//! Root secret only. All keyring calls run off the UI thread.
//!
//! Desktop uses the OS keyring. Android keeps the secret in a private `SharedPreferences` file,
//! encrypted with an AES-GCM key that never leaves Android Keystore.

use crate::sync_crypto::RootSecret;
#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error as KeyringError};
#[cfg(target_os = "android")]
use keyring_core::{Entry, Error as KeyringError};
use std::fmt;
use zeroize::Zeroizing;

const SERVICE: &str = "dev.randomframe.desktop.sync.v1";
const USER: &str = "root-secret";
/// Backed by `shared_prefs/keyring-random-frame-sync.xml`, which is excluded from backups.
#[cfg(target_os = "android")]
const ANDROID_STORE: &str = "random-frame-sync";

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
                Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
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

#[cfg(not(target_os = "android"))]
fn entry(service: &str, user: &str) -> Result<Entry, StorageError> {
    Entry::new(service, user).map_err(|error| map_error(&error))
}

#[cfg(target_os = "android")]
fn entry(service: &str, user: &str) -> Result<Entry, StorageError> {
    use keyring_core::api::CredentialStoreApi;
    let configuration = std::collections::HashMap::from([("name", ANDROID_STORE)]);
    android_native_keyring_store::Store::new_with_configuration(&configuration)
        .and_then(|store| store.build(service, user, None))
        .map_err(|error| map_error(&error))
}

#[cfg(target_os = "android")]
use map_android_error as map_error;

#[cfg(any(target_os = "android", test))]
fn map_android_error(error: &keyring_core::Error) -> StorageError {
    use keyring_core::Error;
    match error {
        Error::NoEntry => StorageError::Missing,
        Error::BadDataFormat(..) | Error::BadEncoding(_) => StorageError::Corrupt,
        Error::PlatformFailure(_) | Error::BadStoreFormat(_) => StorageError::Unavailable,
        _ => StorageError::AccessDenied,
    }
}

#[cfg(not(target_os = "android"))]
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

    #[test]
    fn android_store_errors_never_look_like_a_missing_secret() {
        use keyring_core::Error;
        let detail = || Box::new(std::io::Error::other("private backend detail"));
        assert_eq!(map_android_error(&Error::NoEntry), StorageError::Missing);
        // A Keystore key that no longer decrypts the stored value must not read as "never paired".
        assert_eq!(
            map_android_error(&Error::BadDataFormat(vec![1], detail())),
            StorageError::Corrupt
        );
        assert_eq!(
            map_android_error(&Error::BadEncoding(vec![1])),
            StorageError::Corrupt
        );
        assert_eq!(
            map_android_error(&Error::PlatformFailure(detail())),
            StorageError::Unavailable
        );
        assert_eq!(
            map_android_error(&Error::NoStorageAccess(detail())),
            StorageError::AccessDenied
        );
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
