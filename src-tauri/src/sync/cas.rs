use super::{
    errors::SyncError,
    reconcile::SyncData,
    state::{save_config, Generation, SyncLocalConfig},
};
use crate::{
    snapshot,
    sync_crypto::SyncKeys,
    sync_transport::{SyncTransport, TransportError},
    time::now_ms,
};
use std::path::Path;

pub(super) const MAX_CAS_ATTEMPTS: usize = 3;

pub(super) fn check_rollback(config: &SyncLocalConfig, remote: i64) -> Result<(), SyncError> {
    // Revision is not AEAD AAD. A first-time join has no floor and cannot detect
    // a valid historical blob replayed before this device first joined.
    if let Some(local) = config.last_accepted_revision {
        if remote < local {
            return Err(SyncError::ServerRollbackDetected {
                local_revision: local,
                remote_revision: remote,
            });
        }
    }
    Ok(())
}

pub(super) async fn push_with_retries(
    data: &SyncData<'_>,
    transport: Option<&SyncTransport>,
    path: &Path,
    keys: &SyncKeys,
    mut revision: i64,
    mut config: Option<&mut SyncLocalConfig>,
) -> Result<(i64, Generation), SyncError> {
    for attempt in 0..MAX_CAS_ATTEMPTS {
        let (snapshot, generation, self_record) = data.local_snapshot()?;
        let envelope = keys
            .encrypt_snapshot(&snapshot)
            .map_err(|_| SyncError::InvalidRemoteData)?;
        #[cfg(any(test, debug_assertions))]
        crate::snapshot::report_upload(&snapshot, &envelope);
        match transport
            .ok_or(SyncError::InvalidEndpoint)?
            .update(
                keys.sync_id(),
                &keys.client_auth_token(),
                revision,
                envelope,
            )
            .await
        {
            Ok(next) => {
                let generation = data
                    .state
                    .record_published_self(self_record, generation)
                    .map_err(|_| SyncError::Persistence)?;
                return Ok((next, generation));
            }
            Err(TransportError::Conflict) => {
                if attempt + 1 == MAX_CAS_ATTEMPTS {
                    return Err(SyncError::Conflict);
                }
                let (latest, remote) = transport
                    .ok_or(SyncError::InvalidEndpoint)?
                    .get(keys.sync_id(), &keys.client_auth_token())
                    .await?;
                if let Some(config) = config.as_mut() {
                    check_rollback(config, latest)?;
                }
                data.merge_remote(keys, &remote)?;
                if let Some(config) = config.as_mut() {
                    if config
                        .last_accepted_revision
                        .is_none_or(|floor| latest > floor)
                    {
                        config.last_accepted_revision = Some(latest);
                        save_config(path, config)?;
                    }
                }
                revision = latest;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(SyncError::Conflict)
}

/// First publication of a Restore join. Every attempt rebuilds the upload from the latest
/// remote snapshot. Local state never enters the upload; replacement follows server acceptance.
pub(super) async fn restore_with_retries(
    data: &SyncData<'_>,
    transport: Option<&SyncTransport>,
    keys: &SyncKeys,
    mut revision: i64,
    mut remote: snapshot::SyncSnapshot,
) -> Result<(i64, Generation), SyncError> {
    let transport = transport.ok_or(SyncError::InvalidEndpoint)?;
    for attempt in 0..MAX_CAS_ATTEMPTS {
        let target = data.restore_target(&remote, now_ms())?;
        let bytes = snapshot::serialize_snapshot(&target).map_err(|error| match error {
            snapshot::SnapshotError::PayloadTooLarge => SyncError::BodyTooLarge,
            _ => SyncError::Persistence,
        })?;
        let envelope = keys
            .encrypt_snapshot(&bytes)
            .map_err(|_| SyncError::InvalidRemoteData)?;
        #[cfg(any(test, debug_assertions))]
        crate::snapshot::report_upload(&bytes, &envelope);
        match transport
            .update(
                keys.sync_id(),
                &keys.client_auth_token(),
                revision,
                envelope,
            )
            .await
        {
            Ok(next) => {
                let generation = data
                    .state
                    .replace_synchronized(&target)
                    .map_err(|_| SyncError::Persistence)?;
                return Ok((next, generation));
            }
            Err(TransportError::Conflict) => {
                if attempt + 1 == MAX_CAS_ATTEMPTS {
                    return Err(SyncError::Conflict);
                }
                let (latest, envelope) = transport
                    .get(keys.sync_id(), &keys.client_auth_token())
                    .await?;
                remote = super::reconcile::decode_remote(keys, &envelope)?;
                revision = latest;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(SyncError::Conflict)
}
