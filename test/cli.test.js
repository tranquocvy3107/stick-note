// End-to-end tests of the command line: start, find, open and stop a real server process. Run with: npm test
//
// Every test uses a temp data folder and a free port, and STICK_NOTE_NO_OPEN=1 so no browser window ever opens.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stick-note-cli-'));
  const port = await freePort();
  const env = { ...process.env, STICK_NOTE_DATA: dir, PORT: String(port), STICK_NOTE_NO_OPEN: '1', STICK_NOTE_IDLE_MS: '600000' };
  const run = (...args) => spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8', timeout: 20_000 });
  const ping = () => fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  const waitUntil = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const cleanup = async () => {
    run('--stop');
    await waitUntil(async () => !(await ping()), 5000);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, port, env, run, ping, waitUntil, cleanup };
}

test('--version prints the version from package.json', () => {
  const result = spawnSync(process.execPath, [SERVER, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), PACKAGE.version);
});

test('--data-dir prints where the notes live and honours STICK_NOTE_DATA', async () => {
  const s = await sandbox();
  try {
    assert.equal(path.resolve(s.run('--data-dir').stdout.trim()), path.resolve(s.dir));
  } finally { await s.cleanup(); }
});

test('--open starts a background server, --stop stops it, and a second --stop is harmless', async () => {
  const s = await sandbox();
  try {
    const opened = s.run('--open');
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, new RegExp(`OPEN http://127\\.0\\.0\\.1:${s.port}/`));
    assert.ok(await s.ping(), 'the server answers after --open');

    // Opening again must reuse the running server rather than starting another.
    const again = s.run('--open');
    assert.equal(again.status, 0, again.stderr);
    assert.ok(await s.ping());

    const stopped = s.run('--stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/i);
    assert.ok(await s.waitUntil(async () => !(await s.ping())), 'the server is gone after --stop');

    const second = s.run('--stop');
    assert.equal(second.status, 0);
    assert.match(second.stdout, /not running/i);
  } finally { await s.cleanup(); }
});

test('--run keeps the server in the foreground (AppImage mode) until it is stopped', async () => {
  const s = await sandbox();
  const child = spawn(process.execPath, [SERVER, '--run'], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    assert.ok(await s.waitUntil(() => output.includes('OPEN http://'), 10_000), `no OPEN line, output was: ${output}`);
    assert.ok(await s.ping(), 'the foreground server answers');
    assert.equal(child.exitCode, null, 'the launcher process is still alive: the AppImage mount would stay in place');

    assert.equal(s.run('--stop').status, 0);
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    assert.equal(code, 0, 'the foreground process exits cleanly after --stop');
  } finally {
    child.kill();
    await s.cleanup();
  }
});
