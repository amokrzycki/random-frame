//! Root secret only. All keyring calls run off the UI thread.

use crate::sync_crypto::RootSecret;
use std::fmt;
use zeroize::Zeroizing;

const SERVICE: &str = "dev.randomframe.desktop.sync.v1";
const USER: &str = "root-secret";

pub struct SecureStorage {
    service: String,
    user: String,
}

impl Default for SecureStorage {
    fn default() -> Self {
        Self {
            service: SERVICE.into(),
            user: USER.into(),
        }
    }
}

impl SecureStorage {
    pub async fn store(&self, root: RootSecret) -> Result<(), StorageError> {
        let service = self.service.clone();
        let user = self.user.clone();
        tauri::async_runtime::spawn_blocking(move || {
            entry(&service, &user)?
                .set_secret(root.as_bytes())
                .map_err(|error| map_error(&error))
        })
        .await
        .map_err(|_| StorageError::Unavailable)?
    }

    pub async fn load(&self) -> Result<RootSecret, StorageError> {
        let service = self.service.clone();
        let user = self.user.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = Zeroizing::new(
                entry(&service, &user)?
                    .get_secret()
                    .map_err(|error| map_error(&error))?,
            );
            RootSecret::from_bytes(&bytes).map_err(|_| StorageError::Corrupt)
        })
        .await
        .map_err(|_| StorageError::Unavailable)?
    }

    pub async fn delete(&self) -> Result<(), StorageError> {
        let service = self.service.clone();
        let user = self.user.clone();
        tauri::async_runtime::spawn_blocking(move || {
            match entry(&service, &user)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(map_error(&error)),
            }
        })
        .await
        .map_err(|_| StorageError::Unavailable)?
    }
}

pub trait SecretStore: Send + Sync {
    fn store(
        &self,
        root: RootSecret,
    ) -> impl std::future::Future<Output = Result<(), StorageError>> + Send;
    fn load(&self) -> impl std::future::Future<Output = Result<RootSecret, StorageError>> + Send;
    fn delete(&self) -> impl std::future::Future<Output = Result<(), StorageError>> + Send;
}

impl SecretStore for SecureStorage {
    async fn store(&self, root: RootSecret) -> Result<(), StorageError> {
        self.store(root).await
    }
    async fn load(&self) -> Result<RootSecret, StorageError> {
        self.load().await
    }
    async fn delete(&self) -> Result<(), StorageError> {
        self.delete().await
    }
}

fn entry(service: &str, user: &str) -> Result<keyring::Entry, StorageError> {
    keyring::Entry::new(service, user).map_err(|error| map_error(&error))
}

fn map_error(error: &keyring::Error) -> StorageError {
    match error {
        keyring::Error::NoEntry => StorageError::Missing,
        keyring::Error::PlatformFailure(_) => StorageError::Unavailable,
        _ => StorageError::AccessDenied,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StorageError {
    Missing,
    Unavailable,
    AccessDenied,
    Corrupt,
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Missing => "No stored sync secret",
            Self::Unavailable => "Secure storage is unavailable",
            Self::AccessDenied => "Secure storage access was denied",
            Self::Corrupt => "Stored sync secret is invalid",
        })
    }
}

impl std::error::Error for StorageError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_unavailable_are_distinct_safe_errors() {
        assert_eq!(map_error(&keyring::Error::NoEntry), StorageError::Missing);
        let unavailable = keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
            "private backend detail",
        )));
        assert_eq!(map_error(&unavailable), StorageError::Unavailable);
        assert!(!StorageError::Unavailable
            .to_string()
            .contains("private backend detail"));
    }

    #[tokio::test]
    #[ignore = "requires an unlocked desktop keyring and writes an isolated test credential"]
    async fn desktop_keyring_roundtrip() -> Result<(), StorageError> {
        let storage = SecureStorage {
            service: format!("{SERVICE}.test.{}", std::process::id()),
            user: USER.into(),
        };
        storage.delete().await?;
        assert_eq!(storage.load().await.err(), Some(StorageError::Missing));
        let first = RootSecret::generate();
        let first_id = first.derive().sync_id().to_owned();
        storage.store(first).await?;
        assert_eq!(storage.load().await?.derive().sync_id(), first_id);
        let second = RootSecret::generate();
        let second_id = second.derive().sync_id().to_owned();
        storage.store(second).await?;
        assert_eq!(storage.load().await?.derive().sync_id(), second_id);
        storage.delete().await?;
        assert_eq!(storage.load().await.err(), Some(StorageError::Missing));
        Ok(())
    }
}
