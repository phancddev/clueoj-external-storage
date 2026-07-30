use rust_data_plane::db::CatalogProblem;
use rust_data_plane::reconcile::{build_reconcile_plan, is_active_catalog_state};

#[test]
fn test_reconcile_plan_known_vs_orphan() {
    let folders = vec![
        "known".to_string(),
        "new_orphan".to_string(),
        "claimed".to_string(),
    ];
    let catalog = vec![
        CatalogProblem {
            external_id: "p1".to_string(),
            code: "known".to_string(),
            catalog_state: "present".to_string(),
        },
        CatalogProblem {
            external_id: "p2".to_string(),
            code: "missing".to_string(),
            catalog_state: "present".to_string(),
        },
        CatalogProblem {
            external_id: "p3".to_string(),
            code: "claimed".to_string(),
            catalog_state: "present".to_string(),
        },
    ];

    let plan = build_reconcile_plan(&folders, &catalog);
    let known_ids: std::collections::BTreeSet<&str> = plan
        .known_present
        .iter()
        .map(|p| p.external_id.as_str())
        .collect();
    assert_eq!(known_ids, std::collections::BTreeSet::from(["p1", "p3"]));
    assert_eq!(
        plan.missing_known
            .iter()
            .map(|p| p.external_id.as_str())
            .collect::<Vec<_>>(),
        vec!["p2"]
    );
    assert_eq!(plan.orphans, vec!["new_orphan"]);
}

#[test]
fn test_reconcile_plan_ignores_inactive_catalog_states() {
    let folders = vec![
        "deleted_but_folder_exists".to_string(),
        "mirror".to_string(),
    ];
    let catalog = vec![
        CatalogProblem {
            external_id: "p_deleted".to_string(),
            code: "deleted_but_folder_exists".to_string(),
            catalog_state: "missing".to_string(),
        },
        CatalogProblem {
            external_id: "p_mirror".to_string(),
            code: "mirror".to_string(),
            catalog_state: "mirror".to_string(),
        },
        CatalogProblem {
            external_id: "p_missing_no_folder".to_string(),
            code: "missing_no_folder".to_string(),
            catalog_state: "missing".to_string(),
        },
    ];

    let plan = build_reconcile_plan(&folders, &catalog);
    assert_eq!(
        plan.known_present
            .iter()
            .map(|p| p.external_id.as_str())
            .collect::<Vec<_>>(),
        vec!["p_mirror"]
    );
    assert!(plan.missing_known.is_empty());
    assert_eq!(plan.orphans, vec!["deleted_but_folder_exists"]);
    assert!(is_active_catalog_state("present"));
    assert!(is_active_catalog_state("mirror"));
    assert!(!is_active_catalog_state("missing"));
    assert!(!is_active_catalog_state("deleted"));
}
