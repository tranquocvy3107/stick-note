// Build the Windows packages (run this on Windows):
//
//   node tools/package/build-windows.mjs [--only portable,installer] [--out dist] [--keep]
//
// Output, named by tools/package/names.mjs:
//   dist/StickNote-<version>-windows-x64-portable.zip   unzip anywhere and double-click "Stick Note.exe"
//   dist/StickNote-<version>-windows-x64-setup.exe      per-user installer (no administrator prompt)
//
// Both contain the same program files:
//   Stick Note.exe                  tiny launcher without a console window (packaging/windows/launcher.cs)
//   runtime\stick-note-server.exe   the official Node.js node.exe under a name Task Manager can explain
//   app\                            server.js, src\, public\, package.json, LICENSE, build-info.json
//
// The tools needed are the C# compiler that ships with Windows (csc.exe) and Inno Setup 6.

import fs from 'node:fs';
import path from 'node:path';
import { assetNames } from './names.mjs';
import {
  DIST_DIR, HOMEPAGE, PACKAGING_DIR, ROOT, VERSION, buildEpoch, copyFile, copyrightLine, fail, formatBytes, listFiles,
  makeBuildInfo, makeTempDir, note, numericVersion, parseArgs, parseOnly, peSubsystem, removeDir, renderTemplate,
  run, runMain, stagePayload, step, thirdPartyNotices, toCrlf, touchTree, which, writeText,
} from './lib.mjs';
import { ensureRuntime } from './runtime.mjs';
import { writeZip } from './zip.mjs';

const TARGETS = ['portable', 'installer'];
const LAUNCHER = 'Stick Note.exe';
const SERVER = 'stick-note-server.exe';
const WINDOWS_GUI = 2;

function findCsc() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    process.env.CSC,
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c))
    ?? fail('csc.exe (the C# compiler that ships with Windows) was not found under C:\\Windows\\Microsoft.NET. Set CSC to its path.');
}

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

const csString = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Compile packaging/windows/launcher.cs into a GUI program with the app icon and version information. */
function buildLauncher(workDir) {
  step(`Launcher (${LAUNCHER})`);
  const out = path.join(workDir, LAUNCHER);
  const info = path.join(workDir, 'AssemblyInfo.cs');
  writeText(info, renderTemplate('windows/AssemblyInfo.cs.template', {
    copyright: csString(copyrightLine()), numericVersion: numericVersion(), version: csString(VERSION),
  }));
  run(findCsc(), [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-', '/warnaserror+',
    `/win32icon:${path.join(ROOT, 'public', 'icons', 'app.ico')}`,
    `/win32manifest:${path.join(PACKAGING_DIR, 'windows', 'launcher.manifest')}`,
    `/out:${out}`,
    path.join(PACKAGING_DIR, 'windows', 'launcher.cs'),
    info,
  ]);
  if (peSubsystem(out) !== WINDOWS_GUI) fail(`${LAUNCHER} was not built as a GUI program; it would show a console window`);
  note(`built ${LAUNCHER} (${formatBytes(fs.statSync(out).size)}, GUI program)`);
  return out;
}

/** Lay out the program files of one channel in `stage`. */
function stageProgram(stage, { channel, dataDir, runtime, launcher, installer }) {
  fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
  copyFile(launcher, path.join(stage, LAUNCHER));
  copyFile(runtime.binary, path.join(stage, 'runtime', SERVER));
  copyFile(runtime.license, path.join(stage, 'runtime', 'LICENSE-node.txt'));
  stagePayload(path.join(stage, 'app'), makeBuildInfo(channel, dataDir));
  writeText(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), toCrlf(thirdPartyNotices({ nodeVersion: runtime.version, installer })));
}

function buildPortable({ work, outDir, runtime, launcher }) {
  step('Portable zip');
  const file = assetNames(VERSION).windowsPortable;
  const top = file.replace(/\.zip$/, '');
  const stage = path.join(work, 'portable');
  stageProgram(stage, { channel: 'windows-portable', dataDir: '../data', runtime, launcher, installer: false });
  writeText(path.join(stage, 'README.txt'), toCrlf(renderTemplate('windows/README-portable.txt', { version: VERSION, homepage: HOMEPAGE })));

  const out = path.join(outDir, file);
  fs.rmSync(out, { force: true });
  writeZip(out, listFiles(stage).map((rel) => ({ name: `${top}/${rel}`, file: path.join(stage, rel) })), { epoch: buildEpoch() });
  note(`${file}  ${formatBytes(fs.statSync(out).size)}`);
}

function buildInstaller({ work, outDir, runtime, launcher }) {
  step('Installer');
  const file = assetNames(VERSION).windowsInstaller;
  const stage = path.join(work, 'installer');
  stageProgram(stage, { channel: 'windows-installer', dataDir: 'user', runtime, launcher, installer: true });
  touchTree(stage); // the setup program records file times; keep them stable

  const out = path.join(outDir, file);
  fs.rmSync(out, { force: true });
  run(findIscc(), [
    '/Qp',
    `/DAppVersion=${VERSION}`,
    `/DNumericVersion=${numericVersion()}`,
    `/DSourceDir=${stage}`,
    `/DOutputDir=${outDir}`,
    `/DOutputBaseFilename=${file.replace(/\.exe$/, '')}`,
    `/DRepoRoot=${ROOT}`,
    `/DCopyright=${copyrightLine()}`,
    `/DAppUrl=${HOMEPAGE}`,
    path.join(PACKAGING_DIR, 'windows', 'installer.iss'),
  ]);
  if (!fs.existsSync(out)) fail(`Inno Setup finished but ${file} was not created`);
  note(`${file}  ${formatBytes(fs.statSync(out).size)}`);
}

async function main() {
  if (process.platform !== 'win32') fail('The Windows packages must be built on Windows.');
  const args = parseArgs(process.argv.slice(2), { flags: ['keep'], options: ['only', 'out'] });
  const wanted = parseOnly(args.only, TARGETS);
  const outDir = path.resolve(args.out || DIST_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Stick Note ${VERSION}: building ${[...wanted].join(' and ')} for Windows into ${outDir}`);
  const runtime = await ensureRuntime('win-x64');
  const work = makeTempDir('stick-note-win-');
  try {
    const launcher = buildLauncher(work);
    const context = { work, outDir, runtime, launcher };
    if (wanted.has('portable')) buildPortable(context);
    if (wanted.has('installer')) buildInstaller(context);
  } finally {
    if (args.keep) note(`kept ${work}`);
    else removeDir(work);
  }
  console.log('\nDone.');
}

runMain(main);
