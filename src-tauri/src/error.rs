use reqwest::StatusCode;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    InvalidInput,
    UnknownSource,
    UnavailableSource,
    NotFound,
    RateLimited,
    UpstreamForbidden,
    UpstreamRateLimited,
    Timeout,
    Network,
    InvalidResponse,
    ImageTooLarge,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip)]
    upstream_status: Option<StatusCode>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            upstream_status: None,
        }
    }

    pub fn upstream(context: &str, status: StatusCode) -> Self {
        let kind = match status {
            StatusCode::NOT_FOUND => ErrorKind::NotFound,
            StatusCode::FORBIDDEN => ErrorKind::UpstreamForbidden,
            StatusCode::TOO_MANY_REQUESTS => ErrorKind::UpstreamRateLimited,
            _ => ErrorKind::InvalidResponse,
        };
        Self {
            kind,
            message: format!("{context} returned status {}", status.as_u16()),
            upstream_status: Some(status),
        }
    }

    pub fn network(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::new(ErrorKind::Timeout, "The source timed out")
        } else {
            Self::new(ErrorKind::Network, "The source could not be reached")
        }
    }

    pub fn is_upstream_status(&self, status: StatusCode) -> bool {
        self.upstream_status == Some(status)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_upstream_statuses_without_exposing_internals() {
        assert_eq!(
            AppError::upstream("Prnt.sc", StatusCode::NOT_FOUND).kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            AppError::upstream("Prnt.sc", StatusCode::FORBIDDEN).kind,
            ErrorKind::UpstreamForbidden
        );
        assert_eq!(
            AppError::upstream("Prnt.sc", StatusCode::TOO_MANY_REQUESTS).kind,
            ErrorKind::UpstreamRateLimited
        );
        assert_eq!(
            AppError::upstream("Prnt.sc", StatusCode::BAD_GATEWAY).kind,
            ErrorKind::InvalidResponse
        );
    }
}
