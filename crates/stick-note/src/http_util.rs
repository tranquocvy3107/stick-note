//! Helpers shared by the HTTP handlers: building responses, reading request bodies and understanding addresses.

use bytes::{Bytes, BytesMut};
use http_body_util::{BodyExt, Full};
use hyper::Response;
use hyper::body::Incoming;
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE};
use hyper::http::response::Builder;
use serde::Serialize;
use serde_json::json;

pub type Reply = Response<Full<Bytes>>;

/// The Content-Security-Policy of the web page: scripts and styles only from the program itself.
pub const HTML_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// A response builder that already carries the security headers every answer has.
pub fn builder(status: u16) -> Builder {
    Response::builder()
        .status(status)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Frame-Options", "DENY")
        .header("Cross-Origin-Resource-Policy", "same-origin")
}

/// Finish a response. The headers are made here from known values, so this cannot fail in practice.
pub fn finish(builder: Builder, body: Bytes) -> Reply {
    builder.body(Full::new(body)).unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"Internal server error"))))
}

pub fn json_bytes(status: u16, body: Vec<u8>) -> Reply {
    let length = body.len();
    finish(
        builder(status).header(CONTENT_TYPE, "application/json; charset=utf-8").header(CONTENT_LENGTH, length).header(CACHE_CONTROL, "no-store"),
        Bytes::from(body),
    )
}

pub fn json<T: Serialize>(status: u16, value: &T) -> Reply {
    json_bytes(status, serde_json::to_vec(value).unwrap_or_default())
}

/// Errors are language-neutral: `error` is a stable code the interface translates, `message` is an English
/// explanation for logs and developers.
pub fn error(status: u16, code: &str, message: &str) -> Reply {
    json(status, &json!({ "error": code, "message": message }))
}

pub fn text(status: u16, text: &str) -> Reply {
    finish(
        builder(status).header(CONTENT_TYPE, "text/plain; charset=utf-8").header(CONTENT_LENGTH, text.len()).header(CACHE_CONTROL, "no-store"),
        Bytes::from(text.to_string()),
    )
}

pub fn server_error() -> Reply {
    error(500, "server_error", "Internal server error")
}

// ---- request bodies ---------------------------------------------------------

#[derive(Debug)]
pub enum BodyError {
    TooLarge,
    Failed(String),
}

impl BodyError {
    pub fn reply(&self) -> Reply {
        match self {
            Self::TooLarge => error(413, "payload_too_large", "Request body is too large"),
            Self::Failed(why) => error(400, "bad_request", why),
        }
    }
}

/// How much more than the limit is read and thrown away before giving up on a client that keeps sending.
const DRAIN_EXTRA: usize = 256 * 1024 * 1024;

/// Read a request body, refusing once it grows past `limit` bytes. A body that is too large is still read to the
/// end (and thrown away) so the client receives the answer instead of a broken connection.
pub async fn read_body(mut body: Incoming, limit: usize) -> Result<Bytes, BodyError> {
    let mut buf = BytesMut::new();
    let mut total = 0usize;
    let mut too_large = false;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| BodyError::Failed(e.to_string()))?;
        let Ok(data) = frame.into_data() else { continue };
        total += data.len();
        if total > limit {
            if !too_large {
                too_large = true;
                buf = BytesMut::new();
            }
            if total > limit + DRAIN_EXTRA {
                break;
            }
        } else {
            buf.extend_from_slice(&data);
        }
    }
    if too_large { Err(BodyError::TooLarge) } else { Ok(buf.freeze()) }
}

// ---- addresses ---------------------------------------------------------------

/// What `new URL(target, base).pathname` makes of the path of a request for an http address: backslashes count as
/// slashes, and dot segments (also when written `%2e`) are resolved. The result is still percent-encoded.
pub fn normalize_pathname(raw: &str) -> String {
    let slashed = raw.replace('\\', "/");
    let segments: Vec<&str> = slashed.split('/').collect();
    let last = segments.len() - 1;
    let mut out: Vec<&str> = Vec::new();
    for (i, segment) in segments.iter().enumerate().skip(1) {
        let lower = segment.to_ascii_lowercase();
        match lower.as_str() {
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                out.pop();
                if i == last {
                    out.push("");
                }
            }
            "." | "%2e" => {
                if i == last {
                    out.push("");
                }
            }
            _ => out.push(segment),
        }
    }
    format!("/{}", out.join("/"))
}

/// `decodeURIComponent`: `None` for a broken escape (a `%` without two hex digits) or bytes that are not UTF-8.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = char::from(*bytes.get(i + 1)?).to_digit(16)?;
            let lo = char::from(*bytes.get(i + 2)?).to_digit(16)?;
            out.push(u8::try_from(hi * 16 + lo).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `url.searchParams.get(name)`: the first value, decoded.
pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query?.as_bytes()).find(|(key, _)| key == name).map(|(_, value)| value.into_owned())
}

/// The type of a file by its extension (case does not matter).
pub fn mime_of(name: &str) -> &'static str {
    let ext = name.rfind('.').map(|i| name[i..].to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        ".html" => "text/html; charset=utf-8",
        ".js" | ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".webmanifest" => "application/manifest+json",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".ico" => "image/x-icon",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_normalised_like_a_browser_does() {
        for (raw, expected) in [
            ("/", "/"),
            ("/js/main.js", "/js/main.js"),
            ("/js/../css/app.css", "/css/app.css"),
            ("/./js/main.js", "/js/main.js"),
            ("/js/%2e%2e/css/app.css", "/css/app.css"),
            ("/js/%2E%2E/css/app.css", "/css/app.css"),
            ("/js/.%2e/css/app.css", "/css/app.css"),
            ("/..", "/"),
            ("/../package.json", "/package.json"),
            ("/a/b/..", "/a/"),
            ("/a/b/.", "/a/b/"),
            ("/a//b", "/a//b"),
            ("/a\\b", "/a/b"),
            ("/..%5cpackage.json", "/..%5cpackage.json"),
            ("/..%2fpackage.json", "/..%2fpackage.json"),
            ("/img/%2e%2e%2fboard.json", "/img/%2e%2e%2fboard.json"),
            ("/api/ping/", "/api/ping/"),
        ] {
            assert_eq!(normalize_pathname(raw), expected, "{raw}");
        }
    }

    #[test]
    fn percent_escapes_are_decoded_like_decodeuricomponent() {
        assert_eq!(decode_uri_component("abc").as_deref(), Some("abc"));
        assert_eq!(decode_uri_component("a%20b%2Fc").as_deref(), Some("a b/c"));
        assert_eq!(decode_uri_component("Vi%E1%BB%87t").as_deref(), Some("Việt"));
        assert_eq!(decode_uri_component("%00").as_deref(), Some("\0"));
        assert_eq!(decode_uri_component("100%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%4"), None);
        assert_eq!(decode_uri_component("%E1%BB"), None, "cut off in the middle of a character");
        assert_eq!(decode_uri_component("%C0%AF"), None, "an overlong encoding");
        assert_eq!(decode_uri_component("a+b").as_deref(), Some("a+b"), "a plus is a plus in a path");
    }

    #[test]
    fn query_values_are_decoded_and_the_first_one_wins() {
        assert_eq!(query_param(Some("w=abc123"), "w").as_deref(), Some("abc123"));
        assert_eq!(query_param(Some("x=1&w=a%20b+c&w=second"), "w").as_deref(), Some("a b c"));
        assert_eq!(query_param(Some("w="), "w").as_deref(), Some(""));
        assert_eq!(query_param(Some("w"), "w").as_deref(), Some(""));
        assert_eq!(query_param(Some("other=1"), "w"), None);
        assert_eq!(query_param(None, "w"), None);
        assert_eq!(query_param(Some("w=%zz"), "w").as_deref(), Some("%zz"), "a broken escape stays as it is");
    }

    #[test]
    fn file_types_follow_the_extension_in_any_case() {
        assert_eq!(mime_of("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime_of("js/MAIN.JS"), "text/javascript; charset=utf-8");
        assert_eq!(mime_of("abc.thumb.png"), "image/png");
        assert_eq!(mime_of("photo.jpg"), "image/jpeg");
        assert_eq!(mime_of("noextension"), "application/octet-stream");
        assert_eq!(mime_of("data.bin"), "application/octet-stream");
    }

    #[test]
    fn answers_carry_the_security_headers_and_the_right_lengths() {
        let reply = error(403, "bad_origin", "Origin not allowed");
        assert_eq!(reply.status(), 403);
        let h = reply.headers();
        assert_eq!(h["content-type"], "application/json; charset=utf-8");
        assert_eq!(h["cache-control"], "no-store");
        assert_eq!(h["x-content-type-options"], "nosniff");
        assert_eq!(h["x-frame-options"], "DENY");
        assert_eq!(h["referrer-policy"], "no-referrer");
        assert_eq!(h["cross-origin-resource-policy"], "same-origin");
        let expected = br#"{"error":"bad_origin","message":"Origin not allowed"}"#;
        assert_eq!(h["content-length"], expected.len().to_string().as_str());
        let t = text(404, "Not found");
        assert_eq!(t.headers()["content-type"], "text/plain; charset=utf-8");
        assert_eq!(t.headers()["content-length"], "9");
    }
}
