// Download and verify the few third-party programs that the packaging scripts use. None of them goes into a
// package except the AppImage runtime, which is the small program at the front of every AppImage file:
//   - appimagetool and the AppImage runtime, to build the AppImage;
//   - the official Node.js for Linux, only so that the WSL helper (wsl.mjs) can run these scripts inside a fresh
//     WSL distribution, which has no Node.js.
//
// Everything is pinned in downloads.json. A download is accepted only when its SHA-256 equals the pinned value, and a
// fresh Node.js download must also match the official SHASUMS256.txt published next to it on nodejs.org.
//
// Command line:
//   node tools/package/downloads.mjs fetch node             download the Linux Node.js archive into .cache/
//   node tools/package/downloads.mjs fetch appimage         download appimagetool and the AppImage runtime
//   node tools/package/downloads.mjs update-node <version>  pin another Node.js version, e.g. 24.23.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, PackagingError, downloadFile, fail, fetchText, note, runMain, sha256File, step } from './lib.mjs';

const CONFIG_FILE = fileURLToPath(new URL('./downloads.json', import.meta.url));
const NODE_TARGET = 'linux-x64';
const NODE_EXT = 'tar.xz';

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
      if (official && official.get(fileName) !== pinned) fail(`${fileName}: downloads.json disagrees with nodejs.org's SHASUMS256.txt`);
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
    fail(`SHA-256 mismatch for ${fileName}\n   pinned in downloads.json: ${pinned}\n   downloaded file:          ${actual}`);
  }
  const official = await officialChecksums(version, { allowOffline: false });
  if (official.get(fileName) !== pinned) {
    fs.rmSync(archive);
    fail(`${fileName} is not listed in nodejs.org's SHASUMS256.txt with the pinned hash`);
  }
  note(`verified SHA-256 ${pinned}`);
}

/** The verified official Node.js archive for Linux (the WSL helper unpacks it inside Linux). */
export async function ensureNodeArchive() {
  const { version, sha256 } = readConfig().node;
  const fileName = `node-v${version}-${NODE_TARGET}.${NODE_EXT}`;
  const pinned = sha256[`${NODE_TARGET}.${NODE_EXT}`] ?? fail(`downloads.json has no SHA-256 for ${NODE_TARGET}.${NODE_EXT}`);
  step(`Node.js ${version} for Linux (runs these scripts inside WSL)`);
  const archive = path.join(CACHE_DIR, fileName);
  await ensureArchive({ archive, url: `https://nodejs.org/dist/v${version}/${fileName}`, fileName, pinned, version });
  return { version, archive };
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
    fail(`SHA-256 mismatch for ${label}\n   pinned in downloads.json: ${sha256}\n   downloaded file:          ${actual}`);
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
  const name = `node-v${version}-${NODE_TARGET}.${NODE_EXT}`;
  config.node.sha256[`${NODE_TARGET}.${NODE_EXT}`] = sums.get(name) ?? fail(`SHASUMS256.txt for v${version} has no ${name}`);
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Pinned Node.js ${version} in tools/package/downloads.json:`);
  for (const [key, hash] of Object.entries(config.node.sha256)) console.log(`  ${key}  ${hash}`);
  console.log('Review the change, then run the Linux build through WSL (see tools/package/README.md).');
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'fetch' && argument === 'appimage') {
    const { tool, runtime } = await ensureAppImageTools();
    console.log(`Ready: ${tool}\nReady: ${runtime}`);
  } else if (command === 'fetch' && argument === 'node') {
    console.log(`Ready: ${(await ensureNodeArchive()).archive}`);
  } else if (command === 'update-node') {
    await updateNode(argument);
  } else {
    throw new PackagingError('Usage: node tools/package/downloads.mjs fetch <node|appimage> | update-node <version>');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMain(main);
