use crate::error::{AppError, ErrorKind};
use rand::{distributions::Uniform, Rng};

const BASE36_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

// Empirically determined practical upper bound of the legacy
// sequential base-36 Lightshot namespace.
// 26y3ahr is the last confirmed assigned ID found during boundary probing.
const LEGACY_MAX_ID: &str = "26y3ahr";
const LEGACY_MAX_VALUE: u64 = 4_773_622_239;

pub(super) fn make_id() -> String {
    let mut random = rand::thread_rng();
    let range = Uniform::new_inclusive(0u64, LEGACY_MAX_VALUE);
    value_to_base36(random.sample(range))
}

fn value_to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(BASE36_ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits)
        .unwrap_or_else(|invalid| String::from_utf8_lossy(invalid.as_bytes()).into_owned())
}

fn base36_to_value(id: &str) -> Option<u64> {
    id.bytes().try_fold(0u64, |value, byte| {
        let digit = match byte {
            b'0'..=b'9' => u64::from(byte - b'0'),
            b'a'..=b'z' => u64::from(byte - b'a') + 10,
            _ => return None,
        };
        value.checked_mul(36)?.checked_add(digit)
    })
}

pub fn validate_item_id(id: &str) -> Result<(), AppError> {
    item_id_value(id).map(drop)
}

pub(super) fn item_id_value(id: &str) -> Result<u64, AppError> {
    if !id.is_empty() && id.len() <= LEGACY_MAX_ID.len() {
        if let Some(value) = base36_to_value(id).filter(|value| *value <= LEGACY_MAX_VALUE) {
            return Ok(value);
        }
    }
    Err(AppError::new(
        ErrorKind::InvalidInput,
        "Invalid image identifier",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_variable_length_legacy_base36_ids() {
        assert!(validate_item_id("abc123").is_ok());
        assert!(validate_item_id("abc12").is_ok());
        assert!(validate_item_id(LEGACY_MAX_ID).is_ok());
        for invalid in [
            "26y3ahs", "26y3ahz", "zzzzzzz", "ABC123", "abc-12", "ąbc123", "",
        ] {
            assert!(matches!(
                validate_item_id(invalid),
                Err(AppError {
                    kind: ErrorKind::InvalidInput,
                    ..
                })
            ));
        }
    }

    #[test]
    fn base36_conversions_match_known_boundary_values() {
        assert!(matches!(
            (
                base36_to_value("8aupm6"),
                base36_to_value(LEGACY_MAX_ID)
            ),
            (Some(lower), Some(upper)) if lower < upper
        ));
        assert_eq!(base36_to_value(LEGACY_MAX_ID), Some(LEGACY_MAX_VALUE));
        assert_eq!(value_to_base36(LEGACY_MAX_VALUE), LEGACY_MAX_ID);
        assert_eq!(value_to_base36(LEGACY_MAX_VALUE + 1), "26y3ahs");
    }

    #[test]
    fn value_to_base36_never_pads() {
        assert_eq!(value_to_base36(0), "0");
        assert_eq!(value_to_base36(35), "z");
        assert_eq!(value_to_base36(36), "10");
    }

    #[test]
    fn legacy_id_generator_stays_in_bound_lowercase_and_unpadded() {
        let mut saw_seven_char_id = false;
        for _ in 0..2000 {
            let id = make_id();
            assert!(id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
            assert!(id.len() <= LEGACY_MAX_ID.len());
            assert!(matches!(
                base36_to_value(&id),
                Some(value) if value <= LEGACY_MAX_VALUE
            ));
            if id.len() == LEGACY_MAX_ID.len() {
                saw_seven_char_id = true;
            }
        }
        assert!(
            saw_seven_char_id,
            "expected at least one 7-char id in 2000 samples"
        );
    }
}
