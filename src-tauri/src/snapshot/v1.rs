//! Device-independent encrypted-sync plaintext format.

use crate::sources::prntsc::LEGACY_MAX_VALUE;
use std::fmt;

pub const MAX_ENTRIES: usize = (MAX_PLAINTEXT - 32) / 8;
pub const MAX_SECTION: usize = 100_000;
pub const MAX_PLAINTEXT: usize =
    crate::sync_transport::MAX_ENVELOPE - crate::sync_crypto::ENVELOPE_OVERHEAD;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncRecord {
    pub operation_id: [u8; 16],
    pub first_at: u64,
    pub second_at: u64,
    pub source: String,
    pub id: String,
    pub source_page_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FavoriteRecord {
    pub operation_id: [u8; 16],
    pub added_at: u64,
    pub source: String,
    pub id: String,
    pub source_page_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct SyncSnapshot {
    pub seen: Vec<u64>,
    pub history: Vec<SyncRecord>,
    pub history_removed: Vec<[u8; 16]>,
    pub favorites: Vec<FavoriteRecord>,
    pub favorites_removed: Vec<[u8; 16]>,
}

type ParsedRecord = ([u8; 16], u64, u64, String, String, String);

#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotError {
    TruncatedHeader,
    InvalidMagic,
    UnsupportedVersion(u32),
    TooManyEntries,
    PayloadTooLarge,
    InvalidLength,
    InvalidLegacyId(u64),
    UnsortedOrDuplicate,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TruncatedHeader => f.write_str("Truncated sync snapshot header"),
            Self::InvalidMagic => f.write_str("Invalid sync snapshot magic"),
            Self::UnsupportedVersion(version) => {
                write!(f, "Unsupported sync snapshot version: {version}")
            }
            Self::TooManyEntries => f.write_str("Too many sync snapshot entries"),
            Self::PayloadTooLarge => f.write_str("Sync snapshot exceeds payload limit"),
            Self::InvalidLength => f.write_str("Invalid sync snapshot length"),
            Self::InvalidLegacyId(id) => write!(f, "Invalid legacy Prnt.sc seen ID: {id}"),
            Self::UnsortedOrDuplicate => {
                f.write_str("Sync snapshot entries must be sorted and unique")
            }
        }
    }
}

impl std::error::Error for SnapshotError {}

const MAGIC: &[u8; 8] = b"RFSNAP\0\0";
const VERSION: u32 = 1;

pub fn serialize_snapshot(snapshot: &SyncSnapshot) -> Result<Vec<u8>, SnapshotError> {
    validate_snapshot(snapshot)?;
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    for count in [
        snapshot.seen.len(),
        snapshot.history.len(),
        snapshot.history_removed.len(),
        snapshot.favorites.len(),
        snapshot.favorites_removed.len(),
    ] {
        out.extend_from_slice(
            &u32::try_from(count)
                .map_err(|_| SnapshotError::TooManyEntries)?
                .to_le_bytes(),
        );
    }
    for id in &snapshot.seen {
        out.extend_from_slice(&id.to_le_bytes());
    }
    for record in &snapshot.history {
        write_record(
            &mut out,
            record.operation_id,
            record.first_at,
            record.second_at,
            record.source.as_bytes(),
            record.id.as_bytes(),
            record.source_page_url.as_bytes(),
        )?;
    }
    for id in &snapshot.history_removed {
        out.extend_from_slice(id);
    }
    for record in &snapshot.favorites {
        write_record(
            &mut out,
            record.operation_id,
            record.added_at,
            0,
            record.source.as_bytes(),
            record.id.as_bytes(),
            record.source_page_url.as_bytes(),
        )?;
    }
    for id in &snapshot.favorites_removed {
        out.extend_from_slice(id);
    }
    // Sections share the envelope budget, so a large Seen set leaves less room for the rest.
    if plaintext_too_large(out.len()) {
        return Err(SnapshotError::PayloadTooLarge);
    }
    Ok(out)
}

pub fn parse_snapshot(bytes: &[u8]) -> Result<SyncSnapshot, SnapshotError> {
    if plaintext_too_large(bytes.len()) {
        return Err(SnapshotError::PayloadTooLarge);
    }
    if bytes.len() < 32 {
        return Err(SnapshotError::TruncatedHeader);
    }
    if &bytes[..8] != MAGIC {
        return Err(SnapshotError::InvalidMagic);
    }
    if u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| SnapshotError::InvalidLength)?,
    ) != VERSION
    {
        return Err(SnapshotError::UnsupportedVersion(u32::from_le_bytes(
            bytes[8..12]
                .try_into()
                .map_err(|_| SnapshotError::InvalidLength)?,
        )));
    }
    let mut pos = 12;
    let mut counts = [0usize; 5];
    for count in &mut counts {
        *count = u32::from_le_bytes(
            bytes[pos..pos + 4]
                .try_into()
                .map_err(|_| SnapshotError::InvalidLength)?,
        ) as usize;
        pos += 4;
    }
    if counts[0] > MAX_ENTRIES {
        return Err(SnapshotError::PayloadTooLarge);
    }
    if counts[1..].iter().any(|count| *count > MAX_SECTION) {
        return Err(SnapshotError::TooManyEntries);
    }
    let mut result = SyncSnapshot::default();
    for _ in 0..counts[0] {
        result.seen.push(read_u64(bytes, &mut pos)?);
    }
    for _ in 0..counts[1] {
        result.history.push(read_sync_record(bytes, &mut pos)?);
    }
    for _ in 0..counts[2] {
        result.history_removed.push(read_id(bytes, &mut pos)?);
    }
    for _ in 0..counts[3] {
        result
            .favorites
            .push(read_favorite_record(bytes, &mut pos)?);
    }
    for _ in 0..counts[4] {
        result.favorites_removed.push(read_id(bytes, &mut pos)?);
    }
    if pos != bytes.len() {
        return Err(SnapshotError::InvalidLength);
    }
    validate_snapshot(&result)?;
    Ok(result)
}

fn plaintext_too_large(len: usize) -> bool {
    len > MAX_PLAINTEXT
}

fn validate_snapshot(value: &SyncSnapshot) -> Result<(), SnapshotError> {
    if value.seen.len() > MAX_ENTRIES {
        return Err(SnapshotError::PayloadTooLarge);
    }
    if value.history.len() > MAX_SECTION
        || value.history_removed.len() > MAX_SECTION
        || value.favorites.len() > MAX_SECTION
        || value.favorites_removed.len() > MAX_SECTION
    {
        return Err(SnapshotError::TooManyEntries);
    }
    if let Some(id) = value.seen.iter().find(|id| **id > LEGACY_MAX_VALUE) {
        return Err(SnapshotError::InvalidLegacyId(*id));
    }
    if value.seen.windows(2).any(|w| w[0] >= w[1]) {
        return Err(SnapshotError::UnsortedOrDuplicate);
    }
    if value
        .history
        .windows(2)
        .any(|w| w[0].operation_id >= w[1].operation_id)
        || value
            .favorites
            .windows(2)
            .any(|w| w[0].operation_id >= w[1].operation_id)
        || value.history_removed.windows(2).any(|w| w[0] >= w[1])
        || value.favorites_removed.windows(2).any(|w| w[0] >= w[1])
    {
        return Err(SnapshotError::UnsortedOrDuplicate);
    }
    for record in &value.history {
        validate_fields(&record.source, &record.id, &record.source_page_url)?;
    }
    for record in &value.favorites {
        validate_fields(&record.source, &record.id, &record.source_page_url)?;
    }
    Ok(())
}

pub(crate) fn validate_fields(source: &str, id: &str, url: &str) -> Result<(), SnapshotError> {
    if source.is_empty() || source.len() > 32 || id.is_empty() || id.len() > 128 || url.len() > 2048
    {
        return Err(SnapshotError::InvalidLength);
    }
    Ok(())
}
fn write_record(
    out: &mut Vec<u8>,
    op: [u8; 16],
    a: u64,
    b: u64,
    source: &[u8],
    id: &[u8],
    url: &[u8],
) -> Result<(), SnapshotError> {
    out.extend_from_slice(&op);
    out.extend_from_slice(&a.to_le_bytes());
    out.extend_from_slice(&b.to_le_bytes());
    for field in [source, id, url] {
        out.extend_from_slice(
            &(u16::try_from(field.len()).map_err(|_| SnapshotError::InvalidLength)?).to_le_bytes(),
        );
    }
    out.extend_from_slice(source);
    out.extend_from_slice(id);
    out.extend_from_slice(url);
    Ok(())
}
fn read_u64(bytes: &[u8], pos: &mut usize) -> Result<u64, SnapshotError> {
    let end = pos.checked_add(8).ok_or(SnapshotError::InvalidLength)?;
    let value = u64::from_le_bytes(
        bytes
            .get(*pos..end)
            .ok_or(SnapshotError::InvalidLength)?
            .try_into()
            .map_err(|_| SnapshotError::InvalidLength)?,
    );
    *pos = end;
    Ok(value)
}
fn read_id(bytes: &[u8], pos: &mut usize) -> Result<[u8; 16], SnapshotError> {
    let end = pos.checked_add(16).ok_or(SnapshotError::InvalidLength)?;
    let value = bytes
        .get(*pos..end)
        .ok_or(SnapshotError::InvalidLength)?
        .try_into()
        .map_err(|_| SnapshotError::InvalidLength)?;
    *pos = end;
    Ok(value)
}
fn read_record(bytes: &[u8], pos: &mut usize) -> Result<ParsedRecord, SnapshotError> {
    let op = read_id(bytes, pos)?;
    let a = read_u64(bytes, pos)?;
    let b = read_u64(bytes, pos)?;
    let lengths = [
        read_u16(bytes, pos)?,
        read_u16(bytes, pos)?,
        read_u16(bytes, pos)?,
    ];
    let mut fields = Vec::new();
    for len in lengths {
        let len = len as usize;
        let end = pos.checked_add(len).ok_or(SnapshotError::InvalidLength)?;
        let text = String::from_utf8(
            bytes
                .get(*pos..end)
                .ok_or(SnapshotError::InvalidLength)?
                .to_vec(),
        )
        .map_err(|_| SnapshotError::InvalidLength)?;
        *pos = end;
        fields.push(text);
    }
    Ok((
        op,
        a,
        b,
        fields.remove(0),
        fields.remove(0),
        fields.remove(0),
    ))
}
fn read_u16(bytes: &[u8], pos: &mut usize) -> Result<u16, SnapshotError> {
    let end = pos.checked_add(2).ok_or(SnapshotError::InvalidLength)?;
    let value = u16::from_le_bytes(
        bytes
            .get(*pos..end)
            .ok_or(SnapshotError::InvalidLength)?
            .try_into()
            .map_err(|_| SnapshotError::InvalidLength)?,
    );
    *pos = end;
    Ok(value)
}
fn read_sync_record(bytes: &[u8], pos: &mut usize) -> Result<SyncRecord, SnapshotError> {
    let (operation_id, first_at, second_at, source, id, source_page_url) = read_record(bytes, pos)?;
    Ok(SyncRecord {
        operation_id,
        first_at,
        second_at,
        source,
        id,
        source_page_url,
    })
}
fn read_favorite_record(bytes: &[u8], pos: &mut usize) -> Result<FavoriteRecord, SnapshotError> {
    let (operation_id, added_at, _, source, id, source_page_url) = read_record(bytes, pos)?;
    Ok(FavoriteRecord {
        operation_id,
        added_at,
        source,
        id,
        source_page_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_budget_has_exact_boundary() -> Result<(), std::num::TryFromIntError> {
        assert_eq!(MAX_PLAINTEXT, 67_108_812);
        assert!(!plaintext_too_large(MAX_PLAINTEXT));
        assert!(plaintext_too_large(MAX_PLAINTEXT + 1));
        assert_eq!(MAX_ENTRIES, 8_388_597);
        let mut header = [0; 32];
        header[..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&VERSION.to_le_bytes());
        header[12..16].copy_from_slice(&u32::try_from(MAX_ENTRIES + 1)?.to_le_bytes());
        assert_eq!(parse_snapshot(&header), Err(SnapshotError::PayloadTooLarge));
        header[12..16].fill(0);
        header[16..20].copy_from_slice(&u32::try_from(MAX_SECTION + 1)?.to_le_bytes());
        assert_eq!(parse_snapshot(&header), Err(SnapshotError::TooManyEntries));
        Ok(())
    }

    #[test]
    fn snapshot_above_the_old_seen_limit_roundtrips() -> Result<(), SnapshotError> {
        let snapshot = SyncSnapshot {
            seen: (0..=2_000_000).collect(),
            ..SyncSnapshot::default()
        };
        let bytes = serialize_snapshot(&snapshot)?;
        assert_eq!(bytes.len(), 32 + 2_000_001 * 8);
        assert_eq!(parse_snapshot(&bytes)?, snapshot);
        Ok(())
    }

    #[test]
    fn snapshot_roundtrip_is_canonical_and_rejects_unsorted_operations() -> Result<(), SnapshotError>
    {
        let snapshot = SyncSnapshot {
            seen: vec![1, 9],
            history: vec![SyncRecord {
                operation_id: [1; 16],
                first_at: 10,
                second_at: 11,
                source: "prntsc".into(),
                id: "abc123".into(),
                source_page_url: "https://prnt.sc/abc123".into(),
            }],
            history_removed: vec![[2; 16]],
            favorites: vec![FavoriteRecord {
                operation_id: [3; 16],
                added_at: 12,
                source: "prntsc".into(),
                id: "abc123".into(),
                source_page_url: "https://prnt.sc/abc123".into(),
            }],
            favorites_removed: vec![[4; 16]],
        };
        let bytes = serialize_snapshot(&snapshot)?;
        assert_eq!(&bytes[..12], b"RFSNAP\0\0\x01\0\0\0");
        assert_eq!(parse_snapshot(&bytes)?, snapshot);
        let mut old_seen = bytes;
        old_seen[..8].copy_from_slice(b"RFSEEN\0\0");
        assert_eq!(parse_snapshot(&old_seen), Err(SnapshotError::InvalidMagic));
        let mut invalid = snapshot;
        invalid.history.push(SyncRecord {
            operation_id: [0; 16],
            first_at: 0,
            second_at: 0,
            source: "prntsc".into(),
            id: "other".into(),
            source_page_url: String::new(),
        });
        assert_eq!(
            serialize_snapshot(&invalid),
            Err(SnapshotError::UnsortedOrDuplicate)
        );
        Ok(())
    }
}
