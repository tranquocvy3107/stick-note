# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-28

Stick Note is now a native program: one small file, with no Node.js inside. This release also fixes a window losing its connection to the server and records the project's new address.

### Changed

- **The program is rewritten in Rust.** The local server, the launcher and the command line are now one program of about 1.5 MB, instead of an 80 MB Node.js runtime plus scripts. The Windows installer shrinks from about 24 MB to 2.5 MB, the portable zip and the Linux packages to under 2 MB. Nothing changes in how Stick Note looks or works: the same interface, the same app window, the same notes, the same files. The notes folder is read and written in exactly the layout of earlier versions, so going back to an earlier version works too.
- **Updating from 1.2.x** replaces the old Node.js files (the `runtime` and `app` folders) with the new program and keeps your notes. A running copy is stopped by the installer.
- The Linux packages hold a single static program that runs on every distribution; the `.deb` no longer depends on any library.
- When Stick Note cannot start (for example because another program uses port 4747) it now says so in a message box, with the reason, instead of failing silently.
- Building from source needs Rust (via `rustup`; the exact compiler version is in `rust-toolchain.toml`) and Node.js 20.11 or newer for the tests. See CONTRIBUTING.md.
- The project moved to https://github.com/vytk712025main-eng/stick-note. The old address redirects there. Links, issue templates and release notes now use the new address.
- **Checking a download** (optional): releases up to 1.2.0 were built before the move and can be verified with `gh attestation verify <file> --owner tranquocvy3107`. This and later releases use `gh attestation verify <file> --repo vytk712025main-eng/stick-note`. The checksums in `SHA256SUMS.txt` work for every release.
- `/api/info` also reports how many windows are open.

### Fixed

- **"Lost connection to the server" after leaving the window alone.** The background server used to quit when the window had not reported in for 5 minutes. A browser can freeze or slow down a window that is minimised or hidden, so the server took a window that was only resting for a closed one and shut down, and the window showed the red "Lost connection" bar when you came back. Each window now says goodbye when it really closes, and the server only quits after that: a window that is merely quiet is never counted as closed. If the server ever does stop, the window still keeps your notes and saves them as soon as you open Stick Note again from its shortcut.

### Added

- `THIRD-PARTY-NOTICES.txt` in every package lists the open source libraries inside the program with their licenses.
- Contract tests that start the real program and check the whole HTTP interface, the data files, the backups and the command line, including a data folder written by the last Node.js server.

## [1.2.0] - 2026-11-27

Zones: sort a busy board by drawing labelled areas on it.

### Added

- **Zones.** Labelled rectangles behind the notes, in three kinds: *Important*, *Normal* and *Low priority* (its notes fade so clutter recedes). Any zone can also be *Private*: its notes are blurred until you click them (the lock on the zone's tab shows or hides them all). A zone is only a frame: nothing inside it is ever moved, sorted or aligned for you.
- Draw a zone by pressing and holding on an empty spot for half a second and then dragging (a quick drag still moves the board). Other ways: the `Z` key, the dashed tile in the tray, or `G` to wrap the selected notes.
- Drag a zone's name tab to move it together with the notes whose middle is inside it, and with the zones inside it (pinned notes stay where they are). Drag an edge or corner to resize; double-click the tab, or press `Enter` or `F2`, to rename.
- Deleted zones go to the trash with the notes' trash (restorable for 60 days) and `Ctrl+Z` undoes every zone change. Zones are merged between windows like notes.
- "Show all notes" (`Shift+1`) includes the zones.

### Changed

- The board file gains two optional lists, `zones` and `zonesTrash`. Files from 1.1 open unchanged. The server keeps the zones when a window that does not know about them saves.

## [1.1.0] - 2026-11-27

Easy to install on Windows and Linux, available in English and Vietnamese, and open to contributors.

### Added

- **Installers.** Windows: a setup program that needs no administrator rights, plus a portable zip. Linux: a `.deb`, an AppImage and a tarball. Node.js is bundled, so nothing else has to be installed.
- **English and Vietnamese interface**, chosen from the browser language and switchable in the menu (Language). A new language is one JSON file in `public/locales`.
- **Menu:** *Quit Stick Note*, and the version number at the bottom.
- **Linux support:** finds Chrome, Chromium, Edge or Brave for the app window and falls back to the default browser.
- Command-line options `--run`, `--stop`, `--version` and `--data-dir`, and `start.sh` for source checkouts on Linux and macOS.
- Installed copies keep notes in a per-user folder (`%APPDATA%\Stick Note`, `~/.local/share/stick-note`) so upgrading or uninstalling never touches them. Portable copies keep them next to the app.
- `CONTRIBUTING.md`, `SECURITY.md`, issue and pull request templates, tests on Node 22, 24 and 26 on Windows and Linux, and a release workflow that publishes checksums and build attestations.

### Changed

- All code, comments and documentation are now in English, and the README is rewritten for people who just want to install the app.
- The server is split into small modules under `src/`. API errors carry a stable code that the interface translates.
- Running from a source checkout behaves as before: notes stay in `./data`.

### Upgrading from 1.0

Nothing changes if you keep running from your unpacked folder. To switch to an installer, quit Stick Note, then copy the contents of your old `data` folder into the new data folder before the first start (see the README).

## [1.0.0] - 2026-11-27

The first release.

### Added

- One infinite whiteboard: drag the background to move around, `Ctrl` + scroll to zoom, and it reopens exactly where you left it.
- A tray of paper slips in 7 colours: drag one onto the board and type. You can also double-click the background, press `N`, paste with `Ctrl+V` (text, links, screenshots) or drag links, images, `.url` and `.txt` files in from elsewhere.
- Text notes recognise links (click to open, a small button to copy) and image notes keep the original picture untouched, with a thumbnail so the board stays light, a large view and copy.
- Move, resize, recolour, pin in place, select several notes, undo and redo.
- Search that ignores diacritics (Vietnamese included): matching notes light up and nothing moves.
- A trash that keeps notes for 60 days and can restore them.
- Light and dark appearance, and an option to turn off the slight tilt of the notes.
- Automatic saving into the `data/` folder (JSON file and images), a backup every day, automatic recovery from a damaged file, merging when several windows are open, and unsaved notes kept in the window if the server stops unexpectedly.
- Opens as its own app window with `start.bat`, a script that creates a desktop shortcut, and a background server that quits by itself when the window is closed.

[1.3.0]: https://github.com/vytk712025main-eng/stick-note/releases/tag/v1.3.0
[1.2.0]: https://github.com/vytk712025main-eng/stick-note/releases/tag/v1.2.0
[1.1.0]: https://github.com/vytk712025main-eng/stick-note/releases/tag/v1.1.0
[1.0.0]: https://github.com/vytk712025main-eng/stick-note/releases/tag/v1.0.0
