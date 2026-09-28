use crate::{
    error::AppError,
    snapshot::{validate_fields, MAX_SECTION},
};
use rand::{rngs::OsRng, RngCore};
use std::collections::HashSet;

/// Deduplicates removals in insertion order and keeps the newest `MAX_SECTION`.
// ponytail: FIFO cap; a device offline across more than MAX_SECTION removals can bring
// entries back. Add per-device acknowledgements if that ever matters.
pub(super) fn cap_tombstones(removed: &mut Vec<[u8; 16]>) {
    let mut seen = HashSet::new();
    removed.retain(|id| seen.insert(*id));
    let excess = removed.len().saturating_sub(MAX_SECTION);
    removed.drain(..excess);
}

pub(super) fn validate_item(source: &str, id: &str, source_page_url: &str) -> Result<(), AppError> {
    validate_fields(source, id, source_page_url)
        .map_err(|_| AppError::invalid_input("Frame fields exceed Sync limits"))
}

pub(super) fn operation_id() -> [u8; 16] {
    let mut id = [0; 16];
    OsRng.fill_bytes(&mut id);
    id
}
