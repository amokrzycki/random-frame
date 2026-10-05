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
