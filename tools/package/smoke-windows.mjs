// Smoke tests for the Windows packages in dist/ (run this on Windows after build-windows.mjs):
//
//   node tools/package/smoke-windows.mjs [--only portable,installer] [--dist dist] [--desktop-shortcut] [--no-shortcuts]
//
// portable   unzip, start "Stick Note.exe" the way a shortcut does and with --open, save a note, stop it
// installer  silent install, run the installed copy, silent re-install over a RUNNING copy (the upgrade case: the
//            installer must stop the server so files are not locked), an upgrade over a running copy of the old
//            layout (versions up to 1.2.x ran on Node.js), silent uninstall (the notes must survive); all in
//            temporary folders
//
// The installer test creates and removes a Start Menu shortcut. The Desktop shortcut is only tested with
// --desktop-shortcut (CI does), so a developer's own "Stick Note" shortcut is never overwritten.
// --no-shortcuts tests the installer variant built by "build-windows.mjs --no-shortcuts" (dist/test-installer/): it has
// no shortcuts at all, which is the way to run this test on a machine that already has a "Stick Note" shortcut.

import fs from 'node:fs';
import path from 'node:path';
import { assetNames } from './names.mjs';
import { DIST_DIR, PACKAGING_DIR, ROOT, VERSION, capture, fail, note as logNote, parseArgs, parseOnly, peSubsystem, runMain, step, which } from './lib.mjs';
import {
  appEnv, check, cleanupApp, findFreePort, makeTempDir, ok, ping, removeDir, runToEnd, startApp, stopApp, verifyApp, waitUntil, watchServer,
} from './smoke-lib.mjs';
import { readEntry, readZip } from './zip.mjs';

const TARGETS = ['portable', 'installer'];
const WINDOWS_GUI = 2;
const OLD_VERSION_TAG = 'v1.2.0'; // the last release that ran on Node.js and had the old layout

const powershell = () => which('powershell') || which('pwsh') || fail('PowerShell was not found');

/**
 * Run a small PowerShell snippet; values are passed through environment variables, never spliced into the script.
 * PSModulePath is dropped on purpose: Windows PowerShell 5.1 started from PowerShell 7 inherits the folders of
 * PowerShell 7's modules, loads an Expand-Archive that needs a newer .NET and then extracts nothing
 * while still exiting with 0. Without the variable it uses its own modules.
 */
function ps(script, vars = {}) {
  const result = capture(powershell(), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { PSModulePath: null, ...vars } });
  if (result.status !== 0) fail(`PowerShell failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const expandZip = (zip, dest) => ps('Expand-Archive -LiteralPath $env:SN_ZIP -DestinationPath $env:SN_DEST -Force', { SN_ZIP: zip, SN_DEST: dest });

const shortcutTarget = (lnk) => ps('(New-Object -ComObject WScript.Shell).CreateShortcut($env:SN_LNK).TargetPath', { SN_LNK: lnk });

// Windows may show the same folder with a short (MAYTIN~1) or a long name; compare the real files.
const sameFile = (a, b) => fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();

const folderPath = (name) => ps('[Environment]::GetFolderPath($env:SN_FOLDER)', { SN_FOLDER: name });

function versionInfo(file) {
  const [product, fileVersion, productVersion] = ps(
    '$v = (Get-Item -LiteralPath $env:SN_FILE).VersionInfo; "$($v.ProductName)|$($v.FileVersion)|$($v.ProductVersion)"',
    { SN_FILE: file },
  ).split('|');
  return { product, fileVersion, productVersion };
}

function requireFiles(root, files) {
  for (const rel of files) check(fs.existsSync(path.join(root, ...rel.split('/'))), `${rel} is present`);
}

/** Checks that apply to every unpacked or installed copy. */
function inspectProgram(root, { channel, dataDir }) {
  const exe = path.join(root, 'Stick Note.exe');
  requireFiles(root, ['Stick Note.exe', 'build-info.json', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']);
  check(!fs.existsSync(path.join(root, 'runtime')) && !fs.existsSync(path.join(root, 'app')), 'there is no runtime\\ or app\\ folder (nothing of the old Node.js layout is left)');
  const size = fs.statSync(exe).size;
  check(size < 8 * 1024 * 1024, `Stick Note.exe is ${(size / 1024 / 1024).toFixed(1)} MiB: the whole program, with no runtime inside`);
  check(peSubsystem(exe) === WINDOWS_GUI, 'Stick Note.exe is a GUI program, so it never shows a console window');
  const info = versionInfo(exe);
  check(info.product === 'Stick Note' && info.productVersion === VERSION, `Stick Note.exe carries version information (${info.product} ${info.productVersion})`, JSON.stringify(info));
  const build = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
  check(build.channel === channel && build.version === VERSION, `build-info.json says channel ${channel}, version ${VERSION}`, JSON.stringify(build));
  check(build.dataDir === dataDir, `build-info.json says dataDir "${dataDir}"`, JSON.stringify(build));
  const notices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  check(/hyper/.test(notices) && /tokio/.test(notices) && /Permission is hereby granted/.test(notices), 'THIRD-PARTY-NOTICES.txt lists the Rust crates and prints their licenses');
}

/** Start the program the way a shortcut does and with --open; both must work and share the same notes. */
async function runBothWays(root, { port, env, version, channel, dataDir }) {
  const exe = path.join(root, 'Stick Note.exe');
  const stopCommand = { command: exe, args: ['--stop'] };
  let app;
  try {
    // From another working folder on purpose: the program must not depend on where it is started from.
    app = await startApp({ label: 'Stick Note.exe (what a shortcut starts)', command: exe, cwd: path.dirname(root), env, port });
    await verifyApp(app, { version, channel, dataDir });
    await stopApp(app, stopCommand);

    app = await startApp({ label: 'Stick Note.exe --open', command: exe, args: ['--open'], env, port });
    await verifyApp(app, { version, channel, dataDir });
    await stopApp(app, stopCommand);
    app = null;
  } finally {
    await cleanupApp(app);
  }
}

async function smokePortable(dist) {
  const file = assetNames(VERSION).windowsPortable;
  const zip = path.join(dist, file);
  if (!fs.existsSync(zip)) fail(`${zip} does not exist. Build it first: npm run package:windows`);
  step(`Portable zip: ${file}`);

  const work = makeTempDir('stick-note-smoke-portable-');
  try {
    // A space and an accented letter in the path, as in many real user names and folders.
    const unpacked = path.join(work, 'Stick Note Tést');
    expandZip(zip, unpacked);
    const top = file.replace(/\.zip$/, '');
    const root = path.join(unpacked, top);
    check(fs.existsSync(root), `the zip unpacks into the folder ${top}\\`);
    check(fs.readdirSync(unpacked).length === 1, 'nothing else is in the zip outside that folder');
    requireFiles(root, ['README.txt']);
    inspectProgram(root, { channel: 'windows-portable', dataDir: 'data' });

    // Notes must land next to the program ("data" beside Stick Note.exe), wherever it was unpacked.
    const port = await findFreePort();
    await runBothWays(root, {
      port, env: appEnv(port, { APPDATA: path.join(work, 'must-stay-unused') }), version: VERSION, channel: 'windows-portable', dataDir: path.join(root, 'data'),
    });
    check(!fs.existsSync(path.join(work, 'must-stay-unused')), 'nothing was written to the per-user data folder');
  } finally {
    removeDir(work);
  }
}

// ---- installer ---------------------------------------------------------------------

/** The AppId of the real installer, or (test variant) of the one built with /DNoShortcuts: both are in installer.iss. */
function readAppId({ testVariant }) {
  const script = fs.readFileSync(path.join(PACKAGING_DIR, 'windows', 'installer.iss'), 'utf8');
  const block = testVariant ? /^#ifdef NoShortcuts\r?\n(?:;.*\r?\n)*AppId=\{\{([0-9A-Fa-f-]{36})\}/m : /^#else\r?\n(?:;.*\r?\n)*AppId=\{\{([0-9A-Fa-f-]{36})\}/m;
  const match = block.exec(script);
  return match ? match[1].toUpperCase() : fail('Could not find the AppId in packaging/windows/installer.iss');
}

const registryHas = (key) => capture('reg', ['query', key, '/v', 'DisplayVersion']).status === 0;

/**
 * Lay out an installation of the OLD kind (versions up to 1.2.x, which ran on Node.js) in `installDir`:
 * runtime\stick-note-server.exe is a Node.js, app\ holds the server of release v1.2.0 taken from git. Returns false
 * when the tag is not available (a shallow clone), in which case the test is skipped.
 */
function layOutOldVersion(installDir, work) {
  const archive = path.join(work, 'old-app.zip');
  const result = capture('git', ['archive', '--format=zip', `--output=${archive}`, OLD_VERSION_TAG, 'server.js', 'src', 'public', 'package.json'], { cwd: ROOT });
  if (result.status !== 0) return false;
  const zip = readZip(archive);
  for (const name of zip.entries.keys()) {
    if (name.endsWith('/')) continue;
    const dest = path.join(installDir, 'app', ...name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readEntry(zip, name));
  }
  fs.mkdirSync(path.join(installDir, 'runtime'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(installDir, 'runtime', 'stick-note-server.exe')); // this machine's Node.js stands in for the bundled one
  fs.writeFileSync(path.join(installDir, 'app', 'build-info.json'), JSON.stringify({ channel: 'windows-installer', dataDir: 'user', version: '1.2.0' }));
  fs.writeFileSync(path.join(installDir, 'Stick Note.exe'), 'the old launcher'); // replaced by the new program
  return true;
}

async function smokeInstaller(dist, { desktopShortcut, noShortcuts }) {
  const file = assetNames(VERSION).windowsInstaller;
  const setup = noShortcuts ? path.join(dist, 'test-installer', file) : path.join(dist, file);
  if (!fs.existsSync(setup)) fail(`${setup} does not exist. Build it first: ${noShortcuts ? 'node tools/package/build-windows.mjs --only installer --no-shortcuts' : 'npm run package:windows'}`);
  step(`Installer: ${noShortcuts ? 'test variant without shortcuts' : file}`);

  const programs = folderPath('Programs');
  const desktop = folderPath('Desktop');
  const startMenuLink = path.join(programs, 'Stick Note.lnk');
  const desktopLink = path.join(desktop, 'Stick Note.lnk');
  if (!noShortcuts) {
    // The uninstaller deletes the shortcuts it created, so an existing one (for example from an earlier
    // installation) would be replaced and then lost. Never run over somebody's shortcut.
    for (const link of [startMenuLink, ...(desktopShortcut ? [desktopLink] : [])]) {
      if (fs.existsSync(link)) {
        fail(`${link} already exists and this test would replace it and then delete it. Remove it first, run this test on a clean machine (CI does), or test the variant without shortcuts: build it with "node tools/package/build-windows.mjs --only installer --no-shortcuts" and run this test with --no-shortcuts.`);
      }
    }
  }

  const work = makeTempDir('stick-note-smoke-setup-');
  const installDir = path.join(work, 'Stick Note');
  const appData = path.join(work, 'AppData');
  const dataDir = path.join(appData, 'Stick Note');
  fs.mkdirSync(appData);
  const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${readAppId({ testVariant: noShortcuts })}}_is1`;
  if (registryHas(uninstallKey)) fail(`${uninstallKey} exists already: this test would overwrite and then delete it. Is this the test variant installed for real, or a copy left by an earlier run? Uninstall it first.`);

  const port = await findFreePort();
  // The program under test sees a temporary %APPDATA%, so the notes of a real installation are never touched.
  const env = appEnv(port, { APPDATA: appData });
  // The installer and uninstaller run "--stop" with this environment: PORT keeps it away from a real copy on 4747.
  const setupEnv = { ...process.env, PORT: String(port) };
  const setupArgs = (log) => [
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', `/DIR=${installDir}`, `/LOG=${log}`,
    ...(desktopShortcut ? [] : ['/MERGETASKS=!desktopicon']),
  ];
  const exe = path.join(installDir, 'Stick Note.exe');
  const startInstalledServer = (label) => startApp({ label, command: exe, args: ['--open'], env, port });

  let app = null;
  try {
    console.log('\n-- silent install');
    let result = await runToEnd(setup, setupArgs(path.join(work, 'install.log')), { env: setupEnv, timeoutMs: 300_000 });
    check(result.code === 0, 'the silent install succeeds (no administrator prompt, no window)', `exit ${result.code}: ${result.output}`);
    inspectProgram(installDir, { channel: 'windows-installer', dataDir: 'user' });
    requireFiles(installDir, ['unins000.exe']);
    check(registryHas(uninstallKey), 'Windows lists Stick Note under installed apps (HKCU uninstall entry)');
    if (noShortcuts) ok('shortcuts skipped on purpose (this is the variant without shortcuts)');
    else {
      check(fs.existsSync(startMenuLink) && sameFile(shortcutTarget(startMenuLink), exe), 'a Start Menu shortcut points at the installed Stick Note.exe');
      if (desktopShortcut) check(fs.existsSync(desktopLink), 'the Desktop shortcut was created (that task is on by default)');
      else ok('Desktop shortcut skipped on purpose (use --desktop-shortcut to test it)');
    }

    await runBothWays(installDir, { port, env, version: VERSION, channel: 'windows-installer', dataDir });

    console.log('\n-- silent upgrade over a running copy');
    app = await startInstalledServer('installed copy, left running during the upgrade');
    const watcher = watchServer(port);
    result = await runToEnd(setup, setupArgs(path.join(work, 'upgrade.log')), { env: setupEnv, timeoutMs: 300_000 });
    const wentDownAfter = await watcher.finish();
    check(result.code === 0, 'the upgrade over a running copy succeeds', `exit ${result.code}: ${result.output}`);
    check(wentDownAfter !== null && !(await ping(port)), `the installer stopped the running server (it went down ${wentDownAfter} ms after the upgrade began)`);
    await cleanupApp(app);
    app = null;
    inspectProgram(installDir, { channel: 'windows-installer', dataDir: 'user' });
    check(fs.existsSync(path.join(dataDir, 'board.json')), 'the notes are still there after the upgrade');
    await runBothWays(installDir, { port, env, version: VERSION, channel: 'windows-installer', dataDir });

    console.log(`\n-- silent upgrade over a running copy of the old layout (${OLD_VERSION_TAG}, Node.js)`);
    if (!layOutOldVersion(installDir, work)) {
      logNote(`skipped: the git tag ${OLD_VERSION_TAG} is not available here (a shallow clone has no tags)`);
    } else {
      const oldRuntime = path.join(installDir, 'runtime', 'stick-note-server.exe');
      const oldScript = path.join(installDir, 'app', 'server.js');
      // The old program is removed by the upgrade, so its notes must be there before and after.
      app = await startApp({ label: 'the OLD server (Node.js, runtime\\ and app\\), left running during the upgrade', command: oldRuntime, args: [oldScript, '--open'], env, port });
      const before = await (await fetch(`http://127.0.0.1:${port}/api/board`)).json();
      check(before.board.notes.some((n) => n.id === 'smoke-test-note'), 'the old server serves the notes saved earlier');
      const oldWatcher = watchServer(port);
      result = await runToEnd(setup, setupArgs(path.join(work, 'upgrade-old.log')), { env: setupEnv, timeoutMs: 300_000 });
      const oldWentDown = await oldWatcher.finish();
      check(result.code === 0, 'the upgrade over a running OLD server succeeds', `exit ${result.code}: ${result.output}`);
      check(oldWentDown !== null && !(await ping(port)), `the installer stopped the old server (it went down ${oldWentDown} ms after the upgrade began)`);
      await cleanupApp(app);
      app = null;
      inspectProgram(installDir, { channel: 'windows-installer', dataDir: 'user' });
      check(fs.existsSync(path.join(dataDir, 'board.json')), 'the notes are still there after leaving Node.js behind');
      app = await startInstalledServer('the new program on the notes of the old one');
      const after = await (await fetch(`http://127.0.0.1:${port}/api/board`)).json();
      check(after.board.notes.some((n) => n.id === 'smoke-test-note'), 'the new program shows the notes the old server saved');
      await stopApp(app, { command: exe, args: ['--stop'] });
      app = null;
    }

    console.log('\n-- silent uninstall while the app is running');
    app = await startInstalledServer('installed copy, left running during the uninstall');
    result = await runToEnd(path.join(installDir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { env: setupEnv, timeoutMs: 120_000 });
    check(result.code === 0, 'the silent uninstall succeeds', `exit ${result.code}: ${result.output}`);
    // unins000.exe hands over to a temporary copy of itself and returns at once, so wait for the real work.
    check(await waitUntil(() => !fs.existsSync(installDir), 60_000, 500), 'the install folder is gone');
    check(!(await ping(port)), 'the uninstaller stopped the running server');
    await cleanupApp(app);
    app = null;
    check(!registryHas(uninstallKey), 'the entry under installed apps is gone');
    if (!noShortcuts) {
      check(!fs.existsSync(startMenuLink), 'the Start Menu shortcut is gone');
      if (desktopShortcut) check(!fs.existsSync(desktopLink), 'the Desktop shortcut is gone');
    }
    check(fs.existsSync(path.join(dataDir, 'board.json')), `the notes survive the uninstall (${path.join(dataDir, 'board.json')})`);
  } finally {
    await cleanupApp(app);
    // If a step failed half-way, do not leave an installed copy (and its registry entry and shortcuts) behind.
    const uninstaller = path.join(installDir, 'unins000.exe');
    if (fs.existsSync(uninstaller)) {
      await runToEnd(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { env: setupEnv, timeoutMs: 120_000 }).catch(() => {});
      await waitUntil(() => !fs.existsSync(installDir), 30_000, 500);
    }
    removeDir(work);
  }
}

async function main() {
  if (process.platform !== 'win32') fail('The Windows smoke tests run on Windows.');
  const args = parseArgs(process.argv.slice(2), { flags: ['desktop-shortcut', 'no-shortcuts'], options: ['only', 'dist'] });
  const wanted = parseOnly(args.only, TARGETS);
  const dist = path.resolve(args.dist || DIST_DIR);
  if (args['no-shortcuts'] && args['desktop-shortcut']) fail('--no-shortcuts and --desktop-shortcut contradict each other');
  console.log(`Stick Note ${VERSION}: smoke-testing ${[...wanted].join(' and ')} from ${dist}`);
  if (wanted.has('portable')) await smokePortable(dist);
  if (wanted.has('installer')) await smokeInstaller(dist, { desktopShortcut: Boolean(args['desktop-shortcut']), noShortcuts: Boolean(args['no-shortcuts']) });
  console.log('\nAll Windows smoke tests passed.');
}

runMain(main);
