//! Small helpers: recognising images, time stamps in file names, and safe file writes.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::Duration;

use chrono::{DateTime, Local, SecondsFormat, TimeZone, Utc};

/// Identify an image by its first bytes (never by its file name or declared type).
/// Returns the file extension to store it under.
pub fn sniff_image(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        return Some("png");
    }
    if buf.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if buf.starts_with(b"GIF8") {
        return Some("gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// Local calendar day, e.g. `2026-11-27`.
pub fn local_day() -> String {
    day_of(Local::now())
}

/// Local time stamp that is safe in file names, e.g. `2026-11-27_09-41-05`.
pub fn stamp() -> String {
    stamp_of(Local::now())
}

pub fn day_of<Tz: TimeZone>(t: DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    t.format("%Y-%m-%d").to_string()
}

pub fn stamp_of<Tz: TimeZone>(t: DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    t.format("%Y-%m-%d_%H-%M-%S").to_string()
}

/// Now as an ISO 8601 time in UTC with milliseconds, e.g. `2026-11-27T09:41:05.123Z` (what `Date#toISOString` gives).
pub fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Milliseconds since the Unix epoch (what `Date.now()` gives).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temporary name next to `file`. The counter keeps two threads that write the same file from sharing one.
fn temp_name(file: &Path) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{}.{n}.tmp", std::process::id()));
    PathBuf::from(name)
}

/// Write a file safely: write to a temp file, fsync, then rename over the real file.
pub fn write_file_atomic(file: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = temp_name(file);
    let written = (|| {
        let mut f = File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()
    })();
    if let Err(err) = written {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    let mut attempt = 0u64;
    loop {
        match fs::rename(&tmp, file) {
            Ok(()) => return Ok(()),
            Err(err) => {
                if attempt >= 5 {
                    let _ = fs::remove_file(&tmp);
                    return Err(err);
                }
                // Cloud-sync clients and antivirus sometimes hold a file briefly.
                sleep(Duration::from_millis(40 * (attempt + 1)));
                attempt += 1;
            }
        }
    }
}

/// Lower-case hexadecimal text of some bytes.
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];

    #[test]
    fn sniff_image_detects_the_format_from_content_not_from_the_file_name() {
        assert_eq!(sniff_image(PNG), Some("png"));
        assert_eq!(sniff_image(&[0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), Some("jpg"));
        assert_eq!(sniff_image(b"GIF89a......"), Some("gif"));
        assert_eq!(sniff_image(b"RIFF....WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff_image(&[0, 0, 0]), None);
        assert_eq!(sniff_image(&PNG[..11]), None, "shorter than 12 bytes is never an image");
        assert_eq!(sniff_image(b"RIFF....WAVEfmt "), None);
    }

    #[test]
    fn times_look_like_the_ones_the_node_server_wrote() {
        let t = Utc.with_ymd_and_hms(2026, 11, 7, 9, 4, 5).unwrap();
        assert_eq!(day_of(t), "2026-11-07");
        assert_eq!(stamp_of(t), "2026-11-07_09-04-05");
        let iso = iso_now();
        assert_eq!(iso.len(), 24);
        assert!(iso.ends_with('Z') && iso.as_bytes()[10] == b'T' && iso.as_bytes()[19] == b'.', "{iso}");
    }

    #[test]
    fn hex_is_lower_case_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }

    #[test]
    fn an_atomic_write_replaces_the_file_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("board.json");
        write_file_atomic(&file, b"one").unwrap();
        write_file_atomic(&file, b"two").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"two");
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("board.json")]);
    }

    #[test]
    fn writing_into_a_missing_folder_fails_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_file_atomic(&dir.path().join("missing").join("x.json"), b"x").is_err());
    }

    #[test]
    fn two_writers_never_share_a_temp_file() {
        let file = Path::new("x.json");
        assert_ne!(temp_name(file), temp_name(file));
    }
}
