use super::*;

#[test]
fn roundtrip_is_canonical_and_rejected_headers_distinguish_version_from_magic(
) -> Result<(), SnapshotError> {
    let value = SyncSnapshot::default();
    let bytes = serialize_snapshot(&value)?;
    assert_eq!(parse_snapshot(&bytes)?, value);
    // Version byte below the supported one is a different format, not a newer one.
    let mut rejected = b"RFSNAP\0\0".to_vec();
    rejected.extend_from_slice(&4u32.to_le_bytes());
    rejected.extend_from_slice(&bytes[MAGIC.len()..]);
    assert_eq!(parse_snapshot(&rejected), Err(SnapshotError::InvalidMagic));
    // Version byte above the supported one names a newer format.
    let mut future = bytes.clone();
    future[6] = MAGIC[6] + 1;
    assert_eq!(
        parse_snapshot(&future),
        Err(SnapshotError::UnsupportedVersion)
    );
    // Any other prefix is not this format at all.
    let mut unknown = bytes.clone();
    unknown[..6].copy_from_slice(b"RFSGAP");
    assert_eq!(parse_snapshot(&unknown), Err(SnapshotError::InvalidMagic));
    // The whole header must be present before any byte of it is read.
    assert_eq!(
        parse_snapshot(&bytes[..MAGIC.len() - 1]),
        Err(SnapshotError::TruncatedHeader)
    );
    Ok(())
}

#[test]
fn golden_fixture_decodes_to_the_frozen_format() -> Result<(), SnapshotError> {
    let golden: &[u8] = include_bytes!("fixtures/golden.bin");
    let state = SyncSnapshot {
        seen: vec![42],
        history: vec![SyncRecord {
            operation_id: [1; 16],
            order_at: 1,
            last_view: ViewStamp {
                at_ms: 1_000,
                day: "2026-01-02".into(),
                day_inferred: false,
            },
            source: "prntsc".into(),
            id: "abc123".into(),
            source_page_url: "https://prnt.sc/abc123".into(),
        }],
        exploration: vec![ExplorationRecord {
            source: "prntsc".into(),
            id: "abc123".into(),
            evidence: 1,
        }],
        activity: vec![ActivityOperation::Discovery {
            operation_id: [2; 16],
            source: "prntsc".into(),
            id: "abc123".into(),
            outcome: Outcome::Viewed,
            occurred_at_ms: 1_000,
            day: "2026-01-02".into(),
        }],
        ..SyncSnapshot::default()
    };
    // A field-order or layout change in the format cannot break Sync silently:
    // this pinned byte-for-byte comparison fails first.
    assert_eq!(serialize_snapshot(&state)?, golden);
    assert_eq!(parse_snapshot(golden)?, state);
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
fn retains_device_records_without_local_identity() -> Result<(), SnapshotError> {
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
        preferences: Preferences {
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
        preferences: Preferences {
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
    bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(parse_snapshot(&bytes).is_err());
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
        preferences: Preferences {
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
    let overlap = SyncSnapshot {
        activity: vec![discovery(1, "1", "2026-10-02")],
        activity_removed: vec![[1; 16]],
        ..SyncSnapshot::default()
    };
    assert_eq!(
        serialize_snapshot(&overlap),
        Err(SnapshotError::InvalidValue)
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

#[test]
fn meaningful_state_covers_every_domain_and_excludes_only_self_roster() {
    let self_id = [1; 16];
    let default = SyncSnapshot::default();
    assert!(!default.has_meaningful_synchronized_state(self_id));
    assert!(!SyncSnapshot {
        devices: vec![device(1, 1)],
        ..default.clone()
    }
    .has_meaningful_synchronized_state(self_id));
    let history = SyncRecord {
        operation_id: [1; 16],
        order_at: 1,
        last_view: ViewStamp::inferred(1),
        source: "prntsc".into(),
        id: "0".into(),
        source_page_url: "https://prnt.sc/0".into(),
    };
    for state in [
        SyncSnapshot {
            seen: vec![1],
            ..default.clone()
        },
        SyncSnapshot {
            history: vec![history],
            ..default.clone()
        },
        SyncSnapshot {
            history_removed: vec![[1; 16]],
            ..default.clone()
        },
        SyncSnapshot {
            favorites: vec![FavoriteRecord {
                operation_id: [1; 16],
                added_at: 1,
                source: "prntsc".into(),
                id: "0".into(),
                source_page_url: "https://prnt.sc/0".into(),
            }],
            ..default.clone()
        },
        SyncSnapshot {
            favorites_removed: vec![[1; 16]],
            ..default.clone()
        },
        SyncSnapshot {
            exploration: vec![ExplorationRecord {
                source: "prntsc".into(),
                id: "0".into(),
                evidence: 0,
            }],
            ..default.clone()
        },
        SyncSnapshot {
            activity: vec![discovery(1, "0", "2026-10-02")],
            ..default.clone()
        },
        SyncSnapshot {
            activity_removed: vec![[1; 16]],
            ..default.clone()
        },
        SyncSnapshot {
            preferences: Preferences {
                theme: Some(Register {
                    clock: 1,
                    operation_id: [1; 16],
                    value: "system".into(),
                }),
                history_page_size: None,
            },
            ..default.clone()
        },
        SyncSnapshot {
            preferences: Preferences {
                theme: None,
                history_page_size: Some(Register {
                    clock: 1,
                    operation_id: [1; 16],
                    value: 10,
                }),
            },
            ..default.clone()
        },
        SyncSnapshot {
            devices: vec![device(2, 1)],
            ..default
        },
    ] {
        assert!(state.has_meaningful_synchronized_state(self_id));
    }
}

#[test]
fn roster_merge_keeps_earliest_nonzero_join_time() -> Result<(), SnapshotError> {
    for (a, b, expected) in [(200, 100, 100), (0, 100, 100), (100, 0, 100), (0, 0, 0)] {
        let left = SyncSnapshot {
            devices: vec![DeviceRecord {
                joined_at_ms: a,
                ..device(1, 1)
            }],
            ..SyncSnapshot::default()
        };
        let right = SyncSnapshot {
            devices: vec![DeviceRecord {
                joined_at_ms: b,
                ..device(1, 1)
            }],
            ..SyncSnapshot::default()
        };
        assert_eq!(
            merge_snapshots(&left, &right)?.devices[0].joined_at_ms,
            expected
        );
    }
    Ok(())
}

#[test]
fn zero_and_absent_device_dates_roundtrip() -> Result<(), SnapshotError> {
    let record = DeviceRecord {
        joined_at_ms: 0,
        last_sync: None,
        ..device(1, 1)
    };
    let state = SyncSnapshot {
        devices: vec![record],
        ..Default::default()
    };
    assert_eq!(parse_snapshot(&serialize_snapshot(&state)?)?, state);
    Ok(())
}

#[test]
fn collection_sections_are_validated_and_canonical() -> Result<(), SnapshotError> {
    let state = SyncSnapshot {
        favorites: vec![FavoriteRecord {
            operation_id: [3; 16],
            added_at: 42,
            source: "prntsc".into(),
            id: "abc123".into(),
            source_page_url: "https://prnt.sc/abc123".into(),
        }],
        favorites_removed: vec![[4; 16]],
        collections: vec![CollectionRecord {
            collection_id: [5; 16],
            name: Register {
                clock: 1,
                operation_id: [6; 16],
                value: "Favourite".into(),
            },
        }],
        memberships: vec![MembershipRecord {
            operation_id: [7; 16],
            collection_id: [5; 16],
            favorite_operation_id: [3; 16],
        }],
        ..SyncSnapshot::default()
    };
    assert_eq!(state.collections[0].name.value, "Favourite");
    assert_eq!(state.memberships[0].favorite_operation_id, [3; 16]);
    assert_eq!(parse_snapshot(&serialize_snapshot(&state)?)?, state);
    let mut corrupt = state.clone();
    corrupt.collections[0].name.value = "bad\nname".into();
    assert_eq!(
        serialize_snapshot(&corrupt).err(),
        Some(SnapshotError::InvalidValue)
    );
    corrupt = state.clone();
    corrupt.memberships.push(corrupt.memberships[0].clone());
    assert_eq!(
        serialize_snapshot(&corrupt).err(),
        Some(SnapshotError::UnsortedOrDuplicate)
    );
    let mut forged = serialize_snapshot(&state)?;
    forged.truncate(forged.len() - 4);
    assert!(parse_snapshot(&forged).is_err());
    Ok(())
}

#[test]
fn availability_evidence_does_not_imply_seen() -> Result<(), SnapshotError> {
    let state = SyncSnapshot {
        exploration: vec![ExplorationRecord {
            source: "prntsc".into(),
            id: "abc123".into(),
            evidence: 1,
        }],
        ..SyncSnapshot::default()
    };
    let decoded = parse_snapshot(&serialize_snapshot(&state)?)?;
    assert_eq!(decoded, state);
    Ok(())
}
