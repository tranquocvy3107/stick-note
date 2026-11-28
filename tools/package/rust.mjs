// Building the Rust program for the packages, checking what came out, and the third-party notices that go with it.
//
// The program is one self-contained file: the server, the launcher and the command line, with the web interface
// inside. Nothing else (no Node.js, no runtime) goes into a package.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, VERSION, buildEpoch, capture, fail, formatBytes, note, peSubsystem, run, step, which } from './lib.mjs';

export const TRIPLES = { windows: 'x86_64-pc-windows-msvc', linux: 'x86_64-unknown-linux-musl' };

const WINDOWS_GUI = 2;

/** cargo from the CARGO variable, from PATH, or from the folder rustup installs into. */
export function findCargo() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const candidates = [process.env.CARGO, which('cargo'), path.join(os.homedir(), '.cargo', 'bin', exe)].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c))
    ?? fail('cargo was not found. Install Rust (https://rustup.rs), or set CARGO to the path of cargo.');
}

/**
 * The compiler flags of a release build for `triple`. Paths of this machine are replaced so they do not end up inside
 * the program (it would differ from computer to computer). Windows: the linker is asked not to write the build time
 * into the file. Linux built on another system: Rust's own linker (rust-lld) is used, so no Linux toolchain is needed.
 * Flags are passed in CARGO_ENCODED_RUSTFLAGS, separated by 0x1f, because the paths may contain spaces.
 */
function releaseFlags(triple) {
  const remap = [[ROOT, '/build/stick-note']];
  for (const [variable, to] of [['CARGO_HOME', '/cargo'], ['RUSTUP_HOME', '/rustup']]) {
    if (process.env[variable]) remap.push([process.env[variable], to]);
  }
  const flags = remap.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
  if (triple === TRIPLES.windows) flags.push('-C', 'link-arg=/Brepro');
  if (triple === TRIPLES.linux && process.platform !== 'linux') flags.push('-C', 'linker=rust-lld', '-C', 'linker-flavor=ld.lld');
  return flags.join('\x1f');
}

/**
 * Build the program in release mode and return the path of the file.
 * `triple` is the target; for the Windows build on Windows the host target is used and no --target is passed.
 */
export function buildProgram({ triple }) {
  step(`Program (cargo build --release, ${triple})`);
  const cargo = findCargo();
  const host = process.platform === 'win32' && triple === TRIPLES.windows;
  const exeName = triple.includes('windows') ? 'stick-note.exe' : 'stick-note';
  run(cargo, ['build', '--release', '--locked', '--package', 'stick-note', ...(host ? [] : ['--target', triple])], {
    cwd: ROOT,
    env: { CARGO_ENCODED_RUSTFLAGS: releaseFlags(triple), RUSTFLAGS: null, SOURCE_DATE_EPOCH: String(buildEpoch()), CARGO_INCREMENTAL: '0' },
  });
  const exe = path.join(ROOT, 'target', ...(host ? [] : [triple]), 'release', exeName);
  if (!fs.existsSync(exe)) fail(`cargo finished but ${exe} does not exist`);
  note(`built ${exe} (${formatBytes(fs.statSync(exe).size)})`);
  return exe;
}

/** The program must say it is the version of package.json; only checkable where it can run. */
export function checkProgramVersion(exe) {
  const result = capture(exe, ['--version']);
  if (result.error || result.status !== 0 || result.stdout.trim() !== VERSION) {
    fail(`${exe} --version printed "${result.stdout.trim()}" (exit ${result.status}) but package.json says ${VERSION}`);
  }
  note(`${path.basename(exe)} --version prints ${VERSION}`);
}

/** Windows: a GUI program shows no console window when started from a shortcut. */
export function checkWindowsProgram(exe) {
  if (peSubsystem(exe) !== WINDOWS_GUI) fail(`${exe} was not built as a GUI program; it would show a console window`);
  note('it is a GUI program (no console window)');
}

/**
 * Linux: the program must be statically linked (no program interpreter), so it runs on any distribution.
 * Reads the ELF program headers: a "PT_INTERP" entry would name the dynamic loader.
 */
export function elfIsStatic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    if (head.toString('latin1', 1, 4) !== 'ELF' || head[4] !== 2) fail(`${file} is not a 64-bit ELF program`);
    const phoff = Number(head.readBigUInt64LE(32));
    const phentsize = head.readUInt16LE(54);
    const phnum = head.readUInt16LE(56);
    const table = Buffer.alloc(phentsize * phnum);
    fs.readSync(fd, table, 0, table.length, phoff);
    for (let i = 0; i < phnum; i++) if (table.readUInt32LE(i * phentsize) === 3) return false; // PT_INTERP
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// ---- third-party notices ------------------------------------------------------------

const LICENSE_FILE = /^(licen[sc]e|copying|unlicen[sc]e|notice)([-_.].*)?$/i;

/**
 * The crates that end up in the program: everything reachable from the program through normal (not build-only,
 * not test-only) dependencies, for this target. Procedural macros (serde_derive, tokio-macros, ...) run while the
 * program is compiled and are not part of it, so they are left out together with what only they need (syn, quote, ...).
 */
export function rustCrates(triple) {
  const result = capture(findCargo(), ['metadata', '--format-version', '1', '--locked', '--filter-platform', triple], { cwd: ROOT });
  if (result.status !== 0) fail(`cargo metadata failed: ${result.stderr}`);
  const meta = JSON.parse(result.stdout);
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.packages.find((p) => p.name === 'stick-note' && !p.source) ?? fail('cargo metadata does not list the stick-note package');
  const seen = new Set();
  const stack = [root.id];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    if (packages.get(id).targets.some((target) => target.kind.includes('proc-macro'))) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg);
  }
  seen.delete(root.id);
  return [...seen].map((id) => packages.get(id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const normalise = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

/**
 * Text of THIRD-PARTY-NOTICES.txt: every crate with its license, and the license texts written out once each
 * (most crates carry the same MIT and Apache-2.0 texts). The Windows installer additionally credits Inno Setup.
 */
export function thirdPartyNotices({ triple, installer = false }) {
  const crates = rustCrates(triple);
  const groups = new Map(); // normalised text -> { text, users }
  const missing = [];
  for (const crate of crates) {
    const dir = path.dirname(crate.manifest_path);
    const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
    const label = `${crate.name} ${crate.version} (${crate.license || 'see its license file'})${crate.repository ? ` ${crate.repository}` : ''}`;
    if (files.length === 0) missing.push(label);
    for (const file of files) {
      const text = normalise(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!text) continue;
      const key = crypto.createHash('sha256').update(text).digest('hex');
      if (!groups.has(key)) groups.set(key, { text, users: [] });
      groups.get(key).users.push(label);
    }
  }
  if (missing.length) note(`${missing.length} crate(s) carry no license file; they are listed with their SPDX license: ${missing.map((m) => m.split(' ')[0]).join(', ')}`);

  const rule = '='.repeat(78);
  const parts = [
    'Stick Note includes the following third-party software.',
    '',
    'The Rust standard library (MIT OR Apache-2.0), https://github.com/rust-lang/rust, linked into the program.',
    '',
    `The Rust crates below are compiled into the program (${crates.length} crates for ${triple}).`,
    'Each license text is printed once, followed by the crates that use it.',
  ];
  if (installer) {
    parts.push('', 'The Windows installer is built with Inno Setup.',
      '  Copyright (C) 1997-2026 Jordan Russell. Portions Copyright (C) 2000-2026 Martijn Laan. https://jrsoftware.org/isinfo.php');
  }
  const ordered = [...groups.values()].sort((a, b) => a.users[0].localeCompare(b.users[0]));
  for (const group of ordered) {
    parts.push('', rule, 'Used by:', ...group.users.map((u) => `  ${u}`), '', group.text);
  }
  if (missing.length) {
    parts.push('', rule, 'Crates whose package carries no license file; their license is the one named below:', ...missing.map((m) => `  ${m}`));
  }
  parts.push('', rule, 'Stick Note itself is MIT licensed; see LICENSE.', '');
  return parts.join('\n');
}
