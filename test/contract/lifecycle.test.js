// Contract tests: when does the server quit? (which windows are open, the idle delay, shutdown requests)
//
// Timing tests: the delays are short on purpose, and the margins are wide so a busy machine does not make them flaky.
// Run with: npm test   (Rust: STICK_NOTE_BIN=<program> node --test test/contract)

import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITE, boot, sleep, until } from './harness.mjs';

test('a named window keeps the server running while it is quiet; the server quits after its goodbye', async () => {
  const s = await boot({ idleMs: 500 });
  try {
    const id = 'w-test-window-1';
    assert.equal((await fetch(`${s.base}/api/ping?w=${id}`)).status, 200);
    assert.equal((await s.info()).windows, 1);

    // Three times the delay without a single heartbeat: a frozen window, not a closed one.
    await sleep(1500);
    assert.equal(s.exit, null, 'the server must not quit while a window that said hello has not said goodbye');

    // The goodbye is a write, so it needs the custom header like every other one.
    assert.equal((await fetch(`${s.base}/api/bye?w=${id}`, { method: 'POST' })).status, 403);
    assert.equal((await s.info()).windows, 1);
    const bye = await fetch(`${s.base}/api/bye?w=${id}`, { method: 'POST', headers: WRITE });
    assert.equal(bye.status, 200);
    assert.deepEqual(await bye.json(), { ok: true });
    assert.equal((await s.info()).windows, 0);

    assert.ok(await until(() => s.exit !== null, 6000), 'the server quits once the last window has said goodbye');
    assert.equal(s.exit.code, 0, 'a quiet exit, not a crash');
  } finally { await s.close(); }
});

test('a window that reloads (goodbye, then hello again) does not stop the server', async () => {
  const s = await boot({ idleMs: 800 });
  try {
    const id = 'w-test-window-2';
    await fetch(`${s.base}/api/ping?w=${id}`);
    await fetch(`${s.base}/api/bye?w=${id}`, { method: 'POST', headers: WRITE });
    await sleep(200);
    await fetch(`${s.base}/api/ping?w=${id}`); // the reloaded page says hello again
    await sleep(2000);
    assert.equal(s.exit, null);
    assert.equal((await s.info()).windows, 1);
  } finally { await s.close(); }
});

test('two windows: one leaving does not matter while the other is open', async () => {
  const s = await boot({ idleMs: 400 });
  try {
    await fetch(`${s.base}/api/ping?w=w-first-window`);
    await fetch(`${s.base}/api/ping?w=w-second-window`);
    assert.equal((await s.info()).windows, 2);
    await fetch(`${s.base}/api/bye?w=w-first-window`, { method: 'POST', headers: WRITE });
    await sleep(1500);
    assert.equal(s.exit, null);
    assert.equal((await s.info()).windows, 1);
    await fetch(`${s.base}/api/bye?w=w-second-window`, { method: 'POST', headers: WRITE });
    assert.ok(await until(() => s.exit !== null, 6000));
  } finally { await s.close(); }
});

test('windows of older versions (ping without a name) keep the old rule: quit after a silence', async () => {
  const s = await boot({ idleMs: 600 });
  try {
    await fetch(`${s.base}/api/ping`);
    await sleep(150);
    assert.equal(s.exit, null, 'a recent ping is not a silence yet');
    assert.equal((await s.info()).windows, 0, 'an anonymous ping is not a window');
    assert.ok(await until(() => s.exit !== null, 6000), 'quits once nothing has been heard for the delay');
    assert.equal(s.exit.code, 0);
  } finally { await s.close(); }
});

test('names that do not look like a window id are ignored', async () => {
  const s = await boot({ idleMs: 0 });
  try {
    for (const bad of ['', 'x', 'has%20space%20in%20it', 'a'.repeat(80), '..%2F..%2Fetc', 'semi;colon', 'tab%09tab-name']) {
      assert.equal((await fetch(`${s.base}/api/ping?w=${bad}`)).status, 200, bad);
      assert.equal((await fetch(`${s.base}/api/bye?w=${bad}`, { method: 'POST', headers: WRITE })).status, 200, bad);
    }
    assert.equal((await s.info()).windows, 0);
    await fetch(`${s.base}/api/ping?w=${'a'.repeat(64)}`);
    assert.equal((await s.info()).windows, 1, 'a name of 64 characters is fine');
    await fetch(`${s.base}/api/ping?w=Abc_-9`);
    assert.equal((await s.info()).windows, 2, 'letters, digits, underscore and hyphen, from 6 characters');
    // A goodbye from a window the server never heard of is harmless.
    await fetch(`${s.base}/api/bye?w=w-someone-else`, { method: 'POST', headers: WRITE });
    assert.equal((await s.info()).windows, 2);
  } finally { await s.close(); }
});

test('a server started without an idle delay never quits by itself', async () => {
  const s = await boot({ idleMs: 0 });
  try {
    await sleep(800);
    assert.equal(s.exit, null);
  } finally { await s.close(); }
});
