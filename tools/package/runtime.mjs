// Download, verify and unpack the third-party programs that go into the packages:
// the official Node.js runtime and (for the AppImage) appimagetool.
//
// Everything is pinned in runtime.json. A download is accepted only when its SHA-256 equals the
// pinned value, and a fresh Node.js download must also match the official SHASUMS256.txt published
// next to it on nodejs.org.
//
// Command line:
//   node tools/package/runtime.mjs fetch win-x64|linux-x64   download and unpack the runtime into .cache/
//   node tools/package/runtime.mjs fetch appimage            download appimagetool and the AppImage runtime
//   node tools/package/runtime.mjs update <version>          pin another Node.js version, e.g. 24.23.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CACHE_DIR, PackagingError, capture, downloadFile, fail, fetchText, makeTempDir, note, removeDir, run,
  runMain, sha256File, step,
} from './lib.mjs';
import { readEntry, readZip } from './zip.mjs';

const CONFIG_FILE = fileURLToPath(new URL('./runtime.json', import.meta.url));

const TARGETS = {
  'win-x64': { ext: 'zip', binary: 'node.exe', hostPlatform: 'win32' },
  'linux-x64': { ext: 'tar.xz', binary: 'node', hostPlatform: 'linux' },
};

export const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

/** Parse the lines of a SHASUMS256.txt file ("<hash>  <file name>") into a Map of name -> hash. */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

async function officialChecksums(version, { allowOffline }) {
  const cached = path.join(CACHE_DIR, `node-v${version}-SHASUMS256.txt`);
  if (fs.existsSync(cached)) return parseChecksums(fs.readFileSync(cached, 'utf8'));
  try {
    const text = await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cached, text);
    return parseChecksums(text);
  } catch (err) {
    if (allowOffline) return null; // the pinned hash already matched, so a cached archive is still trustworthy
    throw err;
  }
}

async function ensureArchive({ archive, url, fileName, pinned, version }) {
  if (fs.existsSync(archive)) {
    if (sha256File(archive) === pinned) {
      note(`using the cached ${fileName}`);
      const official = await officialChecksums(version, { allowOffline: true });
      if (official && official.get(fileName) !== pinned) fail(`${fileName}: runtime.json disagrees with nodejs.org's SHASUMS256.txt`);
      return;
    }
    note(`the cached ${fileName} does not match the pinned hash; downloading it again`);
    fs.rmSync(archive);
  }

  note(`downloading ${url}`);
  await downloadFile(url, archive);
  const actual = sha256File(archive);
  if (actual !== pinned) {
    fs.rmSync(archive);
    fail(`SHA-256 mismatch for ${fileName}\n   pinned in runtime.json: ${pinned}\n   downloaded file:        ${actual}`);
  }
  const official = await officialChecksums(version, { allowOffline: false });
  if (official.get(fileName) !== pinned) {
    fs.rmSync(archive);
    fail(`${fileName} is not listed in nodejs.org's SHASUMS256.txt with the pinned hash`);
  }
  note(`verified SHA-256 ${pinned}`);
}

function unpack({ target, archive, base, outDir }) {
  const tmp = makeTempDir('stick-note-runtime-');
  try {
    if (TARGETS[target].ext === 'zip') {
      const zip = readZip(archive);
      for (const [member, name] of [[`${base}/node.exe`, 'node.exe'], [`${base}/LICENSE`, 'LICENSE']]) {
        fs.writeFileSync(path.join(tmp, name), readEntry(zip, member));
      }
    } else {
      if (process.platform !== 'linux') {
        fail('The Linux runtime is unpacked with GNU tar and xz, so this step must run on Linux (or WSL). From Windows use: npm run package:linux:wsl');
      }
      run('tar', ['-xJf', archive, '-C', tmp, '--strip-components=1', `${base}/bin/node`, `${base}/LICENSE`]);
      fs.renameSync(path.join(tmp, 'bin', 'node'), path.join(tmp, 'node'));
    }
    removeDir(outDir);
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.cpSync(tmp, outDir, { recursive: true });
  } finally {
    removeDir(tmp);
  }
}

/**
 * Make sure the pinned Node.js runtime for `target` is downloaded, verified and unpacked.
 * With `extract: false` only the verified archive is fetched (the WSL helper unpacks it inside Linux).
 * Returns the paths of the node binary and Node's LICENSE file.
 */
export async function ensureRuntime(target, { extract = true } = {}) {
  const spec = TARGETS[target] ?? fail(`Unknown runtime "${target}". Choose from: ${Object.keys(TARGETS).join(', ')}`);
  const { version, sha256 } = readConfig().node;
  const fileName = `node-v${version}-${target}.${spec.ext}`;
  const pinned = sha256[`${target}.${spec.ext}`] ?? fail(`runtime.json has no SHA-256 for ${target}.${spec.ext}`);
  const archive = path.join(CACHE_DIR, fileName);

  step(`Node.js ${version} runtime (${target})`);
  await ensureArchive({ archive, url: `https://nodejs.org/dist/v${version}/${fileName}`, fileName, pinned, version });
  if (!extract) return { version, target, archive };

  const base = `node-v${version}-${target}`;
  const outDir = path.join(CACHE_DIR, 'runtime', base);
  const marker = path.join(outDir, '.sha256');
  const binary = path.join(outDir, spec.binary);
  const license = path.join(outDir, 'LICENSE');
  const unpacked = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === pinned && fs.existsSync(binary) && fs.existsSync(license);
  if (!unpacked) {
    note(`unpacking ${spec.binary} and LICENSE`);
    unpack({ target, archive, base, outDir });
    fs.writeFileSync(marker, `${pinned}\n`);
  }

  // A runtime that cannot report its own version is not worth shipping (only checkable on its own platform).
  if (process.platform === spec.hostPlatform) {
    const reported = capture(binary, ['--version']).stdout.trim();
    if (reported !== `v${version}`) fail(`${binary} reports "${reported}" but runtime.json pins v${version}`);
    note(`${spec.binary} reports ${reported}`);
  }
  return { version, target, archive, binary, license };
}

async function ensurePinnedFile({ label, url, sha256, file }) {
  if (fs.existsSync(file) && sha256File(file) === sha256) {
    note(`using the cached ${label}`);
    return file;
  }
  fs.rmSync(file, { force: true });
  note(`downloading ${url}`);
  await downloadFile(url, file);
  const actual = sha256File(file);
  if (actual !== sha256) {
    fs.rmSync(file);
    fail(`SHA-256 mismatch for ${label}\n   pinned in runtime.json: ${sha256}\n   downloaded file:        ${actual}`);
  }
  note(`verified SHA-256 ${sha256}`);
  return file;
}

/**
 * appimagetool and the AppImage runtime, both pinned. appimagetool would otherwise download an
 * unpinned "continuous" runtime from GitHub on every build, so the runtime is fetched and verified
 * here and handed to it with --runtime-file.
 */
export async function ensureAppImageTools() {
  const { appimagetool, appimageRuntime } = readConfig();
  step(`appimagetool ${appimagetool.version} and AppImage runtime ${appimageRuntime.version}`);
  const tool = await ensurePinnedFile({
    label: 'appimagetool', url: appimagetool.url, sha256: appimagetool.sha256,
    file: path.join(CACHE_DIR, `appimagetool-${appimagetool.version}-x86_64.AppImage`),
  });
  const runtime = await ensurePinnedFile({
    label: 'AppImage runtime', url: appimageRuntime.url, sha256: appimageRuntime.sha256,
    file: path.join(CACHE_DIR, `appimage-runtime-${appimageRuntime.version}-x86_64`),
  });
  return { tool, runtime };
}

async function updateNode(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail('Give a version like 24.23.0');
  const sums = parseChecksums(await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`));
  const config = readConfig();
  config.node.version = version;
  for (const key of Object.keys(config.node.sha256)) {
    const name = `node-v${version}-${key}`;
    config.node.sha256[key] = sums.get(name) ?? fail(`SHASUMS256.txt for v${version} has no ${name}`);
  }
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Pinned Node.js ${version} in tools/package/runtime.json:`);
  for (const [key, hash] of Object.entries(config.node.sha256)) console.log(`  ${key}  ${hash}`);
  console.log('Review the change, then rebuild and run the smoke tests (see tools/package/README.md).');
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'fetch' && argument === 'appimage') {
    const { tool, runtime } = await ensureAppImageTools();
    console.log(`Ready: ${tool}
Ready: ${runtime}`);
  } else if (command === 'fetch') {
    const result = await ensureRuntime(argument || fail('Usage: node tools/package/runtime.mjs fetch win-x64|linux-x64|appimage'));
    console.log(`Ready: ${result.binary}`);
  } else if (command === 'update') {
    await updateNode(argument);
  } else {
    throw new PackagingError('Usage: node tools/package/runtime.mjs fetch <win-x64|linux-x64|appimage> | update <version>');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMain(main);
