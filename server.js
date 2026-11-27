#!/usr/bin/env node
// Stick Note: local server and launcher (no third-party dependencies).
//
// - Serves the web interface from ./public
// - Stores your data (board.json, images, backups) in the data folder (see src/paths.js)
// - Listens on 127.0.0.1 only and rejects foreign requests (Host, Origin and a custom header are checked)
//
// Usage:
//   node server.js            run the server in the foreground and print its log
//   node server.js --open     start a background server if needed, then open the app window
//   node server.js --run      run in the foreground and open the app window (used by the AppImage)
//   node server.js --bg       background mode: quit by itself when no window is open
//   node server.js --stop     ask a running server to quit
//   node server.js --version  print the version
//   node server.js --data-dir print the folder where your notes are stored

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { openWindow, probe, startBackground, stopRunning } from './src/launcher.js';
import { APP_ID, DEFAULT_PORT, VERSION, resolveDataDir } from './src/paths.js';
import { sniffImage } from './src/util.js';

export { createApp, sniffImage, APP_ID, VERSION, DEFAULT_PORT };

const SCRIPT = fileURLToPath(import.meta.url);
const IDLE_EXIT_MS = Number(process.env.STICK_NOTE_IDLE_MS) || 300_000; // quit this long after the last window closed

async function main() {
  const args = new Set(process.argv.slice(2));
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const dataDir = resolveDataDir();
  const url = `http://127.0.0.1:${port}/`;

  if (args.has('--version') || args.has('-v')) return console.log(VERSION);
  if (args.has('--data-dir')) return console.log(dataDir);
  if (args.has('--help') || args.has('-h')) {
    return console.log(`Stick Note ${VERSION}\n\nUsage: node server.js [--open | --run | --bg | --stop | --version | --data-dir]\nSee the header of server.js for details.`);
  }

  const running = await probe(port);

  if (args.has('--stop')) {
    if (!running) return console.log('Stick Note is not running.');
    const stopped = await stopRunning(port);
    console.log(stopped ? 'Stick Note stopped.' : 'Stick Note did not stop in time.');
    process.exitCode = stopped ? 0 : 1;
    return;
  }

  if (args.has('--open')) {
    if (!running && !(await startBackground(SCRIPT, port))) {
      console.error(`Could not start Stick Note on port ${port}.`);
      console.error('Run "node server.js" to see the detailed error.');
      process.exit(1);
    }
    openWindow(url);
    return;
  }

  if (running) {
    console.log(`Stick Note is already running at ${url}`);
    if (args.has('--run')) openWindow(url);
    return;
  }

  const background = args.has('--bg');
  const app = createApp({
    port,
    dataDir,
    idleExitMs: background || args.has('--run') ? IDLE_EXIT_MS : 0,
    logToConsole: !background,
    onShutdown: () => app.stop().then(() => process.exit(0)),
  });
  process.on('uncaughtException', (err) => { app.log('uncaughtException', err && err.stack ? err.stack : err); });
  process.on('unhandledRejection', (err) => { app.log('unhandledRejection', err && err.stack ? err.stack : err); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.stop().then(() => process.exit(0)));
  try {
    await app.listen();
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      if (await probe(port)) return; // another copy just finished starting; use that one
      console.error(`Port ${port} is used by another program. Choose another port, for example: PORT=4848`);
    } else {
      console.error('Could not start the server:', err);
    }
    process.exit(1);
  }
  if (args.has('--run')) openWindow(url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  main();
}
