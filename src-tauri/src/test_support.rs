//! Shared loopback fixture helpers for tests that stand in for the image source.
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApplicationRequest {
    Page,
    Asset,
}

/// Recognises only the source's own `GET /page/<id>` and `GET /asset/<id>` requests. Local
/// software probes freshly opened loopback ports (bare `GET /`, TLS `ClientHello`), so neither
/// counting connections nor letting the first arrival pick a fixture response is stable.
pub(crate) fn application_request(request: &str) -> Option<(ApplicationRequest, &str)> {
    let mut parts = request.lines().next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let path = parts.next()?;
    let (kind, id) = if let Some(id) = path.strip_prefix("/page/") {
        (ApplicationRequest::Page, id)
    } else {
        (ApplicationRequest::Asset, path.strip_prefix("/asset/")?)
    };
    (!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric())).then_some((kind, id))
}

/// Sends what real port scanners were observed to send and waits for the reply, so the fixture has
/// recorded the request before this returns. Bounded so a fixture regression fails instead of
/// hanging the suite.
pub(crate) async fn probe(address: &str) -> std::io::Result<()> {
    for payload in [
        &b"GET / HTTP/1.1\r\nhost: localhost\r\nuser-agent: node\r\n\r\n"[..],
        &[
            0x16, 0x03, 0x01, 0x05, 0xc8, 0x01, 0x00, 0x05, 0xc4, 0x03, 0x03,
        ][..],
    ] {
        let mut stream = TcpStream::connect(address).await?;
        stream.write_all(payload).await?;
        let mut reply = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.read_to_end(&mut reply),
        )
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "fixture probe timed out")
        })??;
    }
    Ok(())
}

#[test]
fn recognises_only_application_requests() {
    assert_eq!(
        application_request("GET /page/abc123 HTTP/1.1\r\n"),
        Some((ApplicationRequest::Page, "abc123"))
    );
    assert_eq!(
        application_request("GET /asset/abc123 HTTP/1.1\r\n"),
        Some((ApplicationRequest::Asset, "abc123"))
    );
    for foreign in [
        "GET / HTTP/1.1\r\nuser-agent: node\r\n",
        "GET /page/ HTTP/1.1\r\n",
        "GET /page/abc123?probe=1 HTTP/1.1\r\n",
        "POST /page/abc123 HTTP/1.1\r\n",
        "\u{16}\u{3}\u{1}\u{5}",
        "",
    ] {
        assert_eq!(application_request(foreign), None, "{foreign:?}");
    }
}
