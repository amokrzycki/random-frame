use super::{
    errors::SyncError,
    reconcile::SyncData,
    state::{
        load_config, save_config, Generation, LocalSyncSummary, SyncLocalConfig, SyncState,
        SyncStatus,
    },
};
#[cfg(test)]
use crate::persistence::{HistoryStore, SeenStore};
use crate::{
    persistence::PersistentState, secure_storage::SecretStore, sync_transport::SyncTransport,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

pub struct SyncEngine<S: SecretStore> {
    #[cfg(test)]
    pub(super) seen: Arc<SeenStore>,
    #[cfg(test)]
    pub(super) history: Arc<HistoryStore>,
    pub(super) data: Arc<PersistentState>,
    pub(super) secret: S,
    pub(super) transport: Option<SyncTransport>,
    pub(super) path: PathBuf,
    pub(super) operation: AsyncMutex<()>,
    pub(super) status: Mutex<SyncStatus>,
    pub(super) uploaded_generation: Mutex<Option<Generation>>,
    app_handle: Option<AppHandle>,
}

impl<S: SecretStore> SyncEngine<S> {
    pub fn new(
        directory: &Path,
        data: Arc<PersistentState>,
        secret: S,
        endpoint: Option<&str>,
        app_handle: Option<AppHandle>,
    ) -> Self {
        let transport = endpoint.and_then(|value| SyncTransport::new(value).ok());
        let path = directory.join("sync-config.json");
        let config = load_config(&path).ok().flatten();
        Self {
            #[cfg(test)]
            seen: Arc::clone(&data.seen),
            #[cfg(test)]
            history: Arc::clone(&data.history),
            data,
            secret,
            transport,
            path,
            operation: AsyncMutex::new(()),
            status: Mutex::new(SyncStatus {
                paired: config.is_some(),
                state: if config.is_some() {
                    SyncState::Idle
                } else {
                    SyncState::Unpaired
                },
                last_success_revision: config.map(|c| c.last_accepted_revision),
                ..Self::unpaired_status()
            }),
            uploaded_generation: Mutex::new(None),
            app_handle,
        }
    }

    pub(super) fn transport(&self) -> Result<&SyncTransport, SyncError> {
        self.transport.as_ref().ok_or(SyncError::InvalidEndpoint)
    }

    pub(super) fn data(&self) -> SyncData<'_> {
        SyncData { state: &self.data }
    }

    pub(super) fn config(&self) -> Result<Option<SyncLocalConfig>, SyncError> {
        load_config(&self.path)
    }

    pub(super) fn save(&self, config: &SyncLocalConfig) -> Result<(), SyncError> {
        save_config(&self.path, config)
    }

    pub(super) fn status_snapshot(&self) -> SyncStatus {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let uploaded = *self
            .uploaded_generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        status.dirty = uploaded != Some(self.local_generation());
        status.last_success_at = self.config().ok().flatten().and_then(|c| c.last_success_at);
        status.this_device_id = Some(hex::encode(self.data.identity.id()));
        status
    }

    pub(super) fn local_generation(&self) -> Generation {
        self.data.generation()
    }

    pub(super) fn set_state(
        &self,
        state: SyncState,
        error: Option<&SyncError>,
        revision: Option<i64>,
    ) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        status.state = state;
        status.last_error_category = error.map(|e| e.category().to_owned());
        if let Some(revision) = revision {
            status.last_success_revision = Some(revision);
        }
    }

    pub(super) fn notify_state_changed(&self) {
        if let Some(handle) = &self.app_handle {
            let _ = handle.emit("sync-state-changed", ());
        }
    }

    pub async fn status(&self) -> Result<SyncStatus, SyncError> {
        if self.config()?.is_none() {
            return Ok(self.status_snapshot());
        }
        if self.journal()?.is_some() {
            return Ok(self.status_snapshot());
        }
        let Ok(_guard) = self.operation.try_lock() else {
            return Ok(self.status_snapshot());
        };
        self.refresh_or_local().await
    }

    /// Counts of what this device would bring into (Merge) or lose to (Restore) a join.
    pub fn local_summary(&self) -> Result<LocalSyncSummary, SyncError> {
        let (snapshot, _) = self.data.snapshot().map_err(|_| SyncError::Persistence)?;
        Ok(LocalSyncSummary::from_snapshot(
            &snapshot,
            self.data.identity.id(),
        ))
    }

    pub async fn sync_now(&self) -> Result<SyncStatus, SyncError> {
        let revision = self.status_snapshot().last_success_revision;
        let _guard = self.operation.lock().await;
        let status = self.status_snapshot();
        // A successful overlapping operation already reconciled this generation.
        if status.last_success_revision != revision
            && !status.dirty
            && matches!(status.state, SyncState::Idle)
        {
            return Ok(status);
        }
        self.set_state(SyncState::Syncing, None, None);
        let result = self.sync_inner().await;
        self.finish(&result);
        result
    }

    pub async fn startup_sync(&self) -> Result<SyncStatus, SyncError> {
        if self.config()?.is_none() && self.journal()?.is_none() {
            return self.status().await;
        }
        self.sync_now().await
    }

    /// Any device but the administrator can leave. Ending a Sync that already ended just forgets it.
    pub async fn leave(&self) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        let ended = match self.config() {
            Ok(config) => config.is_some_and(|c| c.terminal.is_some()),
            // Damaged local Sync state cannot be repaired; leaving starts clean.
            Err(SyncError::CorruptLocalState) => true,
            Err(error) => return Err(error),
        };
        if ended {
            self.reset_local().await?;
            *self
                .uploaded_generation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            *self
                .status
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Self::unpaired_status();
            self.notify_state_changed();
            return Ok(self.status_snapshot());
        }
        self.end_membership(false).await
    }

    fn unpaired_status() -> SyncStatus {
        SyncStatus {
            supported: true,
            paired: false,
            state: SyncState::Unpaired,
            last_success_at: None,
            last_success_revision: None,
            dirty: true,
            last_error_category: None,
            this_device_id: None,
            devices: Vec::new(),
            control: super::state::MembershipStatus::default(),
        }
    }

    pub(super) fn finish<T>(&self, result: &Result<T, SyncError>) {
        if let Err(error) = result {
            let state = if matches!(error, SyncError::Unpaired) {
                SyncState::Unpaired
            } else if matches!(
                error,
                SyncError::Offline
                    | SyncError::Timeout
                    | SyncError::Tls
                    | SyncError::RateLimited
                    | SyncError::ServerError
            ) {
                SyncState::Offline
            } else {
                SyncState::Error
            };
            self.set_state(state, Some(error), None);
            // A GET may already have merged durable remote state before a later PUT failed.
            self.notify_state_changed();
        }
    }
}
