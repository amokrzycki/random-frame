use super::{
    device::{DeviceIdentity, DeviceMetadata},
    io::{load_json, save_json},
    sync_ops::operation_id,
};
use crate::time::now_ms;
use crate::{
    error::AppError,
    snapshot::{merge_snapshots, DeviceRecord, PreferencesV2, Register, SyncSnapshot},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PreferenceData {
    version: u8,
    imported: bool,
    preferences: PreferencesV2,
    devices: Vec<DeviceRecord>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserPreferences {
    pub theme: Option<String>,
    pub history_page_size: Option<u16>,
}
pub struct PreferenceStore {
    path: PathBuf,
    data: Mutex<PreferenceData>,
    generation: AtomicU64,
    identity: Option<Arc<DeviceIdentity>>,
}
#[allow(clippy::significant_drop_tightening)]
impl PreferenceStore {
    #[allow(dead_code)]
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        Self::load(directory, None)
    }

    pub fn with_identity(
        directory: &Path,
        identity: Arc<DeviceIdentity>,
    ) -> Result<Self, AppError> {
        Self::load(directory, Some(identity))
    }

    fn load(directory: &Path, identity: Option<Arc<DeviceIdentity>>) -> Result<Self, AppError> {
        let path = directory.join("preferences.json");
        let mut data: PreferenceData = load_json(&path)?;
        if data.version > 2 {
            return Err(AppError::persistence("Unsupported preferences schema"));
        }
        data.version = 2;
        if let Some(identity) = &identity {
            data.devices = Self::ensure_self_record(&data.devices, identity);
        }
        crate::snapshot::validate_snapshot(&SyncSnapshot {
            preferences: data.preferences.clone(),
            devices: data.devices.clone(),
            ..SyncSnapshot::default()
        })
        .map_err(AppError::persistence)?;
        save_json(&path, &data)?;
        Ok(Self {
            path,
            data: Mutex::new(data),
            generation: AtomicU64::new(0),
            identity,
        })
    }

    fn ensure_self_record(
        devices: &[DeviceRecord],
        identity: &DeviceIdentity,
    ) -> Vec<DeviceRecord> {
        let id = identity.id();
        if let Some(existing) = devices.iter().find(|d| d.device_id == id) {
            let mut next = existing.clone();
            if next.metadata.value.display_name != identity.display_name()
                || next.metadata.value.platform != identity.platform()
            {
                next.metadata = Register {
                    clock: next.metadata.clock.saturating_add(1).max(1),
                    operation_id: operation_id(),
                    value: identity.metadata(),
                };
            }
            let mut out = devices.to_vec();
            if let Some(slot) = out.iter_mut().find(|d| d.device_id == id) {
                *slot = next;
            }
            out
        } else {
            let mut out = devices.to_vec();
            out.push(DeviceRecord {
                device_id: id,
                metadata: Register {
                    clock: 1,
                    operation_id: operation_id(),
                    value: identity.metadata(),
                },
                joined_at_ms: now_ms(),
                last_sync: None,
            });
            out
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
    pub fn sync_state(&self) -> (PreferencesV2, Vec<DeviceRecord>) {
        let data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (data.preferences.clone(), data.devices.clone())
    }
    pub fn get(&self) -> UserPreferences {
        let (p, _) = self.sync_state();
        UserPreferences {
            theme: p.theme.map(|x| x.value),
            history_page_size: p.history_page_size.map(|x| x.value),
        }
    }
    pub fn set(
        &self,
        preferences: UserPreferences,
        legacy_import: bool,
    ) -> Result<UserPreferences, AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if legacy_import && data.imported {
            drop(data);
            return Ok(self.get());
        }
        let mut next = data.clone();
        let clock = max_clock(&next)
            .checked_add(1)
            .ok_or_else(|| AppError::persistence("Preference clock exhausted"))?;
        if let Some(value) = preferences.theme {
            if (!legacy_import || next.preferences.theme.is_none())
                && next
                    .preferences
                    .theme
                    .as_ref()
                    .map_or(true, |x| x.value != value)
            {
                next.preferences.theme = Some(Register {
                    clock,
                    operation_id: operation_id(),
                    value,
                });
            }
        }
        if let Some(value) = preferences.history_page_size {
            if (!legacy_import || next.preferences.history_page_size.is_none())
                && next
                    .preferences
                    .history_page_size
                    .as_ref()
                    .map_or(true, |x| x.value != value)
            {
                next.preferences.history_page_size = Some(Register {
                    clock,
                    operation_id: operation_id(),
                    value,
                });
            }
        }
        next.imported |= legacy_import;
        crate::snapshot::validate_snapshot(&SyncSnapshot {
            preferences: next.preferences.clone(),
            devices: next.devices.clone(),
            ..SyncSnapshot::default()
        })
        .map_err(AppError::persistence)?;
        self.save_changed(&mut data, next)?;
        drop(data);
        Ok(self.get())
    }
    /// Restore: preferences and roster become exactly the incoming ones; the legacy
    /// browser import is closed so it cannot overwrite them.
    pub fn replace(
        &self,
        preferences: PreferencesV2,
        devices: Vec<DeviceRecord>,
    ) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = PreferenceData {
            version: 2,
            imported: true,
            preferences,
            devices,
        };
        self.save_changed(&mut data, next)
    }

    /// Adds or refreshes only this device's roster record (and its last sync) in `snapshot`,
    /// leaving every other record as given.
    pub fn register_self(snapshot: &mut SyncSnapshot, identity: &DeviceIdentity, at_ms: u64) {
        snapshot.devices = Self::ensure_self_record(&snapshot.devices, identity);
        snapshot.devices.sort_by_key(|d| d.device_id);
        let clock = snapshot_clock(snapshot).saturating_add(1);
        let id = identity.id();
        if let Some(record) = snapshot.devices.iter_mut().find(|d| d.device_id == id) {
            record.last_sync = Some(Register {
                clock,
                operation_id: operation_id(),
                value: at_ms,
            });
        }
    }

    pub fn merge(
        &self,
        preferences: PreferencesV2,
        devices: Vec<DeviceRecord>,
    ) -> Result<(), AppError> {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let merged = merge_snapshots(
            &SyncSnapshot {
                preferences: data.preferences.clone(),
                devices: data.devices.clone(),
                ..SyncSnapshot::default()
            },
            &SyncSnapshot {
                preferences,
                devices,
                ..SyncSnapshot::default()
            },
        )
        .map_err(AppError::persistence)?;
        let mut next = data.clone();
        next.preferences = merged.preferences;
        next.devices = merged.devices;
        self.save_changed(&mut data, next)
    }
    fn save_changed(
        &self,
        data: &mut PreferenceData,
        next: PreferenceData,
    ) -> Result<(), AppError> {
        if *data != next {
            save_json(&self.path, &next)?;
            *data = next;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn set_device_metadata(&self, metadata: DeviceMetadata) -> Result<(), AppError> {
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| AppError::invalid_input("No device identity"))?;
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = identity.id();
        let clock = max_clock(&data)
            .checked_add(1)
            .ok_or_else(|| AppError::persistence("Preference clock exhausted"))?;
        let mut next = data.clone();
        if let Some(slot) = next.devices.iter_mut().find(|d| d.device_id == id) {
            slot.metadata = Register {
                clock,
                operation_id: operation_id(),
                value: metadata,
            };
        } else {
            next.devices.push(DeviceRecord {
                device_id: id,
                metadata: Register {
                    clock,
                    operation_id: operation_id(),
                    value: metadata,
                },
                joined_at_ms: now_ms(),
                last_sync: None,
            });
        }
        self.save_changed(&mut data, next)
    }

    pub fn update_self_last_sync(&self, at_ms: u64) -> Result<(), AppError> {
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| AppError::invalid_input("No device identity"))?;
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = identity.id();
        let clock = max_clock(&data)
            .checked_add(1)
            .ok_or_else(|| AppError::persistence("Preference clock exhausted"))?;
        let mut next = data.clone();
        if let Some(slot) = next.devices.iter_mut().find(|d| d.device_id == id) {
            slot.last_sync = Some(Register {
                clock,
                operation_id: operation_id(),
                value: at_ms,
            });
        } else {
            next.devices.push(DeviceRecord {
                device_id: id,
                metadata: Register {
                    clock,
                    operation_id: operation_id(),
                    value: identity.metadata(),
                },
                joined_at_ms: now_ms(),
                last_sync: Some(Register {
                    clock,
                    operation_id: operation_id(),
                    value: at_ms,
                }),
            });
        }
        self.save_changed(&mut data, next)
    }
}

fn max_clock(data: &PreferenceData) -> u64 {
    registers_clock(&data.preferences, &data.devices)
}

fn snapshot_clock(snapshot: &SyncSnapshot) -> u64 {
    registers_clock(&snapshot.preferences, &snapshot.devices)
}

fn registers_clock(preferences: &PreferencesV2, devices: &[DeviceRecord]) -> u64 {
    devices
        .iter()
        .flat_map(|d| {
            [
                d.metadata.clock,
                d.last_sync.as_ref().map_or(0, |x| x.clock),
            ]
        })
        .max()
        .unwrap_or(0)
        .max(
            preferences.theme.as_ref().map_or(0, |x| x.clock).max(
                preferences
                    .history_page_size
                    .as_ref()
                    .map_or(0, |x| x.clock),
            ),
        )
}
