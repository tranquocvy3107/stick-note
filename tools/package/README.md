# Packaging

Builds the files a person downloads from a release, so that nobody needs Node.js, Rust or a terminal. The scripts use only Node.js built-ins plus standard operating system tools and the Rust compiler. File names come from `names.mjs`; templates and the installer script are in `packaging/`.

| File in `dist/` | Build on | Needs |
|---|---|---|
| `StickNote-<version>-windows-x64-setup.exe` | Windows | Rust (cargo) and Inno Setup 6 (`winget install JRSoftware.InnoSetup`) |
| `StickNote-<version>-windows-x64-portable.zip` | Windows | Rust (cargo) |
| `stick-note_<version>_amd64.deb` | Linux, or Windows through WSL | Rust with the musl target, `dpkg-deb`, GNU `tar`, `xz` |
| `StickNote-<version>-linux-x64.AppImage` | the same | the same |
| `StickNote-<version>-linux-x64.tar.gz` | the same | the same |
| `SHA256SUMS.txt` | anywhere | Node.js |

Every package holds **one program file** and nothing else that runs: `Stick Note.exe` (a Windows GUI program of about 1.4 MB) or `stick-note` (a statically linked `x86_64-unknown-linux-musl` program of about 1.5 MB that runs on any distribution), with the web interface inside it. Next to the program sit `build-info.json` (how the copy was packaged: `channel`, and `dataDir`: `user` for the installer, `.deb` and AppImage, so notes survive upgrades; `data` for the portable zip and tar.gz, so notes sit next to the program), the licence and `THIRD-PARTY-NOTICES.txt` (every Rust crate compiled in, with its license text, made from `cargo metadata` by `rust.mjs`).

The compiler is pinned in `rust-toolchain.toml` and every build uses `--locked` (the versions in `Cargo.lock`). Builds replace the paths of the build machine and, on Windows, ask the linker not to write the build time, so the same commit gives the same program.

## Build

```
npm run package:windows                  # installer and portable zip   (add: -- --only portable)
npm run package:linux                    # on Linux: .deb, AppImage, tar.gz   (add: -- --only deb,tarball)
npm run package:linux:wsl                # on Windows: build and test the Linux packages through WSL (add: -- --distro Ubuntu-22.04)
npm run package:checksums                # dist/SHA256SUMS.txt   (add: -- --require-all, as the release does)
```

`dist/` (results), `target/` (Rust build output) and `.cache/` (downloads) are git-ignored. The Linux packages are assembled in the temporary folder, which must be a real Linux file system; `package:linux:wsl` takes care of that: it cross-builds the static Linux program on Windows (with Rust's own linker, `rust-lld`, so no Linux toolchain is needed), then runs `build-linux.mjs` and the smoke tests inside WSL with `--exe` and `--notices`.

## Test

```
npm run package:smoke                    # Windows: portable + installer. Linux: deb + AppImage + tar.gz
npm run package:smoke -- --only portable
node tools/package/wsl.mjs smoke --only deb --fuse    # Linux packages from Windows
npm test                                 # also runs package.test.mjs (zip writer, templates, notices, pinned actions, ...)
```

Each smoke test starts the packaged program with `STICK_NOTE_NO_OPEN=1` on a port between 4760 and 4790 and a temporary `APPDATA` / `XDG_DATA_HOME`, checks `/api/ping`, the page, `/locales/en.json` and `/api/info` (channel, version, data folder), saves a note and finds `board.json` in the expected folder, then runs `--stop`. It also checks that the program is a GUI program (Windows) or statically linked (Linux), and that no part of the old Node.js layout is left. Beyond that:

- **Windows installer:** silent install, run, silent re-install over a *running* copy (the installer must stop the server first or Windows refuses to replace the exe), the same over a running copy of the **old layout** (versions up to 1.2.x ran on Node.js; the test lays one out from the git tag `v1.2.0`, so the tags must be fetched), silent uninstall (the notes must survive). It creates and removes a Start Menu shortcut and a registry entry, and refuses to run if a `Stick Note.lnk` already exists there or if Stick Note is installed: every installer shares one `AppId`, so a test installation would overwrite your entry under "Apps & features" and its uninstall would delete it. The Desktop shortcut is only tested with `--desktop-shortcut` (CI does) for the same reason. Never click through the installer wizard on a machine whose Desktop has your own "Stick Note" shortcut.
- **Test installer variant** for a machine that has Stick Note installed: `node tools/package/build-windows.mjs --only installer --no-shortcuts` writes `dist/test-installer/…-setup.exe`, an installer with its **own AppId and no shortcuts**, and `node tools/package/smoke-windows.mjs --only installer --no-shortcuts` tests that one. Everything else is the same. CI tests the real installer on a clean runner.
- **.deb:** contents and permissions, `lintian` (errors fail the test; `--require-lintian` fails if it is missing), `dpkg -i`, upgrade over a running copy, `dpkg -r`. It needs root or passwordless `sudo` and refuses to run if `stick-note` is already installed.
- **AppImage:** runs without FUSE (`APPIMAGE_EXTRACT_AND_RUN`); `--fuse` also runs it mounted, as a person would.

## Pinned downloads

`downloads.json` pins the few third-party programs the scripts download, each with its SHA-256: `appimagetool` and the AppImage runtime (the small program at the front of every AppImage; appimagetool would fetch an unpinned "continuous" runtime on its own, so the runtime is pinned here and passed with `--runtime-file`), and the official Node.js for Linux, which is only used to run these scripts inside WSL (a fresh WSL distribution has no Node.js). A download is used only if its hash matches; a fresh Node.js download must also match the official `SHASUMS256.txt`.

- **New Rust version:** change `channel` in `rust-toolchain.toml`, run `rustup toolchain install`, `npm test`, `npm run package:windows`, `npm run package:linux:wsl`, and say so in `CHANGELOG.md`.
- **New crate versions:** Dependabot proposes them every week (`cargo update` does the same by hand). `Cargo.lock` is committed.
- **New Node.js for the WSL helper:** `node tools/package/downloads.mjs update-node 24.x.y`.
- **New appimagetool or AppImage runtime:** change the URL and SHA-256 in `downloads.json` (GitHub shows the digest of each release asset).
- `node tools/package/downloads.mjs fetch node|appimage` only downloads and verifies.

## Releases

`.github/workflows/package.yml` builds and smoke-tests everything on `windows-latest` and `ubuntu-latest`; `ci.yml` calls it on every push and pull request. `release.yml` runs on a `vX.Y.Z` tag: it checks the tag against `package.json`, runs the tests, calls `package.yml`, writes `SHA256SUMS.txt`, creates build-provenance attestations for every file and publishes the GitHub release with notes from `tools/release-notes.mjs`. Every action is pinned to a commit; Dependabot proposes updates weekly.

## Things to know

- **Never change the `AppId`** in `packaging/windows/installer.iss`: Windows uses it to find an earlier installation for upgrades and uninstall. (The test variant has its own, on purpose.)
- The installer and uninstaller run `--stop` on port `PORT` (default 4747) before touching files, with the new program or, when they meet an installation of the old layout, with its Node.js. `[InstallDelete]` removes the old `app\` and `runtime\` folders. Nothing ever deletes the data folder.
- The `.deb` installs the program in `/usr/lib/stick-note` with `/usr/bin/stick-note` as a link to it; the program finds its `build-info.json` next to itself, following the link. It depends on no library and only suggests (does not depend on) a Chromium-based browser, so apt never pulls one in; without one the app opens in the default browser. Upgrading from a 1.2.x package: dpkg runs the old package's `prerm`, which stops the old server, and then removes the old `/opt/stick-note` files.
- Environment variables: `STICK_NOTE_MAINTAINER_EMAIL` (the `.deb` maintainer address; defaults to `git config user.email`), `SOURCE_DATE_EPOCH` (timestamp in the packages; defaults to the commit time), `STICK_NOTE_COMMIT`, `CARGO` and `ISCC` (paths of cargo and the Inno Setup compiler).
- Nothing is code-signed, so Windows SmartScreen says "Windows protected your PC" for the installer and the portable exe, and some antivirus programs are wary of any small unsigned program. The checksums and the build attestations are how a download can be checked.
