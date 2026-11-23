use super::*;

#[test]
fn large_activity_survives_absent_remote_and_interrupted_merge() -> Result<(), AppError> {
    let directory = test_directory("large-merge-recovery");
    let remote_directory = test_directory("large-merge-remote");
    let local = PersistentState::new(&directory)?;
    for id in 1..=5 {
        local.discover(id, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    }
    assert_eq!(local.activity.viewed_total(), 5);
    let remote = PersistentState::new(&remote_directory)?;
    for id in [700_001, 700_002, 700_003] {
        remote.discover(id, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    }
    let incoming = remote.snapshot()?.0;
    fs::create_dir(directory.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    assert!(local.merge(&incoming).is_err());
    assert!(
        local.snapshot().is_err(),
        "partial merge must not be exported"
    );
    fs::remove_dir(directory.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    drop(local);
    let recovered = PersistentState::new(&directory)?;
    assert_eq!(recovered.activity.viewed_total(), 8);
    assert_eq!(recovered.snapshot()?.0.activity.len(), 8);
    recovered.merge(&incoming)?;
    assert_eq!(recovered.activity.viewed_total(), 8);
    fs::remove_dir_all(directory).map_err(AppError::persistence)?;
    fs::remove_dir_all(remote_directory).map_err(AppError::persistence)
}
