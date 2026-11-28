// Build and test the Linux packages from Windows, inside WSL.
//
//   node tools/package/wsl.mjs build|smoke|all [--distro Ubuntu-24.04] [--only deb,appimage,tarball] [--fuse] [--require-lintian]
//
// --fuse and --require-lintian are passed on to smoke-linux.mjs.
//
// What happens where:
//   - on Windows: the Linux program is built (a static x86_64-unknown-linux-musl build, made with Rust's own linker, so
//     no Linux toolchain is needed) and THIRD-PARTY-NOTICES.txt is made from the crates it contains;
//   - inside WSL: the packages are assembled and tested with these scripts. They need Node.js, but a fresh WSL
//     distribution has none, so the pinned, verified Linux Node.js is downloaded on the Windows side, unpacked inside
//     WSL and used to run them. (It is a tool here, not part of any package.)
//
// Everything runs as root inside WSL because the smoke tests install the .deb with dpkg.
// The packages land in dist/ of this repository (the Windows folder), like a normal build.

import fs from 'node:fs';
import path from 'node:path';
import {
  CACHE_DIR, ROOT, buildEpoch, capture, fail, gitCommit, parseArgs, run, runMain, which, writeFile,
} from './lib.mjs';
import { ensureNodeArchive } from './downloads.mjs';
import { TRIPLES, buildProgram, thirdPartyNotices } from './rust.mjs';

const COMMANDS = ['build', 'smoke', 'all'];
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function toWslPath(distro, windowsPath) {
  const result = capture('wsl', ['-d', distro, '--', 'wslpath', '-a', windowsPath]);
  if (result.status !== 0 || !result.stdout.trim()) fail(`WSL distribution "${distro}" could not translate ${windowsPath}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function main() {
  if (process.platform !== 'win32') fail('This helper is for Windows. On Linux run the scripts directly: node tools/package/build-linux.mjs');
  const args = parseArgs(process.argv.slice(2), { flags: ['fuse', 'require-lintian'], options: ['distro', 'only'] });
  const command = args._[0] || fail(`Usage: node tools/package/wsl.mjs <${COMMANDS.join('|')}> [--distro Ubuntu-24.04] [--only deb,appimage,tarball]`);
  if (!COMMANDS.includes(command)) fail(`Unknown command "${command}". Choose from: ${COMMANDS.join(', ')}`);
  const distro = args.distro || 'Ubuntu-24.04';
  if (!which('wsl')) fail('wsl.exe was not found. Install WSL (wsl --install) with an Ubuntu distribution.');

  const { archive } = await ensureNodeArchive();
  const root = toWslPath(distro, ROOT);
  const archiveInWsl = toWslPath(distro, archive);
  const only = args.only ? ` --only ${shellQuote(args.only)}` : '';
  const smokeFlags = ['fuse', 'require-lintian'].filter((flag) => args[flag]).map((flag) => ` --${flag}`).join('');

  let buildFlags = '';
  if (command !== 'smoke') {
    const exe = buildProgram({ triple: TRIPLES.linux });
    const notices = path.join(CACHE_DIR, 'linux-third-party-notices.txt');
    writeFile(notices, thirdPartyNotices({ triple: TRIPLES.linux }));
    buildFlags = ` --exe ${shellQuote(toWslPath(distro, exe))} --notices ${shellQuote(toWslPath(distro, notices))}`;
  }

  // Values that need git or the Windows environment are worked out here and handed over.
  const email = process.env.STICK_NOTE_MAINTAINER_EMAIL || capture('git', ['config', 'user.email'], { cwd: ROOT }).stdout.trim();
  const lines = [
    '#!/bin/sh',
    'set -eu',
    'BOOT=/tmp/stick-note-wsl-node',
    'rm -rf "$BOOT" && mkdir -p "$BOOT"',
    `trap 'rm -rf "$BOOT"' EXIT`,
    `tar -xJf ${shellQuote(archiveInWsl)} -C "$BOOT" --strip-components=2 --wildcards '*/bin/node'`,
    `export SOURCE_DATE_EPOCH=${shellQuote(buildEpoch())}`,
    `export STICK_NOTE_COMMIT=${shellQuote(gitCommit())}`,
    ...(email ? [`export STICK_NOTE_MAINTAINER_EMAIL=${shellQuote(email)}`] : []),
    `cd ${shellQuote(root)}`,
    ...(command !== 'smoke' ? [`"$BOOT/node" tools/package/build-linux.mjs${only}${buildFlags}`] : []),
    ...(command !== 'build' ? [`"$BOOT/node" tools/package/smoke-linux.mjs${only}${smokeFlags}`] : []),
    '',
  ];
  const script = path.join(CACHE_DIR, 'wsl-run.sh');
  writeFile(script, lines.join('\n')); // LF line endings: the script is read by sh
  run('wsl', ['-d', distro, '-u', 'root', '--', 'sh', toWslPath(distro, script)]);
  if (!fs.existsSync(path.join(ROOT, 'dist'))) fail('WSL finished but dist/ was not created');
}

runMain(main);
