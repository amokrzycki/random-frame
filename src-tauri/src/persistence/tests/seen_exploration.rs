use super::*;
use std::{fs::OpenOptions, io::Write};

#[test]
fn seen_insert_merge_and_reload_are_monotonic_and_idempotent() -> Result<(), AppError> {
    let directory = test_directory("seen");
    let store = SeenStore::new(&directory)?;
    assert!(!store.contains(42));
    assert!(store.insert(42)?);
    assert!(!store.insert(42)?);
    assert_eq!(store.merge([42, 43, 43, 44])?, 2);
    assert_eq!(store.merge([42, 43, 44])?, 0);
    drop(store);
    let reloaded = SeenStore::new(&directory)?;
    assert!(reloaded.contains(42));
    assert!(reloaded.contains(43));
    assert!(reloaded.contains(44));
    assert_eq!(reloaded.merge([44, 45])?, 1);
    let saved: Vec<u64> = load_json(&directory.join("prntsc-seen.json"))?;
    assert_eq!(saved, vec![42, 43, 44, 45]);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn local_seen_insert_appends_without_rewriting_snapshot() -> Result<(), AppError> {
    let directory = test_directory("seen-append");
    let store = SeenStore::new(&directory)?;
    store.merge([42])?;
    let snapshot_before =
        fs::read(directory.join("prntsc-seen.json")).map_err(AppError::persistence)?;
    assert!(store.insert(43)?);
    assert_eq!(
        fs::read(directory.join("prntsc-seen.json")).map_err(AppError::persistence)?,
        snapshot_before
    );
    assert_eq!(
        fs::read(directory.join("prntsc-seen.log")).map_err(AppError::persistence)?,
        43_u64.to_le_bytes()
    );
    drop(store);
    assert!(SeenStore::new(&directory)?.contains(43));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn truncated_seen_log_tail_is_repaired_before_next_insert() -> Result<(), AppError> {
    let directory = test_directory("seen-log-tail");
    let store = SeenStore::new(&directory)?;
    store.insert(42)?;
    drop(store);
    OpenOptions::new()
        .append(true)
        .open(directory.join("prntsc-seen.log"))
        .and_then(|mut file| file.write_all(&[1, 2, 3]))
        .map_err(AppError::persistence)?;
    let reloaded = SeenStore::new(&directory)?;
    assert!(reloaded.contains(42));
    assert!(reloaded.insert(43)?);
    drop(reloaded);
    assert!(SeenStore::new(&directory)?.contains(43));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn snapshot_merge_is_atomic_monotonic_and_persistent() -> Result<(), AppError> {
    let directory = test_directory("snapshot-merge");
    let local = SeenStore::new(&directory)?;
    local.insert(1)?;
    let bytes = snapshot::serialize_snapshot(&snapshot::SyncSnapshot {
        seen: vec![2, 3],
        ..snapshot::SyncSnapshot::default()
    })
    .map_err(AppError::persistence)?;

    let mut corrupt = bytes.clone();
    corrupt.extend_from_slice(&4_u64.to_le_bytes());
    assert!(snapshot::parse_snapshot(&corrupt).is_err());
    let mut invalid_last = bytes.clone();
    invalid_last[40..48]
        .copy_from_slice(&(crate::sources::prntsc::LEGACY_MAX_VALUE + 1).to_le_bytes());
    assert!(snapshot::parse_snapshot(&invalid_last).is_err());
    assert!(local.contains(1));
    assert!(!local.contains(2));
    let incoming = snapshot::parse_snapshot(&bytes)
        .map_err(AppError::persistence)?
        .seen;
    assert_eq!(local.merge(incoming.clone())?, 2);
    assert_eq!(local.merge(incoming)?, 0);
    assert_eq!(local.merge([])?, 0);
    assert_eq!(local.merge([2])?, 0);
    drop(local);
    let reloaded = SeenStore::new(&directory)?;
    assert_eq!(reloaded.snapshot_with_generation().0, vec![1, 2, 3]);
    let empty_directory = test_directory("snapshot-empty");
    let empty = SeenStore::new(&empty_directory)?;
    assert_eq!(
        empty.merge(
            snapshot::parse_snapshot(&bytes)
                .map_err(AppError::persistence)?
                .seen
        )?,
        2
    );

    fs::remove_dir_all(directory).map_err(AppError::persistence)?;
    fs::remove_dir_all(empty_directory).map_err(AppError::persistence)
}

#[test]
#[ignore = "manual size and timing measurement; includes local JSON persistence in merge"]
#[allow(
    clippy::print_stderr,
    reason = "measurement is reported from an ignored test"
)]
fn measure_snapshot_sizes_and_times() -> Result<(), AppError> {
    use std::time::Instant;

    for count in [100_u64, 10_000, 100_000, 500_000, 1_000_000] {
        let directory = test_directory("snapshot-measure");
        let store = SeenStore::new(&directory)?;
        let ids: HashSet<_> = (0..count).collect();

        let start = Instant::now();
        let mut seen: Vec<_> = ids.into_iter().collect();
        seen.sort_unstable();
        let bytes = snapshot::serialize_snapshot(&snapshot::SyncSnapshot {
            seen,
            ..snapshot::SyncSnapshot::default()
        })
        .map_err(AppError::persistence)?;
        let serialize = start.elapsed();
        let start = Instant::now();
        let parsed = snapshot::parse_snapshot(&bytes)
            .map_err(AppError::persistence)?
            .seen;
        let parse = start.elapsed();
        let start = Instant::now();
        let added = store.merge(parsed)?;
        let merge = start.elapsed();
        assert_eq!(
            added,
            usize::try_from(count).map_err(AppError::persistence)?
        );
        eprintln!(
            "{count}\t{}\t{serialize:?}\t{parse:?}\t{merge:?}",
            bytes.len()
        );
        #[cfg(target_os = "linux")]
        {
            let status = fs::read_to_string("/proc/self/status").map_err(AppError::persistence)?;
            eprintln!(
                "{}",
                status
                    .lines()
                    .find(|line| line.starts_with("VmHWM:"))
                    .unwrap_or("VmHWM unavailable")
            );
        }
        fs::remove_dir_all(directory).map_err(AppError::persistence)?;
    }
    Ok(())
}

#[test]
fn interrupted_seen_snapshot_is_recovered() -> Result<(), AppError> {
    let directory = test_directory("seen-recovery");
    let store = SeenStore::new(&directory)?;
    store.merge([42])?;
    drop(store);
    fs::rename(
        directory.join("prntsc-seen.json"),
        directory.join("prntsc-seen.json.tmp"),
    )
    .map_err(AppError::persistence)?;
    assert!(SeenStore::new(&directory)?.contains(42));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn failed_seen_save_does_not_change_memory_or_disk() -> Result<(), AppError> {
    let directory = test_directory("seen-failed-save");
    let store = SeenStore::new(&directory)?;
    store.merge([42])?;
    fs::create_dir(directory.join("prntsc-seen.log")).map_err(AppError::persistence)?;
    assert!(store.insert(43).is_err());
    assert!(!store.contains(43));
    fs::remove_dir(directory.join("prntsc-seen.log")).map_err(AppError::persistence)?;
    assert!(SeenStore::new(&directory)?.contains(42));
    assert!(!SeenStore::new(&directory)?.contains(43));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn explored_ids_are_unique_race_safe_and_persistent() -> Result<(), AppError> {
    let directory = test_directory("explored");
    let store = Arc::new(ExplorationStore::new(&directory)?);
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let store = Arc::clone(&store);
            thread::spawn(move || store.mark(42, ExplorationOutcome::Viewed))
        })
        .collect();
    for worker in threads {
        assert!(worker.join().is_ok_and(|result| result.is_ok()));
    }
    assert_eq!(store.count(), 1);
    drop(store);
    assert_eq!(ExplorationStore::new(&directory)?.count(), 1);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn repeated_views_of_the_same_id_never_move_the_independent_rejected_count() -> Result<(), AppError>
{
    // Regression: unavailable was once derived as explored - viewedTotal, wrong under revisits.
    let directory = test_directory("explored-repeat-views");
    let store = ExplorationStore::new(&directory)?;

    store.mark(7, ExplorationOutcome::Rejected)?;
    assert_eq!(store.unavailable_count(), 1);

    // Same id shown many times (e.g. adjacent-id jump): only the first mark is recorded.
    for _ in 0..25 {
        store.mark(1, ExplorationOutcome::Viewed)?;
    }

    assert_eq!(store.count(), 2);
    assert_eq!(store.viewable_count(), 1);
    assert_eq!(
        store.unavailable_count(),
        1,
        "rejected count must not decay from repeat views"
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn explored_unique_equals_viewable_plus_unavailable_once_fully_classified() -> Result<(), AppError>
{
    let directory = test_directory("explored-equation");
    let store = ExplorationStore::new(&directory)?;
    store.mark(1, ExplorationOutcome::Viewed)?;
    store.mark(2, ExplorationOutcome::Viewed)?;
    store.mark(3, ExplorationOutcome::Rejected)?;

    assert_eq!(
        store.count(),
        store.viewable_count() + store.unavailable_count()
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn a_second_mark_of_a_different_class_is_ignored_and_keeps_the_first_classification(
) -> Result<(), AppError> {
    let directory = test_directory("explored-reclassify");
    let store = ExplorationStore::new(&directory)?;
    assert!(store.mark(9, ExplorationOutcome::Viewed)?);
    assert!(!store.mark(9, ExplorationOutcome::Rejected)?);

    assert_eq!(store.viewable_count(), 1);
    assert_eq!(store.unavailable_count(), 0);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn legacy_plain_id_lines_are_counted_as_explored_but_not_classified() -> Result<(), AppError> {
    // Legacy ids (bare numbers, no comma) still count toward explored but never viewable/rejected.
    let directory = test_directory("explored-legacy");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    fs::write(directory.join("prntsc-explored.txt"), "10\n11\n").map_err(AppError::persistence)?;

    let store = ExplorationStore::new(&directory)?;
    assert_eq!(store.count(), 2);
    assert_eq!(store.viewable_count(), 0);
    assert_eq!(store.unavailable_count(), 0);
    assert_eq!(store.counts(), (2, 0, 0, 2));

    store.mark(12, ExplorationOutcome::Viewed)?;
    assert_eq!(store.count(), 3);
    assert_eq!(store.viewable_count(), 1);
    assert_eq!(store.counts(), (3, 1, 0, 2));
    assert_eq!(
        fs::read_to_string(directory.join("prntsc-explored.txt")).map_err(AppError::persistence)?,
        "10\n11\n"
    );
    assert_eq!(
        store.viewable_count() + store.unavailable_count(),
        1,
        "classified subset must stay smaller than the explored total while legacy ids remain"
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn classifications_are_first_write_wins_across_all_transitions_and_restart() -> Result<(), AppError>
{
    let directory = test_directory("explored-transitions");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    fs::write(directory.join("prntsc-explored.txt"), "1\n2\n").map_err(AppError::persistence)?;
    let store = ExplorationStore::new(&directory)?;
    for (id, outcome) in [
        (1, ExplorationOutcome::Viewed),
        (2, ExplorationOutcome::Rejected),
    ] {
        assert!(!store.mark(id, outcome)?);
    }
    assert!(store.mark(3, ExplorationOutcome::Viewed)?);
    assert!(store.mark(4, ExplorationOutcome::Rejected)?);
    assert!(!store.mark(3, ExplorationOutcome::Rejected)?);
    assert!(!store.mark(4, ExplorationOutcome::Viewed)?);
    assert_eq!(store.counts(), (4, 1, 1, 2));
    drop(store);
    assert_eq!(ExplorationStore::new(&directory)?.counts(), (4, 1, 1, 2));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn corrupt_rows_and_out_of_range_ids_fail_instead_of_inflating_progress() -> Result<(), AppError> {
    let directory = test_directory("explored-corrupt");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    let path = directory.join("prntsc-explored.txt");
    for contents in ["1,x\n", "4773622240,v\n"] {
        fs::write(&path, contents).map_err(AppError::persistence)?;
        assert!(ExplorationStore::new(&directory).is_err());
    }
    fs::write(&path, "1,v\n1,v\n").map_err(AppError::persistence)?;
    let store = ExplorationStore::new(&directory)?;
    assert_eq!(store.counts(), (1, 1, 0, 0));
    assert!(store
        .mark(4_773_622_240, ExplorationOutcome::Viewed)
        .is_err());
    assert_eq!(store.counts(), (1, 1, 0, 0));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn nearby_checks_and_acceptance_never_create_draws_or_implicit_seen() -> Result<(), AppError> {
    let directory = test_directory("nearby-checks");
    let data = PersistentState::new(&directory)?;
    for id in 1..=8 {
        let result = data.record_check(
            id,
            if id % 2 == 0 {
                ExplorationOutcome::Viewed
            } else {
                ExplorationOutcome::Rejected
            },
        )?;
        assert!(result.inserted && result.evidence_changed);
    }
    assert!(
        !data
            .record_check(2, ExplorationOutcome::Viewed)?
            .evidence_changed
    );
    assert!(
        data.record_check(1, ExplorationOutcome::Viewed)?
            .evidence_changed
    );
    assert_eq!(data.explored.evidence(1), Some(3));
    let state = data.snapshot()?.0;
    assert_eq!(state.exploration.len(), 8);
    assert!(state.seen.is_empty() && state.history.is_empty() && state.activity.is_empty());
    drop(data);
    let data = PersistentState::new(&directory)?;
    assert_eq!(data.snapshot()?.0.seen.len(), 0);
    // A concurrent Restore may remove the check before full-image acceptance.
    data.replace_synchronized(&snapshot::SyncSnapshot::default())?;
    data.accept_nearby(&HistoryItem {
        source: "prntsc".into(),
        id: "2".into(),
        source_page_url: "https://prnt.sc/2".into(),
        viewed_at: 1_800_000_000_000,
    })?;
    let state = data.snapshot()?.0;
    assert_eq!(state.history.len(), 1);
    assert_eq!(state.seen, vec![2]);
    assert_eq!(state.exploration[0].evidence, 1);
    assert_eq!(state.activity.len(), 0);
    assert!(data.activity.draw_frame_views().is_empty());
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn nearby_check_replays_journal_and_startup_receipt_is_mandatory() -> Result<(), AppError> {
    let directory = test_directory("nearby-replay");
    let data = PersistentState::new(&directory)?;
    fs::create_dir(directory.join("exploration-v2.json.tmp")).map_err(AppError::persistence)?;
    assert!(data.record_check(42, ExplorationOutcome::Viewed).is_err());
    fs::remove_dir(directory.join("exploration-v2.json.tmp")).map_err(AppError::persistence)?;
    drop(data);
    let data = PersistentState::new(&directory)?;
    assert_eq!(data.explored.evidence(42), Some(1));
    assert_eq!(data.snapshot()?.0.seen.len(), 0);
    assert_eq!(data.snapshot()?.0.activity.len(), 0);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn collections_consent_does_not_approve_nearby_sync_semantics() -> Result<(), AppError> {
    let directory = test_directory("nearby-consent");
    let data = PersistentState::new(&directory)?;
    super::super::io::save_json(
        &directory.join("sync-upgrades.json"),
        &BTreeMap::from([("group", 3)]),
    )?;
    assert!(!data.sync_upgrade_approved("group")?);
    data.approve_sync_upgrade("group")?;
    assert!(data.sync_upgrade_approved("group")?);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn nearby_startup_cannot_pass_a_failed_legacy_receipt() -> Result<(), AppError> {
    let directory = test_directory("nearby-startup-receipt");
    fs::create_dir_all(&directory).map_err(AppError::persistence)?;
    fs::write(directory.join("prntsc-explored.txt"), "42,v\n").map_err(AppError::persistence)?;
    fs::create_dir(directory.join("seen-reconciliation-v4.json.tmp"))
        .map_err(AppError::persistence)?;
    assert!(PersistentState::new(&directory).is_err());
    fs::remove_dir(directory.join("seen-reconciliation-v4.json.tmp"))
        .map_err(AppError::persistence)?;
    let data = PersistentState::new(&directory)?;
    assert!(data.seen.contains(42));
    data.record_check(43, ExplorationOutcome::Viewed)?;
    drop(data);
    assert!(!PersistentState::new(&directory)?.seen.contains(43));
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn nearby_enriches_legacy_evidence_and_draw_attribution_keeps_original_day() -> Result<(), AppError>
{
    let directory = test_directory("nearby-draw-attribution");
    let data = PersistentState::new(&directory)?;
    data.merge(&snapshot::SyncSnapshot {
        exploration: vec![snapshot::ExplorationRecord {
            source: "prntsc".into(),
            id: "1".into(),
            evidence: 0,
        }],
        ..snapshot::SyncSnapshot::default()
    })?;
    let commit = data.record_check(1, ExplorationOutcome::Viewed)?;
    assert!(!commit.inserted && commit.evidence_changed);
    assert_eq!(data.explored.count(), 1);
    let mut item = HistoryItem {
        source: "prntsc".into(),
        id: "2".into(),
        source_page_url: "https://prnt.sc/2".into(),
        viewed_at: 1_800_000_000_000,
    };
    data.accept(&item, false)?;
    let before = data.activity.draw_frame_views();
    assert_eq!(before.len(), 1);
    item.viewed_at += 86_400_000;
    data.accept_nearby(&item)?;
    let after = data.activity.draw_frame_views();
    assert_eq!(after[0].at_ms, before[0].at_ms);
    assert_eq!(after[0].day, before[0].day);
    data.record_check(3, ExplorationOutcome::Rejected)?;
    item.id = "3".into();
    item.source_page_url = "https://prnt.sc/3".into();
    data.accept(&item, false)?;
    assert_eq!(data.explored.evidence(3), Some(3));
    assert_eq!(data.activity.viewed_total(), 1);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}
