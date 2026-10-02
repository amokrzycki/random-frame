use crate::{error::AppError, sources::prntsc};
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

    fn load(&self) -> Result<Vec<Thumbnail>, AppError> {
        let files = match fs::read_dir(&self.0) {
            Ok(files) => files,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(AppError::persistence(error)),
        };
        let mut thumbnails = Vec::new();
        let mut files = files
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::persistence)?;
        // Preserve insertion order across restarts for oldest-first eviction.
        files.sort_by_cached_key(|file| file.metadata().and_then(|m| m.modified()).ok());
        for file in files {
            let name = file.file_name();
            let Some(id) = name
                .to_str()
                .and_then(|name| name.strip_prefix("prntsc-"))
                .and_then(|name| name.strip_suffix(".jpg"))
            else {
                continue;
            };
            let key = format!("prntsc:{id}");
            if Self::filename(&key).is_err() {
                continue;
            }
            let metadata = file.metadata().map_err(AppError::persistence)?;
            if !metadata.is_file()
                || metadata.len() == 0
                || metadata.len() > MAX_THUMBNAIL_BYTES as u64
            {
                continue;
            }
            thumbnails.push((key, fs::read(file.path()).map_err(AppError::persistence)?));
        }
        Ok(thumbnails)
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
pub(crate) fn load_thumbnail_cache(
    cache: State<'_, ThumbnailCache>,
) -> Result<Vec<Thumbnail>, AppError> {
    cache.load()
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
        let original_time = fs::metadata(directory.join("prntsc-abc123.jpg"))?.modified()?;
        cache.save(&[(other.clone(), vec![4, 5])], &[key.clone(), other])?;
        assert_eq!(
            fs::metadata(directory.join("prntsc-abc123.jpg"))?.modified()?,
            original_time
        );
        assert_eq!(cache.load()?.len(), 2);
        assert!(cache
            .save(&[("prntsc:../escape".into(), vec![0])], &[])
            .is_err());
        assert!(cache
            .save(
                &[(key.clone(), vec![0; MAX_THUMBNAIL_BYTES + 1])],
                std::slice::from_ref(&key)
            )
            .is_err());
        assert_eq!(cache.load()?.len(), 2);
        cache.save(&[], std::slice::from_ref(&key))?;
        assert_eq!(cache.load()?, vec![(key, vec![1, 2, 3])]);
        cache.save(&[], &[])?;
        assert_eq!(cache.load()?, Vec::<Thumbnail>::new());
        fs::remove_dir_all(directory)?;
        Ok(())
    }
}
