//! Canonical, device-independent plaintext. The crypto envelope and credentials remain v1.
#[cfg(any(test, debug_assertions))]
mod diagnostics;
mod merge;
#[cfg(test)]
pub use diagnostics::diagnostics;
#[cfg(any(test, debug_assertions))]
pub(crate) use diagnostics::{diagnostics_enabled, report_diagnostics, report_upload};
#[allow(
    dead_code,
    reason = "frozen v1 codec is retained for compatibility and mixed-version tests"
)]
pub(crate) mod v1;
use crate::sources::prntsc::LEGACY_MAX_VALUE;
use chrono::{NaiveDate, TimeZone, Utc};
pub use merge::merge_snapshots;
pub(crate) use merge::reconcile_seen;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

pub const MAX_PLAINTEXT: usize = 67_108_864 - crate::sync_crypto::ENVELOPE_OVERHEAD;
#[cfg(test)]
pub const MAX_ENTRIES: usize = (MAX_PLAINTEXT - 32) / 8;
// Only the frozen v1 decoder has a per-section cap. V2 is bounded by bytes, never trimmed.
#[cfg(test)]
pub const MAX_SECTION: usize = 100_000;
pub type OperationId = [u8; 16];

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct ViewStamp {
    pub at_ms: u64,
    pub day: String,
    pub day_inferred: bool,
}
impl ViewStamp {
    pub fn inferred(at_ms: u64) -> Self {
        let day = i64::try_from(at_ms)
            .ok()
            .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
            .map_or_else(
                || "1970-01-01".into(),
                |time| time.format("%Y-%m-%d").to_string(),
            );
        Self {
            at_ms,
            day,
            day_inferred: true,
        }
    }
    pub(crate) fn key(&self) -> (u64, bool, &str) {
        (self.at_ms, !self.day_inferred, &self.day)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct SyncRecord {
    pub operation_id: OperationId,
    pub order_at: u64,
    pub last_view: ViewStamp,
    pub source: String,
    pub id: String,
    pub source_page_url: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct FavoriteRecord {
    pub operation_id: OperationId,
    pub added_at: u64,
    pub source: String,
    pub id: String,
    pub source_page_url: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct ExplorationRecord {
    pub source: String,
    pub id: String,
    pub evidence: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum Outcome {
    Viewed,
    Rejected,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct DailyCounts {
    pub viewed: u64,
    pub rejected: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum ActivityOperation {
    Discovery {
        operation_id: OperationId,
        source: String,
        id: String,
        outcome: Outcome,
        occurred_at_ms: u64,
        day: String,
    },
    LegacyImport {
        operation_id: OperationId,
        viewed_total: u64,
        days: BTreeMap<String, DailyCounts>,
    },
}
impl ActivityOperation {
    pub fn operation_id(&self) -> OperationId {
        match self {
            Self::Discovery { operation_id, .. } | Self::LegacyImport { operation_id, .. } => {
                *operation_id
            }
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Register<T> {
    pub clock: u64,
    pub operation_id: OperationId,
    pub value: T,
}
impl<T> Register<T> {
    pub fn stamp(&self) -> (u64, OperationId) {
        (self.clock, self.operation_id)
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct PreferencesV2 {
    pub theme: Option<Register<String>>,
    pub history_page_size: Option<Register<u16>>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct DeviceMetadata {
    pub display_name: String,
    pub platform: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct DeviceRecord {
    pub device_id: OperationId,
    pub metadata: Register<DeviceMetadata>,
    pub joined_at_ms: u64,
    pub last_sync: Option<Register<u64>>,
}
/// Zero means unknown, not an earlier historical join.
pub(crate) fn earliest_joined_at(a: u64, b: u64) -> u64 {
    match (a, b) {
        (0, known) | (known, 0) => known,
        _ => a.min(b),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub struct SyncSnapshot {
    pub seen: Vec<u64>,
    pub history: Vec<SyncRecord>,
    pub history_removed: Vec<OperationId>,
    pub favorites: Vec<FavoriteRecord>,
    pub favorites_removed: Vec<OperationId>,
    pub exploration: Vec<ExplorationRecord>,
    pub activity: Vec<ActivityOperation>,
    pub activity_removed: Vec<OperationId>,
    pub preferences: PreferencesV2,
    pub devices: Vec<DeviceRecord>,
}
impl SyncSnapshot {
    /// Any content, deletion or explicit preference Merge can contribute. The automatic
    /// self roster record alone is not meaningful; records of other devices are.
    pub fn has_meaningful_synchronized_state(&self, this_device: OperationId) -> bool {
        !(self.seen.is_empty()
            && self.history.is_empty()
            && self.history_removed.is_empty()
            && self.favorites.is_empty()
            && self.favorites_removed.is_empty()
            && self.exploration.is_empty()
            && self.activity.is_empty()
            && self.activity_removed.is_empty()
            && self.preferences == PreferencesV2::default()
            && self.devices.iter().all(|d| d.device_id == this_device))
    }
}

/// Schema capability, independent of whether a represented section happens to be empty.
#[derive(Clone, Copy)]
pub(crate) enum SyncDomain {
    Seen,
    History,
    HistoryRemovals,
    Favorites,
    FavoriteRemovals,
    Exploration,
    Activity,
    ActivityRemovals,
    Preferences,
    Devices,
}
#[derive(Debug)]
pub struct DecodedSnapshot {
    pub original_schema_version: u32,
    pub data: SyncSnapshot,
    pub needs_upgrade: bool,
}
impl DecodedSnapshot {
    pub(crate) fn represents(&self, domain: SyncDomain) -> bool {
        match self.original_schema_version {
            1 => matches!(
                domain,
                SyncDomain::Seen
                    | SyncDomain::History
                    | SyncDomain::HistoryRemovals
                    | SyncDomain::Favorites
                    | SyncDomain::FavoriteRemovals
            ),
            2 => true,
            // Unsupported schemas cannot reach Restore through decode_snapshot.
            _ => false,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotError {
    TruncatedHeader,
    InvalidMagic,
    UnsupportedVersion(u32),
    TooManyEntries,
    PayloadTooLarge,
    InvalidLength,
    InvalidLegacyId(u64),
    UnsortedOrDuplicate,
    InvalidValue,
    ConflictingOperation,
    CounterOverflow,
}
impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TruncatedHeader => f.write_str("Sync snapshot header is too short"),
            Self::InvalidMagic => f.write_str("Sync snapshot has invalid magic bytes"),
            Self::UnsupportedVersion(version) => {
                write!(f, "Unsupported sync snapshot version: {version}")
            }
            Self::TooManyEntries => f.write_str("Sync snapshot has too many entries"),
            Self::PayloadTooLarge => f.write_str("Sync snapshot exceeds payload limit"),
            Self::InvalidLength => f.write_str("Sync snapshot has invalid length or field size"),
            Self::InvalidLegacyId(id) => write!(f, "Invalid legacy Prnt.sc seen ID: {id}"),
            Self::UnsortedOrDuplicate => {
                f.write_str("Sync snapshot entries must be sorted and unique")
            }
            Self::InvalidValue => f.write_str("Sync snapshot contains invalid field value"),
            Self::ConflictingOperation => f.write_str(
                "Sync snapshot has conflicting operation with same ID but different payload",
            ),
            Self::CounterOverflow => f.write_str("Sync snapshot activity counter overflow"),
        }
    }
}
impl std::error::Error for SnapshotError {}
const MAGIC: &[u8; 8] = b"RFSNAP\0\0";

pub fn validate_day(day: &str) -> Result<(), SnapshotError> {
    if day.len() != 10
        || NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .ok()
            .map_or(true, |d| d.format("%Y-%m-%d").to_string() != day)
    {
        return Err(SnapshotError::InvalidValue);
    }
    Ok(())
}
pub(crate) fn validate_fields(source: &str, id: &str, url: &str) -> Result<(), SnapshotError> {
    if source.is_empty()
        || source.len() > 32
        || id.is_empty()
        || id.len() > 128
        || url.len() > 2048
        || source.contains('\0')
        || id.contains('\0')
        || url.contains('\0')
    {
        return Err(SnapshotError::InvalidLength);
    }
    Ok(())
}
fn sorted<T: Ord>(iter: impl IntoIterator<Item = T>) -> Result<(), SnapshotError> {
    let mut previous = None;
    for value in iter {
        if previous.as_ref().is_some_and(|p| p >= &value) {
            return Err(SnapshotError::UnsortedOrDuplicate);
        }
        previous = Some(value);
    }
    Ok(())
}
pub fn activity_projection(
    ops: &[ActivityOperation],
) -> Result<(u64, BTreeMap<String, DailyCounts>), SnapshotError> {
    let mut total = 0u64;
    let mut days: BTreeMap<String, DailyCounts> = BTreeMap::new();
    for op in ops {
        match op {
            ActivityOperation::Discovery { outcome, day, .. } => {
                validate_day(day)?;
                let counts = days.entry(day.clone()).or_default();
                let count = match outcome {
                    Outcome::Viewed => {
                        total = total.checked_add(1).ok_or(SnapshotError::CounterOverflow)?;
                        &mut counts.viewed
                    }
                    Outcome::Rejected => &mut counts.rejected,
                };
                *count = count.checked_add(1).ok_or(SnapshotError::CounterOverflow)?;
            }
            ActivityOperation::LegacyImport {
                viewed_total,
                days: legacy,
                ..
            } => {
                total = total
                    .checked_add(*viewed_total)
                    .ok_or(SnapshotError::CounterOverflow)?;
                for (day, counts) in legacy {
                    validate_day(day)?;
                    let sum = days.entry(day.clone()).or_default();
                    sum.viewed = sum
                        .viewed
                        .checked_add(counts.viewed)
                        .ok_or(SnapshotError::CounterOverflow)?;
                    sum.rejected = sum
                        .rejected
                        .checked_add(counts.rejected)
                        .ok_or(SnapshotError::CounterOverflow)?;
                }
            }
        }
    }
    Ok((total, days))
}
pub fn validate_snapshot(s: &SyncSnapshot) -> Result<(), SnapshotError> {
    sorted(s.seen.iter())?;
    if let Some(id) = s.seen.iter().find(|id| **id > LEGACY_MAX_VALUE) {
        return Err(SnapshotError::InvalidLegacyId(*id));
    }
    sorted(s.history.iter().map(|x| x.operation_id))?;
    sorted(s.history_removed.iter())?;
    sorted(s.favorites.iter().map(|x| x.operation_id))?;
    sorted(s.favorites_removed.iter())?;
    sorted(s.exploration.iter().map(|x| (&x.source, &x.id)))?;
    sorted(s.activity.iter().map(ActivityOperation::operation_id))?;
    sorted(s.activity_removed.iter())?;
    sorted(s.devices.iter().map(|x| x.device_id))?;
    if s.history
        .iter()
        .any(|x| s.history_removed.binary_search(&x.operation_id).is_ok())
        || s.favorites
            .iter()
            .any(|x| s.favorites_removed.binary_search(&x.operation_id).is_ok())
        || s.activity
            .iter()
            .any(|x| s.activity_removed.binary_search(&x.operation_id()).is_ok())
    {
        return Err(SnapshotError::InvalidValue);
    }
    for x in &s.history {
        validate_fields(&x.source, &x.id, &x.source_page_url)?;
        validate_day(&x.last_view.day)?;
    }
    for x in &s.favorites {
        validate_fields(&x.source, &x.id, &x.source_page_url)?;
    }
    for x in &s.exploration {
        validate_fields(&x.source, &x.id, "")?;
        if x.evidence > 3 {
            return Err(SnapshotError::InvalidValue);
        }
    }
    for x in &s.activity {
        if let ActivityOperation::Discovery {
            source, id, day, ..
        } = x
        {
            validate_fields(source, id, "")?;
            validate_day(day)?;
        }
    }
    // Validate every operation, including tombstoned ones, but project only the active set.
    let removed: std::collections::BTreeSet<_> = s.activity_removed.iter().collect();
    for op in &s.activity {
        activity_projection(std::slice::from_ref(op))?;
    }
    activity_projection(
        &s.activity
            .iter()
            .filter(|x| !removed.contains(&x.operation_id()))
            .cloned()
            .collect::<Vec<_>>(),
    )?;
    if s.preferences
        .theme
        .as_ref()
        .is_some_and(|x| !["system", "light", "dark"].contains(&x.value.as_str()))
        || s.preferences
            .history_page_size
            .as_ref()
            .is_some_and(|x| ![10, 25, 50, 100].contains(&x.value))
    {
        return Err(SnapshotError::InvalidValue);
    }
    for d in &s.devices {
        if d.metadata.value.display_name.trim().is_empty()
            || d.metadata.value.display_name.len() > 128
            || d.metadata.value.platform.is_empty()
            || d.metadata.value.platform.len() > 32
        {
            return Err(SnapshotError::InvalidValue);
        }
    }
    Ok(())
}

// Every append checks the shared budget before allocating. Counts on read are bounded by
// remaining bytes and minimum entry sizes before any collection is allocated.
struct Writer(Vec<u8>);
impl Writer {
    fn bytes(&mut self, bytes: &[u8]) -> Result<(), SnapshotError> {
        if self
            .0
            .len()
            .checked_add(bytes.len())
            .map_or(true, |n| n > MAX_PLAINTEXT)
        {
            return Err(SnapshotError::PayloadTooLarge);
        }
        self.0.extend_from_slice(bytes);
        Ok(())
    }
    fn u8(&mut self, v: u8) -> Result<(), SnapshotError> {
        self.bytes(&[v])
    }
    fn u16(&mut self, v: u16) -> Result<(), SnapshotError> {
        self.bytes(&v.to_le_bytes())
    }
    fn u32(&mut self, v: u32) -> Result<(), SnapshotError> {
        self.bytes(&v.to_le_bytes())
    }
    fn u64(&mut self, v: u64) -> Result<(), SnapshotError> {
        self.bytes(&v.to_le_bytes())
    }
    fn text(&mut self, v: &str) -> Result<(), SnapshotError> {
        self.u16(u16::try_from(v.len()).map_err(|_| SnapshotError::InvalidLength)?)?;
        self.bytes(v.as_bytes())
    }
    fn count(&mut self, n: usize) -> Result<(), SnapshotError> {
        self.u32(u32::try_from(n).map_err(|_| SnapshotError::TooManyEntries)?)
    }
    fn stamp<T>(&mut self, r: &Register<T>) -> Result<(), SnapshotError> {
        self.u64(r.clock)?;
        self.bytes(&r.operation_id)
    }
    fn optional<T>(
        &mut self,
        r: Option<&Register<T>>,
        value: impl FnOnce(&mut Self, &T) -> Result<(), SnapshotError>,
    ) -> Result<(), SnapshotError> {
        self.u8(u8::from(r.is_some()))?;
        if let Some(r) = r {
            self.stamp(r)?;
            value(self, &r.value)?;
        }
        Ok(())
    }
}
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], SnapshotError> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(SnapshotError::InvalidLength)?;
        let bytes = self
            .bytes
            .get(self.pos..end)
            .ok_or(SnapshotError::InvalidLength)?;
        self.pos = end;
        Ok(bytes)
    }
    fn u8(&mut self) -> Result<u8, SnapshotError> {
        Ok(self.bytes(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, SnapshotError> {
        Ok(u16::from_le_bytes(
            self.bytes(2)?
                .try_into()
                .map_err(|_| SnapshotError::InvalidLength)?,
        ))
    }
    fn u32(&mut self) -> Result<u32, SnapshotError> {
        Ok(u32::from_le_bytes(
            self.bytes(4)?
                .try_into()
                .map_err(|_| SnapshotError::InvalidLength)?,
        ))
    }
    fn u64(&mut self) -> Result<u64, SnapshotError> {
        Ok(u64::from_le_bytes(
            self.bytes(8)?
                .try_into()
                .map_err(|_| SnapshotError::InvalidLength)?,
        ))
    }
    fn id(&mut self) -> Result<OperationId, SnapshotError> {
        self.bytes(16)?
            .try_into()
            .map_err(|_| SnapshotError::InvalidLength)
    }
    fn text(&mut self) -> Result<String, SnapshotError> {
        let n = self.u16()? as usize;
        String::from_utf8(self.bytes(n)?.to_vec()).map_err(|_| SnapshotError::InvalidLength)
    }
    fn count(&mut self, minimum: usize) -> Result<usize, SnapshotError> {
        let n = self.u32()? as usize;
        if n > (self.bytes.len() - self.pos) / minimum {
            return Err(SnapshotError::InvalidLength);
        }
        Ok(n)
    }
    fn bool(&mut self) -> Result<bool, SnapshotError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::InvalidValue),
        }
    }
    fn optional<T>(
        &mut self,
        value: impl FnOnce(&mut Self) -> Result<T, SnapshotError>,
    ) -> Result<Option<Register<T>>, SnapshotError> {
        if !self.bool()? {
            return Ok(None);
        }
        Ok(Some(Register {
            clock: self.u64()?,
            operation_id: self.id()?,
            value: value(self)?,
        }))
    }
}

pub fn serialize_snapshot(s: &SyncSnapshot) -> Result<Vec<u8>, SnapshotError> {
    validate_snapshot(s)?;
    let mut w = Writer(Vec::new());
    w.bytes(MAGIC)?;
    w.u32(2)?;
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
    Ok(w.0)
}
pub fn parse_snapshot(bytes: &[u8]) -> Result<SyncSnapshot, SnapshotError> {
    Ok(decode_snapshot(bytes)?.data)
}
#[allow(
    clippy::too_many_lines,
    reason = "explicit ordered wire sections keep the binary format reviewable"
)]
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
        return decode_v1(bytes);
    }
    if version != 2 {
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
    if r.pos != bytes.len() {
        return Err(SnapshotError::InvalidLength);
    }
    validate_snapshot(&s)?;
    Ok(DecodedSnapshot {
        original_schema_version: 2,
        data: s,
        needs_upgrade: false,
    })
}
fn decode_v1(bytes: &[u8]) -> Result<DecodedSnapshot, SnapshotError> {
    let old = v1::parse_snapshot(bytes).map_err(|e| match e {
        v1::SnapshotError::UnsupportedVersion(v) => SnapshotError::UnsupportedVersion(v),
        v1::SnapshotError::PayloadTooLarge => SnapshotError::PayloadTooLarge,
        _ => SnapshotError::InvalidLength,
    })?;
    let s = SyncSnapshot {
        seen: old.seen,
        history: old
            .history
            .into_iter()
            .map(|x| SyncRecord {
                operation_id: x.operation_id,
                order_at: x.first_at,
                last_view: ViewStamp::inferred(x.second_at),
                source: x.source,
                id: x.id,
                source_page_url: x.source_page_url,
            })
            .collect(),
        history_removed: old.history_removed,
        favorites: old
            .favorites
            .into_iter()
            .map(|x| FavoriteRecord {
                operation_id: x.operation_id,
                added_at: x.added_at,
                source: x.source,
                id: x.id,
                source_page_url: x.source_page_url,
            })
            .collect(),
        favorites_removed: old.favorites_removed,
        ..SyncSnapshot::default()
    };
    validate_snapshot(&s)?;
    Ok(DecodedSnapshot {
        original_schema_version: 1,
        data: s,
        needs_upgrade: true,
    })
}
#[cfg(test)]
#[path = "snapshot/tests.rs"]
mod v2_tests;
