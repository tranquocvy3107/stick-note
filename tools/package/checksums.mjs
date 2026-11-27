// Write dist/SHA256SUMS.txt: the SHA-256 of every release file in dist/.
//
//   node tools/package/checksums.mjs [--dist dist] [--require-all]
//
// The format is the one "sha256sum -c SHA256SUMS.txt" reads ("<hash>  <file name>"), so a user can run
// that command next to the downloaded files. With --require-all (the release job) all five packages
// must be present and nothing else may be in the folder, so a half-built or polluted release fails.

import fs from 'node:fs';
import path from 'node:path';
import { assetNames } from './names.mjs';
import { DIST_DIR, VERSION, fail, note, parseArgs, runMain, sha256File } from './lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['require-all'], options: ['dist'] });
  const dist = path.resolve(args.dist || DIST_DIR);
  if (!fs.existsSync(dist)) fail(`${dist} does not exist. Build the packages first.`);

  const { checksums, ...assets } = assetNames(VERSION);
  const present = Object.values(assets).filter((name) => fs.existsSync(path.join(dist, name))).sort();
  const missing = Object.values(assets).filter((name) => !present.includes(name));
  const unexpected = fs.readdirSync(dist).filter((name) => name !== checksums && !present.includes(name));

  if (present.length === 0) fail(`${dist} contains none of the release files for version ${VERSION}`);
  if (args['require-all']) {
    if (missing.length) fail(`These release files are missing from ${dist}: ${missing.join(', ')}`);
    if (unexpected.length) fail(`These files in ${dist} are not release files: ${unexpected.join(', ')}`);
  } else {
    for (const name of missing) note(`warning: ${name} is not in ${dist}`);
    for (const name of unexpected) note(`warning: ${name} is not a release file and is not listed`);
  }

  const lines = present.map((name) => `${sha256File(path.join(dist, name))}  ${name}`);
  fs.writeFileSync(path.join(dist, checksums), `${lines.join('\n')}\n`); // LF, as sha256sum expects
  console.log(`Wrote ${path.join(dist, checksums)}`);
  for (const line of lines) console.log(`  ${line}`);
}

runMain(main);
