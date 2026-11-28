//! The server log: lines on the console (unless the server runs in the background) and in `server.log` in the data folder.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use crate::util::iso_now;

/// `server.log` is moved to `server.old.log` once it grows past this.
const MAX_LOG_BYTES: u64 = 512 * 1024;

pub struct Logger {
    file: PathBuf,
    old_file: PathBuf,
    to_console: bool,
    guard: Mutex<()>,
}

impl Logger {
    pub fn new(data_dir: &Path, to_console: bool) -> Self {
        Self { file: data_dir.join("server.log"), old_file: data_dir.join("server.old.log"), to_console, guard: Mutex::new(()) }
    }

    pub fn log(&self, message: &str) {
        let line = format!("[{}] {message}", iso_now());
        if self.to_console {
            let _ = writeln!(io::stdout(), "{line}");
        }
        let _guard = self.guard.lock().unwrap_or_else(PoisonError::into_inner);
        // A logging failure must never take the server down.
        let _ = self.append(&line);
    }

    fn append(&self, line: &str) -> io::Result<()> {
        if fs::metadata(&self.file).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
            fs::rename(&self.file, &self.old_file)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&self.file)?;
        writeln!(file, "{line}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_get_a_utc_time_and_are_appended() {
        let dir = tempfile::tempdir().unwrap();
        let log = Logger::new(dir.path(), false);
        log.log("first");
        log.log("second");
        let text = fs::read_to_string(dir.path().join("server.log")).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with('[') && lines[0].ends_with("] first"), "{}", lines[0]);
        assert!(lines[1].ends_with("] second"));
    }

    #[test]
    fn a_big_log_is_moved_aside_and_a_new_one_started() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("server.log"), vec![b'x'; 600 * 1024]).unwrap();
        Logger::new(dir.path(), false).log("fresh");
        assert_eq!(fs::metadata(dir.path().join("server.old.log")).unwrap().len(), 600 * 1024);
        assert!(fs::read_to_string(dir.path().join("server.log")).unwrap().ends_with("fresh\n"));
    }

    #[test]
    fn a_log_that_cannot_be_written_does_not_stop_anything() {
        Logger::new(Path::new("/this/folder/does/not/exist"), false).log("nobody will read this");
    }
}
