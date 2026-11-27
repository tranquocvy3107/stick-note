// Shared helpers for the packaging scripts. Node built-ins only; works on Windows and Linux.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = path.join(ROOT, '.cache');
export const DIST_DIR = path.join(ROOT, 'dist');
export const PACKAGING_DIR = path.join(ROOT, 'packaging');

export const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const VERSION = pkg.version;
const APP_NAME = 'Stick Note';
export const HOMEPAGE = String(pkg.homepage || '').replace(/#.*$/, '');

/** An expected failure: the message alone tells the person what to fix (no stack trace). */
export class PackagingError extends Error {}

export const fail = (message) => { throw new PackagingError(message); };

/** Run an async main() and turn failures into a clear message and a non-zero exit code. */
export function runMain(main) {
  main().catch((err) => {
    const known = err instanceof PackagingError;
    console.error(`\nerror: ${known ? err.message : (err && err.stack) || err}`);
    process.exitCode = 1;
  });
}

export const step = (title) => console.log(`\n== ${title}`);
export const note = (text) => console.log(`   ${text}`);

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * Minimal option parser: `flags` are booleans, `options` take a value (`--out dist` or `--out=dist`).
 * Unknown options are an error so a typo never silently builds the wrong thing.
 */
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { result._.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (flags.includes(name)) result[name] = true;
    else if (options.includes(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) fail(`Option --${name} needs a value`);
      result[name] = value;
    } else fail(`Unknown option --${name}`);
  }
  return result;
}

/** Split a comma list such as "deb,appimage" and reject names that are not in `allowed`. */
export function parseOnly(value, allowed) {
  if (!value) return new Set(allowed);
  const wanted = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of wanted) if (!allowed.includes(name)) fail(`Unknown target "${name}". Choose from: ${allowed.join(', ')}`);
  return new Set(wanted);
}

// ---- running other programs -------------------------------------------------

// For the log only (arguments are passed to the program as-is, never through a shell).
const display = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * The environment for a child program: this process's variables plus `extra`.
 * A value of null removes the variable (names are compared ignoring case on Windows, where they are case-insensitive).
 */
export function childEnv(extra = {}) {
  const same = process.platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  const env = { ...process.env };
  for (const [name, value] of Object.entries(extra)) {
    for (const key of Object.keys(env)) if (same(key, name)) delete env[key];
    if (value !== null && value !== undefined) env[name] = value;
  }
  return env;
}

/** Run a program with its output shown; throws when it fails. */
export function run(command, args = [], { cwd, env, quiet = false } = {}) {
  if (!quiet) console.log(`   $ ${[command, ...args].map(display).join(' ')}`);
  const result = spawnSync(command, args, {
    cwd, env: env ? childEnv(env) : process.env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) fail(`Could not start "${command}": ${result.error.message}`);
  if (result.status !== 0) fail(`"${command}" failed with exit code ${result.status}`);
}

/** Run a program and return { status, stdout, stderr }; never throws (status is null if it could not start). */
export function capture(command, args = [], { cwd, env, input, timeout } = {}) {
  const result = spawnSync(command, args, {
    cwd, env: env ? childEnv(env) : process.env, input, timeout, encoding: 'utf8', windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error };
}

/** Absolute path of a program found on PATH, or null. */
export function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

// ---- hashing and downloading ------------------------------------------------

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Network hiccups and server errors are worth another try; "404 Not Found" is not.
const retryable = (status) => status === 408 || status === 429 || status >= 500;

async function withRetries(label, attempts, work) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (err) {
      last = err;
      if (err.permanent || attempt === attempts) break;
      const wait = 2000 * 2 ** (attempt - 1);
      console.log(`   ${label}: ${err.message}; retrying in ${wait / 1000}s (${attempt}/${attempts - 1})`);
      await sleep(wait);
    }
  }
  fail(`Could not download ${label}: ${last.message}`);
}

async function request(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), { permanent: !retryable(res.status) });
  return res;
}

export async function fetchText(url, { attempts = 4 } = {}) {
  return withRetries(url, attempts, async () => (await request(url)).text());
}

/** Download to `dest` (through a .partial file so an interrupted download is never mistaken for a good one). */
export async function downloadFile(url, dest, { attempts = 4 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  await withRetries(url, attempts, async () => {
    try {
      const res = await request(url);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partial));
      fs.renameSync(partial, dest);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
  });
}

// ---- build metadata ---------------------------------------------------------

/** Seconds since 1970 used for every timestamp in the packages, so rebuilding the same commit gives the same bytes. */
export function buildEpoch() {
  const fromEnv = process.env.SOURCE_DATE_EPOCH;
  if (fromEnv && /^\d+$/.test(fromEnv)) return Number(fromEnv);
  const git = capture('git', ['log', '-1', '--format=%ct'], { cwd: ROOT });
  if (git.status === 0 && /^\d+$/.test(git.stdout.trim())) return Number(git.stdout.trim());
  return Math.floor(Date.now() / 1000);
}

export function gitCommit() {
  if (process.env.STICK_NOTE_COMMIT !== undefined) return process.env.STICK_NOTE_COMMIT;
  const git = capture('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT });
  if (git.status === 0 && /^[0-9a-f]{7,40}$/.test(git.stdout.trim())) return git.stdout.trim();
  const sha = process.env.GITHUB_SHA || '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : '';
}

/**
 * Contents of build-info.json (read by src/paths.js and /api/info).
 * dataDir "user" = per-user folder that survives upgrades; "../data" = next to the app (portable).
 */
export function makeBuildInfo(channel, dataDir) {
  return { channel, dataDir, version: VERSION, commit: gitCommit(), builtAt: new Date(buildEpoch() * 1000).toISOString() };
}

/** "1.1.0" -> "1.1.0.0" and "1.2.3-rc.1" -> "1.2.3.0": Windows version resources only allow four numbers. */
export function numericVersion(version = VERSION) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) fail(`Cannot turn "${version}" into a four-part number; package.json needs a x.y.z version`);
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

/** "Copyright (c) 2026 name" taken from LICENSE so the year and owner are written in one place only. */
export function copyrightLine() {
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  const match = /^Copyright \(c\) .+$/m.exec(license);
  if (!match) fail('LICENSE has no "Copyright (c) ..." line');
  return match[0].trim();
}

// ---- files ------------------------------------------------------------------

export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Remember which temp folders start with `prefix`. The returned function deletes the ones created since,
 * for programs (the AppImage runtime) that unpack themselves into /tmp and do not always clean up.
 */
export function trackTempDirs(prefix) {
  const names = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
  const before = new Set(names());
  return () => { for (const name of names()) if (!before.has(name)) removeDir(path.join(os.tmpdir(), name)); };
}

/** Every file below `dir` as sorted, forward-slash relative paths (a stable order for archives). */
export function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

export function totalSize(dir) {
  return listFiles(dir).reduce((sum, rel) => sum + fs.statSync(path.join(dir, rel)).size, 0);
}

export const toCrlf = (text) => text.replace(/\r?\n/g, '\r\n');
const toLf = (text) => text.replace(/\r\n/g, '\n');

/** Read a text file from packaging/ and fill in {{placeholders}}. Line endings come back as LF. */
export function renderTemplate(relativePath, vars = {}) {
  const text = toLf(fs.readFileSync(path.join(PACKAGING_DIR, relativePath), 'utf8'));
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in vars)) fail(`packaging/${relativePath} uses {{${key}}} but no value was given`);
    return String(vars[key]);
  });
}

/**
 * Copy a file. fs.copyFileSync is used first; when it fails with "not enough memory" (seen when a
 * 100 MB file is copied between a Windows drive and the Linux disk inside WSL) the bytes are
 * copied in small chunks instead.
 */
export function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(src, dest);
    return;
  } catch (err) {
    if (err.code !== 'ENOMEM') throw err;
  }
  const input = fs.openSync(src, 'r');
  const output = fs.openSync(dest, 'w');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(input, buf, 0, buf.length, null);
      if (n === 0) break;
      fs.writeSync(output, buf, 0, n);
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/** Write a file (text or bytes), creating its folder first. */
export function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

export const writeText = writeFile;

/**
 * chmod a staged tree: 755 for folders and listed executables, 644 for everything else.
 * (Windows ignores this; it matters for the Linux packages.)
 */
export function applyModes(root, executables = []) {
  const exec = new Set(executables);
  const walk = (rel) => {
    const abs = path.join(root, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { fs.chmodSync(path.join(root, next), 0o755); walk(next); }
      else fs.chmodSync(path.join(root, next), exec.has(next) ? 0o755 : 0o644);
    }
  };
  fs.chmodSync(root, 0o755);
  walk('');
}

/** Give every file and folder the same modification time, so the archives do not change from run to run. */
export function touchTree(root, epoch = buildEpoch()) {
  const paths = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      paths.push(child);
    }
  };
  walk(root);
  paths.push(root);
  for (const p of paths) fs.utimesSync(p, epoch, epoch);
}

// ---- the application payload --------------------------------------------------

// An allow-list on purpose: what ships must never depend on what happens to sit in the checkout
// (the notes in ./data, editor leftovers, a stray node_modules ...).
const PAYLOAD = ['server.js', 'src', 'public', 'package.json', 'LICENSE'];
const REQUIRED = ['server.js', 'package.json', 'LICENSE', 'src/app.js', 'src/paths.js', 'public/index.html'];
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'node_modules', '.git', 'data']);
const SKIP_PATTERN = /(~|\.(tmp|bak|orig|rej|swp|log))$/i;
const TEXT_PATTERN = /\.(js|mjs|json|html|css|svg|txt|md)$/i;

function copyEntry(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) fail(`${src} is a symbolic link; the payload must contain real files only`);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src).sort()) {
      if (SKIP_NAMES.has(name) || SKIP_PATTERN.test(name)) continue;
      copyEntry(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  // Text files are normalised to LF: a Windows checkout may have turned them into CRLF, and the
  // same release should contain the same bytes whichever machine built it.
  if (TEXT_PATTERN.test(src)) fs.writeFileSync(dest, toLf(fs.readFileSync(src, 'utf8')));
  else fs.copyFileSync(src, dest);
}

/** Copy the application files into `appDir` and write build-info.json next to server.js. */
export function stagePayload(appDir, buildInfo) {
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of PAYLOAD) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) fail(`${entry} is missing from the repository, nothing to package`);
    copyEntry(src, path.join(appDir, entry));
  }
  for (const rel of REQUIRED) if (!fs.existsSync(path.join(appDir, rel))) fail(`The staged app has no ${rel}`);
  writeText(path.join(appDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
}

/** Text of THIRD-PARTY-NOTICES.txt. The Windows installer additionally credits Inno Setup. */
export function thirdPartyNotices({ nodeVersion, installer = false }) {
  const parts = [
    `${APP_NAME} includes the following third-party software.`,
    '',
    'Node.js',
    `  Version: ${nodeVersion}`,
    '  Used to run the app. It is the unmodified official build from https://nodejs.org/',
    '  (the file runtime/node, or runtime\\stick-note-server.exe on Windows, which is node.exe renamed).',
    '  License: MIT-style, plus the licenses of the components bundled in Node.js.',
    '  Full text: runtime/LICENSE-node.txt, or https://github.com/nodejs/node/blob/main/LICENSE',
  ];
  if (installer) {
    parts.push(
      '',
      'Inno Setup',
      '  Used to build the Windows installer.',
      '  Copyright (C) 1997-2026 Jordan Russell. Portions Copyright (C) 2000-2026 Martijn Laan.',
      '  https://jrsoftware.org/isinfo.php',
    );
  }
  parts.push('', `${APP_NAME} itself is MIT licensed; see app/LICENSE.`, '');
  return parts.join('\n');
}

/**
 * The "subsystem" field of a Windows program: 2 = GUI (no console window), 3 = console.
 * Reading it is how the build and the smoke test prove that Stick Note.exe never shows a black window.
 */
export function peSubsystem(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    const pe = head.readUInt32LE(0x3c);
    if (head.toString('latin1', 0, 2) !== 'MZ' || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') fail(`${file} is not a Windows program`);
    return head.readUInt16LE(pe + 24 + 68); // the offset is the same for 32-bit and 64-bit programs
  } finally {
    fs.closeSync(fd);
  }
}
