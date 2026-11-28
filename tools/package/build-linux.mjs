// Build the Linux packages (run this on Linux; from Windows use: npm run package:linux:wsl):
//
//   node tools/package/build-linux.mjs [--only deb,appimage,tarball] [--out dist] [--keep] [--exe <program>]
//
// Output, named by tools/package/names.mjs:
//   dist/stick-note_<version>_amd64.deb              Ubuntu, Debian, Linux Mint: double-click, Install
//   dist/StickNote-<version>-linux-x64.AppImage      any other distribution
//   dist/StickNote-<version>-linux-x64.tar.gz        no installation: extract and run ./stick-note
//
// Every package holds one program file: a statically linked build for x86_64-unknown-linux-musl, which needs nothing
// from the system but the kernel, so it runs on any distribution. Needs: cargo with the musl target (rustup target add
// x86_64-unknown-linux-musl), GNU tar, xz, gzip and dpkg-deb (all present on Ubuntu and Debian). --exe uses a program
// that was built already, and --notices a THIRD-PARTY-NOTICES.txt that was made already (the WSL helper builds both
// on Windows, where cargo is).
//
// Everything is assembled under the system temp folder, which must be a real Linux file system:
// file modes and root ownership are only reliable there (not on a Windows drive seen from WSL).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { assetNames } from './names.mjs';
import {
  DIST_DIR, HOMEPAGE, PackagingError, ROOT, VERSION, applyModes, buildEpoch, capture, copyFile, copyrightLine, fail,
  formatBytes, listFiles, makeBuildInfo, makeTempDir, note, parseArgs, parseOnly, removeDir, renderTemplate, run, runMain,
  step, totalSize, touchTree, trackTempDirs, which, writeFile, writeText,
} from './lib.mjs';
import { ensureAppImageTools } from './downloads.mjs';
import { TRIPLES, buildProgram, checkProgramVersion, elfIsStatic, thirdPartyNotices } from './rust.mjs';

const TARGETS = ['deb', 'appimage', 'tarball'];

// Sizes the desktop looks for. The PNGs were rendered from public/icons/icon.svg (see tools/make-ico.mjs).
const ICONS = [
  [16, 'tools/icon-src/icon-16.png'],
  [32, 'tools/icon-src/icon-32.png'],
  [48, 'tools/icon-src/icon-48.png'],
  [64, 'tools/icon-src/icon-64.png'],
  [256, 'tools/icon-src/icon-256.png'],
  [512, 'public/icons/icon-512.png'],
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

/**
 * Put the program, its build-info.json and the notices into `dir`. The program looks for build-info.json next to
 * itself (resolving symbolic links), which is how it learns its channel and where the notes live.
 */
function placeProgram(dir, { exe, channel, dataDir, notices }) {
  fs.mkdirSync(dir, { recursive: true });
  copyFile(exe, path.join(dir, 'stick-note'));
  writeText(path.join(dir, 'build-info.json'), `${JSON.stringify(makeBuildInfo(channel, dataDir), null, 2)}\n`);
  writeText(path.join(dir, 'THIRD-PARTY-NOTICES.txt'), notices);
}

/** A PNG's width is stored right after its signature; a mis-sized icon would silently look blurry. */
function pngWidth(file) {
  const data = read(file);
  if (data.readUInt32BE(0) !== 0x89504e47) fail(`${file} is not a PNG`);
  return data.readUInt32BE(16);
}

function placeIcons(root) {
  for (const [size, file] of ICONS) {
    if (pngWidth(file) !== size) fail(`${file} should be ${size} pixels wide`);
    writeFile(path.join(root, 'usr', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps', 'stick-note.png'), read(file));
  }
  writeFile(path.join(root, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps', 'stick-note.svg'), read('public/icons/icon.svg'));
}

function maintainer() {
  const email = process.env.STICK_NOTE_MAINTAINER_EMAIL || capture('git', ['config', 'user.email'], { cwd: ROOT }).stdout.trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) {
    fail('No maintainer e-mail address for the .deb. Set it with: git config user.email <address> (or the STICK_NOTE_MAINTAINER_EMAIL variable).\n   Use your GitHub "noreply" address so no private address ends up in a public file.');
  }
  return `Stick Note maintainers <${email}>`;
}

/** 1.2.3-rc.1 sorts before 1.2.3 in Debian only when written 1.2.3~rc.1. */
const debVersion = (version) => version.replace('-', '~');

/** The MIT text from LICENSE, laid out the way a Debian copyright file wants it (one space, "." for blank lines). */
function mitTextForDebian() {
  const lines = read('LICENSE').toString('utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith('Permission is hereby granted'));
  if (start < 0) fail('LICENSE does not look like the MIT license');
  return lines.slice(start).join('\n').trim().split('\n').map((l) => (l.trim() === '' ? ' .' : ` ${l}`)).join('\n');
}

function debChangelog(maintainerLine, version) {
  const date = new Date(buildEpoch() * 1000).toUTCString().replace('GMT', '+0000');
  const body = [
    `stick-note (${debVersion(version)}) unstable; urgency=medium`,
    '',
    `  * Release ${version}. What changed:`,
    `    ${HOMEPAGE}/releases/tag/v${version}`,
    '',
    ` -- ${maintainerLine}  ${date}`,
    '',
  ].join('\n');
  return zlib.gzipSync(Buffer.from(body), { level: 9 }); // gzip -9n: no name or time stored
}

/** "<md5>  <path>" for every installed file, the format dpkg and debsums expect. Links are not files: they are left out. */
function md5sums(root) {
  const line = (rel) => `${crypto.createHash('md5').update(fs.readFileSync(path.join(root, rel))).digest('hex')}  ${rel}`;
  const regular = (rel) => !rel.startsWith('DEBIAN/') && !fs.lstatSync(path.join(root, rel)).isSymbolicLink();
  return `${listFiles(root).filter(regular).map(line).join('\n')}\n`;
}

function buildDeb({ work, outDir, exe, notices }) {
  step('Debian package');
  const file = assetNames(VERSION).linuxDeb;
  const root = path.join(work, 'deb');
  const maintainerLine = maintainer();

  // The program lives in /usr/lib/stick-note (with its build-info.json); /usr/bin/stick-note is a link to it.
  placeProgram(path.join(root, 'usr', 'lib', 'stick-note'), { exe, channel: 'linux-deb', dataDir: 'user', notices });
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.symlinkSync('../lib/stick-note/stick-note', path.join(root, 'usr', 'bin', 'stick-note'));
  writeText(path.join(root, 'usr', 'share', 'applications', 'stick-note.desktop'), renderTemplate('linux/stick-note.desktop'));
  placeIcons(root);

  const docs = path.join(root, 'usr', 'share', 'doc', 'stick-note');
  writeText(path.join(docs, 'copyright'), renderTemplate('linux/copyright', {
    homepage: HOMEPAGE, copyright: copyrightLine().replace(/^Copyright \(c\) /, ''), mitText: mitTextForDebian(),
  }));
  fs.writeFileSync(path.join(docs, 'changelog.gz'), debChangelog(maintainerLine, VERSION));
  const manDate = new Date(buildEpoch() * 1000).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  writeFile(path.join(root, 'usr', 'share', 'man', 'man1', 'stick-note.1.gz'), zlib.gzipSync(
    renderTemplate('linux/stick-note.1', { date: manDate, version: VERSION, homepage: HOMEPAGE }), { level: 9 }));
  writeText(path.join(root, 'usr', 'share', 'lintian', 'overrides', 'stick-note'), renderTemplate('linux/lintian-overrides'));

  // Computed before DEBIAN/ exists so the control file's own size is not counted.
  const installedSize = Math.ceil(totalSize(root) / 1024);
  const control = renderTemplate('linux/control', {
    version: debVersion(VERSION), maintainer: maintainerLine, installedSize, homepage: HOMEPAGE,
  }).replace(/^#.*\n/gm, ''); // comments are for maintainers of this repository, not for dpkg
  writeText(path.join(root, 'DEBIAN', 'control'), control);
  writeText(path.join(root, 'DEBIAN', 'prerm'), renderTemplate('linux/prerm'));
  writeText(path.join(root, 'DEBIAN', 'md5sums'), md5sums(root)); // lets "debsums" check the installed files

  applyModes(root, ['usr/lib/stick-note/stick-note', 'DEBIAN/prerm']);
  touchTree(root);

  const built = path.join(work, file);
  // -Zxz: every dpkg since 1.15 reads xz, while the zstd default of newer dpkg breaks older Debian and Ubuntu.
  run('dpkg-deb', ['--root-owner-group', '-Zxz', '-z6', '--build', root, built], { env: { SOURCE_DATE_EPOCH: String(buildEpoch()) } });
  copyFile(built, path.join(outDir, file));
  note(`${file}  ${formatBytes(fs.statSync(built).size)}`);
}

async function buildAppImage({ work, outDir, exe, notices }) {
  step('AppImage');
  const file = assetNames(VERSION).linuxAppImage;
  const { tool, runtime: appImageRuntime } = await ensureAppImageTools();

  const appDir = path.join(work, 'AppDir');
  placeProgram(path.join(appDir, 'usr', 'lib', 'stick-note'), { exe, channel: 'linux-appimage', dataDir: 'user', notices });
  writeText(path.join(appDir, 'AppRun'), renderTemplate('linux/AppRun'));
  writeText(path.join(appDir, 'stick-note.desktop'), renderTemplate('linux/stick-note.desktop'));
  fs.writeFileSync(path.join(appDir, 'stick-note.png'), read('tools/icon-src/icon-256.png'));
  fs.symlinkSync('stick-note.png', path.join(appDir, '.DirIcon'));
  placeIcons(appDir);
  applyModes(appDir, ['AppRun', 'usr/lib/stick-note/stick-note']);
  touchTree(appDir);

  // Run appimagetool from the temp folder (executable bit guaranteed) and without FUSE (not available in CI or containers).
  const toolCopy = path.join(work, 'appimagetool');
  copyFile(tool, toolCopy);
  fs.chmodSync(toolCopy, 0o755);
  const built = path.join(work, file);
  const cleanUnpacked = trackTempDirs('appimage_extracted_');
  try {
    run(toolCopy, ['--no-appstream', '--runtime-file', appImageRuntime, appDir, built], {
      env: { ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1', SOURCE_DATE_EPOCH: String(buildEpoch()) },
    });
  } finally {
    cleanUnpacked(); // appimagetool unpacks itself into the temp folder
  }
  copyFile(built, path.join(outDir, file));
  fs.chmodSync(path.join(outDir, file), 0o755);
  note(`${file}  ${formatBytes(fs.statSync(built).size)}`);
}

async function buildTarball({ work, outDir, exe, notices }) {
  step('tar.gz');
  const file = assetNames(VERSION).linuxTarball;
  const top = `stick-note-${VERSION}-linux-x64`;
  const dir = path.join(work, 'tarball', top);

  placeProgram(dir, { exe, channel: 'linux-tarball', dataDir: 'data', notices });
  writeText(path.join(dir, 'README.txt'), renderTemplate('linux/README-tarball.txt', { version: VERSION, homepage: HOMEPAGE }));
  writeText(path.join(dir, 'LICENSE'), read('LICENSE').toString('utf8').replace(/\r\n/g, '\n'));
  applyModes(dir, ['stick-note']);
  touchTree(path.dirname(dir));

  // Sorted names, numeric root ownership and one fixed time: the same input gives the same archive.
  const tar = path.join(work, 'stick-note.tar');
  run('tar', ['--sort=name', '--format=gnu', '--owner=0', '--group=0', '--numeric-owner', `--mtime=@${buildEpoch()}`,
    '-cf', tar, '-C', path.dirname(dir), top]);
  const out = path.join(outDir, file);
  await pipeline(fs.createReadStream(tar), zlib.createGzip({ level: 9 }), fs.createWriteStream(out));
  note(`${file}  ${formatBytes(fs.statSync(out).size)}`);
}

function requireTools(wanted) {
  const needs = [['tar', 'GNU tar'], ['xz', 'xz-utils']];
  if (wanted.has('deb')) needs.push(['dpkg-deb', 'dpkg-dev (or the "dpkg" package on Debian/Ubuntu)']);
  for (const [program, hint] of needs) if (!which(program)) fail(`"${program}" was not found. Install ${hint}.`);
}

async function main() {
  if (process.platform !== 'linux') {
    throw new PackagingError('The Linux packages must be built on Linux. On Windows run: npm run package:linux:wsl (needs WSL with Ubuntu).');
  }
  const args = parseArgs(process.argv.slice(2), { flags: ['keep'], options: ['only', 'out', 'exe', 'notices'] });
  const wanted = parseOnly(args.only, TARGETS);
  const outDir = path.resolve(args.out || DIST_DIR);
  requireTools(wanted);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Stick Note ${VERSION}: building ${[...wanted].join(', ')} for Linux into ${outDir}`);
  const built = args.exe ? path.resolve(args.exe) : buildProgram({ triple: TRIPLES.linux });
  if (!fs.existsSync(built)) fail(`${built} does not exist`);
  if (!elfIsStatic(built)) fail(`${built} is not statically linked, so it would not run on every distribution (build it for x86_64-unknown-linux-musl)`);
  note('the program is statically linked');
  const work = makeTempDir('stick-note-linux-');
  try {
    // A copy on the Linux file system: the program may sit on a Windows drive (WSL), where the executable bit is not reliable.
    const exe = path.join(work, 'program-source', 'stick-note');
    copyFile(built, exe);
    fs.chmodSync(exe, 0o755);
    checkProgramVersion(exe);
    // The notices are made from the crates the program was built from, which needs cargo. The WSL helper makes them
    // on Windows (where cargo is) and hands the file over.
    const notices = args.notices ? fs.readFileSync(path.resolve(args.notices), 'utf8') : thirdPartyNotices({ triple: TRIPLES.linux });
    const context = { work, outDir, exe, notices };
    if (wanted.has('tarball')) await buildTarball(context);
    if (wanted.has('deb')) buildDeb(context);
    if (wanted.has('appimage')) await buildAppImage(context);
  } finally {
    if (args.keep) note(`kept ${work}`);
    else removeDir(work);
  }
  console.log('\nDone.');
}

runMain(main);
