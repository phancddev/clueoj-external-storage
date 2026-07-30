use rust_data_plane::watcher::{debounce_wait_for_age, problem_codes_from_paths};

#[test]
fn test_problem_codes_from_all_event_paths() {
    let root = std::path::Path::new("/problems");
    let paths = vec![
        std::path::PathBuf::from("/problems/a/init.yml"),
        std::path::PathBuf::from("/problems/b/tests.zip"),
        std::path::PathBuf::from("/problems/a/checker.cpp"),
        std::path::PathBuf::from("/outside/c/file.txt"),
    ];

    assert_eq!(problem_codes_from_paths(root, &paths), vec!["a", "b"]);
}

#[test]
fn test_problem_codes_reject_traversal_like_code() {
    let root = std::path::Path::new("/problems");
    let paths = vec![std::path::PathBuf::from("/problems/../escape/file.txt")];

    assert!(problem_codes_from_paths(root, &paths).is_empty());
}

#[test]
fn test_problem_codes_ignore_hidden_root_entries() {
    let root = std::path::Path::new("/problems");
    let paths = vec![
        std::path::PathBuf::from("/problems/.locks/p1.lock"),
        std::path::PathBuf::from("/problems/visible/file.txt"),
    ];

    assert_eq!(problem_codes_from_paths(root, &paths), vec!["visible"]);
}

#[test]
fn test_debounce_has_max_delay() {
    assert_eq!(
        debounce_wait_for_age(std::time::Duration::from_secs(0)),
        std::time::Duration::from_secs(5)
    );
    assert_eq!(
        debounce_wait_for_age(std::time::Duration::from_secs(29)),
        std::time::Duration::from_secs(1)
    );
    assert_eq!(
        debounce_wait_for_age(std::time::Duration::from_secs(31)),
        std::time::Duration::from_secs(0)
    );
}
