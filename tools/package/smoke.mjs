// Run the smoke tests that fit the operating system this is started on:
//   Windows -> smoke-windows.mjs (portable zip and installer)
//   Linux   -> smoke-linux.mjs   (.deb, AppImage and tar.gz)
// All options are passed on, for example:  npm run package:smoke -- --only portable

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, run, runMain } from './lib.mjs';

async function main() {
  const script = { win32: 'smoke-windows.mjs', linux: 'smoke-linux.mjs' }[process.platform]
    ?? fail(`There are no packages to smoke-test on ${process.platform}`);
  run(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), script), ...process.argv.slice(2)]);
}

runMain(main);
