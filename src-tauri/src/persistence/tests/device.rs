use super::*;
use crate::persistence::{device::DeviceIdentity, PreferenceStore};
use std::sync::Arc;

#[test]
fn device_identity_generates_and_persists_stable_id() -> Result<(), AppError> {
    let dir = test_directory("device-id");
    let first = DeviceIdentity::new(&dir)?;
    let id = first.id();
    assert!(!id.iter().all(|b| *b == 0));
    assert_eq!(first.platform(), std::env::consts::OS);
    drop(first);

    let second = DeviceIdentity::new(&dir)?;
    assert_eq!(second.id(), id);
    assert_eq!(second.platform(), std::env::consts::OS);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn device_identity_rename_persists_and_validates() -> Result<(), AppError> {
    let dir = test_directory("device-rename");
    let identity = DeviceIdentity::new(&dir)?;
    identity.set_display_name(" Living Room ")?;
    assert_eq!(identity.display_name(), "Living Room");
    drop(identity);

    let restarted = DeviceIdentity::new(&dir)?;
    assert_eq!(restarted.display_name(), "Living Room");

    assert!(restarted.set_display_name("").is_err());
    assert!(restarted.set_display_name(&"a".repeat(129)).is_err());
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn recovery_creates_new_identity() -> Result<(), AppError> {
    let dir = test_directory("device-recovery");
    let first = DeviceIdentity::new(&dir)?;
    let id = first.id();
    drop(first);

    fs::remove_dir_all(&dir).map_err(AppError::persistence)?;
    let after_recovery = DeviceIdentity::new(&dir)?;
    assert_ne!(after_recovery.id(), id);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn preference_store_keeps_self_device_and_tracks_last_sync() -> Result<(), AppError> {
    let dir = test_directory("pref-device");
    let identity = Arc::new(DeviceIdentity::new(&dir)?);
    let store = PreferenceStore::with_identity(&dir, Arc::clone(&identity))?;
    let (_, devices) = store.sync_state();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].device_id, identity.id());
    let joined = devices[0].joined_at_ms;
    assert!(joined > 0);
    assert!(devices[0].last_sync.is_none());
    assert_eq!(
        devices[0].metadata.value.display_name,
        identity.display_name()
    );

    identity.set_display_name("Office")?;
    store.set_device_metadata(identity.metadata())?;
    let (_, devices) = store.sync_state();
    assert_eq!(devices[0].metadata.value.display_name, "Office");

    let mut upload = crate::snapshot::SyncSnapshot {
        devices: store.sync_state().1,
        ..Default::default()
    };
    PreferenceStore::stage_self_last_sync(&mut upload, &identity, 1_000_000);
    assert!(store.sync_state().1[0].last_sync.is_none());
    store.merge(crate::snapshot::PreferencesV2::default(), upload.devices)?;
    let (_, devices) = PreferenceStore::with_identity(&dir, Arc::clone(&identity))?.sync_state();
    assert_eq!(
        devices[0].last_sync.as_ref().map(|r| r.value),
        Some(1_000_000)
    );
    assert_eq!(devices[0].joined_at_ms, joined);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn legacy_zero_join_time_survives_preferences_restart() -> Result<(), AppError> {
    let dir = test_directory("legacy-device-date");
    let identity = Arc::new(DeviceIdentity::new(&dir)?);
    let store = PreferenceStore::with_identity(&dir, Arc::clone(&identity))?;
    let mut devices = store.sync_state().1;
    devices[0].joined_at_ms = 0;
    store.replace(crate::snapshot::PreferencesV2::default(), devices)?;
    let restarted = PreferenceStore::with_identity(&dir, identity)?;
    assert_eq!(restarted.sync_state().1[0].joined_at_ms, 0);
    assert!(restarted.sync_state().1[0].last_sync.is_none());
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
