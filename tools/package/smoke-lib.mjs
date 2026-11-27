// Building blocks for the smoke tests: start a packaged app, check it over HTTP, stop it.
//
// Safety rules that every smoke test follows:
//  - only ports 4760-4790 are used, never the app's default 4747 (a real copy may be running there);
//  - STICK_NOTE_DATA and STICK_NOTE_BROWSER are removed from the environment, and the data location
//    is steered with a temporary APPDATA / XDG_DATA_HOME instead, so the "per-user folder" logic
//    that real users get is what is tested;
//  - STICK_NOTE_NO_OPEN=1 so no browser window ever opens.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CACHE_DIR, fail, makeTempDir, note, removeDir, sha256File } from './lib.mjs';
import { readConfig } from './runtime.mjs';

const PORT_RANGE = [4760, 4790];
const SMOKE_NOTE_ID = 'smoke-test-note';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ok = (message) => console.log(`   ok  ${message}`);

export function check(condition, message, detail) {
  if (!condition) fail(`Smoke test failed: ${message}${detail ? `\n   ${detail}` : ''}`);
  ok(message);
}

/** Poll `fn` until it returns something truthy; resolves to that value, or null on timeout. */
export async function waitUntil(fn, timeoutMs, intervalMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

const portIsFree = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

export async function findFreePort() {
  const [from, to] = PORT_RANGE;
  const start = from + Math.floor(Math.random() * (to - from + 1));
  for (let i = 0; i <= to - from; i++) {
    const port = from + ((start - from + i) % (to - from + 1));
    if (await portIsFree(port)) return port;
  }
  return fail(`No free port between ${from} and ${to}. Is something else using them?`);
}

/** The /api/ping answer of a Stick Note server on this port, or null when nothing (or something else) answers. */
export async function ping(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return body && body.app === 'stick-note' ? body : null;
  } catch {
    return null;
  }
}

/** Environment for a packaged app under test (a full replacement of process.env, not a patch). */
export function appEnv(port, extra = {}) {
  const env = { ...process.env, PORT: String(port), STICK_NOTE_NO_OPEN: '1', STICK_NOTE_IDLE_MS: '180000', ...extra };
  for (const key of ['STICK_NOTE_DATA', 'STICK_NOTE_BROWSER']) if (!(key in extra)) delete env[key];
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]; // an explicit undefined removes a variable
  return env;
}

/**
 * The runtime inside a package must be the verified official Node.js, untouched. The build verified
 * the download and unpacked it into .cache/, so comparing hashes proves nothing changed on the way.
 */
export function checkRuntimeIsOfficial(file, target) {
  const { version } = readConfig().node;
  const official = path.join(CACHE_DIR, 'runtime', `node-v${version}-${target}`, target.startsWith('win') ? 'node.exe' : 'node');
  if (!fs.existsSync(official)) {
    note('the official runtime is not in .cache/, so the byte-for-byte comparison is skipped');
    return;
  }
  check(sha256File(file) === sha256File(official), `the bundled runtime is byte-for-byte the official Node.js ${version}`);
}

// ---- processes -----------------------------------------------------------------

/**
 * Start a program without waiting for it. Output goes to files rather than pipes: the background
 * server that "--open" starts may inherit the handles, and an inherited pipe would never close.
 */
export function startProcess(command, args, { cwd, env, logDir } = {}) {
  const dir = logDir || makeTempDir('stick-note-smoke-log-');
  const outFile = path.join(dir, `out-${path.basename(command)}.txt`);
  const out = fs.openSync(outFile, 'w');
  let exit = null;
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, out], windowsHide: true });
  fs.closeSync(out);
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.once('error', (error) => { exit = { code: null, error }; });
  return {
    child,
    command,
    get exit() { return exit; },
    output: () => fs.readFileSync(outFile, 'utf8'),
    dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

/** Run a program to completion. Resolves to { code, output }; rejects (via fail) on timeout or start errors. */
export async function runToEnd(command, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  const proc = startProcess(command, args, { cwd, env });
  const done = await waitUntil(() => proc.exit, timeoutMs, 100);
  if (!done) {
    proc.child.kill();
    fail(`${path.basename(command)} did not finish within ${timeoutMs / 1000}s`);
  }
  if (done.error) fail(`Could not start ${command}: ${done.error.message}`);
  await sleep(150); // let the last output reach the file
  const output = proc.output();
  proc.dispose();
  return { code: done.code, output };
}

// ---- the app under test -----------------------------------------------------------

/**
 * Start a packaged app.
 *  mode "open": the command is a launcher that starts a background server and exits ("--open").
 *  mode "run":  the command keeps running in the foreground and prints the OPEN line (AppImage).
 * `expectOpenLine` is false for Stick Note.exe, which has no console and so prints nothing.
 */
export async function startApp({ label, command, args = [], cwd, env, port, mode = 'open', expectOpenLine = true }) {
  console.log(`\n-- start: ${label}`);
  const proc = startProcess(command, args, { cwd, env });
  const app = { label, port, proc, mode, env };

  if (mode === 'open') {
    const done = await waitUntil(() => proc.exit, 60_000, 100);
    const shown = [path.basename(command), ...args.map((a) => path.basename(a))].join(' ');
    check(done && !done.error && done.code === 0, `${shown} exits with code 0`,
      done ? `exit ${JSON.stringify(done)}\n${proc.output()}` : 'it did not exit within 60 s');
    if (expectOpenLine) {
      await sleep(150);
      check(proc.output().includes(`OPEN http://127.0.0.1:${port}/`), `it reports OPEN http://127.0.0.1:${port}/ instead of opening a window`, proc.output());
    }
  } else {
    const line = await waitUntil(() => proc.output().includes(`OPEN http://127.0.0.1:${port}/`) || proc.exit, 60_000, 100);
    check(line && !proc.exit, 'the app runs in the foreground and reports the OPEN line', `${proc.output()}\n${JSON.stringify(proc.exit)}`);
  }
  const up = await waitUntil(() => ping(port), 15_000);
  check(up, `the server answers on port ${port}`, proc.output());
  return app;
}

const samePath = (a, b) => (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b));

/** HTTP checks against a running server, ending with a real save into the data folder. */
export async function verifyApp(app, { version, channel, dataDir }) {
  const base = `http://127.0.0.1:${app.port}`;
  const get = (p) => fetch(base + p, { signal: AbortSignal.timeout(10_000) });

  const hello = await (await get('/api/ping')).json();
  check(hello.app === 'stick-note' && hello.version === version, `/api/ping says Stick Note ${version}`, JSON.stringify(hello));

  const page = await get('/');
  const html = await page.text();
  check(page.status === 200 && html.includes('Stick Note'), '/ serves the app page');

  const localeRes = await get('/locales/en.json');
  const strings = localeRes.status === 200 ? await localeRes.json() : null;
  check(strings && typeof strings === 'object' && Object.keys(strings).length > 10, '/locales/en.json serves the English strings');

  const info = await (await get('/api/info')).json();
  check(info.channel === channel, `/api/info reports channel "${channel}"`, `it reports "${info.channel}"`);
  check(info.version === version, `/api/info reports version ${version}`, `it reports "${info.version}"`);
  check(samePath(info.dataDir, dataDir), `the data folder is ${dataDir}`, `the server uses ${info.dataDir}`);

  const board = await (await get('/api/board')).json();
  const now = Date.now();
  const note = { id: SMOKE_NOTE_ID, k: 'text', x: 40, y: 40, w: 220, c: 'yellow', r: 0, z: 1, t: 'Saved by the packaging smoke test', ts: now, mt: now };
  const put = await fetch(`${base}/api/board`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Stick-Note': '1' },
    body: JSON.stringify({ baseRev: board.rev, board: { notes: [note], trash: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  check(put.status === 200, 'PUT /api/board saves a note', `HTTP ${put.status} ${await put.text()}`);

  const file = path.join(dataDir, 'board.json');
  check(fs.existsSync(file), `board.json exists in ${dataDir}`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(saved.notes.some((n) => n.id === SMOKE_NOTE_ID), 'board.json contains the saved note');
}

/** Stop the app the way the product does ("--stop") and confirm nothing answers any more. */
export async function stopApp(app, { command, args, cwd }) {
  const result = await runToEnd(command, args, { cwd, env: app.env, timeoutMs: 60_000 });
  check(result.code === 0 && /stopped/i.test(result.output), '--stop shuts the server down (exit code 0)', `exit ${result.code}: ${result.output}`);
  const gone = await waitUntil(async () => !(await ping(app.port)), 10_000);
  check(gone, 'nothing answers on the port any more');
  if (app.mode === 'run') {
    const ended = await waitUntil(() => app.proc.exit, 15_000, 100);
    check(ended, 'the foreground process exits by itself after --stop');
  }
  app.proc.dispose();
}

/** Best-effort cleanup for failures: ask the server to quit, then kill what we started. Never throws. */
export async function cleanupApp(app) {
  if (!app) return;
  try {
    if (await ping(app.port)) {
      await fetch(`http://127.0.0.1:${app.port}/api/shutdown`, { method: 'POST', headers: { 'X-Stick-Note': '1' }, signal: AbortSignal.timeout(3000) });
      await waitUntil(async () => !(await ping(app.port)), 5000);
    }
    if (!app.proc.exit) app.proc.child.kill();
  } catch { /* best effort */ }
  app.proc.dispose();
}

/**
 * Remember whether (and after how long) the server stops answering while something else runs.
 * Used for the upgrade test: the installer, not an idle timeout, must be what stops the server.
 */
export function watchServer(port, intervalMs = 400) {
  const started = Date.now();
  let wentDownAt = null;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      if (!(await ping(port)) && wentDownAt === null) wentDownAt = Date.now();
      await sleep(intervalMs);
    }
  })();
  return {
    async finish() {
      stopped = true;
      await loop;
      return wentDownAt === null ? null : wentDownAt - started;
    },
  };
}

export { makeTempDir, removeDir };
