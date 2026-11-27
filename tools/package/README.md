# Packaging

Builds the files a person downloads from a release, so that nobody needs Node.js or a terminal. The scripts use only Node.js built-ins plus standard operating system tools. File names come from `names.mjs`; templates and the installer script are in `packaging/`.

| File in `dist/` | Build on | Needs |
|---|---|---|
| `StickNote-<version>-windows-x64-setup.exe` | Windows | Inno Setup 6 (`winget install JRSoftware.InnoSetup`) and `csc.exe` (part of Windows) |
| `StickNote-<version>-windows-x64-portable.zip` | Windows | `csc.exe` |
| `stick-note_<version>_amd64.deb` | Linux | `dpkg-deb`, GNU `tar`, `xz` |
| `StickNote-<version>-linux-x64.AppImage` | Linux | the same |
| `StickNote-<version>-linux-x64.tar.gz` | Linux | the same |
| `SHA256SUMS.txt` | anywhere | Node.js |

Every package contains the official Node.js runtime (downloaded, verified and cached, see "Pinned downloads"), the app (`server.js`, `src/`, `public/`, `package.json`, `LICENSE`) and a generated `build-info.json`. That file tells the app how it was packaged: `channel`, and `dataDir` (`user` for the installer, `.deb` and AppImage, so notes survive upgrades; `../data` for the portable zip and tar.gz, so notes sit next to the app).

## Build

```
npm run package:windows                  # installer and portable zip   (add: -- --only portable)
npm run package:linux                    # on Linux: .deb, AppImage, tar.gz   (add: -- --only deb,tarball)
npm run package:linux:wsl                # on Windows: build and test the Linux packages inside WSL (add: -- --distro Ubuntu-22.04)
npm run package:checksums                # dist/SHA256SUMS.txt   (add: -- --require-all, as the release does)
```

`dist/` (results) and `.cache/` (downloads) are git-ignored. The Linux packages are assembled in the temporary folder, which must be a real Linux file system; `package:linux:wsl` takes care of that and unpacks the pinned Linux Node.js inside WSL to run the scripts.

## Test

```
npm run package:smoke                    # Windows: portable + installer. Linux: deb + AppImage + tar.gz
npm run package:smoke -- --only portable
node tools/package/wsl.mjs smoke --only deb --fuse    # Linux packages from Windows
npm test                                 # also runs package.test.mjs (zip writer, templates, pinned actions, ...)
```

Each smoke test starts the packaged app with `STICK_NOTE_NO_OPEN=1` on a port between 4760 and 4790 and a temporary `APPDATA` / `XDG_DATA_HOME`, checks `/api/ping`, the page, `/locales/en.json` and `/api/info` (channel, version, data folder), saves a note and finds `board.json` in the expected folder, then runs `--stop`. It also checks that the bundled runtime is byte-for-byte the verified official one. Beyond that:

- **Windows installer:** silent install, run, silent re-install over a *running* copy (the installer must stop the server first or Windows refuses to replace its exe), silent uninstall (the notes must survive). It creates and removes a Start Menu shortcut and a registry entry, and refuses to run if a `Stick Note.lnk` already exists there, because uninstalling deletes it. The Desktop shortcut is only tested with `--desktop-shortcut` (CI does) for the same reason. Never click through the installer wizard on a machine whose Desktop has your own "Stick Note" shortcut.
- **.deb:** contents and permissions, `lintian` (errors fail the test; `--require-lintian` fails if it is missing), `dpkg -i`, upgrade over a running copy, `dpkg -r`. It needs root or passwordless `sudo` and refuses to run if `stick-note` is already installed.
- **AppImage:** runs without FUSE (`APPIMAGE_EXTRACT_AND_RUN`); `--fuse` also runs it mounted, as a person would.

## Pinned downloads

`runtime.json` holds the Node.js version and the SHA-256 of the Windows zip and the Linux tar.xz, plus URL and SHA-256 of `appimagetool` and the AppImage runtime. A download is used only if its hash matches; a fresh Node.js download must also match the official `SHASUMS256.txt`. appimagetool would fetch an unpinned "continuous" runtime on its own, so the runtime is pinned here and passed with `--runtime-file`.

- **New Node.js version:** `node tools/package/runtime.mjs update 24.x.y`. It rewrites `runtime.json` from nodejs.org's `SHASUMS256.txt`. Then run `npm run package:windows`, `npm run package:linux:wsl` and the smoke tests, and commit `runtime.json`. Stay on an LTS line.
- **New appimagetool or AppImage runtime:** change the URL and SHA-256 in `runtime.json` (GitHub shows the digest of each release asset).
- `node tools/package/runtime.mjs fetch win-x64|linux-x64|appimage` only downloads and verifies.

## Releases

`.github/workflows/package.yml` builds and smoke-tests everything on `windows-latest` and `ubuntu-latest`; `ci.yml` calls it on every push and pull request. `release.yml` runs on a `vX.Y.Z` tag: it checks the tag against `package.json`, runs the tests, calls `package.yml`, writes `SHA256SUMS.txt`, creates build-provenance attestations for every file and publishes the GitHub release with notes from `tools/release-notes.mjs`. Every action is pinned to a commit; Dependabot proposes updates weekly.

## Things to know

- **Never change the `AppId`** in `packaging/windows/installer.iss`: Windows uses it to find an earlier installation for upgrades and uninstall.
- The installer and uninstaller run `--stop` on port `PORT` (default 4747) before touching files. Nothing ever deletes the data folder.
- The `.deb` suggests (not depends on) a Chromium-based browser, so apt never pulls one in; without one the app opens in the default browser. It depends on `libc6`, `libgcc-s1` and `libstdc++6`, which the bundled Node.js needs.
- Environment variables: `STICK_NOTE_MAINTAINER_EMAIL` (the `.deb` maintainer address; defaults to `git config user.email`), `SOURCE_DATE_EPOCH` (timestamp in the packages; defaults to the commit time), `STICK_NOTE_COMMIT`, `CSC` and `ISCC` (paths of the compilers).
- Nothing is code-signed, so Windows SmartScreen says "Windows protected your PC" for the installer and the portable exe.
