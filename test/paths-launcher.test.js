// Tests for where data lives (src/paths.js) and which browser is chosen (src/launcher.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataDir, userDataDir } from '../src/paths.js';
import { findBrowser } from '../src/launcher.js';

// ---- data folder ---------------------------------------------------------

test('STICK_NOTE_DATA always wins', () => {
  const dir = resolveDataDir({ env: { STICK_NOTE_DATA: 'some/where' }, root: '/app', buildInfo: { dataDir: 'user' } });
  assert.equal(dir, path.resolve('some/where'));
});

test('a source checkout keeps its notes in ./data', () => {
  assert.equal(resolveDataDir({ env: {}, root: path.resolve('/app'), buildInfo: {} }), path.join(path.resolve('/app'), 'data'));
});

test('portable builds keep notes next to the app, wherever it is unpacked', () => {
  const root = path.resolve('/portable/app');
  assert.equal(resolveDataDir({ env: {}, root, buildInfo: { dataDir: '../data' } }), path.resolve('/portable/data'));
});

test('installed builds use a per-user folder on each platform', () => {
  assert.equal(
    userDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming' }, home: 'C:\\Users\\Ann' }),
    'C:\\Users\\Ann\\AppData\\Roaming\\Stick Note',
  );
  assert.equal(userDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\Ann' }), 'C:\\Users\\Ann\\AppData\\Roaming\\Stick Note');
  assert.equal(userDataDir({ platform: 'linux', env: {}, home: '/home/ann' }), '/home/ann/.local/share/stick-note');
  assert.equal(userDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data/xdg' }, home: '/home/ann' }), '/data/xdg/stick-note');
  assert.equal(userDataDir({ platform: 'darwin', env: {}, home: '/Users/ann' }), '/Users/ann/Library/Application Support/Stick Note');
  assert.equal(
    resolveDataDir({ env: { XDG_DATA_HOME: '/x' }, root: '/opt/stick-note/app', buildInfo: { dataDir: 'user' }, platform: 'linux', home: '/home/ann' }),
    '/x/stick-note',
  );
});

// ---- browser choice ------------------------------------------------------

const has = (...files) => (p) => files.includes(p);

test('STICK_NOTE_BROWSER overrides detection when the file exists', () => {
  assert.equal(findBrowser({ platform: 'linux', env: { STICK_NOTE_BROWSER: '/x/browser' }, exists: has('/x/browser', '/usr/bin/chromium') }), '/x/browser');
  assert.equal(findBrowser({ platform: 'linux', env: { STICK_NOTE_BROWSER: '/x/missing' }, exists: has('/usr/bin/chromium') }), '/usr/bin/chromium');
});

test('Windows prefers Edge, then Chrome', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local' };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findBrowser({ platform: 'win32', env, exists: has(edge, chrome) }), edge);
  assert.equal(findBrowser({ platform: 'win32', env, exists: has(chrome) }), chrome);
  assert.equal(findBrowser({ platform: 'win32', env, exists: has() }), null);
});

test('Linux looks through PATH and the usual install folders', () => {
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/home/ann/bin:/usr/bin' }, exists: has('/home/ann/bin/chromium') }), '/home/ann/bin/chromium');
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/chromium', '/usr/bin/google-chrome') }), '/usr/bin/google-chrome', 'Chrome is preferred over Chromium');
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '' }, exists: has('/snap/bin/chromium') }), '/snap/bin/chromium', 'snap installs are found even without PATH');
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has('/usr/bin/firefox') }), null, 'Firefox cannot open an app window, so the default-browser fallback is used');
});
