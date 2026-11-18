//! Group root secret and the authenticated snapshot envelope.

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use std::fmt;
use zeroize::Zeroizing;

use crate::{snapshot, sync_protocol::valid_hex, sync_transport::MAX_ENVELOPE};

const ENCRYPTION_LABEL: &[u8] = b"random-frame/sync/encryption";
const ID_LABEL: &[u8] = b"random-frame/sync/id";
const ENVELOPE_MAGIC: &[u8; 8] = b"RFSYNC\0\0";
const ENVELOPE_VERSION: u32 = 1;
const HEADER_LEN: usize = 8 + 4 + 32 + 8 + 32;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
pub(crate) const ENVELOPE_OVERHEAD: usize = HEADER_LEN + NONCE_LEN + TAG_LEN;

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
        let hkdf = Hkdf::<Sha256>::new(None, self.as_bytes());
        let mut encryption = Zeroizing::new([0; 32]);
        let mut id = [0; 32];
        hkdf.expand(ENCRYPTION_LABEL, encryption.as_mut())
            .unwrap_or_else(|_| unreachable!());
        hkdf.expand(ID_LABEL, &mut id)
            .unwrap_or_else(|_| unreachable!());
        SyncKeys {
            encryption,
            key_id: hex::encode(id),
        }
    }
}

pub struct SyncKeys {
    encryption: Zeroizing<[u8; 32]>,
    key_id: String,
}

impl SyncKeys {
    /// Names this root inside key packages and envelope headers; never a secret.
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn encrypt_snapshot(
        &self,
        group: &str,
        epoch: i64,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        if plaintext.len() > MAX_ENVELOPE - ENVELOPE_OVERHEAD {
            return Err(CryptoError::BodyTooLarge);
        }
        snapshot::parse_snapshot(plaintext).map_err(snapshot_error)?;
        let mut header = self.header(group, epoch)?;
        let mut nonce = [0; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        header.extend_from_slice(&nonce);
        let cipher = XChaCha20Poly1305::new_from_slice(self.encryption.as_ref())
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &header,
                },
            )
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        header.extend_from_slice(&ciphertext);
        Ok(header)
    }

    pub fn decrypt_snapshot(
        &self,
        group: &str,
        epoch: i64,
        envelope: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let header = self.header(group, epoch)?;
        if envelope.len() < ENVELOPE_OVERHEAD
            || envelope.len() > MAX_ENVELOPE
            || envelope[..HEADER_LEN] != header
        {
            return Err(CryptoError::InvalidEnvelope);
        }
        let cipher = XChaCha20Poly1305::new_from_slice(self.encryption.as_ref())
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    XNonce::from_slice(&envelope[HEADER_LEN..HEADER_LEN + NONCE_LEN]),
                    Payload {
                        msg: &envelope[HEADER_LEN + NONCE_LEN..],
                        aad: &envelope[..HEADER_LEN + NONCE_LEN],
                    },
                )
                .map_err(|_| CryptoError::InvalidEnvelope)?,
        );
        snapshot::parse_snapshot(&plaintext).map_err(snapshot_error)?;
        Ok(plaintext)
    }

    /// The server reads these 84 bytes: magic, version (u32 LE), group, epoch (u64 BE), key id.
    fn header(&self, group: &str, epoch: i64) -> Result<Vec<u8>, CryptoError> {
        if !valid_hex(group, 32) || epoch < 1 {
            return Err(CryptoError::InvalidEnvelope);
        }
        let mut header = Vec::with_capacity(HEADER_LEN + NONCE_LEN);
        header.extend_from_slice(ENVELOPE_MAGIC);
        header.extend_from_slice(&ENVELOPE_VERSION.to_le_bytes());
        header.extend_from_slice(&hex::decode(group).map_err(|_| CryptoError::InvalidEnvelope)?);
        header.extend_from_slice(&epoch.to_be_bytes());
        header.extend_from_slice(
            &hex::decode(&self.key_id).map_err(|_| CryptoError::InvalidEnvelope)?,
        );
        Ok(header)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    InvalidSecret,
    InvalidSnapshot,
    InvalidEnvelope,
    BodyTooLarge,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BodyTooLarge => "Encrypted sync data exceeds the transfer limit",
            Self::InvalidSecret => "Invalid stored sync secret",
            Self::InvalidSnapshot => "Invalid seen snapshot",
            Self::InvalidEnvelope => "Encrypted sync data could not be opened",
        })
    }
}

impl std::error::Error for CryptoError {}

fn snapshot_error(_: snapshot::SnapshotError) -> CryptoError {
    CryptoError::InvalidSnapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::SyncSnapshot;

    const GROUP: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn fixture() -> RootSecret {
        let bytes: Vec<u8> = (0..32).collect();
        RootSecret::from_bytes(&bytes).unwrap_or_else(|_| unreachable!())
    }

    fn plaintext() -> Vec<u8> {
        snapshot::serialize_snapshot(&SyncSnapshot {
            seen: vec![1, 42],
            ..SyncSnapshot::default()
        })
        .unwrap_or_else(|_| unreachable!())
    }

    #[test]
    fn envelope_overhead_matches_transport_and_plaintext_budget() {
        assert_eq!(HEADER_LEN, 84);
        assert_eq!(ENVELOPE_OVERHEAD, 124);
        assert_eq!(snapshot::MAX_PLAINTEXT + ENVELOPE_OVERHEAD, MAX_ENVELOPE);
    }

    #[test]
    fn header_layout_is_exactly_what_the_server_reads() {
        let keys = fixture().derive();
        let envelope = keys
            .encrypt_snapshot(GROUP, 258, &plaintext())
            .unwrap_or_else(|_| unreachable!());
        assert_eq!(&envelope[..8], b"RFSYNC\0\0");
        assert_eq!(envelope[8..12], 1_u32.to_le_bytes());
        assert_eq!(hex::encode(&envelope[12..44]), GROUP);
        assert_eq!(envelope[44..52], 258_u64.to_be_bytes());
        assert_eq!(hex::encode(&envelope[52..84]), keys.key_id());
        assert_eq!(envelope.len(), ENVELOPE_OVERHEAD + plaintext().len());
    }

    #[test]
    fn roundtrip_binds_group_epoch_and_key() {
        let keys = fixture().derive();
        let envelope = keys
            .encrypt_snapshot(GROUP, 1, &plaintext())
            .unwrap_or_else(|_| unreachable!());
        assert_eq!(
            keys.decrypt_snapshot(GROUP, 1, &envelope).ok().as_deref(),
            Some(&plaintext())
        );
        assert!(keys.decrypt_snapshot(GROUP, 2, &envelope).is_err());
        let other_group = GROUP.replace('0', "1");
        assert!(keys.decrypt_snapshot(&other_group, 1, &envelope).is_err());
        let other_key = RootSecret::generate().derive();
        assert!(other_key.decrypt_snapshot(GROUP, 1, &envelope).is_err());
    }

    #[test]
    fn tampering_with_any_byte_is_rejected() {
        let keys = fixture().derive();
        let envelope = keys
            .encrypt_snapshot(GROUP, 1, &plaintext())
            .unwrap_or_else(|_| unreachable!());
        for index in [0, 9, 20, 46, 60, 90, envelope.len() - 1] {
            let mut damaged = envelope.clone();
            damaged[index] ^= 1;
            assert!(keys.decrypt_snapshot(GROUP, 1, &damaged).is_err());
        }
        assert!(keys
            .decrypt_snapshot(GROUP, 1, &envelope[..ENVELOPE_OVERHEAD - 1])
            .is_err());
    }

    #[test]
    fn nonces_differ_and_derivation_is_deterministic() {
        let keys = fixture().derive();
        let a = keys
            .encrypt_snapshot(GROUP, 1, &plaintext())
            .unwrap_or_else(|_| unreachable!());
        let b = keys
            .encrypt_snapshot(GROUP, 1, &plaintext())
            .unwrap_or_else(|_| unreachable!());
        assert_ne!(a[84..108], b[84..108]);
        assert_eq!(keys.key_id(), fixture().derive().key_id());
        assert_ne!(keys.key_id(), RootSecret::generate().derive().key_id());
    }

    #[test]
    fn stable_derivation_vector() {
        assert_eq!(
            fixture().derive().key_id(),
            "3ba81b86df907cf4627ebf4090f6a8891b7560f559febf1724799feded0bdd17",
        );
    }

    #[test]
    fn valid_aead_with_invalid_snapshot_is_rejected() {
        let keys = fixture().derive();
        let header = keys.header(GROUP, 1).unwrap_or_else(|_| unreachable!());
        let mut nonce = [7; NONCE_LEN];
        nonce[0] = 1;
        let mut aad = header;
        aad.extend_from_slice(&nonce);
        let cipher = XChaCha20Poly1305::new_from_slice(keys.encryption.as_ref())
            .unwrap_or_else(|_| unreachable!());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: b"not a snapshot",
                    aad: &aad,
                },
            )
            .unwrap_or_else(|_| unreachable!());
        let mut envelope = aad;
        envelope.extend_from_slice(&ciphertext);
        assert!(keys.decrypt_snapshot(GROUP, 1, &envelope).is_err());
    }
}
