//! Membership v2 wire contract. Keep the server copy and protocol fixture in sync.
use serde::{Deserialize, Serialize};
pub const MAX_REQUEST: usize = 67_108_864;
pub const MAX_METADATA: usize = 1_048_576;
pub const SUITE: &str = "HPKE-0020-0001-0003";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingRequest {
    pub member_id: String,
    pub device_id: String,
    pub token_verifier: String,
    pub wrapping_public_key: String,
    pub nonce: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipient {
    pub kind: String,
    pub id: String,
    pub version: i64,
    pub public_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpochKeyPackage {
    pub group_id: String,
    pub epoch: i64,
    pub key_id: String,
    pub recipient_kind: String,
    pub recipient_id: String,
    pub recipient_version: i64,
    pub suite: String,
    pub encapsulated_key: String,
    pub ciphertext: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[expect(
    clippy::struct_field_names,
    reason = "The wire contract names logical member IDs explicitly"
)]
pub struct Member {
    pub member_id: String,
    pub device_id: String,
    pub credential_version: i64,
    pub wrapping_public_key: String,
    pub status: String,
    pub joined_at_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    pub protocol_version: u8,
    pub group_id: String,
    pub master_member_id: String,
    pub state: String,
    pub epoch: i64,
    pub revision: i64,
    pub key_id: String,
    pub snapshot_schema_floor: u32,
    pub recovery_generation: i64,
    pub recovery_public_key: String,
    pub this_member_id: Option<String>,
    pub members: Vec<Member>,
    pub key_package: EpochKeyPackage,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRegistration {
    pub generation: i64,
    pub token_verifier: String,
    pub public_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    Create {
        member: PairingRequest,
        recovery: RecoveryRegistration,
        key_id: String,
        packages: Vec<EpochKeyPackage>,
    },
    Snapshot {
        credential_version: i64,
        key_id: String,
    },
    Invite {
        credential_version: i64,
        invitation_id: String,
        invitation_verifier: String,
        member: PairingRequest,
        package: EpochKeyPackage,
    },
    Redeem {
        invitation_id: String,
        invitation_verifier: String,
        member: PairingRequest,
    },
    Revoke {
        credential_version: i64,
        target: String,
        key_id: String,
        packages: Vec<EpochKeyPackage>,
    },
    Recovery {
        recovery_generation: i64,
        member: PairingRequest,
        recovery: RecoveryRegistration,
        key_id: String,
        packages: Vec<EpochKeyPackage>,
    },
    Leave {
        credential_version: i64,
    },
    Dissolve {
        credential_version: i64,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub expected_revision: i64,
    pub expected_epoch: i64,
    pub mutation: Mutation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationResult {
    pub operation_id: String,
    pub revision: i64,
    pub epoch: i64,
    pub recovery_generation: i64,
}

pub fn valid_hex(s: &str, bytes: usize) -> bool {
    s.len() == bytes * 2
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn encode<T: Serialize>(metadata: &T, payload: &[u8]) -> Result<Vec<u8>, &'static str> {
    let json = serde_json::to_vec(metadata).map_err(|_| "invalid_metadata")?;
    if json.len() > MAX_METADATA || 4 + json.len() + payload.len() > MAX_REQUEST {
        return Err("body_too_large");
    }
    let mut body = Vec::with_capacity(4 + json.len() + payload.len());
    body.extend_from_slice(
        &u32::try_from(json.len())
            .map_err(|_| "body_too_large")?
            .to_be_bytes(),
    );
    body.extend_from_slice(&json);
    body.extend_from_slice(payload);
    Ok(body)
}
pub fn decode<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<(T, &[u8]), &'static str> {
    if body.len() > MAX_REQUEST {
        return Err("body_too_large");
    }
    let prefix: [u8; 4] = body
        .get(..4)
        .ok_or("invalid_metadata")?
        .try_into()
        .map_err(|_| "invalid_metadata")?;
    let len = u32::from_be_bytes(prefix) as usize;
    if len > MAX_METADATA || len > body.len() - 4 {
        return Err("invalid_metadata");
    }
    let meta = serde_json::from_slice(&body[4..4 + len]).map_err(|_| "invalid_metadata")?;
    Ok((meta, &body[4 + len..]))
}
