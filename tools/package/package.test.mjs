// Tests for the pure parts of the packaging scripts (run by "npm test" with everything else).
// The packages themselves are tested by the smoke tests: npm run package:smoke

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetNames } from './names.mjs';
import {
  PackagingError, ROOT, childEnv, listFiles, makeBuildInfo, numericVersion, parseArgs, parseOnly, renderTemplate, stagePayload, toCrlf,
} from './lib.mjs';
import { crc32, readEntry, readZip, writeZip } from './zip.mjs';
import { parseChecksums, readConfig } from './runtime.mjs';

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

test('the pinned downloads in runtime.json are well formed', () => {
  const config = readConfig();
  assert.match(config.node.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(config.node.sha256).sort(), ['linux-x64.tar.xz', 'win-x64.zip']);
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

test('the payload is an allow-list copy with LF line endings and a build-info.json', () => {
  const dir = tempDir();
  try {
    const info = makeBuildInfo('linux-deb', 'user');
    assert.deepEqual(Object.keys(info), ['channel', 'dataDir', 'version', 'commit', 'builtAt']);
    assert.equal(new Date(info.builtAt).toISOString(), info.builtAt);

    const app = path.join(dir, 'app');
    stagePayload(app, info);
    const files = listFiles(app);
    for (const required of ['server.js', 'package.json', 'LICENSE', 'build-info.json', 'src/app.js', 'public/index.html']) assert.ok(files.includes(required), required);
    assert.deepEqual(files.filter((f) => !/^(server\.js|package\.json|LICENSE|build-info\.json|src\/|public\/)/.test(f)), [], 'only the allow-listed entries');
    assert.ok(!files.some((f) => f.startsWith('data/') || f.includes('node_modules')), 'no notes and no node_modules');
    assert.ok(!fs.readFileSync(path.join(app, 'server.js'), 'utf8').includes('\r'), 'server.js has LF line endings');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'build-info.json'), 'utf8')), info);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
