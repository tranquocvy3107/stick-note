# Contributing to Stick Note

Thank you for helping! Stick Note is a small project with a strong idea, so a few ground rules keep it coherent. Bug reports, translations, documentation fixes and code are all welcome.

## The idea (please keep it intact)

Stick Note has **one screen: a whiteboard**. You drop paper notes on it and find them again by remembering *where* you put them. That means:

1. **Position is sacred.** The app never sorts, aligns, moves or groups notes by itself. A note moves only when its owner drags it.
2. **The board is the only interface.** No pages, folders, tags, lists or management screens. Controls are small, sit at the edges and never cover the board.
3. **Capturing is fast.** Drag a slip, double-click, press `N` or paste.
4. **Reusing is fast.** Links open and copy at once; images view and copy at once.
5. **Never lose data.** Autosave, safe writes, backups, a trash, undo. A change that could lose data needs discussion first.
6. **Zero runtime dependencies.** The app runs with plain Node.js and plain browser JavaScript. Please open an issue before adding a dependency (build tools for packaging are discussed case by case).

If your idea bends one of these, open an issue first so we can talk it through before you spend time on it.

## Getting started

You need [Node.js](https://nodejs.org) 20.11 or newer and a Chromium-based browser (Edge, Chrome, Chromium, Brave).

```bash
git clone https://github.com/vytk712025main-eng/stick-note.git
cd stick-note
npm test                                  # all tests, no install step
node server.js                            # run in the foreground and watch the log
node server.js --open                     # run in the background and open the app window
```

**Use a throw-away data folder and another port while developing** so you never touch real notes or a copy you use every day:

```bash
# bash
STICK_NOTE_DATA=/tmp/stick-dev PORT=4748 node server.js --open
```
```powershell
# PowerShell
$env:STICK_NOTE_DATA = "$env:TEMP\stick-dev"; $env:PORT = '4748'; node server.js --open
```

`STICK_NOTE_NO_OPEN=1` prints the address instead of opening a window (handy for scripts and tests).

## Project layout

```
server.js            Entry point and command line (--open, --run, --stop, ...)
src/                 Server: paths.js (where data lives), app.js (HTTP, API, storage, backups),
                     launcher.js (app window, browser detection), http.js, util.js
public/              The interface (plain ES modules, no build step)
  index.html         All the markup
  css/app.css        All the styling (light and dark)
  js/                main, store, view, noteview, interactions, capture, ui, i18n, ...
  locales/           en.json, vi.json: every visible text
test/                node:test suites (npm test)
tools/               Icon and release helpers; tools/package builds the installers
CLAUDE.md            Architecture notes and decisions in more detail
```

## Making a change

1. Fork, then create a branch from `main`.
2. Make the change. Keep it focused: one topic per pull request.
3. Add or update tests. Pure logic goes in `test/logic.test.js`; server behaviour in `test/server.test.js`.
4. Run `npm test`; everything must pass.
5. If you changed what a user sees, try it in a real browser window and describe what you checked (a screenshot helps).
6. Open a pull request using the template.

### Style

- Plain JavaScript (ES modules), 2-space indent, single quotes, semicolons.
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
