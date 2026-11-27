# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow [Semantic Versioning](https://semver.org/).

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

[1.2.0]: https://github.com/tranquocvy3107/stick-note/releases/tag/v1.2.0
[1.1.0]: https://github.com/tranquocvy3107/stick-note/releases/tag/v1.1.0
[1.0.0]: https://github.com/tranquocvy3107/stick-note/releases/tag/v1.0.0
