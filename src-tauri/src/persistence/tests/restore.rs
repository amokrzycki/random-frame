use super::*;

#[test]
fn replacing_synchronized_state_drops_the_seen_log_and_survives_restart() -> Result<(), AppError> {
    let directory = test_directory("replace-seen-log");
    let state = PersistentState::new(&directory)?;
    // A pre-join local view lives only in the append log.
    state.seen.insert(41)?;
    state.seen.merge([40])?;
    let target = snapshot::SyncSnapshot {
        seen: vec![1, 2],
        ..snapshot::SyncSnapshot::default()
    };
    let generation = state.generation();
    state.replace_synchronized(&target)?;
    assert_ne!(state.generation(), generation);
    assert_eq!(state.snapshot()?.0.seen, vec![1, 2]);
    drop(state);
    let reopened = PersistentState::new(&directory)?;
    assert_eq!(reopened.snapshot()?.0.seen, vec![1, 2]);
    assert!(!reopened.seen.contains(41));
    // Replacing with the state already held is a no-op for every store generation.
    let generation = reopened.generation();
    reopened.replace_synchronized(&reopened.snapshot()?.0)?;
    assert_eq!(reopened.generation(), generation);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn restore_receipt_survives_restart_and_preserves_subsequent_collection_edits(
) -> Result<(), AppError> {
    let directory = test_directory("restore-receipt");
    let state = PersistentState::new(&directory)?;
    state.favorites.create_collection("Restored")?;
    let target = state.snapshot()?.0;
    state.replace_synchronized_once(&target, Some([42; 16]))?;
    state.favorites.create_collection("After Restore")?;
    let expected = state.snapshot()?.0;
    drop(state);
    let reopened = PersistentState::new(&directory)?;
    let generation = reopened.generation();
    reopened.replace_synchronized_once(&target, Some([42; 16]))?;
    assert_eq!(reopened.snapshot()?.0, expected);
    assert_eq!(reopened.generation(), generation);
    // A different Restore remains authoritative and replaces all represented domains.
    reopened.replace_synchronized_once(&target, Some([43; 16]))?;
    assert_eq!(reopened.snapshot()?.0, target);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}
