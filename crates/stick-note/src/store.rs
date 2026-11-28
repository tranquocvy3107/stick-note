//! The data of a person's whiteboard: `board.json`, the pictures and the backups.
//!
//! Everything here is plain blocking file work; the HTTP layer calls it from worker threads. The file formats and
//! rules are exactly the ones the Node.js server used, so a data folder can move between the two programs.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::jsnum;
use crate::logger::Logger;
use crate::paths::APP_ID;
use crate::util::{hex, iso_now, local_day, sniff_image, stamp, write_file_atomic};

pub const MAX_BOARD_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_THUMB_BYTES: usize = 8 * 1024 * 1024;
const MAX_NOTES: usize = 50_000;
const MAX_ZONES: usize = 10_000;
const KEEP_DAILY_BACKUPS: usize = 60;
const KEEP_SPECIAL_BACKUPS: usize = 30;

// ---- the board ------------------------------------------------------------

/// The saved state of the whiteboard. Notes and zones are kept as the JSON the interface sent, untouched.
#[derive(Debug, Clone)]
pub struct Board {
    pub rev: i64,
    pub notes: Vec<Value>,
    pub trash: Vec<Value>,
    pub zones: Vec<Value>,
    pub zones_trash: Vec<Value>,
    /// A string once something has been saved, `null` before.
    pub saved_at: Value,
}

impl Board {
    fn empty() -> Self {
        Self { rev: 0, notes: Vec::new(), trash: Vec::new(), zones: Vec::new(), zones_trash: Vec::new(), saved_at: Value::Null }
    }

    /// What a client receives: the lists it edits (`rev` and `savedAt` travel beside them).
    fn content(&self) -> Content<'_> {
        Content { notes: &self.notes, trash: &self.trash, zones: &self.zones, zones_trash: &self.zones_trash }
    }
}

#[derive(Serialize)]
struct Content<'a> {
    notes: &'a [Value],
    trash: &'a [Value],
    zones: &'a [Value],
    #[serde(rename = "zonesTrash")]
    zones_trash: &'a [Value],
}

/// The answer to `GET /api/board`.
#[derive(Serialize)]
struct Reply<'a> {
    rev: i64,
    #[serde(rename = "savedAt")]
    saved_at: &'a Value,
    board: Content<'a>,
}

/// The answer to a save that was made from an out-of-date copy: the current board, so the client can merge.
#[derive(Serialize)]
struct Conflict<'a> {
    error: &'static str,
    message: &'static str,
    rev: i64,
    board: Content<'a>,
}

/// What `board.json` holds. The order of the keys is the one the Node.js server wrote.
#[derive(Serialize)]
struct OnDisk<'a> {
    app: &'static str,
    schema: u32,
    rev: i64,
    #[serde(rename = "savedAt")]
    saved_at: &'a Value,
    notes: &'a [Value],
    trash: &'a [Value],
    zones: &'a [Value],
    #[serde(rename = "zonesTrash")]
    zones_trash: &'a [Value],
}

fn read_board_file(file: &Path) -> Result<Board, String> {
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let Value::Object(mut map) = data else { return Err("not a valid board file".into()) };
    let Some(Value::Array(notes)) = map.remove("notes") else { return Err("not a valid board file".into()) };
    let mut list = |key: &str| match map.remove(key) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    let trash = list("trash");
    // Zones arrived in 1.2: a board file written by an older version simply has none.
    let zones = list("zones");
    let zones_trash = list("zonesTrash");
    let rev = jsnum::number_from_json(map.get("rev"));
    let saved_at = map.remove("savedAt").filter(jsnum::truthy).unwrap_or(Value::Null);
    #[allow(clippy::cast_possible_truncation)]
    let rev = if rev.is_nan() { 0 } else { rev as i64 };
    Ok(Board { rev, notes, trash, zones, zones_trash, saved_at })
}

fn is_backup_file(name: &str) -> bool {
    name.starts_with("board-") && name.ends_with(".json")
}

/// `board-2026-11-27.json`
fn is_daily_backup(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("board-").and_then(|r| r.strip_suffix(".json")) else { return false };
    let b = rest.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// `board-2026-11-27_09-41-05-before-shrink.json` and `...-manual.json`
fn is_special_backup(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("board-") else { return false };
    rest.ends_with("-before-shrink.json") || rest.ends_with("-manual.json")
}

/// Read `board.json`. A damaged file is set aside and the newest backup that can be read takes its place.
fn load_board(dir: &Path, board_file: &Path, backups_dir: &Path, log: &Logger) -> Board {
    if !board_file.exists() {
        return Board::empty();
    }
    match read_board_file(board_file) {
        Ok(board) => board,
        Err(err) => {
            log.log(&format!("board.json is damaged: {err}"));
            let _ = fs::rename(board_file, dir.join(format!("board.corrupt-{}.json", stamp())));
            let mut candidates: Vec<String> = fs::read_dir(backups_dir)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|name| is_backup_file(name))
                .collect();
            candidates.sort();
            candidates.reverse();
            for name in candidates {
                if let Ok(mut restored) = read_board_file(&backups_dir.join(&name)) {
                    restored.rev += 1;
                    log.log(&format!("restored the board from backup {name}"));
                    return restored;
                }
            }
            Board::empty()
        }
    }
}

// ---- what a save may contain ------------------------------------------------

/// A validated `PUT /api/board` body.
#[derive(Debug)]
pub struct PutRequest {
    /// The revision the client's copy was based on, as JavaScript would read it (NaN when missing).
    pub base_rev: f64,
    pub notes: Vec<Value>,
    pub trash: Vec<Value>,
    /// `None`: the client does not know zones (an older interface), so the saved ones stay.
    pub zones: Option<Vec<Value>>,
    pub zones_trash: Option<Vec<Value>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PutError {
    InvalidJson,
    InvalidBoard,
}

/// Every item must be an object with a text `id` of 1 to 64 characters.
fn clean_list(value: Option<Value>, max: usize) -> Result<Vec<Value>, PutError> {
    let Some(Value::Array(items)) = value else { return Err(PutError::InvalidBoard) };
    let valid = items.len() <= max
        && items.iter().all(|item| match item {
            Value::Object(map) => matches!(map.get("id"), Some(Value::String(id)) if !id.is_empty() && id.encode_utf16().count() <= 64),
            _ => false,
        });
    if valid { Ok(items) } else { Err(PutError::InvalidBoard) }
}

pub fn parse_put(body: &[u8]) -> Result<PutRequest, PutError> {
    let text = String::from_utf8_lossy(body);
    let data: Result<Value, _> = if may_contain_surrogate_escape(text.as_bytes()) {
        let mut fixed = text.into_owned().into_bytes();
        replace_lone_surrogates(&mut fixed);
        serde_json::from_slice(&fixed)
    } else {
        serde_json::from_str(&text)
    };
    let Value::Object(mut root) = data.map_err(|_| PutError::InvalidJson)? else { return Err(PutError::InvalidBoard) };
    let base_rev = jsnum::number_from_json(root.get("baseRev"));
    let Some(Value::Object(mut board)) = root.remove("board") else { return Err(PutError::InvalidBoard) };

    let notes = clean_list(board.remove("notes"), MAX_NOTES)?;
    let trash = match board.remove("trash") {
        None | Some(Value::Null) => Vec::new(),
        other => clean_list(other, MAX_NOTES)?,
    };
    // Zones are optional on the way in: a window still running the interface of an older version does not know
    // about them and leaves them out, which must not wipe the zones already saved. An empty list is a real change.
    let zones = board.remove("zones").map(|v| clean_list(Some(v), MAX_ZONES)).transpose()?;
    let zones_trash = board.remove("zonesTrash").map(|v| clean_list(Some(v), MAX_ZONES)).transpose()?;
    Ok(PutRequest { base_rev, notes, trash, zones, zones_trash })
}

fn may_contain_surrogate_escape(json: &[u8]) -> bool {
    json.windows(3).any(|w| w[0] == b'\\' && w[1] == b'u' && (w[2] == b'd' || w[2] == b'D'))
}

fn hex4(s: &[u8]) -> Option<u32> {
    if s.len() < 4 {
        return None;
    }
    s[..4].iter().try_fold(0u32, |acc, &b| Some(acc * 16 + char::from(b).to_digit(16)?))
}

/// JavaScript strings may hold half of a surrogate pair (text cut in the middle of an emoji), and `JSON.stringify`
/// writes it as a six-character escape (a backslash, the letter u and four hexadecimal digits). The Node.js server
/// stored such text as it came; Rust strings cannot hold it, so the lone half becomes U+FFFD (the replacement
/// character) rather than making the whole save fail. The replacement escape has the same length, so the text is
/// changed in place.
fn replace_lone_surrogates(json: &mut [u8]) -> usize {
    let mut replaced = 0;
    let mut i = 0;
    while i < json.len() {
        if json[i] != b'\\' {
            i += 1;
            continue;
        }
        if json.get(i + 1) != Some(&b'u') {
            i += 2; // another escape, or an escaped backslash: skip both characters
            continue;
        }
        match hex4(json.get(i + 2..).unwrap_or(&[])) {
            Some(0xD800..=0xDBFF) => {
                let low =
                    (json.get(i + 6) == Some(&b'\\') && json.get(i + 7) == Some(&b'u')).then(|| hex4(json.get(i + 8..).unwrap_or(&[]))).flatten();
                if matches!(low, Some(0xDC00..=0xDFFF)) {
                    i += 12; // a complete pair
                } else {
                    json[i + 2..i + 6].copy_from_slice(b"fffd");
                    replaced += 1;
                    i += 6;
                }
            }
            Some(0xDC00..=0xDFFF) => {
                json[i + 2..i + 6].copy_from_slice(b"fffd");
                replaced += 1;
                i += 6;
            }
            Some(_) => i += 6,
            None => i += 2,
        }
    }
    replaced
}

pub enum PutOutcome {
    Saved {
        rev: i64,
        saved_at: String,
    },
    /// The client's copy is out of date: the body to answer with (the current board).
    Conflict(Vec<u8>),
    Failed(String),
}

// ---- the store ---------------------------------------------------------------

pub struct Store {
    dir: PathBuf,
    board_file: PathBuf,
    images_dir: PathBuf,
    backups_dir: PathBuf,
    log: Arc<Logger>,
    board: Mutex<Board>,
}

impl Store {
    /// Open (and, when needed, create) the data folder.
    pub fn open(dir: &Path, log: Arc<Logger>) -> io::Result<Self> {
        let images_dir = dir.join("images");
        let backups_dir = dir.join("backups");
        fs::create_dir_all(&images_dir)?;
        fs::create_dir_all(&backups_dir)?;
        let board_file = dir.join("board.json");
        let board = load_board(dir, &board_file, &backups_dir, &log);
        Ok(Self { dir: dir.to_path_buf(), board_file, images_dir, backups_dir, log, board: Mutex::new(board) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> MutexGuard<'_, Board> {
        self.board.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn rev(&self) -> i64 {
        self.lock().rev
    }

    /// (revision, notes, trash, zones) for `/api/info`.
    pub fn counts(&self) -> (i64, usize, usize, usize) {
        let b = self.lock();
        (b.rev, b.notes.len(), b.trash.len(), b.zones.len())
    }

    /// The body of `GET /api/board`.
    pub fn board_json(&self) -> Vec<u8> {
        let b = self.lock();
        serde_json::to_vec(&Reply { rev: b.rev, saved_at: &b.saved_at, board: b.content() }).unwrap_or_default()
    }

    /// Save a board, unless the client's copy is out of date. The check and the write happen under one lock.
    pub fn put(&self, request: PutRequest) -> PutOutcome {
        let mut board = self.lock();
        #[allow(clippy::cast_precision_loss)]
        if request.base_rev != board.rev as f64 {
            let body =
                serde_json::to_vec(&Conflict { error: "conflict", message: "The board changed elsewhere", rev: board.rev, board: board.content() });
            return PutOutcome::Conflict(body.unwrap_or_default());
        }
        match self.write_next(&board, request) {
            Ok(next) => {
                let saved_at = next.saved_at.as_str().unwrap_or_default().to_string();
                let outcome = PutOutcome::Saved { rev: next.rev, saved_at };
                *board = next;
                outcome
            }
            Err(err) => {
                self.log.log(&format!("Could not write board.json: {err}"));
                PutOutcome::Failed(format!("Could not write the data: {err}"))
            }
        }
    }

    fn write_next(&self, current: &Board, request: PutRequest) -> io::Result<Board> {
        self.backup_before_write(current, request.notes.len())?;
        let next = Board {
            rev: current.rev + 1,
            zones: request.zones.unwrap_or_else(|| current.zones.clone()),
            zones_trash: request.zones_trash.unwrap_or_else(|| current.zones_trash.clone()),
            notes: request.notes,
            trash: request.trash,
            saved_at: Value::String(iso_now()),
        };
        let bytes = serde_json::to_vec(&OnDisk {
            app: APP_ID,
            schema: 1,
            rev: next.rev,
            saved_at: &next.saved_at,
            notes: &next.notes,
            trash: &next.trash,
            zones: &next.zones,
            zones_trash: &next.zones_trash,
        })?;
        write_file_atomic(&self.board_file, &bytes)?;
        Ok(next)
    }

    // ---- backups ----

    fn prune_backups(&self) {
        let result = (|| -> io::Result<()> {
            let names: Vec<String> = fs::read_dir(&self.backups_dir)?.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
            for (matches, keep) in [(is_daily_backup as fn(&str) -> bool, KEEP_DAILY_BACKUPS), (is_special_backup, KEEP_SPECIAL_BACKUPS)] {
                let mut group: Vec<&String> = names.iter().filter(|n| matches(n)).collect();
                group.sort();
                for old in &group[..group.len().saturating_sub(keep)] {
                    fs::remove_file(self.backups_dir.join(old))?;
                }
            }
            Ok(())
        })();
        if let Err(err) = result {
            self.log.log(&format!("Could not prune old backups: {err}"));
        }
    }

    /// Back up the previous state before overwriting it:
    ///  - one copy per day (the last state of the previous save)
    ///  - one extra copy when the number of notes drops sharply (mass deletion or a bug)
    fn backup_before_write(&self, current: &Board, next_notes: usize) -> io::Result<()> {
        if !self.board_file.exists() {
            return Ok(());
        }
        let daily = self.backups_dir.join(format!("board-{}.json", local_day()));
        if !daily.exists() {
            fs::copy(&self.board_file, &daily)?;
        }
        let before = current.notes.len();
        #[allow(clippy::cast_precision_loss)]
        if before >= 8 && (next_notes as f64) < before as f64 * 0.6 {
            fs::copy(&self.board_file, self.backups_dir.join(format!("board-{}-before-shrink.json", stamp())))?;
            self.log.log(&format!("The number of notes dropped from {before} to {next_notes}; saved a backup of the previous state."));
        }
        self.prune_backups();
        Ok(())
    }

    /// `POST /api/backup`: copy the board file now. `None` when there is nothing to copy yet.
    pub fn backup_now(&self) -> io::Result<Option<String>> {
        let _guard = self.lock(); // not in the middle of a save
        if !self.board_file.exists() {
            return Ok(None);
        }
        let name = format!("board-{}-manual.json", stamp());
        fs::copy(&self.board_file, self.backups_dir.join(&name))?;
        self.prune_backups();
        Ok(Some(name))
    }

    /// The newest backups first.
    pub fn recent_backups(&self, limit: usize) -> io::Result<Vec<String>> {
        let mut names: Vec<String> =
            fs::read_dir(&self.backups_dir)?.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.ends_with(".json")).collect();
        names.sort();
        names.reverse();
        names.truncate(limit);
        Ok(names)
    }

    // ---- pictures ----

    pub fn image_path(&self, id: &str) -> PathBuf {
        self.images_dir.join(id)
    }

    /// Store a picture under the SHA-1 of its content. `None` when the bytes are not a supported image.
    pub fn save_image(&self, bytes: &[u8]) -> io::Result<Option<String>> {
        let Some(ext) = sniff_image(bytes) else { return Ok(None) };
        let id = format!("{}.{ext}", hex(&Sha1::digest(bytes)));
        let file = self.images_dir.join(&id);
        if !file.exists() {
            write_file_atomic(&file, bytes)?;
        }
        Ok(Some(id))
    }

    /// Store the thumbnail of picture `original`. `None` when it is not a PNG, JPEG or WebP image.
    pub fn save_thumb(&self, original: &str, bytes: &[u8]) -> io::Result<Option<String>> {
        let Some(ext) = sniff_image(bytes).filter(|ext| *ext != "gif") else { return Ok(None) };
        let id = format!("{}.thumb.{ext}", original.split('.').next().unwrap_or(original));
        let file = self.images_dir.join(&id);
        if !file.exists() {
            write_file_atomic(&file, bytes)?;
        }
        Ok(Some(id))
    }

    /// An original picture that is really stored.
    pub fn has_original(&self, id: &str) -> bool {
        is_original_id(id) && self.images_dir.join(id).exists()
    }
}

fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "webp" | "gif")
}

fn is_sha1_hex(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `<sha1>.png` (also `.jpg`, `.webp`, `.gif`)
pub fn is_original_id(id: &str) -> bool {
    id.split_once('.').is_some_and(|(hash, ext)| is_sha1_hex(hash) && is_image_ext(ext))
}

/// An original or its thumbnail: `<sha1>.png` or `<sha1>.thumb.png`.
pub fn is_image_id(id: &str) -> bool {
    id.split_once('.').is_some_and(|(hash, rest)| is_sha1_hex(hash) && is_image_ext(rest.strip_prefix("thumb.").unwrap_or(rest)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open(dir: &Path) -> Store {
        Store::open(dir, Arc::new(Logger::new(dir, false))).unwrap()
    }

    fn note(id: &str) -> Value {
        json!({ "id": id, "k": "text", "x": 10, "y": 20, "t": format!("note {id}"), "mt": 1 })
    }

    fn request(base_rev: f64, notes: Vec<Value>) -> PutRequest {
        PutRequest { base_rev, notes, trash: Vec::new(), zones: None, zones_trash: None }
    }

    fn saved_rev(outcome: PutOutcome) -> i64 {
        match outcome {
            PutOutcome::Saved { rev, .. } => rev,
            PutOutcome::Conflict(_) => panic!("unexpected conflict"),
            PutOutcome::Failed(why) => panic!("unexpected failure: {why}"),
        }
    }

    fn ids(list: &[Value]) -> Vec<&str> {
        list.iter().map(|n| n["id"].as_str().unwrap()).collect()
    }

    #[test]
    fn a_new_folder_starts_with_an_empty_board_and_the_subfolders() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        assert_eq!(store.counts(), (0, 0, 0, 0));
        assert!(dir.path().join("images").is_dir() && dir.path().join("backups").is_dir());
        let body: Value = serde_json::from_slice(&store.board_json()).unwrap();
        assert_eq!(body, json!({ "rev": 0, "savedAt": null, "board": { "notes": [], "trash": [], "zones": [], "zonesTrash": [] } }));
    }

    #[test]
    fn saving_bumps_the_revision_writes_the_file_in_the_node_layout_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        assert_eq!(saved_rev(store.put(request(0.0, vec![note("a")]))), 1);
        assert_eq!(saved_rev(store.put(request(1.0, vec![note("a"), note("b")]))), 2);
        let on_disk: Value = serde_json::from_slice(&fs::read(dir.path().join("board.json")).unwrap()).unwrap();
        let keys: Vec<_> = on_disk.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["app", "schema", "rev", "savedAt", "notes", "trash", "zones", "zonesTrash"]);
        assert_eq!(on_disk["app"], "stick-note");
        assert_eq!(on_disk["schema"], 1);
        assert_eq!(on_disk["rev"], 2);
        drop(store);
        let again = open(dir.path());
        assert_eq!(again.counts(), (2, 2, 0, 0));
    }

    #[test]
    fn a_stale_save_gets_the_current_board_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        store.put(request(0.0, vec![note("a")]));
        let PutOutcome::Conflict(body) = store.put(request(0.0, vec![note("b")])) else { panic!("expected a conflict") };
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], "conflict");
        assert_eq!(body["rev"], 1);
        assert_eq!(body["board"]["notes"][0]["id"], "a");
        assert_eq!(store.counts().0, 1);
        assert!(matches!(store.put(request(f64::NAN, vec![])), PutOutcome::Conflict(_)), "a missing revision is a stale one");
    }

    #[test]
    fn zones_that_are_left_out_stay_and_an_empty_list_clears_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        let zone = json!({ "id": "z1", "x": 1, "y": 2, "w": 3, "h": 4, "k": "normal", "t": "z", "mt": 1 });
        let mut first = request(0.0, vec![note("a")]);
        first.zones = Some(vec![zone]);
        first.zones_trash = Some(vec![]);
        store.put(first);
        store.put(request(1.0, vec![note("a"), note("b")]));
        let body: Value = serde_json::from_slice(&store.board_json()).unwrap();
        assert_eq!(body["board"]["zones"][0]["id"], "z1", "a client that does not know zones keeps them");
        let mut clear = request(2.0, vec![]);
        clear.zones = Some(vec![]);
        store.put(clear);
        let body: Value = serde_json::from_slice(&store.board_json()).unwrap();
        assert_eq!(body["board"]["zones"], json!([]));
    }

    #[test]
    fn the_first_save_makes_no_backup_and_the_second_makes_the_daily_one_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        store.put(request(0.0, vec![note("first")]));
        assert_eq!(fs::read_dir(dir.path().join("backups")).unwrap().count(), 0);
        store.put(request(1.0, vec![note("first"), note("second")]));
        store.put(request(2.0, vec![note("first"), note("second"), note("third")]));
        let daily = dir.path().join("backups").join(format!("board-{}.json", local_day()));
        let kept: Value = serde_json::from_slice(&fs::read(daily).unwrap()).unwrap();
        assert_eq!(ids(kept["notes"].as_array().unwrap()), ["first"], "a day's backup is never overwritten");
    }

    #[test]
    fn a_sharp_drop_keeps_an_extra_backup_but_only_from_eight_notes_up() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        let many: Vec<_> = (0..10).map(|i| note(&format!("n{i}"))).collect();
        store.put(request(0.0, many.clone()));
        store.put(request(1.0, many[..2].to_vec()));
        let names: Vec<_> = fs::read_dir(dir.path().join("backups")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names.iter().filter(|n| n.ends_with("-before-shrink.json")).count(), 1);
        // 7 notes down to 1 is under the limit of 8: no alarm.
        let small = tempfile::tempdir().unwrap();
        let store = open(small.path());
        store.put(request(0.0, many[..7].to_vec()));
        store.put(request(1.0, many[..1].to_vec()));
        assert!(fs::read_dir(small.path().join("backups")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("before-shrink")));
    }

    #[test]
    fn old_backups_are_pruned_to_sixty_daily_and_thirty_special_ones() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("backups");
        fs::create_dir_all(&backups).unwrap();
        for m in 1..=7 {
            for d in 1..=10 {
                fs::write(backups.join(format!("board-2025-{m:02}-{d:02}.json")), "{}").unwrap();
            }
        }
        for i in 0..35 {
            fs::write(backups.join(format!("board-2025-02-{:02}_10-00-{i:02}-manual.json", i % 28 + 1)), "{}").unwrap();
        }
        fs::write(dir.path().join("board.json"), r#"{"rev":1,"notes":[]}"#).unwrap();
        let store = open(dir.path());
        store.put(request(1.0, vec![note("a")]));
        let names: Vec<String> = fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names.iter().filter(|n| is_daily_backup(n)).count(), 60);
        assert_eq!(names.iter().filter(|n| is_special_backup(n)).count(), 30);
        assert!(!names.contains(&"board-2025-01-01.json".to_string()));
    }

    #[test]
    fn the_backup_name_checks_match_the_patterns_of_the_node_server() {
        assert!(is_daily_backup("board-2026-11-27.json"));
        assert!(!is_daily_backup("board-2026-11-27_09-41-05-manual.json"));
        assert!(!is_daily_backup("board-2026-1-27.json"));
        assert!(!is_daily_backup("board-2026-11-27.json.bak"));
        assert!(is_special_backup("board-2026-11-27_09-41-05-manual.json"));
        assert!(is_special_backup("board-2026-11-27_09-41-05-before-shrink.json"));
        assert!(is_special_backup("board--manual.json"));
        assert!(!is_special_backup("board-manual.json"), "needs a dash before the word");
        assert!(!is_special_backup("board-2026-11-27.json"));
    }

    #[test]
    fn a_damaged_board_is_set_aside_and_the_newest_readable_backup_is_restored() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("backups");
        fs::create_dir_all(&backups).unwrap();
        fs::write(backups.join("board-2026-01-01.json"), r#"{"rev":4,"notes":[{"id":"old"}]}"#).unwrap();
        fs::write(backups.join("board-2026-01-02.json"), r#"{"rev":6,"notes":[{"id":"newest"}],"zones":[{"id":"z"}]}"#).unwrap();
        fs::write(backups.join("board-2026-01-03_10-00-00-manual.json"), "{ broken").unwrap();
        fs::write(dir.path().join("board.json"), "{\"notes\": [ trunc").unwrap();
        let store = open(dir.path());
        assert_eq!(store.counts(), (7, 1, 0, 1), "the newest backup that can be read, one revision on");
        assert!(fs::read_dir(dir.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("board.corrupt-")));
        assert!(!dir.path().join("board.json").exists() || fs::read_to_string(dir.path().join("board.json")).unwrap() != "{\"notes\": [ trunc");
    }

    #[test]
    fn a_board_file_that_is_json_but_not_a_board_starts_empty_when_there_is_no_backup() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("board.json"), r#"{"notes":5}"#).unwrap();
        assert_eq!(open(dir.path()).counts(), (0, 0, 0, 0));
    }

    #[test]
    fn a_board_file_of_version_11_has_no_zones_and_odd_values_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("board.json"), r#"{"app":"stick-note","schema":1,"rev":"4","savedAt":"","notes":[{"id":"old"}],"trash":"x"}"#)
            .unwrap();
        let store = open(dir.path());
        let body: Value = serde_json::from_slice(&store.board_json()).unwrap();
        assert_eq!(body["rev"], 4, "a revision written as text is read as a number");
        assert_eq!(body["savedAt"], Value::Null, "an empty time is no time");
        assert_eq!(body["board"]["trash"], json!([]));
        assert_eq!(body["board"]["zones"], json!([]));
    }

    #[test]
    fn pictures_are_stored_by_content_once_and_thumbnails_need_their_original() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        let png: Vec<u8> = [&[0x89u8, 0x50, 0x4e, 0x47][..], &[7; 20][..]].concat();
        let id = store.save_image(&png).unwrap().unwrap();
        assert_eq!(id, format!("{}.png", hex(&Sha1::digest(&png))));
        assert_eq!(store.save_image(&png).unwrap().as_deref(), Some(id.as_str()));
        assert_eq!(fs::read_dir(dir.path().join("images")).unwrap().count(), 1);
        assert_eq!(store.save_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap(), None);
        assert!(store.has_original(&id));
        assert!(!store.has_original(&format!("{}.png", "b".repeat(40))));
        assert!(!store.has_original(&format!("{}.thumb.png", &id[..40])), "a thumbnail is not an original");
        let thumb = store.save_thumb(&id, &png).unwrap().unwrap();
        assert_eq!(thumb, format!("{}.thumb.png", &id[..40]));
        assert_eq!(store.save_thumb(&id, b"GIF89a....................").unwrap(), None, "a GIF cannot be a thumbnail");
    }

    #[test]
    fn picture_ids_follow_the_patterns_of_the_node_server() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        for ok in ["png", "jpg", "webp", "gif"] {
            assert!(is_original_id(&format!("{hash}.{ok}")));
            assert!(is_image_id(&format!("{hash}.{ok}")));
        }
        assert!(is_image_id(&format!("{hash}.thumb.png")));
        assert!(!is_original_id(&format!("{hash}.thumb.png")));
        for bad in [
            "",
            "x.png",
            &format!("{hash}.svg"),
            &format!("{hash}.PNG"),
            &format!("{}.png", hash.to_uppercase()),
            &format!("{hash}x.png"),
            &format!("{hash}.thumb.thumb.png"),
            &format!("../{hash}.png"),
            &format!("{hash}.png/"),
        ] {
            assert!(!is_image_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn put_bodies_are_validated_like_the_node_server_did() {
        let parse = |v: Value| parse_put(v.to_string().as_bytes());
        let ok = parse(json!({ "baseRev": 3, "board": { "notes": [note("a")] } })).unwrap();
        assert_eq!((ok.base_rev, ok.notes.len(), ok.trash.len(), ok.zones.is_none()), (3.0, 1, 0, true));
        assert_eq!(parse_put(b"{not json").unwrap_err(), PutError::InvalidJson);
        assert_eq!(parse_put(b"").unwrap_err(), PutError::InvalidJson);
        for bad in [
            json!(null),
            json!([]),
            json!({ "board": null }),
            json!({ "board": [] }),
            json!({ "board": { "notes": "x" } }),
            json!({ "board": { "notes": [{ "nope": 1 }] } }),
            json!({ "board": { "notes": [{ "id": "" }] } }),
            json!({ "board": { "notes": [{ "id": 7 }] } }),
            json!({ "board": { "notes": [[]] } }),
            json!({ "board": { "notes": [{ "id": "x".repeat(65) }] } }),
            json!({ "board": { "notes": [], "trash": "x" } }),
            json!({ "board": { "notes": [], "zones": null } }),
            json!({ "board": { "notes": [], "zones": 5 } }),
            json!({ "board": { "notes": [], "zonesTrash": [{ "nope": 1 }] } }),
        ] {
            assert_eq!(parse(bad.clone()).unwrap_err(), PutError::InvalidBoard, "{bad}");
        }
        assert!(parse(json!({ "board": { "notes": [{ "id": "x".repeat(64) }] } })).is_ok());
        assert!(parse(json!({ "board": { "notes": [], "trash": null } })).is_ok(), "a null trash means an empty one");
        let sixty_four_emoji = "😀".repeat(32); // 64 UTF-16 units, 32 characters
        assert!(parse(json!({ "board": { "notes": [{ "id": sixty_four_emoji }] } })).is_ok());
        assert!(
            parse(json!({ "board": { "notes": [{ "id": "😀".repeat(33) }] } })).is_err(),
            "length is counted in UTF-16 units, as JavaScript does"
        );
        assert!(parse(json!({ "baseRev": "7", "board": { "notes": [] } })).unwrap().base_rev == 7.0);
        assert!(parse(json!({ "board": { "notes": [] } })).unwrap().base_rev.is_nan());
    }

    /// A JSON escape (backslash, u, four hex digits), built at run time: this file contains none itself, because
    /// some editors and tools quietly turn them into the characters they stand for.
    fn esc(hex: &str) -> String {
        format!("{}u{hex}", '\x5c')
    }

    #[test]
    fn half_an_emoji_is_replaced_instead_of_refusing_the_save() {
        let (high, low, bs) = (esc("d83d"), esc("de00"), '\x5c');
        let body = format!(
            r#"{{"baseRev":0,"board":{{"notes":[{{"id":"a","t":"cut {high} here"}},{{"id":"b","t":"lone low {low}"}},{{"id":"c","t":"whole {high}{low} pair"}},{{"id":"d","t":"escaped {bs}{bs}ud83d backslash"}}]}}}}"#
        );
        let request = parse_put(body.as_bytes()).unwrap();
        let texts: Vec<_> = request.notes.iter().map(|n| n["t"].as_str().unwrap().to_string()).collect();
        let escaped = format!("escaped {bs}ud83d backslash");
        assert_eq!(texts, ["cut \u{fffd} here", "lone low \u{fffd}", "whole \u{1f600} pair", escaped.as_str()]);
    }

    #[test]
    fn the_surrogate_scanner_only_touches_real_escapes() {
        let (high, low, bs) = (esc("d83d"), esc("de00"), '\x5c');
        let (a, e, fffd) = (esc("0041"), esc("00e9"), esc("fffd"));
        let input = format!(r#"["{high}", "{high}x", "{high}{a}", "{bs}{bs}ud83d", "{bs}{bs}{high}", "{high}{high}{low}", "{e}", "{bs}u12"]"#);
        let expected = format!(r#"["{fffd}", "{fffd}x", "{fffd}{a}", "{bs}{bs}ud83d", "{bs}{bs}{fffd}", "{fffd}{high}{low}", "{e}", "{bs}u12"]"#);
        let mut text = input.into_bytes();
        let replaced = replace_lone_surrogates(&mut text);
        assert_eq!(replaced, 5, "{}", String::from_utf8_lossy(&text));
        assert_eq!(String::from_utf8(text).unwrap(), expected);
        assert!(!may_contain_surrogate_escape(format!(r#"{{"t":"plain {e} text"}}"#).as_bytes()));
        assert!(may_contain_surrogate_escape(format!(r#"{{"t":"{}"}}"#, esc("DC00")).as_bytes()));
    }

    #[test]
    fn text_in_vietnamese_is_kept_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        let text = "Họp thứ Hai 10h — https://example.com/Việt_Nam?q=đ&x=1";
        store.put(request(0.0, vec![json!({ "id": "n1", "t": text })]));
        let on_disk = fs::read_to_string(dir.path().join("board.json")).unwrap();
        assert!(on_disk.contains(text), "stored as UTF-8, not as escapes");
    }

    #[test]
    fn a_manual_backup_copies_the_board_and_the_list_is_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path());
        assert_eq!(store.backup_now().unwrap(), None);
        store.put(request(0.0, vec![note("a")]));
        let name = store.backup_now().unwrap().unwrap();
        assert!(name.starts_with("board-") && name.ends_with("-manual.json"));
        assert_eq!(store.recent_backups(10).unwrap()[0], name);
        assert!(store.recent_backups(0).unwrap().is_empty());
    }
}
