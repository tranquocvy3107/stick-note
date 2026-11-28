//! The Stick Note server: the HTTP API, the web interface and the pictures.
//!
//! The routes, status codes, headers and error codes are the ones of the Node.js server this program replaces;
//! test/contract/ holds the tests that pin them down and run against both.

use std::convert::Infallible;
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use bytes::Bytes;
use hyper::body::Incoming;
use hyper::header::{self, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use hyper::http::request::Parts;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request};
use hyper_util::rt::{TokioIo, TokioTimer};
use rust_embed::RustEmbed;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::http_util::{
    HTML_CSP, Reply, builder, decode_uri_component, error, finish, json, json_bytes, mime_of, normalize_pathname, query_param, read_body,
    server_error, text,
};
use crate::jsnum;
use crate::launcher::spawn_detached;
use crate::logger::Logger;
use crate::paths::{APP_ID, BuildInfo, Platform, VERSION};
use crate::presence::Presence;
use crate::store::{MAX_BOARD_BYTES, MAX_IMAGE_BYTES, MAX_THUMB_BYTES, PutError, PutOutcome, Store, is_image_id, parse_put};
use crate::util::{hex, now_ms};

/// The web interface (the `public` folder of the repository). Release builds carry it inside the program; debug
/// builds read it from the folder, so editing the interface needs no rebuild.
#[derive(RustEmbed)]
#[folder = "../../public/"]
struct Assets;

pub struct ServerOptions {
    /// TCP port; 0 picks a free one (used by tests).
    pub port: u16,
    pub data_dir: PathBuf,
    /// Quit this long after the last window said goodbye (0 = never). See presence.rs.
    pub idle_exit_ms: u64,
    /// A window silent for this long is counted as gone.
    pub window_ttl_ms: u64,
    pub log_to_console: bool,
    /// Contents of build-info.json (how this copy was packaged).
    pub build_info: BuildInfo,
}

#[derive(Debug)]
pub enum StartError {
    PortInUse,
    Other(String),
}

struct App {
    port: u16,
    data_dir: PathBuf,
    store: Arc<Store>,
    log: Arc<Logger>,
    presence: Mutex<Presence>,
    build_info: BuildInfo,
    started: Instant,
    shutdown: Arc<Notify>,
}

static PANIC_LOG: OnceLock<Arc<Logger>> = OnceLock::new();

/// Make a panic leave a line in server.log, where someone looking for the reason can find it.
pub fn log_panics() {
    std::panic::set_hook(Box::new(|info| {
        let line = format!("panic: {info}");
        match PANIC_LOG.get() {
            Some(log) => log.log(&line),
            None => {
                use std::io::Write;
                let _ = writeln!(std::io::stderr(), "{line}");
            }
        }
    }));
}

/// Run the server until it is asked to quit (a shutdown request, the last window leaving, Ctrl+C).
/// `on_listening` is called with the port as soon as the server is ready for requests.
pub fn serve(options: ServerOptions, on_listening: impl FnOnce(u16)) -> Result<(), StartError> {
    let log = Arc::new(Logger::new(&options.data_dir, options.log_to_console));
    let _ = PANIC_LOG.set(log.clone());
    let store = Store::open(&options.data_dir, log.clone())
        .map(Arc::new)
        .map_err(|e| StartError::Other(format!("cannot open the data folder {}: {e}", options.data_dir.display())))?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(16)
        .enable_all()
        .build()
        .map_err(|e| StartError::Other(e.to_string()))?;

    let result = runtime.block_on(async {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], options.port))).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::AddrInUse => StartError::PortInUse,
            _ => StartError::Other(e.to_string()),
        })?;
        let port = listener.local_addr().map_err(|e| StartError::Other(e.to_string()))?.port();
        let shutdown = Arc::new(Notify::new());
        let app = Arc::new(App {
            port,
            data_dir: options.data_dir.clone(),
            store,
            log: log.clone(),
            // Starting counts as activity: the window that caused the start is about to say hello.
            presence: Mutex::new(Presence::new(options.idle_exit_ms, options.window_ttl_ms, now_ms())),
            build_info: options.build_info,
            started: Instant::now(),
            shutdown: shutdown.clone(),
        });

        if options.idle_exit_ms > 0 {
            tokio::spawn(idle_watch(app.clone(), options.idle_exit_ms));
        }
        tokio::spawn({
            let shutdown = shutdown.clone();
            async move {
                wait_for_signal().await;
                shutdown.notify_one();
            }
        });

        app.log.log(&format!("Stick Note {VERSION} is running at http://127.0.0.1:{port}/ (data: {})", app.data_dir.display()));
        on_listening(port);

        loop {
            tokio::select! {
                () = shutdown.notified() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let app = app.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |request| {
                            let app = app.clone();
                            async move { Ok::<_, Infallible>(app.handle(request).await) }
                        });
                        let connection = http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(30)).serve_connection(TokioIo::new(stream), service);
                        // A client that goes away in the middle of a request is not worth a log line.
                        let _ = connection.await;
                    });
                }
            }
        }
        Ok(())
    });
    // Do not wait for requests that are still running: the server was asked to quit.
    runtime.shutdown_background();
    if let Err(StartError::Other(why)) = &result {
        log.log(&format!("Could not start the server: {why}"));
    }
    result
}

/// Ask the server to quit when the last window has gone, checking often enough for the delay to be accurate.
async fn idle_watch(app: Arc<App>, idle_exit_ms: u64) {
    let tick_ms = (idle_exit_ms / 4).clamp(100, 10_000);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_millis(tick_ms), Duration::from_millis(tick_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_tick = now_ms();
    loop {
        interval.tick().await;
        let now = now_ms();
        let mut presence = app.presence.lock().unwrap_or_else(PoisonError::into_inner);
        // The computer just woke from sleep and the clock jumped: give the windows time to say hello again.
        if now.saturating_sub(last_tick) > (tick_ms * 3).max(30_000) {
            presence.wake(now);
        }
        last_tick = now;
        if presence.should_quit(now) {
            drop(presence);
            app.log.log("No window is open any more; shutting down.");
            app.shutdown.notify_one();
            return;
        }
    }
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = async {
                match terminate.as_mut() {
                    Some(t) => { t.recv().await; }
                    None => std::future::pending::<()>().await,
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Run blocking file work off the network threads. `None` when the work panicked.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(work).await.ok()
}

impl App {
    // ---- request checks ----

    fn allowed_hosts(&self) -> [String; 3] {
        let port = self.port;
        [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")]
    }

    fn host_allowed(&self, host: Option<&str>) -> bool {
        host.is_some_and(|h| self.allowed_hosts().contains(&h.to_ascii_lowercase()))
    }

    fn origin_allowed(&self, origin: &str) -> bool {
        let origin = origin.to_ascii_lowercase();
        self.allowed_hosts().iter().any(|h| origin == format!("http://{h}"))
    }

    // ---- routing ----

    async fn handle(self: Arc<Self>, request: Request<Incoming>) -> Reply {
        let (parts, body) = request.into_parts();
        let host = parts.headers.get(header::HOST).and_then(|v| v.to_str().ok());
        if !self.host_allowed(host) {
            return text(403, "Host not allowed");
        }
        let path = normalize_pathname(parts.uri.path());
        if path.starts_with("/api/") {
            return self.api(&parts, &path, body).await;
        }
        if parts.method != Method::GET && parts.method != Method::HEAD {
            return text(405, "Method not allowed");
        }
        if path.starts_with("/img/") {
            return self.serve_image(&parts, &path).await;
        }
        serve_static(&parts, &path)
    }

    async fn api(self: &Arc<Self>, parts: &Parts, path: &str, body: Incoming) -> Reply {
        let method = &parts.method;
        if method != Method::GET && method != Method::HEAD {
            // Writes need a custom header: another website cannot send it without the browser blocking the
            // request at the preflight step.
            if parts.headers.get("x-stick-note").map(|v| v.as_bytes()) != Some(b"1") {
                return error(403, "missing_header", "The X-Stick-Note header is required");
            }
            if let Some(origin) = parts.headers.get(header::ORIGIN) {
                let allowed = origin.to_str().ok().is_some_and(|o| o.is_empty() || self.origin_allowed(o));
                if !allowed {
                    return error(403, "bad_origin", "Origin not allowed");
                }
            }
        }
        let query = parts.uri.query();
        let get = method == Method::GET;
        let post = method == Method::POST;

        match path {
            "/api/ping" if get => {
                let window = query_param(query, "w");
                self.presence.lock().unwrap_or_else(PoisonError::into_inner).ping(window.as_deref(), now_ms());
                json(200, &json!({ "app": APP_ID, "version": VERSION, "t": now_ms() }))
            }
            "/api/bye" if post => {
                let window = query_param(query, "w");
                self.presence.lock().unwrap_or_else(PoisonError::into_inner).bye(window.as_deref(), now_ms());
                json(200, &json!({ "ok": true }))
            }
            "/api/rev" if get => json(200, &json!({ "rev": self.store.rev() })),
            "/api/board" if get => {
                let store = self.store.clone();
                match blocking(move || store.board_json()).await {
                    Some(body) => json_bytes(200, body),
                    None => server_error(),
                }
            }
            "/api/board" if method == Method::PUT => self.put_board(body).await,
            "/api/images" if post => self.upload_image(body).await,
            "/api/thumb" if post => self.upload_thumb(query, body).await,
            "/api/info" if get => self.info(),
            "/api/backup" if post => {
                let store = self.store.clone();
                match blocking(move || store.backup_now()).await {
                    Some(Ok(file)) => json(200, &json!({ "file": file })),
                    Some(Err(err)) => self.fail("POST", path, &err.to_string()),
                    None => server_error(),
                }
            }
            "/api/open-data-folder" if post => {
                let opener = if cfg!(windows) {
                    "explorer.exe"
                } else if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                };
                if let Err(err) = spawn_detached(std::process::Command::new(opener).arg(&self.data_dir)) {
                    self.log.log(&format!("Could not open the data folder: {err}"));
                }
                json(200, &json!({ "ok": true, "dataDir": self.data_dir.to_string_lossy() }))
            }
            "/api/shutdown" if post => {
                let shutdown = self.shutdown.clone();
                // Let the answer reach the client first.
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    shutdown.notify_one();
                });
                json(200, &json!({ "ok": true }))
            }
            _ => error(404, "not_found", "No such API endpoint"),
        }
    }

    /// An error nobody planned for: log it, answer with a plain 500.
    fn fail(&self, method: &str, path: &str, why: &str) -> Reply {
        self.log.log(&format!("API error {method} {path} {why}"));
        server_error()
    }

    // ---- the API ----

    async fn put_board(self: &Arc<Self>, body: Incoming) -> Reply {
        let body = match read_body(body, MAX_BOARD_BYTES).await {
            Ok(body) => body,
            Err(err) => return err.reply(),
        };
        let store = self.store.clone();
        let outcome = blocking(move || parse_put(&body).map(|request| store.put(request))).await;
        match outcome {
            None => server_error(),
            Some(Err(PutError::InvalidJson)) => error(400, "invalid_json", "The request body is not valid JSON"),
            Some(Err(PutError::InvalidBoard)) => error(400, "invalid_board", "The board data is malformed"),
            Some(Ok(PutOutcome::Saved { rev, saved_at })) => json(200, &json!({ "rev": rev, "savedAt": saved_at })),
            Some(Ok(PutOutcome::Conflict(body))) => json_bytes(409, body),
            Some(Ok(PutOutcome::Failed(message))) => error(500, "write_failed", &message),
        }
    }

    async fn upload_image(self: &Arc<Self>, body: Incoming) -> Reply {
        let body = match read_body(body, MAX_IMAGE_BYTES).await {
            Ok(body) => body,
            Err(err) => return err.reply(),
        };
        let store = self.store.clone();
        match blocking(move || store.save_image(&body)).await {
            Some(Ok(Some(id))) => json(200, &json!({ "id": id })),
            Some(Ok(None)) => error(415, "unsupported_image", "Only PNG, JPEG, WebP and GIF images are accepted"),
            Some(Err(err)) => self.fail("POST", "/api/images", &err.to_string()),
            None => server_error(),
        }
    }

    async fn upload_thumb(self: &Arc<Self>, query: Option<&str>, body: Incoming) -> Reply {
        let original = query_param(query, "of").unwrap_or_default();
        if !self.store.has_original(&original) {
            return error(400, "unknown_image", "The original image does not exist");
        }
        let body = match read_body(body, MAX_THUMB_BYTES).await {
            Ok(body) => body,
            Err(err) => return err.reply(),
        };
        let store = self.store.clone();
        match blocking(move || store.save_thumb(&original, &body)).await {
            Some(Ok(Some(id))) => json(200, &json!({ "id": id })),
            Some(Ok(None)) => error(415, "unsupported_thumb", "A thumbnail must be PNG, JPEG or WebP"),
            Some(Err(err)) => self.fail("POST", "/api/thumb", &err.to_string()),
            None => server_error(),
        }
    }

    fn info(&self) -> Reply {
        let (rev, notes, trash, zones) = self.store.counts();
        let backups = match self.store.recent_backups(10) {
            Ok(names) => names,
            Err(err) => return self.fail("GET", "/api/info", &err.to_string()),
        };
        let windows = self.presence.lock().unwrap_or_else(PoisonError::into_inner).count();
        let channel = self.build_info.get("channel").filter(|v| jsnum::truthy(v)).cloned().unwrap_or_else(|| Value::from("source"));
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let uptime = self.started.elapsed().as_secs_f64().round() as u64;
        json(
            200,
            &json!({
                "app": APP_ID,
                "version": VERSION,
                "channel": channel,
                "platform": Platform::current().node_name(),
                "dataDir": self.data_dir.to_string_lossy(),
                "port": self.port,
                "rev": rev,
                "notes": notes,
                "trash": trash,
                "zones": zones,
                "windows": windows,
                "backups": backups,
                "uptimeSec": uptime,
            }),
        )
    }

    // ---- pictures and the web interface ----

    async fn serve_image(self: &Arc<Self>, parts: &Parts, path: &str) -> Reply {
        let Some(id) = decode_uri_component(&path["/img/".len()..]) else { return text(400, "Bad request") };
        if !is_image_id(&id) {
            return text(404, "Not found");
        }
        let file = self.store.image_path(&id);
        let head = parts.method == Method::HEAD;
        let loaded = blocking(move || -> Option<(u64, Option<Vec<u8>>)> {
            let meta = fs::metadata(&file).ok().filter(fs::Metadata::is_file)?;
            if head { Some((meta.len(), None)) } else { fs::read(&file).ok().map(|bytes| (meta.len(), Some(bytes))) }
        })
        .await
        .flatten();
        let Some((length, bytes)) = loaded else { return text(404, "Not found") };
        finish(
            builder(200)
                .header(CONTENT_TYPE, mime_of(&id))
                .header(CONTENT_LENGTH, length)
                .header(CACHE_CONTROL, "public, max-age=31536000, immutable"),
            bytes.map_or_else(Bytes::new, Bytes::from),
        )
    }
}

fn serve_static(parts: &Parts, path: &str) -> Reply {
    let Some(decoded) = decode_uri_component(path) else { return text(400, "Bad request") };
    if decoded.contains('\0') {
        return text(400, "Bad request");
    }
    let rel = match decoded.as_str() {
        "/" => "/index.html",
        "/favicon.ico" => "/icons/icon.svg",
        other => other,
    };
    // Nothing outside the web interface is ever served.
    if rel.contains('\\') || rel.split('/').any(|segment| segment == "..") {
        return text(403, "Forbidden");
    }
    let Some(file) = Assets::get(rel.trim_start_matches('/')) else { return text(404, "Not found") };

    let hash = hex(&file.metadata.sha256_hash());
    let etag = format!("W/\"{}-{}\"", file.data.len(), &hash[..12]);
    let mut response = builder(200).header(CONTENT_TYPE, mime_of(rel)).header(ETAG, etag.as_str()).header(CACHE_CONTROL, "no-cache");
    if mime_of(rel).starts_with("text/html") {
        response = response.header("Content-Security-Policy", HTML_CSP);
    }
    if parts.headers.get(IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return finish(response.status(304), Bytes::new());
    }
    let length = file.data.len();
    let response = response.header(CONTENT_LENGTH, length);
    if parts.method == Method::HEAD {
        return finish(response, Bytes::new());
    }
    let body = match file.data {
        std::borrow::Cow::Borrowed(bytes) => Bytes::from_static(bytes),
        std::borrow::Cow::Owned(bytes) => Bytes::from(bytes),
    };
    finish(response, body)
}
