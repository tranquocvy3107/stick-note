//! Build script.
//!
//! * The version number comes from package.json, the one place it is written (the release workflow and the
//!   packaging scripts read it from there too). The program gets it as `STICK_NOTE_VERSION`.
//! * The web interface in public/ is compiled into the program, so a change there must trigger a rebuild.
//!   `STICK_NOTE_ASSETS_HASH` makes sure of it, and the program uses it to tell builds apart.
//! * On Windows the executable gets the Stick Note icon, its version information and its manifest.

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"));
    let repo = manifest_dir.join("..").join("..");

    let package_json = repo.join("package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    let version = read_version(&package_json);
    println!("cargo:rustc-env=STICK_NOTE_VERSION={version}");

    let public = repo.join("public");
    println!("cargo:rerun-if-changed={}", public.display());
    println!("cargo:rustc-env=STICK_NOTE_ASSETS_HASH={:016x}", hash_dir(&public));

    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        windows_resources(&repo, &manifest_dir, &version);
    }
}

fn read_version(package_json: &Path) -> String {
    let text = fs::read_to_string(package_json).unwrap_or_else(|e| panic!("cannot read {}: {e}", package_json.display()));
    let json: serde_json::Value = serde_json::from_str(&text).expect("package.json is not valid JSON");
    json["version"].as_str().expect("package.json has no \"version\"").to_string()
}

/// FNV-1a over every file name and file content below `dir`, in a fixed order.
fn hash_dir(dir: &Path) -> u64 {
    fn walk(dir: &Path, base: &Path, hash: &mut u64) {
        let mut entries: Vec<_> = fs::read_dir(dir).expect("cannot read public/").map(|e| e.expect("directory entry").path()).collect();
        entries.sort();
        for path in entries {
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            feed(hash, rel.as_bytes());
            if path.is_dir() {
                walk(&path, base, hash);
            } else {
                feed(hash, &fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display())));
            }
        }
    }
    fn feed(hash: &mut u64, bytes: &[u8]) {
        for b in bytes {
            *hash ^= u64::from(*b);
            *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    walk(dir, dir, &mut hash);
    hash
}

/// "1.2.3" or "1.2.3-beta.1" -> (1, 2, 3).
fn numeric_version(version: &str) -> (u64, u64, u64) {
    let core = version.split(['-', '+']).next().unwrap_or("0.0.0");
    let mut parts = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// The copyright line of the LICENSE file, e.g. "Copyright (c) 2026 name".
fn copyright(repo: &Path) -> String {
    fs::read_to_string(repo.join("LICENSE"))
        .ok()
        .and_then(|text| text.lines().find(|l| l.starts_with("Copyright")).map(|l| l.trim().to_string()))
        .unwrap_or_else(|| "Stick Note".to_string())
}

#[cfg(windows)]
fn windows_resources(repo: &Path, manifest_dir: &Path, version: &str) {
    let manifest = manifest_dir.join("windows").join("stick-note.manifest");
    let icon = repo.join("public").join("icons").join("app.ico");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rerun-if-changed={}", icon.display());
    println!("cargo:rerun-if-changed={}", repo.join("LICENSE").display());

    let (major, minor, patch) = numeric_version(version);
    let numeric = (major << 48) | (minor << 32) | (patch << 16);
    let dotted = format!("{major}.{minor}.{patch}.0");

    let mut res = winresource::WindowsResource::new();
    res.set_icon(icon.to_str().expect("icon path is valid UTF-8"));
    res.set_manifest_file(manifest.to_str().expect("manifest path is valid UTF-8"));
    res.set_language(0x0409); // English (United States)
    res.set_version_info(winresource::VersionInfo::FILEVERSION, numeric);
    res.set_version_info(winresource::VersionInfo::PRODUCTVERSION, numeric);
    res.set("FileVersion", &dotted);
    res.set("ProductVersion", version);
    res.set("ProductName", "Stick Note");
    res.set("FileDescription", "Stick Note");
    res.set("InternalName", "Stick Note");
    res.set("OriginalFilename", "Stick Note.exe");
    res.set("CompanyName", "Stick Note");
    res.set("LegalCopyright", &copyright(repo));
    res.compile().expect("could not embed the Windows resources (icon, version information, manifest)");
}

#[cfg(not(windows))]
fn windows_resources(_repo: &Path, _manifest_dir: &Path, _version: &str) {
    let _ = (numeric_version, copyright); // only the Windows build uses these
}
