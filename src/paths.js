// Where things live: the application folder, the data folder and build metadata.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder that contains server.js, package.json and public/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const APP_ID = 'stick-note';
export const APP_NAME = 'Stick Note';
export const DEFAULT_PORT = 4747;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The version number is written in exactly one place: package.json.
export const VERSION = (readJson(path.join(ROOT, 'package.json')) || {}).version || '0.0.0';

/**
 * Metadata written by the packaging scripts into the app folder as build-info.json.
 * It is absent when running from a source checkout, which then behaves as a "source" build.
 */
export function readBuildInfo(root = ROOT) {
  return readJson(path.join(root, 'build-info.json')) || {};
}

/** Per-user data folder used by installed builds. */
export function userDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP_NAME);
  return p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), APP_ID);
}

/**
 * Where the notes are stored. In order of priority:
 *  1. the STICK_NOTE_DATA environment variable;
 *  2. "dataDir" in build-info.json: "user" (installed builds, a per-user folder that survives
 *     upgrades and uninstalls) or a path relative to the app folder (portable builds);
 *  3. ./data next to server.js (running from a source checkout).
 */
export function resolveDataDir({ env = process.env, root = ROOT, buildInfo = readBuildInfo(root), platform, home } = {}) {
  if (env.STICK_NOTE_DATA) return path.resolve(env.STICK_NOTE_DATA);
  const setting = buildInfo.dataDir;
  if (setting === 'user') return userDataDir({ platform, env, home });
  if (typeof setting === 'string' && setting) return path.resolve(root, setting);
  return path.join(root, 'data');
}
