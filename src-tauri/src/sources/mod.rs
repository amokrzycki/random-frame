pub mod prntsc;

use crate::error::{AppError, ErrorKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Prntsc,
    InternetArchive,
}

impl Source {
    pub fn id(self) -> &'static str {
        match self {
            Self::Prntsc => "prntsc",
            Self::InternetArchive => "internet-archive",
        }
    }

    fn available(self) -> bool {
        matches!(self, Self::Prntsc)
    }
}

const SOURCES: [Source; 2] = [Source::Prntsc, Source::InternetArchive];

pub fn select_source(requested: &str) -> Result<Source, AppError> {
    select_source_with(requested, rand::random())
}

fn select_source_with(requested: &str, random: f64) -> Result<Source, AppError> {
    if requested == "mixed" {
        let available: Vec<_> = SOURCES
            .iter()
            .copied()
            .filter(|source| source.available())
            .collect();
        if available.is_empty() {
            return Err(AppError::new(
                ErrorKind::UnavailableSource,
                "No sources are currently available",
            ));
        }
        return Ok(available[((random * available.len() as f64) as usize).min(available.len() - 1)]);
    }

    let source = SOURCES
        .iter()
        .copied()
        .find(|source| source.id() == requested)
        .ok_or_else(|| {
            AppError::new(
                ErrorKind::UnknownSource,
                format!("Unknown source: {requested}"),
            )
        })?;
    if !source.available() {
        return Err(AppError::new(
            ErrorKind::UnavailableSource,
            format!("{} source is not available yet", source.id()),
        ));
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_explicit_unknown_and_unavailable_sources() {
        assert_eq!(select_source_with("prntsc", 0.5).unwrap(), Source::Prntsc);
        assert_eq!(
            select_source_with("unknown", 0.5).unwrap_err().kind,
            ErrorKind::UnknownSource
        );
        assert_eq!(
            select_source_with("internet-archive", 0.5)
                .unwrap_err()
                .kind,
            ErrorKind::UnavailableSource
        );
    }

    #[test]
    fn mixed_selects_only_available_sources() {
        assert_eq!(select_source_with("mixed", 0.0).unwrap(), Source::Prntsc);
        assert_eq!(select_source_with("mixed", 0.99).unwrap(), Source::Prntsc);
    }
}
