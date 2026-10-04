use crate::{error::AppError, snapshot::validate_fields};
use rand::{rngs::OsRng, RngCore};

/// Retain every known removal; upload budget errors must never discard state.
pub(super) fn deduplicate_tombstones(removed: &mut Vec<[u8; 16]>) {
    removed.sort_unstable();
    removed.dedup();
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
