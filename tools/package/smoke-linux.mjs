// Smoke tests for the Linux packages in dist/ (run this on Linux after build-linux.mjs;
// from Windows use: node tools/package/wsl.mjs smoke).
//
//   node tools/package/smoke-linux.mjs [--only deb,appimage,tarball] [--dist dist] [--fuse] [--require-lintian]
//
// deb       inspect it, run lintian, install it with dpkg, run it, re-install over a RUNNING copy
//           (the upgrade case), remove it while running; the notes must survive
// appimage  run it (without FUSE, so it works in containers and CI), stop it; with --fuse also
//           run it the normal way, mounted through FUSE
// tarball   extract, run ./stick-note (also through a symlink), stop it
//
// Installing the .deb needs root, so run this as root or as a user with passwordless sudo. It
// refuses to run when stick-note is already installed, so a real installation is never replaced.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetNames } from './names.mjs';
import { DIST_DIR, VERSION, capture, fail, note, parseArgs, parseOnly, runMain, step, trackTempDirs, which } from './lib.mjs';
import {
  appEnv, check, checkRuntimeIsOfficial, cleanupApp, findFreePort, makeTempDir, ping, removeDir, runToEnd, startApp,
  stopApp, verifyApp, watchServer,
} from './smoke-lib.mjs';

const TARGETS = ['deb', 'appimage', 'tarball'];
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Command line that runs `command` as root with some environment variables (dpkg passes them to prerm). */
function asRoot(command, args, env = {}) {
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const inner = ['env', ...pairs, command, ...args];
  return isRoot ? { command: inner[0], args: inner.slice(1) } : { command: 'sudo', args: ['-n', ...inner] };
}

async function runAsRoot(command, args, env, timeoutMs = 300_000) {
  const line = asRoot(command, args, { DEBIAN_FRONTEND: 'noninteractive', ...env });
  return runToEnd(line.command, line.args, { timeoutMs });
}

/** Parse "Field: value" lines of `dpkg-deb -f` (continuation lines start with a space). */
function parseFields(text) {
  const fields = {};
  let last = null;
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (match) { last = match[1]; fields[last] = match[2]; } else if (last && line.startsWith(' ')) fields[last] += `\n${line}`;
  }
  return fields;
}

const tool = (name) => which(name) || fail(`"${name}" is needed for this test but was not found`);

function inspectDeb(deb) {
  const dpkgDeb = tool('dpkg-deb');
  const fields = parseFields(capture(dpkgDeb, ['-f', deb]).stdout);
  check(fields.Package === 'stick-note' && fields.Architecture === 'amd64', 'package stick-note, architecture amd64');
  check(fields.Version === VERSION.replace('-', '~'), `version ${VERSION}`, `control says ${fields.Version}`);
  check(fields.Section === 'utils' && fields.Priority === 'optional', 'section utils, priority optional');
  check(/^Stick Note maintainers <[^<>\s]+@[^<>\s]+>$/.test(fields.Maintainer || ''), `maintainer is "${fields.Maintainer}"`);
  check(/^https:\/\/github\.com\/[^/]+\/stick-note$/.test(fields.Homepage || ''), `homepage is ${fields.Homepage}`);
  check(/chromium/.test(fields.Suggests || '') && /microsoft-edge-stable/.test(fields.Suggests || ''), 'a browser is only suggested');
  check(!/chrom|edge|brave/i.test(`${fields.Depends || ''}${fields.Recommends || ''}`), 'no browser is a hard or recommended dependency (apt must not pull one in)');
  check(Number(fields['Installed-Size']) > 1000, `Installed-Size is ${fields['Installed-Size']} KiB`);
  check(/^\S.*\n \S/.test(fields.Description || ''), 'there is a short and a long description');

  const lines = capture(dpkgDeb, ['-c', deb]).stdout.split('\n').filter(Boolean);
  const entries = lines.map((line) => {
    const m = /^(\S{10})\s+(\S+)\s+(\d+)\s+\S+\s+\S+\s+(\S+)(?: -> (.+))?$/.exec(line);
    return m ? { mode: m[1], owner: m[2], size: Number(m[3]), file: m[4].replace(/^\.\//, ''), link: m[5] } : fail(`Cannot read this line of dpkg-deb -c: ${line}`);
  });
  const byPath = new Map(entries.map((e) => [e.file, e]));
  check(entries.every((e) => e.owner === 'root/root'), 'every file belongs to root');
  check(entries.filter((e) => e.mode[0] === 'd').every((e) => e.mode === 'drwxr-xr-x'), 'every folder is mode 755');
  const executables = entries.filter((e) => e.mode[0] === '-' && e.mode.includes('x')).map((e) => e.file).sort();
  check(JSON.stringify(executables) === JSON.stringify(['opt/stick-note/runtime/node', 'usr/bin/stick-note']),
    'only the runtime and the /usr/bin launcher are executable', executables.join(', '));
  check(entries.filter((e) => e.mode[0] === '-' && !e.mode.includes('x')).every((e) => e.mode === '-rw-r--r--'), 'every other file is mode 644');
  const need = [
    'opt/stick-note/runtime/node', 'opt/stick-note/runtime/LICENSE-node.txt', 'opt/stick-note/app/server.js',
    'opt/stick-note/app/build-info.json', 'opt/stick-note/app/public/index.html', 'opt/stick-note/THIRD-PARTY-NOTICES.txt',
    'usr/bin/stick-note', 'usr/share/applications/stick-note.desktop', 'usr/share/doc/stick-note/copyright',
    'usr/share/doc/stick-note/changelog.gz', 'usr/share/man/man1/stick-note.1.gz', 'usr/share/icons/hicolor/scalable/apps/stick-note.svg',
    ...[16, 32, 48, 64, 256, 512].map((s) => `usr/share/icons/hicolor/${s}x${s}/apps/stick-note.png`),
  ];
  for (const file of need) check(byPath.has(file), `contains /${file}`);

  const info = capture(dpkgDeb, ['-I', deb]).stdout;
  check(/\*\s+prerm\s/.test(info), 'has an executable prerm script');
}

/** Lintian: errors fail the test; warnings are printed. Skipped (with a note) when lintian is not installed. */
function runLintian(deb, { required }) {
  const lintian = which('lintian');
  if (!lintian) {
    if (required) fail('lintian is not installed (apt install lintian) but --require-lintian was given');
    note('lintian is not installed, so it was skipped');
    return;
  }
  const result = capture(lintian, ['--tag-display-limit', '0', deb]);
  const tags = result.stdout.split('\n').filter((l) => /^[EWIPX]: /.test(l));
  const count = (letter) => tags.filter((l) => l.startsWith(`${letter}:`)).length;
  for (const line of tags.filter((l) => /^[EW]:/.test(l))) console.log(`   lintian ${line}`);
  check(count('E') === 0, `lintian reports no errors (warnings: ${count('W')}, informational: ${count('I')})`, result.stdout);
  check(count('W') === 0, 'lintian reports no warnings');
}

const installed = () => /Status: install ok installed/.test(capture('dpkg', ['-s', 'stick-note']).stdout);

async function smokeDeb(dist, { requireLintian }) {
  const file = assetNames(VERSION).linuxDeb;
  const deb = path.join(dist, file);
  if (!fs.existsSync(deb)) fail(`${deb} does not exist. Build it first: node tools/package/build-linux.mjs`);
  step(`Debian package: ${file}`);
  inspectDeb(deb);
  runLintian(deb, { required: requireLintian });
  if (installed()) fail('stick-note is already installed on this machine. This test installs and removes it, so remove it yourself first (sudo dpkg -r stick-note).');

  const work = makeTempDir('stick-note-smoke-deb-');
  const xdg = path.join(work, 'xdg');
  const dataDir = path.join(xdg, 'stick-note');
  const port = await findFreePort();
  const env = appEnv(port, { XDG_DATA_HOME: xdg });
  const stopCommand = { command: '/opt/stick-note/runtime/node', args: ['/opt/stick-note/app/server.js', '--stop'] };
  const start = (label) => startApp({ label, command: '/usr/bin/stick-note', env, port });

  let app = null;
  try {
    console.log('\n-- dpkg -i');
    let result = await runAsRoot('dpkg', ['-i', deb], { PORT: port });
    check(result.code === 0, 'dpkg -i installs the package', result.output);
    const status = capture('dpkg', ['-s', 'stick-note']).stdout;
    check(/Status: install ok installed/.test(status), 'dpkg reports it as installed');
    const listed = capture('dpkg', ['-L', 'stick-note']).stdout.split('\n');
    for (const p of ['/opt/stick-note/runtime/node', '/usr/bin/stick-note', '/usr/share/applications/stick-note.desktop']) check(listed.includes(p), `dpkg -L lists ${p}`);
    checkRuntimeIsOfficial('/opt/stick-note/runtime/node', 'linux-x64');
    const version = capture('/usr/bin/stick-note', ['--version'], { env: appEnv(port) });
    check(version.stdout.trim() === VERSION, `"stick-note --version" prints ${VERSION}`, version.stdout + version.stderr);
    const validate = which('desktop-file-validate');
    if (validate) {
      const v = capture(validate, ['/usr/share/applications/stick-note.desktop']);
      check(v.status === 0, 'desktop-file-validate accepts the menu entry', v.stdout + v.stderr);
      if (v.stdout.trim()) note(v.stdout.trim());
    }

    app = await start('/usr/bin/stick-note (what the menu entry runs)');
    await verifyApp(app, { version: VERSION, channel: 'linux-deb', dataDir });
    await stopApp(app, stopCommand);

    console.log('\n-- dpkg -i over a running copy (upgrade)');
    app = await start('/usr/bin/stick-note, left running during the upgrade');
    const watcher = watchServer(port);
    result = await runAsRoot('dpkg', ['-i', deb], { PORT: port });
    const wentDownAfter = await watcher.finish();
    check(result.code === 0, 'the upgrade over a running copy succeeds', result.output);
    check(wentDownAfter !== null && !(await ping(port)), `prerm stopped the running server (it went down ${wentDownAfter} ms after the upgrade began)`);
    await cleanupApp(app);
    app = await start('/usr/bin/stick-note after the upgrade');
    await verifyApp(app, { version: VERSION, channel: 'linux-deb', dataDir });
    await stopApp(app, stopCommand);

    console.log('\n-- dpkg -r while running');
    app = await start('/usr/bin/stick-note, left running during the removal');
    result = await runAsRoot('dpkg', ['-r', 'stick-note'], { PORT: port });
    check(result.code === 0, 'dpkg -r removes the package', result.output);
    check(!(await ping(port)), 'prerm stopped the running server');
    await cleanupApp(app);
    app = null;
    check(!installed(), 'dpkg no longer lists the package');
    check(!fs.existsSync('/opt/stick-note') && !fs.existsSync('/usr/bin/stick-note') && !fs.existsSync('/usr/share/applications/stick-note.desktop'),
      '/opt/stick-note, /usr/bin/stick-note and the menu entry are gone');
    check(fs.existsSync(path.join(dataDir, 'board.json')), `the notes survive the removal (${path.join(dataDir, 'board.json')})`);
  } finally {
    await cleanupApp(app);
    if (installed()) await runAsRoot('dpkg', ['-P', 'stick-note'], { PORT: port }).catch(() => {});
    removeDir(work);
  }
}

// ---- AppImage --------------------------------------------------------------------

async function smokeAppImage(dist, { fuse }) {
  const file = assetNames(VERSION).linuxAppImage;
  const image = path.join(dist, file);
  if (!fs.existsSync(image)) fail(`${image} does not exist. Build it first: node tools/package/build-linux.mjs`);
  step(`AppImage: ${file}`);

  const head = fs.readFileSync(image).subarray(0, 11);
  check(head.toString('latin1', 1, 4) === 'ELF' && head[8] === 0x41 && head[9] === 0x49 && head[10] === 0x02, 'it is an ELF program with the AppImage type 2 marker');

  const work = makeTempDir('stick-note-smoke-appimage-');
  const cleanUnpacked = trackTempDirs('appimage_extracted_'); // the AppImage unpacks itself into /tmp when run without FUSE
  // Run from a copy: dist/ may sit on a Windows drive (WSL) where the executable bit is not reliable.
  const copy = path.join(work, file);
  fs.copyFileSync(image, copy);
  fs.chmodSync(copy, 0o755);
  try {
    // Unpack it without running or mounting it, and look at what is inside.
    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    const extract = await runToEnd(copy, ['--appimage-extract'], { cwd: unpacked, timeoutMs: 120_000 });
    check(extract.code === 0, '--appimage-extract unpacks it', extract.output);
    const root = path.join(unpacked, 'squashfs-root');
    const inside = path.join(root, 'usr', 'lib', 'stick-note');
    for (const rel of ['AppRun', 'stick-note.desktop', 'stick-note.png', '.DirIcon', 'usr/lib/stick-note/runtime/node', 'usr/lib/stick-note/app/server.js']) {
      check(fs.existsSync(path.join(root, ...rel.split('/'))), `it contains ${rel}`);
    }
    check(fs.statSync(path.join(root, 'AppRun')).mode & 0o111, 'AppRun is executable');
    const appRun = fs.readFileSync(path.join(root, 'AppRun'), 'utf8');
    check(/server\.js" --run "\$@"/.test(appRun), 'AppRun starts the server in the foreground (--run)');
    checkRuntimeIsOfficial(path.join(inside, 'runtime', 'node'), 'linux-x64');
    const build = JSON.parse(fs.readFileSync(path.join(inside, 'app', 'build-info.json'), 'utf8'));
    check(build.channel === 'linux-appimage' && build.dataDir === 'user' && build.version === VERSION, 'build-info.json says linux-appimage, dataDir user', JSON.stringify(build));

    const run = async (label, extraEnv) => {
      const xdg = path.join(work, `xdg-${Math.random().toString(36).slice(2, 8)}`);
      const port = await findFreePort();
      const env = appEnv(port, { XDG_DATA_HOME: xdg, ...extraEnv });
      let app = null;
      try {
        // Foreground mode: the AppImage must keep running (it unmounts when AppRun exits).
        app = await startApp({ label, command: copy, env, port, mode: 'run' });
        await verifyApp(app, { version: VERSION, channel: 'linux-appimage', dataDir: path.join(xdg, 'stick-note') });
        await stopApp(app, { command: copy, args: ['--stop'] });
        app = null;
      } finally {
        await cleanupApp(app);
      }
    };
    // APPIMAGE_EXTRACT_AND_RUN: no FUSE needed, so this also works in containers and CI.
    await run('the AppImage, unpacked on the fly (APPIMAGE_EXTRACT_AND_RUN=1)', { APPIMAGE_EXTRACT_AND_RUN: '1' });
    const fuseWorks = fs.existsSync('/dev/fuse') && Boolean(which('fusermount3') || which('fusermount'));
    if (fuse && fuseWorks) await run('the AppImage, mounted through FUSE (how a person runs it)', { APPIMAGE_EXTRACT_AND_RUN: undefined });
    else note(fuse ? '--fuse was given but this machine has no FUSE, so the normal mounted start was skipped' : 'the normal FUSE-mounted start was not tested (use --fuse on a machine that has FUSE)');
  } finally {
    cleanUnpacked();
    removeDir(work);
  }
}

// ---- tarball ---------------------------------------------------------------------

async function smokeTarball(dist) {
  const file = assetNames(VERSION).linuxTarball;
  const archive = path.join(dist, file);
  if (!fs.existsSync(archive)) fail(`${archive} does not exist. Build it first: node tools/package/build-linux.mjs`);
  step(`tar.gz: ${file}`);

  const work = makeTempDir('stick-note-smoke-tar-');
  try {
    const extracted = path.join(work, 'Stick Note extracted');
    fs.mkdirSync(extracted);
    const result = capture(tool('tar'), ['-xzf', archive, '-C', extracted]);
    check(result.status === 0, 'tar extracts it', result.stderr);
    const top = `stick-note-${VERSION}-linux-x64`;
    check(JSON.stringify(fs.readdirSync(extracted)) === JSON.stringify([top]), `it has the single top-level folder ${top}/`, fs.readdirSync(extracted).join(', '));
    const root = path.join(extracted, top);
    for (const rel of ['stick-note', 'README.txt', 'THIRD-PARTY-NOTICES.txt', 'runtime/node', 'runtime/LICENSE-node.txt', 'app/server.js', 'app/build-info.json', 'app/package.json', 'app/LICENSE']) {
      check(fs.existsSync(path.join(root, ...rel.split('/'))), `it contains ${rel}`);
    }
    check((fs.statSync(path.join(root, 'stick-note')).mode & 0o111) !== 0 && (fs.statSync(path.join(root, 'runtime', 'node')).mode & 0o111) !== 0, 'stick-note and runtime/node are executable');
    checkRuntimeIsOfficial(path.join(root, 'runtime', 'node'), 'linux-x64');
    const build = JSON.parse(fs.readFileSync(path.join(root, 'app', 'build-info.json'), 'utf8'));
    check(build.channel === 'linux-tarball' && build.dataDir === '../data' && build.version === VERSION, 'build-info.json says linux-tarball, dataDir ../data', JSON.stringify(build));

    // Notes must end up next to the program, so the folder can be moved or copied as a whole.
    const dataDir = path.join(root, 'data');
    const port = await findFreePort();
    const env = appEnv(port, { XDG_DATA_HOME: path.join(work, 'must-stay-unused') });
    const stopCommand = { command: path.join(root, 'runtime', 'node'), args: [path.join(root, 'app', 'server.js'), '--stop'] };
    const link = path.join(work, 'link-to-stick-note');
    fs.symlinkSync(path.join(root, 'stick-note'), link);

    for (const [label, command] of [['./stick-note', path.join(root, 'stick-note')], ['a symlink to stick-note', link]]) {
      let app = null;
      try {
        app = await startApp({ label, command, cwd: work, env, port });
        await verifyApp(app, { version: VERSION, channel: 'linux-tarball', dataDir });
        await stopApp(app, stopCommand);
        app = null;
      } finally {
        await cleanupApp(app);
      }
    }
    check(!fs.existsSync(path.join(work, 'must-stay-unused')), 'nothing was written to the per-user data folder');
  } finally {
    removeDir(work);
  }
}

async function main() {
  if (process.platform !== 'linux') fail('The Linux smoke tests run on Linux. From Windows use: node tools/package/wsl.mjs smoke');
  const args = parseArgs(process.argv.slice(2), { flags: ['fuse', 'require-lintian'], options: ['only', 'dist'] });
  const wanted = parseOnly(args.only, TARGETS);
  const dist = path.resolve(args.dist || DIST_DIR);
  console.log(`Stick Note ${VERSION}: smoke-testing ${[...wanted].join(', ')} from ${dist} (as ${isRoot ? 'root' : os.userInfo().username})`);
  if (wanted.has('tarball')) await smokeTarball(dist);
  if (wanted.has('appimage')) await smokeAppImage(dist, { fuse: Boolean(args.fuse) });
  if (wanted.has('deb')) await smokeDeb(dist, { requireLintian: Boolean(args['require-lintian']) });
  console.log('\nAll Linux smoke tests passed.');
}

runMain(main);
