// Contract tests of the command line: start, find, open and stop a real server process.
//
// Every test uses a temp data folder and a free port, and STICK_NOTE_NO_OPEN=1 so no browser window ever opens.
// Run with: npm test   (Rust: STICK_NOTE_BIN=<program> node --test test/contract)

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE, freePort, program, removeDir, run, tempDir, testEnv } from './harness.mjs';

async function sandbox() {
  const dir = tempDir('stick-note-cli-');
  const port = await freePort();
  const env = { STICK_NOTE_DATA: dir, PORT: String(port), STICK_NOTE_IDLE_MS: '600000' };
  const runIt = (...args) => run(args, { env });
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
    runIt('--stop');
    await waitUntil(async () => !(await ping()), 5000);
    removeDir(dir);
  };
  return { dir, port, env, run: runIt, ping, waitUntil, cleanup };
}

test('--version prints the version from package.json', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), PACKAGE.version);
  assert.equal(run(['-v']).stdout.trim(), PACKAGE.version);
});

test('--help prints a short usage text', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(PACKAGE.version));
  for (const flag of ['--open', '--stop', '--version', '--data-dir']) assert.ok(result.stdout.includes(flag), flag);
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

test('the background server started by --open keeps the notes in the chosen folder and logs there', async () => {
  const s = await sandbox();
  try {
    assert.equal(s.run('--open').status, 0);
    const info = await (await fetch(`http://127.0.0.1:${s.port}/api/info`)).json();
    assert.equal(path.resolve(info.dataDir), path.resolve(s.dir));
    assert.equal(info.port, s.port);
  } finally { await s.cleanup(); }
});

test('--run keeps the server in the foreground (AppImage mode) until it is stopped', async () => {
  const s = await sandbox();
  const child = spawn(program(), ['--run'], { env: testEnv(s.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

test('starting a second copy on the same port reports it and exits quietly', async () => {
  const s = await sandbox();
  const first = spawn(program(), ['--serve'], { env: testEnv(s.env), stdio: 'ignore', windowsHide: true });
  try {
    assert.ok(await s.waitUntil(() => s.ping(), 10_000));
    const second = s.run('--serve');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, new RegExp(`already running at http://127\\.0\\.0\\.1:${s.port}/`));
  } finally {
    first.kill();
    await s.cleanup();
  }
});

test('a port used by another program is reported, not hidden', async () => {
  const s = await sandbox();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(s.port, '127.0.0.1', resolve));
  try {
    const result = s.run('--serve');
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Port ${s.port} is used by another program`));
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await s.cleanup();
  }
});

test('--open on a port used by another program fails with exit code 1 and says so', async () => {
  const s = await sandbox();
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => blocker.listen(s.port, '127.0.0.1', resolve));
  try {
    const result = s.run('--open');
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Could not start Stick Note on port ${s.port}`));
    assert.doesNotMatch(result.stdout, /OPEN /, 'no window is opened when there is no server');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await s.cleanup();
  }
});

test('no arguments open the app, the way a shortcut starts it', async () => {
  const s = await sandbox();
  try {
    const result = s.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`OPEN http://127\\.0\\.0\\.1:${s.port}/`));
    assert.ok(await s.ping());
  } finally { await s.cleanup(); }
});
