//! HTTP transport for the sync protocol.

use reqwest::{header, Client, Method, StatusCode, Url};
use std::{fmt, time::Duration};

pub const MAX_ENVELOPE: usize = 67_108_864;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Revoked,
    Left,
    Closed,
    CredentialReplaced,
    MasterRequired,
    MasterCannotLeave,
    OperationMismatch,
    InvalidEndpoint,
    InvalidIdentity,
    Offline,
    Timeout,
    Tls,
    MalformedResponse,
    NotFound,
    Conflict,
    RateLimited,
    ServerError,
    UnexpectedStatus(u16),
    BodyTooLarge,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for TransportError {}

fn lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub struct SyncTransport {
    client: Client,
    base: Url,
}

impl SyncTransport {
    pub fn new(base: &str) -> Result<Self, TransportError> {
        let base = Url::parse(base).map_err(|_| TransportError::InvalidEndpoint)?;
        let host = base.host_str().ok_or(TransportError::InvalidEndpoint)?;
        let loopback = host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback());
        if !((base.scheme() == "https") || (base.scheme() == "http" && loopback))
            || !base.username().is_empty()
            || base.password().is_some()
            || base.path() != "/"
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(TransportError::InvalidEndpoint);
        }
        // Allow a full 64 MiB transfer on a modest link.
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| TransportError::InvalidEndpoint)?;
        Ok(Self { client, base })
    }

    /// A call on a group, authenticated by a device token.
    pub async fn group(
        &self,
        group: &str,
        route: &str,
        method: Method,
        token: &str,
        invitation: Option<&str>,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, TransportError> {
        if !lower_hex_64(group)
            || !lower_hex_64(token)
            || invitation.is_some_and(|s| !lower_hex_64(s))
        {
            return Err(TransportError::InvalidIdentity);
        }
        let url = self
            .base
            .join(&format!("sync/groups/{group}/{route}"))
            .map_err(|_| TransportError::InvalidEndpoint)?;
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(secret) = invitation {
            request = request.header("x-rf-invitation", secret);
        }
        self.send(request, body).await
    }

    /// Looks up the group behind a code. Knowing the secret is the only credential.
    pub async fn invitation(&self, id: &str, secret: &str) -> Result<Vec<u8>, TransportError> {
        if !valid_id(id) || !lower_hex_64(secret) {
            return Err(TransportError::InvalidIdentity);
        }
        let url = self
            .base
            .join(&format!("sync/invitations/{id}"))
            .map_err(|_| TransportError::InvalidEndpoint)?;
        self.send(self.client.get(url).header("x-rf-invitation", secret), None)
            .await
    }

    async fn send(
        &self,
        mut request: reqwest::RequestBuilder,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, TransportError> {
        if body.as_ref().is_some_and(|b| b.len() > MAX_ENVELOPE) {
            return Err(TransportError::BodyTooLarge);
        }
        if let Some(bytes) = body {
            request = request
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(bytes);
        }
        let mut response = request.send().await.map_err(|e| map_reqwest(&e))?;
        let status = response.status();
        let limit = if status.is_success() {
            MAX_ENVELOPE
        } else {
            256
        };
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(TransportError::BodyTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| map_reqwest(&e))? {
            if chunk.len() > limit - bytes.len() {
                return Err(TransportError::BodyTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        if status == StatusCode::FORBIDDEN || status == StatusCode::CONFLICT {
            return Err(match bytes.as_slice() {
                b"revoked" => TransportError::Revoked,
                b"left" => TransportError::Left,
                b"closed" => TransportError::Closed,
                b"credential_replaced" => TransportError::CredentialReplaced,
                b"master_required" => TransportError::MasterRequired,
                b"master_cannot_leave" => TransportError::MasterCannotLeave,
                b"operation_mismatch" => TransportError::OperationMismatch,
                _ => TransportError::MalformedResponse,
            });
        }
        check_status(status, StatusCode::OK)?;
        Ok(bytes)
    }
}

fn valid_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_status(actual: StatusCode, expected: StatusCode) -> Result<(), TransportError> {
    if actual == expected {
        return Ok(());
    }
    Err(match actual {
        StatusCode::NOT_FOUND => TransportError::NotFound,
        StatusCode::PRECONDITION_FAILED => TransportError::Conflict,
        StatusCode::TOO_MANY_REQUESTS => TransportError::RateLimited,
        StatusCode::PAYLOAD_TOO_LARGE => TransportError::BodyTooLarge,
        code if code.is_server_error() => TransportError::ServerError,
        code => TransportError::UnexpectedStatus(code.as_u16()),
    })
}

fn map_reqwest(error: &reqwest::Error) -> TransportError {
    if error.is_timeout() {
        TransportError::Timeout
    } else if error.is_connect() {
        let detail = error.to_string().to_ascii_lowercase();
        if ["tls", "rustls", "certificate"]
            .iter()
            .any(|word| detail.contains(word))
        {
            TransportError::Tls
        } else {
            TransportError::Offline
        }
    } else if error.is_request() {
        TransportError::Offline
    } else {
        TransportError::MalformedResponse
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_validation() {
        for ok in [
            "https://sync.example.com",
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(SyncTransport::new(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://sync.example.com",
            "https://u:p@sync.example.com",
            "https://sync.example.com/base",
            "https://sync.example.com/?q=1",
            "https://sync.example.com/#f",
            "ftp://sync.example.com",
            "not a url",
        ] {
            assert!(SyncTransport::new(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn invalid_identity_is_rejected_before_sending() -> Result<(), TransportError> {
        let transport = SyncTransport::new("http://127.0.0.1:9")?;
        let group = "a".repeat(64);
        let token = "b".repeat(64);
        for (g, t, i) in [
            ("short", token.as_str(), None),
            (group.as_str(), "short", None),
            (group.as_str(), token.as_str(), Some("UPPER")),
        ] {
            assert_eq!(
                transport
                    .group(g, "snapshot", Method::GET, t, i, None)
                    .await,
                Err(TransportError::InvalidIdentity)
            );
        }
        assert_eq!(
            transport.invitation("zz", &token).await,
            Err(TransportError::InvalidIdentity)
        );
        assert_eq!(
            transport.invitation(&"a".repeat(32), "short").await,
            Err(TransportError::InvalidIdentity)
        );
        Ok(())
    }

    #[test]
    fn statuses_map_to_categories() {
        assert_eq!(
            check_status(StatusCode::NOT_FOUND, StatusCode::OK),
            Err(TransportError::NotFound)
        );
        assert_eq!(
            check_status(StatusCode::PRECONDITION_FAILED, StatusCode::OK),
            Err(TransportError::Conflict)
        );
        assert_eq!(
            check_status(StatusCode::SERVICE_UNAVAILABLE, StatusCode::OK),
            Err(TransportError::ServerError)
        );
        assert_eq!(check_status(StatusCode::OK, StatusCode::OK), Ok(()));
    }
}
