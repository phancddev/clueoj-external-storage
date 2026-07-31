use rust_data_plane::db::scan_matches_snapshot_objects;
use rust_data_plane::models::{FileEntry, ScanResult};

fn scan(files: &[(&str, &str, u64)]) -> ScanResult {
    ScanResult {
        problem_external_id: Some("42".to_string()),
        code: "sum".to_string(),
        logical_bytes: files.iter().map(|item| item.2).sum(),
        allocated_bytes: 0,
        archive_bytes: 0,
        auxiliary_bytes: 0,
        file_count: files.len() as i64,
        files: files
            .iter()
            .map(|(path, sha256, size)| FileEntry {
                path: (*path).to_string(),
                sha256: (*sha256).to_string(),
                size: *size,
                allocated_bytes: 0,
                dev: 0,
                ino: 0,
                nlink: 1,
                mode: 0o100644,
                duplicate_of: None,
                symlink_target: None,
                is_dir: false,
            })
            .collect(),
        observed_at: chrono::Utc::now(),
    }
}

#[test]
fn readiness_requires_exact_snapshot_identity() {
    let actual = scan(&[("tests.zip", "sha-tests", 10), ("init.yml", "sha-init", 20)]);
    let expected = vec![
        ("init.yml".to_string(), "sha-init".to_string(), 20),
        ("tests.zip".to_string(), "sha-tests".to_string(), 10),
    ];
    assert!(scan_matches_snapshot_objects(&actual, &expected));
}

#[test]
fn readiness_rejects_partial_or_mutated_tree() {
    let partial = scan(&[("init.yml", "sha-init", 20)]);
    let expected = vec![
        ("init.yml".to_string(), "sha-init".to_string(), 20),
        ("tests.zip".to_string(), "sha-tests".to_string(), 10),
    ];
    assert!(!scan_matches_snapshot_objects(&partial, &expected));

    let mutated = scan(&[
        ("init.yml", "different", 20),
        ("tests.zip", "sha-tests", 10),
    ]);
    assert!(!scan_matches_snapshot_objects(&mutated, &expected));
}
