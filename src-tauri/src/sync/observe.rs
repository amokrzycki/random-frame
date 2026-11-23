//! Reading the group: authenticated control, status and terminal states.
use super::helpers::{credential_version, invalid};
use super::{
    engine::SyncEngine,
    errors::SyncError,
    state::{DeviceSummary, MembershipStatus, SyncLocalConfig, SyncState, SyncStatus},
    vault::Credentials,
};
use crate::{
    secure_storage::SecretStore,
    snapshot,
    sync_membership_crypto::{self as crypto},
    sync_protocol::{decode, valid_hex, Control, OperationResult, Recipient, PROTOCOL_VERSION},
    time::now_ms,
};
use reqwest::Method;

impl<S: SecretStore> SyncEngine<S> {
    pub(super) async fn call(
        &self,
        group: &str,
        route: &str,
        method: Method,
        token: &[u8; 32],
        invitation: Option<&[u8; 32]>,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, SyncError> {
        let invitation = invitation.map(crypto::token);
        self.transport()?
            .group(
                group,
                route,
                method,
                &crypto::token(token),
                invitation.as_deref().map(String::as_str),
                body,
            )
            .await
            .map_err(Into::into)
    }
    pub(super) fn group_status(
        &self,
        c: Option<&Control>,
        config: &SyncLocalConfig,
        code_ready: bool,
    ) -> SyncStatus {
        let mut s = self.status_snapshot();
        s.paired = config.terminal.is_none();
        s.control = MembershipStatus {
            group_state: Some(
                if config.terminal.as_deref() == Some("closed") {
                    "closed"
                } else {
                    "active"
                }
                .into(),
            ),
            membership_state: Some(if config.left_locally {
                "left_locally".into()
            } else {
                config.terminal.clone().unwrap_or_else(|| "active".into())
            }),
            master_member_id: c.map(|c| c.master_member_id.clone()),
            this_member_id: Some(config.member_id.clone()),
            credential_version: Some(config.credential_version),
            key_epoch: Some(config.epoch),
            control_verified_at: c.map(|_| now_ms()),
            code_ready,
        };
        s.devices = if let Some(c) = c {
            let roster = self.data.preferences.sync_state().1;
            c.members
                .iter()
                .map(|member| {
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
                        this_device: member.member_id == config.member_id,
                        member_id: Some(member.member_id.clone()),
                        status: Some(member.status.clone()),
                        is_master: member.member_id == c.master_member_id,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        if let Some(reason) = &config.terminal {
            s.state = SyncState::Error;
            s.last_error_category = Some(if config.left_locally {
                "left_locally".into()
            } else {
                reason.clone()
            });
        }
        s
    }
    pub(super) fn cache_status(&self, s: SyncStatus) {
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
            config.terminal = Some(reason.into());
            self.save(&config)?;
            self.cache_status(self.group_status(None, &config, false));
        }
        if let Some(entry) = self.journal()? {
            self.clear_journal(&entry)?;
        }
        // Terminal metadata is committed first; even denied keyring cleanup cannot enable sync.
        let _ = self.secret.delete().await;
        self.notify_state_changed();
        Ok(())
    }
    pub(super) async fn read_group(
        &self,
        c: &mut Credentials,
    ) -> Result<(Control, snapshot::SyncSnapshot), SyncError> {
        let bytes = match self
            .call(&c.group_id, "snapshot", Method::GET, &c.token, None, None)
            .await
        {
            Ok(b) => b,
            Err(e) => {
                self.terminal(&e).await?;
                return Err(e);
            }
        };
        let (control, payload): (Control, &[u8]) = decode(&bytes).map_err(invalid)?;
        if control.protocol_version != PROTOCOL_VERSION
            || control.group_id != c.group_id
            || control.state != "active"
            || control.revision < 1
            || control.epoch < 1
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
            || control.this_member_id.as_deref() != Some(&c.member_id)
        {
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
        let recipient = Recipient {
            kind: "member".into(),
            id: member.member_id.clone(),
            version: member.credential_version,
            public_key: member.wrapping_public_key.clone(),
        };
        if let Some(config) = self.config()?.filter(|p| p.group_id == c.group_id) {
            super::cas::check_rollback(&config, control.revision)?;
            if config.terminal.is_some() {
                return Err(SyncError::Unpaired);
            }
            if control.epoch > config.epoch {
                self.set_state(SyncState::UpdatingKey, None, None);
                self.notify_state_changed();
            }
            if control.epoch < config.epoch || recipient.version < config.credential_version {
                return Err(SyncError::InvalidRemoteData);
            }
        }
        let root = crypto::open_root(
            &control.group_id,
            control.epoch,
            &control.key_id,
            &recipient,
            &c.private_key,
            &control.key_package,
        )
        .map_err(invalid)?;
        let plaintext = root
            .derive()
            .decrypt_snapshot(&control.group_id, control.epoch, payload)
            .map_err(invalid)?;
        let remote =
            snapshot::parse_snapshot(&plaintext).map_err(super::helpers::snapshot_error)?;
        c.root = *root.as_bytes();
        Ok((control, remote))
    }
    pub(super) fn save_observed(
        &self,
        c: &Credentials,
        control: &Control,
    ) -> Result<(), SyncError> {
        let result = OperationResult {
            operation_id: String::new(),
            revision: control.revision,
            epoch: control.epoch,
        };
        let mut config = self.config_after(c, &result)?;
        config.credential_version = credential_version(control, &c.member_id)?;
        self.save(&config)?;
        self.cache_status(self.group_status(
            Some(control),
            &config,
            c.admin && c.join_seed.is_some(),
        ));
        Ok(())
    }
    /// What this device knows without asking the server.
    pub(super) async fn local_status(&self) -> Result<SyncStatus, SyncError> {
        let config = self.config()?.ok_or(SyncError::Unpaired)?;
        let code_ready = match self.vault().await {
            Ok(vault) => vault
                .current
                .as_ref()
                .is_some_and(|c| c.admin && c.join_seed.is_some()),
            Err(_) => false,
        };
        Ok(self.group_status(None, &config, code_ready))
    }
    /// The server's view when reachable, otherwise this device's own.
    pub(super) async fn refresh_or_local(&self) -> Result<SyncStatus, SyncError> {
        match self.refresh_status().await {
            Err(error) if error.is_transient() => {
                self.set_state(SyncState::Offline, Some(&error), None);
                self.local_status().await
            }
            other => other,
        }
    }
    pub(super) async fn refresh_status(&self) -> Result<SyncStatus, SyncError> {
        let config = self.config()?.ok_or(SyncError::Unpaired)?;
        if config.terminal.is_some() {
            return Ok(self.group_status(None, &config, false));
        }
        let mut vault = self.vault().await?;
        let c = vault.current.as_mut().ok_or(SyncError::CorruptLocalState)?;
        if c.group_id != config.group_id || c.member_id != config.member_id {
            return Err(SyncError::CorruptLocalState);
        }
        let (control, _) = self.read_group(c).await?;
        self.save_observed(c, &control)?;
        let code_ready = c.admin && c.join_seed.is_some();
        self.save_vault(&vault).await?;
        if matches!(self.status_snapshot().state, SyncState::UpdatingKey) {
            self.set_state(SyncState::Idle, None, None);
        }
        Ok(self.group_status(
            Some(&control),
            &self.config()?.ok_or(SyncError::Unpaired)?,
            code_ready,
        ))
    }
}
