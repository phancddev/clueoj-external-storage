use rust_data_plane::hasher::{sha256_bytes, sha256_file};
use rust_data_plane::models::{manifest_key, object_key_for_sha256};

#[test]
fn test_sha256_bytes_known_vector() {
    let hash = sha256_bytes(b"hello world");
    assert_eq!(
        hash,
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
}

#[test]
fn test_sha256_bytes_empty() {
    let hash = sha256_bytes(b"");
    assert_eq!(
        hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn test_sha256_file_matches_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.txt");
    std::fs::write(&path, b"hello world").unwrap();
    let file_hash = sha256_file(&path).unwrap();
    let bytes_hash = sha256_bytes(b"hello world");
    assert_eq!(file_hash, bytes_hash);
}

#[test]
fn test_sha256_file_large() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.bin");
    let data = vec![0xABu8; 200_000];
    std::fs::write(&path, &data).unwrap();
    let file_hash = sha256_file(&path).unwrap();
    let bytes_hash = sha256_bytes(&data);
    assert_eq!(file_hash, bytes_hash);
}

#[test]
fn test_object_key_format() {
    let sha = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    let key = object_key_for_sha256(sha);
    assert_eq!(
        key,
        "objects/sha256/b9/b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );
}

#[test]
fn test_manifest_key_format() {
    let key = manifest_key("prob-42", 3);
    assert_eq!(key, "snapshots/prob-42/3/manifest.json");
}
