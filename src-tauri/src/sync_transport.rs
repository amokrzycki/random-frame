//! Opaque HTTP transport for the v1 sync protocol.

use reqwest::{header, Client, StatusCode, Url};
use std::{fmt, time::Duration};

pub const MAX_ENVELOPE: usize = 16_000_068;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    InvalidEndpoint,
    InvalidIdentity,
    Offline,
    Timeout,
    Tls,
    MalformedResponse,
    MissingChain,
    Conflict,
    RateLimited,
    ServerError,
    UnexpectedStatus(u16),
    BodyTooLarge,
    InvalidEtag,
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

pub fn parse_etag(value: Option<&header::HeaderValue>) -> Result<i64, TransportError> {
    let value = value.ok_or(TransportError::InvalidEtag)?;
    let bytes = value.as_bytes();
    if bytes.len() < 3 || bytes.first() != Some(&b'"') || bytes.last() != Some(&b'"') {
        return Err(TransportError::InvalidEtag);
    }
    let digits = &bytes[1..bytes.len() - 1];
    if digits.is_empty() || digits[0] == b'0' || !digits.iter().all(u8::is_ascii_digit) {
        return Err(TransportError::InvalidEtag);
    }
    std::str::from_utf8(digits)
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|revision| *revision > 0)
        .ok_or(TransportError::InvalidEtag)
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
        // 5s connect and 45s whole request: enough for a 16 MB upload on a modest link.
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| TransportError::InvalidEndpoint)?;
        Ok(Self { client, base })
    }

    fn url(&self, id: &str) -> Result<Url, TransportError> {
        if !lower_hex_64(id) {
            return Err(TransportError::InvalidIdentity);
        }
        self.base
            .join(&format!("sync/{id}"))
            .map_err(|_| TransportError::InvalidEndpoint)
    }

    fn request(
        &self,
        method: reqwest::Method,
        id: &str,
        token: &str,
    ) -> Result<reqwest::RequestBuilder, TransportError> {
        if !lower_hex_64(token) {
            return Err(TransportError::InvalidIdentity);
        }
        Ok(self
            .client
            .request(method, self.url(id)?)
            .bearer_auth(token))
    }

    pub async fn create(
        &self,
        id: &str,
        token: &str,
        envelope: Vec<u8>,
    ) -> Result<i64, TransportError> {
        self.put(id, token, "*", envelope, StatusCode::CREATED, true)
            .await
    }

    pub async fn update(
        &self,
        id: &str,
        token: &str,
        expected: i64,
        envelope: Vec<u8>,
    ) -> Result<i64, TransportError> {
        self.put(
            id,
            token,
            &format!("\"{expected}\""),
            envelope,
            StatusCode::NO_CONTENT,
            false,
        )
        .await
    }

    async fn put(
        &self,
        id: &str,
        token: &str,
        condition: &str,
        envelope: Vec<u8>,
        expected: StatusCode,
        create: bool,
    ) -> Result<i64, TransportError> {
        if envelope.len() > MAX_ENVELOPE {
            return Err(TransportError::BodyTooLarge);
        }
        let header_name = if create {
            header::IF_NONE_MATCH
        } else {
            header::IF_MATCH
        };
        let response = self
            .request(reqwest::Method::PUT, id, token)?
            .header(header_name, condition)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(envelope)
            .send()
            .await
            .map_err(|error| map_reqwest(&error))?;
        check_status(response.status(), expected)?;
        parse_etag(response.headers().get(header::ETAG))
    }

    pub async fn get(&self, id: &str, token: &str) -> Result<(i64, Vec<u8>), TransportError> {
        let mut response = self
            .request(reqwest::Method::GET, id, token)?
            .send()
            .await
            .map_err(|error| map_reqwest(&error))?;
        check_status(response.status(), StatusCode::OK)?;
        let revision = parse_etag(response.headers().get(header::ETAG))?;
        if response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            != Some("application/octet-stream")
        {
            return Err(TransportError::MalformedResponse);
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_ENVELOPE as u64)
        {
            return Err(TransportError::BodyTooLarge);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| map_reqwest(&error))?
        {
            if chunk.len() > MAX_ENVELOPE - body.len() {
                return Err(TransportError::BodyTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok((revision, body))
    }
}

fn check_status(actual: StatusCode, expected: StatusCode) -> Result<(), TransportError> {
    if actual == expected {
        return Ok(());
    }
    Err(match actual {
        StatusCode::NOT_FOUND => TransportError::MissingChain,
        StatusCode::PRECONDITION_FAILED => TransportError::Conflict,
        StatusCode::TOO_MANY_REQUESTS => TransportError::RateLimited,
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
    fn endpoint_and_etag_validation() {
        for url in [
            "https://sync.example.com",
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            assert!(SyncTransport::new(url).is_ok(), "{url}");
        }
        for url in [
            "http://sync.example.com",
            "https://a:b@example.com",
            "https://example.com/base",
            "not a url",
        ] {
            assert!(SyncTransport::new(url).is_err(), "{url}");
        }
        for valid in ["\"1\"", "\"42\""] {
            assert!(parse_etag(Some(
                &header::HeaderValue::from_str(valid).unwrap_or_else(|_| unreachable!())
            ))
            .is_ok());
        }
        for invalid in [
            "W/\"1\"",
            "\"0\"",
            "\"-1\"",
            "\"9223372036854775808\"",
            "\"1\", \"2\"",
            " \"1\"",
            "\"01\"",
            "1",
        ] {
            assert_eq!(
                parse_etag(Some(
                    &header::HeaderValue::from_str(invalid).unwrap_or_else(|_| unreachable!())
                )),
                Err(TransportError::InvalidEtag)
            );
        }
        assert_eq!(parse_etag(None), Err(TransportError::InvalidEtag));
    }
}
