use super::{errors::SyncError, state::SyncLocalConfig};

pub(super) const MAX_CAS_ATTEMPTS: usize = 3;

pub(super) fn check_rollback(config: &SyncLocalConfig, remote: i64) -> Result<(), SyncError> {
    // Revision is not AEAD AAD. A first-time join has no floor and cannot detect
    // a valid historical blob replayed before this device first joined.
    if remote < config.last_accepted_revision {
        return Err(SyncError::ServerRollbackDetected {
            local_revision: config.last_accepted_revision,
            remote_revision: remote,
        });
    }
    Ok(())
}
