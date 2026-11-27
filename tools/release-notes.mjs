// Print the release notes for one version: its section of CHANGELOG.md plus a short download guide.
// Usage:  node tools/release-notes.mjs 1.1.0 > notes.md   (the release workflow calls this)

import fs from 'node:fs';
import { assetNames } from './package/names.mjs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node tools/release-notes.mjs <version>, for example 1.1.0');
  process.exit(1);
}

const lines = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Add it before releasing.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (l.startsWith('## [') || /^\[[^\]]+\]:\s/.test(l)));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();

const n = assetNames(version);
console.log(`${body}

## Which file do I download?

| You use | Download |
|---|---|
| **Windows 10 / 11** | \`${n.windowsInstaller}\`: double-click it and follow the steps |
| **Ubuntu, Debian, Linux Mint** | \`${n.linuxDeb}\`: double-click it, then click Install |
| **Any other Linux** | \`${n.linuxAppImage}\`: make it executable, then double-click it |
| Windows without installing | \`${n.windowsPortable}\`: unzip anywhere and run \`Stick Note.exe\` |
| Linux without installing | \`${n.linuxTarball}\`: extract anywhere and run \`stick-note\` |

Node.js is **not** needed: it is included. Step-by-step help is in the [README](https://github.com/vytk712025main-eng/stick-note#install).

**Windows may say "Windows protected your PC"** because this app is new and not code-signed yet. Click **More info**, then **Run anyway**. You can check the download first with \`${n.checksums}\`.

### Verify your download (optional)

\`${n.checksums}\` lists the SHA-256 of every file here. Every file also has a signed build attestation, so you can prove it was built by this repository's workflow: \`gh attestation verify <file> --repo tranquocvy3107/stick-note\`.`);
