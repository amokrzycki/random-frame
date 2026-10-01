use super::*;

#[test]
fn history_survives_reload_and_clear_is_persistent() -> Result<(), AppError> {
    let directory = test_directory("history");
    let store = HistoryStore::new(&directory)?;
    store.record(HistoryItem {
        source: "prntsc".to_owned(),
        id: "abc123".to_owned(),
        source_page_url: "https://prnt.sc/abc123".to_owned(),
        viewed_at: 42,
    })?;

    let reloaded = HistoryStore::new(&directory)?;
    assert_eq!(reloaded.snapshot().history[0].id, "abc123");
    assert_eq!(reloaded.sync_state().0.len(), 1);
    reloaded.record(HistoryItem {
        source: "prntsc".to_owned(),
        id: "abc123".to_owned(),
        source_page_url: "https://prnt.sc/abc123".to_owned(),
        viewed_at: 84,
    })?;
    assert_eq!(reloaded.snapshot().history.len(), 1);
    assert_eq!(reloaded.sync_state().0.len(), 1);
    assert_eq!(reloaded.snapshot().history[0].viewed_at, 84);
    reloaded.clear()?;
    assert_eq!(HistoryStore::new(&directory)?.snapshot().history, vec![]);
    fs::rename(
        directory.join("history.json"),
        directory.join("history.json.tmp"),
    )
    .map_err(AppError::persistence)?;
    assert_eq!(HistoryStore::new(&directory)?.snapshot().history, vec![]);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn remove_drops_one_frame_and_restore_returns_it_in_place() -> Result<(), AppError> {
    let directory = test_directory("history-remove");
    let item = |id: &str, viewed_at| HistoryItem {
        source: "prntsc".to_owned(),
        id: id.to_owned(),
        source_page_url: format!("https://prnt.sc/{id}"),
        viewed_at,
    };
    let store = HistoryStore::new(&directory)?;
    for (id, at) in [("aaa111", 10), ("bbb222", 20), ("ccc333", 30)] {
        store.record(item(id, at))?;
    }
    store.select(1)?;

    let removed = store.remove("prntsc", "bbb222")?;
    let ids = |snapshot: &HistorySnapshot| {
        snapshot
            .history
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&removed.snapshot), ["aaa111", "ccc333"]);
    // The shown frame is gone, so nothing is selected until the client picks a neighbour.
    assert_eq!(removed.snapshot.index, -1);
    assert!(store.remove("prntsc", "bbb222").is_err());
    // The removal is a tombstone, so it survives a reload and reaches synced devices.
    assert_eq!(
        ids(&HistoryStore::new(&directory)?.snapshot()),
        ["aaa111", "ccc333"]
    );
    assert_eq!(store.sync_state().1.len(), 1);

    let restored = store.restore(item("bbb222", 20), removed.order_at)?;
    assert_eq!(ids(&restored), ["aaa111", "bbb222", "ccc333"]);
    assert_eq!(
        ids(&store.restore(item("bbb222", 20), removed.order_at)?),
        ["aaa111", "bbb222", "ccc333"]
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn favorite_toggle_adds_then_removes_and_survives_reload() -> Result<(), AppError> {
    let directory = test_directory("favorites");
    let item = |added_at| FavoriteItem {
        source: "prntsc".to_owned(),
        id: "abc123".to_owned(),
        source_page_url: "https://prnt.sc/abc123".to_owned(),
        added_at,
    };
    let store = FavoriteStore::new(&directory)?;
    assert_eq!(store.toggle(item(42))?, vec![item(42)]);
    // Membership is by (source, id): a later timestamp still removes the same frame.
    assert_eq!(store.toggle(item(84))?, vec![]);
    assert_eq!(store.toggle(item(126))?, vec![item(126)]);

    let reloaded = FavoriteStore::new(&directory)?;
    assert_eq!(reloaded.snapshot(), vec![item(126)]);
    // A save interrupted before its rename leaves only the .tmp file; it is recovered on load.
    fs::rename(
        directory.join("favorites.json"),
        directory.join("favorites.json.tmp"),
    )
    .map_err(AppError::persistence)?;
    assert_eq!(FavoriteStore::new(&directory)?.snapshot(), vec![item(126)]);
    assert!(directory.join("favorites.json").exists());
    reloaded.clear()?;
    assert_eq!(FavoriteStore::new(&directory)?.snapshot(), vec![]);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn history_and_favorites_sync_merge_is_idempotent_and_preserves_removals() -> Result<(), AppError> {
    let a_dir = test_directory("sync-state-a");
    let b_dir = test_directory("sync-state-b");
    let a_history = HistoryStore::new(&a_dir)?;
    let b_history = HistoryStore::new(&b_dir)?;
    let a_favorites = FavoriteStore::new(&a_dir)?;
    let b_favorites = FavoriteStore::new(&b_dir)?;
    let item = || HistoryItem {
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
        viewed_at: 42,
    };
    a_history.record(item())?;
    a_favorites.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
        added_at: 42,
    })?;
    b_history.merge_sync_state(a_history.sync_state())?;
    b_favorites.merge_sync_state(a_favorites.sync_state())?;
    assert_eq!(b_history.snapshot().history.len(), 1);
    assert_eq!(b_favorites.snapshot().len(), 1);
    b_history.merge_sync_state(a_history.sync_state())?;
    b_favorites.merge_sync_state(a_favorites.sync_state())?;
    assert_eq!(b_history.sync_state().0.len(), 1);
    assert_eq!(b_favorites.sync_state().0.len(), 1);
    a_history.clear()?;
    a_favorites.clear()?;
    b_history.merge_sync_state(a_history.sync_state())?;
    b_favorites.merge_sync_state(a_favorites.sync_state())?;
    assert_eq!(b_history.snapshot().history, vec![]);
    assert_eq!(b_favorites.snapshot(), vec![]);
    fs::remove_dir_all(a_dir).map_err(AppError::persistence)?;
    fs::remove_dir_all(b_dir).map_err(AppError::persistence)
}

#[test]
fn concurrent_favorites_project_once_and_toggle_removes_all_adds() -> Result<(), AppError> {
    let a_dir = test_directory("favorite-concurrent-a");
    let b_dir = test_directory("favorite-concurrent-b");
    let a = FavoriteStore::new(&a_dir)?;
    let b = FavoriteStore::new(&b_dir)?;
    let item = FavoriteItem {
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
        added_at: 42,
    };
    a.toggle(item.clone())?;
    b.toggle(item.clone())?;
    a.merge_sync_state(b.sync_state())?;
    assert_eq!(a.snapshot(), vec![item.clone()]);
    assert_eq!(a.toggle(item)?, vec![]);
    b.merge_sync_state(a.sync_state())?;
    assert_eq!(b.snapshot(), vec![]);
    fs::remove_dir_all(a_dir).map_err(AppError::persistence)?;
    fs::remove_dir_all(b_dir).map_err(AppError::persistence)
}

#[test]
fn history_merge_keeps_latest_view_and_selected_frame() -> Result<(), AppError> {
    let a_dir = test_directory("history-merge-a");
    let b_dir = test_directory("history-merge-b");
    let a = HistoryStore::new(&a_dir)?;
    let b = HistoryStore::new(&b_dir)?;
    let item = |id: &str, viewed_at| HistoryItem {
        source: "prntsc".into(),
        id: id.into(),
        source_page_url: format!("https://prnt.sc/{id}"),
        viewed_at,
    };
    a.record(item("x", 42))?;
    b.merge_sync_state(a.sync_state())?;
    a.record(item("x", 84))?;
    b.merge_sync_state(a.sync_state())?;
    assert_eq!(b.snapshot().history[0].viewed_at, 84);

    b.record(item("y", 90))?;
    b.select(1)?;
    b.merge_sync_state((
        vec![snapshot::SyncRecord {
            operation_id: [0; 16],
            first_at: 0,
            second_at: 10,
            source: "prntsc".into(),
            id: "before".into(),
            source_page_url: "https://prnt.sc/before".into(),
        }],
        vec![],
    ))?;
    let selected = b.snapshot();
    let index = usize::try_from(selected.index).map_err(AppError::persistence)?;
    assert_eq!(selected.history[index].id, "y");
    assert_eq!(
        b.local_view_times()
            .iter()
            .filter(|time| time.is_some())
            .count(),
        1
    );
    fs::remove_dir_all(a_dir).map_err(AppError::persistence)?;
    fs::remove_dir_all(b_dir).map_err(AppError::persistence)
}

#[test]
fn new_frames_land_last_after_merges_and_remote_clears() -> Result<(), AppError> {
    let a_dir = test_directory("history-order-a");
    let b_dir = test_directory("history-order-b");
    let a = HistoryStore::new(&a_dir)?;
    let b = HistoryStore::new(&b_dir)?;
    let item = |id: &str, viewed_at| HistoryItem {
        source: "prntsc".into(),
        id: id.into(),
        source_page_url: format!("https://prnt.sc/{id}"),
        viewed_at,
    };
    let ids = |store: &HistoryStore| {
        store
            .snapshot()
            .history
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>()
    };
    for (index, id) in ["a1", "a2", "a3"].into_iter().enumerate() {
        a.record(item(id, 10 + index as u64))?;
    }
    b.record(item("b1", 20))?;
    a.merge_sync_state(b.sync_state())?;
    assert_eq!(ids(&a), ["a1", "a2", "a3", "b1"]);
    a.record(item("a4", 15))?;
    assert_eq!(ids(&a).last().map(String::as_str), Some("a4"));

    b.merge_sync_state(a.sync_state())?;
    b.clear()?;
    a.record(item("a5", 30))?;
    a.merge_sync_state(b.sync_state())?;
    assert_eq!(ids(&a), ["a5"]);
    assert_eq!(a.local_view_times(), vec![Some(30)]);
    a.record(item("a6", 1))?;
    assert_eq!(ids(&a), ["a5", "a6"]);
    fs::remove_dir_all(a_dir).map_err(AppError::persistence)?;
    fs::remove_dir_all(b_dir).map_err(AppError::persistence)
}

#[test]
fn sync_sections_stay_within_snapshot_limits() -> Result<(), AppError> {
    let directory = test_directory("history-limits");
    let history = HistoryStore::new(&directory)?;
    let favorites = FavoriteStore::new(&directory)?;
    let op_id = |index: usize| {
        let mut id = [0; 16];
        id[..8].copy_from_slice(&(index as u64).to_le_bytes());
        id
    };
    let records = (0..=MAX_SECTION)
        .map(|index| snapshot::SyncRecord {
            operation_id: op_id(index),
            first_at: index as u64,
            second_at: index as u64,
            source: "prntsc".into(),
            id: index.to_string(),
            source_page_url: String::new(),
        })
        .collect();
    let tombstones = (0..=MAX_SECTION)
        .map(|index| op_id((index + 1) << 32))
        .collect();
    history.merge_sync_state((records, tombstones))?;
    let (ops, removed) = history.sync_state();
    assert_eq!(ops.len(), MAX_SECTION);
    assert_eq!(removed.len(), MAX_SECTION);
    assert!(ops.iter().all(|op| op.id != "0"));
    assert!(removed.contains(&op_id(0)));
    assert_eq!(history.snapshot().history.len(), MAX_SECTION);

    let long = FavoriteItem {
        source: "prntsc".into(),
        id: "x".repeat(129),
        source_page_url: String::new(),
        added_at: 1,
    };
    assert!(favorites.toggle(long).is_err());
    assert!(history
        .record(HistoryItem {
            source: String::new(),
            id: "abc".into(),
            source_page_url: String::new(),
            viewed_at: 1,
        })
        .is_err());
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn cleared_favorites_are_not_restored_by_a_later_merge() -> Result<(), AppError> {
    let a_dir = test_directory("favorite-clear-a");
    let b_dir = test_directory("favorite-clear-b");
    let a = FavoriteStore::new(&a_dir)?;
    let b = FavoriteStore::new(&b_dir)?;
    a.toggle(FavoriteItem {
        source: "prntsc".into(),
        id: "abc123".into(),
        source_page_url: "https://prnt.sc/abc123".into(),
        added_at: 42,
    })?;
    b.merge_sync_state(a.sync_state())?;
    let before_clear = b.sync_state();
    b.clear()?;
    b.merge_sync_state(before_clear)?;
    assert_eq!(b.sync_state().0, vec![]);
    assert_eq!(b.sync_state().1.len(), 1);
    fs::remove_dir_all(a_dir).map_err(AppError::persistence)?;
    fs::remove_dir_all(b_dir).map_err(AppError::persistence)
}

#[test]
fn history_views_per_day_counts_only_prntsc_entries_by_local_day() -> Result<(), AppError> {
    let directory = test_directory("history-views-per-day");
    let store = HistoryStore::new(&directory)?;
    let viewed_at: u64 = 1_789_000_000_000;
    for (source, id) in [
        ("prntsc", "abc123"),
        ("prntsc", "abc124"),
        ("other", "abc125"),
    ] {
        store.record(HistoryItem {
            source: source.to_owned(),
            id: id.to_owned(),
            source_page_url: format!("https://prnt.sc/{id}"),
            viewed_at,
        })?;
    }
    let day = Local
        .timestamp_millis_opt(1_789_000_000_000)
        .single()
        .map(|time| day_key(activity_day(&time)))
        .unwrap_or_default();
    assert_eq!(store.prntsc_views_per_day(), BTreeMap::from([(day, 2)]));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}
