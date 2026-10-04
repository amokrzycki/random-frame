use super::{
    io::{load_json, save_json},
    sync_ops::operation_id,
};
use crate::{
    error::AppError,
    snapshot::{merge_snapshots, DeviceRecord, PreferencesV2, Register, SyncSnapshot},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
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
}
impl PreferenceStore {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        let path = directory.join("preferences.json");
        let mut data: PreferenceData = load_json(&path)?;
        if data.version > 2 {
            return Err(AppError::persistence("Unsupported preferences schema"));
        }
        data.version = 2;
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
        })
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
        let max_clock = next
            .preferences
            .theme
            .as_ref()
            .map_or(0, |x| x.clock)
            .max(
                next.preferences
                    .history_page_size
                    .as_ref()
                    .map_or(0, |x| x.clock),
            )
            .max(
                next.devices
                    .iter()
                    .flat_map(|d| {
                        [
                            d.metadata.clock,
                            d.last_sync.as_ref().map_or(0, |x| x.clock),
                        ]
                    })
                    .max()
                    .unwrap_or(0),
            );
        let clock = max_clock
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
        let result = self.save_changed(&mut data, next);
        drop(data);
        result
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
}
