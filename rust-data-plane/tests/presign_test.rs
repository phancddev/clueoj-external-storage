use async_trait::async_trait;
use bytes::Bytes;
use rust_data_plane::error::{AppError, AppResult};
use rust_data_plane::models::{Manifest, ManifestFile, PresignResult};
use rust_data_plane::r2::{ObjectMeta, ObjectStore};
use rust_data_plane::snapshot::presign_canonical_from_manifest;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

struct InstrumentedStore {
    meta: ObjectMeta,
    head_calls: AtomicUsize,
    presign_calls: AtomicUsize,
    get_calls: AtomicUsize,
    verify_calls: AtomicUsize,
}

impl InstrumentedStore {
    fn new(meta: ObjectMeta) -> Self {
        Self {
            meta,
            head_calls: AtomicUsize::new(0),
            presign_calls: AtomicUsize::new(0),
            get_calls: AtomicUsize::new(0),
            verify_calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl ObjectStore for InstrumentedStore {
    async fn put_object(&self, _key: &str, _body: Vec<u8>, _sha256: &str) -> AppResult<()> {
        unreachable!("presign must not upload")
    }

    async fn put_object_from_path(
        &self,
        _key: &str,
        _path: &std::path::Path,
        _sha256: &str,
    ) -> AppResult<()> {
        unreachable!("presign must not upload")
    }

    async fn get_object(&self, key: &str) -> AppResult<Bytes> {
        self.get_calls.fetch_add(1, Ordering::SeqCst);
        Err(AppError::Internal(format!("unexpected get_object {key}")))
    }

    async fn get_object_to_path(&self, key: &str, _path: &std::path::Path) -> AppResult<String> {
        self.get_calls.fetch_add(1, Ordering::SeqCst);
        Err(AppError::Internal(format!(
            "unexpected get_object_to_path {key}"
        )))
    }

    async fn head_object(&self, _key: &str) -> AppResult<ObjectMeta> {
        self.head_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.meta.clone())
    }

    async fn verify_object(&self, key: &str, _expected_sha256: &str) -> AppResult<bool> {
        self.verify_calls.fetch_add(1, Ordering::SeqCst);
        Err(AppError::Internal(format!(
            "unexpected verify_object {key}"
        )))
    }

    async fn presign_get(
        &self,
        key: &str,
        filename: &str,
        ttl: Option<Duration>,
    ) -> AppResult<PresignResult> {
        self.presign_calls.fetch_add(1, Ordering::SeqCst);
        Ok(PresignResult {
            url: format!("memory://{key}?filename={filename}"),
            expires_at: chrono::Utc::now()
                + chrono::Duration::from_std(ttl.unwrap_or(Duration::from_secs(180))).unwrap(),
        })
    }

    async fn delete_object(&self, _key: &str) -> AppResult<()> {
        unreachable!("presign must not delete")
    }

    async fn health_check(&self) -> AppResult<()> {
        Ok(())
    }
}

fn manifest() -> Manifest {
    Manifest {
        schema_version: 2,
        problem_id: "p1".to_string(),
        code: "abc".to_string(),
        generation: 7,
        created_at: chrono::Utc::now(),
        canonical_download_path: Some("tests.zip".to_string()),
        total_bytes: 4,
        file_count: 1,
        files: vec![ManifestFile {
            path: "tests.zip".to_string(),
            sha256: "abcd".to_string(),
            size: 4,
            allocated_bytes: 4,
            mode: 0,
            dev: 0,
            ino: 0,
            nlink: 1,
            duplicate_of: None,
            symlink_target: None,
            object_key: "objects/sha256/ab/abcd".to_string(),
        }],
    }
}

#[tokio::test]
async fn presign_uses_head_metadata_without_body_get_or_verify() {
    let store = InstrumentedStore::new(ObjectMeta {
        size: 4,
        etag: None,
        sha256: Some("abcd".to_string()),
        exists: true,
    });
    let result = presign_canonical_from_manifest(&store, &manifest(), None)
        .await
        .unwrap();

    assert!(result.url.contains("objects/sha256/ab/abcd"));
    assert_eq!(store.head_calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.presign_calls.load(Ordering::SeqCst), 1);
    assert_eq!(store.get_calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.verify_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn presign_rejects_missing_checksum_metadata() {
    let store = InstrumentedStore::new(ObjectMeta {
        size: 4,
        etag: None,
        sha256: None,
        exists: true,
    });
    let result = presign_canonical_from_manifest(&store, &manifest(), None).await;

    assert!(matches!(result, Err(AppError::R2NotReady(_))));
    assert_eq!(store.presign_calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.get_calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.verify_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn presign_rejects_mismatched_checksum_metadata() {
    let store = InstrumentedStore::new(ObjectMeta {
        size: 4,
        etag: None,
        sha256: Some("efgh".to_string()),
        exists: true,
    });
    let result = presign_canonical_from_manifest(&store, &manifest(), None).await;

    assert!(matches!(result, Err(AppError::ChecksumMismatch { .. })));
    assert_eq!(store.presign_calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.get_calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.verify_calls.load(Ordering::SeqCst), 0);
}
