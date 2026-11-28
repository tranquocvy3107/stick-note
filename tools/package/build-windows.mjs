// Build the Windows packages (run this on Windows):
//
//   node tools/package/build-windows.mjs [--only portable,installer] [--out dist] [--keep] [--exe <program>] [--no-shortcuts]
//
// Output, named by tools/package/names.mjs:
//   dist/StickNote-<version>-windows-x64-portable.zip   unzip anywhere and double-click "Stick Note.exe"
//   dist/StickNote-<version>-windows-x64-setup.exe      per-user installer (no administrator prompt)
//
// Both contain the same program files:
//   Stick Note.exe          the program: server, launcher and command line in one file, without a console window
//   build-info.json         how this copy was packaged (channel, where the notes are kept)
//   LICENSE.txt, THIRD-PARTY-NOTICES.txt
//
// The program is built with cargo (Rust) and the installer with Inno Setup 6. --exe uses a program that was
// built already instead of building one. --no-shortcuts builds a test installer WITHOUT Start Menu and Desktop
// shortcuts: the smoke test uses it on a machine that has a "Stick Note" shortcut of its own (see smoke-windows.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { assetNames } from './names.mjs';
import {
  DIST_DIR, HOMEPAGE, PACKAGING_DIR, ROOT, VERSION, buildEpoch, copyFile, copyrightLine, fail, formatBytes, listFiles, makeBuildInfo,
  makeTempDir, note, numericVersion, parseArgs, parseOnly, removeDir, renderTemplate, run, runMain, step, toCrlf, touchTree, which, writeText,
} from './lib.mjs';
import { TRIPLES, buildProgram, checkProgramVersion, checkWindowsProgram, thirdPartyNotices } from './rust.mjs';
import { writeZip } from './zip.mjs';

const TARGETS = ['portable', 'installer'];
const PROGRAM = 'Stick Note.exe';

function findIscc() {
  const programFiles86 = process.env['ProgramFiles(x86)'];
  const programFiles = process.env.ProgramFiles;
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.ISCC,
    which('iscc'),
    programFiles86 && path.join(programFiles86, 'Inno Setup 6', 'ISCC.exe'),
    programFiles && path.join(programFiles, 'Inno Setup 6', 'ISCC.exe'),
    local && path.join(local, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c))
    ?? fail('Inno Setup 6 (ISCC.exe) was not found. Install it with "winget install JRSoftware.InnoSetup" or "choco install innosetup", or set ISCC to its path.');
}

/** Lay out the program files of one channel in `stage`. */
function stageProgram(stage, { channel, dataDir, exe, installer }) {
  fs.mkdirSync(stage, { recursive: true });
  copyFile(exe, path.join(stage, PROGRAM));
  writeText(path.join(stage, 'build-info.json'), `${JSON.stringify(makeBuildInfo(channel, dataDir), null, 2)}\n`);
  writeText(path.join(stage, 'LICENSE.txt'), toCrlf(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')));
  writeText(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), toCrlf(thirdPartyNotices({ triple: TRIPLES.windows, installer })));
}

function buildPortable({ work, outDir, exe }) {
  step('Portable zip');
  const file = assetNames(VERSION).windowsPortable;
  const top = file.replace(/\.zip$/, '');
  const stage = path.join(work, 'portable');
  stageProgram(stage, { channel: 'windows-portable', dataDir: 'data', exe, installer: false });
  writeText(path.join(stage, 'README.txt'), toCrlf(renderTemplate('windows/README-portable.txt', { version: VERSION, homepage: HOMEPAGE })));

  const out = path.join(outDir, file);
  fs.rmSync(out, { force: true });
  writeZip(out, listFiles(stage).map((rel) => ({ name: `${top}/${rel}`, file: path.join(stage, rel) })), { epoch: buildEpoch() });
  note(`${file}  ${formatBytes(fs.statSync(out).size)}`);
}

function buildInstaller({ work, outDir, exe, shortcuts }) {
  step(shortcuts ? 'Installer' : 'Installer (test variant without shortcuts)');
  const file = assetNames(VERSION).windowsInstaller;
  const stage = path.join(work, 'installer');
  stageProgram(stage, { channel: 'windows-installer', dataDir: 'user', exe, installer: true });
  touchTree(stage); // the setup program records file times; keep them stable

  // The test variant goes into its own folder, so it can never be mistaken for the real installer or end up in a release.
  const installerDir = shortcuts ? outDir : path.join(outDir, 'test-installer');
  fs.mkdirSync(installerDir, { recursive: true });
  const out = path.join(installerDir, file);
  fs.rmSync(out, { force: true });
  run(findIscc(), [
    '/Qp',
    `/DAppVersion=${VERSION}`,
    `/DNumericVersion=${numericVersion()}`,
    `/DSourceDir=${stage}`,
    `/DOutputDir=${installerDir}`,
    `/DOutputBaseFilename=${file.replace(/\.exe$/, '')}`,
    `/DRepoRoot=${ROOT}`,
    `/DCopyright=${copyrightLine()}`,
    `/DAppUrl=${HOMEPAGE}`,
    ...(shortcuts ? [] : ['/DNoShortcuts=1']),
    path.join(PACKAGING_DIR, 'windows', 'installer.iss'),
  ]);
  if (!fs.existsSync(out)) fail(`Inno Setup finished but ${file} was not created`);
  note(`${file}  ${formatBytes(fs.statSync(out).size)}`);
}

async function main() {
  if (process.platform !== 'win32') fail('The Windows packages must be built on Windows.');
  const args = parseArgs(process.argv.slice(2), { flags: ['keep', 'no-shortcuts'], options: ['only', 'out', 'exe'] });
  const wanted = parseOnly(args.only, TARGETS);
  const outDir = path.resolve(args.out || DIST_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Stick Note ${VERSION}: building ${[...wanted].join(' and ')} for Windows into ${outDir}`);
  const exe = args.exe ? path.resolve(args.exe) : buildProgram({ triple: TRIPLES.windows });
  if (!fs.existsSync(exe)) fail(`${exe} does not exist`);
  checkWindowsProgram(exe);
  checkProgramVersion(exe);

  const work = makeTempDir('stick-note-win-');
  try {
    const context = { work, outDir, exe };
    if (wanted.has('portable')) buildPortable(context);
    if (wanted.has('installer')) buildInstaller({ ...context, shortcuts: !args['no-shortcuts'] });
  } finally {
    if (args.keep) note(`kept ${work}`);
    else removeDir(work);
  }
  console.log('\nDone.');
}

runMain(main);
