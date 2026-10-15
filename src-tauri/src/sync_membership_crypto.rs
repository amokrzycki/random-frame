//! RFC 9180 HPKE Base, X25519/HKDF-SHA256/ChaCha20Poly1305; no custom KEM.
use crate::{
    sync_crypto::{CryptoError, RootSecret},
    sync_protocol::{valid_hex, EpochKeyPackage, Recipient, SUITE},
};
use hkdf::Hkdf;
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, Kem as _,
    OpModeR, OpModeS, Serializable,
};
use rand::{rngs::OsRng, RngCore};
use rand09::TryRngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
type Kem = X25519HkdfSha256;
type Private = <Kem as hpke::Kem>::PrivateKey;
type Public = <Kem as hpke::Kem>::PublicKey;

pub fn random_secret() -> [u8; 32] {
    let mut b = [0; 32];
    OsRng.fill_bytes(&mut b);
    b
}
pub fn random_id() -> String {
    hex::encode(&random_secret()[..16])
}
pub fn token(secret: &[u8; 32]) -> Zeroizing<String> {
    Zeroizing::new(hex::encode(secret))
}
pub fn verifier(secret: &[u8; 32]) -> String {
    hex::encode(Sha256::digest(token(secret).as_bytes()))
}
pub fn keypair() -> (Zeroizing<[u8; 32]>, String) {
    let seed = Zeroizing::new(random_secret());
    let (sk, pk) = Kem::derive_keypair(seed.as_ref());
    (
        Zeroizing::new(sk.to_bytes().into()),
        hex::encode(pk.to_bytes()),
    )
}
pub fn public_key(private: &[u8; 32]) -> Result<String, CryptoError> {
    let sk = Private::from_bytes(private).map_err(|_| CryptoError::InvalidSecret)?;
    Ok(hex::encode(Kem::sk_to_pk(&sk).to_bytes()))
}
fn context(group: &str, epoch: i64, key: &str, r: &Recipient) -> Result<Vec<u8>, CryptoError> {
    if !valid_hex(group, 32)
        || !valid_hex(key, 32)
        || !valid_hex(&r.id, 16)
        || epoch < 1
        || r.version < 1
    {
        return Err(CryptoError::InvalidEnvelope);
    }
    let mut c = b"random-frame/sync/v2/root-package\0".to_vec();
    c.extend_from_slice(&2_u32.to_be_bytes());
    c.extend_from_slice(&hex::decode(group).map_err(|_| CryptoError::InvalidEnvelope)?);
    c.extend_from_slice(&epoch.to_be_bytes());
    c.extend_from_slice(&hex::decode(key).map_err(|_| CryptoError::InvalidEnvelope)?);
    c.push(match r.kind.as_str() {
        "member" => 1,
        "admin_recovery" => 2,
        _ => return Err(CryptoError::InvalidEnvelope),
    });
    c.extend_from_slice(&hex::decode(&r.id).map_err(|_| CryptoError::InvalidEnvelope)?);
    c.extend_from_slice(&r.version.to_be_bytes());
    Ok(c)
}
pub fn seal_root(
    group: &str,
    epoch: i64,
    r: &Recipient,
    root: &RootSecret,
) -> Result<EpochKeyPackage, CryptoError> {
    let key = root.derive().sync_id().to_owned();
    let ctx = context(group, epoch, &key, r)?;
    let pk =
        Public::from_bytes(&hex::decode(&r.public_key).map_err(|_| CryptoError::InvalidSecret)?)
            .map_err(|_| CryptoError::InvalidSecret)?;
    let mut rng = rand09::rngs::OsRng.unwrap_err();
    let (enc, mut sender) = hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, Kem, _>(
        &OpModeS::Base,
        &pk,
        &ctx,
        &mut rng,
    )
    .map_err(|_| CryptoError::InvalidEnvelope)?;
    let ct = sender
        .seal(root.as_bytes(), &ctx)
        .map_err(|_| CryptoError::InvalidEnvelope)?;
    Ok(EpochKeyPackage {
        group_id: group.into(),
        epoch,
        key_id: key,
        recipient_kind: r.kind.clone(),
        recipient_id: r.id.clone(),
        recipient_version: r.version,
        suite: SUITE.into(),
        encapsulated_key: hex::encode(enc.to_bytes()),
        ciphertext: hex::encode(ct),
    })
}
pub fn open_root(
    group: &str,
    epoch: i64,
    key: &str,
    r: &Recipient,
    private: &[u8; 32],
    p: &EpochKeyPackage,
) -> Result<RootSecret, CryptoError> {
    if p.group_id != group
        || p.epoch != epoch
        || p.key_id != key
        || p.recipient_kind != r.kind
        || p.recipient_id != r.id
        || p.recipient_version != r.version
        || p.suite != SUITE
        || public_key(private)? != r.public_key
    {
        return Err(CryptoError::InvalidEnvelope);
    }
    let ctx = context(group, epoch, key, r)?;
    let sk = Private::from_bytes(private).map_err(|_| CryptoError::InvalidSecret)?;
    let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(
        &hex::decode(&p.encapsulated_key).map_err(|_| CryptoError::InvalidEnvelope)?,
    )
    .map_err(|_| CryptoError::InvalidEnvelope)?;
    let mut receiver =
        hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(&OpModeR::Base, &sk, &enc, &ctx)
            .map_err(|_| CryptoError::InvalidEnvelope)?;
    let bytes = Zeroizing::new(
        receiver
            .open(
                &hex::decode(&p.ciphertext).map_err(|_| CryptoError::InvalidEnvelope)?,
                &ctx,
            )
            .map_err(|_| CryptoError::InvalidEnvelope)?,
    );
    let root = RootSecret::from_bytes(&bytes)?;
    if root.derive().sync_id() != key {
        return Err(CryptoError::InvalidEnvelope);
    }
    Ok(root)
}
pub type RecoveryCredentials = (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>, String);
pub struct AdminRecoverySecret(pub Zeroizing<[u8; 32]>);
impl AdminRecoverySecret {
    pub fn generate() -> Self {
        Self(Zeroizing::new(random_secret()))
    }
    pub fn derive_credentials(&self, group: &str) -> Result<RecoveryCredentials, CryptoError> {
        if !valid_hex(group, 32) {
            return Err(CryptoError::InvalidSecret);
        }
        let salt = hex::decode(group).map_err(|_| CryptoError::InvalidSecret)?;
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), self.0.as_ref());
        let mut auth = Zeroizing::new([0; 32]);
        let mut seed = Zeroizing::new([0; 32]);
        hkdf.expand(b"random-frame/sync/v2/admin-recovery/auth", auth.as_mut())
            .map_err(|_| CryptoError::InvalidSecret)?;
        hkdf.expand(
            b"random-frame/sync/v2/admin-recovery/kem-seed",
            seed.as_mut(),
        )
        .map_err(|_| CryptoError::InvalidSecret)?;
        let (sk, pk) = Kem::derive_keypair(seed.as_ref());
        Ok((
            auth,
            Zeroizing::new(sk.to_bytes().into()),
            hex::encode(pk.to_bytes()),
        ))
    }
    pub fn code(&self, group: &str, generation: i64) -> Zeroizing<String> {
        let mut code = Zeroizing::new(format!(
            "rf-admin-v2-{group}-{generation}-{}",
            hex::encode(self.0.as_ref())
        ));
        let sum = Sha256::new()
            .chain_update(b"random-frame/sync/v2/admin-code\0")
            .chain_update(code.as_bytes())
            .finalize();
        code.push('-');
        code.push_str(&hex::encode(&sum[..4]));
        code
    }
    pub fn from_code(code: &str) -> Result<(String, i64, Self), CryptoError> {
        let mut parts = code
            .strip_prefix("rf-admin-v2-")
            .ok_or(CryptoError::InvalidRecoveryKey)?
            .split('-');
        let group = parts.next().ok_or(CryptoError::InvalidRecoveryKey)?;
        let generation = parts
            .next()
            .ok_or(CryptoError::InvalidRecoveryKey)?
            .parse::<i64>()
            .map_err(|_| CryptoError::InvalidRecoveryKey)?;
        let secret = parts.next().ok_or(CryptoError::InvalidRecoveryKey)?;
        if !valid_hex(group, 32) || generation < 1 || !valid_hex(secret, 32) {
            return Err(CryptoError::InvalidRecoveryKey);
        }
        let bytes =
            Zeroizing::new(hex::decode(secret).map_err(|_| CryptoError::InvalidRecoveryKey)?);
        let mut value = Zeroizing::new([0; 32]);
        value.copy_from_slice(&bytes);
        let result = Self(value);
        if result.code(group, generation).as_str() != code {
            return Err(CryptoError::InvalidRecoveryKey);
        }
        Ok((group.into(), generation, result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packages_bind_every_context_field_and_reject_bad_keys(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let group = hex::encode(random_secret());
        let root = RootSecret::generate();
        let (sk, pk) = keypair();
        let r = Recipient {
            kind: "member".into(),
            id: random_id(),
            version: 1,
            public_key: pk,
        };
        let key = root.derive().sync_id().to_owned();
        let p = seal_root(&group, 1, &r, &root)?;
        assert_eq!(
            open_root(&group, 1, &key, &r, &sk, &p)?.as_bytes(),
            root.as_bytes()
        );
        let (other, _) = keypair();
        assert!(open_root(&group, 1, &key, &r, &other, &p).is_err());
        assert!(open_root(&hex::encode(random_secret()), 1, &key, &r, &sk, &p).is_err());
        assert!(open_root(&group, 2, &key, &r, &sk, &p).is_err());
        let mut changed = r.clone();
        changed.version = 2;
        assert!(open_root(&group, 1, &key, &changed, &sk, &p).is_err());
        changed = r.clone();
        changed.kind = "admin_recovery".into();
        assert!(open_root(&group, 1, &key, &changed, &sk, &p).is_err());
        let mut tampered = p.clone();
        tampered.ciphertext.replace_range(..2, "00");
        if tampered == p {
            tampered.ciphertext.replace_range(..2, "ff");
        }
        assert!(open_root(&group, 1, &key, &r, &sk, &tampered).is_err());
        changed = r.clone();
        changed.public_key = "00".repeat(32);
        assert!(seal_root(&group, 1, &changed, &root).is_err());
        let secret = AdminRecoverySecret::generate();
        let code = secret.code(&group, 1);
        let (g, generation, decoded) = AdminRecoverySecret::from_code(&code)?;
        assert_eq!(g, group);
        assert_eq!(generation, 1);
        let (auth, private, public) = decoded.derive_credentials(&group)?;
        assert_ne!(auth.as_ref(), private.as_ref());
        let recovery = Recipient {
            kind: "admin_recovery".into(),
            id: r.id,
            version: 1,
            public_key: public,
        };
        for epoch in 1..=3 {
            let root = RootSecret::generate();
            let p = seal_root(&group, epoch, &recovery, &root)?;
            assert_eq!(
                open_root(
                    &group,
                    epoch,
                    root.derive().sync_id(),
                    &recovery,
                    &private,
                    &p
                )?
                .as_bytes(),
                root.as_bytes()
            );
            assert!(
                open_root(&group, epoch, root.derive().sync_id(), &recovery, &auth, &p).is_err()
            );
        }
        Ok(())
    }
    #[test]
    fn rfc9180_a2_and_selected_suite_vectors() -> Result<(), Box<dyn std::error::Error>> {
        // Upstream test-vectors-5f503c5.json, also linked by RFC 9180 Appendix A.
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../test/fixtures/hpke-rfc9180.json"))?;
        for v in vectors {
            let bytes = |field: &str| -> Result<Vec<u8>, hex::FromHexError> {
                hex::decode(v[field].as_str().unwrap_or_default())
            };
            let (sk, pk) = Kem::derive_keypair(&bytes("ikmR")?);
            assert_eq!(hex::encode(sk.to_bytes()), v["skRm"]);
            assert_eq!(hex::encode(pk.to_bytes()), v["pkRm"]);
            let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(&bytes("enc")?)
                .map_err(|_| CryptoError::InvalidEnvelope)?;
            let e = &v["encryptions"][0];
            let ct = hex::decode(e["ct"].as_str().unwrap_or_default())?;
            let aad = hex::decode(e["aad"].as_str().unwrap_or_default())?;
            let pt = if v["aead_id"] == 1 {
                hpke::setup_receiver::<hpke::aead::AesGcm128, HkdfSha256, Kem>(
                    &OpModeR::Base,
                    &sk,
                    &enc,
                    &bytes("info")?,
                )
                .map_err(|_| CryptoError::InvalidEnvelope)?
                .open(&ct, &aad)
                .map_err(|_| CryptoError::InvalidEnvelope)?
            } else {
                hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(
                    &OpModeR::Base,
                    &sk,
                    &enc,
                    &bytes("info")?,
                )
                .map_err(|_| CryptoError::InvalidEnvelope)?
                .open(&ct, &aad)
                .map_err(|_| CryptoError::InvalidEnvelope)?
            };
            assert_eq!(hex::encode(pt), e["pt"]);
        }
        Ok(())
    }
    #[test]
    fn managed_envelope_does_not_accept_legacy_or_cross_group(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let keys = RootSecret::generate().derive();
        let group = hex::encode(random_secret());
        let bytes = crate::snapshot::serialize_snapshot(&crate::snapshot::SyncSnapshot::default())?;
        assert_eq!(
            keys.encrypt_managed(&group, 2, &vec![0; crate::sync_transport::MAX_ENVELOPE]),
            Err(CryptoError::BodyTooLarge)
        );
        let envelope = keys.encrypt_managed(&group, 2, &bytes)?;
        assert_eq!(
            keys.decrypt_managed(&group, 2, &envelope)?.as_slice(),
            bytes
        );
        assert!(keys.decrypt_managed(&group, 1, &envelope).is_err());
        assert!(keys
            .decrypt_managed(&hex::encode(random_secret()), 2, &envelope)
            .is_err());
        assert!(keys.decrypt_snapshot(keys.sync_id(), &envelope).is_err());
        assert!(keys
            .decrypt_managed(&group, 2, &keys.encrypt_snapshot(&bytes)?)
            .is_err());
        Ok(())
    }
}
