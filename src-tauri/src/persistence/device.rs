use super::io::{load_json, save_json};
use crate::error::AppError;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex};

pub use crate::snapshot::DeviceMetadata;

pub type DeviceId = [u8; 16];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityData {
    version: u8,
    device_id: DeviceId,
    display_name: String,
    platform: String,
}

impl Default for IdentityData {
    fn default() -> Self {
        Self {
            version: 1,
            device_id: random_device_id(),
            display_name: default_display_name(),
            platform: std::env::consts::OS.into(),
        }
    }
}

fn random_device_id() -> DeviceId {
    let mut id = [0u8; 16];
    rand::thread_rng().fill(&mut id);
    id
}

fn default_display_name() -> String {
    std::env::consts::OS.into()
}

/// Local, stable identity for this installation. It is never part of the encrypted
/// snapshot and never moves between devices.
pub struct DeviceIdentity {
    data: Mutex<IdentityData>,
}

impl DeviceIdentity {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(directory).map_err(AppError::persistence)?;
        let path = directory.join("device-identity.json");
        let mut data: IdentityData = load_json(&path)?;
        if data.version != 1 {
            return Err(AppError::persistence("Unsupported device identity schema"));
        }
        if data.platform.is_empty() {
            data.platform = std::env::consts::OS.into();
        }
        if data.display_name.is_empty() {
            data.display_name = default_display_name();
        }
        save_json(&path, &data)?;
        Ok(Self {
            data: Mutex::new(data),
        })
    }

    pub fn id(&self) -> DeviceId {
        self.data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .device_id
    }

    pub fn display_name(&self) -> String {
        self.data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .display_name
            .clone()
    }

    pub fn platform(&self) -> String {
        self.data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .platform
            .clone()
    }

    pub fn metadata(&self) -> DeviceMetadata {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        DeviceMetadata {
            display_name: data.display_name.clone(),
            platform: data.platform.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!(
            "random-frame-device-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn generates_and_reloads_identity() -> Result<(), AppError> {
        let dir = temp_dir("reload");
        let first = DeviceIdentity::new(&dir)?;
        let id = first.id();
        assert_ne!(id, [0u8; 16]);
        drop(first);
        let second = DeviceIdentity::new(&dir)?;
        assert_eq!(second.id(), id);
        fs::remove_dir_all(dir).map_err(AppError::persistence)
    }
}
