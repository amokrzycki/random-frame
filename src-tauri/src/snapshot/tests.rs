use super::*;

#[test]
fn v1_snapshot_preserves_operations_and_tombstones() -> Result<(), SnapshotError> {
    let decoded = decode_snapshot(include_bytes!(
        "../persistence/tests/fixtures/snapshot-v1.bin"
    ))?;
    assert_eq!(decoded.original_schema_version, 1);
    assert!(decoded.needs_upgrade);
    assert_eq!(decoded.data.history[0].operation_id, [1; 16]);
    assert_eq!(decoded.data.history_removed, vec![[2; 16]]);
    assert_eq!(decoded.data.favorites[0].operation_id, [3; 16]);
    assert_eq!(decoded.data.favorites_removed, vec![[4; 16]]);
    assert_eq!(decoded.data.activity, vec![]);
    assert!(decoded.data.history[0].last_view.day_inferred);
    Ok(())
}

#[test]
fn v2_roundtrip_is_canonical_and_old_decoder_rejects_it() -> Result<(), SnapshotError> {
    let value = SyncSnapshot::default();
    let bytes = serialize_snapshot(&value)?;
    assert_eq!(decode_snapshot(&bytes)?.original_schema_version, 2);
    assert_eq!(parse_snapshot(&bytes)?, value);
    assert!(matches!(
        v1::parse_snapshot(&bytes),
        Err(v1::SnapshotError::UnsupportedVersion(2))
    ));
    Ok(())
}

fn discovery(id: u8, frame: &str, day: &str) -> ActivityOperation {
    ActivityOperation::Discovery {
        operation_id: [id; 16],
        source: "prntsc".into(),
        id: frame.into(),
        outcome: Outcome::Viewed,
        occurred_at_ms: 1,
        day: day.into(),
    }
}
fn device(id: u8, clock: u8) -> DeviceRecord {
    DeviceRecord {
        device_id: [id; 16],
        metadata: Register {
            clock: u64::from(clock),
            operation_id: {
                let mut op = [id + 10; 16];
                op[0] = clock;
                op
            },
            value: DeviceMetadata {
                display_name: "My device".into(),
                platform: "linux".into(),
            },
        },
        joined_at_ms: 100,
        last_sync: Some(Register {
            clock: u64::from(clock),
            operation_id: {
                let mut op = [id + 20; 16];
                op[0] = clock;
                op
            },
            value: 200,
        }),
    }
}
#[test]
fn v2_retains_device_records_without_local_identity() -> Result<(), SnapshotError> {
    let a = SyncSnapshot {
        devices: vec![device(1, 1)],
        ..SyncSnapshot::default()
    };
    let bytes = serialize_snapshot(&a)?;
    assert_eq!(parse_snapshot(&bytes)?, a);
    let b = SyncSnapshot {
        devices: vec![device(1, 2), device(2, 1)],
        ..SyncSnapshot::default()
    };
    let merged = merge_snapshots(&a, &b)?;
    assert_eq!(merged.devices.len(), 2);
    assert_eq!(merged.devices[0].metadata.clock, 2);
    assert_eq!(merge_snapshots(&b, &a)?, merged);
    Ok(())
}
#[test]
fn merge_is_associative_commutative_and_idempotent() -> Result<(), SnapshotError> {
    let a = SyncSnapshot {
        activity: vec![discovery(1, "1", "2026-10-02")],
        exploration: vec![ExplorationRecord {
            source: "prntsc".into(),
            id: "1".into(),
            evidence: 1,
        }],
        devices: vec![device(1, 1)],
        ..SyncSnapshot::default()
    };
    let b = SyncSnapshot {
        activity: vec![discovery(2, "1", "2026-10-02")],
        exploration: vec![ExplorationRecord {
            source: "prntsc".into(),
            id: "1".into(),
            evidence: 2,
        }],
        ..SyncSnapshot::default()
    };
    let c = SyncSnapshot {
        activity_removed: vec![[1; 16]],
        ..SyncSnapshot::default()
    };
    assert_eq!(merge_snapshots(&a, &a)?, a);
    let ab = merge_snapshots(&a, &b)?;
    assert_eq!(ab, merge_snapshots(&b, &a)?);
    assert_eq!(ab, merge_snapshots(&ab, &ab)?);
    assert_eq!(
        merge_snapshots(&ab, &c)?,
        merge_snapshots(&a, &merge_snapshots(&b, &c)?)?
    );
    assert_eq!(ab.exploration[0].evidence, 3);
    assert_eq!(activity_projection(&ab.activity)?.0, 2);
    Ok(())
}
#[test]
fn preferences_merge_independent_fields_and_resolve_same_field() -> Result<(), SnapshotError> {
    let a = SyncSnapshot {
        preferences: PreferencesV2 {
            theme: Some(Register {
                clock: 2,
                operation_id: [1; 16],
                value: "dark".into(),
            }),
            history_page_size: None,
        },
        ..SyncSnapshot::default()
    };
    let b = SyncSnapshot {
        preferences: PreferencesV2 {
            theme: Some(Register {
                clock: 2,
                operation_id: [2; 16],
                value: "light".into(),
            }),
            history_page_size: Some(Register {
                clock: 1,
                operation_id: [3; 16],
                value: 50,
            }),
        },
        ..SyncSnapshot::default()
    };
    let ab = merge_snapshots(&a, &b)?;
    assert_eq!(
        ab.preferences
            .theme
            .ok_or(SnapshotError::InvalidValue)?
            .value,
        "light"
    );
    assert_eq!(
        ab.preferences
            .history_page_size
            .ok_or(SnapshotError::InvalidValue)?
            .value,
        50
    );
    assert_eq!(merge_snapshots(&a, &b)?, merge_snapshots(&b, &a)?);
    Ok(())
}
#[test]
fn malformed_counts_ids_dates_preferences_and_overflow_are_rejected() -> Result<(), SnapshotError> {
    let mut bytes = serialize_snapshot(&SyncSnapshot::default())?;
    bytes[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode_snapshot(&bytes).is_err());
    bytes = serialize_snapshot(&SyncSnapshot::default())?;
    bytes[8..12].copy_from_slice(&99u32.to_le_bytes());
    assert!(matches!(
        decode_snapshot(&bytes),
        Err(SnapshotError::UnsupportedVersion(99))
    ));
    let bad = SyncSnapshot {
        activity: vec![discovery(1, "1", "2026-02-30")],
        ..SyncSnapshot::default()
    };
    assert!(serialize_snapshot(&bad).is_err());
    let bad = SyncSnapshot {
        activity: vec![
            discovery(1, "1", "2026-10-02"),
            discovery(1, "2", "2026-10-02"),
        ],
        ..SyncSnapshot::default()
    };
    assert!(serialize_snapshot(&bad).is_err());
    let bad = SyncSnapshot {
        preferences: PreferencesV2 {
            theme: None,
            history_page_size: Some(Register {
                clock: 1,
                operation_id: [1; 16],
                value: 99,
            }),
        },
        ..SyncSnapshot::default()
    };
    assert!(serialize_snapshot(&bad).is_err());
    let overflow = SyncSnapshot {
        activity: vec![
            ActivityOperation::LegacyImport {
                operation_id: [1; 16],
                viewed_total: u64::MAX,
                days: BTreeMap::new(),
            },
            discovery(2, "1", "2026-10-02"),
        ],
        ..SyncSnapshot::default()
    };
    assert_eq!(
        serialize_snapshot(&overflow),
        Err(SnapshotError::CounterOverflow)
    );
    Ok(())
}
#[test]
fn plaintext_budget_has_exact_boundary_without_trimming() -> Result<(), SnapshotError> {
    let mut writer = Writer(Vec::new());
    writer.bytes(&vec![0; MAX_PLAINTEXT])?;
    assert_eq!(writer.u8(0), Err(SnapshotError::PayloadTooLarge));
    let state = SyncSnapshot {
        seen: (0..MAX_ENTRIES as u64).collect(),
        ..SyncSnapshot::default()
    };
    assert_eq!(
        serialize_snapshot(&state),
        Err(SnapshotError::PayloadTooLarge)
    );
    assert_eq!(state.seen.len(), MAX_ENTRIES);
    Ok(())
}
