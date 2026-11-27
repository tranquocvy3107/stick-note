# Security policy

Stick Note keeps personal notes, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead:

1. Open the [Security tab](https://github.com/tranquocvy3107/stick-note/security) of this repository.
2. Click **Report a vulnerability** and describe the problem: what you did, what happened, and which version and operating system.

You will get a first answer within about a week. This is a volunteer project, so fixes take the time they take, but we will keep you informed and credit you in the release notes if you wish.

## Supported versions

Only the **latest release** receives security fixes. Please update before reporting.

## What Stick Note does today

- The server listens on `127.0.0.1` only, never on the network.
- Every request is checked: the `Host` header (against DNS rebinding), the `Origin`, and a custom `X-Stick-Note` header on every write (so another website cannot write to your notes from your browser).
- A strict Content Security Policy blocks inline scripts; text from notes is never inserted as HTML.
- Images are identified by their content (magic bytes), stored under a hash of their content, and served only by exact id (no path traversal).
- Files are written safely (temporary file, flush, rename); a damaged board is recovered from the daily backup.
- The packages are built by a public workflow from a tagged commit, listed in `SHA256SUMS.txt`, and carry signed build attestations.

## Known limitations

- **Notes are stored unencrypted** in the data folder. Anyone who can read your user files can read your notes. Use full-disk encryption (BitLocker, LUKS) if that matters to you. Encrypted storage is planned.
- **Other programs running as you** can talk to the local server on `127.0.0.1` and read your notes. Stick Note is not designed to resist malware that already runs under your account. A per-session access token is planned.
- The Windows installer and executables are not code-signed yet, so Windows SmartScreen shows a warning on first run. Verify the download with `SHA256SUMS.txt` or `gh attestation verify`.

## Scope

In scope: the server (`server.js`, `src/`), the interface (`public/`), the installers and the release workflows. Out of scope: vulnerabilities in the browser you use to display the app, in Node.js itself (report those upstream, we will update the bundled runtime), or attacks that need physical access to an unlocked computer.
