use crate::error::AppError;
use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::Write, path::Path};

/// Reads a JSON store, recovering a `.json.tmp` left by a save interrupted before its rename.
pub(super) fn load_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, AppError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(AppError::persistence),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let temporary = path.with_extension("json.tmp");
            match fs::read(&temporary) {
                Ok(bytes) => {
                    if let Ok(data) = serde_json::from_slice(&bytes) {
                        fs::rename(temporary, path).map_err(AppError::persistence)?;
                        Ok(data)
                    } else {
                        if path.with_extension("json.bak").exists() {
                            return restore_json_backup(path);
                        }
                        // Without a committed file or backup, a torn first write has
                        // not applied any effects. Retry its creator from empty state.
                        fs::remove_file(temporary).map_err(AppError::persistence)?;
                        Ok(T::default())
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
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

// A Windows interrupted replacement can be recovered after moving the profile
// to another platform too. A committed backup must never become default state.
fn restore_json_backup<T: DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let backup = path.with_extension("json.bak");
    let data = serde_json::from_slice(&fs::read(&backup).map_err(AppError::persistence)?)
        .map_err(AppError::persistence)?;
    fs::rename(backup, path).map_err(AppError::persistence)?;
    Ok(data)
}

/// Writes a `.json.tmp` sibling and renames it over the store, so a crash never leaves a torn file.
// ponytail: explicit fsync after write and directory rename ensures durability across crashes.
// Adds I/O overhead but prevents data loss on power failure or system crash. Acceptable tradeoff
// for user data that cannot be recovered from the server.
pub(crate) fn save_json<T: Serialize>(path: &Path, data: &T) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(data).map_err(AppError::persistence)?;
    let temporary = path.with_extension("json.tmp");
    let written = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
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
    fs::rename(&temporary, path).map_err(AppError::persistence)?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(AppError::persistence)?;
    }
    Ok(())
}
