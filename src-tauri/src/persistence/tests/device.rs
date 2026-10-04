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
    assert_eq!(
        devices[0].metadata.value.display_name,
        identity.display_name()
    );

    identity.set_display_name("Office")?;
    store.set_device_metadata(identity.metadata())?;
    let (_, devices) = store.sync_state();
    assert_eq!(devices[0].metadata.value.display_name, "Office");

    store.update_self_last_sync(1_000_000)?;
    let (_, devices) = PreferenceStore::with_identity(&dir, Arc::clone(&identity))?.sync_state();
    assert_eq!(
        devices[0].last_sync.as_ref().map(|r| r.value),
        Some(1_000_000)
    );
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
