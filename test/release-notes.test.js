// The release notes printed by tools/release-notes.mjs (the release workflow publishes them). Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/release-notes.mjs', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Runs the script for `version`; GITHUB_REPOSITORY is only set when the test says so.
function notes(env = {}, version = VERSION) {
  const base = { ...process.env };
  delete base.GITHUB_REPOSITORY;
  return spawnSync(process.execPath, [SCRIPT, version], { env: { ...base, ...env }, encoding: 'utf8' });
}

test('the notes for the current version hold its changelog section and the download guide', () => {
  const result = notes();
  assert.equal(result.status, 0, `package.json is at ${VERSION}: CHANGELOG.md needs a "## [${VERSION}]" section. ${result.stderr}`);
  assert.match(result.stdout, /## Which file do I download\?/);
  assert.match(result.stdout, /StickNote-.*-windows-x64-setup\.exe/);
  assert.match(result.stdout, /### Verify your download/);
});

test('the verify command and the README link name the repository the release is built in', () => {
  const result = notes({ GITHUB_REPOSITORY: 'someone/stick-note' });
  assert.match(result.stdout, /gh attestation verify <file> --repo someone\/stick-note/);
  assert.match(result.stdout, /https:\/\/github\.com\/someone\/stick-note#install/);
});

test('run outside GitHub Actions the notes fall back to the project home', () => {
  const result = notes();
  // Only the part the tool writes itself: the changelog text may explain how to check the older releases.
  const verify = result.stdout.split('### Verify your download')[1] || '';
  assert.match(verify, /gh attestation verify <file> --repo vytk712025main-eng\/stick-note/);
  assert.doesNotMatch(verify, /tranquocvy3107/, 'new releases are attested under the new repository');
});

test('a version that is not in the changelog is refused with a clear message', () => {
  const result = notes({}, '0.0.0');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no "## \[0\.0\.0\]" section/);
});
