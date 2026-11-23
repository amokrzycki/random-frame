use super::*;
use crate::persistence::{device::DeviceIdentity, PreferenceStore};
use std::sync::Arc;

#[test]
fn upload_acknowledgement_keeps_inflight_preferences_dirty() -> Result<(), AppError> {
    let dir = test_directory("preference-upload-race");
    let data = PersistentState::new(&dir)?;
    let (published, generation) = data.snapshot_for_publication(1_000_000)?;
    let record = published.devices[0].clone();
    data.read(|| {
        data.preferences.set(UserPreferences {
            theme: Some("dark".into()),
            history_page_size: None,
        })
    })?;
    let acknowledged = data.record_published_self(record, generation)?;
    assert!(published.preferences.theme.is_none());
    assert_ne!(acknowledged, data.generation());
    assert_eq!(data.preferences.get().theme.as_deref(), Some("dark"));
    let (next, generation) = data.snapshot_for_publication(1_000_001)?;
    let acknowledged = data.record_published_self(next.devices[0].clone(), generation)?;
    assert_eq!(acknowledged, data.generation());
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

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
    let store = PreferenceStore::with_identity(&dir, &identity)?;
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

    let mut upload = crate::snapshot::SyncSnapshot {
        devices: store.sync_state().1,
        ..Default::default()
    };
    PreferenceStore::stage_self_last_sync(&mut upload, &identity, 1_000_000);
    assert!(store.sync_state().1[0].last_sync.is_none());
    store.merge(crate::snapshot::Preferences::default(), upload.devices)?;
    let (_, devices) = PreferenceStore::with_identity(&dir, &identity)?.sync_state();
    assert_eq!(
        devices[0].last_sync.as_ref().map(|r| r.value),
        Some(1_000_000)
    );
    assert_eq!(devices[0].joined_at_ms, joined);
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}

#[test]
fn zero_join_time_survives_preferences_restart() -> Result<(), AppError> {
    let dir = test_directory("zero-join-time");
    let identity = Arc::new(DeviceIdentity::new(&dir)?);
    let store = PreferenceStore::with_identity(&dir, &identity)?;
    let mut devices = store.sync_state().1;
    devices[0].joined_at_ms = 0;
    store.replace(crate::snapshot::Preferences::default(), devices)?;
    let restarted = PreferenceStore::with_identity(&dir, &identity)?;
    assert_eq!(restarted.sync_state().1[0].joined_at_ms, 0);
    assert!(restarted.sync_state().1[0].last_sync.is_none());
    fs::remove_dir_all(dir).map_err(AppError::persistence)
}
