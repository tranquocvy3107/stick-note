// Starting, finding and stopping the app: background server, app window, browser detection.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ID } from './paths.js';

/** True when a Stick Note server answers on this port. */
export function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).app === APP_ID); } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

export async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Chromium-based browsers can open a page as a bare app window (--app). Order = preference.
const WINDOWS_BROWSERS = [
  ['ProgramFiles(x86)', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Microsoft/Edge/Application/msedge.exe'],
  ['LOCALAPPDATA', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Google/Chrome/Application/chrome.exe'],
  ['ProgramFiles(x86)', 'Google/Chrome/Application/chrome.exe'],
  ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'],
  ['ProgramFiles', 'BraveSoftware/Brave-Browser/Application/brave.exe'],
  ['LOCALAPPDATA', 'BraveSoftware/Brave-Browser/Application/brave.exe'],
];

const MAC_BROWSERS = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_COMMANDS = [
  'google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'microsoft-edge',
  'chromium', 'chromium-browser', 'brave-browser', 'brave', 'vivaldi-stable', 'vivaldi',
];
const LINUX_DIRS = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome', '/opt/microsoft/msedge'];

/**
 * Find a Chromium-based browser that can show the app in its own window.
 * `exists` is injectable so the lookup order can be tested without installing browsers.
 * Returns an absolute path or null (the caller then falls back to the default browser).
 */
export function findBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const override = env.STICK_NOTE_BROWSER;
  if (override && exists(override)) return override;

  if (platform === 'win32') {
    for (const [variable, rel] of WINDOWS_BROWSERS) {
      if (!env[variable]) continue;
      const candidate = path.win32.join(env[variable], ...rel.split('/'));
      if (exists(candidate)) return candidate;
    }
    return null;
  }

  if (platform === 'darwin') return MAC_BROWSERS.find((p) => exists(p)) || null;

  const dirs = [...(env.PATH || '').split(':').filter(Boolean), ...LINUX_DIRS];
  for (const name of [...LINUX_COMMANDS, 'chrome', 'msedge']) {
    for (const dir of dirs) {
      const candidate = path.posix.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Open the app as its own window (no address bar, no tabs); fall back to the default browser. */
export function openWindow(url, { env = process.env, platform = process.platform } = {}) {
  if (env.STICK_NOTE_NO_OPEN) {
    console.log('OPEN ' + url);
    return;
  }
  const exe = findBrowser({ platform, env });
  if (exe) {
    const child = spawn(
      exe,
      [`--app=${url}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
    return;
  }
  const [cmd, args] =
    platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

/** Start a detached background server (it exits by itself once no window is open) and wait for it. */
export async function startBackground(scriptPath, port) {
  spawn(process.execPath, [scriptPath, '--bg'], {
    detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  }).unref();
  return waitFor(() => probe(port), 10_000);
}

/** Ask a running server to quit gracefully. Resolves true when nothing is listening any more. */
export function stopRunning(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', headers: { 'X-Stick-Note': '1' }, timeout: 3000 },
      (res) => {
        res.resume();
        res.on('end', async () => resolve(await waitFor(async () => !(await probe(port)), 5000)));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}
