//! Frozen v3 wire codec; deliberately rejects v4.
#![allow(
    clippy::too_many_lines,
    reason = "Frozen explicit wire sections mirror the deployed v3 codec"
)]
use super::{
    migrate_legacy_collections, normalize_seeded_collection_name, v2, validate_snapshot,
    ActivityOperation, BTreeMap, CollectionRecord, DailyCounts, DecodedSnapshot, DeviceMetadata,
    DeviceRecord, ExplorationRecord, FavoriteRecord, MembershipRecord, Outcome, Reader, Register,
    SnapshotError, SyncRecord, SyncSnapshot, ViewStamp, Writer, MAGIC, MAX_PLAINTEXT,
};
pub fn serialize_snapshot(s: &SyncSnapshot) -> Result<Vec<u8>, SnapshotError> {
    validate_snapshot(s)?;
    let mut w = Writer(Vec::new());
    w.bytes(MAGIC)?;
    w.u32(3)?;
    w.count(s.seen.len())?;
    for x in &s.seen {
        w.u64(*x)?;
    }
    w.count(s.history.len())?;
    for x in &s.history {
        w.bytes(&x.operation_id)?;
        w.u64(x.order_at)?;
        w.u64(x.last_view.at_ms)?;
        w.text(&x.last_view.day)?;
        w.u8(u8::from(x.last_view.day_inferred))?;
        w.text(&x.source)?;
        w.text(&x.id)?;
        w.text(&x.source_page_url)?;
    }
    w.count(s.history_removed.len())?;
    for x in &s.history_removed {
        w.bytes(x)?;
    }
    w.count(s.favorites.len())?;
    for x in &s.favorites {
        w.bytes(&x.operation_id)?;
        w.u64(x.added_at)?;
        w.text(&x.source)?;
        w.text(&x.id)?;
        w.text(&x.source_page_url)?;
    }
    w.count(s.favorites_removed.len())?;
    for x in &s.favorites_removed {
        w.bytes(x)?;
    }
    w.count(s.exploration.len())?;
    for x in &s.exploration {
        w.text(&x.source)?;
        w.text(&x.id)?;
        w.u8(x.evidence)?;
    }
    w.count(s.activity.len())?;
    for x in &s.activity {
        w.bytes(&x.operation_id())?;
        match x {
            ActivityOperation::Discovery {
                source,
                id,
                outcome,
                occurred_at_ms,
                day,
                ..
            } => {
                w.u8(0)?;
                w.text(source)?;
                w.text(id)?;
                w.u8(match outcome {
                    Outcome::Viewed => 1,
                    Outcome::Rejected => 2,
                })?;
                w.u64(*occurred_at_ms)?;
                w.text(day)?;
            }
            ActivityOperation::LegacyImport {
                viewed_total, days, ..
            } => {
                w.u8(1)?;
                w.u64(*viewed_total)?;
                w.count(days.len())?;
                for (day, counts) in days {
                    w.text(day)?;
                    w.u64(counts.viewed)?;
                    w.u64(counts.rejected)?;
                }
            }
        }
    }
    w.count(s.activity_removed.len())?;
    for x in &s.activity_removed {
        w.bytes(x)?;
    }
    w.optional(s.preferences.theme.as_ref(), |w, v| w.text(v))?;
    w.optional(s.preferences.history_page_size.as_ref(), |w, v| w.u16(*v))?;
    w.count(s.devices.len())?;
    for x in &s.devices {
        w.bytes(&x.device_id)?;
        w.stamp(&x.metadata)?;
        w.text(&x.metadata.value.display_name)?;
        w.text(&x.metadata.value.platform)?;
        w.u64(x.joined_at_ms)?;
        w.optional(x.last_sync.as_ref(), |w, v| w.u64(*v))?;
    }
    w.count(s.collections.len())?;
    for c in &s.collections {
        w.bytes(&c.collection_id)?;
        w.stamp(&c.name)?;
        w.text(&c.name.value)?;
    }
    w.count(s.collections_removed.len())?;
    for id in &s.collections_removed {
        w.bytes(id)?;
    }
    w.count(s.memberships.len())?;
    for m in &s.memberships {
        w.bytes(&m.operation_id)?;
        w.bytes(&m.collection_id)?;
        w.bytes(&m.favorite_operation_id)?;
    }
    w.count(s.memberships_removed.len())?;
    for id in &s.memberships_removed {
        w.bytes(id)?;
    }
    Ok(w.0)
}
pub fn decode_snapshot(bytes: &[u8]) -> Result<DecodedSnapshot, SnapshotError> {
    if bytes.len() > MAX_PLAINTEXT {
        return Err(SnapshotError::PayloadTooLarge);
    }
    if bytes.len() < 12 {
        return Err(SnapshotError::TruncatedHeader);
    }
    let mut r = Reader { bytes, pos: 0 };
    if r.bytes(8)? != MAGIC {
        return Err(SnapshotError::InvalidMagic);
    }
    let version = r.u32()?;
    if version == 1 {
        return super::decode_v1(bytes);
    }
    if version == 2 {
        let mut decoded = v2::decode_snapshot(bytes)?;
        migrate_legacy_collections(&mut decoded.data);
        decoded.needs_upgrade = true;
        return Ok(decoded);
    }
    if version != 3 {
        return Err(SnapshotError::UnsupportedVersion(version));
    }
    let mut s = SyncSnapshot::default();
    for _ in 0..r.count(8)? {
        s.seen.push(r.u64()?);
    }
    for _ in 0..r.count(51)? {
        s.history.push(SyncRecord {
            operation_id: r.id()?,
            order_at: r.u64()?,
            last_view: ViewStamp {
                at_ms: r.u64()?,
                day: r.text()?,
                day_inferred: r.bool()?,
            },
            source: r.text()?,
            id: r.text()?,
            source_page_url: r.text()?,
        });
    }
    for _ in 0..r.count(16)? {
        s.history_removed.push(r.id()?);
    }
    for _ in 0..r.count(32)? {
        s.favorites.push(FavoriteRecord {
            operation_id: r.id()?,
            added_at: r.u64()?,
            source: r.text()?,
            id: r.text()?,
            source_page_url: r.text()?,
        });
    }
    for _ in 0..r.count(16)? {
        s.favorites_removed.push(r.id()?);
    }
    for _ in 0..r.count(7)? {
        s.exploration.push(ExplorationRecord {
            source: r.text()?,
            id: r.text()?,
            evidence: r.u8()?,
        });
    }
    for _ in 0..r.count(29)? {
        let operation_id = r.id()?;
        s.activity.push(match r.u8()? {
            0 => ActivityOperation::Discovery {
                operation_id,
                source: r.text()?,
                id: r.text()?,
                outcome: match r.u8()? {
                    1 => Outcome::Viewed,
                    2 => Outcome::Rejected,
                    _ => return Err(SnapshotError::InvalidValue),
                },
                occurred_at_ms: r.u64()?,
                day: r.text()?,
            },
            1 => {
                let viewed_total = r.u64()?;
                let mut days = BTreeMap::new();
                let mut previous = None;
                for _ in 0..r.count(28)? {
                    let day = r.text()?;
                    if previous.as_ref().is_some_and(|p| p >= &day) {
                        return Err(SnapshotError::UnsortedOrDuplicate);
                    }
                    previous = Some(day.clone());
                    days.insert(
                        day,
                        DailyCounts {
                            viewed: r.u64()?,
                            rejected: r.u64()?,
                        },
                    );
                }
                ActivityOperation::LegacyImport {
                    operation_id,
                    viewed_total,
                    days,
                }
            }
            _ => return Err(SnapshotError::InvalidValue),
        });
    }
    for _ in 0..r.count(16)? {
        s.activity_removed.push(r.id()?);
    }
    s.preferences.theme = r.optional(Reader::text)?;
    s.preferences.history_page_size = r.optional(Reader::u16)?;
    for _ in 0..r.count(55)? {
        s.devices.push(DeviceRecord {
            device_id: r.id()?,
            metadata: Register {
                clock: r.u64()?,
                operation_id: r.id()?,
                value: DeviceMetadata {
                    display_name: r.text()?,
                    platform: r.text()?,
                },
            },
            joined_at_ms: r.u64()?,
            last_sync: r.optional(Reader::u64)?,
        });
    }
    for _ in 0..r.count(43)? {
        s.collections.push(CollectionRecord {
            collection_id: r.id()?,
            name: Register {
                clock: r.u64()?,
                operation_id: r.id()?,
                value: r.text()?,
            },
        });
    }
    for _ in 0..r.count(16)? {
        s.collections_removed.push(r.id()?);
    }
    for _ in 0..r.count(48)? {
        s.memberships.push(MembershipRecord {
            operation_id: r.id()?,
            collection_id: r.id()?,
            favorite_operation_id: r.id()?,
        });
    }
    for _ in 0..r.count(16)? {
        s.memberships_removed.push(r.id()?);
    }
    if r.pos != bytes.len() {
        return Err(SnapshotError::InvalidLength);
    }
    validate_snapshot(&s)?;
    normalize_seeded_collection_name(&mut s);
    Ok(DecodedSnapshot {
        original_schema_version: 3,
        data: s,
        needs_upgrade: false,
    })
}
