//! Sync operations: create, join, codes, sync, removal, leave and end.
use super::helpers::{
    credential_version, crypto_error, invalid, invitation_recipient, journal, member_recipients,
    packages, snapshot_error,
};
use super::{
    engine::SyncEngine,
    errors::SyncError,
    state::{CreateSyncResult, JoinMode, SyncState, SyncStatus},
    vault::{Credentials, Journal},
};
use crate::{
    secure_storage::SecretStore,
    snapshot, sync_code,
    sync_membership_crypto::{self as crypto},
    sync_protocol::{valid_hex, AdministratorCodeLookup, Mutation, Recipient},
    time::now_ms,
};
use zeroize::Zeroizing;

impl<S: SecretStore> SyncEngine<S> {
    pub async fn create(&self) -> Result<CreateSyncResult, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        self.set_state(SyncState::Syncing, None, None);
        let result = self.create_inner().await;
        self.finish(&result);
        result
    }
    async fn create_inner(&self) -> Result<CreateSyncResult, SyncError> {
        if let Some(entry) = self.journal()? {
            if !matches!(&entry.request.mutation, Mutation::Create { .. }) {
                return Err(SyncError::PendingOperation);
            }
            self.commit_journal(&entry).await?;
            return self.created().await;
        }
        self.forget_terminal().await?;
        if self.config()?.is_some() {
            return Err(SyncError::AlreadyPaired);
        }
        let mut vault = self.vault().await?;
        if vault.current.is_some() {
            return Err(SyncError::AlreadyPaired);
        }
        let group = hex::encode(crypto::random_secret());
        let mut c = Credentials::new(group.clone());
        c.admin = true;
        let member = c.registration(hex::encode(self.data.identity.id()))?;
        let recipients = vec![Recipient {
            kind: "member".into(),
            id: member.member_id.clone(),
            version: 1,
            public_key: member.wrapping_public_key.clone(),
        }];
        let (snapshot, generation, self_record) = self.data().local_snapshot()?;
        let root = c.root()?;
        let payload = root
            .derive()
            .encrypt_snapshot(&group, 1, &snapshot)
            .map_err(|error| crypto_error(&error))?;
        let mutation = Mutation::Create {
            member,
            key_id: root.derive().key_id().into(),
            packages: packages(&group, 1, &recipients, &root)?,
        };
        vault.pending = Some(c);
        self.save_vault(&vault).await?;
        let mut entry = journal(group, 0, 0, mutation, "create");
        entry.promote = true;
        entry.generation = Some(generation);
        entry.self_record = Some(self_record);
        let entry = self.prepare(entry, &payload)?;
        self.commit_journal(&entry).await?;
        self.created().await
    }
    /// The group exists. Registering its first code is a second request; if that fails the
    /// administrator can ask for a new code.
    async fn created(&self) -> Result<CreateSyncResult, SyncError> {
        let code = self.mint_code().await.ok().map(|code| code.to_string());
        let status = self
            .refresh_or_local()
            .await
            .unwrap_or_else(|_| self.status_snapshot());
        Ok(CreateSyncResult { code, status })
    }
    /// Registers a fresh code, replacing the previous one. The new code is kept only once the
    /// server accepted it, so the code shown always works.
    async fn mint_code(&self) -> Result<Zeroizing<String>, SyncError> {
        for _ in 0..super::cas::MAX_CAS_ATTEMPTS {
            let mut vault = self.vault().await?;
            let c = vault.current.as_mut().ok_or(SyncError::Unpaired)?;
            if !c.admin {
                return Err(SyncError::AdministratorRequired);
            }
            let (control, _) = self.read_group(c).await?;
            if control.master_member_id != c.member_id {
                return Err(SyncError::AdministratorRequired);
            }
            let seed = Zeroizing::new(crypto::random_secret());
            let join = crypto::join_credentials(&seed).map_err(invalid)?;
            let package = crypto::seal_root(
                &c.group_id,
                control.epoch,
                &invitation_recipient(&join),
                &c.root()?,
            )
            .map_err(invalid)?;
            let mutation = Mutation::Invitation {
                credential_version: credential_version(&control, &c.member_id)?,
                invitation_id: join.id.clone(),
                invitation_verifier: crypto::verifier(&join.secret),
                invitation_public_key: join.public_key.clone(),
                package,
            };
            let mut entry = journal(
                c.group_id.clone(),
                control.revision,
                control.epoch,
                mutation,
                "invitation",
            );
            // The new seed becomes the stored code only once the server accepts it.
            entry.promote = true;
            let mut pending = c.clone();
            pending.join_seed = Some(*seed);
            vault.pending = Some(pending);
            self.save_vault(&vault).await?;
            let entry = self.prepare(entry, &[])?;
            match self.commit_journal(&entry).await {
                Ok(_) => return sync_code::encode(&seed).map_err(Into::into),
                Err(SyncError::Conflict) => {}
                Err(e) => return Err(e),
            }
        }
        Err(SyncError::Conflict)
    }
    async fn finish_invitation(&self) -> Result<bool, SyncError> {
        match self.journal()? {
            None => Ok(false),
            Some(entry) if matches!(&entry.request.mutation, Mutation::Invitation { .. }) => {
                self.commit_journal(&entry).await?;
                Ok(true)
            }
            Some(_) => Err(SyncError::PendingOperation),
        }
    }
    /// Administrator: replaces the code. Everyone who has not joined yet needs the new one.
    pub async fn new_code(&self) -> Result<String, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        let result = async {
            if self.finish_invitation().await? {
                return self.stored_code().await;
            }
            self.mint_code().await.map(|code| code.to_string())
        }
        .await;
        self.finish(&result);
        result
    }
    /// Administrator: shows the current code again.
    pub async fn show_code(&self) -> Result<String, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        self.finish_invitation().await?;
        self.stored_code().await
    }
    async fn stored_code(&self) -> Result<String, SyncError> {
        let vault = self.vault().await?;
        let c = vault.current.as_ref().ok_or(SyncError::Unpaired)?;
        if !c.admin {
            return Err(SyncError::AdministratorRequired);
        }
        let seed = c.join_seed.ok_or(SyncError::NoCode)?;
        Ok(sync_code::encode(&seed)?.to_string())
    }

    pub async fn join(&self, code: &str, mode: JoinMode) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if let Some(mut entry) = self.journal()? {
            if !matches!(&entry.request.mutation, Mutation::Join { .. }) {
                return Err(SyncError::PendingOperation);
            }
            // The earlier join continues, but with the mode chosen now.
            if entry.join_mode != Some(mode) {
                entry.join_mode = Some(mode);
                self.rewrite_journal(&entry)?;
            }
            self.resume().await?;
            return self.sync_inner().await;
        }
        self.forget_terminal().await?;
        if let Some(mut config) = self.config()? {
            if config.adoption.is_some() {
                if config.adoption != Some(mode) {
                    config.adoption = Some(mode);
                    self.save(&config)?;
                }
                return self.sync_inner().await;
            }
            return Err(SyncError::AlreadyPaired);
        }
        let seed = sync_code::decode(code)?;
        self.set_state(SyncState::Syncing, None, None);
        let result = self.join_inner(&seed, mode).await;
        self.finish(&result);
        result
    }
    async fn join_inner(
        &self,
        seed: &Zeroizing<[u8; 32]>,
        mode: JoinMode,
    ) -> Result<SyncStatus, SyncError> {
        for attempt in 0..super::cas::MAX_CAS_ATTEMPTS {
            let entry = self.prepare_join(seed, mode).await?;
            match self.commit_journal(&entry).await {
                Ok(_) => return self.sync_inner().await,
                // Someone else changed the group between the lookup and the join; look again.
                Err(SyncError::Conflict) if attempt + 1 < super::cas::MAX_CAS_ATTEMPTS => {}
                Err(e) => return Err(e),
            }
        }
        Err(SyncError::Conflict)
    }
    /// Looks the code up, opens the group key it carries, and durably records the exact join
    /// request together with this device's new credentials before anything is sent.
    pub(super) async fn prepare_join(
        &self,
        seed: &Zeroizing<[u8; 32]>,
        mode: JoinMode,
    ) -> Result<Journal, SyncError> {
        let join = crypto::join_credentials(seed).map_err(invalid)?;
        let bytes = match self
            .transport()?
            .invitation(&join.id, &crypto::token(&join.secret))
            .await
        {
            Ok(bytes) => bytes,
            Err(crate::sync_transport::TransportError::NotFound) => {
                return Err(SyncError::CodeRejected)
            }
            Err(error) => return Err(error.into()),
        };
        let lookup: AdministratorCodeLookup = serde_json::from_slice(&bytes).map_err(invalid)?;
        if !valid_hex(&lookup.group_id, 32)
            || !valid_hex(&lookup.key_id, 32)
            || lookup.epoch < 1
            || lookup.revision < 1
        {
            return Err(SyncError::InvalidRemoteData);
        }
        let root = crypto::open_root(
            &lookup.group_id,
            lookup.epoch,
            &lookup.key_id,
            &invitation_recipient(&join),
            &join.private_key,
            &lookup.package,
        )
        .map_err(invalid)?;
        let mut c = Credentials::new(lookup.group_id.clone());
        c.root = *root.as_bytes();
        c.join_seed = Some(**seed);
        let member = c.registration(hex::encode(self.data.identity.id()))?;
        let own = Recipient {
            kind: "member".into(),
            id: member.member_id.clone(),
            version: 1,
            public_key: member.wrapping_public_key.clone(),
        };
        let package =
            crypto::seal_root(&lookup.group_id, lookup.epoch, &own, &root).map_err(invalid)?;
        let mut entry = journal(
            lookup.group_id.clone(),
            lookup.revision,
            lookup.epoch,
            Mutation::Join {
                invitation_id: join.id.clone(),
                invitation_verifier: crypto::verifier(&join.secret),
                member,
                package,
            },
            "join",
        );
        entry.promote = true;
        entry.join_mode = Some(mode);
        let mut vault = self.vault().await?;
        vault.pending = Some(c);
        self.save_vault(&vault).await?;
        self.prepare(entry, &[])
    }

    pub(super) async fn sync_inner(&self) -> Result<SyncStatus, SyncError> {
        self.resume().await?;
        for _ in 0..super::cas::MAX_CAS_ATTEMPTS {
            let config = self.config()?.ok_or(SyncError::Unpaired)?;
            if config.terminal.is_some() {
                return Ok(self.group_status(None, &config, false));
            }
            let mut vault = self.vault().await?;
            let c = vault.current.as_mut().ok_or(SyncError::CorruptLocalState)?;
            let (control, remote) = self.read_group(c).await?;
            let root = c.root()?;
            self.save_observed(c, &control)?;
            let (bytes, generation, self_record, restore) =
                if config.adoption == Some(JoinMode::Restore) {
                    let target = self.data().restore_target(&remote, now_ms())?;
                    (
                        snapshot::serialize_snapshot(&target).map_err(snapshot_error)?,
                        None,
                        None,
                        true,
                    )
                } else {
                    self.data
                        .merge(&remote)
                        .map_err(|_| SyncError::Persistence)?;
                    let (bytes, generation, record) = self.data().local_snapshot()?;
                    (bytes, Some(generation), Some(record), false)
                };
            let payload = root
                .derive()
                .encrypt_snapshot(&c.group_id, control.epoch, &bytes)
                .map_err(|error| crypto_error(&error))?;
            let mut entry = journal(
                c.group_id.clone(),
                control.revision,
                control.epoch,
                Mutation::Snapshot {
                    credential_version: credential_version(&control, &c.member_id)?,
                    key_id: control.key_id.clone(),
                },
                "snapshot",
            );
            entry.restore = restore;
            entry.generation = generation;
            entry.self_record = self_record;
            self.save_vault(&vault).await?;
            let entry = self.prepare(entry, &payload)?;
            match self.commit_journal(&entry).await {
                Ok(_) => {
                    self.set_state(SyncState::Idle, None, None);
                    return self.refresh_status().await;
                }
                Err(SyncError::Conflict) => {}
                Err(e) => return Err(e),
            }
        }
        Err(SyncError::Conflict)
    }

    /// Administrator: removes a device. The group key changes, which ends the current code, so a
    /// new one is registered right away.
    pub async fn remove_device(&self, target: &str) -> Result<SyncStatus, SyncError> {
        let _guard = self
            .operation
            .try_lock()
            .map_err(|_| SyncError::AlreadySyncing)?;
        if let Some(entry) = self.journal()? {
            if !matches!(&entry.request.mutation, Mutation::Revoke { target: t, .. } if t == target)
            {
                return Err(SyncError::PendingOperation);
            }
            self.commit_journal(&entry).await?;
        } else {
            let result = self.revoke(target).await;
            self.finish(&result);
            result?;
        }
        let _ = self.mint_code().await;
        self.refresh_or_local().await
    }
    async fn revoke(&self, target: &str) -> Result<(), SyncError> {
        let mut vault = self.vault().await?;
        let mut c = vault.current.clone().ok_or(SyncError::Unpaired)?;
        let (control, remote) = self.read_group(&mut c).await?;
        if control.master_member_id != c.member_id {
            return Err(SyncError::AdministratorRequired);
        }
        if control.epoch == i64::MAX
            || target == c.member_id
            || !control
                .members
                .iter()
                .any(|m| m.member_id == target && m.status == "active")
        {
            return Err(SyncError::InvalidRemoteData);
        }
        let mut recipients = member_recipients(&control);
        recipients.retain(|r| r.id != target);
        self.data
            .merge(&remote)
            .map_err(|_| SyncError::Persistence)?;
        let root = crate::sync_crypto::RootSecret::generate();
        c.root = *root.as_bytes();
        c.join_seed = None;
        let mutation = Mutation::Revoke {
            credential_version: credential_version(&control, &c.member_id)?,
            target: target.into(),
            key_id: root.derive().key_id().into(),
            packages: packages(&c.group_id, control.epoch + 1, &recipients, &root)?,
        };
        let snapshot = self.data.snapshot().map_err(|_| SyncError::Persistence)?.0;
        let payload = root
            .derive()
            .encrypt_snapshot(
                &c.group_id,
                control.epoch + 1,
                &snapshot::serialize_snapshot(&snapshot).map_err(snapshot_error)?,
            )
            .map_err(|error| crypto_error(&error))?;
        let mut entry = journal(
            c.group_id.clone(),
            control.revision,
            control.epoch,
            mutation,
            "revoke",
        );
        entry.promote = true;
        vault.pending = Some(c);
        self.save_vault(&vault).await?;
        let entry = self.prepare(entry, &payload)?;
        self.commit_journal(&entry).await?;
        Ok(())
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
            return Ok(self.group_status(None, &self.config()?.ok_or(SyncError::Unpaired)?, false));
        }
        let mut vault = self.vault().await?;
        let c = vault.current.as_mut().ok_or(SyncError::Unpaired)?;
        if !dissolve && c.admin {
            return Err(SyncError::AdministratorCannotLeave);
        }
        let read = self.read_group(c).await;
        if !dissolve
            && matches!(
                &read,
                Err(SyncError::Offline | SyncError::Timeout | SyncError::Tls)
            )
        {
            self.terminal(&SyncError::Left).await?;
            let mut config = self.config()?.ok_or(SyncError::Unpaired)?;
            config.left_locally = true;
            self.save(&config)?;
            let status = self.group_status(None, &config, false);
            self.cache_status(status.clone());
            return Ok(status);
        }
        let (control, _) = read?;
        if dissolve && control.master_member_id != c.member_id {
            return Err(SyncError::AdministratorRequired);
        }
        if !dissolve && control.master_member_id == c.member_id {
            return Err(SyncError::AdministratorCannotLeave);
        }
        let version = credential_version(&control, &c.member_id)?;
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
        Ok(self.group_status(None, &self.config()?.ok_or(SyncError::Unpaired)?, false))
    }

    /// Forgets a Sync this device was removed from, closed or left, so a new one can start.
    pub(super) async fn forget_terminal(&self) -> Result<(), SyncError> {
        if self.config()?.is_some_and(|c| c.terminal.is_some()) {
            if self.journal()?.is_some() {
                return Err(SyncError::PendingOperation);
            }
            self.reset_local().await?;
        }
        Ok(())
    }
    /// Removes everything this device holds for Sync: credentials, config and journal.
    pub(super) async fn reset_local(&self) -> Result<(), SyncError> {
        self.secret.delete().await?;
        self.remove_journal_files()?;
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
        Ok(())
    }
}
