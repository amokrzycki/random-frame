use super::{
    admin::{Credentials, Journal},
    engine::SyncEngine,
    errors::SyncError,
    state::{
        CreateManagedSyncResult, DeviceSummary, JoinMode, MembershipStatus, SyncState, SyncStatus,
    },
};
use crate::{
    secure_storage::SecretStore,
    snapshot,
    sync_membership_crypto::{self as crypto, AdminRecoverySecret},
    sync_protocol::{
        decode, encode, valid_hex, Control, EpochKeyPackage, Mutation, OperationResult,
        PairingRequest, Recipient, RecoveryRegistration, Request,
    },
    time::now_ms,
};
use reqwest::Method;
use zeroize::Zeroizing;

fn invalid<T>(_: T) -> SyncError {
    SyncError::InvalidRemoteData
}
fn crypto_error(error: &crate::sync_crypto::CryptoError) -> SyncError {
    match error {
        crate::sync_crypto::CryptoError::BodyTooLarge => SyncError::BodyTooLarge,
        _ => SyncError::InvalidRemoteData,
    }
}
fn snapshot_error(error: snapshot::SnapshotError) -> SyncError {
    match error {
        snapshot::SnapshotError::PayloadTooLarge => SyncError::BodyTooLarge,
        _ => SyncError::InvalidRemoteData,
    }
}
fn registration(
    secret: &AdminRecoverySecret,
    group: &str,
    generation: i64,
) -> Result<RecoveryRegistration, SyncError> {
    let (auth, _, pk) = secret.derive_credentials(group).map_err(invalid)?;
    Ok(RecoveryRegistration {
        generation,
        token_verifier: crypto::verifier(&auth),
        public_key: pk,
    })
}
fn recipients(c: &Control) -> Vec<Recipient> {
    let mut rs: Vec<_> = c
        .members
        .iter()
        .filter(|m| m.status == "active")
        .map(|m| Recipient {
            kind: "member".into(),
            id: m.member_id.clone(),
            version: m.credential_version,
            public_key: m.wrapping_public_key.clone(),
        })
        .collect();
    rs.push(Recipient {
        kind: "admin_recovery".into(),
        id: c.master_member_id.clone(),
        version: c.recovery_generation,
        public_key: c.recovery_public_key.clone(),
    });
    rs
}
fn packages(
    group: &str,
    epoch: i64,
    rs: &[Recipient],
    root: &crate::sync_crypto::RootSecret,
) -> Result<Vec<EpochKeyPackage>, SyncError> {
    rs.iter()
        .map(|r| crypto::seal_root(group, epoch, r, root).map_err(invalid))
        .collect()
}
fn journal(group: String, revision: i64, epoch: i64, mutation: Mutation, route: &str) -> Journal {
    Journal {
        version: 2,
        group_id: group,
        request: Request {
            operation_id: crypto::random_id(),
            expected_revision: revision,
            expected_epoch: epoch,
            mutation,
        },
        request_hash: String::new(),
        route: route.into(),
        promote: false,
        restore: false,
        legacy_source_id: None,
        join_mode: None,
        confirmed: true,
        generation: None,
        self_record: None,
        snapshot_schema: None,
        source_schema: 2,
    }
}
fn invitation(code: &str) -> Result<(String, String, Zeroizing<[u8; 32]>), SyncError> {
    let mut parts = code
        .strip_prefix("rf-invite-v2-")
        .ok_or(SyncError::InvalidRecoveryKey)?
        .split('-');
    let g = parts.next().ok_or(SyncError::InvalidRecoveryKey)?;
    let id = parts.next().ok_or(SyncError::InvalidRecoveryKey)?;
    let secret = parts.next().ok_or(SyncError::InvalidRecoveryKey)?;
    if parts.next().is_some() || !valid_hex(g, 32) || !valid_hex(id, 16) || !valid_hex(secret, 32) {
        return Err(SyncError::InvalidRecoveryKey);
    }
    let bytes = Zeroizing::new(hex::decode(secret).map_err(invalid)?);
    let mut s = Zeroizing::new([0; 32]);
    s.copy_from_slice(&bytes);
    Ok((g.into(), id.into(), s))
}

pub(super) fn invitation_group(code: &str) -> Result<String, SyncError> {
    Ok(invitation(code)?.0)
}

impl<S: SecretStore> SyncEngine<S> {
    pub(super) async fn call_v2(
        &self,
        group: &str,
        route: &str,
        method: Method,
        auth: &[u8; 32],
        invite: Option<&[u8; 32]>,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, SyncError> {
        let invite = invite.map(crypto::token);
        self.transport()?
            .managed(
                group,
                route,
                method,
                &crypto::token(auth),
                invite.as_deref().map(String::as_str),
                body,
            )
            .await
            .map_err(Into::into)
    }
    pub(super) fn managed_status(
        &self,
        c: Option<&Control>,
        config: &super::state::SyncLocalConfig,
    ) -> SyncStatus {
        let mut s = self.status_snapshot();
        let Some(m) = &config.managed else {
            return s;
        };
        s.paired = m.terminal.is_none();
        s.control = MembershipStatus {
            group_state: Some(
                if m.terminal.as_deref() == Some("closed") {
                    "closed"
                } else {
                    "active"
                }
                .into(),
            ),
            membership_state: Some(if m.left_locally {
                "left_locally".into()
            } else {
                m.terminal.clone().unwrap_or_else(|| "active".into())
            }),
            master_member_id: c.map(|c| c.master_member_id.clone()),
            this_member_id: Some(m.member_id.clone()),
            credential_version: Some(m.credential_version),
            key_epoch: Some(m.epoch),
            control_verified_at: c.map(|_| now_ms()),
            legacy_source_id: m.legacy_source_id.clone(),
        };
        s.devices = if let Some(c) = c {
            c.members
                .iter()
                .map(|member| {
                    let roster = self.data.preferences.sync_state().1;
                    let d = roster
                        .iter()
                        .find(|d| hex::encode(d.device_id) == member.device_id);
                    DeviceSummary {
                        device_id: member.device_id.clone(),
                        display_name: d.map_or_else(
                            || format!("Device {}", &member.member_id[..8]),
                            |d| d.metadata.value.display_name.clone(),
                        ),
                        platform: d.map_or_else(
                            || "unknown".into(),
                            |d| d.metadata.value.platform.clone(),
                        ),
                        joined_at_ms: member.joined_at_ms,
                        last_synced_at_ms: d.and_then(|d| d.last_sync.as_ref().map(|r| r.value)),
                        this_device: member.member_id == m.member_id,
                        member_id: Some(member.member_id.clone()),
                        status: Some(member.status.clone()),
                        is_master: member.member_id == c.master_member_id,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        if let Some(reason) = &m.terminal {
            s.state = SyncState::Error;
            s.last_error_category = Some(if m.left_locally {
                "left_locally".into()
            } else {
                reason.clone()
            });
        }
        s
    }
    pub(super) fn cache_managed_status(&self, s: SyncStatus) {
        *self
            .status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = s;
    }
    pub(super) async fn terminal(&self, error: &SyncError) -> Result<(), SyncError> {
        let reason = match error {
            SyncError::Revoked => "revoked",
            SyncError::Closed => "closed",
            SyncError::CredentialReplaced => "credential_replaced",
            SyncError::Left => "left",
            _ => return Ok(()),
        };
        if let Some(mut config) = self.config()? {
            if let Some(m) = &mut config.managed {
                m.terminal = Some(reason.into());
                self.save(&config)?;
                self.cache_managed_status(self.managed_status(None, &config));
            }
        }
        if let Some(entry) = self.journal()? {
            self.clear_journal(&entry)?;
        }
        // Terminal metadata is committed first; even denied keyring cleanup cannot enable sync.
        let _ = self.secret.delete_v2().await;
        self.notify_state_changed();
        Ok(())
    }
    #[expect(
        clippy::too_many_lines,
        reason = "Keep authenticated control, package and schema checks in their required order"
    )]
    pub(super) async fn read_managed(
        &self,
        c: &mut Credentials,
        recovery: Option<&AdminRecoverySecret>,
    ) -> Result<(Control, snapshot::DecodedSnapshot), SyncError> {
        let (auth, private, route) = if let Some(secret) = recovery {
            let (auth, private, _) = secret.derive_credentials(&c.group_id).map_err(invalid)?;
            (auth, private, "recovery/bootstrap")
        } else {
            (
                Zeroizing::new(c.token),
                Zeroizing::new(c.private_key),
                "snapshot",
            )
        };
        let bytes = match self
            .call_v2(&c.group_id, route, Method::GET, &auth, None, None)
            .await
        {
            Ok(b) => b,
            Err(e) => {
                if recovery.is_none() {
                    self.terminal(&e).await?;
                }
                return Err(e);
            }
        };
        let (control, payload): (Control, &[u8]) = decode(&bytes).map_err(invalid)?;
        if control.protocol_version != 2
            || control.group_id != c.group_id
            || control.state != "active"
            || control.revision < 1
            || control.epoch < 1
            || !(2..=3).contains(&control.snapshot_schema_floor)
            || control.recovery_generation < 1
            || !valid_hex(&control.master_member_id, 16)
        {
            return Err(SyncError::InvalidRemoteData);
        }
        let mut member_ids = std::collections::BTreeSet::new();
        for member in &control.members {
            if !valid_hex(&member.member_id, 16)
                || !valid_hex(&member.device_id, 16)
                || !valid_hex(&member.wrapping_public_key, 32)
                || member.credential_version < 1
                || !matches!(member.status.as_str(), "active" | "revoked" | "left")
                || !member_ids.insert(&member.member_id)
            {
                return Err(SyncError::InvalidRemoteData);
            }
        }
        if !control
            .members
            .iter()
            .any(|m| m.member_id == control.master_member_id && m.status == "active")
        {
            return Err(SyncError::InvalidRemoteData);
        }
        let r = if recovery.is_some() {
            if control.this_member_id.is_some()
                || control.recovery_generation != c.recovery_generation
            {
                return Err(SyncError::InvalidRecoveryKey);
            }
            Recipient {
                kind: "admin_recovery".into(),
                id: control.master_member_id.clone(),
                version: control.recovery_generation,
                public_key: control.recovery_public_key.clone(),
            }
        } else {
            if control.this_member_id.as_deref() != Some(&c.member_id) {
                return Err(SyncError::InvalidRemoteData);
            }
            let member = control
                .members
                .iter()
                .find(|m| m.member_id == c.member_id && m.status == "active")
                .ok_or(SyncError::InvalidRemoteData)?;
            if member.wrapping_public_key != crypto::public_key(&c.private_key).map_err(invalid)?
                || member.device_id != hex::encode(self.data.identity.id())
            {
                return Err(SyncError::InvalidRemoteData);
            }
            Recipient {
                kind: "member".into(),
                id: member.member_id.clone(),
                version: member.credential_version,
                public_key: member.wrapping_public_key.clone(),
            }
        };
        if let Some(config) = self.config()?.filter(|p| p.sync_id == c.group_id) {
            super::cas::check_rollback(&config, control.revision)?;
            if let Some(m) = config.managed {
                if m.terminal.is_some() {
                    return Err(SyncError::Unpaired);
                }
                if control.epoch > m.epoch {
                    self.set_state(SyncState::UpdatingKey, None, None);
                    self.notify_state_changed();
                }
                if control.epoch < m.epoch || r.version < m.credential_version {
                    return Err(SyncError::InvalidRemoteData);
                }
            }
        }
        let root = crypto::open_root(
            &control.group_id,
            control.epoch,
            &control.key_id,
            &r,
            &private,
            &control.key_package,
        )
        .map_err(invalid)?;
        let plaintext = root
            .derive()
            .decrypt_managed(&control.group_id, control.epoch, payload)
            .map_err(|error| match error {
                crate::sync_crypto::CryptoError::UnsupportedSnapshotVersion(v) => {
                    SyncError::UnsupportedVersion(v)
                }
                _ => SyncError::InvalidRemoteData,
            })?;
        let remote = snapshot::decode_snapshot(&plaintext).map_err(|error| match error {
            snapshot::SnapshotError::UnsupportedVersion(v) => SyncError::UnsupportedVersion(v),
            _ => SyncError::InvalidRemoteData,
        })?;
        let floor = self
            .data
            .schema_floor(&control.group_id)
            .map_err(|_| SyncError::Persistence)?
            .max(
                self.data
                    .publication_floor(&control.group_id, control.revision)
                    .map_err(|_| SyncError::Persistence)?,
            )
            .max(control.snapshot_schema_floor)
            .max(
                self.config()?
                    .filter(|p| p.sync_id == c.group_id)
                    .map_or(2, |p| p.highest_schema_version),
            );
        if remote.original_schema_version < floor {
            return Err(SyncError::SchemaDowngrade);
        }
        c.root = *root.as_bytes();
        Ok((control, remote))
    }
    fn require_managed_upgrade(&self, group: &str, schema: u32) -> Result<(), SyncError> {
        if schema < 3
            && !self
                .data
                .sync_upgrade_approved(group)
                .map_err(|_| SyncError::Persistence)?
        {
            return Err(SyncError::UpgradeRequired);
        }
        Ok(())
    }
    pub(super) fn save_observed(
        &self,
        c: &Credentials,
        control: &Control,
        source: Option<String>,
        schema: u32,
    ) -> Result<(), SyncError> {
        let result = OperationResult {
            operation_id: String::new(),
            revision: control.revision,
            epoch: control.epoch,
            recovery_generation: control.recovery_generation,
        };
        let mut config = self.managed_config(c, &result, source)?;
        let m = config
            .managed
            .as_mut()
            .ok_or(SyncError::CorruptLocalState)?;
        m.credential_version = control
            .members
            .iter()
            .find(|m| m.member_id == c.member_id)
            .ok_or(SyncError::InvalidRemoteData)?
            .credential_version;
        config.highest_schema_version = config.highest_schema_version.max(schema);
        self.save(&config)?;
        self.cache_managed_status(self.managed_status(Some(control), &config));
        Ok(())
    }
    pub(super) async fn commit_journal(
        &self,
        entry: &Journal,
    ) -> Result<OperationResult, SyncError> {
        let mut result = self.commit_journal_inner(entry).await;
        if matches!(&entry.request.mutation, Mutation::Create { .. })
            && matches!(result, Err(SyncError::MissingChain))
        {
            result = Err(SyncError::UnsupportedVersion(2));
        }
        if let Err(error) = &result {
            self.terminal(error).await?;
            if (matches!(&entry.request.mutation, Mutation::Recovery { .. })
                && *error == SyncError::MissingChain)
                || *error == SyncError::UnsupportedVersion(2)
                || matches!(
                    error,
                    SyncError::Conflict
                        | SyncError::OperationMismatch
                        | SyncError::MasterRequired
                        | SyncError::InvitationExpired
                        | SyncError::InvitationConsumed
                )
            {
                if entry.snapshot_schema.is_some()
                    || matches!(
                        &entry.request.mutation,
                        Mutation::Create { .. }
                            | Mutation::Snapshot { .. }
                            | Mutation::Revoke { .. }
                            | Mutation::Recovery { .. }
                    )
                {
                    self.data
                        .cancel_publication(&entry.group_id)
                        .map_err(|_| SyncError::Persistence)?;
                }
                self.clear_journal(entry)?;
                let mut vault = self.vault().await?;
                if matches!(&entry.request.mutation, Mutation::Redeem { .. }) {
                    vault.pairing = vault.pending.take();
                } else {
                    vault.pending = None;
                }
                vault.auth = None;
                vault.invitation = None;
                self.save_vault(&vault).await?;
            }
        }
        result
    }
    #[expect(
        clippy::too_many_lines,
        reason = "Keep the durable remote commit, secret promotion and local restore sequence explicit"
    )]
    pub(super) async fn commit_journal_inner(
        &self,
        entry: &Journal,
    ) -> Result<OperationResult, SyncError> {
        if !entry.confirmed {
            return Err(SyncError::PendingOperation);
        }
        let mut vault = self.vault().await?;
        let bytes = self.request_bytes(entry)?;
        let current = vault.current.as_ref();
        let pending = vault.pending.as_ref();
        let c = if entry.promote {
            pending.or(current)
        } else {
            current
        }
        .ok_or(SyncError::CorruptLocalState)?;
        let (_, payload): (Request, &[u8]) = decode(&bytes).map_err(invalid)?;
        let published_schema = if payload.is_empty() {
            None
        } else {
            let epoch = if matches!(
                &entry.request.mutation,
                Mutation::Create { .. } | Mutation::Revoke { .. } | Mutation::Recovery { .. }
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
                .decrypt_managed(&entry.group_id, epoch, payload)
                .map_err(invalid)?;
            let schema = snapshot::decode_snapshot(&plain)
                .map_err(invalid)?
                .original_schema_version;
            if entry.snapshot_schema.is_some_and(|v| v != schema) {
                return Err(SyncError::CorruptLocalState);
            }
            let floor = self
                .data
                .schema_floor(&entry.group_id)
                .map_err(|_| SyncError::Persistence)?
                .max(
                    self.data
                        .publication_floor(
                            &entry.group_id,
                            entry.request.expected_revision.saturating_add(1),
                        )
                        .map_err(|_| SyncError::Persistence)?,
                )
                .max(
                    self.config()?
                        .filter(|p| p.sync_id == entry.group_id)
                        .map_or(2, |p| p.highest_schema_version),
                );
            if schema < floor {
                return Err(SyncError::SchemaDowngrade);
            }
            if schema == 3 && !matches!(&entry.request.mutation, Mutation::Create { .. }) {
                self.require_managed_upgrade(&entry.group_id, entry.source_schema)?;
            }
            self.data
                .begin_publication(&entry.group_id, entry.request.expected_revision, schema)
                .map_err(|_| SyncError::Persistence)?;
            Some(schema)
        };
        let result = if matches!(&entry.request.mutation, Mutation::Recovery { .. }) {
            // The old code is never given replay privileges; confirm with the prepared new token.
            match self
                .call_v2(
                    &entry.group_id,
                    &format!("operations/{}", entry.request.operation_id),
                    Method::GET,
                    &c.token,
                    None,
                    None,
                )
                .await
            {
                Ok(b) => serde_json::from_slice(&b).map_err(invalid)?,
                Err(SyncError::MissingChain) => {
                    let auth = vault.auth.as_ref().ok_or(SyncError::CorruptLocalState)?;
                    let b = self
                        .call_v2(
                            &entry.group_id,
                            &entry.route,
                            Method::POST,
                            auth,
                            None,
                            Some(bytes.clone()),
                        )
                        .await?;
                    serde_json::from_slice::<OperationResult>(&b).map_err(invalid)?
                }
                Err(e) => return Err(e),
            }
        } else {
            let method = if entry.route == "snapshot" {
                Method::PUT
            } else {
                Method::POST
            };
            let b = self
                .call_v2(
                    &entry.group_id,
                    &entry.route,
                    method,
                    &c.token,
                    vault.invitation.as_ref(),
                    Some(bytes.clone()),
                )
                .await?;
            serde_json::from_slice(&b).map_err(invalid)?
        };
        let result: OperationResult = result;
        if result.operation_id != entry.request.operation_id
            || result.revision < 1
            || result.epoch < 1
        {
            return Err(SyncError::InvalidRemoteData);
        }
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
            return Ok(result);
        }
        if entry.promote && vault.pending.is_some() {
            vault.current = vault.pending.take();
        }
        let c = vault.current.as_ref().ok_or(SyncError::CorruptLocalState)?;
        // Persist promoted secrets before config; retained journal repairs either crash boundary.
        self.save_vault(&vault).await?;
        let mut config = self.managed_config(c, &result, entry.legacy_source_id.clone())?;
        if let Some(mode) = entry.join_mode {
            config
                .managed
                .as_mut()
                .ok_or(SyncError::CorruptLocalState)?
                .adoption = Some(mode);
        }
        if matches!(&entry.request.mutation, Mutation::Snapshot { .. }) {
            config
                .managed
                .as_mut()
                .ok_or(SyncError::CorruptLocalState)?
                .adoption = None;
        }
        if matches!(
            &entry.request.mutation,
            Mutation::Create { .. }
                | Mutation::Snapshot { .. }
                | Mutation::Revoke { .. }
                | Mutation::Recovery { .. }
        ) {
            config.last_success_at = Some(now_ms());
        }
        if let Some(schema) = published_schema {
            config.highest_schema_version = config.highest_schema_version.max(schema);
        }
        self.save(&config)?;
        if entry.restore {
            let (_, payload): (Request, &[u8]) = decode(&bytes).map_err(invalid)?;
            let plain = c
                .root()?
                .derive()
                .decrypt_managed(&entry.group_id, result.epoch, payload)
                .map_err(invalid)?;
            let target = snapshot::decode_snapshot(&plain).map_err(invalid)?;
            let mut operation = [0; 16];
            hex::decode_to_slice(&entry.request.operation_id, &mut operation).map_err(invalid)?;
            self.data
                .replace_synchronized_once(&target.data, Some(operation))
                .map_err(|_| SyncError::Persistence)?;
        }
        if published_schema.is_some() {
            self.data
                .complete_publication(&entry.group_id)
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
        if published_schema.is_some() {
            self.set_state(SyncState::Idle, None, Some(result.revision));
        }
        vault.auth = None;
        if vault.invitation_id.is_none()
            || matches!(
                &entry.request.mutation,
                Mutation::Revoke { .. } | Mutation::Recovery { .. }
            )
        {
            vault.invitation = None;
            vault.invitation_id = None;
        }
        self.save_vault(&vault).await?;
        self.notify_state_changed();
        if entry.legacy_source_id.is_some() {
            self.secret
                .delete()
                .await
                .map_err(|_| SyncError::SecureStorage)?;
        }
        Ok(result)
    }
    pub(super) async fn resume_managed(&self) -> Result<(), SyncError> {
        if let Some(entry) = self.journal()? {
            self.commit_journal(&entry).await?;
        }
        Ok(())
    }
    pub async fn create_managed(&self) -> Result<CreateManagedSyncResult, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        let result = self.create_managed_inner(false).await;
        self.finish(&result);
        result
    }
    pub async fn move_to_managed_sync(&self) -> Result<CreateManagedSyncResult, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        let result = self.create_managed_inner(true).await;
        self.finish(&result);
        result
    }
    async fn create_managed_inner(
        &self,
        moving: bool,
    ) -> Result<CreateManagedSyncResult, SyncError> {
        if let Some(entry) = self.journal()? {
            if !matches!(&entry.request.mutation, Mutation::Create { .. }) {
                return Err(SyncError::PendingOperation);
            }
            self.commit_journal(&entry).await?;
            return self.managed_creation_result(false).await;
        }
        self.forget_terminal().await?;
        let prior = self.config()?;
        let source = if moving {
            let config = prior
                .as_ref()
                .filter(|p| p.protocol_version == 1)
                .ok_or(SyncError::ManagedRequired)?;
            let keys = self.secret.load().await?.derive();
            if keys.sync_id() != config.sync_id {
                return Err(SyncError::CorruptLocalState);
            }
            let (r, b) = self
                .transport()?
                .get(keys.sync_id(), &keys.client_auth_token())
                .await?;
            super::cas::check_rollback(config, r)?;
            self.data()
                .merge_remote(&keys, &b, config.highest_schema_version, r)?;
            Some(config.sync_id.clone())
        } else {
            if prior.is_some() {
                return Err(SyncError::AlreadyPaired);
            }
            None
        };
        let mut vault = self.vault().await?;
        if vault.current.is_some() {
            return Err(SyncError::AlreadyPaired);
        }
        let group = hex::encode(crypto::random_secret());
        let mut c = Credentials::new(group.clone(), crypto::random_id());
        let admin = AdminRecoverySecret::generate();
        c.admin_secret = Some(*admin.0);
        c.recovery_generation = 1;
        let member = c.pairing(hex::encode(self.data.identity.id()))?;
        let recovery = registration(&admin, &group, 1)?;
        let rs = vec![
            Recipient {
                kind: "member".into(),
                id: member.member_id.clone(),
                version: 1,
                public_key: member.wrapping_public_key.clone(),
            },
            Recipient {
                kind: "admin_recovery".into(),
                id: member.member_id.clone(),
                version: 1,
                public_key: recovery.public_key.clone(),
            },
        ];
        let (snapshot, generation, self_record) = self.data().local_snapshot()?;
        let root = c.root()?;
        let payload = root
            .derive()
            .encrypt_managed(&group, 1, &snapshot)
            .map_err(|error| crypto_error(&error))?;
        let mutation = Mutation::Create {
            member,
            recovery,
            key_id: root.derive().sync_id().into(),
            packages: packages(&group, 1, &rs, &root)?,
        };
        vault.pending = Some(c);
        self.save_vault(&vault).await?;
        let mut entry = journal(group, 0, 0, mutation, "create");
        entry.promote = true;
        entry.generation = Some(generation);
        entry.self_record = Some(self_record);
        entry.legacy_source_id = source;
        entry.snapshot_schema = Some(3);
        entry.source_schema = 3; // New group; legacy consent was checked before its merge.
        let entry = self.prepare(entry, &payload)?;
        self.commit_journal(&entry).await?;
        self.managed_creation_result(false).await
    }
    async fn managed_creation_result(
        &self,
        prepared: bool,
    ) -> Result<CreateManagedSyncResult, SyncError> {
        let vault = self.vault().await?;
        let c = if prepared {
            vault.pending.as_ref().or(vault.current.as_ref())
        } else {
            vault.current.as_ref()
        }
        .ok_or(SyncError::CorruptLocalState)?;
        let secret = AdminRecoverySecret(Zeroizing::new(
            c.admin_secret.ok_or(SyncError::MasterRequired)?,
        ));
        let code = secret.code(&c.group_id, c.recovery_generation).to_string();
        let group = c.group_id.clone();
        let status = if prepared {
            self.status_snapshot()
        } else {
            self.refresh_managed_status().await?
        };
        let source = self
            .config()?
            .and_then(|p| p.managed.and_then(|m| m.legacy_source_id));
        Ok(CreateManagedSyncResult {
            group_id: group,
            admin_recovery_code: code,
            status,
            source_legacy_id: source,
            prepared,
        })
    }
    pub(super) async fn refresh_managed_status(&self) -> Result<SyncStatus, SyncError> {
        let config = self.config()?.ok_or(SyncError::Unpaired)?;
        if config
            .managed
            .as_ref()
            .is_some_and(|m| m.terminal.is_some())
        {
            return Ok(self.managed_status(None, &config));
        }
        let mut vault = self.vault().await?;
        let c = vault.current.as_mut().ok_or(SyncError::CorruptLocalState)?;
        if c.group_id != config.sync_id
            || config
                .managed
                .as_ref()
                .is_none_or(|m| m.member_id != c.member_id)
        {
            return Err(SyncError::CorruptLocalState);
        }
        let (control, remote) = self.read_managed(c, None).await?;
        let source = config.managed.and_then(|m| m.legacy_source_id);
        self.save_observed(c, &control, source, remote.original_schema_version)?;
        self.save_vault(&vault).await?;
        if matches!(self.status_snapshot().state, SyncState::UpdatingKey)
            || (remote.original_schema_version == 3
                && self.status_snapshot().last_error_category.as_deref()
                    == Some("upgrade_required"))
        {
            self.set_state(SyncState::Idle, None, None);
        }
        Ok(self.managed_status(Some(&control), &self.config()?.ok_or(SyncError::Unpaired)?))
    }
    pub async fn pairing_request(&self) -> Result<String, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        self.forget_terminal().await?;
        if self.config()?.is_some() {
            return Err(SyncError::AlreadyPaired);
        }
        let mut vault = self.vault().await?;
        if self.journal()?.is_some() {
            return Err(SyncError::PendingOperation);
        }
        if vault.pairing.is_none() {
            vault.pairing = Some(Credentials::new(String::new(), crypto::random_id()));
            self.save_vault(&vault).await?;
        }
        let p = vault
            .pairing
            .as_ref()
            .ok_or(SyncError::CorruptLocalState)?
            .pairing(hex::encode(self.data.identity.id()))?;
        Ok(format!(
            "rf-pair-v2-{}",
            hex::encode(serde_json::to_vec(&p).map_err(|_| SyncError::Persistence)?)
        ))
    }
    pub async fn create_invitation(&self, request: &str) -> Result<String, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if let Some(entry) = self.journal()? {
            if matches!(&entry.request.mutation, Mutation::Invite { .. }) {
                self.commit_journal(&entry).await?;
                return self.last_invitation().await;
            }
            return Err(SyncError::PendingOperation);
        }
        if request.len() > 4096 {
            return Err(SyncError::InvalidRecoveryKey);
        }
        let b = hex::decode(
            request
                .strip_prefix("rf-pair-v2-")
                .ok_or(SyncError::InvalidRecoveryKey)?,
        )
        .map_err(invalid)?;
        let p: PairingRequest = serde_json::from_slice(&b).map_err(invalid)?;
        if !valid_hex(&p.member_id, 16)
            || !valid_hex(&p.device_id, 16)
            || !valid_hex(&p.token_verifier, 32)
            || !valid_hex(&p.wrapping_public_key, 32)
            || !valid_hex(&p.nonce, 32)
        {
            return Err(SyncError::InvalidRecoveryKey);
        }
        let mut vault = self.vault().await?;
        let c = vault.current.as_mut().ok_or(SyncError::Unpaired)?;
        let (control, _) = self.read_managed(c, None).await?;
        if control.master_member_id != c.member_id {
            return Err(SyncError::MasterRequired);
        }
        let r = Recipient {
            kind: "member".into(),
            id: p.member_id.clone(),
            version: 1,
            public_key: p.wrapping_public_key.clone(),
        };
        let package =
            crypto::seal_root(&c.group_id, control.epoch, &r, &c.root()?).map_err(invalid)?;
        let invitation_id = crypto::random_id();
        let secret = crypto::random_secret();
        let mutation = Mutation::Invite {
            credential_version: control
                .members
                .iter()
                .find(|m| m.member_id == c.member_id)
                .ok_or(SyncError::InvalidRemoteData)?
                .credential_version,
            invitation_id: invitation_id.clone(),
            invitation_verifier: crypto::verifier(&secret),
            member: p,
            package,
        };
        let entry = journal(
            c.group_id.clone(),
            control.revision,
            control.epoch,
            mutation,
            "invitations",
        );
        // Save the invite secret before HTTP; keep it available after a lost response.
        vault.invitation = Some(secret);
        vault.invitation_id = Some(invitation_id);
        self.save_vault(&vault).await?;
        let entry = self.prepare(entry, &[])?;
        self.commit_journal(&entry).await?;
        self.last_invitation().await
    }
    async fn last_invitation(&self) -> Result<String, SyncError> {
        let vault = self.vault().await?;
        let c = vault.current.as_ref().ok_or(SyncError::Unpaired)?;
        Ok(format!(
            "rf-invite-v2-{}-{}-{}",
            c.group_id,
            vault
                .invitation_id
                .as_ref()
                .ok_or(SyncError::CorruptLocalState)?,
            crypto::token(
                vault
                    .invitation
                    .as_ref()
                    .ok_or(SyncError::CorruptLocalState)?
            )
            .as_str()
        ))
    }
    pub async fn invitation_code(&self) -> Result<String, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if self.journal()?.is_some() {
            return Err(SyncError::PendingOperation);
        }
        let status = self.refresh_managed_status().await?;
        if status.control.master_member_id != status.control.this_member_id {
            return Err(SyncError::MasterRequired);
        }
        if self.vault().await?.invitation_id.is_none() {
            return Err(SyncError::NoInvitation);
        }
        self.last_invitation().await
    }
    pub(super) async fn join_managed(
        &self,
        code: &str,
        mode: JoinMode,
    ) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if self.journal()?.is_some() {
            self.resume_managed().await?;
            return self.sync_managed_inner().await;
        }
        if let Some(config) = self.config()? {
            if config
                .managed
                .as_ref()
                .is_some_and(|m| m.adoption.is_some())
            {
                return self.sync_managed_inner().await;
            }
            return Err(SyncError::AlreadyPaired);
        }
        let (group, invite, secret) = invitation(code)?;
        let mut vault = self.vault().await?;
        let mut c = vault.pairing.take().ok_or(SyncError::InvalidRecoveryKey)?;
        c.group_id = group.clone();
        let member = c.pairing(hex::encode(self.data.identity.id()))?;
        let mut entry = journal(
            group,
            0,
            0,
            Mutation::Redeem {
                invitation_id: invite,
                invitation_verifier: crypto::verifier(&secret),
                member,
            },
            "redeem",
        );
        let status = self
            .call_v2(
                &c.group_id,
                "invitation/status",
                Method::POST,
                &c.token,
                Some(&secret),
                Some(encode(&entry.request, &[]).map_err(|_| SyncError::BodyTooLarge)?),
            )
            .await?;
        let result: OperationResult = serde_json::from_slice(&status).map_err(invalid)?;
        entry.request.expected_revision = result.revision;
        entry.request.expected_epoch = result.epoch;
        entry.promote = true;
        entry.join_mode = Some(mode);
        vault.pending = Some(c);
        vault.invitation = Some(*secret);
        self.save_vault(&vault).await?;
        let entry = self.prepare(entry, &[])?;
        self.commit_journal(&entry).await?;
        self.sync_managed_inner().await
    }
    pub(super) async fn sync_managed_inner(&self) -> Result<SyncStatus, SyncError> {
        self.resume_managed().await?;
        let local = if self
            .config()?
            .and_then(|c| c.managed)
            .is_some_and(|m| m.adoption == Some(JoinMode::Restore))
        {
            self.data.snapshot().map_err(|_| SyncError::Persistence)?.0
        } else {
            snapshot::SyncSnapshot::default()
        };
        for _ in 0..super::cas::MAX_CAS_ATTEMPTS {
            let config = self.config()?.ok_or(SyncError::Unpaired)?;
            let m = config.managed.as_ref().ok_or(SyncError::ManagedRequired)?;
            if m.terminal.is_some() {
                return Ok(self.managed_status(None, &config));
            }
            let mut vault = self.vault().await?;
            let c = vault.current.as_mut().ok_or(SyncError::CorruptLocalState)?;
            let (control, remote) = self.read_managed(c, None).await?;
            self.require_managed_upgrade(&c.group_id, remote.original_schema_version)?;
            let adoption = m.adoption;
            let source = m.legacy_source_id.clone();
            let root = c.root()?;
            self.save_observed(c, &control, source.clone(), remote.original_schema_version)?;
            let (bytes, generation, self_record, restore) = if adoption == Some(JoinMode::Restore) {
                let target = self.data().restore_target(&remote, &local, now_ms())?;
                (
                    snapshot::serialize_snapshot(&target).map_err(snapshot_error)?,
                    None,
                    None,
                    true,
                )
            } else {
                self.data
                    .merge_versioned(&remote.data, &c.group_id, remote.original_schema_version)
                    .map_err(|_| SyncError::Persistence)?;
                let (bytes, generation, record) = self.data().local_snapshot()?;
                (bytes, Some(generation), Some(record), false)
            };
            let payload = root
                .derive()
                .encrypt_managed(&c.group_id, control.epoch, &bytes)
                .map_err(|error| crypto_error(&error))?;
            let version = control
                .members
                .iter()
                .find(|m| m.member_id == c.member_id)
                .ok_or(SyncError::InvalidRemoteData)?
                .credential_version;
            let mut entry = journal(
                c.group_id.clone(),
                control.revision,
                control.epoch,
                Mutation::Snapshot {
                    credential_version: version,
                    key_id: control.key_id.clone(),
                },
                "snapshot",
            );
            entry.snapshot_schema = Some(3);
            entry.source_schema = remote.original_schema_version;
            entry.restore = restore;
            entry.legacy_source_id = source;
            entry.generation = generation;
            entry.self_record = self_record;
            self.save_vault(&vault).await?;
            let entry = self.prepare(entry, &payload)?;
            match self.commit_journal(&entry).await {
                Ok(_) => {
                    self.set_state(SyncState::Idle, None, None);
                    return self.refresh_managed_status().await;
                }
                Err(SyncError::Conflict) => {}
                Err(e) => return Err(e),
            }
        }
        Err(SyncError::Conflict)
    }
    pub async fn remove_device(&self, target: &str) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if let Some(entry) = self.journal()? {
            if !matches!(&entry.request.mutation,Mutation::Revoke{target:t,..} if t==target) {
                return Err(SyncError::PendingOperation);
            }
            self.commit_journal(&entry).await?;
            return self.refresh_managed_status().await;
        }
        let result = self.rotate_managed(Some(target), None).await;
        self.finish(&result);
        result?;
        self.refresh_managed_status().await
    }
    #[expect(
        clippy::too_many_lines,
        reason = "Build the complete atomic revoke or recovery request in one place"
    )]
    async fn rotate_managed(
        &self,
        target: Option<&str>,
        recovery: Option<(&str, i64, AdminRecoverySecret)>,
    ) -> Result<(), SyncError> {
        let mut vault = self.vault().await?;
        let recovering = recovery.is_some();
        let (mut c, secret) = if let Some((group, generation, secret)) = recovery {
            if self.config()?.is_some() {
                return Err(SyncError::AlreadyPaired);
            }
            let mut c = Credentials::new(group.into(), crypto::random_id());
            c.recovery_generation = generation;
            (c, Some(secret))
        } else {
            let current = vault.current.as_ref().ok_or(SyncError::Unpaired)?;
            let mut c = Credentials::new(current.group_id.clone(), current.member_id.clone());
            c.token = current.token;
            c.private_key = current.private_key;
            c.nonce = current.nonce;
            c.root = current.root;
            c.admin_secret = current.admin_secret;
            c.recovery_generation = current.recovery_generation;
            (c, None)
        };
        let (control, remote) = self.read_managed(&mut c, secret.as_ref()).await?;
        if !recovering && control.master_member_id != c.member_id {
            return Err(SyncError::MasterRequired);
        }
        if control.epoch == i64::MAX || control.recovery_generation == i64::MAX {
            return Err(SyncError::InvalidRemoteData);
        }
        self.require_managed_upgrade(&c.group_id, remote.original_schema_version)?;
        let mut rs = recipients(&control);
        let version = control
            .members
            .iter()
            .find(|m| m.member_id == control.master_member_id)
            .ok_or(SyncError::InvalidRemoteData)?
            .credential_version;
        let mutation;
        let target_snapshot = if recovering {
            c.member_id.clone_from(&control.master_member_id);
            let new = AdminRecoverySecret::generate();
            c.admin_secret = Some(*new.0);
            c.recovery_generation = control.recovery_generation + 1;
            let member = c.pairing(hex::encode(self.data.identity.id()))?;
            let registration = registration(&new, &c.group_id, c.recovery_generation)?;
            for r in &mut rs {
                if r.kind == "admin_recovery" {
                    r.version = registration.generation;
                    r.public_key.clone_from(&registration.public_key);
                } else if r.id == c.member_id {
                    r.version = version.checked_add(1).ok_or(SyncError::InvalidRemoteData)?;
                    r.public_key.clone_from(&member.wrapping_public_key);
                }
            }
            let local = self.data.snapshot().map_err(|_| SyncError::Persistence)?.0;
            let target = self.data().restore_target(&remote, &local, now_ms())?;
            let root = crate::sync_crypto::RootSecret::generate();
            c.root = *root.as_bytes();
            mutation = Mutation::Recovery {
                recovery_generation: control.recovery_generation,
                member,
                recovery: registration,
                key_id: root.derive().sync_id().into(),
                packages: packages(&c.group_id, control.epoch + 1, &rs, &root)?,
            };
            target
        } else {
            let target = target.ok_or(SyncError::InvalidRemoteData)?;
            if target == c.member_id
                || !control
                    .members
                    .iter()
                    .any(|m| m.member_id == target && m.status == "active")
            {
                return Err(SyncError::InvalidRemoteData);
            }
            rs.retain(|r| r.kind != "member" || r.id != target);
            self.data
                .merge_versioned(&remote.data, &c.group_id, remote.original_schema_version)
                .map_err(|_| SyncError::Persistence)?;
            let root = crate::sync_crypto::RootSecret::generate();
            c.root = *root.as_bytes();
            mutation = Mutation::Revoke {
                credential_version: version,
                target: target.into(),
                key_id: root.derive().sync_id().into(),
                packages: packages(&c.group_id, control.epoch + 1, &rs, &root)?,
            };
            self.data.snapshot().map_err(|_| SyncError::Persistence)?.0
        };
        let payload = c
            .root()?
            .derive()
            .encrypt_managed(
                &c.group_id,
                control.epoch + 1,
                &snapshot::serialize_snapshot(&target_snapshot).map_err(snapshot_error)?,
            )
            .map_err(|error| crypto_error(&error))?;
        let mut entry = journal(
            c.group_id.clone(),
            control.revision,
            control.epoch,
            mutation,
            if recovering {
                "recovery/commit"
            } else {
                "revoke"
            },
        );
        entry.promote = true;
        entry.snapshot_schema = Some(3);
        entry.source_schema = remote.original_schema_version;
        entry.restore = recovering;
        entry.confirmed = !recovering;
        entry.legacy_source_id = self
            .config()?
            .and_then(|p| p.managed.and_then(|m| m.legacy_source_id));
        if let Some(secret) = secret {
            vault.auth = Some(*secret.derive_credentials(&c.group_id).map_err(invalid)?.0);
        }
        vault.pending = Some(c);
        self.save_vault(&vault).await?;
        let entry = self.prepare(entry, &payload)?;
        if !recovering {
            self.commit_journal(&entry).await?;
        }
        Ok(())
    }
    pub async fn recover_admin(
        &self,
        code: &str,
        confirmed: bool,
    ) -> Result<CreateManagedSyncResult, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if let Some(mut entry) = self.journal()? {
            if !matches!(&entry.request.mutation, Mutation::Recovery { .. }) {
                return Err(SyncError::PendingOperation);
            }
            if !confirmed && !entry.confirmed {
                return self.managed_creation_result(true).await;
            }
            entry.confirmed = true;
            crate::persistence::save_json(&self.admin_path(), &Some(&entry))
                .map_err(|_| SyncError::Persistence)?;
            self.commit_journal(&entry).await?;
            return self.managed_creation_result(false).await;
        }
        if confirmed {
            return Err(SyncError::PendingOperation);
        }
        let (group, generation, secret) =
            AdminRecoverySecret::from_code(code).map_err(|_| SyncError::InvalidRecoveryKey)?;
        self.rotate_managed(None, Some((&group, generation, secret)))
            .await?;
        self.managed_creation_result(true).await
    }
    pub async fn dissolve_group(&self) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        let result = self.end_membership(true).await;
        self.finish(&result);
        result
    }
    pub(super) async fn end_membership(&self, dissolve: bool) -> Result<SyncStatus, SyncError> {
        if let Some(entry) = self.journal()? {
            if !matches!(
                (&entry.request.mutation, dissolve),
                (Mutation::Dissolve { .. }, true) | (Mutation::Leave { .. }, false)
            ) {
                return Err(SyncError::PendingOperation);
            }
            self.commit_journal(&entry).await?;
            return Ok(self.managed_status(None, &self.config()?.ok_or(SyncError::Unpaired)?));
        }
        let mut vault = self.vault().await?;
        let c = vault.current.as_mut().ok_or(SyncError::Unpaired)?;
        if !dissolve && c.admin_secret.is_some() {
            return Err(SyncError::MasterCannotLeave);
        }
        let read = self.read_managed(c, None).await;
        if !dissolve
            && matches!(
                &read,
                Err(SyncError::Offline
                    | SyncError::Timeout
                    | SyncError::Tls
                    | SyncError::ServerError
                    | SyncError::RateLimited)
            )
        {
            self.terminal(&SyncError::Left).await?;
            let mut config = self.config()?.ok_or(SyncError::Unpaired)?;
            config
                .managed
                .as_mut()
                .ok_or(SyncError::CorruptLocalState)?
                .left_locally = true;
            self.save(&config)?;
            let status = self.managed_status(None, &config);
            self.cache_managed_status(status.clone());
            return Ok(status);
        }
        let (control, _) = read?;
        if dissolve && control.master_member_id != c.member_id {
            return Err(SyncError::MasterRequired);
        }
        if !dissolve && control.master_member_id == c.member_id {
            return Err(SyncError::MasterCannotLeave);
        }
        let version = control
            .members
            .iter()
            .find(|m| m.member_id == c.member_id)
            .ok_or(SyncError::InvalidRemoteData)?
            .credential_version;
        let mutation = if dissolve {
            Mutation::Dissolve {
                credential_version: version,
            }
        } else {
            Mutation::Leave {
                credential_version: version,
            }
        };
        let entry = journal(
            c.group_id.clone(),
            control.revision,
            control.epoch,
            mutation,
            if dissolve { "dissolve" } else { "leave" },
        );
        self.save_vault(&vault).await?;
        let entry = self.prepare(entry, &[])?;
        self.commit_journal(&entry).await?;
        Ok(self.managed_status(None, &self.config()?.ok_or(SyncError::Unpaired)?))
    }
}
impl<S: SecretStore> SyncEngine<S> {
    pub(super) async fn admin_code(&self) -> Result<String, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if self.journal()?.is_some() {
            return Err(SyncError::PendingOperation);
        }
        let s = self.refresh_managed_status().await?;
        if s.control.master_member_id != s.control.this_member_id {
            return Err(SyncError::MasterRequired);
        }
        let vault = self.vault().await?;
        let c = vault.current.as_ref().ok_or(SyncError::Unpaired)?;
        let secret = AdminRecoverySecret(Zeroizing::new(
            c.admin_secret.ok_or(SyncError::MasterRequired)?,
        ));
        Ok(secret.code(&c.group_id, c.recovery_generation).to_string())
    }
}
impl<S: SecretStore> SyncEngine<S> {
    pub async fn cancel_admin_recovery(&self) -> Result<(), SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        let Some(entry) = self.journal()? else {
            return Ok(());
        };
        if entry.confirmed || !matches!(&entry.request.mutation, Mutation::Recovery { .. }) {
            return Err(SyncError::PendingOperation);
        }
        self.clear_journal(&entry)?;
        let mut vault = self.vault().await?;
        vault.pending = None;
        vault.auth = None;
        self.save_vault(&vault).await
    }
}
impl<S: SecretStore> SyncEngine<S> {
    async fn forget_terminal(&self) -> Result<(), SyncError> {
        if self
            .config()?
            .is_some_and(|c| c.managed.is_some_and(|m| m.terminal.is_some()))
        {
            if self.journal()?.is_some() {
                return Err(SyncError::PendingOperation);
            }
            self.secret.delete_v2().await?;
            for path in [
                self.path.with_extension("json.tmp"),
                self.path.with_extension("json.bak"),
                self.path.clone(),
            ] {
                match std::fs::remove_file(path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(SyncError::Persistence),
                }
            }
            #[cfg(unix)]
            crate::persistence::sync_parent(&self.path).map_err(|_| SyncError::Persistence)?;
        }
        Ok(())
    }
}
