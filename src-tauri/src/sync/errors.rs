use crate::{secure_storage::StorageError, sync_transport::TransportError};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "category", content = "details", rename_all = "snake_case")]
pub enum SyncError {
    Revoked,
    Left,
    Closed,
    CredentialReplaced,
    MasterRequired,
    MasterCannotLeave,
    OperationMismatch,
    NoCode,
    PendingOperation,
    InvalidEndpoint,
    CodeLength,
    CodeWord(usize),
    CodeTypo,
    CodeRejected,
    AlreadyPaired,
    Unpaired,
    AlreadySyncing,
    #[serde(rename = "migration_pending")]
    LocalMigrationPending,
    CorruptLocalState,
    SecureStorage,
    Persistence,
    InvalidRemoteData,
    Offline,
    Timeout,
    Tls,
    MalformedResponse,
    NotFound,
    Conflict,
    RateLimited,
    ServerError,
    BodyTooLarge,
    ServerRollbackDetected {
        local_revision: i64,
        remote_revision: i64,
    },
    UnsupportedPlatform,
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.category())
    }
}

impl std::error::Error for SyncError {}

impl From<TransportError> for SyncError {
    fn from(error: TransportError) -> Self {
        match error {
            TransportError::Revoked => Self::Revoked,
            TransportError::Left => Self::Left,
            TransportError::Closed => Self::Closed,
            TransportError::CredentialReplaced => Self::CredentialReplaced,
            TransportError::MasterRequired => Self::MasterRequired,
            TransportError::MasterCannotLeave => Self::MasterCannotLeave,
            TransportError::OperationMismatch => Self::OperationMismatch,
            TransportError::InvalidEndpoint => Self::InvalidEndpoint,
            TransportError::Offline => Self::Offline,
            TransportError::Timeout => Self::Timeout,
            TransportError::Tls => Self::Tls,
            TransportError::NotFound => Self::NotFound,
            TransportError::Conflict => Self::Conflict,
            TransportError::RateLimited => Self::RateLimited,
            TransportError::ServerError => Self::ServerError,
            TransportError::BodyTooLarge => Self::BodyTooLarge,
            TransportError::MalformedResponse
            | TransportError::UnexpectedStatus(_)
            | TransportError::InvalidIdentity => Self::MalformedResponse,
        }
    }
}

impl From<crate::sync_code::CodeError> for SyncError {
    fn from(error: crate::sync_code::CodeError) -> Self {
        match error {
            crate::sync_code::CodeError::WordCount => Self::CodeLength,
            crate::sync_code::CodeError::UnknownWord(position) => Self::CodeWord(position),
            crate::sync_code::CodeError::Checksum => Self::CodeTypo,
        }
    }
}

impl From<StorageError> for SyncError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Missing | StorageError::Corrupt => Self::CorruptLocalState,
            StorageError::Unavailable | StorageError::AccessDenied => Self::SecureStorage,
        }
    }
}

impl SyncError {
    /// The server or network is momentarily unreachable; the same request can succeed later.
    pub(super) fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Offline | Self::Timeout | Self::Tls | Self::RateLimited | Self::ServerError
        )
    }
    pub(super) fn category(&self) -> &'static str {
        match self {
            Self::Revoked => "revoked",
            Self::Left => "left",
            Self::Closed => "closed",
            Self::CredentialReplaced => "credential_replaced",
            Self::MasterRequired => "master_required",
            Self::MasterCannotLeave => "master_cannot_leave",
            Self::OperationMismatch => "operation_mismatch",
            Self::NoCode => "no_code",
            Self::PendingOperation => "pending_operation",
            Self::ServerRollbackDetected { .. } => "rollback_detected",
            Self::InvalidEndpoint => "invalid_endpoint",
            Self::CodeLength => "code_length",
            Self::CodeWord(_) => "code_word",
            Self::CodeTypo => "code_typo",
            Self::CodeRejected => "code_rejected",
            Self::AlreadyPaired => "already_paired",
            Self::Unpaired => "unpaired",
            Self::LocalMigrationPending => "migration_pending",
            Self::AlreadySyncing => "already_syncing",
            Self::CorruptLocalState => "corrupt_local_state",
            Self::SecureStorage => "secure_storage",
            Self::Persistence => "persistence",
            Self::InvalidRemoteData => "invalid_remote_data",
            Self::Offline => "offline",
            Self::Timeout => "timeout",
            Self::Tls => "tls",
            Self::MalformedResponse => "malformed_response",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::BodyTooLarge => "body_too_large",
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}
