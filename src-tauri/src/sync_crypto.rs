//! Local v1 pairing identity and authenticated seen-snapshot envelope.

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::fmt;
use zeroize::Zeroizing;

use crate::snapshot::{self, MAX_ENTRIES};

const ENCRYPTION_LABEL: &[u8] = b"random-frame/sync/v1/encryption";
const AUTH_LABEL: &[u8] = b"random-frame/sync/v1/auth";
const ID_LABEL: &[u8] = b"random-frame/sync/v1/id";
const RECOVERY_LABEL: &[u8] = b"random-frame/recovery/v1";
const ENVELOPE_MAGIC: &[u8; 8] = b"RFSYNC\0\0";
const ENVELOPE_VERSION: u32 = 1;
const HEADER_LEN: usize = 8 + 4 + 24;
const TAG_LEN: usize = 16;
const MAX_SNAPSHOT_LEN: usize = 16 + MAX_ENTRIES * 8;

pub struct RootSecret(Zeroizing<[u8; 32]>);

impl RootSecret {
    pub fn generate() -> Self {
        let mut bytes = Zeroizing::new([0; 32]);
        OsRng.fill_bytes(bytes.as_mut());
        Self(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() != 32 {
            return Err(CryptoError::InvalidSecret);
        }
        let mut root = Zeroizing::new([0; 32]);
        root.copy_from_slice(bytes);
        Ok(Self(root))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn derive(&self) -> SyncKeys {
        // Fixed v1 labels and the empty salt are part of the frozen derivation format.
        let hkdf = Hkdf::<Sha256>::new(None, self.as_bytes());
        let mut encryption = Zeroizing::new([0; 32]);
        let mut auth = Zeroizing::new([0; 32]);
        let mut id = [0; 32];
        hkdf.expand(ENCRYPTION_LABEL, encryption.as_mut())
            .unwrap_or_else(|_| unreachable!());
        hkdf.expand(AUTH_LABEL, auth.as_mut())
            .unwrap_or_else(|_| unreachable!());
        hkdf.expand(ID_LABEL, &mut id)
            .unwrap_or_else(|_| unreachable!());
        SyncKeys {
            encryption,
            auth,
            sync_id: hex_encode(&id),
        }
    }

    pub fn recovery_key(&self) -> Zeroizing<String> {
        use std::fmt::Write;
        let digest = Sha256::new()
            .chain_update(RECOVERY_LABEL)
            .chain_update(self.as_bytes())
            .finalize();
        let mut key = Zeroizing::new(String::with_capacity(4 + 64 + 1 + 8));
        key.push_str("rf1-");
        for byte in self.as_bytes() {
            let _ = write!(&mut *key, "{byte:02x}");
        }
        key.push('-');
        for byte in &digest[..4] {
            let _ = write!(&mut *key, "{byte:02x}");
        }
        key
    }

    pub fn from_recovery_key(input: &str) -> Result<Self, CryptoError> {
        let (secret, checksum) = input
            .strip_prefix("rf1-")
            .ok_or(CryptoError::InvalidRecoveryKey)?
            .split_once('-')
            .ok_or(CryptoError::InvalidRecoveryKey)?;
        if secret.len() != 64 || checksum.len() != 8 {
            return Err(CryptoError::InvalidRecoveryKey);
        }
        let bytes = Zeroizing::new(hex_decode(secret).ok_or(CryptoError::InvalidRecoveryKey)?);
        let root = Self::from_bytes(&bytes).map_err(|_| CryptoError::InvalidRecoveryKey)?;
        if root.recovery_key().as_str() != input {
            return Err(CryptoError::InvalidRecoveryKey);
        }
        Ok(root)
    }
}

pub struct SyncKeys {
    encryption: Zeroizing<[u8; 32]>,
    auth: Zeroizing<[u8; 32]>,
    sync_id: String,
}

impl SyncKeys {
    pub fn sync_id(&self) -> &str {
        &self.sync_id
    }

    /// Send only over HTTPS as a bearer credential; never store this on the server.
    pub fn client_auth_token(&self) -> Zeroizing<String> {
        Zeroizing::new(hex_encode(self.auth.as_ref()))
    }

    /// SHA-256 of a 256-bit random-derived token; suitable for server-side comparison.
    #[allow(
        dead_code,
        reason = "server verifier is part of the frozen v1 derivation API"
    )]
    pub fn server_auth_verifier(&self) -> String {
        hex_encode(&Sha256::digest(self.client_auth_token().as_bytes()))
    }

    pub fn encrypt_snapshot(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        snapshot::parse_snapshot(plaintext).map_err(|_| CryptoError::InvalidSnapshot)?;
        let mut nonce = [0; 24];
        OsRng.fill_bytes(&mut nonce);
        let mut envelope = Vec::with_capacity(HEADER_LEN + plaintext.len() + TAG_LEN);
        envelope.extend_from_slice(ENVELOPE_MAGIC);
        envelope.extend_from_slice(&ENVELOPE_VERSION.to_le_bytes());
        envelope.extend_from_slice(&nonce);
        let cipher = XChaCha20Poly1305::new_from_slice(self.encryption.as_ref())
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &self.aad(&envelope[..12]),
                },
            )
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        envelope.extend_from_slice(&ciphertext);
        Ok(envelope)
    }

    pub fn decrypt_snapshot(
        &self,
        expected_sync_id: &str,
        envelope: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        if expected_sync_id != self.sync_id {
            return Err(CryptoError::InvalidEnvelope);
        }
        if envelope.len() < HEADER_LEN + TAG_LEN
            || envelope.len() > HEADER_LEN + TAG_LEN + MAX_SNAPSHOT_LEN
        {
            return Err(CryptoError::InvalidEnvelope);
        }
        if &envelope[..8] != ENVELOPE_MAGIC
            || u32::from_le_bytes(
                envelope[8..12]
                    .try_into()
                    .map_err(|_| CryptoError::InvalidEnvelope)?,
            ) != ENVELOPE_VERSION
        {
            return Err(CryptoError::InvalidEnvelope);
        }
        let cipher = XChaCha20Poly1305::new_from_slice(self.encryption.as_ref())
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&envelope[12..HEADER_LEN]),
                Payload {
                    msg: &envelope[HEADER_LEN..],
                    aad: &self.aad(&envelope[..12]),
                },
            )
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        snapshot::parse_snapshot(&plaintext).map_err(|_| CryptoError::InvalidSnapshot)?;
        Ok(plaintext)
    }

    fn aad(&self, header: &[u8]) -> Vec<u8> {
        let mut aad = Vec::with_capacity(header.len() + self.sync_id.len());
        aad.extend_from_slice(header);
        aad.extend_from_slice(self.sync_id.as_bytes());
        aad
    }
}

#[allow(
    clippy::enum_variant_names,
    reason = "invalidity is the common safe error category"
)]
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    InvalidSecret,
    InvalidRecoveryKey,
    InvalidSnapshot,
    InvalidEnvelope,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidSecret => "Invalid stored sync secret",
            Self::InvalidRecoveryKey => "Invalid recovery key",
            Self::InvalidSnapshot => "Invalid seen snapshot",
            Self::InvalidEnvelope => "Encrypted sync data could not be opened",
        })
    }
}

impl std::error::Error for CryptoError {}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(result, "{byte:02x}");
    }
    result
}

fn hex_decode(input: &str) -> Option<Vec<u8>> {
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).ok()?;
            if !pair
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return None;
            }
            u8::from_str_radix(pair, 16).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::SeenStore;
    use std::collections::HashSet;

    fn fixture() -> RootSecret {
        let bytes: Vec<u8> = (0..32).collect();
        RootSecret::from_bytes(&bytes).unwrap_or_else(|_| unreachable!())
    }

    fn snapshot() -> Vec<u8> {
        snapshot::serialize_snapshot(&HashSet::from([1, 42])).unwrap_or_else(|_| unreachable!())
    }

    #[test]
    fn derivation_is_separate_deterministic_and_sensitive() {
        let first = RootSecret::generate();
        let second = RootSecret::generate();
        assert_eq!(first.as_bytes().len(), 32);
        assert_ne!(first.as_bytes(), second.as_bytes());
        let root = fixture();
        let keys = root.derive();
        let same = fixture().derive();
        assert_eq!(keys.sync_id(), same.sync_id());
        assert_eq!(keys.encryption.as_ref(), same.encryption.as_ref());
        assert_eq!(keys.auth.as_ref(), same.auth.as_ref());
        assert_ne!(keys.encryption.as_ref(), keys.auth.as_ref());
        assert_ne!(hex_encode(keys.encryption.as_ref()), keys.sync_id());
        assert_ne!(hex_encode(keys.auth.as_ref()), keys.sync_id());
        let mut changed = *root.as_bytes();
        changed[0] ^= 1;
        let changed = RootSecret::from_bytes(&changed)
            .unwrap_or_else(|_| unreachable!())
            .derive();
        assert_ne!(keys.sync_id(), changed.sync_id());
        assert_ne!(keys.auth.as_ref(), changed.auth.as_ref());
        assert_ne!(keys.encryption.as_ref(), changed.encryption.as_ref());
        assert_ne!(*keys.client_auth_token(), keys.server_auth_verifier());
    }

    #[test]
    fn stable_v1_vectors() {
        let root = fixture();
        let keys = root.derive();
        assert_eq!(
            hex_encode(keys.encryption.as_ref()),
            "1be9a8f3a995887eb461ec47d8dca2e412f5cd1b3f19ad6a7a6c775be024cfa6"
        );
        assert_eq!(
            hex_encode(keys.auth.as_ref()),
            "849d889a5511423d18dffe61c92796005318fa916449dcc3e6fe0e9d8d8b9d90"
        );
        assert_eq!(
            keys.sync_id(),
            "6d7efd095845c986cef388be39a7bf323a594294deb7bef8b6553d2ba1b7ac62"
        );
        assert_eq!(
            keys.server_auth_verifier(),
            "b4029f45e1ecb8ff49a25ab1f5ab5527620de4beda89d948c9b939d19c02804c"
        );
        assert_eq!(
            root.recovery_key().as_str(),
            "rf1-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f-ef83c816"
        );
    }

    #[test]
    fn recovery_key_is_canonical_and_detects_errors() {
        let canonical = fixture().recovery_key();
        assert_eq!(
            RootSecret::from_recovery_key(&canonical)
                .unwrap_or_else(|_| unreachable!())
                .recovery_key()
                .as_str(),
            canonical.as_str()
        );
        for bad in [
            canonical.replacen("rf1", "rf2", 1),
            canonical.to_ascii_uppercase(),
            canonical[..canonical.len() - 1].to_owned(),
            format!("{}0", canonical.as_str()),
            canonical.replacen('0', "z", 1),
            format!("{}0", &canonical[..canonical.len() - 1]),
            canonical.replacen('0', "1", 1),
        ] {
            assert!(RootSecret::from_recovery_key(&bad).is_err());
        }
    }

    #[test]
    fn envelope_roundtrip_nonce_and_tamper_fail_without_merge() {
        let keys = fixture().derive();
        let plain = snapshot();
        let good = keys
            .encrypt_snapshot(&plain)
            .unwrap_or_else(|_| unreachable!());
        let second = keys
            .encrypt_snapshot(&plain)
            .unwrap_or_else(|_| unreachable!());
        assert_ne!(good, second);
        assert_eq!(
            keys.decrypt_snapshot(keys.sync_id(), &good).ok(),
            Some(plain)
        );
        let directory = std::env::temp_dir().join(format!(
            "random-frame-crypto-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let seen = SeenStore::new(&directory).unwrap_or_else(|_| unreachable!());
        seen.insert(7).unwrap_or_else(|_| unreachable!());
        let mut cases = Vec::new();
        for position in [12, HEADER_LEN, good.len() - 1] {
            let mut damaged = good.clone();
            damaged[position] ^= 1;
            cases.push(damaged);
        }
        cases.push(good[..good.len() - 1].to_vec());
        cases.push([good.as_slice(), &[0]].concat());
        let mut version = good.clone();
        version[8] = 2;
        cases.push(version);
        cases.push(good[..HEADER_LEN + TAG_LEN - 1].to_vec());
        for case in cases {
            assert!(keys.decrypt_snapshot(keys.sync_id(), &case).is_err());
            assert!(seen.contains(7));
            assert!(!seen.contains(1));
        }
        assert!(keys.decrypt_snapshot(&"0".repeat(64), &good).is_err());
        let other = RootSecret::generate().derive();
        assert!(other.decrypt_snapshot(other.sync_id(), &good).is_err());
        assert!(!seen.contains(1));
        let imported = keys
            .decrypt_snapshot(keys.sync_id(), &good)
            .unwrap_or_else(|_| unreachable!());
        assert_eq!(seen.merge_snapshot(&imported).ok(), Some(2));
        assert!(seen.contains(1));
        std::fs::remove_dir_all(directory).unwrap_or_else(|_| unreachable!());
    }

    #[test]
    fn valid_aead_with_invalid_snapshot_is_rejected() {
        let keys = fixture().derive();
        let mut invalid = snapshot();
        invalid[0] = b'X';
        assert_eq!(
            keys.encrypt_snapshot(&invalid),
            Err(CryptoError::InvalidSnapshot)
        );
        let mut nonce = [0; 24];
        OsRng.fill_bytes(&mut nonce);
        let mut envelope = Vec::from(*ENVELOPE_MAGIC);
        envelope.extend_from_slice(&ENVELOPE_VERSION.to_le_bytes());
        envelope.extend_from_slice(&nonce);
        let cipher = XChaCha20Poly1305::new_from_slice(keys.encryption.as_ref())
            .unwrap_or_else(|_| unreachable!());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &invalid,
                    aad: &keys.aad(&envelope[..12]),
                },
            )
            .unwrap_or_else(|_| unreachable!());
        envelope.extend_from_slice(&ciphertext);
        assert_eq!(
            keys.decrypt_snapshot(keys.sync_id(), &envelope),
            Err(CryptoError::InvalidSnapshot)
        );
    }
}
