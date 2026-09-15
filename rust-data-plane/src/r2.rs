use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client as S3Client;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::models::PresignResult;

/// Content-Type trả về trên presigned GET để trình duyệt phân loại đúng
/// file thay vì rơi vào `binary/octet-stream` mặc định (một trong các
/// heuristic khiến browser gắn cờ "file nguy hiểm").
pub fn content_type_for_filename(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        "application/zip"
    } else if lower.ends_with(".yml") || lower.ends_with(".yaml") {
        "application/x-yaml"
    } else if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".cpp") || lower.ends_with(".cc") || lower.ends_with(".h") {
        "text/x-c++src"
    } else if lower.ends_with(".pdf") {
        "application/pdf"
    } else {
        "application/octet-stream"
    }
}

pub trait ObjectStore: Send + Sync {
    async fn put_object(&self, key: &str, body: Vec<u8>, sha256: &str) -> AppResult<()>;
    async fn put_object_from_path(&self, key: &str, path: &Path, sha256: &str) -> AppResult<()>;
    async fn get_object(&self, key: &str) -> AppResult<Bytes>;
    async fn get_object_to_path(&self, key: &str, path: &Path) -> AppResult<String>;
    async fn head_object(&self, key: &str) -> AppResult<ObjectMeta>;
    async fn verify_object(&self, key: &str, expected_sha256: &str) -> AppResult<bool>;
    async fn presign_get(
        &self,
        key: &str,
        filename: &str,
        ttl: Option<Duration>,
    ) -> AppResult<PresignResult>;
    async fn delete_object(&self, key: &str) -> AppResult<()>;
    async fn health_check(&self) -> AppResult<()>;
}

#[derive(Debug, Clone)]
pub struct ObjectMeta {
    pub size: u64,
    pub etag: Option<String>,
    pub sha256: Option<String>,
    pub exists: bool,
}

pub struct R2Client {
    client: S3Client,
    bucket: String,
    presign_ttl: Duration,
    multipart_threshold_bytes: u64,
    multipart_part_bytes: u64,
}

impl R2Client {
    #[allow(clippy::too_many_arguments)]
    pub async fn new(
        endpoint: Option<String>,
        region: String,
        access_key: Option<String>,
        secret_key: Option<String>,
        bucket: String,
        presign_ttl: Duration,
        multipart_threshold_bytes: u64,
        multipart_part_bytes: u64,
    ) -> AppResult<Self> {
        let mut loader = aws_config::defaults(BehaviorVersion::latest());
        if let (Some(ak), Some(sk)) = (access_key, secret_key) {
            loader = loader.credentials_provider(Credentials::new(ak, sk, None, None, "static"));
        }
        if let Some(ep) = endpoint {
            loader = loader.endpoint_url(ep);
        }
        loader = loader.region(Region::new(region));
        let cfg = loader.load().await;
        // R2 is S3-compatible but uses an account endpoint rather than AWS'
        // bucket subdomains. Path-style requests avoid invalid
        // <bucket>.<account>.r2.cloudflarestorage.com hostnames.
        let s3_cfg = aws_sdk_s3::config::Builder::from(&cfg)
            .force_path_style(true)
            .build();
        let client = S3Client::from_conf(s3_cfg);
        Ok(Self {
            client,
            bucket,
            presign_ttl,
            multipart_threshold_bytes,
            multipart_part_bytes: multipart_part_bytes.max(5 * 1024 * 1024),
        })
    }
}

#[async_trait]
impl ObjectStore for R2Client {
    async fn put_object(&self, key: &str, body: Vec<u8>, sha256: &str) -> AppResult<()> {
        let existing = self.head_object(key).await?;
        if existing.exists {
            if self.verify_object(key, sha256).await? {
                return Ok(());
            }
            return Err(AppError::ChecksumMismatch {
                expected: sha256.to_string(),
                got: format!("existing object differs at {key}"),
            });
        }
        let body = ByteStream::from(body);
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(body)
            .metadata("sha256", sha256)
            .send()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        tracing::debug!(key, sha256, "object uploaded");
        Ok(())
    }

    async fn put_object_from_path(&self, key: &str, path: &Path, sha256: &str) -> AppResult<()> {
        let existing = self.head_object(key).await?;
        if existing.exists {
            if self.verify_object(key, sha256).await? {
                return Ok(());
            }
            return Err(AppError::ChecksumMismatch {
                expected: sha256.to_string(),
                got: format!("existing object differs at {key}"),
            });
        }

        let size = std::fs::metadata(path).map_err(AppError::Io)?.len();
        if size >= self.multipart_threshold_bytes {
            return self.multipart_upload_from_path(key, path, sha256).await;
        }

        let body = ByteStream::from_path(path)
            .await
            .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(body)
            .metadata("sha256", sha256)
            .send()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        tracing::debug!(key, sha256, "object uploaded from path");
        Ok(())
    }

    async fn get_object(&self, key: &str) -> AppResult<Bytes> {
        let resp = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| {
                if error
                    .as_service_error()
                    .is_some_and(|service| service.is_no_such_key())
                {
                    AppError::ObjectNotFound(key.to_string())
                } else {
                    AppError::R2(format!("get_object failed for key {key}"))
                }
            })?;
        let body = resp
            .body
            .collect()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        Ok(body.into_bytes())
    }

    async fn get_object_to_path(&self, key: &str, path: &Path) -> AppResult<String> {
        let resp = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| {
                if error
                    .as_service_error()
                    .is_some_and(|service| service.is_no_such_key())
                {
                    AppError::ObjectNotFound(key.to_string())
                } else {
                    AppError::R2(format!("get_object failed for key {key}"))
                }
            })?;
        let mut body = resp.body;
        let mut file = tokio::fs::File::create(path).await.map_err(AppError::Io)?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = body
            .try_next()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?
        {
            hasher.update(&chunk);
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(AppError::Io)?;
        }
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(AppError::Io)?;
        file.sync_all().await.map_err(AppError::Io)?;
        Ok(hex::encode(hasher.finalize()))
    }

    async fn head_object(&self, key: &str) -> AppResult<ObjectMeta> {
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(resp) => Ok(ObjectMeta {
                size: resp.content_length.unwrap_or(0) as u64,
                etag: resp.e_tag,
                sha256: resp.metadata.and_then(|m| m.get("sha256").cloned()),
                exists: true,
            }),
            Err(e) => {
                // HeadObject errors may stringify to the unhelpful
                // "service error". Use the modeled SDK error first so a
                // missing object is not mistaken for an R2 outage.
                let is_not_found = e
                    .as_service_error()
                    .is_some_and(|service| service.is_not_found());
                if is_not_found {
                    Ok(ObjectMeta {
                        size: 0,
                        etag: None,
                        sha256: None,
                        exists: false,
                    })
                } else {
                    Err(AppError::R2(e.to_string()))
                }
            }
        }
    }

    async fn verify_object(&self, key: &str, expected_sha256: &str) -> AppResult<bool> {
        let data = self.get_object(key).await?;
        let actual = crate::hasher::sha256_bytes(&data);
        if actual != expected_sha256 {
            tracing::warn!(key, expected = expected_sha256, got = %actual, "checksum mismatch");
            return Ok(false);
        }
        Ok(true)
    }

    async fn presign_get(
        &self,
        key: &str,
        filename: &str,
        ttl: Option<Duration>,
    ) -> AppResult<PresignResult> {
        let ttl = ttl
            .unwrap_or(self.presign_ttl)
            .min(Duration::from_secs(300));
        let presign_cfg =
            PresigningConfig::expires_in(ttl).map_err(|e| AppError::R2(e.to_string()))?;
        let disposition = format!("attachment; filename=\"{filename}\"");
        let presigned = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .response_content_disposition(disposition)
            .response_content_type(content_type_for_filename(filename).to_string())
            .presigned(presign_cfg)
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        Ok(PresignResult {
            url: presigned.uri().to_string(),
            expires_at: chrono::Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default(),
        })
    }

    async fn delete_object(&self, key: &str) -> AppResult<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        Ok(())
    }

    async fn health_check(&self) -> AppResult<()> {
        self.client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        Ok(())
    }
}

impl R2Client {
    async fn multipart_upload_from_path(
        &self,
        key: &str,
        path: &Path,
        sha256: &str,
    ) -> AppResult<()> {
        let created = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .metadata("sha256", sha256)
            .send()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        let upload_id = created
            .upload_id()
            .ok_or_else(|| AppError::R2("multipart upload missing upload_id".to_string()))?
            .to_string();

        let result = self
            .multipart_upload_parts(key, path, &upload_id, sha256)
            .await;
        if let Err(err) = result {
            let _ = self
                .client
                .abort_multipart_upload()
                .bucket(&self.bucket)
                .key(key)
                .upload_id(&upload_id)
                .send()
                .await;
            return Err(err);
        }
        Ok(())
    }

    async fn multipart_upload_parts(
        &self,
        key: &str,
        path: &Path,
        upload_id: &str,
        sha256: &str,
    ) -> AppResult<()> {
        let mut file = std::fs::File::open(path).map_err(AppError::Io)?;
        let mut part_number = 1;
        let mut completed = Vec::new();
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; self.multipart_part_bytes as usize];
        loop {
            let n = file.read(&mut buf).map_err(AppError::Io)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            let body = ByteStream::from(buf[..n].to_vec());
            let part = self
                .client
                .upload_part()
                .bucket(&self.bucket)
                .key(key)
                .upload_id(upload_id)
                .part_number(part_number)
                .body(body)
                .send()
                .await
                .map_err(|e| AppError::R2(e.to_string()))?;
            completed.push(
                CompletedPart::builder()
                    .part_number(part_number)
                    .set_e_tag(part.e_tag)
                    .build(),
            );
            part_number += 1;
        }
        let actual = hex::encode(hasher.finalize());
        if actual != sha256 {
            return Err(AppError::ChecksumMismatch {
                expected: sha256.to_string(),
                got: actual,
            });
        }
        self.client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(completed))
                    .build(),
            )
            .send()
            .await
            .map_err(|e| AppError::R2(e.to_string()))?;
        Ok(())
    }
}

pub struct InMemoryStore {
    objects: Arc<RwLock<HashMap<String, Vec<u8>>>>,
    presign_ttl: Duration,
}

impl InMemoryStore {
    pub fn new(presign_ttl: Duration) -> Self {
        Self {
            objects: Arc::new(RwLock::new(HashMap::new())),
            presign_ttl,
        }
    }
}

#[async_trait]
impl ObjectStore for InMemoryStore {
    async fn put_object(&self, key: &str, body: Vec<u8>, _sha256: &str) -> AppResult<()> {
        let mut objects = self.objects.write().await;
        if let Some(existing) = objects.get(key) {
            if existing == &body {
                return Ok(());
            }
            return Err(AppError::ChecksumMismatch {
                expected: crate::hasher::sha256_bytes(existing),
                got: crate::hasher::sha256_bytes(&body),
            });
        }
        objects.insert(key.to_string(), body);
        Ok(())
    }

    async fn put_object_from_path(&self, key: &str, path: &Path, sha256: &str) -> AppResult<()> {
        let body = tokio::fs::read(path).await.map_err(AppError::Io)?;
        let actual = crate::hasher::sha256_bytes(&body);
        if actual != sha256 {
            return Err(AppError::ChecksumMismatch {
                expected: sha256.to_string(),
                got: actual,
            });
        }
        self.put_object(key, body, sha256).await
    }

    async fn get_object(&self, key: &str) -> AppResult<Bytes> {
        self.objects
            .read()
            .await
            .get(key)
            .cloned()
            .map(Bytes::from)
            .ok_or_else(|| AppError::ObjectNotFound(key.to_string()))
    }

    async fn get_object_to_path(&self, key: &str, path: &Path) -> AppResult<String> {
        let data = self.get_object(key).await?;
        tokio::fs::write(path, &data).await.map_err(AppError::Io)?;
        Ok(crate::hasher::sha256_bytes(&data))
    }

    async fn head_object(&self, key: &str) -> AppResult<ObjectMeta> {
        let map = self.objects.read().await;
        if let Some(data) = map.get(key) {
            Ok(ObjectMeta {
                size: data.len() as u64,
                etag: None,
                sha256: Some(crate::hasher::sha256_bytes(data)),
                exists: true,
            })
        } else {
            Ok(ObjectMeta {
                size: 0,
                etag: None,
                sha256: None,
                exists: false,
            })
        }
    }

    async fn verify_object(&self, key: &str, expected_sha256: &str) -> AppResult<bool> {
        let data = self.get_object(key).await?;
        let actual = crate::hasher::sha256_bytes(&data);
        Ok(actual == expected_sha256)
    }

    async fn presign_get(
        &self,
        key: &str,
        filename: &str,
        ttl: Option<Duration>,
    ) -> AppResult<PresignResult> {
        let ttl = ttl
            .unwrap_or(self.presign_ttl)
            .min(Duration::from_secs(300));
        let map = self.objects.read().await;
        if !map.contains_key(key) {
            return Err(AppError::ObjectNotFound(key.to_string()));
        }
        let url = format!("memory://localhost/bucket/{key}?filename={filename}&ttl={ttl:?}");
        Ok(PresignResult {
            url,
            expires_at: chrono::Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default(),
        })
    }

    async fn delete_object(&self, key: &str) -> AppResult<()> {
        self.objects.write().await.remove(key);
        Ok(())
    }

    async fn health_check(&self) -> AppResult<()> {
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_store_from_config(
    mode: &str,
    endpoint: Option<String>,
    region: String,
    access_key: Option<String>,
    secret_key: Option<String>,
    bucket: String,
    presign_ttl: Duration,
    multipart_threshold_bytes: u64,
    multipart_part_bytes: u64,
) -> AppResult<Arc<dyn ObjectStore>> {
    if mode.eq_ignore_ascii_case("inmemory") {
        tracing::warn!("using explicit in-memory object store; test/dev only");
        return Ok(Arc::new(InMemoryStore::new(presign_ttl)));
    }

    if !mode.eq_ignore_ascii_case("r2") {
        return Err(AppError::R2(format!("unknown object store mode: {mode}")));
    }
    if endpoint.is_none() || access_key.is_none() || secret_key.is_none() || bucket.is_empty() {
        return Err(AppError::R2(
            "R2 config incomplete; set STORAGE_OBJECT_STORE=inmemory only for test/dev".to_string(),
        ));
    }
    let client = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(R2Client::new(
            endpoint,
            region,
            access_key,
            secret_key,
            bucket,
            presign_ttl,
            multipart_threshold_bytes,
            multipart_part_bytes,
        ))
    })?;
    Ok(Arc::new(client))
}
