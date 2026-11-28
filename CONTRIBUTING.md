# Contributing to Stick Note

Thank you for helping! Stick Note is a small project with a strong idea, so a few ground rules keep it coherent. Bug reports, translations, documentation fixes and code are all welcome.

## The idea (please keep it intact)

Stick Note has **one screen: a whiteboard**. You drop paper notes on it and find them again by remembering *where* you put them. That means:

1. **Position is sacred.** The app never sorts, aligns, moves or groups notes by itself. A note moves only when its owner drags it.
2. **The board is the only interface.** No pages, folders, tags, lists or management screens. Controls are small, sit at the edges and never cover the board.
3. **Capturing is fast.** Drag a slip, double-click, press `N` or paste.
4. **Reusing is fast.** Links open and copy at once; images view and copy at once.
5. **Never lose data.** Autosave, safe writes, backups, a trash, undo. A change that could lose data needs discussion first.
6. **Few dependencies.** The interface is plain browser JavaScript with no dependencies and no build step. The program is Rust and uses a small set of widely used crates (see `Cargo.toml`). Please open an issue before adding one (build tools for packaging are discussed case by case).

If your idea bends one of these, open an issue first so we can talk it through before you spend time on it.

## Getting started

You need [Rust](https://rustup.rs) (the exact compiler version is pinned in `rust-toolchain.toml`; run `rustup toolchain install` in the folder once), [Node.js](https://nodejs.org) 20.11 or newer (it runs the JavaScript tests and the packaging scripts), and a Chromium-based browser (Edge, Chrome, Chromium, Brave).

```bash
git clone https://github.com/vytk712025main-eng/stick-note.git
cd stick-note
npm test                                  # builds the program, runs cargo test and the JavaScript tests
cargo run -- --serve                      # run in the foreground and watch the log (reads public/ from disk: edit and reload)
cargo run --release -- --open             # run in the background and open the app window (also: npm start)
```

**Use a throw-away data folder and another port while developing** so you never touch real notes or a copy you use every day. (A program built inside the checkout keeps its notes in `./data`, which is git-ignored.)

```bash
# bash
STICK_NOTE_DATA=/tmp/stick-dev PORT=4748 cargo run -- --serve
```
```powershell
# PowerShell
$env:STICK_NOTE_DATA = "$env:TEMP\stick-dev"; $env:PORT = '4748'; cargo run -- --serve
```

`STICK_NOTE_NO_OPEN=1` prints the address instead of opening a window (handy for scripts and tests).

## Project layout

```
Cargo.toml           The Rust workspace (the compiler version is pinned in rust-toolchain.toml)
crates/stick-note/   The program: cli.rs (command line), app.rs (HTTP, API), store.rs (board, backups, pictures),
                     presence.rs, paths.rs, launcher.rs (app window, browser detection), winui.rs (Windows details)
public/              The interface (plain ES modules, no build step); it is embedded into the program
  index.html         All the markup
  css/app.css        All the styling (light and dark)
  js/                main, store, view, noteview, interactions, capture, ui, i18n, ...
  locales/           en.json, vi.json: every visible text
test/                JavaScript suites; test/contract starts the real program and tests it over HTTP
tools/               Icon, test and release helpers; tools/package builds the installers
CLAUDE.md            Architecture notes and decisions in more detail
```

## Making a change

1. Fork, then create a branch from `main`.
2. Make the change. Keep it focused: one topic per pull request.
3. Add or update tests. Pure interface logic goes in `test/logic.test.js`; what the program does over HTTP or on the command line in `test/contract/`; Rust logic in a `#[cfg(test)]` module next to it.
4. Run `npm test`; everything must pass. CI also runs `cargo fmt --all --check` and `cargo clippy --all-targets -- -D warnings`.
5. If you changed what a user sees, try it in a real browser window and describe what you checked (a screenshot helps).
6. Open a pull request using the template.

### Style

- Plain JavaScript (ES modules), 2-space indent, single quotes, semicolons.
- Rust: `cargo fmt` decides the layout (`rustfmt.toml`), clippy must be quiet, and the only `unsafe` code lives in `winui.rs`.
- Everything in the repository is written in **English**: code, comments, commit messages, documentation.
- Comments explain *why*, not what. Name things plainly.
- No emoji in code or user-facing text.
- Commit messages: a short imperative summary ("Add zone resize handles"), then a paragraph on why if it is not obvious.

### Traps we already fell into

- Do not change a CSS custom property on a parent of the notes every frame: it forces a style recalculation of every note. The grid is set directly on the board's style.
- A note's toolbar is built lazily (`ensureTools`); building it for every note makes a large board crawl.
- Never leave focus on a link or button inside a note, or `Enter` will click it instead of editing.
- While a text field is composing (Telex, VNI, Pinyin...) ignore `Esc` and `Enter` (`e.isComposing`).
- Every change to a note must go through `store.js` so `mt` (last modified) is updated; merging two windows depends on it.

## Translations

Every visible text lives in `public/locales/<code>.json`. To add a language:

1. Copy `public/locales/en.json` to `public/locales/<code>.json` (for example `fr.json`) and translate the values. Keep the keys and the `{placeholders}`. Messages with `{ "one": ..., "other": ... }` are plurals (use the forms your language needs, or exact numbers such as `"1"`). `[[Ctrl]]` shows a key cap and `**text**` is bold.
2. Add `{ code: 'fr', name: 'Français' }` to `LANGUAGES` in `public/js/i18n.js`.
3. Run `npm test`. It tells you which messages are missing or have different placeholders.

Anything missing falls back to English, so a partial translation still works.

## Reporting bugs and ideas

Use the [issue templates](https://github.com/vytk712025main-eng/stick-note/issues/new/choose). For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Releases (maintainers)

1. Update `version` in `package.json` and add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` (plus its link at the bottom).
2. Open a pull request, wait for CI to pass, merge.
3. Tag the merge commit and push the tag: `git tag vx.y.z && git push origin vx.y.z`. The release workflow checks the tag matches `package.json`, runs the tests, builds the Windows and Linux packages, writes `SHA256SUMS.txt`, attests the files and publishes the GitHub release.
4. Download one file per platform from the release and try it before announcing.

By contributing you agree that your work is released under the [MIT license](LICENSE).
