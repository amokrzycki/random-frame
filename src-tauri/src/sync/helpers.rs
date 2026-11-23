//! Small pure helpers shared by the Sync operations.
use super::{errors::SyncError, vault::Journal};
use crate::{
    snapshot,
    sync_membership_crypto::{self as crypto, JoinCredentials},
    sync_protocol::{Control, EpochKeyPackage, Mutation, Recipient, Request},
};

pub(super) fn invalid<T>(_: T) -> SyncError {
    SyncError::InvalidRemoteData
}
pub(super) fn crypto_error(error: &crate::sync_crypto::CryptoError) -> SyncError {
    match error {
        crate::sync_crypto::CryptoError::BodyTooLarge => SyncError::BodyTooLarge,
        crate::sync_crypto::CryptoError::UnsupportedVersion => SyncError::UnsupportedVersion,
        _ => SyncError::InvalidRemoteData,
    }
}
pub(super) fn snapshot_error(error: snapshot::SnapshotError) -> SyncError {
    match error {
        snapshot::SnapshotError::PayloadTooLarge => SyncError::BodyTooLarge,
        snapshot::SnapshotError::UnsupportedVersion => SyncError::UnsupportedVersion,
        _ => SyncError::InvalidRemoteData,
    }
}
pub(super) fn member_recipients(c: &Control) -> Vec<Recipient> {
    c.members
        .iter()
        .filter(|m| m.status == "active")
        .map(|m| Recipient {
            kind: "member".into(),
            id: m.member_id.clone(),
            version: m.credential_version,
            public_key: m.wrapping_public_key.clone(),
        })
        .collect()
}
pub(super) fn packages(
    group: &str,
    epoch: i64,
    rs: &[Recipient],
    root: &crate::sync_crypto::RootSecret,
) -> Result<Vec<EpochKeyPackage>, SyncError> {
    rs.iter()
        .map(|r| crypto::seal_root(group, epoch, r, root).map_err(invalid))
        .collect()
}
pub(super) fn journal(
    group: String,
    revision: i64,
    epoch: i64,
    mutation: Mutation,
    route: &str,
) -> Journal {
    Journal {
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
        join_mode: None,
        generation: None,
        self_record: None,
    }
}
pub(super) fn invitation_recipient(join: &JoinCredentials) -> Recipient {
    Recipient {
        kind: "invitation".into(),
        id: join.id.clone(),
        version: 1,
        public_key: join.public_key.clone(),
    }
}
pub(super) fn credential_version(control: &Control, member: &str) -> Result<i64, SyncError> {
    control
        .members
        .iter()
        .find(|m| m.member_id == member)
        .map(|m| m.credential_version)
        .ok_or(SyncError::InvalidRemoteData)
}
