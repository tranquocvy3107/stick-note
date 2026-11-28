//! Starting, finding and stopping the app: the background server, the app window and browser detection.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::paths::{APP_ID, Env, Platform, join_with};
use crate::winui;

// ---- talking to a running server ------------------------------------------------

struct Answer {
    body: Vec<u8>,
}

/// One small HTTP request to the server on this computer. (The program needs no HTTP client library for this.)
fn request(port: u16, method: &str, path: &str, headers: &str, timeout: Duration) -> io::Result<Answer> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let length = if method == "GET" { "" } else { "Content-Length: 0\r\n" };
    // One write, so the server sees the whole request at once.
    let head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{length}{headers}\r\n");
    stream.write_all(head.as_bytes())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no HTTP answer"))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let body = raw[split + 4..].to_vec();
    let body = if head.contains("transfer-encoding: chunked") { dechunk(&body) } else { body };
    Ok(Answer { body })
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") {
        let size = std::str::from_utf8(&data[..line_end])
            .ok()
            .and_then(|s| usize::from_str_radix(s.split(';').next().unwrap_or("").trim(), 16).ok())
            .unwrap_or(0);
        data = &data[line_end + 2..];
        if size == 0 || data.len() < size {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
    out
}

/// True when a Stick Note server answers on this port.
pub fn probe(port: u16) -> bool {
    request(port, "GET", "/api/ping", "", Duration::from_millis(800))
        .ok()
        .and_then(|answer| serde_json::from_slice::<Value>(&answer.body).ok())
        .is_some_and(|json| json.get("app").and_then(Value::as_str) == Some(APP_ID))
}

/// Keep asking `done` until it says yes or `ms` milliseconds have passed.
pub fn wait_for(mut done: impl FnMut() -> bool, ms: u64) -> bool {
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end {
        if done() {
            return true;
        }
        sleep(Duration::from_millis(150));
    }
    false
}

/// Ask a running server to quit gracefully. True when nothing is listening any more.
pub fn stop_running(port: u16) -> bool {
    if request(port, "POST", "/api/shutdown", "X-Stick-Note: 1\r\n", Duration::from_secs(3)).is_err() {
        return false;
    }
    wait_for(|| !probe(port), 5000)
}

// ---- starting programs -----------------------------------------------------------

#[cfg(windows)]
const DETACHED: u32 = 0x0000_0008 | 0x0000_0200; // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
#[cfg(windows)]
const HIDDEN: u32 = 0x0800_0000 | 0x0000_0200; // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP

fn detach(command: &mut Command, hidden_console: bool) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(if hidden_console { HIDDEN } else { DETACHED });
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = hidden_console;
        command.process_group(0);
    }
}

fn start(command: &mut Command, hidden_console: bool) -> io::Result<std::process::Child> {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    detach(command, hidden_console);
    winui::protect_std_handles();
    command.spawn()
}

/// Start a program that keeps running on its own (a browser window, the file manager). It is not waited for, but
/// something collects its exit status so no zombie is left behind.
pub fn spawn_detached(command: &mut Command) -> io::Result<()> {
    let mut child = start(command, false)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Start the background server (it exits by itself once no window is open) and wait until it answers.
/// False when it does not come up in ten seconds or stops with an error first.
pub fn start_background(port: u16) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let Ok(mut child) = start(Command::new(exe).arg("--bg"), false) else { return false };
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if probe(port) {
            return true;
        }
        // It may have stopped for good, for example because another program is using the port. (A clean exit
        // means another copy had just finished starting, which the next probe will find.)
        if let Ok(Some(status)) = child.try_wait()
            && !status.success()
        {
            return false;
        }
        sleep(Duration::from_millis(150));
    }
    false
}

// ---- the app window ---------------------------------------------------------------

// Chromium-based browsers can open a page as a bare app window (--app). Order = preference.
const WINDOWS_BROWSERS: [(&str, &str); 8] = [
    ("ProgramFiles(x86)", "Microsoft/Edge/Application/msedge.exe"),
    ("ProgramFiles", "Microsoft/Edge/Application/msedge.exe"),
    ("LOCALAPPDATA", "Microsoft/Edge/Application/msedge.exe"),
    ("ProgramFiles", "Google/Chrome/Application/chrome.exe"),
    ("ProgramFiles(x86)", "Google/Chrome/Application/chrome.exe"),
    ("LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"),
    ("ProgramFiles", "BraveSoftware/Brave-Browser/Application/brave.exe"),
    ("LOCALAPPDATA", "BraveSoftware/Brave-Browser/Application/brave.exe"),
];

const MAC_BROWSERS: [&str; 4] = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const LINUX_COMMANDS: [&str; 12] = [
    "google-chrome-stable",
    "google-chrome",
    "microsoft-edge-stable",
    "microsoft-edge",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "brave",
    "vivaldi-stable",
    "vivaldi",
    "chrome",
    "msedge",
];
const LINUX_DIRS: [&str; 5] = ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome", "/opt/microsoft/msedge"];

/// Find a Chromium-based browser that can show the app in its own window. `exists` can be replaced so the order of
/// the search can be tested without installing browsers. `None` means: fall back to the default browser.
pub fn find_browser(platform: Platform, env: Env, exists: &dyn Fn(&str) -> bool) -> Option<String> {
    if let Some(chosen) = env("STICK_NOTE_BROWSER").filter(|p| !p.is_empty())
        && exists(&chosen)
    {
        return Some(chosen);
    }
    match platform {
        Platform::Windows => WINDOWS_BROWSERS.iter().find_map(|(variable, relative)| {
            let base = env(variable).filter(|b| !b.is_empty())?;
            let mut parts = vec![base.as_str()];
            parts.extend(relative.split('/'));
            Some(join_with('\\', &parts)).filter(|candidate| exists(candidate))
        }),
        Platform::Mac => MAC_BROWSERS.iter().find(|p| exists(p)).map(|p| (*p).to_string()),
        Platform::Linux => {
            let path = env("PATH").unwrap_or_default();
            let dirs: Vec<&str> = path.split(':').filter(|d| !d.is_empty()).chain(LINUX_DIRS).collect();
            LINUX_COMMANDS
                .iter()
                .find_map(|name| dirs.iter().find_map(|dir| Some(join_with('/', &[dir, name])).filter(|candidate| exists(candidate))))
        }
    }
}

/// Open the app as its own window (no address bar, no tabs); fall back to the default browser.
pub fn open_window(url: &str, env: Env, platform: Platform) {
    if env("STICK_NOTE_NO_OPEN").is_some_and(|v| !v.is_empty()) {
        let _ = writeln!(io::stdout(), "OPEN {url}");
        return;
    }
    let failed = || {
        let _ = writeln!(io::stdout(), "Open {url} in your browser.");
    };
    if let Some(browser) = find_browser(platform, env, &|p| Path::new(p).exists()) {
        let mut command = Command::new(browser);
        command.arg(format!("--app={url}")).args(["--window-size=1440,900", "--no-first-run", "--no-default-browser-check"]);
        if spawn_detached(&mut command).is_err() {
            failed();
        }
        return;
    }
    let mut command = match platform {
        Platform::Windows => {
            let mut c = Command::new("cmd");
            c.args(["/c", "start", "", url]);
            c
        }
        Platform::Mac => {
            let mut c = Command::new("open");
            c.arg(url);
            c
        }
        Platform::Linux => {
            let mut c = Command::new("xdg-open");
            c.arg(url);
            c
        }
    };
    // `cmd` is a console program: give it a console nobody can see rather than none, or one would flash up.
    match start(&mut command, true) {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(_) => failed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::TcpListener;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    fn has<'a>(files: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p| files.contains(&p)
    }

    #[test]
    fn stick_note_browser_overrides_detection_when_the_file_exists() {
        let exists = has(&["/x/browser", "/usr/bin/chromium"]);
        assert_eq!(find_browser(Platform::Linux, &env_of(&[("STICK_NOTE_BROWSER", "/x/browser")]), &exists).as_deref(), Some("/x/browser"));
        let exists = has(&["/usr/bin/chromium"]);
        assert_eq!(find_browser(Platform::Linux, &env_of(&[("STICK_NOTE_BROWSER", "/x/missing")]), &exists).as_deref(), Some("/usr/bin/chromium"));
    }

    #[test]
    fn windows_prefers_edge_then_chrome() {
        let env = env_of(&[
            ("ProgramFiles", "C:\\Program Files"),
            ("ProgramFiles(x86)", "C:\\Program Files (x86)"),
            ("LOCALAPPDATA", "C:\\Users\\Ann\\AppData\\Local"),
        ]);
        let edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
        let chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        assert_eq!(find_browser(Platform::Windows, &env, &has(&[edge, chrome])).as_deref(), Some(edge));
        assert_eq!(find_browser(Platform::Windows, &env, &has(&[chrome])).as_deref(), Some(chrome));
        assert_eq!(find_browser(Platform::Windows, &env, &has(&[])), None);
        assert_eq!(find_browser(Platform::Windows, &env_of(&[]), &has(&[edge])), None, "without the folders there is nothing to look in");
    }

    #[test]
    fn linux_looks_through_path_and_the_usual_install_folders() {
        let at = |path: &str, files: &[&str]| find_browser(Platform::Linux, &env_of(&[("PATH", path)]), &has(files));
        assert_eq!(at("/home/ann/bin:/usr/bin", &["/home/ann/bin/chromium"]).as_deref(), Some("/home/ann/bin/chromium"));
        assert_eq!(
            at("/usr/bin", &["/usr/bin/chromium", "/usr/bin/google-chrome"]).as_deref(),
            Some("/usr/bin/google-chrome"),
            "Chrome is preferred over Chromium"
        );
        assert_eq!(at("", &["/snap/bin/chromium"]).as_deref(), Some("/snap/bin/chromium"), "snap installs are found even without PATH");
        assert_eq!(at("/usr/bin", &["/usr/bin/firefox"]), None, "Firefox cannot open an app window, so the default-browser fallback is used");
    }

    #[test]
    fn mac_looks_in_applications() {
        let edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
        assert_eq!(find_browser(Platform::Mac, &env_of(&[]), &has(&[edge])).as_deref(), Some(edge));
    }

    #[test]
    fn chunked_answers_are_put_together() {
        assert_eq!(dechunk(b"5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n"), b"hello world");
        assert_eq!(dechunk(b""), b"");
    }

    #[test]
    fn nothing_listening_means_not_running() {
        let free = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(!probe(free));
        assert!(!stop_running(free));
    }

    #[test]
    fn a_program_that_is_not_stick_note_is_not_taken_for_it() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for (body, _) in [(r#"{"app":"something-else"}"#, 0), ("not json", 1), (r#"{"app":"stick-note"}"#, 2)] {
                let (mut socket, _) = listener.accept().unwrap();
                // Read the whole request first: closing a socket with unread data makes Windows reset the connection.
                let mut seen = Vec::new();
                let mut buffer = [0u8; 256];
                while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0, "the client closed before finishing its request");
                    seen.extend_from_slice(&buffer[..n]);
                }
                let answer = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(answer.as_bytes()).unwrap();
            }
        });
        assert!(!probe(port), "another JSON service");
        assert!(!probe(port), "not JSON at all");
        assert!(probe(port), "the real thing");
        server.join().unwrap();
    }

    #[test]
    fn wait_for_gives_up_after_the_time_and_stops_early_on_success() {
        let started = Instant::now();
        assert!(!wait_for(|| false, 300));
        assert!(started.elapsed() >= Duration::from_millis(300));
        let mut calls = 0;
        assert!(wait_for(
            || {
                calls += 1;
                calls == 3
            },
            5000
        ));
        assert_eq!(calls, 3);
    }
}
