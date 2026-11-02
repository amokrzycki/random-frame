use crate::{error::AppError, sources::prntsc};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{collections::HashSet, fs, path::PathBuf};
use tauri::{Manager, State};

type Thumbnail = (String, Vec<u8>);
const MAX_THUMBNAIL_BYTES: usize = 128 * 1024;

pub(crate) struct ThumbnailCache(PathBuf);

impl ThumbnailCache {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self(directory)
    }

    fn filename(key: &str) -> Result<String, AppError> {
        let id = key
            .strip_prefix("prntsc:")
            .ok_or_else(|| AppError::invalid_input("Invalid thumbnail source"))?;
        prntsc::validate_item_id(id)?;
        Ok(format!("prntsc-{id}.jpg"))
    }

    pub(crate) fn read_preview(&self, id: &str) -> Result<Option<Vec<u8>>, AppError> {
        let value = prntsc::item_id_value(id)?;
        let mut paths = vec![self.0.join(Self::filename(&format!("prntsc:{id}"))?)];
        // Historical leading-zero aliases keep their filenames and trusted provenance.
        if !paths[0].exists() {
            match fs::read_dir(&self.0) {
                Ok(entries) => {
                    for entry in entries {
                        let entry = entry.map_err(AppError::persistence)?;
                        if entry
                            .file_name()
                            .to_str()
                            .and_then(|name| name.strip_prefix("prntsc-"))
                            .and_then(|name| name.strip_suffix(".jpg"))
                            .is_some_and(|alias| prntsc::item_id_value(alias).ok() == Some(value))
                        {
                            paths.push(entry.path());
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(AppError::persistence(e)),
            }
        }
        for path in paths {
            match fs::metadata(&path) {
                Ok(meta)
                    if meta.is_file()
                        && meta.len() > 0
                        && meta.len() <= MAX_THUMBNAIL_BYTES as u64 =>
                {
                    return fs::read(path).map(Some).map_err(AppError::persistence)
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    return Err(AppError::persistence(e))
                }
                _ => {}
            }
        }
        Ok(None)
    }
    // Enumerating keys is cheap enough to reconcile the disk cache at startup; reading
    // every image is not, so bytes stay on disk until a view actually needs them. The
    // size and oldest-first order let the frontend keep its ordinary-cache bounds
    // without decoding anything.
    fn keys(&self) -> Result<Vec<(String, u64)>, AppError> {
        let files = match fs::read_dir(&self.0) {
            Ok(files) => files,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(AppError::persistence(error)),
        };
        let mut keys = Vec::new();
        for file in files {
            let file = file.map_err(AppError::persistence)?;
            let name = file.file_name();
            let Some(id) = name
                .to_str()
                .and_then(|name| name.strip_prefix("prntsc-"))
                .and_then(|name| name.strip_suffix(".jpg"))
            else {
                continue;
            };
            if prntsc::validate_item_id(id).is_err() {
                continue;
            }
            let metadata = file.metadata().map_err(AppError::persistence)?;
            if !metadata.is_file()
                || metadata.len() == 0
                || metadata.len() > MAX_THUMBNAIL_BYTES as u64
            {
                continue;
            }
            let modified = metadata.modified().ok();
            keys.push((modified, format!("prntsc:{id}"), metadata.len()));
        }
        // Preserve the old insertion order for oldest-first ordinary eviction.
        keys.sort_by_cached_key(|(modified, _, _)| *modified);
        Ok(keys
            .into_iter()
            .map(|(_, key, bytes)| (key, bytes))
            .collect())
    }

    // The frontend resolves leading-zero aliases against the key list, so this reads
    // exactly the requested file and never scans the directory.
    fn read_encoded(&self, key: &str) -> Result<Option<String>, AppError> {
        let path = self.0.join(Self::filename(key)?);
        match fs::metadata(&path) {
            Ok(meta)
                if meta.is_file() && meta.len() > 0 && meta.len() <= MAX_THUMBNAIL_BYTES as u64 =>
            {
                let bytes = fs::read(path).map_err(AppError::persistence)?;
                Ok(Some(format!(
                    "data:image/jpeg;base64,{}",
                    STANDARD.encode(bytes)
                )))
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(AppError::persistence(error))
            }
            _ => Ok(None),
        }
    }

    #[allow(
        clippy::case_sensitive_file_extension_comparisons,
        reason = "Only lowercase filenames created by this cache are managed"
    )]
    fn save(&self, entries: &[Thumbnail], keep: &[String]) -> Result<(), AppError> {
        let keep = keep
            .iter()
            .map(|key| Self::filename(key))
            .collect::<Result<HashSet<_>, _>>()?;
        for (key, bytes) in entries {
            let filename = Self::filename(key)?;
            if bytes.is_empty() || bytes.len() > MAX_THUMBNAIL_BYTES || !keep.contains(&filename) {
                return Err(AppError::invalid_input("Invalid thumbnail data"));
            }
        }
        fs::create_dir_all(&self.0).map_err(AppError::persistence)?;
        for (key, bytes) in entries {
            let path = self.0.join(Self::filename(key)?);
            // A frame's thumbnail is immutable. Never rewrite files already saved.
            if fs::read(&path).is_ok_and(|saved| saved == *bytes) {
                continue;
            }
            let temporary = path.with_extension("tmp");
            fs::write(&temporary, bytes).map_err(AppError::persistence)?;
            #[cfg(windows)]
            if path.exists() {
                fs::remove_file(&path).map_err(AppError::persistence)?;
            }
            fs::rename(&temporary, &path).map_err(AppError::persistence)?;
        }
        for file in fs::read_dir(&self.0).map_err(AppError::persistence)? {
            let file = file.map_err(AppError::persistence)?;
            let name = file.file_name();
            let Some(name) = name.to_str() else { continue };
            if (name.ends_with(".jpg") && !keep.contains(name)) || name.ends_with(".tmp") {
                fs::remove_file(file.path()).map_err(AppError::persistence)?;
            }
        }
        Ok(())
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command state extractors must be passed by value"
)]
pub(crate) fn list_thumbnail_cache(
    cache: State<'_, ThumbnailCache>,
) -> Result<Vec<(String, u64)>, AppError> {
    cache.keys()
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be owned"
)]
pub(crate) fn read_thumbnail_cache(
    key: String,
    cache: State<'_, ThumbnailCache>,
) -> Result<Option<String>, AppError> {
    cache.read_encoded(&key)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command arguments must be owned"
)]
pub(crate) fn save_thumbnail_cache(
    entries: Vec<Thumbnail>,
    keep: Vec<String>,
    cache: State<'_, ThumbnailCache>,
) -> Result<(), AppError> {
    cache.save(&entries, &keep)
}

pub(crate) fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(ThumbnailCache::new(
        app.path().app_cache_dir()?.join("thumbnails"),
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temporary_cache() -> (ThumbnailCache, PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "random-frame-thumbnails-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos())
        ));
        (ThumbnailCache::new(directory.clone()), directory)
    }

    #[test]
    fn lists_keys_without_reading_bytes_and_reads_one_file_on_demand(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (cache, directory) = temporary_cache();
        assert_eq!(cache.keys()?, Vec::<(String, u64)>::new());
        let key = "prntsc:abc123".to_owned();
        let other = "prntsc:def456".to_owned();
        cache.save(
            &[(key.clone(), vec![1, 2, 3]), (other.clone(), vec![4, 5])],
            &[key.clone(), other.clone()],
        )?;
        let mut keys = cache.keys()?;
        keys.sort();
        assert_eq!(keys, vec![(key.clone(), 3), (other, 2)]);
        assert_eq!(
            cache.read_encoded(&key)?,
            Some("data:image/jpeg;base64,AQID".into())
        );
        assert_eq!(cache.read_encoded("prntsc:1")?, None);
        assert!(cache.read_encoded("prntsc:../escape").is_err());
        // Empty and oversized files are not offered to the frontend, so the first
        // reconciliation prunes them instead of keeping them forever.
        fs::write(directory.join("prntsc-empty.jpg"), [])?;
        fs::write(
            directory.join("prntsc-huge.jpg"),
            vec![0; MAX_THUMBNAIL_BYTES + 1],
        )?;
        assert_eq!(cache.keys()?.len(), 2);
        cache.save(&[], &[key])?;
        assert!(!directory.join("prntsc-empty.jpg").exists());
        assert!(!directory.join("prntsc-huge.jpg").exists());
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn stores_individual_files_and_prunes_only_after_success(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = std::env::temp_dir().join(format!(
            "random-frame-thumbnails-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)?
                .as_nanos()
        ));
        let cache = ThumbnailCache::new(directory.clone());
        let key = "prntsc:abc123".to_owned();
        let other = "prntsc:def456".to_owned();
        cache.save(&[(key.clone(), vec![1, 2, 3])], std::slice::from_ref(&key))?;
        assert_eq!(
            cache.read_encoded(&key)?,
            Some("data:image/jpeg;base64,AQID".into())
        );
        let original_time = fs::metadata(directory.join("prntsc-abc123.jpg"))?.modified()?;
        cache.save(&[(other.clone(), vec![4, 5])], &[key.clone(), other])?;
        assert_eq!(
            fs::metadata(directory.join("prntsc-abc123.jpg"))?.modified()?,
            original_time
        );
        assert_eq!(cache.keys()?.len(), 2);
        assert!(cache
            .save(&[("prntsc:../escape".into(), vec![0])], &[])
            .is_err());
        assert!(cache
            .save(
                &[(key.clone(), vec![0; MAX_THUMBNAIL_BYTES + 1])],
                std::slice::from_ref(&key)
            )
            .is_err());
        assert_eq!(cache.keys()?.len(), 2);
        cache.save(&[], std::slice::from_ref(&key))?;
        assert_eq!(cache.keys()?, vec![(key.clone(), 3)]);
        assert_eq!(
            cache.read_encoded(&key)?,
            Some("data:image/jpeg;base64,AQID".into())
        );
        cache.save(&[], &[])?;
        assert_eq!(cache.keys()?, Vec::<(String, u64)>::new());
        fs::remove_dir_all(directory)?;
        Ok(())
    }
}
