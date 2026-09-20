use regex::Regex;
use reqwest::Url;
use std::sync::OnceLock;

pub fn is_allowed_image_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && matches!(url.host_str(), Some("image.prntscr.com" | "i.imgur.com"))
    })
}

pub fn extract_image_url(html: &str) -> Option<String> {
    static PATTERNS: OnceLock<Result<Vec<Regex>, regex::Error>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r#"(?i)<img[^>]+id=["']screenshot-image["'][^>]+src=["']([^"']+)["']"#,
            r#"(?i)<img[^>]+src=["']([^"']+)["'][^>]+id=["']screenshot-image["']"#,
            r#"(?i)<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']"#,
            r#"(?i)<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']"#,
        ]
        .into_iter()
        .map(Regex::new)
        .collect()
    });
    let patterns = patterns.as_ref().ok()?;
    patterns.iter().find_map(|pattern| {
        let value = pattern.captures(html)?.get(1)?.as_str();
        let decoded = value
            .replace("&amp;", "&")
            .replace("&#x2F;", "/")
            .replace("&#47;", "/");
        is_allowed_image_url(&decoded).then_some(decoded)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_known_https_image_hosts() {
        assert!(is_allowed_image_url("https://i.imgur.com/example.png"));
        assert!(is_allowed_image_url(
            "https://image.prntscr.com/image/example.png"
        ));
        assert!(!is_allowed_image_url(
            "http://image.prntscr.com/example.png"
        ));
        assert!(!is_allowed_image_url(
            "https://image.prntscr.com.evil.example/image.png"
        ));
        assert!(!is_allowed_image_url("not a url"));
    }

    #[test]
    fn extracts_screenshot_or_open_graph_image_in_either_attribute_order() {
        let cases = [
            r#"<img id="screenshot-image" src="https://i.imgur.com/a.png">"#,
            r#"<img src="https://i.imgur.com/b.png" id="screenshot-image">"#,
            r#"<meta property="og:image" content="https://image.prntscr.com/a.png?x=1&amp;y=2">"#,
            r#"<meta content="https://image.prntscr.com/b.png" property="og:image">"#,
        ];
        assert_eq!(
            extract_image_url(cases[0]),
            Some("https://i.imgur.com/a.png".into())
        );
        assert_eq!(
            extract_image_url(cases[1]),
            Some("https://i.imgur.com/b.png".into())
        );
        assert_eq!(
            extract_image_url(cases[2]),
            Some("https://image.prntscr.com/a.png?x=1&y=2".into())
        );
        assert_eq!(
            extract_image_url(cases[3]),
            Some("https://image.prntscr.com/b.png".into())
        );
        assert_eq!(
            extract_image_url(r#"<meta property="og:image" content="https://evil.example/a.png">"#),
            None
        );
        assert_eq!(
            extract_image_url(r#"<META PROPERTY="OG:IMAGE" CONTENT="https://i.imgur.com/c.png">"#),
            Some("https://i.imgur.com/c.png".into())
        );
    }
}
