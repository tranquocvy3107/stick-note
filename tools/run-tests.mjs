// Runs every test of the project (this is what "npm test" does):
//
//   1. cargo build      the program the contract tests start
//   2. cargo test       the unit tests of the Rust code
//   3. node --test      the JavaScript tests: the web interface, the packaging scripts and the contract tests, which
//                       start the program built in step 1 and talk to it over HTTP
//
// All three always run, so one failure does not hide another. A program built elsewhere can be tested by setting
// STICK_NOTE_BIN to its path: step 1 is then skipped. (Only the JavaScript tests that need no program: npm run test:js.)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, fail, runMain } from './package/lib.mjs';
import { findCargo } from './package/rust.mjs';

function step(title, command, args, env = {}) {
  console.log(`\n=== ${title}\n$ ${[path.basename(command), ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) fail(`Could not start ${command}: ${result.error.message}`);
  return result.status === 0;
}

async function main() {
  const cargo = findCargo();
  const results = [];
  let bin = process.env.STICK_NOTE_BIN;
  if (!bin) {
    results.push(['cargo build', step('Build the program', cargo, ['build', '--locked', '--package', 'stick-note'])]);
    bin = path.join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'stick-note.exe' : 'stick-note');
  }
  results.push(['cargo test', step('Rust unit tests', cargo, ['test', '--locked'])]);
  if (!fs.existsSync(bin)) fail(`There is no program to run the contract tests against: ${bin} does not exist (did the build fail?).`);
  results.push(['node --test', step(`JavaScript tests (the contract tests run ${bin})`, process.execPath, ['--test'], { STICK_NOTE_BIN: bin })]);

  console.log('\n=== Summary');
  for (const [name, ok] of results) console.log(`${ok ? 'passed' : 'FAILED'}  ${name}`);
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

runMain(main);
