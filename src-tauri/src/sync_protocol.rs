//! Sync wire contract. The server README ("Wire contract") is the specification.
use serde::{Deserialize, Serialize};
pub const MAX_REQUEST: usize = 67_108_864;
pub const MAX_METADATA: usize = 1_048_576;
pub const PROTOCOL_VERSION: u8 = 1;
pub const SUITE: &str = "HPKE-0020-0001-0003";

/// A device as the server stores it; only the verifier of its token is sent.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberRegistration {
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub protocol_version: u8,
    pub group_id: String,
    pub master_member_id: String,
    pub state: String,
    pub epoch: i64,
    pub revision: i64,
    pub key_id: String,
    pub this_member_id: Option<String>,
    pub members: Vec<Member>,
    pub key_package: EpochKeyPackage,
}
/// Answer to `GET /sync/invitations/{id}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdministratorCodeLookup {
    pub group_id: String,
    pub epoch: i64,
    pub revision: i64,
    pub key_id: String,
    pub package: EpochKeyPackage,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    Create {
        member: MemberRegistration,
        key_id: String,
        packages: Vec<EpochKeyPackage>,
    },
    Snapshot {
        credential_version: i64,
        key_id: String,
    },
    Invitation {
        credential_version: i64,
        invitation_id: String,
        invitation_verifier: String,
        invitation_public_key: String,
        package: EpochKeyPackage,
    },
    Join {
        invitation_id: String,
        invitation_verifier: String,
        member: MemberRegistration,
        package: EpochKeyPackage,
    },
    Revoke {
        credential_version: i64,
        target: String,
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
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub operation_id: String,
    pub revision: i64,
    pub epoch: i64,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package() -> EpochKeyPackage {
        EpochKeyPackage {
            group_id: "g".into(),
            epoch: 2,
            key_id: "k".into(),
            recipient_kind: "invitation".into(),
            recipient_id: "r".into(),
            recipient_version: 1,
            suite: SUITE.into(),
            encapsulated_key: "e".into(),
            ciphertext: "c".into(),
        }
    }

    fn registration() -> MemberRegistration {
        MemberRegistration {
            member_id: "m".into(),
            device_id: "d".into(),
            token_verifier: "t".into(),
            wrapping_public_key: "w".into(),
            nonce: "n".into(),
        }
    }

    fn wire_package() -> serde_json::Value {
        json!({
            "groupId": "g", "epoch": 2, "keyId": "k", "recipientKind": "invitation",
            "recipientId": "r", "recipientVersion": 1, "suite": "HPKE-0020-0001-0003",
            "encapsulatedKey": "e", "ciphertext": "c"
        })
    }

    fn wire_member() -> serde_json::Value {
        json!({
            "memberId": "m", "deviceId": "d", "tokenVerifier": "t",
            "wrappingPublicKey": "w", "nonce": "n"
        })
    }

    #[test]
    fn mutations_have_snake_case_fields_and_camel_case_nested_objects() {
        let cases = [
            (
                Mutation::Create {
                    member: registration(),
                    key_id: "k".into(),
                    packages: vec![package()],
                },
                json!({"kind": "create", "member": wire_member(), "key_id": "k", "packages": [wire_package()]}),
            ),
            (
                Mutation::Snapshot {
                    credential_version: 1,
                    key_id: "k".into(),
                },
                json!({"kind": "snapshot", "credential_version": 1, "key_id": "k"}),
            ),
            (
                Mutation::Invitation {
                    credential_version: 1,
                    invitation_id: "i".into(),
                    invitation_verifier: "v".into(),
                    invitation_public_key: "p".into(),
                    package: package(),
                },
                json!({"kind": "invitation", "credential_version": 1, "invitation_id": "i",
                    "invitation_verifier": "v", "invitation_public_key": "p", "package": wire_package()}),
            ),
            (
                Mutation::Join {
                    invitation_id: "i".into(),
                    invitation_verifier: "v".into(),
                    member: registration(),
                    package: package(),
                },
                json!({"kind": "join", "invitation_id": "i", "invitation_verifier": "v",
                    "member": wire_member(), "package": wire_package()}),
            ),
            (
                Mutation::Revoke {
                    credential_version: 1,
                    target: "t".into(),
                    key_id: "k".into(),
                    packages: vec![package()],
                },
                json!({"kind": "revoke", "credential_version": 1, "target": "t", "key_id": "k",
                    "packages": [wire_package()]}),
            ),
            (
                Mutation::Leave {
                    credential_version: 1,
                },
                json!({"kind": "leave", "credential_version": 1}),
            ),
            (
                Mutation::Dissolve {
                    credential_version: 1,
                },
                json!({"kind": "dissolve", "credential_version": 1}),
            ),
        ];
        for (mutation, expected) in cases {
            assert_eq!(serde_json::to_value(&mutation).ok(), Some(expected));
        }
    }

    #[test]
    fn request_metadata_is_camel_case_and_framed_big_endian() -> Result<(), &'static str> {
        let request = Request {
            operation_id: "o".into(),
            expected_revision: 3,
            expected_epoch: 2,
            mutation: Mutation::Leave {
                credential_version: 1,
            },
        };
        let body = encode(&request, b"payload")?;
        let length = u32::from_be_bytes(body[..4].try_into().map_err(|_| "prefix")?) as usize;
        let metadata: serde_json::Value =
            serde_json::from_slice(&body[4..4 + length]).map_err(|_| "json")?;
        assert_eq!(
            metadata,
            json!({"operationId": "o", "expectedRevision": 3, "expectedEpoch": 2,
                "mutation": {"kind": "leave", "credential_version": 1}})
        );
        assert_eq!(&body[4 + length..], b"payload");
        let (decoded, rest): (Request, &[u8]) = decode(&body)?;
        assert_eq!(decoded.expected_revision, 3);
        assert_eq!(rest, b"payload");
        Ok(())
    }

    #[test]
    fn server_sent_types_tolerate_additions() -> Result<(), serde_json::Error> {
        let result: OperationResult = serde_json::from_value(
            json!({"operationId": "o", "revision": 2, "epoch": 1, "futureField": true}),
        )?;
        assert_eq!(result.revision, 2);
        let lookup: AdministratorCodeLookup = serde_json::from_value(json!({
            "groupId": "g", "epoch": 1, "revision": 2, "keyId": "k",
            "package": wire_package(), "futureField": 1
        }))?;
        assert_eq!(lookup.epoch, 1);
        Ok(())
    }

    #[test]
    fn framing_rejects_truncated_and_oversized_metadata() {
        assert!(decode::<Request>(&[0, 0]).is_err());
        assert!(decode::<Request>(&[0, 0, 0, 9, b'{']).is_err());
        let huge = u32::try_from(MAX_METADATA + 1).unwrap_or(u32::MAX);
        assert!(decode::<Request>(&huge.to_be_bytes()).is_err());
    }
}
