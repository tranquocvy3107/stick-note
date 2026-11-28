// Tests for the pure parts of the packaging scripts (run by "npm test" with everything else).
// The packages themselves are tested by the smoke tests: npm run package:smoke

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetNames } from './names.mjs';
import {
  PackagingError, ROOT, childEnv, makeBuildInfo, numericVersion, parseArgs, parseOnly, renderTemplate, toCrlf,
} from './lib.mjs';
import { crc32, readEntry, readZip, writeZip } from './zip.mjs';
import { parseChecksums, readConfig } from './downloads.mjs';
import { TRIPLES, elfIsStatic, thirdPartyNotices } from './rust.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stick-note-pkgtest-'));

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('a zip written here reads back unchanged and is identical when written twice', () => {
  const dir = tempDir();
  try {
    const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251));
    const entries = [
      { name: 'top/readme.txt', data: Buffer.from('hello\nwörld\n') },
      { name: 'top/bin/data.bin', data: binary },
      { name: 'top/empty.txt', data: Buffer.alloc(0) },
      { name: 'top/Stick Note Tếst/file.txt', data: Buffer.from('unicode folder') },
    ];
    const first = path.join(dir, 'a.zip');
    const second = path.join(dir, 'b.zip');
    writeZip(first, entries, { epoch: 1_795_747_472 });
    writeZip(second, entries, { epoch: 1_795_747_472 });
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));

    const zip = readZip(first);
    assert.deepEqual([...zip.entries.keys()], entries.map((e) => e.name));
    for (const entry of entries) assert.deepEqual(readEntry(zip, entry.name), entry.data);
    assert.throws(() => readEntry(zip, 'top/missing.txt'), PackagingError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged zip entry is detected', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'a.zip');
    writeZip(file, [{ name: 'a.txt', data: Buffer.from('x'.repeat(100)) }], { epoch: 1_795_747_472 });
    const bytes = fs.readFileSync(file);
    bytes[40] ^= 0xff; // somewhere inside the compressed data
    fs.writeFileSync(file, bytes);
    assert.throws(() => readEntry(readZip(file), 'a.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SHASUMS256.txt lines are parsed', () => {
  const hash = 'a'.repeat(64);
  const sums = parseChecksums(`${hash}  node-v24.0.0-win-x64.zip\r\nnot a checksum line\n${'b'.repeat(64)} *node-v24.0.0-linux-x64.tar.xz\n`);
  assert.equal(sums.get('node-v24.0.0-win-x64.zip'), hash);
  assert.equal(sums.get('node-v24.0.0-linux-x64.tar.xz'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('the pinned downloads in downloads.json are well formed', () => {
  const config = readConfig();
  assert.match(config.node.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(config.node.sha256), ['linux-x64.tar.xz'], 'Node.js is only used to run the scripts inside WSL: no Windows build, nothing is bundled');
  for (const hash of [...Object.values(config.node.sha256), config.appimagetool.sha256, config.appimageRuntime.sha256]) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
  for (const download of [config.appimagetool, config.appimageRuntime]) assert.match(download.url, /^https:\/\/github\.com\/AppImage\//);
});

test('Windows version numbers have four numeric parts', () => {
  assert.equal(numericVersion('1.1.0'), '1.1.0.0');
  assert.equal(numericVersion('2.10.3-rc.1'), '2.10.3.0');
  assert.throws(() => numericVersion('latest'), PackagingError);
});

test('release file names carry the version and are unique', () => {
  const names = Object.values(assetNames('1.2.3'));
  assert.equal(new Set(names).size, names.length);
  for (const name of names.filter((n) => n !== 'SHA256SUMS.txt')) assert.ok(name.includes('1.2.3'), name);
});

test('childEnv adds variables and removes those set to null', () => {
  process.env.SN_TEST_KEEP = 'a';
  process.env.SN_TEST_DROP = 'b';
  try {
    const env = childEnv({ SN_TEST_NEW: 'c', SN_TEST_DROP: null });
    assert.equal(env.SN_TEST_KEEP, 'a');
    assert.equal(env.SN_TEST_NEW, 'c');
    assert.ok(!('SN_TEST_DROP' in env), 'a null value removes the variable');
  } finally {
    delete process.env.SN_TEST_KEEP;
    delete process.env.SN_TEST_DROP;
  }
});

test('options are parsed strictly', () => {
  assert.deepEqual(parseArgs(['x', '--keep', '--out=dist', '--only', 'deb'], { flags: ['keep'], options: ['out', 'only'] }), { _: ['x'], keep: true, out: 'dist', only: 'deb' });
  assert.throws(() => parseArgs(['--nope'], {}), PackagingError);
  assert.throws(() => parseArgs(['--out'], { options: ['out'] }), PackagingError);
  assert.deepEqual([...parseOnly('deb, tarball', ['deb', 'appimage', 'tarball'])], ['deb', 'tarball']);
  assert.equal(parseOnly(undefined, ['a', 'b']).size, 2);
  assert.throws(() => parseOnly('rpm', ['deb']), PackagingError);
});

test('templates fill their placeholders and refuse unknown ones', () => {
  assert.match(renderTemplate('windows/README-portable.txt', { version: '9.9.9', homepage: 'https://example.org' }), /Stick Note 9\.9\.9 \(portable\)/);
  assert.throws(() => renderTemplate('windows/README-portable.txt', { version: '9.9.9' }), PackagingError);
  assert.equal(toCrlf('a\nb\r\nc'), 'a\r\nb\r\nc');
});

test('build-info.json has the keys the program and the smoke tests read', () => {
  const info = makeBuildInfo('linux-deb', 'user');
  assert.deepEqual(Object.keys(info), ['channel', 'dataDir', 'version', 'commit', 'builtAt']);
  assert.equal(info.channel, 'linux-deb');
  assert.equal(info.dataDir, 'user');
  assert.equal(new Date(info.builtAt).toISOString(), info.builtAt);
});

/** A 64-bit ELF file header followed by a program header table with the given segment types. */
function fakeElf(types) {
  const header = Buffer.alloc(64);
  header.write('\x7fELF', 0, 'latin1');
  header[4] = 2; // 64-bit
  header.writeBigUInt64LE(64n, 32); // the program headers follow the file header
  header.writeUInt16LE(56, 54); // size of one program header
  header.writeUInt16LE(types.length, 56);
  const table = Buffer.alloc(56 * types.length);
  types.forEach((type, i) => table.writeUInt32LE(type, i * 56));
  return Buffer.concat([header, table]);
}

test('a Linux program is recognised as static when it names no program interpreter', () => {
  const dir = tempDir();
  try {
    const PT_LOAD = 1;
    const PT_DYNAMIC = 2;
    const PT_INTERP = 3;
    const write = (name, bytes) => { fs.writeFileSync(path.join(dir, name), bytes); return path.join(dir, name); };
    assert.equal(elfIsStatic(write('static', fakeElf([PT_LOAD, PT_LOAD]))), true);
    assert.equal(elfIsStatic(write('static-pie', fakeElf([PT_LOAD, PT_DYNAMIC]))), true, 'a static-pie program has a dynamic section but no interpreter');
    assert.equal(elfIsStatic(write('dynamic', fakeElf([PT_INTERP, PT_LOAD, PT_DYNAMIC]))), false);
    assert.throws(() => elfIsStatic(write('text', Buffer.from('#!/bin/sh\necho hi\n'.repeat(10)))), PackagingError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the third-party notices name the crates compiled for each system and print each license text once', () => {
  const windows = thirdPartyNotices({ triple: TRIPLES.windows, installer: true });
  const linux = thirdPartyNotices({ triple: TRIPLES.linux });
  for (const text of [windows, linux]) {
    assert.match(text, /^Stick Note includes the following third-party software\./);
    for (const crate of ['tokio ', 'hyper ', 'serde_json ', 'rust-embed ']) assert.ok(text.includes(crate), crate);
    assert.match(text, /Permission is hereby granted, free of charge/, 'the MIT license is printed');
    assert.match(text, /Apache License/, 'the Apache license is printed');
    // Each block is "Used by: <crates>" and then one license text. Identical texts must have been merged into one block.
    const bodies = text.split('='.repeat(78)).filter((block) => block.trimStart().startsWith('Used by:')).map((block) => block.slice(block.indexOf('\n\n') + 2).trim());
    assert.ok(bodies.length > 5, 'there are several different license texts');
    assert.equal(new Set(bodies).size, bodies.length, 'a license text shared by several crates is printed once, not once per crate');
    assert.match(text, /Stick Note itself is MIT licensed/);
  }
  assert.ok(windows.includes('windows-sys '), 'Windows builds include the Windows API crate');
  assert.ok(!linux.includes('windows-sys '), 'Linux builds do not');
  assert.ok(linux.includes('signal-hook-registry '), 'Linux builds include the Unix signal crate');
  assert.ok(!windows.includes('signal-hook-registry '));
  assert.match(windows, /Inno Setup/, 'the installer credits Inno Setup');
  assert.doesNotMatch(linux, /Inno Setup/);
  assert.doesNotMatch(windows + linux, /winresource|tempfile/, 'build-time and test-only crates are not shipped, so they are not listed');
  assert.doesNotMatch(windows + linux, /serde_derive|tokio-macros|rust-embed-impl|\bsyn \d|\bquote \d/, 'procedural macros run at build time and are not part of the program');
});

test('the version number is written in package.json only and the program reads it from there', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  const build = fs.readFileSync(path.join(ROOT, 'crates', 'stick-note', 'build.rs'), 'utf8');
  assert.match(build, /package\.json/, 'build.rs reads the version from package.json');
  const manifest = fs.readFileSync(path.join(ROOT, 'crates', 'stick-note', 'Cargo.toml'), 'utf8');
  assert.match(manifest, /^version = "0\.0\.0"$/m, 'Cargo.toml carries no real version number, so there is nothing to keep in step');
});

test('the installer script keeps its identity and installs without administrator rights', () => {
  const script = fs.readFileSync(path.join(ROOT, 'packaging', 'windows', 'installer.iss'), 'utf8');
  const code = script.split(/\r?\n/).filter((line) => !/^\s*(;|\/\/)/.test(line)).join('\n'); // without comments
  assert.match(script, /^AppId=\{\{2EDA025B-3EC9-46ED-8EAA-141C4C1AC42D\}$/m, 'AppId must never change: it is how upgrades and uninstall find the old copy');
  assert.match(script, /^PrivilegesRequired=lowest$/m);
  assert.match(script, /^#define AppName "Stick Note"$/m);
  assert.match(script, /^DefaultDirName=\{autopf\}\\\{#AppName\}$/m, 'the default folder is under {autopf}, which is %LOCALAPPDATA%\\Programs for a per-user install');
  assert.match(code, /function PrepareToInstall[\s\S]*StopRunningServer/, 'it stops a running server before replacing files');
  assert.match(code, /--stop/);
  assert.doesNotMatch(code, /\{(user|common)?appdata\}|\{app\}\\data/i, 'it never touches the data folder');
});

test('every GitHub Action is pinned to a full commit SHA with a version comment', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!match || match[1].startsWith('./')) continue;
      assert.match(match[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${match[1]} must be pinned to a commit`);
      assert.match(match[2], /#\s*v\d+\.\d+\.\d+\s*$/, `${file}: ${match[1]} needs a "# vX.Y.Z" comment`);
    }
  }
});
