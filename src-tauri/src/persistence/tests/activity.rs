use super::*;

#[test]
fn activity_records_viewed_and_rejected_into_the_right_day_and_persists() -> Result<(), AppError> {
    let directory = test_directory("activity");
    let store = ActivityStore::new(&directory)?;
    store.record(ExplorationOutcome::Viewed, "2026-09-19")?;
    store.record(ExplorationOutcome::Rejected, "2026-09-19")?;
    store.record(ExplorationOutcome::Rejected, "2026-09-19")?;
    store.record(ExplorationOutcome::Viewed, "2026-09-20")?;

    assert_eq!(store.viewed_total(), 2);
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    let days = store.recent_days(today, 3);
    assert_eq!(
        days,
        vec![
            (
                "2026-09-19".to_owned(),
                DailyActivitySnapshot {
                    viewed: 1,
                    rejected: 2
                }
            ),
            (
                "2026-09-20".to_owned(),
                DailyActivitySnapshot {
                    viewed: 1,
                    rejected: 0
                }
            ),
        ],
        "2026-09-18 predates the first recorded activity and must not be zero-filled"
    );

    let reloaded = ActivityStore::new(&directory)?;
    assert_eq!(reloaded.viewed_total(), 2);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn activity_clear_resets_totals_and_days() -> Result<(), AppError> {
    let directory = test_directory("activity-clear");
    let store = ActivityStore::new(&directory)?;
    store.record(ExplorationOutcome::Viewed, "2026-09-20")?;
    store.clear()?;
    assert_eq!(store.viewed_total(), 0);
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    assert_eq!(
        store.recent_days(today, 1),
        vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())]
    );
    // A pending legacy browser key must not re-import pre-clear totals, even after restart.
    store.migrate("2026-09-20", 5, 42, "2026-09-20")?;
    assert_eq!(store.viewed_total(), 0);
    let reloaded = ActivityStore::new(&directory)?;
    reloaded.migrate("2026-09-20", 5, 42, "2026-09-20")?;
    assert_eq!(reloaded.viewed_total(), 0);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn activity_migration_runs_once_and_only_folds_today_when_the_legacy_day_matches(
) -> Result<(), AppError> {
    let directory = test_directory("activity-migrate");
    let store = ActivityStore::new(&directory)?;

    store.migrate("2026-09-19", 5, 101, "2026-09-20")?;
    assert_eq!(store.viewed_total(), 101);
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    assert_eq!(
        store.recent_days(today, 1),
        vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())],
        "legacy day differs from today, so today's bucket stays untouched"
    );

    // A second migration attempt must not double-count the lifetime total.
    store.migrate("2026-09-20", 3, 101, "2026-09-20")?;
    assert_eq!(store.viewed_total(), 101);
    assert_eq!(
        store.recent_days(today, 1),
        vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())]
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn activity_migration_folds_todays_partial_count_when_the_legacy_day_matches(
) -> Result<(), AppError> {
    let directory = test_directory("activity-migrate-today");
    let store = ActivityStore::new(&directory)?;

    store.migrate("2026-09-20", 7, 42, "2026-09-20")?;
    assert_eq!(store.viewed_total(), 42);
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    assert_eq!(
        store.recent_days(today, 1),
        vec![(
            "2026-09-20".to_owned(),
            DailyActivitySnapshot {
                viewed: 7,
                rejected: 0
            }
        )]
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn revisit_repair_only_lowers_overcounted_days_runs_once_and_persists() -> Result<(), AppError> {
    let directory = test_directory("activity-repair");
    let store = ActivityStore::new(&directory)?;
    // Migrated legacy views match history, so they survive.
    store.migrate("2026-09-21", 3, 100, "2026-09-21")?;
    // 2 revisits on top of 4 first views.
    for _ in 0..6 {
        store.record(ExplorationOutcome::Viewed, "2026-09-22")?;
    }
    store.record(ExplorationOutcome::Rejected, "2026-09-22")?;
    let first_views = BTreeMap::from([
        ("2026-09-20".to_owned(), 9),
        ("2026-09-21".to_owned(), 3),
        ("2026-09-22".to_owned(), 4),
    ]);

    store.repair_revisit_views(&first_views)?;
    store.repair_revisit_views(&BTreeMap::new())?;

    let expected = vec![
        (
            "2026-09-21".to_owned(),
            DailyActivitySnapshot {
                viewed: 3,
                rejected: 0,
            },
        ),
        (
            "2026-09-22".to_owned(),
            DailyActivitySnapshot {
                viewed: 4,
                rejected: 1,
            },
        ),
    ];
    let today = NaiveDate::from_ymd_opt(2026, 9, 22).unwrap_or_default();
    assert_eq!(
        store.recent_days(today, 183),
        expected,
        "days before tracking stay absent"
    );
    assert_eq!(
        store.viewed_total(),
        104,
        "legacy total survives the repair"
    );
    let reloaded = ActivityStore::new(&directory)?;
    assert_eq!(reloaded.recent_days(today, 183), expected);
    assert_eq!(reloaded.viewed_total(), 104);
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn recent_days_with_no_recorded_activity_returns_only_today() -> Result<(), AppError> {
    let directory = test_directory("activity-window-empty");
    let store = ActivityStore::new(&directory)?;
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    assert_eq!(
        store.recent_days(today, 183),
        vec![("2026-09-20".to_owned(), DailyActivitySnapshot::default())]
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn recent_days_stops_at_the_first_recorded_day_short_of_the_window_cap() -> Result<(), AppError> {
    let directory = test_directory("activity-window-partial");
    let store = ActivityStore::new(&directory)?;
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    // Tracking started 7 days ago: exactly 8 days (2026-09-13 .. 2026-09-20) should render.
    store.record(ExplorationOutcome::Viewed, "2026-09-13")?;

    let days = store.recent_days(today, 183);
    assert_eq!(days.len(), 8);
    assert_eq!(
        days.first().map(|(date, _)| date.as_str()),
        Some("2026-09-13")
    );
    assert_eq!(
        days.last().map(|(date, _)| date.as_str()),
        Some("2026-09-20")
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn recent_days_caps_long_running_history_to_a_rolling_window() -> Result<(), AppError> {
    let directory = test_directory("activity-window-rolling");
    let store = ActivityStore::new(&directory)?;
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    // Tracking started a year ago, far past the 183-day cap.
    store.record(ExplorationOutcome::Viewed, "2025-09-20")?;

    let days = store.recent_days(today, 183);
    assert_eq!(days.len(), 183);
    assert_eq!(
        days.first().map(|(date, _)| date.as_str()),
        Some("2026-03-22"),
        "window must start exactly 182 days before today, not at the true tracking start"
    );
    assert_eq!(
        days.last().map(|(date, _)| date.as_str()),
        Some("2026-09-20")
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn recent_days_with_zero_max_days_returns_empty() -> Result<(), AppError> {
    let directory = test_directory("activity-window-zero");
    let store = ActivityStore::new(&directory)?;
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    store.record(ExplorationOutcome::Viewed, "2026-09-20")?;
    assert!(store.recent_days(today, 0).is_empty());
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn recent_days_with_future_tracking_start_clamps_to_today() -> Result<(), AppError> {
    let directory = test_directory("activity-window-future");
    let store = ActivityStore::new(&directory)?;
    let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap_or_default();
    store.record(ExplorationOutcome::Viewed, "2026-09-25")?;
    let days = store.recent_days(today, 183);
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].0, "2026-09-20");
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn activity_day_is_the_local_calendar_day_not_the_utc_day() -> Result<(), AppError> {
    // UTC+2: just after local midnight the UTC date is still the previous day.
    assert_eq!(day_key(day_at("2026-09-22T00:30:00+02:00")?), "2026-09-22");
    assert_eq!(day_key(day_at("2026-09-22T23:59:59+02:00")?), "2026-09-22");
    // UTC-5: late in the local evening the UTC date is already the next day.
    assert_eq!(day_key(day_at("2026-09-22T00:00:00-05:00")?), "2026-09-22");
    assert_eq!(day_key(day_at("2026-09-22T22:30:00-05:00")?), "2026-09-22");
    Ok(())
}

#[test]
fn activity_days_follow_the_local_offset_across_dst_changes() -> Result<(), AppError> {
    // Europe/Warsaw enters DST on 2026-03-29 (+01:00 -> +02:00) and leaves it on 2026-10-25.
    assert_eq!(day_key(day_at("2026-03-29T00:30:00+01:00")?), "2026-03-29");
    assert_eq!(day_key(day_at("2026-03-29T23:30:00+02:00")?), "2026-03-29");
    assert_eq!(day_key(day_at("2026-10-25T00:30:00+02:00")?), "2026-10-25");
    assert_eq!(day_key(day_at("2026-10-25T23:30:00+01:00")?), "2026-10-25");

    let directory = test_directory("activity-window-dst");
    let store = ActivityStore::new(&directory)?;
    store.record(
        ExplorationOutcome::Viewed,
        &day_key(day_at("2026-10-24T12:00:00+02:00")?),
    )?;
    let dates: Vec<String> = store
        .recent_days(day_at("2026-10-26T00:30:00+01:00")?, 183)
        .into_iter()
        .map(|(date, _)| date)
        .collect();
    assert_eq!(
        dates,
        ["2026-10-24", "2026-10-25", "2026-10-26"],
        "the 25-hour DST day appears exactly once, with no skipped or duplicated day"
    );
    fs::remove_dir_all(directory).map_err(AppError::persistence)
}

#[test]
fn first_local_day_of_use_starts_the_window_and_local_today_ends_it() -> Result<(), AppError> {
    // First use whose UTC date differs from the local date, on both sides of UTC.
    for (zone, first_use, later) in [
        (
            "utc-plus-2",
            "2026-09-22T00:30:00+02:00",
            "2026-09-24T01:00:00+02:00",
        ),
        (
            "utc-minus-5",
            "2026-09-22T22:30:00-05:00",
            "2026-09-24T21:00:00-05:00",
        ),
    ] {
        let directory = test_directory(&format!("activity-first-day-{zone}"));
        let store = ActivityStore::new(&directory)?;
        let first_day = day_at(first_use)?;
        store.record(ExplorationOutcome::Viewed, &day_key(first_day))?;

        assert_eq!(
            store.recent_days(first_day, 183),
            vec![(
                "2026-09-22".to_owned(),
                DailyActivitySnapshot {
                    viewed: 1,
                    rejected: 0,
                },
            )],
            "{zone}: the first local day is today and nothing before it is rendered"
        );

        let days = store.recent_days(day_at(later)?, 183);
        let dates: Vec<&str> = days.iter().map(|(date, _)| date.as_str()).collect();
        assert_eq!(
            dates,
            ["2026-09-22", "2026-09-23", "2026-09-24"],
            "{zone}: window runs from the first local day through local today"
        );
        assert_eq!(days[2].1, DailyActivitySnapshot::default());
        fs::remove_dir_all(directory).map_err(AppError::persistence)?;
    }
    Ok(())
}
