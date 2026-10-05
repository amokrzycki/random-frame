//! A versioned destination is the atomic import receipt: once present, legacy is never read again.
use super::io::{load_json, save_json};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
#[derive(Default, Deserialize, Serialize)]
struct Receipts {
    version: u8,
    imported: BTreeSet<String>,
}
pub(super) fn source_path(
    directory: &Path,
    destination: &str,
    legacy: &str,
) -> Result<PathBuf, AppError> {
    let path = directory.join(destination);
    // An incomplete first write is not a receipt: the untouched legacy file can retry.
    // Complete temporary files are recovered to retain their generated operation IDs.
    let complete_temporary = std::fs::read(path.with_extension("json.tmp"))
        .is_ok_and(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
    if path.exists() || complete_temporary || path.with_extension("json.bak").exists() {
        Ok(path)
    } else {
        let receipts_path = directory.join("state-migration.json");
        let recoverable_receipts = std::fs::read(receipts_path.with_extension("json.tmp"))
            .is_ok_and(|bytes| serde_json::from_slice::<Receipts>(&bytes).is_ok());
        if (receipts_path.exists()
            || recoverable_receipts
            || receipts_path.with_extension("json.bak").exists())
            && has_receipt(directory, destination.trim_end_matches(".json"))?
        {
            return Err(AppError::persistence(
                "Committed migration destination is missing",
            ));
        }
        Ok(directory.join(legacy))
    }
}
pub(super) fn receipt(directory: &Path, name: &str) -> Result<(), AppError> {
    let path = directory.join("state-migration.json");
    let mut receipts: Receipts = load_json(&path)?;
    if receipts.version > 1 {
        return Err(AppError::persistence("Unsupported migration receipts"));
    }
    receipts.version = 1;
    if receipts.imported.insert(name.into()) {
        save_json(&path, &receipts)?;
    }
    Ok(())
}

pub(super) fn has_receipt(directory: &Path, name: &str) -> Result<bool, AppError> {
    let receipts: Receipts = load_json(&directory.join("state-migration.json"))?;
    if receipts.version > 1 {
        return Err(AppError::persistence("Unsupported migration receipts"));
    }
    Ok(receipts.imported.contains(name))
}
