//! Device-independent plaintext format for legacy Prnt.sc seen IDs.

use crate::sources::prntsc::LEGACY_MAX_VALUE;
use std::{collections::HashSet, fmt};

const MAGIC: &[u8; 8] = b"RFSEEN\0\0";
const VERSION: u32 = 1;
const HEADER_LEN: usize = 16;
pub const MAX_ENTRIES: usize = 2_000_000; // 16,000,016 bytes, before future encryption overhead.

#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotError {
    TruncatedHeader,
    InvalidMagic,
    UnsupportedVersion(u32),
    TooManyEntries,
    InvalidLength,
    InvalidLegacyId(u64),
    UnsortedOrDuplicate,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TruncatedHeader => f.write_str("Truncated seen snapshot header"),
            Self::InvalidMagic => f.write_str("Invalid seen snapshot magic"),
            Self::UnsupportedVersion(version) => {
                write!(f, "Unsupported seen snapshot version: {version}")
            }
            Self::TooManyEntries => f.write_str("Too many seen snapshot entries"),
            Self::InvalidLength => f.write_str("Invalid seen snapshot length"),
            Self::InvalidLegacyId(id) => write!(f, "Invalid legacy Prnt.sc seen ID: {id}"),
            Self::UnsortedOrDuplicate => {
                f.write_str("Seen snapshot entries must be sorted and unique")
            }
        }
    }
}

impl std::error::Error for SnapshotError {}

/// V1: 8-byte magic, little-endian u32 version, little-endian u32 count,
/// then strictly ascending little-endian u64 IDs. No padding or trailing bytes.
pub fn serialize_snapshot(ids: &HashSet<u64>) -> Result<Vec<u8>, SnapshotError> {
    if ids.len() > MAX_ENTRIES {
        return Err(SnapshotError::TooManyEntries);
    }
    let mut sorted: Vec<_> = ids.iter().copied().collect();
    sorted.sort_unstable();
    let mut bytes = Vec::with_capacity(HEADER_LEN + sorted.len() * 8);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&VERSION.to_le_bytes());
    let count = u32::try_from(sorted.len()).map_err(|_| SnapshotError::TooManyEntries)?;
    bytes.extend_from_slice(&count.to_le_bytes());
    for id in sorted {
        if id > LEGACY_MAX_VALUE {
            return Err(SnapshotError::InvalidLegacyId(id));
        }
        bytes.extend_from_slice(&id.to_le_bytes());
    }
    Ok(bytes)
}

pub fn parse_snapshot(bytes: &[u8]) -> Result<Vec<u64>, SnapshotError> {
    if bytes.len() < HEADER_LEN {
        return Err(SnapshotError::TruncatedHeader);
    }
    if &bytes[..8] != MAGIC {
        return Err(SnapshotError::InvalidMagic);
    }
    let version = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| SnapshotError::InvalidLength)?,
    );
    if version != VERSION {
        return Err(SnapshotError::UnsupportedVersion(version));
    }
    let count = u32::from_le_bytes(
        bytes[12..16]
            .try_into()
            .map_err(|_| SnapshotError::InvalidLength)?,
    ) as usize;
    if count > MAX_ENTRIES {
        return Err(SnapshotError::TooManyEntries);
    }
    if bytes.len() != HEADER_LEN + count * 8 {
        return Err(SnapshotError::InvalidLength);
    }
    let mut ids = Vec::with_capacity(count);
    for chunk in bytes[HEADER_LEN..].chunks_exact(8) {
        let id = u64::from_le_bytes(chunk.try_into().map_err(|_| SnapshotError::InvalidLength)?);
        if id > LEGACY_MAX_VALUE {
            return Err(SnapshotError::InvalidLegacyId(id));
        }
        if ids.last().is_some_and(|previous| *previous >= id) {
            return Err(SnapshotError::UnsortedOrDuplicate);
        }
        ids.push(id);
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(entries: &[u64]) -> Vec<u8> {
        let mut bytes = Vec::from(*MAGIC);
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.extend_from_slice(
            &u32::try_from(entries.len())
                .unwrap_or_default()
                .to_le_bytes(),
        );
        for id in entries {
            bytes.extend_from_slice(&id.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn v1_layout_roundtrip_and_order_are_stable() -> Result<(), SnapshotError> {
        // Frozen wire fixture: changing bytes here requires a new format version.
        let golden =
            b"RFSEEN\0\0\x01\0\0\0\x03\0\0\0\x01\0\0\0\0\0\0\0\x05\0\0\0\0\0\0\0\x09\0\0\0\0\0\0\0";
        let empty = serialize_snapshot(&HashSet::new())?;
        assert_eq!(empty, raw(&[]));
        assert_eq!(parse_snapshot(&empty)?, Vec::<u64>::new());

        let first = [5, 1, 9].into_iter().collect();
        let second = [9, 5, 1].into_iter().collect();
        assert_eq!(serialize_snapshot(&first)?, golden);
        assert_eq!(parse_snapshot(golden)?, vec![1, 5, 9]);
        assert_eq!(serialize_snapshot(&first)?, serialize_snapshot(&second)?);
        assert_eq!(parse_snapshot(&serialize_snapshot(&first)?)?, vec![1, 5, 9]);

        let maximum = serialize_snapshot(&HashSet::from([LEGACY_MAX_VALUE]))?;
        assert_eq!(maximum, raw(&[LEGACY_MAX_VALUE]));
        assert_eq!(parse_snapshot(&maximum)?, vec![LEGACY_MAX_VALUE]);
        assert_eq!(
            serialize_snapshot(&HashSet::from([LEGACY_MAX_VALUE + 1])),
            Err(SnapshotError::InvalidLegacyId(LEGACY_MAX_VALUE + 1))
        );
        Ok(())
    }

    #[test]
    fn parser_rejects_noncanonical_and_corrupt_input() {
        assert_eq!(
            parse_snapshot(&raw(&[])[..15]),
            Err(SnapshotError::TruncatedHeader)
        );

        let mut bytes = raw(&[]);
        bytes[0] = b'X';
        assert_eq!(parse_snapshot(&bytes), Err(SnapshotError::InvalidMagic));

        let mut bytes = raw(&[]);
        bytes[8..12].copy_from_slice(&2_u32.to_le_bytes());
        assert_eq!(
            parse_snapshot(&bytes),
            Err(SnapshotError::UnsupportedVersion(2))
        );

        let mut bytes = raw(&[1]);
        bytes.truncate(bytes.len() - 1);
        assert_eq!(parse_snapshot(&bytes), Err(SnapshotError::InvalidLength));

        let mut bytes = raw(&[1]);
        bytes[12..16].copy_from_slice(&2_u32.to_le_bytes());
        assert_eq!(parse_snapshot(&bytes), Err(SnapshotError::InvalidLength));

        let mut bytes = raw(&[]);
        bytes[12..16].copy_from_slice(&2_000_001_u32.to_le_bytes());
        assert_eq!(parse_snapshot(&bytes), Err(SnapshotError::TooManyEntries));

        assert_eq!(
            parse_snapshot(&raw(&[LEGACY_MAX_VALUE + 1])),
            Err(SnapshotError::InvalidLegacyId(LEGACY_MAX_VALUE + 1))
        );
        assert_eq!(
            parse_snapshot(&raw(&[1, 1])),
            Err(SnapshotError::UnsortedOrDuplicate)
        );
        assert_eq!(
            parse_snapshot(&raw(&[2, 1])),
            Err(SnapshotError::UnsortedOrDuplicate)
        );

        let mut bytes = raw(&[1]);
        bytes.push(0);
        assert_eq!(parse_snapshot(&bytes), Err(SnapshotError::InvalidLength));
    }
}
