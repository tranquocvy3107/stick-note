// Which windows are open and when the background server may quit (src/presence.js). Run with: npm test
//
// A fake clock lets a test "wait" for hours in no time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresence } from '../src/presence.js';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const IDLE = 5 * MIN;

function setup(options = {}) {
  let t = 1_000_000;
  const presence = createPresence({ idleExitMs: IDLE, now: () => t, ...options });
  return { presence, advance: (ms) => { t += ms; } };
}

test('with no window at all the server may quit once the delay has passed', () => {
  const { presence, advance } = setup();
  advance(IDLE - SEC);
  assert.equal(presence.shouldQuit(), false);
  advance(2 * SEC);
  assert.equal(presence.shouldQuit(), true);
});

test('a window that said hello keeps the server alive however quiet it goes (a browser may freeze it)', () => {
  const { presence, advance } = setup();
  presence.ping('w-one-window');
  assert.equal(presence.count, 1);
  advance(3 * HOUR); // no heartbeat for hours: 1.2.0 quit the server after 5 minutes of this
  assert.equal(presence.shouldQuit(), false);
  assert.equal(presence.count, 1);
});

test('after the last goodbye the server quits, but only after the delay', () => {
  const { presence, advance } = setup();
  presence.ping('w-one-window');
  advance(HOUR);
  presence.bye('w-one-window');
  assert.equal(presence.count, 0);
  advance(IDLE - SEC);
  assert.equal(presence.shouldQuit(), false, 'a window that is only reloading has time to come back');
  advance(2 * SEC);
  assert.equal(presence.shouldQuit(), true);
});

test('a window that comes back after a goodbye (a reload) cancels the quit', () => {
  const { presence, advance } = setup();
  presence.ping('w-one-window');
  presence.bye('w-one-window');
  advance(IDLE - SEC);
  presence.ping('w-one-window');
  advance(HOUR);
  assert.equal(presence.shouldQuit(), false);
});

test('one window leaving does not matter while another one is open', () => {
  const { presence, advance } = setup();
  presence.ping('w-first-window');
  presence.ping('w-second-window');
  assert.equal(presence.count, 2);
  presence.bye('w-first-window');
  advance(HOUR);
  assert.equal(presence.shouldQuit(), false);
  presence.bye('w-second-window');
  advance(IDLE + SEC);
  assert.equal(presence.shouldQuit(), true);
});

test('windows of version 1.2.0 and older (no id, no goodbye) keep the old rule: quit after a silence', () => {
  const { presence, advance } = setup();
  presence.ping(); // the older window pings without a name
  presence.ping(null);
  assert.equal(presence.count, 0);
  advance(IDLE - SEC);
  assert.equal(presence.shouldQuit(), false);
  presence.ping(); // another heartbeat 20 seconds later in real life
  advance(IDLE - SEC);
  assert.equal(presence.shouldQuit(), false, 'every ping starts the delay again');
  advance(2 * SEC);
  assert.equal(presence.shouldQuit(), true);
});

test('a window that stays silent for longer than the time to live is counted as gone', () => {
  const { presence, advance } = setup({ windowTtlMs: 24 * HOUR });
  presence.ping('w-one-window');
  advance(24 * HOUR - MIN);
  assert.equal(presence.shouldQuit(), false);
  advance(2 * MIN);
  assert.equal(presence.shouldQuit(), true, 'for example because the browser crashed and never said goodbye');
  assert.equal(presence.count, 0);
});

test('waking from sleep starts every clock again', () => {
  const { presence, advance } = setup({ windowTtlMs: 2 * HOUR });
  presence.ping('w-one-window');
  advance(10 * HOUR); // the computer slept: the window could not say anything
  presence.wake();
  assert.equal(presence.shouldQuit(), false);
  assert.equal(presence.count, 1);
  advance(HOUR);
  assert.equal(presence.shouldQuit(), false);
});

test('names that do not look like a window id are ignored', () => {
  const { presence } = setup();
  for (const bad of ['', 'x', 'has space in it', 'a'.repeat(80), '../../etc', undefined, null, 42, {}]) {
    presence.ping(bad);
    presence.bye(bad);
  }
  assert.equal(presence.count, 0);
});

test('a goodbye from a window the server never heard of is harmless', () => {
  const { presence, advance } = setup();
  presence.ping('w-one-window');
  presence.bye('w-someone-else');
  assert.equal(presence.count, 1);
  advance(HOUR);
  assert.equal(presence.shouldQuit(), false);
});
