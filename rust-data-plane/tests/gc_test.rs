use rust_data_plane::snapshot::{gc_delete_timeline_is_safe, should_clear_dirty_after_snapshot};

#[test]
fn test_gc_delete_lock_blocks_ready_between_check_and_delete() {
    assert!(!gc_delete_timeline_is_safe(&[
        "delete_lock",
        "finalize_ready",
        "delete_object",
        "delete_unlock",
    ]));
}

#[test]
fn test_gc_delete_timeline_allows_delete_before_future_ready_attempt() {
    assert!(gc_delete_timeline_is_safe(&[
        "delete_lock",
        "delete_object",
        "delete_unlock",
    ]));
    assert!(!gc_delete_timeline_is_safe(&[
        "delete_lock",
        "delete_object",
        "delete_unlock",
        "finalize_ready",
    ]));
}

#[test]
fn test_dirty_clear_requires_matching_or_older_dirty_generation() {
    assert!(should_clear_dirty_after_snapshot(
        true,
        Some(5),
        10,
        5,
        Some(10)
    ));
    assert!(should_clear_dirty_after_snapshot(
        true,
        Some(4),
        10,
        5,
        Some(10)
    ));
    assert!(!should_clear_dirty_after_snapshot(
        true,
        Some(6),
        10,
        5,
        Some(10)
    ));
    assert!(!should_clear_dirty_after_snapshot(
        false,
        Some(5),
        10,
        5,
        Some(10)
    ));
    assert!(!should_clear_dirty_after_snapshot(
        true,
        None,
        10,
        5,
        Some(10)
    ));
}

#[test]
fn test_dirty_clear_rejects_newer_mutation_with_same_generation() {
    assert!(!should_clear_dirty_after_snapshot(
        true,
        Some(5),
        11,
        5,
        Some(10)
    ));
    assert!(should_clear_dirty_after_snapshot(
        true,
        Some(5),
        10,
        5,
        Some(10)
    ));
    assert!(!should_clear_dirty_after_snapshot(
        true,
        Some(5),
        10,
        5,
        None
    ));
}
