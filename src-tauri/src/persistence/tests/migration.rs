use super::*;
use crate::snapshot::{ActivityOperation, Outcome, SyncSnapshot};
#[test]
fn undo_preserves_remote_source_day_and_inferred_flag() -> Result<(), AppError> {
    let dir = test_directory("undo-source-day");
    let store = HistoryStore::new(&dir)?;
    let stamp = snapshot::ViewStamp {
        at_ms: 1,
        day: "2026-10-02".into(),
        day_inferred: true,
    };
    store.merge_sync_state((
        vec![snapshot::SyncRecord {
            operation_id: [1; 16],
            order_at: 1,
            last_view: stamp.clone(),
            source: "prntsc".into(),
            id: "1".into(),
            source_page_url: "https://prnt.sc/1".into(),
        }],
        vec![],
    ))?;
    let item = store.snapshot().history[0].clone();
    let removed = store.remove("prntsc", "1")?;
    store.restore(item, removed.order_at, removed.last_view)?;
    assert_eq!(HistoryStore::new(&dir)?.sync_state().0[0].last_view, stamp);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn repeated_clear_commit_does_not_remove_later_changes() -> Result<(), AppError> {
    let dir = test_directory("clear-scope");
    let state = PersistentState::new(&dir)?;
    state.discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    let request = state.prepare_clear()?;
    state.discover(2, ExplorationOutcome::Viewed, 2, "2026-10-02")?;
    state.commit_clear(&request)?;
    state.commit_clear(&request)?;
    assert_eq!(state.activity.viewed_total(), 1);
    assert_eq!(state.explored.counts().0, 2);
    drop(state);
    assert_eq!(PersistentState::new(&dir)?.activity.viewed_total(), 1);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn immutable_operation_conflict_changes_no_store() -> Result<(), AppError> {
    let dir = test_directory("conflict-atomic");
    let state = PersistentState::new(&dir)?;
    state.discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    let (before, generation) = state.snapshot()?;
    let mut conflicting = before.clone();
    conflicting.seen.push(999);
    let ActivityOperation::Discovery { outcome, .. } = &mut conflicting.activity[0];
    *outcome = Outcome::Rejected;
    assert!(state.merge(&conflicting).is_err());
    assert_eq!(state.snapshot()?, (before, generation));
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn clear_removes_known_activity_but_preserves_unknown_offline_activity() -> Result<(), AppError> {
    let dir_a = test_directory("reset-a");
    let dir_b = test_directory("reset-b");
    let a = PersistentState::new(&dir_a)?;
    let b = PersistentState::new(&dir_b)?;
    a.discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    let old = a.snapshot()?.0;
    b.merge(&old)?;
    b.discover(2, ExplorationOutcome::Viewed, 2, "2026-10-02")?;
    let reset = a.prepare_clear()?;
    a.commit_clear(&reset)?;
    a.merge(&b.snapshot()?.0)?;
    a.merge(&old)?;
    assert_eq!(a.activity.viewed_total(), 1);
    assert_eq!(a.snapshot()?.0.activity_removed.len(), 1);
    assert_eq!(a.explored.count(), 2);
    fs::remove_dir_all(dir_a).map_err(AppError::persistence)?;
    fs::remove_dir_all(dir_b).map_err(AppError::persistence)
}
#[test]
fn same_frame_independent_offline_discoveries_remain_distinct() -> Result<(), AppError> {
    let dir_a = test_directory("independent-a");
    let dir_b = test_directory("independent-b");
    let a = PersistentState::new(&dir_a)?;
    let b = PersistentState::new(&dir_b)?;
    a.discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    b.discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    a.merge(&b.snapshot()?.0)?;
    a.merge(&b.snapshot()?.0)?;
    assert_eq!(a.activity.viewed_total(), 2);
    assert_eq!(a.explored.count(), 1);
    let reloaded = PersistentState::new(&dir_a)?;
    assert_eq!(reloaded.activity.viewed_total(), 2);
    assert_eq!(a.activity.viewed_total(), 2);
    let generation = a.snapshot()?.1;
    a.merge(&a.snapshot()?.0)?;
    assert_eq!(a.snapshot()?.1, generation);
    fs::remove_dir_all(dir_a).map_err(AppError::persistence)?;
    fs::remove_dir_all(dir_b).map_err(AppError::persistence)
}
#[test]
fn remote_exploration_merge_does_not_create_activity() -> Result<(), AppError> {
    let dir = test_directory("remote-discovery");
    let a = PersistentState::new(&dir)?;
    a.merge(&SyncSnapshot {
        exploration: vec![snapshot::ExplorationRecord {
            source: "prntsc".into(),
            id: "1".into(),
            evidence: 1,
        }],
        ..SyncSnapshot::default()
    })?;
    a.discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    assert_eq!(a.activity.viewed_total(), 0);
    assert!(!a.seen.contains(1));
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn discovery_recovers_after_failure_between_store_writes() -> Result<(), AppError> {
    let dir = test_directory("discovery-replay");
    let a = PersistentState::new(&dir)?;
    fs::create_dir(dir.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    assert!(a
        .discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")
        .is_err());
    let journal_before =
        fs::read(dir.join("state-transaction.json")).map_err(AppError::persistence)?;
    assert!(a.snapshot().is_err());
    assert_eq!(
        fs::read(dir.join("state-transaction.json")).map_err(AppError::persistence)?,
        journal_before
    );
    fs::remove_dir(dir.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    drop(a);
    let a = PersistentState::new(&dir)?;
    let saved = a.snapshot()?.0;
    assert_eq!(a.activity.viewed_total(), 1);
    assert_eq!(a.explored.count(), 1);
    a.discover(1, ExplorationOutcome::Viewed, 2, "2026-10-03")?;
    assert_eq!(a.snapshot()?.0, saved);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn combined_clear_recovers_without_partial_reset() -> Result<(), AppError> {
    let dir = test_directory("clear-replay");
    let a = PersistentState::new(&dir)?;
    a.accept(&HistoryItem {
        source: "prntsc".into(),
        id: "1".into(),
        source_page_url: "https://prnt.sc/1".into(),
        viewed_at: 1,
    })?;
    let request = a.prepare_clear()?;
    fs::create_dir(dir.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    assert!(a.commit_clear(&request).is_err());
    assert!(a.snapshot().is_err());
    fs::remove_dir(dir.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    drop(a);
    let a = PersistentState::new(&dir)?;
    assert_eq!(a.history.snapshot().history.len(), 0);
    assert_eq!(a.activity.viewed_total(), 0);
    assert!(a.seen.contains(1));
    assert_eq!(a.explored.count(), 1);
    a.discover(2, ExplorationOutcome::Viewed, 2, "2026-10-02")?;
    a.commit_clear(&request)?;
    assert_eq!(a.activity.viewed_total(), 1);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn prepared_clear_restarts_with_frozen_scope_and_cancel_preserves_data() -> Result<(), AppError> {
    let dir = test_directory("prepared-clear");
    let a = PersistentState::new(&dir)?;
    a.discover(1, ExplorationOutcome::Viewed, 1, "2026-10-02")?;
    let cancelled = a.prepare_clear()?;
    a.cancel_clear(&cancelled)?;
    assert_eq!(a.activity.viewed_total(), 1);
    let prepared = a.prepare_clear()?;
    a.discover(2, ExplorationOutcome::Viewed, 2, "2026-10-02")?;
    drop(a);
    let a = PersistentState::new(&dir)?;
    a.commit_clear(&prepared)?;
    assert_eq!(a.activity.viewed_total(), 1);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn preferences_observe_remote_clocks_before_local_edits() -> Result<(), AppError> {
    let dir = test_directory("preference-clocks");
    let a = PersistentState::new(&dir)?;
    a.preferences.set(UserPreferences {
        theme: Some("dark".into()),
        history_page_size: None,
    })?;
    let remote = SyncSnapshot {
        preferences: snapshot::Preferences {
            theme: Some(snapshot::Register {
                clock: 500,
                operation_id: [1; 16],
                value: "light".into(),
            }),
            history_page_size: None,
        },
        ..SyncSnapshot::default()
    };
    a.merge(&remote)?;
    a.preferences.set(UserPreferences {
        theme: Some("system".into()),
        history_page_size: None,
    })?;
    assert!(
        a.snapshot()?
            .0
            .preferences
            .theme
            .ok_or_else(|| AppError::persistence("Missing theme"))?
            .clock
            > 500
    );
    drop(a);
    let a = PersistentState::new(&dir)?;
    assert_eq!(a.preferences.get().theme.as_deref(), Some("system"));
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
#[test]
fn source_day_survives_recovery_and_clear_keeps_later_activity() -> Result<(), AppError> {
    let dir = test_directory("source-day");
    let a = PersistentState::new(&dir)?;
    let item = HistoryItem {
        source: "prntsc".into(),
        id: "1".into(),
        source_page_url: "https://prnt.sc/1".into(),
        viewed_at: 1,
    };
    a.accept(&item)?;
    let mut remote = a.snapshot()?.0;
    remote.history[0].last_view = snapshot::ViewStamp {
        at_ms: 2,
        day: "2026-10-02".into(),
        day_inferred: false,
    };
    a.merge(&remote)?;
    assert_eq!(a.history.frame_views()[0].day, "2026-10-02");
    let request = a.prepare_clear()?;
    a.commit_clear(&request)?;
    a.discover(2, ExplorationOutcome::Viewed, 2, "2026-10-02")?;
    drop(a);
    let a = PersistentState::new(&dir)?;
    assert_eq!(a.history.snapshot().history, vec![]);
    assert_eq!(a.activity.viewed_total(), 1);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn interrupted_remote_merge_is_recovered() -> Result<(), AppError> {
    let dir = test_directory("schema-replay");
    let a = PersistentState::new(&dir)?;
    let remote = SyncSnapshot {
        activity: vec![ActivityOperation::Discovery {
            operation_id: [1; 16],
            source: "prntsc".into(),
            id: "1".into(),
            outcome: Outcome::Viewed,
            occurred_at_ms: 1,
            day: "2026-10-02".into(),
        }],
        ..SyncSnapshot::default()
    };
    fs::create_dir(dir.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    assert!(a.merge(&remote).is_err());
    fs::remove_dir(dir.join("activity-v2.json.tmp")).map_err(AppError::persistence)?;
    drop(a);
    let a = PersistentState::new(&dir)?;
    assert_eq!(a.activity.viewed_total(), 1);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
