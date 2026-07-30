use rust_data_plane::paths::{
    safe_destination_under_root, safe_join, safe_problem_folder, validate_content_object_key,
    validate_relative_path,
};
use rust_data_plane::scanner::{
    canonical_download_path_from_folder, list_problem_codes, scan_problem_folder, scan_volume,
};
use std::fs;

#[test]
fn test_scan_volume_returns_stats() {
    let dir = tempfile::tempdir().unwrap();
    let vol = scan_volume(dir.path()).unwrap();
    assert!(vol.total_bytes > 0);
    assert!(vol.free_bytes > 0);
    assert!(!vol.stale);
}

#[test]
fn test_scan_problem_folder_counts() {
    let dir = tempfile::tempdir().unwrap();
    let code = "testprob";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("init.yml"), "archive: tests.zip\n").unwrap();
    fs::write(folder.join("tests.zip"), b"PK\x05\x06\x00\x00\x00\x00").unwrap();
    fs::write(folder.join("checker.cpp"), b"int main(){}").unwrap();

    let scan = scan_problem_folder(dir.path(), code).unwrap();
    assert_eq!(scan.code, code);
    assert_eq!(scan.file_count, 3);
    assert!(scan.logical_bytes > 0);
    assert!(scan.allocated_bytes > 0);
    assert!(scan.archive_bytes > 0);
    assert!(scan.auxiliary_bytes > 0);
    assert_eq!(scan.files.len(), 3);
    for f in &scan.files {
        assert!(!f.sha256.is_empty());
    }
}

#[test]
fn test_scan_problem_folder_missing() {
    let dir = tempfile::tempdir().unwrap();
    let result = scan_problem_folder(dir.path(), "nonexistent");
    assert!(result.is_err());
}

#[test]
fn test_scan_hardlink_dedup() {
    let dir = tempfile::tempdir().unwrap();
    let code = "hardlink_test";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("original.txt"), b"shared content").unwrap();
    fs::hard_link(folder.join("original.txt"), folder.join("link.txt")).unwrap();

    let scan = scan_problem_folder(dir.path(), code).unwrap();
    assert_eq!(scan.file_count, 2);
    let logical = scan.logical_bytes;
    let dup_file = scan
        .files
        .iter()
        .find(|f| f.duplicate_of.is_some())
        .unwrap();
    assert!(dup_file.nlink >= 2);
    let non_dup = scan
        .files
        .iter()
        .find(|f| f.duplicate_of.is_none())
        .unwrap();
    assert!(!non_dup.sha256.is_empty());
    assert_eq!(dup_file.sha256, non_dup.sha256);
    assert_eq!(logical, "shared content".len() as u64);
}

#[test]
fn test_scan_symlink_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let code = "symlink_test";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("real.txt"), b"real").unwrap();
    std::os::unix::fs::symlink(folder.join("real.txt"), folder.join("link.txt")).unwrap();

    let scan = scan_problem_folder(dir.path(), code).unwrap();
    assert_eq!(scan.file_count, 1);
    assert_eq!(scan.files.len(), 1);
    assert_eq!(scan.files[0].path, "real.txt");
}

#[test]
fn test_list_problem_codes_sorted() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("c_problem")).unwrap();
    fs::create_dir(dir.path().join("a_problem")).unwrap();
    fs::create_dir(dir.path().join("b_problem")).unwrap();
    fs::create_dir(dir.path().join(".hidden")).unwrap();
    fs::write(dir.path().join("not_a_dir.txt"), "").unwrap();

    let codes = list_problem_codes(dir.path()).unwrap();
    assert_eq!(codes, vec!["a_problem", "b_problem", "c_problem"]);
}

#[test]
fn test_scan_subdirectory_files() {
    let dir = tempfile::tempdir().unwrap();
    let code = "subdir_test";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    fs::create_dir(folder.join("sub")).unwrap();
    fs::write(folder.join("sub").join("nested.txt"), b"nested").unwrap();
    fs::write(folder.join("top.txt"), b"top").unwrap();

    let scan = scan_problem_folder(dir.path(), code).unwrap();
    assert_eq!(scan.file_count, 2);
    let paths: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"top.txt"));
    assert!(paths.contains(&"sub/nested.txt"));
}

#[test]
fn test_problem_code_path_escape_rejected() {
    let dir = tempfile::tempdir().unwrap();
    assert!(scan_problem_folder(dir.path(), "../outside").is_err());
    assert!(safe_problem_folder(dir.path(), "/absolute").is_err());
    assert!(safe_join(dir.path(), "../outside.txt").is_err());
    assert!(safe_destination_under_root(dir.path(), std::path::Path::new("../outside")).is_err());
    assert!(safe_destination_under_root(dir.path(), &dir.path().join("../outside")).is_err());
    assert!(safe_destination_under_root(dir.path(), std::path::Path::new("problem")).is_ok());
    assert!(validate_relative_path("sub/ok.txt").is_ok());
    assert!(validate_content_object_key(
        "objects/sha256/b9/b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    )
    .is_ok());
    assert!(validate_content_object_key("snapshots/p1/1/manifest.json").is_err());
}

#[test]
fn test_canonical_download_uses_init_archive_only() {
    let dir = tempfile::tempdir().unwrap();
    let code = "canonical_test";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("init.yml"), "archive: official.dat\n").unwrap();
    fs::write(folder.join("random.zip"), b"not canonical").unwrap();
    fs::write(folder.join("official.dat"), b"canonical").unwrap();

    let scan = scan_problem_folder(dir.path(), code).unwrap();
    assert_eq!(
        canonical_download_path_from_folder(&folder, &scan.files),
        Some("official.dat".to_string())
    );
}

#[test]
fn test_canonical_download_rejects_traversal_archive() {
    let dir = tempfile::tempdir().unwrap();
    let code = "canonical_escape";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("init.yml"), "archive: ../outside.zip\n").unwrap();
    fs::write(folder.join("tests.zip"), b"PK").unwrap();

    let scan = scan_problem_folder(dir.path(), code).unwrap();
    assert_eq!(
        canonical_download_path_from_folder(&folder, &scan.files),
        None
    );
}

#[test]
fn test_canonical_download_requires_existing_archive() {
    let dir = tempfile::tempdir().unwrap();
    let code = "canonical_missing";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("init.yml"), "archive: absent.zip\n").unwrap();

    let scan = scan_problem_folder(dir.path(), code).unwrap();
    assert_eq!(
        canonical_download_path_from_folder(&folder, &scan.files),
        None
    );
}

#[cfg(unix)]
#[test]
fn test_scan_rejects_fifo_special_file() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let dir = tempfile::tempdir().unwrap();
    let code = "fifo_test";
    let folder = dir.path().join(code);
    fs::create_dir(&folder).unwrap();
    let fifo = folder.join("pipe");
    let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) };
    assert_eq!(rc, 0);

    let result = scan_problem_folder(dir.path(), code);
    assert!(result.is_err());
}
