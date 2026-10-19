use crate::error::{AppError, ErrorKind};
use std::time::Instant;

const CAPACITY: f64 = 8.0;
const REFILL_PER_SECOND: f64 = 3.0;

pub struct RateLimiter {
    tokens: f64,
    updated_at: Instant,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            tokens: CAPACITY,
            updated_at: Instant::now(),
        }
    }

    fn take_at(&mut self, now: Instant) -> Result<(), AppError> {
        self.tokens = (self.tokens
            + now.duration_since(self.updated_at).as_secs_f64() * REFILL_PER_SECOND)
            .min(CAPACITY);
        self.updated_at = now;
        if self.tokens < 1.0 {
            return Err(AppError::new(
                ErrorKind::RateLimited,
                "Too many requests. Please try again shortly.",
            ));
        }
        self.tokens -= 1.0;
        Ok(())
    }

    pub fn delay_until_token(&self, now: Instant) -> std::time::Duration {
        let tokens = (self.tokens
            + now.saturating_duration_since(self.updated_at).as_secs_f64() * REFILL_PER_SECOND)
            .min(CAPACITY);
        std::time::Duration::from_secs_f64(((1.0 - tokens) / REFILL_PER_SECOND).max(0.0))
    }
    pub fn take(&mut self) -> Result<(), AppError> {
        self.take_at(Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn enforces_capacity_and_refills_three_tokens_per_second() {
        let start = Instant::now();
        let mut limiter = RateLimiter {
            tokens: CAPACITY,
            updated_at: start,
        };
        for _ in 0..8 {
            assert!(limiter.take_at(start).is_ok());
        }
        assert!(matches!(
            limiter.take_at(start),
            Err(AppError {
                kind: ErrorKind::RateLimited,
                ..
            })
        ));
        assert!(limiter.take_at(start + Duration::from_millis(334)).is_ok());
        assert!(matches!(
            limiter.take_at(start + Duration::from_millis(334)),
            Err(AppError {
                kind: ErrorKind::RateLimited,
                ..
            })
        ));
    }
}

#[cfg(test)]
mod nearby_tests {
    use super::*;
    #[test]
    fn local_admission_delay_does_not_consume_tokens() {
        let at = Instant::now();
        let mut limiter = RateLimiter {
            tokens: 0.0,
            updated_at: at,
        };
        assert!((limiter.delay_until_token(at).as_secs_f64() - 1.0 / 3.0).abs() < 0.000_001);
        assert!(limiter
            .delay_until_token(at + std::time::Duration::from_millis(334))
            .is_zero());
        assert_eq!(limiter.tokens, 0.0);
        assert!(limiter
            .take_at(at + std::time::Duration::from_millis(334))
            .is_ok());
    }
}
