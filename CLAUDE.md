# Stick Note: notes for AI coding agents (and a map for people)

Stick Note is a personal notes app with **one screen: a whiteboard**. You drag a paper slip from a tray onto the board, write (text, a link, an image) and leave it there. No folders, no tags, no lists: **position on the board is the organisation.** The board fills up and gets messy, and that is fine, because the owner remembers where everything is, comes back to read it, click links and copy.

It runs on the user's own computer (Windows and Linux; macOS later), offline, as a small Node.js server plus a browser window opened with `--app`.

## Working agreement with the owner (read this first)

> If you have any question, ask me. If information is missing, ask me to provide it.

- When something is unclear, **ask before guessing**. Use the AskUserQuestion tool, bundle questions into one round and put your recommended option first.
- When information is missing (a path, an account, a decision, an example), **say exactly what you need**. Never invent placeholder values.
- When you have a proposal, keep it short so the owner can decide quickly; they are not a programmer.
- **Talk to the owner in Vietnamese.** Everything inside the repository (code, comments, docs, commit messages, PRs, UI source strings) is **English**. The Vietnamese UI lives only in `public/locales/vi.json`.
- When you finish, say what you did, how you checked it, and what you could not check.
- **The owner uses the installed app every day** (the Windows setup program): program in `%LOCALAPPDATA%\Programs\Stick Note`, real notes in `%APPDATA%\Stick Note`, server on port 4747. Never stop or restart that server, never touch that folder, never click through an installer wizard. The unzipped folder that holds the main checkout of this repository is an old 1.0 copy: do not edit files there, do not run its `start.bat` (it would split the notes into a second place), do not delete anything in it without asking. Develop in a git worktree (`.claude/worktrees/<name>`, on its own branch) and always use a temp `STICK_NOTE_DATA` and another port. Double-check absolute paths: a file written without the worktree prefix lands in the old folder.
- Every push, pull request, tag or release goes to a **public** repository: ask the owner first. Never commit `data/` or anything personal. Commits use the repository's GitHub noreply e-mail (already set in the repo config).

## Product principles (do not break)

1. **Position is sacred.** The app never sorts, aligns, moves or groups notes by itself. A note moves only when the owner drags it, or drags the zone it sits in (the one exception: `freeSpot` nudges a *new* note sideways if it would land exactly on another).
2. **The board is the only interface.** No pages, folders, tags, lists or management screens. Controls are small, at the edges, and never cover the board.
3. **Fast capture.** Drag a slip, double-click the board, press `N`, or `Ctrl+V` (text, link, image).
4. **Fast reuse.** Links open and copy at once; images view and copy at once.
5. **No data loss.** Autosave, safe writes, daily backups, trash, undo. Anything that could lose data needs the owner's approval first.
6. **The board remembers where you were looking** (position and zoom).

## Decisions agreed with the owner

- Local desktop app, offline, opened as its own window (Edge/Chrome/Chromium/Brave `--app`), not a hosted website. Windows and Linux first.
- Infinite board; text, links, images and screenshots.
- UI language: English by default plus Vietnamese, picked from the browser language and switchable in the menu. More languages are one JSON file. The repository, README and docs are English only, because the project is meant to be open to contributors.
- No runtime dependencies. Build-time tools for packaging are allowed when justified.
- Releases are small and sequential, each tried by the owner before it is published:
  - **1.1**: English everywhere, translations, installers for Windows and Linux.
  - **1.2**: **Zones** (below).
  - **2.0**: **Vault**: security, backups and history (below).
- **Zones (1.2, built).** Labelled rectangles drawn behind the notes. Kinds: *Important*, *Normal*, *Low priority* (its notes fade so clutter recedes) and a separate *Private* flag that combines with any kind (its notes are blurred until clicked; purely visual in 1.2, the Vault hardens it). Rectangles first; freeform lasso only if the owner still wants it after trying them. Create by pressing and holding about 0.4 s on empty board and then dragging (a quick drag still pans), or `Z`, or the dashed tray tile, or `G` to wrap the selected notes. A note belongs to a zone when its **centre** is inside it (computed, never stored). Dragging a zone's name tab moves it with the notes whose centre is inside it and the zones that lie entirely inside it; pinned notes stay. Positions stay sacred: a zone never rearranges what is inside.
- **Vault (2.0).** One optional passphrase encrypts everything at rest (board, images, thumbnails, snapshots, backups) with AES-256-GCM, a random data key wrapped by a key derived from the passphrase (scrypt) and by a printed recovery key; the app offers it on first launch and can remember the unlock on this device (Windows DPAPI, Linux keyring when available). Private zones blur their content, are left out of search until revealed, and clear the clipboard after copying. Plus: a per-session access token for the local server, a dedicated browser profile for the app window, rolling snapshots with a history browser (restore a whole board or single notes), export/import of one backup file, and a `verify` check. Forgetting both passphrase and recovery key means the data cannot be recovered: say so plainly in the UI.
- Data location depends on how it was installed: installer, `.deb`, AppImage use a per-user folder (`%APPDATA%\Stick Note`, `~/.local/share/stick-note`) so upgrades and uninstalls never touch notes; portable zip/tarball use `data/` next to the app; a source checkout uses `./data`. `STICK_NOTE_DATA` overrides everything.

## Commands

| Command | What it does |
|---|---|
| `npm test` | All tests (`node --test`, no install step) |
| `node server.js` | Run in the foreground and print the log (`start-debug.bat` on Windows) |
| `node server.js --open` | Start a background server if needed, then open the app window (`start.bat`, `./start.sh`, `npm start`) |
| `node server.js --run` | Foreground server that also opens the window and quits when idle (the AppImage uses this) |
| `node server.js --stop` | Ask a running server to quit |
| `node server.js --version` / `--data-dir` | Print the version / the folder holding the notes |
| `tools/create-shortcut.ps1` | Desktop shortcut for a source checkout (the installers make their own) |
| `tools/package/*` | Build the installers; see `tools/package/README.md` |

From a Windows terminal run `.\start.bat` (this machine sets `NoDefaultCurrentDirectoryInExePath=1`, so a bare `start.bat` is not found).

Environment variables: `PORT` (default 4747), `STICK_NOTE_DATA` (data folder), `STICK_NOTE_IDLE_MS` (how long after the last window said goodbye the background server quits, default 300000), `STICK_NOTE_BROWSER` (path of the browser used for the app window), `STICK_NOTE_NO_OPEN=1` (print `OPEN <url>` instead of opening a window; use it in every automated test).

**When testing, always point `STICK_NOTE_DATA` at a temp folder and use another port (4748, 4750, ...)** so real notes and the owner's running copy are never touched.

## Architecture

No build step. The browser loads ES modules straight from `public/js`.

```
server.js              Entry point and command line
src/
  paths.js             Where things live: app folder, data folder (per install channel), build-info.json, VERSION
  app.js               createApp(): HTTP server, JSON API, board storage, images, backups, idle exit
  presence.js          Which windows are open and when the background server may quit (pure, tested)
  launcher.js          probe/wait, browser detection (Windows, Linux, macOS), open the app window, --stop
  http.js, util.js     Response helpers and CSP; atomic file write, image sniffing, timestamps
public/
  index.html           All markup (no inline script: CSP forbids it). data-i18n* attributes name message keys
  css/app.css          All styling, light and dark
  locales/             en.json (the reference), vi.json
  js/
    main.js            Start-up: i18n, wiring, load, hello/goodbye to the server, save on exit
    i18n.js            Tiny translation layer (placeholders, plurals, [[kbd]] and **bold** markup)
    store.js           Data, undo/redo, autosave, conflict handling. Every data change goes through here
    merge.js           Merge two versions of the board item by item, notes and zones (pure, tested)
    api.js             Calls the server (writes carry X-Stick-Note)
    view.js            Infinite viewport: coordinates, pan, zoom, animation
    noteview.js        Draws notes to the DOM (links, images); toolbars built lazily
    zones.js           Zone logic (pure, tested): geometry, which notes sit in a zone, saved-data checks
    zoneview.js        Draws zones (rectangle, name tab, bar, handles) and the faded / blurred look of the notes inside
    interactions.js    All pointer, touch and keyboard behaviour: select, drag, resize, edit, copy, delete, undo
    zoneinteractions.js  Draw, move, resize, rename, options and delete for zones (interactions.js lends it the gesture machinery)
    capture.js         Every way of putting something on the board: tray, double-click, paste, drop
    image.js           Read images, make thumbnails, upload
    ui.js              Zoom bar, search, menu, trash drawer, image viewer, help, notices
    util.js, constants.js, icons.js
test/                  logic, server, paths/launcher and i18n suites
tools/                 icons, release notes, create-shortcut; package/ builds installers and release assets
packaging/             Inno Setup script, Windows launcher source, Linux desktop and package files
.github/               CI and release workflows, issue and PR templates, Dependabot
docs/                  Screenshots for the README
```

### Data model

`board.json`: `{ app, schema: 1, rev, savedAt, notes: [...], trash: [...], zones: [...], zonesTrash: [...] }`. The two zone lists are optional on disk and on the wire: a file from 1.1 has none, and a window that does not send them (an old interface) leaves the saved zones untouched.

Note: `{ id, k: 'text'|'image', x, y, w, h?, c (colour), r (tilt), z, lock?, t (text or caption), ts, mt }`. Images add `img`, `th` (thumbnail), `iw`, `ih`. Trashed notes add `del`. `mt` (last modified) decides merges, so **every change must update `mt`** (the functions in `store.js` do). The viewport (x, y, zoom), theme, tilt and language live in `localStorage`, not in `board.json`, so two windows never fight over them.

Zone: `{ id, x, y, w, h, k: 'important'|'normal'|'low', p? (1 = private), t? (name), ts, mt }`; ids start with `z`, trashed zones add `del`. Which notes are "in" a zone is never stored: it is computed from each note's centre (`zones.js`), so nothing can drift out of step. Zones are saved, undone and merged exactly like notes (`store.js`, `merge.js`). Which private notes the owner has opened lives only in memory (`zoneview.js`) and is forgotten on reload.

### Saving and syncing

- The client saves 350 ms after the last change. `PUT /api/board` carries `baseRev`; if the server's `rev` moved on it answers `409` with the current board, and the client merges with `mergeBoards` and saves again. So two windows never overwrite each other.
- On a save error it retries with growing delays (up to 15 s), mirrors the board into `localStorage['stick-note:pending']`, and shows a red banner after 4 s. The mirror is merged back on the next start.
- The server writes safely (temp file, fsync, rename). Backups: one per day (60 kept), a `before-shrink` copy when the note count drops below 60 %, `manual` copies. A damaged `board.json` is recovered from the newest backup.
- Images are stored by content hash (`<sha1>.<ext>`), never overwritten, never deleted (orphans of purged notes stay; there is no cleanup tool yet).
- The server binds to `127.0.0.1` only and checks `Host`, `Origin` and the `X-Stick-Note` header on writes; the CSP forbids inline script. A background server quits by itself once no window is left: each window has a name (kept in `sessionStorage`), says hello with `GET /api/ping?w=<name>` every 20 s and goodbye with `POST /api/bye?w=<name>` when it closes, and the server quits `STICK_NOTE_IDLE_MS` after the last goodbye. A window that merely goes quiet still counts as open (see the first trap below); windows of 1.2.0 and older ping without a name, and for them the old rule holds (quit after that much silence). Details and the one-week safety net are in `src/presence.js`.

### API

`GET /api/ping[?w=<window>]`, `POST /api/bye?w=<window>`, `GET /api/rev`, `GET|PUT /api/board`, `POST /api/images`, `POST /api/thumb?of=<id>`, `GET /img/<id>`, `GET /api/info` (version, channel, data folder, counts, windows open), `POST /api/backup`, `POST /api/open-data-folder`, `POST /api/shutdown`.
Errors are `{ "error": "<code>", "message": "<English text>" }`; the interface translates by code.

### Translations

Every visible text is a key in `public/locales/en.json` (flat object, `{placeholders}`, plural objects, `[[Ctrl]]` key caps, `**bold**`). `t()` must never run at module load time (the catalogue is loaded in `main.js` first). `npm test` checks that every language has the same keys and placeholders and that every key used in the code exists. Adding a language is documented in `CONTRIBUTING.md`.

## Packaging and releases

`tools/package/README.md` documents building the Windows installer and portable zip and the Linux `.deb`, AppImage and tarball, the pinned Node.js runtime, and the smoke tests. File names come from `tools/package/names.mjs`. Windows executables are not code-signed yet (SmartScreen warns); free signing for open source projects is a possible later step.

Release procedure (ask the owner before every push, PR, tag or release):

1. Bump `version` in `package.json`; add `## [x.y.z] - YYYY-MM-DD` and its link to `CHANGELOG.md`.
2. `npm test`; commit on a branch; open a PR; wait for CI; merge with `gh pr merge --squash --author-email 263265751+tranquocvy3107@users.noreply.github.com --match-head-commit <sha>`. **Never merge without `--author-email`**: GitHub then writes the owner's real e-mail address into the squash commit of this public repository (it happened with 1.1.0 and the commit had to be replaced by force-pushing `main` once). The owner should also switch on "Keep my email addresses private" in the GitHub e-mail settings of every account that commits or merges: a merge made in the web page by another account (for example the repository owner account) would leak that account's address the same way.
3. `git tag vx.y.z` on the merge commit and `git push origin vx.y.z`. The release workflow builds everything, writes `SHA256SUMS.txt`, attests the files and creates the GitHub release with notes from `CHANGELOG.md`.
4. Download one file per platform from the release, install it for real, and check that it starts and keeps the notes.

Where the project lives: https://github.com/vytk712025main-eng/stick-note (moved from `tranquocvy3107/stick-note` on 2026-11-27; the old address redirects, `git push` included). The `gh` login on the owner's computer is still `tranquocvy3107`, now a *write collaborator*: enough to push branches and tags, open and merge PRs and create releases. Settings (security options, auto-merge, collaborators, webhooks) need the owner signed in as `vytk712025main-eng`. **Never create a repository called `stick-note` under `tranquocvy3107`** (the redirects would be deleted) and **never delete or rename that account**: the build attestations of releases 1.0 to 1.2.0 are stored under it.

Verifying attestations: releases up to 1.2.0 verify only with `gh attestation verify <file> --owner tranquocvy3107` (`--repo` answers HTTP 404 since the move). Releases built after the move should verify with `--repo vytk712025main-eng/stick-note`; check that once after the first release built there, and fix the README and `tools/release-notes.mjs` if it does not work. `LICENSE` and the `author` field of `package.json` still name `tranquocvy3107` (a transfer does not move copyright); change them only when the owner decides.

## Traps we already fell into

- **A quiet window is not a closed window.** A browser freezes or slows down a window that is minimised or hidden, so its timers (the 20 s heartbeat) can stop for hours. Version 1.2.0 quit the server after 5 minutes without a heartbeat, and a window left alone found its server gone ("Lost connection to the server", log line `No window has been open for a while`). The server now keeps running until a named window says goodbye (`presence.js`); never go back to "silence means closed". To reproduce a frozen window drive a throw-away headless Edge through the DevTools protocol: `Page.setWebLifecycleState` with `frozen`, and a server started with `STICK_NOTE_IDLE_MS=3000`. The old rule needs about 10 s to show, the new one survives indefinitely.
- **Never change a CSS custom property on a parent of the notes every frame.** Variables are inherited, so every note's style is recalculated (it cost 160 ms per frame with 1,500 notes). The grid is set directly on the board's style in `view.js`.
- **A note's toolbar is built lazily** (`ensureTools`, at most 12 alive). Building it up front for every note is 50,000+ hidden elements.
- **Do not leave focus on a link or button inside a note** (`mousedown` is cancelled, `click` still works). Otherwise `Enter` clicks it again instead of editing.
- Dragging that starts on a link must still drag the note without opening the link (`suppressClickUntil`, 4 px threshold).
- A new note left empty is discarded and its undo step removed (`popCheckpoint`).
- While a text field is composing (Telex, VNI, Pinyin) ignore `Esc` and `Enter` (`e.isComposing`).
- A note's `translate` and `rotate` are separate CSS properties (not one `transform`) so "straighten while editing" and "lift while dragging" stay independent.
- **Never change `left`, `top`, `width` or `height` of anything inside `#world` on every frame of a drag.** Any layout change costs the browser about 5 ms with 1,500 notes (measured), while `translate` costs about 0.1 ms. Dragging a zone therefore shifts the zone's parts with `translate` and writes the real position on release (`zoneinteractions.js`). Resizing still changes the size on every move, as resizing a note does.
- **A zone element must have no `transform`, `translate`, `opacity`, `filter` or `will-change`**: each creates a stacking context and traps the name tab under the notes. Visual effects go on its `.zbox` child.
- The `--zk` variable that keeps zone tabs readable when zoomed out is set on `#zones` only, at most about ten times a second: writing it makes the browser recalculate every zone element.
- A note's faded / blurred look comes from `refreshLooks` in `zoneview.js`, one pass over the notes (all of them after a zone change, only the touched ones after a note change). Do not add per-frame work to it.
- Do not call `t()` at import time, and do not name a local variable `t` where you also translate.
- Paths: a Write/Edit with a path missing the worktree prefix silently changes the owner's checkout.
- **Installer tests must never touch the owner's machine.** Never click through the Windows installer wizard here: its Desktop-shortcut task overwrites the owner's own `Stick Note.lnk` and uninstalling deletes it (this happened once; the shortcut was recreated with `tools/create-shortcut.ps1`). The smoke tests are silent and skip that shortcut on purpose. Never clean `%TEMP%` with a wildcard such as `sn-*`: other work keeps scratch folders there; delete only folders you created by exact name.
- Windows PowerShell 5.1 started from PowerShell 7 inherits `PSModulePath` and then `Expand-Archive` extracts nothing while exiting 0. The packaging scripts drop `PSModulePath` for child PowerShell processes (`childEnv`).

## Testing in the Claude environment

- The built-in browser pane is often hidden: `requestAnimationFrame` does not run, animations and screenshots lag (wait at least a second), the clipboard is denied and the page has no focus. Do not conclude "bug" from a screenshot taken right after an action; read real values with JavaScript.
- Real-engine screenshots: `msedge --headless=new --hide-scrollbars --window-size=1440,900 --virtual-time-budget=5000 --screenshot=<file> <url>` (on this machine Edge renders the dark theme by default).
- `window.stickNote` in the console exposes `store`, `view`, `layer`, `inter`, `ui`, `capture` for debugging and tests.
- The browser tool's drag cannot send the Shift key; test area selection with synthetic `PointerEvent`s that have `shiftKey: true`.
- Zones: dispatch synthetic `PointerEvent`s (`bubbles: true`, a fixed `pointerId`) on `#board`, on a zone's `.ztab` or on `document.body`. Press-and-hold needs a real wait of about 450 ms (`await new Promise((r) => setTimeout(r, 450))`) between the `pointerdown` and the first `pointermove`. A board with zones is easy to seed: write a `board.json` with `zones` into a temporary data folder. Clicking a note deselects the selected zone (and hides its bar), so select the zone again before clicking its buttons.
- `msedge --headless=new --screenshot` cannot choose the colour scheme or select a zone. For README screenshots drive Edge through the DevTools protocol (`--remote-debugging-port`, `Emulation.setEmulatedMedia` for `prefers-color-scheme`, `Page.captureScreenshot`) with a throw-away `--user-data-dir`.

## Not done yet (ask the owner before starting)

- The Vault above.
- Freeform (lasso) zones: only if the owner still wants them after using rectangles. Zone names are not searched yet.
- Cleanup of orphaned images in `images/`.
- Export/import as a single file (comes with the Vault).
- Checklists inside text notes.
- Phone use (needs remote access and sign-in; out of scope for now).
- macOS builds, a fallback port when 4747 is taken, an update check (must be opt-in: the app talks to nothing by default).
- `will-change: transform` while dragging/zooming if a board with thousands of notes still stutters (not measurable on real hardware yet).
