use crate::{secure_storage::StorageError, sync_transport::TransportError};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "category", content = "details", rename_all = "snake_case")]
pub enum SyncError {
    InvalidEndpoint,
    InvalidRecoveryKey,
    AlreadyPaired,
    Unpaired,
    AlreadySyncing,
    CorruptLocalState,
    SecureStorage,
    Persistence,
    InvalidRemoteData,
    Offline,
    Timeout,
    Tls,
    MalformedResponse,
    MissingChain,
    Conflict,
    RateLimited,
    ServerError,
    BodyTooLarge,
    ServerRollbackDetected {
        local_revision: i64,
        remote_revision: i64,
    },
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
            TransportError::InvalidEndpoint => Self::InvalidEndpoint,
            TransportError::Offline => Self::Offline,
            TransportError::Timeout => Self::Timeout,
            TransportError::Tls => Self::Tls,
            TransportError::MissingChain => Self::MissingChain,
            TransportError::Conflict => Self::Conflict,
            TransportError::RateLimited => Self::RateLimited,
            TransportError::ServerError => Self::ServerError,
            TransportError::BodyTooLarge => Self::BodyTooLarge,
            TransportError::MalformedResponse
            | TransportError::InvalidEtag
            | TransportError::UnexpectedStatus(_)
            | TransportError::InvalidIdentity => Self::MalformedResponse,
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
    pub(super) fn category(&self) -> &'static str {
        match self {
            Self::ServerRollbackDetected { .. } => "rollback_detected",
            Self::InvalidEndpoint => "invalid_endpoint",
            Self::InvalidRecoveryKey => "invalid_recovery_key",
            Self::AlreadyPaired => "already_paired",
            Self::Unpaired => "unpaired",
            Self::AlreadySyncing => "already_syncing",
            Self::CorruptLocalState => "corrupt_local_state",
            Self::SecureStorage => "secure_storage",
            Self::Persistence => "persistence",
            Self::InvalidRemoteData => "invalid_remote_data",
            Self::Offline => "offline",
            Self::Timeout => "timeout",
            Self::Tls => "tls",
            Self::MalformedResponse => "malformed_response",
            Self::MissingChain => "missing_chain",
            Self::Conflict => "conflict",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::BodyTooLarge => "body_too_large",
        }
    }
}
