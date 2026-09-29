use crate::error::AppError;
use serde::{de::DeserializeOwned, Serialize};
use std::{fs, path::Path};

/// Reads a JSON store, recovering a `.json.tmp` left by a save interrupted before its rename.
pub(super) fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, AppError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(AppError::persistence),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temporary = path.with_extension("json.tmp");
            match fs::read(&temporary) {
                Ok(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(data) => {
                        fs::rename(temporary, path).map_err(AppError::persistence)?;
                        Ok(data)
                    }
                    Err(error) => {
                        #[cfg(windows)]
                        if path.with_extension("json.bak").exists() {
                            return restore_json_backup(path);
                        }
                        Err(AppError::persistence(error))
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    #[cfg(windows)]
                    if path.with_extension("json.bak").exists() {
                        return restore_json_backup(path);
                    }
                    Ok(T::default())
                }
                Err(error) => Err(AppError::persistence(error)),
            }
        }
        Err(error) => Err(AppError::persistence(error)),
    }
}

#[cfg(windows)]
fn restore_json_backup<T: DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let backup = path.with_extension("json.bak");
    let data = serde_json::from_slice(&fs::read(&backup).map_err(AppError::persistence)?)
        .map_err(AppError::persistence)?;
    fs::rename(backup, path).map_err(AppError::persistence)?;
    Ok(data)
}

/// Writes a `.json.tmp` sibling and renames it over the store, so a crash never leaves a torn file.
pub(crate) fn save_json<T: Serialize>(path: &Path, data: &T) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(data).map_err(AppError::persistence)?;
    let temporary = path.with_extension("json.tmp");
    if let Err(error) = fs::write(&temporary, bytes) {
        let _ = fs::remove_file(&temporary);
        return Err(AppError::persistence(error));
    }
    #[cfg(windows)]
    if path.exists() {
        let backup = path.with_extension("json.bak");
        if backup.exists() {
            fs::remove_file(&backup).map_err(AppError::persistence)?;
        }
        fs::rename(path, &backup).map_err(AppError::persistence)?;
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::rename(backup, path);
            return Err(AppError::persistence(error));
        }
        let _ = fs::remove_file(backup);
        return Ok(());
    }
    fs::rename(&temporary, path).map_err(AppError::persistence)
}
