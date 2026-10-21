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

pub fn select_source(requested: &str) -> Result<Source, AppError> {
    let source = match requested {
        "prntsc" | "mixed" => Source::Prntsc,
        "internet-archive" => Source::InternetArchive,
        _ => {
            return Err(AppError::new(
                ErrorKind::UnknownSource,
                format!("Unknown source: {requested}"),
            ));
        }
    };
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
        assert!(matches!(select_source("prntsc"), Ok(Source::Prntsc)));
        assert!(matches!(
            select_source("unknown"),
            Err(AppError {
                kind: ErrorKind::UnknownSource,
                ..
            })
        ));
        assert!(matches!(
            select_source("internet-archive"),
            Err(AppError {
                kind: ErrorKind::UnavailableSource,
                ..
            })
        ));
    }

    #[test]
    fn mixed_routes_only_to_the_prntsc_exploration_pipeline() {
        assert!(matches!(select_source("mixed"), Ok(Source::Prntsc)));
    }
}
