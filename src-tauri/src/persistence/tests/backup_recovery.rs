use super::*;

#[test]
fn activity_backup_is_not_replaced_with_empty_state_on_another_platform() -> Result<(), AppError> {
    for torn_temporary in [false, true] {
        let directory = test_directory("activity-cross-platform-backup");
        fs::create_dir_all(&directory).map_err(AppError::persistence)?;
        let store = ActivityStore::new(&directory)?;
        for day in ["2026-09-19", "2026-09-20"] {
            store.record(ExplorationOutcome::Viewed, day)?;
            store.record(ExplorationOutcome::Rejected, day)?;
        }
        let operations = store.sync_state().0;
        assert_eq!(store.viewed_total(), 2);
        drop(store);
        // The Windows atomic replacement protocol can leave this durable file.
        // Opening that profile on Linux must also recover it.
        fs::rename(
            directory.join("activity-v2.json"),
            directory.join("activity-v2.json.bak"),
        )
        .map_err(AppError::persistence)?;
        if torn_temporary {
            fs::write(directory.join("activity-v2.json.tmp"), b"{\"version\":")
                .map_err(AppError::persistence)?;
        }
        let recovered = ActivityStore::new(&directory)?;
        assert_eq!(recovered.viewed_total(), 2);
        assert!(
            recovered.sync_state().0 == operations,
            "recovery must retain the recorded operations"
        );
        drop(recovered);
        let restarted = ActivityStore::new(&directory)?;
        assert_eq!(restarted.viewed_total(), 2);
        assert_eq!(restarted.sync_state().0, operations);
        // Another device can already hold the same operations. Merging them again
        // is a union of the same operations, not a double count.
        restarted.merge_sync_state(operations, Vec::new())?;
        assert_eq!(restarted.viewed_total(), 2);
        fs::remove_dir_all(directory).map_err(AppError::persistence)?;
    }
    Ok(())
}

#[test]
fn cleared_activity_backup_preserves_tombstones() -> Result<(), AppError> {
    let directory = test_directory("activity-cleared-backup");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    let store = ActivityStore::new(&directory)?;
    store.record(ExplorationOutcome::Viewed, "2026-09-19")?;
    store.clear()?;
    let removed = store.sync_state().1;
    assert_eq!(removed.len(), 1);
    drop(store);
    fs::rename(
        directory.join("activity-v2.json"),
        directory.join("activity-v2.json.bak"),
    )
    .map_err(AppError::persistence)?;
    let recovered = ActivityStore::new(&directory)?;
    assert_eq!(recovered.viewed_total(), 0);
    assert!(
        recovered.sync_state().1 == removed,
        "clear must survive backup recovery"
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn corrupt_committed_backup_fails_closed_instead_of_exporting_empty_activity(
) -> Result<(), AppError> {
    let directory = test_directory("activity-corrupt-backup");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    fs::write(directory.join("activity-v2.json.bak"), b"{\"version\":")
        .map_err(AppError::persistence)?;
    assert!(ActivityStore::new(&directory).is_err());
    assert!(!directory.join("activity-v2.json").exists());
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}
