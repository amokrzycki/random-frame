use reqwest::StatusCode;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    InvalidInput,
    #[serde(rename = "stale_saved_frame")]
    StaleSavedFrame,
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
    NoNewFrame,
    Persistence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip)]
    upstream_status: Option<StatusCode>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            upstream_status: None,
            retry_after_ms: None,
        }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidInput, message)
    }

    pub fn persistence(error: impl fmt::Display) -> Self {
        let message = format!("Application data could not be saved: {error}");
        Self::new(ErrorKind::Persistence, message)
    }

    pub fn upstream(context: &str, status: StatusCode) -> Self {
        let kind = match status {
            StatusCode::NOT_FOUND | StatusCode::GONE => ErrorKind::NotFound,
            StatusCode::FORBIDDEN => ErrorKind::UpstreamForbidden,
            StatusCode::TOO_MANY_REQUESTS => ErrorKind::UpstreamRateLimited,
            _ => ErrorKind::InvalidResponse,
        };
        Self {
            kind,
            message: format!("{context} returned status {}", status.as_u16()),
            upstream_status: Some(status),
            retry_after_ms: None,
        }
    }

    pub fn upstream_response(context: &str, response: &reqwest::Response) -> Self {
        let mut error = Self::upstream(context, response.status());
        error.retry_after_ms = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|value| {
                value
                    .parse::<u64>()
                    .ok()
                    .and_then(|seconds| seconds.checked_mul(1000))
                    .or_else(|| {
                        chrono::DateTime::parse_from_rfc2822(value)
                            .ok()
                            .and_then(|date| {
                                u64::try_from(
                                    date.timestamp_millis()
                                        .saturating_sub(chrono::Utc::now().timestamp_millis())
                                        .max(0),
                                )
                                .ok()
                            })
                    })
            });
        error
    }
    pub fn network(error: reqwest::Error) -> Self {
        let is_timeout = error.is_timeout();
        drop(error);
        if is_timeout {
            Self::new(ErrorKind::Timeout, "The source timed out")
        } else {
            Self::new(ErrorKind::Network, "The source could not be reached")
        }
    }

    pub fn is_upstream_status(&self, status: StatusCode) -> bool {
        self.upstream_status == Some(status)
    }

    pub fn is_classified_source_outcome(&self) -> bool {
        self.kind == ErrorKind::NotFound
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

#[cfg(test)]
mod nearby_outcome_tests {
    use super::*;
    #[test]
    fn only_confirmed_missing_classifies_not_parser_or_preview_policy() {
        for kind in [
            ErrorKind::InvalidResponse,
            ErrorKind::ImageTooLarge,
            ErrorKind::Network,
            ErrorKind::Timeout,
        ] {
            assert!(!AppError::new(kind, "preview failed").is_classified_source_outcome());
        }
        assert!(AppError::upstream("source", StatusCode::GONE).is_classified_source_outcome());
    }
}
