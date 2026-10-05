use super::*;
use crate::snapshot::ActivityOperation;

#[test]
fn large_activity_survives_absent_remote_and_interrupted_versioned_merge() -> Result<(), AppError> {
    let directory = test_directory("large-merge-recovery");
    let remote_directory = test_directory("large-merge-remote");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    fs::write(
        directory.join("activity.json"),
        include_bytes!("fixtures/activity-large-legacy.json"),
    )
    .map_err(AppError::persistence)?;
    let local = PersistentState::new(&directory)?;
    local.merge_versioned(&snapshot::SyncSnapshot::default(), "test", 1)?;
    assert_eq!(local.activity.viewed_total(), 5752);
    local.merge_versioned(&snapshot::SyncSnapshot::default(), "test", 2)?;
    assert_eq!(local.activity.viewed_total(), 5752);
    let remote = PersistentState::new(&remote_directory)?;
    for id in [700_001, 700_002, 700_003] {
        remote.discover(id, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    }
    let incoming = remote.snapshot()?.0;
    fs::create_dir(directory.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    assert!(local.merge_versioned(&incoming, "test", 2).is_err());
    assert!(
        local.snapshot().is_err(),
        "partial merge must not be exported"
    );
    fs::remove_dir(directory.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    drop(local);
    let recovered = PersistentState::new(&directory)?;
    assert_eq!(recovered.activity.viewed_total(), 5755);
    assert_eq!(recovered.snapshot()?.0.activity.len(), 4);
    recovered.merge_versioned(&incoming, "test", 2)?;
    assert_eq!(recovered.activity.viewed_total(), 5755);
    assert_eq!(recovered.schema_floor("test")?, 2);
    fs::remove_dir_all(directory).map_err(AppError::persistence)?;
    fs::remove_dir_all(remote_directory).map_err(AppError::persistence)
}

#[test]
fn large_realistic_legacy_activity_import_is_durable_and_keeps_its_operation(
) -> Result<(), AppError> {
    let dir = test_directory("large-legacy-activity");
    fs::create_dir_all(&dir).map_err(AppError::persistence)?;
    fs::write(
        dir.join("activity.json"),
        include_bytes!("fixtures/activity-large-legacy.json"),
    )
    .map_err(AppError::persistence)?;

    // The checked-in fixture preserves a real day distribution with no user or frame data.
    let imported = ActivityStore::new(&dir)?;
    assert_eq!(imported.viewed_total(), 5752);
    let (operations, removed) = imported.sync_state();
    assert_eq!(removed.len(), 0);
    assert_eq!(operations.len(), 1);
    let ActivityOperation::LegacyImport {
        operation_id,
        viewed_total,
        days,
    } = &operations[0]
    else {
        unreachable!("legacy file becomes one LegacyImport operation")
    };
    assert_eq!(*viewed_total, 5752);
    assert_eq!(days.len(), 10);
    assert_eq!(days.values().map(|x| x.viewed).sum::<u64>(), 5752);
    assert_eq!(days.values().map(|x| x.rejected).sum::<u64>(), 6255);

    // Restart reuses the imported operation ID; the untouched source is not counted twice.
    drop(imported);
    let restarted = ActivityStore::new(&dir)?;
    assert_eq!(restarted.viewed_total(), 5752);
    assert_eq!(restarted.sync_state().0[0].operation_id(), *operation_id);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
