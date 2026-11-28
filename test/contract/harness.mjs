// Black-box test harness: runs the real program and talks to it over HTTP, exactly as the app window does.
//
// The contract tests in this folder start the built program, so STICK_NOTE_BIN must name it (stick-note on Linux,
// stick-note.exe on Windows). "npm test" builds it and sets the variable; to run these tests by hand:
//   cargo build
//   STICK_NOTE_BIN=target/debug/stick-note node --test test/contract
//
// Every test uses a temporary data folder, a free port and STICK_NOTE_NO_OPEN=1, so it never touches real
// notes, the real port 4747 or a browser window.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
export const BIN = process.env.STICK_NOTE_BIN ? path.resolve(process.env.STICK_NOTE_BIN) : null;

if (!BIN) throw new Error('STICK_NOTE_BIN is not set. Build the program (cargo build) and set it to the path of stick-note(.exe), or run: npm test');
if (!fs.existsSync(BIN)) throw new Error(`STICK_NOTE_BIN points to a file that does not exist: ${BIN}`);

export const APP_ID = 'stick-note';
export const WRITE = { 'X-Stick-Note': '1' };
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const pad2 = (n) => String(n).padStart(2, '0');
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
export const note = (id, extra = {}) => ({ id, k: 'text', x: 10, y: 20, w: 220, t: `note ${id}`, mt: 1, ...extra });
export const zone = (id, extra = {}) => ({ id, x: 40, y: 60, w: 400, h: 260, k: 'normal', t: `zone ${id}`, mt: 1, ...extra });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
}

export function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Remove a folder; Windows may keep a file busy for a moment after a process has exited. */
export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const madeDirs = new Set();

/** A new temporary folder. Every folder made here is removed when the test run ends (see the exit handler below). */
export const tempDir = (prefix = 'stick-note-test-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.add(dir);
  return dir;
};

// ---- the program under test -------------------------------------------------

/**
 * A private copy of the program with a build-info.json next to it, which is how a packaged build
 * announces its channel and where it keeps the notes.
 */
export function makeApp(buildInfo) {
  const dir = tempDir('stick-note-app-');
  fs.copyFileSync(BIN, path.join(dir, path.basename(BIN)));
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify(buildInfo));
  return { dir };
}

/** The program to start: the built one, or the copy made by makeApp. */
export function program(app = null) {
  return app ? path.join(app.dir, path.basename(BIN)) : BIN;
}

/** The environment of a test run: nothing from the person's own STICK_NOTE_* settings leaks in. */
export function testEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if ((key.startsWith('STICK_NOTE_') && key !== 'STICK_NOTE_BIN') || key.toUpperCase() === 'PORT') delete env[key];
  return { ...env, STICK_NOTE_NO_OPEN: '1', ...extra };
}

/** Run the program to completion with the given arguments. */
export function run(args, { env = {}, app = null, timeout = 20_000 } = {}) {
  return spawnSync(program(app), args, { env: testEnv(env), encoding: 'utf8', timeout, windowsHide: true });
}

const children = new Set();
process.on('exit', () => {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  // After the programs are stopped: nothing is left behind in the temp folder, whatever a test did.
  for (const dir of madeDirs) { try { removeDir(dir); } catch { /* best effort */ } }
});

/**
 * Start a server process and wait until it answers.
 *
 * @param {object}  options
 * @param {string}  [options.dir]       Data folder (default: a new temporary one, removed by close()).
 * @param {number}  [options.idleMs]    Quit this long after the last window left. 0 = a plain foreground server that never quits.
 * @param {object}  [options.buildInfo] Contents of a build-info.json that sits next to the program.
 * @param {object}  [options.env]       Extra environment variables.
 */
export async function boot({ dir, idleMs = 0, buildInfo = null, env = {} } = {}) {
  const ownsDir = !dir;
  dir ??= tempDir();
  const app = buildInfo ? makeApp(buildInfo) : null;
  const command = program(app);
  let lastOutput = '';

  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await freePort();
    const childEnv = testEnv({
      STICK_NOTE_DATA: dir,
      PORT: String(port),
      ...(idleMs > 0 ? { STICK_NOTE_IDLE_MS: String(idleMs) } : {}),
      ...env,
    });
    // "--run" is the mode in which the server quits when its windows are gone; "--serve" never quits by itself.
    const child = spawn(command, [idleMs > 0 ? '--run' : '--serve'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let exit = null;
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exit = { code, signal }; children.delete(child); resolve(exit); }));

    const baseUrl = `http://127.0.0.1:${port}`;
    const ready = await until(async () => {
      if (exit) return true;
      try { return (await fetch(`${baseUrl}/api/ping`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, 15_000);
    if (!ready || exit) {
      lastOutput = output;
      if (!exit) { child.kill(); await exited; }
      continue; // most likely the port was taken between choosing it and starting; try another one
    }

    return {
      port, dir, app, base: baseUrl, child, exited,
      get exit() { return exit; },
      get output() { return output; },
      put: (baseRev, board, headers = WRITE) => fetch(`${baseUrl}/api/board`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ baseRev, board }),
      }),
      get: async () => (await fetch(`${baseUrl}/api/board`)).json(),
      info: async () => (await fetch(`${baseUrl}/api/info`)).json(),
      /** Stop the server the way the app does, then (unless keep) delete its temporary folders. */
      async close({ keep = false } = {}) {
        if (!exit) {
          try { await fetch(`${baseUrl}/api/shutdown`, { method: 'POST', headers: WRITE, signal: AbortSignal.timeout(2000) }); } catch { /* may be gone already */ }
          const done = await Promise.race([exited, sleep(5000).then(() => null)]);
          if (!done) { child.kill(); await exited; }
        }
        if (!keep && ownsDir) removeDir(dir);
        if (app) removeDir(app.dir);
      },
    };
  }
  if (ownsDir) removeDir(dir);
  if (app) removeDir(app.dir);
  throw new Error(`the server did not start. Output of the last attempt:\n${lastOutput}`);
}

/** Send a request with an arbitrary Host header or an unusual target (fetch does not allow either). */
export function rawRequest(port, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
