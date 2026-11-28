//! Where things live: the application folder, the data folder and build metadata.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

pub const APP_ID: &str = "stick-note";
pub const APP_NAME: &str = "Stick Note";
pub const DEFAULT_PORT: u16 = 4747;

/// The version number, written in package.json only (build.rs passes it on).
pub const VERSION: &str = env!("STICK_NOTE_VERSION");

/// Metadata of how a copy was packaged: `build-info.json` next to the program. Absent for a copy built from source.
pub type BuildInfo = Map<String, Value>;

/// Reads environment variables; a parameter so that tests can use made-up ones.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The folder of the running program (the "application folder").
pub fn app_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}

/// `build-info.json` in `root`; an empty map when it is missing or not an object.
pub fn read_build_info(root: &Path) -> BuildInfo {
    fs::read_to_string(root.join("build-info.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| if let Value::Object(map) = value { Some(map) } else { None })
        .unwrap_or_default()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Mac,
    Linux,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }

    /// The name Node.js calls it (`process.platform`), which is what `/api/info` reports.
    pub const fn node_name(self) -> &'static str {
        match self {
            Self::Windows => "win32",
            Self::Mac => "darwin",
            Self::Linux => "linux",
        }
    }
}

/// Join path parts with one separator between them (the separator of a platform that may not be this one).
pub(crate) fn join_with(sep: char, parts: &[&str]) -> String {
    let mut out = String::new();
    for part in parts {
        if !out.is_empty() && !out.ends_with(sep) {
            out.push(sep);
        }
        out.push_str(part);
    }
    out
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// Per-user data folder used by installed builds.
pub fn user_data_dir(platform: Platform, env: Env, home: &str) -> String {
    match platform {
        Platform::Windows => {
            let roaming = non_empty(env("APPDATA")).unwrap_or_else(|| join_with('\\', &[home, "AppData", "Roaming"]));
            join_with('\\', &[&roaming, APP_NAME])
        }
        Platform::Mac => join_with('/', &[home, "Library", "Application Support", APP_NAME]),
        Platform::Linux => {
            let base = non_empty(env("XDG_DATA_HOME")).unwrap_or_else(|| join_with('/', &[home, ".local", "share"]));
            join_with('/', &[&base, APP_ID])
        }
    }
}

/// Make a path absolute and tidy: no `.` or `..` parts, without looking at the disk (like Node's `path.resolve`).
pub fn resolve(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Where the notes are stored. In order of priority:
///  1. the `STICK_NOTE_DATA` environment variable;
///  2. `"dataDir"` in build-info.json: `"user"` (installed builds: a per-user folder that survives upgrades and
///     uninstalls) or a path relative to the application folder (portable builds);
///  3. `./data` next to the program (a copy built from source).
pub fn resolve_data_dir(env: Env, root: &Path, build_info: &BuildInfo, platform: Platform, home: &str) -> PathBuf {
    if let Some(dir) = non_empty(env("STICK_NOTE_DATA")) {
        return resolve(Path::new(&dir));
    }
    match build_info.get("dataDir") {
        Some(Value::String(s)) if s == "user" => PathBuf::from(user_data_dir(platform, env, home)),
        Some(Value::String(s)) if !s.is_empty() => resolve(&root.join(s)),
        _ => source_checkout_data_dir(root).unwrap_or_else(|| root.join("data")),
    }
}

/// A program that cargo built inside a source checkout sits in `<repo>/target/debug` (or `release`, or
/// `<target triple>/release`). Its notes go to `<repo>/data`, where a source checkout has always kept them, and not
/// into `target/`, which `cargo clean` empties.
fn source_checkout_data_dir(root: &Path) -> Option<PathBuf> {
    let target = root.ancestors().take(4).find(|dir| dir.file_name().is_some_and(|name| name == "target"))?;
    let repo = target.parent().filter(|repo| repo.join("Cargo.toml").is_file())?;
    Some(repo.join("data"))
}

/// The current user's home folder.
pub fn home_dir() -> String {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(var).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    fn info(json: &str) -> BuildInfo {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn installed_builds_use_a_per_user_folder_on_each_platform() {
        let win = env_of(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming")]);
        assert_eq!(user_data_dir(Platform::Windows, &win, "C:\\Users\\Ann"), "C:\\Users\\Ann\\AppData\\Roaming\\Stick Note");
        assert_eq!(user_data_dir(Platform::Windows, &env_of(&[]), "C:\\Users\\Ann"), "C:\\Users\\Ann\\AppData\\Roaming\\Stick Note");
        assert_eq!(user_data_dir(Platform::Windows, &env_of(&[("APPDATA", "")]), "C:\\Users\\Ann"), "C:\\Users\\Ann\\AppData\\Roaming\\Stick Note");
        assert_eq!(user_data_dir(Platform::Linux, &env_of(&[]), "/home/ann"), "/home/ann/.local/share/stick-note");
        assert_eq!(user_data_dir(Platform::Linux, &env_of(&[("XDG_DATA_HOME", "/data/xdg")]), "/home/ann"), "/data/xdg/stick-note");
        assert_eq!(user_data_dir(Platform::Mac, &env_of(&[]), "/Users/ann"), "/Users/ann/Library/Application Support/Stick Note");
    }

    #[test]
    fn stick_note_data_always_wins() {
        let dir = resolve_data_dir(
            &env_of(&[("STICK_NOTE_DATA", "some/where")]),
            Path::new("/app"),
            &info(r#"{"dataDir":"user"}"#),
            Platform::current(),
            "/home/ann",
        );
        assert_eq!(dir, resolve(Path::new("some/where")));
        assert!(dir.is_absolute());
    }

    #[test]
    fn a_copy_built_from_source_keeps_its_notes_in_data_next_to_it() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(resolve_data_dir(&env_of(&[]), root.path(), &BuildInfo::new(), Platform::current(), "/h"), root.path().join("data"));
    }

    #[test]
    fn a_program_built_by_cargo_in_a_checkout_keeps_its_notes_in_the_data_folder_of_the_checkout() {
        let repo = tempfile::tempdir().unwrap();
        fs::write(repo.path().join("Cargo.toml"), "[workspace]\n").unwrap();
        for profile in [Path::new("target/debug"), Path::new("target/release"), Path::new("target/x86_64-unknown-linux-musl/release")] {
            let root = repo.path().join(profile);
            fs::create_dir_all(&root).unwrap();
            assert_eq!(resolve_data_dir(&env_of(&[]), &root, &BuildInfo::new(), Platform::current(), "/h"), repo.path().join("data"), "{profile:?}");
        }
        // The same folder names somewhere that is not a checkout (no Cargo.toml above target/) mean nothing special.
        let elsewhere = tempfile::tempdir().unwrap();
        let root = elsewhere.path().join("target").join("release");
        fs::create_dir_all(&root).unwrap();
        assert_eq!(resolve_data_dir(&env_of(&[]), &root, &BuildInfo::new(), Platform::current(), "/h"), root.join("data"));
    }

    #[test]
    fn portable_builds_keep_notes_wherever_the_folder_is_unpacked() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("app");
        assert_eq!(
            resolve_data_dir(&env_of(&[]), &app, &info(r#"{"dataDir":"../data"}"#), Platform::current(), "/h"),
            resolve(&root.path().join("data"))
        );
        assert_eq!(resolve_data_dir(&env_of(&[]), root.path(), &info(r#"{"dataDir":"data"}"#), Platform::current(), "/h"), root.path().join("data"));
    }

    #[test]
    fn the_user_folder_is_chosen_by_build_info_and_the_platform() {
        let dir = resolve_data_dir(
            &env_of(&[("XDG_DATA_HOME", "/x")]),
            Path::new("/opt/stick-note"),
            &info(r#"{"dataDir":"user"}"#),
            Platform::Linux,
            "/home/ann",
        );
        assert_eq!(dir, PathBuf::from("/x/stick-note"));
    }

    #[test]
    fn build_info_is_read_from_next_to_the_program_and_ignored_when_it_is_not_an_object() {
        let root = tempfile::tempdir().unwrap();
        assert!(read_build_info(root.path()).is_empty());
        fs::write(root.path().join("build-info.json"), r#"{"channel":"windows-installer","dataDir":"user"}"#).unwrap();
        assert_eq!(read_build_info(root.path()).get("channel"), Some(&Value::from("windows-installer")));
        fs::write(root.path().join("build-info.json"), "[1,2]").unwrap();
        assert!(read_build_info(root.path()).is_empty());
        fs::write(root.path().join("build-info.json"), "{broken").unwrap();
        assert!(read_build_info(root.path()).is_empty());
    }

    #[test]
    fn resolve_removes_dots_without_touching_the_disk() {
        let base = std::path::absolute("x").unwrap().parent().unwrap().to_path_buf();
        assert_eq!(resolve(Path::new("a/./b/../c")), base.join("a").join("c"));
        assert!(resolve(Path::new("../../../../../../../../../../../..")).parent().is_none(), "never climbs above the root");
    }

    #[test]
    fn the_platform_names_match_what_node_reported() {
        assert_eq!(Platform::Windows.node_name(), "win32");
        assert_eq!(Platform::Linux.node_name(), "linux");
        assert_eq!(Platform::Mac.node_name(), "darwin");
    }
}
