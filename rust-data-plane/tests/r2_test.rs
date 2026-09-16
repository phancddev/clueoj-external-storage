use rust_data_plane::error::AppError;
use rust_data_plane::models::{Manifest, ManifestFile};
use rust_data_plane::r2::InMemoryStore;
use rust_data_plane::r2::ObjectStore;
use rust_data_plane::snapshot::materialize_manifest_files;
use std::time::Duration;

async fn setup() -> InMemoryStore {
    InMemoryStore::new(Duration::from_secs(180))
}

#[tokio::test]
async fn test_put_get_object() {
    let store = setup().await;
    let key = "objects/sha256/ab/abcdef";
    let data = b"hello world".to_vec();
    store.put_object(key, data.clone(), "hash").await.unwrap();
    let got = store.get_object(key).await.unwrap();
    assert_eq!(got.as_ref(), data.as_slice());
}

#[tokio::test]
async fn test_head_object_exists() {
    let store = setup().await;
    let key = "objects/sha256/cd/cdef1234";
    store
        .put_object(key, b"data".to_vec(), "hash")
        .await
        .unwrap();
    let meta = store.head_object(key).await.unwrap();
    assert!(meta.exists);
    assert_eq!(meta.size, 4);
}

#[tokio::test]
async fn test_head_object_missing() {
    let store = setup().await;
    let meta = store.head_object("nonexistent").await.unwrap();
    assert!(!meta.exists);
    assert_eq!(meta.size, 0);
}

#[tokio::test]
async fn test_verify_object_match() {
    let store = setup().await;
    let key = "objects/sha256/ef/ef5678";
    let data = b"hello world".to_vec();
    let sha = rust_data_plane::hasher::sha256_bytes(&data);
    store.put_object(key, data, &sha).await.unwrap();
    let ok = store.verify_object(key, &sha).await.unwrap();
    assert!(ok);
}

#[tokio::test]
async fn test_verify_object_mismatch() {
    let store = setup().await;
    let key = "objects/sha256/ef/ef5678";
    store
        .put_object(key, b"hello world".to_vec(), "hash")
        .await
        .unwrap();
    let ok = store
        .verify_object(
            key,
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .await
        .unwrap();
    assert!(!ok);
}

#[tokio::test]
async fn test_presign_get_existing() {
    let store = setup().await;
    let key = "snapshots/p1/1/manifest.json";
    store
        .put_object(key, b"manifest".to_vec(), "hash")
        .await
        .unwrap();
    let result = store.presign_get(key, "manifest.json", None).await.unwrap();
    assert!(result.url.contains(key));
    assert!(result.expires_at > chrono::Utc::now());
}

#[tokio::test]
async fn test_presign_get_missing() {
    let store = setup().await;
    let result = store.presign_get("nonexistent", "file.zip", None).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_presign_ttl_capped() {
    let store = InMemoryStore::new(Duration::from_secs(600));
    let key = "objects/sha256/ab/abcdef";
    store
        .put_object(key, b"data".to_vec(), "hash")
        .await
        .unwrap();
    let result = store
        .presign_get(key, "file.zip", Some(Duration::from_secs(600)))
        .await
        .unwrap();
    let ttl = (result.expires_at - chrono::Utc::now()).num_seconds();
    assert!(ttl <= 300, "TTL should be capped at 300s, got {ttl}");
}

#[tokio::test]
async fn test_delete_object() {
    let store = setup().await;
    let key = "objects/sha256/ab/abcdef";
    store
        .put_object(key, b"data".to_vec(), "hash")
        .await
        .unwrap();
    store.delete_object(key).await.unwrap();
    let meta = store.head_object(key).await.unwrap();
    assert!(!meta.exists);
}

#[tokio::test]
async fn test_overwrite_object_rejected() {
    let store = setup().await;
    let key = "objects/sha256/ab/abcdef";
    store.put_object(key, b"v1".to_vec(), "h1").await.unwrap();
    let result = store.put_object(key, b"v2".to_vec(), "h2").await;
    assert!(result.is_err());
    let got = store.get_object(key).await.unwrap();
    assert_eq!(got.as_ref(), b"v1");
}

#[tokio::test]
async fn test_put_object_from_path_rejects_same_size_mutation() {
    let store = setup().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("data.bin");
    std::fs::write(&path, b"AAAA").unwrap();
    let old_sha = rust_data_plane::hasher::sha256_file(&path).unwrap();
    std::fs::write(&path, b"BBBB").unwrap();

    let key = rust_data_plane::models::object_key_for_sha256(&old_sha);
    let result = store.put_object_from_path(&key, &path, &old_sha).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_build_store_fails_closed_without_r2_config() {
    let result = rust_data_plane::r2::build_store_from_config(
        "r2",
        None,
        "auto".to_string(),
        None,
        None,
        "bucket".to_string(),
        Duration::from_secs(180),
        128 * 1024 * 1024,
        64 * 1024 * 1024,
    );
    assert!(result.is_err());
}

#[tokio::test]
async fn test_build_store_allows_explicit_inmemory() {
    let result = rust_data_plane::r2::build_store_from_config(
        "inmemory",
        None,
        "auto".to_string(),
        None,
        None,
        "bucket".to_string(),
        Duration::from_secs(180),
        128 * 1024 * 1024,
        64 * 1024 * 1024,
    );
    assert!(result.is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn test_restore_materializes_modes_and_hardlinks() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let store = setup().await;
    let data = b"#!/bin/sh\nexit 0\n".to_vec();
    let sha = rust_data_plane::hasher::sha256_bytes(&data);
    let object_key = rust_data_plane::models::object_key_for_sha256(&sha);
    store
        .put_object(&object_key, data.clone(), &sha)
        .await
        .unwrap();
    let regular = ManifestFile {
        path: "bin/runner".to_string(),
        sha256: sha.clone(),
        size: data.len() as u64,
        allocated_bytes: data.len() as u64,
        mode: 0o100755,
        dev: 1,
        ino: 2,
        nlink: 2,
        duplicate_of: None,
        symlink_target: None,
        object_key: object_key.clone(),
    };
    let private_data = b"private-archive".to_vec();
    let private_sha = rust_data_plane::hasher::sha256_bytes(&private_data);
    let private_key = rust_data_plane::models::object_key_for_sha256(&private_sha);
    store
        .put_object(&private_key, private_data.clone(), &private_sha)
        .await
        .unwrap();
    let private = ManifestFile {
        path: "D.zip".to_string(),
        sha256: private_sha,
        size: private_data.len() as u64,
        allocated_bytes: private_data.len() as u64,
        mode: 0o100600,
        dev: 1,
        ino: 4,
        nlink: 1,
        duplicate_of: None,
        symlink_target: None,
        object_key: private_key,
    };
    let duplicate = ManifestFile {
        path: "bin/runner-link".to_string(),
        duplicate_of: Some(regular.path.clone()),
        ..regular.clone()
    };
    let manifest = Manifest {
        schema_version: 2,
        problem_id: "p1".to_string(),
        code: "sum".to_string(),
        generation: 1,
        created_at: chrono::Utc::now(),
        files: vec![regular, duplicate, private],
        canonical_download_path: None,
        total_bytes: (data.len() * 2 + private_data.len()) as u64,
        file_count: 3,
    };
    let dir = tempfile::tempdir().unwrap();

    materialize_manifest_files(&store, &manifest, dir.path())
        .await
        .unwrap();

    let first = std::fs::metadata(dir.path().join("bin/runner")).unwrap();
    let second = std::fs::metadata(dir.path().join("bin/runner-link")).unwrap();
    assert_eq!(first.ino(), second.ino());
    assert_eq!(first.permissions().mode() & 0o777, 0o755);
    assert_eq!(std::fs::read(dir.path().join("bin/runner")).unwrap(), data);
    let private_meta = std::fs::metadata(dir.path().join("D.zip")).unwrap();
    assert_eq!(private_meta.permissions().mode() & 0o777, 0o644);
    assert_eq!(std::fs::read(dir.path().join("D.zip")).unwrap(), private_data);
}

#[cfg(unix)]
#[tokio::test]
async fn test_restore_materializes_safe_relative_symlink() {
    let store = setup().await;
    let target = "data/input.txt";
    let sha = rust_data_plane::hasher::sha256_bytes(target.as_bytes());
    let object_key = rust_data_plane::models::object_key_for_sha256(&sha);
    store
        .put_object(&object_key, target.as_bytes().to_vec(), &sha)
        .await
        .unwrap();
    let manifest = Manifest {
        schema_version: 3,
        problem_id: "p1".to_string(),
        code: "sum".to_string(),
        generation: 1,
        created_at: chrono::Utc::now(),
        files: vec![ManifestFile {
            path: "input-link".to_string(),
            sha256: sha,
            size: target.len() as u64,
            allocated_bytes: 0,
            mode: 0o120777,
            dev: 1,
            ino: 3,
            nlink: 1,
            duplicate_of: None,
            symlink_target: Some(target.to_string()),
            object_key,
        }],
        canonical_download_path: None,
        total_bytes: target.len() as u64,
        file_count: 1,
    };
    let dir = tempfile::tempdir().unwrap();

    materialize_manifest_files(&store, &manifest, dir.path())
        .await
        .unwrap();

    assert_eq!(
        std::fs::read_link(dir.path().join("input-link")).unwrap(),
        std::path::PathBuf::from(target),
    );
}

#[tokio::test]
async fn test_restore_classifies_missing_snapshot_object() {
    let store = setup().await;
    let data = b"missing".to_vec();
    let sha = rust_data_plane::hasher::sha256_bytes(&data);
    let object_key = rust_data_plane::models::object_key_for_sha256(&sha);
    let manifest = Manifest {
        schema_version: 3,
        problem_id: "p1".to_string(),
        code: "sum".to_string(),
        generation: 1,
        created_at: chrono::Utc::now(),
        files: vec![ManifestFile {
            path: "data.txt".to_string(),
            sha256: sha,
            size: data.len() as u64,
            allocated_bytes: data.len() as u64,
            mode: 0o100644,
            dev: 1,
            ino: 4,
            nlink: 1,
            duplicate_of: None,
            symlink_target: None,
            object_key: object_key.clone(),
        }],
        canonical_download_path: None,
        total_bytes: data.len() as u64,
        file_count: 1,
    };
    let dir = tempfile::tempdir().unwrap();

    let error = materialize_manifest_files(&store, &manifest, dir.path())
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        AppError::R2ObjectMissing { path, key }
            if path == "data.txt" && key == object_key
    ));
}

#[tokio::test]
async fn test_restore_rejects_missing_hardlink_source() {
    let store = setup().await;
    let data = b"same".to_vec();
    let sha = rust_data_plane::hasher::sha256_bytes(&data);
    let object_key = rust_data_plane::models::object_key_for_sha256(&sha);
    let manifest = Manifest {
        schema_version: 2,
        problem_id: "p1".to_string(),
        code: "sum".to_string(),
        generation: 1,
        created_at: chrono::Utc::now(),
        files: vec![ManifestFile {
            path: "link.txt".to_string(),
            sha256: sha,
            size: data.len() as u64,
            allocated_bytes: data.len() as u64,
            mode: 0o644,
            dev: 1,
            ino: 2,
            nlink: 2,
            duplicate_of: Some("missing.txt".to_string()),
            symlink_target: None,
            object_key,
        }],
        canonical_download_path: None,
        total_bytes: 0,
        file_count: 1,
    };
    let dir = tempfile::tempdir().unwrap();

    let result = materialize_manifest_files(&store, &manifest, dir.path()).await;

    assert!(result.is_err());
}
