use super::*;

#[test]
fn activity_backup_is_not_replaced_with_empty_state_on_another_platform() -> Result<(), AppError> {
    for torn_temporary in [false, true] {
        let directory = test_directory("activity-cross-platform-backup");
        fs::create_dir_all(&directory).map_err(AppError::persistence)?;
        fs::write(
            directory.join("activity.json"),
            include_bytes!("fixtures/activity-large-legacy.json"),
        )
        .map_err(AppError::persistence)?;
        let store = ActivityStore::new(&directory)?;
        let operations = store.sync_state().0;
        drop(store);
        // The Windows atomic replacement protocol can leave this durable file.
        // Migrating or inspecting that profile on Linux must also recover it.
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
        assert_eq!(recovered.viewed_total(), 5752);
        assert!(
            recovered.sync_state().0 == operations,
            "recovery must retain imported IDs"
        );
        drop(recovered);
        let restarted = ActivityStore::new(&directory)?;
        assert_eq!(restarted.viewed_total(), 5752);
        assert!(
            restarted.sync_state().0 == operations,
            "restart must not reimport legacy"
        );
        // Another device can already hold the original import. Recovery reuses
        // its ID, so the next sync is a union of the same operation, not +5,752.
        restarted.merge_sync_state(operations, Vec::new(), false)?;
        assert_eq!(restarted.viewed_total(), 5752);
        fs::remove_dir_all(directory).map_err(AppError::persistence)?;
    }
    Ok(())
}

#[test]
fn cleared_activity_backup_preserves_tombstones_and_closed_browser_import() -> Result<(), AppError>
{
    let directory = test_directory("activity-cleared-backup");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    fs::write(
        directory.join("activity.json"),
        include_bytes!("fixtures/activity-large-legacy.json"),
    )
    .map_err(AppError::persistence)?;
    let store = ActivityStore::new(&directory)?;
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
    recovered.migrate("2026-10-03", 3, 5752, "2026-10-03")?;
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

#[test]
fn backup_migration_receipt_blocks_reimport_of_a_missing_committed_ledger() -> Result<(), AppError>
{
    let directory = test_directory("activity-backup-receipt");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    fs::write(
        directory.join("activity.json"),
        include_bytes!("fixtures/activity-large-legacy.json"),
    )
    .map_err(AppError::persistence)?;
    drop(ActivityStore::new(&directory)?);
    fs::rename(
        directory.join("state-migration.json"),
        directory.join("state-migration.json.bak"),
    )
    .map_err(AppError::persistence)?;
    fs::remove_file(directory.join("activity-v2.json")).map_err(AppError::persistence)?;
    // A fresh import ID would double count the old import when the remote returns.
    assert!(ActivityStore::new(&directory).is_err());
    assert!(!directory.join("activity-v2.json").exists());
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}
