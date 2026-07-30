use rust_data_plane::db::{allocate_counter_value, ACQUIRE_DIRTY_SNAPSHOT_JOB_SQL};

#[test]
fn test_watcher_generations_advance_counter_for_control_allocator() {
    let mut next_generation = 1;
    let mut max_observed = 0;

    for expected in 1..=5 {
        let (allocated, next) = allocate_counter_value(next_generation, max_observed);
        assert_eq!(allocated, expected);
        next_generation = next;
        max_observed = allocated;
    }

    let (control_allocated, next) = allocate_counter_value(next_generation, max_observed);
    assert_eq!(control_allocated, 6);
    assert_eq!(next, 7);
}

#[test]
fn test_concurrent_generation_allocations_are_unique_when_serialized_by_counter() {
    let mut next_generation = 1;
    let max_observed = 0;
    let mut allocated = Vec::new();

    for _ in 0..10 {
        let (generation, next) = allocate_counter_value(next_generation, max_observed);
        allocated.push(generation);
        next_generation = next;
    }

    let unique: std::collections::BTreeSet<i64> = allocated.iter().copied().collect();
    assert_eq!(unique.len(), allocated.len());
    assert_eq!(allocated, (1..=10).collect::<Vec<_>>());
}

#[test]
fn test_counter_seeds_beyond_existing_snapshots() {
    assert_eq!(allocate_counter_value(1, 5), (6, 7));
    assert_eq!(allocate_counter_value(9, 5), (9, 10));
}

#[test]
fn test_dirty_snapshot_job_sql_keeps_cte_commas() {
    let normalized = ACQUIRE_DIRTY_SNAPSHOT_JOB_SQL
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        normalized.contains("RETURNING next_token - 1 AS fencing_token ), dirty AS"),
        "token CTE must be comma-separated from dirty CTE: {normalized}"
    );
    assert!(
        normalized.contains("RETURNING (next_generation - 1)::BIGINT AS generation"),
        "watcher generation must decode into Rust i64: {normalized}"
    );
    for cte in [
        "WITH target AS",
        "generation_seed AS",
        "generation_alloc AS",
        "max_seen AS",
        "token AS",
        "dirty AS",
    ] {
        assert!(normalized.contains(cte), "missing CTE {cte}");
    }
}
