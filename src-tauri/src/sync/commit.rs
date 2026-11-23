//! Committing the durable journal: send, accept, promote credentials, update local state.
use super::helpers::{invalid, snapshot_error};
use super::{
    engine::SyncEngine,
    errors::SyncError,
    state::SyncState,
    vault::{Credentials, Journal, Vault},
};
use crate::{
    secure_storage::SecretStore,
    snapshot,
    sync_membership_crypto::{self as crypto},
    sync_protocol::{decode, Mutation, OperationResult, Request},
    time::now_ms,
};
use reqwest::Method;

impl<S: SecretStore> SyncEngine<S> {
    pub(super) async fn commit_journal(
        &self,
        entry: &Journal,
    ) -> Result<OperationResult, SyncError> {
        let result = self.commit_journal_inner(entry).await;
        if let Err(error) = &result {
            self.terminal(error).await?;
            // A snapshot is recomputed from local data, so one that can never be accepted is dropped
            // instead of blocking every later operation.
            let hopeless_snapshot = matches!(&entry.request.mutation, Mutation::Snapshot { .. })
                && matches!(
                    error,
                    SyncError::MalformedResponse
                        | SyncError::BodyTooLarge
                        | SyncError::InvalidRemoteData
                        | SyncError::Persistence
                        | SyncError::CorruptLocalState
                );
            if hopeless_snapshot
                || matches!(
                    error,
                    SyncError::Conflict
                        | SyncError::OperationMismatch
                        | SyncError::AdministratorRequired
                        | SyncError::CodeRejected
                )
            {
                self.clear_journal(entry)?;
                let mut vault = self.vault().await?;
                vault.pending = None;
                self.save_vault(&vault).await?;
            }
        }
        result
    }
    /// A join is authenticated by the code's secret; if its response was lost and the code has
    /// since been replaced, the operation record answers instead.
    pub(super) async fn send_join(
        &self,
        c: &Credentials,
        bytes: &[u8],
    ) -> Result<Vec<u8>, SyncError> {
        let seed = c.join_seed.ok_or(SyncError::CorruptLocalState)?;
        let join = crypto::join_credentials(&seed).map_err(invalid)?;
        match self
            .call(
                &c.group_id,
                "join",
                Method::POST,
                &c.token,
                Some(&join.secret),
                Some(bytes.to_vec()),
            )
            .await
        {
            Err(SyncError::NotFound) => {
                let (request, _): (Request, &[u8]) = decode(bytes).map_err(invalid)?;
                match self
                    .call(
                        &c.group_id,
                        &format!("operations/{}", request.operation_id),
                        Method::GET,
                        &c.token,
                        None,
                        None,
                    )
                    .await
                {
                    Err(SyncError::NotFound) => Err(SyncError::CodeRejected),
                    other => other,
                }
            }
            other => other,
        }
    }
    pub(super) async fn commit_journal_inner(
        &self,
        entry: &Journal,
    ) -> Result<OperationResult, SyncError> {
        let mut vault = self.vault().await?;
        let bytes = self.request_bytes(entry)?;
        let result = self.send_entry(entry, &vault, &bytes).await?;
        self.accept(entry, &mut vault, &bytes, &result).await?;
        Ok(result)
    }
    /// Checks the exact request still decrypts, sends it, and validates the server's answer.
    async fn send_entry(
        &self,
        entry: &Journal,
        vault: &Vault,
        bytes: &[u8],
    ) -> Result<OperationResult, SyncError> {
        let c = if entry.promote {
            vault.pending.as_ref().or(vault.current.as_ref())
        } else {
            vault.current.as_ref()
        }
        .ok_or(SyncError::CorruptLocalState)?;
        let (_, payload): (Request, &[u8]) = decode(bytes).map_err(invalid)?;
        let publishes = !payload.is_empty();
        if publishes {
            let epoch = if matches!(
                &entry.request.mutation,
                Mutation::Create { .. } | Mutation::Revoke { .. }
            ) {
                entry
                    .request
                    .expected_epoch
                    .checked_add(1)
                    .ok_or(SyncError::CorruptLocalState)?
            } else {
                entry.request.expected_epoch
            };
            let plain = c
                .root()?
                .derive()
                .decrypt_snapshot(&entry.group_id, epoch, payload)
                .map_err(invalid)?;
            snapshot::parse_snapshot(&plain).map_err(snapshot_error)?;
        }
        let response = if matches!(&entry.request.mutation, Mutation::Join { .. }) {
            self.send_join(c, bytes).await?
        } else {
            let method = if entry.route == "snapshot" {
                Method::PUT
            } else {
                Method::POST
            };
            self.call(
                &entry.group_id,
                &entry.route,
                method,
                &c.token,
                None,
                Some(bytes.to_vec()),
            )
            .await?
        };
        let result: OperationResult = serde_json::from_slice(&response).map_err(invalid)?;
        if result.operation_id != entry.request.operation_id
            || result.revision < 1
            || result.epoch < 1
        {
            return Err(SyncError::InvalidRemoteData);
        }
        Ok(result)
    }
    /// Applies an accepted operation locally: promote credentials, save config, replace local
    /// state on Restore, then clear the journal. Order matters; the journal repairs a crash
    /// at any boundary.
    async fn accept(
        &self,
        entry: &Journal,
        vault: &mut Vault,
        bytes: &[u8],
        result: &OperationResult,
    ) -> Result<(), SyncError> {
        let (_, payload): (Request, &[u8]) = decode(bytes).map_err(invalid)?;
        let publishes = !payload.is_empty();
        if matches!(
            &entry.request.mutation,
            Mutation::Dissolve { .. } | Mutation::Leave { .. }
        ) {
            self.clear_journal(entry)?;
            self.terminal(
                if matches!(&entry.request.mutation, Mutation::Dissolve { .. }) {
                    &SyncError::Closed
                } else {
                    &SyncError::Left
                },
            )
            .await?;
            return Ok(());
        }
        if entry.promote {
            if let Some(pending) = vault.pending.take() {
                vault.current = Some(pending);
            }
        }
        // Persist promoted secrets before config; the retained journal repairs either crash boundary.
        self.save_vault(vault).await?;
        let c = vault.current.as_ref().ok_or(SyncError::CorruptLocalState)?;
        let mut config = self.config_after(c, result)?;
        if let Some(mode) = entry.join_mode {
            config.adoption = Some(mode);
        }
        if matches!(&entry.request.mutation, Mutation::Snapshot { .. }) {
            config.adoption = None;
        }
        if matches!(
            &entry.request.mutation,
            Mutation::Create { .. } | Mutation::Snapshot { .. } | Mutation::Revoke { .. }
        ) {
            config.last_success_at = Some(now_ms());
        }
        self.save(&config)?;
        if entry.restore {
            let plain = c
                .root()?
                .derive()
                .decrypt_snapshot(&entry.group_id, result.epoch, payload)
                .map_err(invalid)?;
            let target = snapshot::parse_snapshot(&plain).map_err(snapshot_error)?;
            let mut operation = [0; 16];
            hex::decode_to_slice(&entry.request.operation_id, &mut operation).map_err(invalid)?;
            self.data
                .replace_synchronized_once(&target, Some(operation))
                .map_err(|_| SyncError::Persistence)?;
        }
        if let (Some(record), Some(generation)) = (&entry.self_record, entry.generation) {
            let generation = self
                .data
                .record_published_self(record.clone(), generation)
                .map_err(|_| SyncError::Persistence)?;
            *self
                .uploaded_generation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(generation);
        }
        self.clear_journal(entry)?;
        if publishes {
            self.set_state(SyncState::Idle, None, Some(result.revision));
        }
        if matches!(&entry.request.mutation, Mutation::Join { .. }) {
            // The code stays in the vault until here so a replayed join can still authenticate.
            if let Some(current) = vault.current.as_mut() {
                current.join_seed = None;
            }
            self.save_vault(vault).await?;
        }
        self.notify_state_changed();
        Ok(())
    }
    pub(super) async fn resume(&self) -> Result<(), SyncError> {
        if let Some(entry) = self.journal()? {
            self.commit_journal(&entry).await?;
        }
        Ok(())
    }
}
