// Contract tests: the HTTP API, security, storage, backups and recovery of a running server.
//
// They start a real server process (see harness.mjs), so the same file proves that the Node.js server and the
// Rust program behave identically. Run with: npm test   (Rust: STICK_NOTE_BIN=<program> node --test test/contract)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ID, PNG, WRITE, boot, note, rawRequest, removeDir, tempDir, today, zone, PACKAGE } from './harness.mjs';

test('ping identifies the server as Stick Note', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/ping`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.app, APP_ID);
    assert.equal(body.version, PACKAGE.version);
    assert.equal(typeof body.t, 'number');
    assert.match(res.headers.get('content-type'), /^application\/json; charset=utf-8$/i);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  } finally { await s.close(); }
});

test('an empty board is saved and read back with non-ASCII text intact', async () => {
  const s = await boot();
  try {
    const empty = await s.get();
    assert.equal(empty.rev, 0);
    assert.equal(empty.savedAt, null);
    assert.deepEqual(empty.board, { notes: [], trash: [], zones: [], zonesTrash: [] });

    // Vietnamese sample: diacritics and a percent-free URL must survive the round trip byte for byte.
    const text = 'Họp thứ Hai 10h — https://example.com/Việt_Nam?q=đ&x=1';
    const res = await s.put(0, { notes: [note('n1', { t: text })], trash: [] });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.rev, 1);
    assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'savedAt is an ISO time in UTC');

    const after = await s.get();
    assert.equal(after.rev, 1);
    assert.equal(after.savedAt, saved.savedAt);
    assert.equal(after.board.notes[0].t, text);

    const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'board.json'), 'utf8'));
    assert.equal(onDisk.app, APP_ID);
    assert.equal(onDisk.schema, 1);
    assert.equal(onDisk.rev, 1);
    assert.equal(onDisk.notes[0].t, text);
    assert.equal(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files are left behind');
  } finally { await s.close(); }
});

test('a note comes back exactly as it was sent, with its keys in the same order', async () => {
  const s = await boot();
  try {
    const sent = { id: 'k1', k: 'text', x: 10.5, y: -20, w: 220, c: 'yellow', r: -1.25, z: 3, t: 'a\nb\t"q" \\ / <>', ts: 1700000000000, mt: 1700000000123 };
    assert.equal((await s.put(0, { notes: [sent], trash: [] })).status, 200);
    const got = await s.get();
    assert.equal(JSON.stringify(got.board.notes[0]), JSON.stringify(sent));
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(s.dir, 'board.json'), 'utf8')).notes[0]), JSON.stringify(sent));
  } finally { await s.close(); }
});

test('writes need the custom header and a valid Origin', async () => {
  const s = await boot();
  try {
    const board = { notes: [note('n1')], trash: [] };
    const noHeader = await s.put(0, board, {});
    assert.equal(noHeader.status, 403, 'missing header');
    assert.equal((await noHeader.json()).error, 'missing_header');
    const wrongValue = await s.put(0, board, { 'X-Stick-Note': '0' });
    assert.equal(wrongValue.status, 403, 'the header must say 1');
    const evil = await s.put(0, board, { ...WRITE, Origin: 'https://evil.example' });
    assert.equal(evil.status, 403, 'foreign Origin');
    assert.equal((await evil.json()).error, 'bad_origin');
    const nullOrigin = await s.put(0, board, { ...WRITE, Origin: 'null' });
    assert.equal(nullOrigin.status, 403, 'a sandboxed page sends Origin: null');
    assert.equal((await s.put(0, board, { ...WRITE, Origin: s.base })).status, 200, "the app's own Origin");
    assert.equal((await s.get()).rev, 1);
  } finally { await s.close(); }
});

test('foreign Host headers are rejected (DNS rebinding protection)', async () => {
  const s = await boot();
  try {
    const bad = await rawRequest(s.port, { url: '/api/board', headers: { Host: 'evil.example' } });
    assert.equal(bad.status, 403);
    const badPort = await rawRequest(s.port, { url: '/api/ping', headers: { Host: '127.0.0.1:1' } });
    assert.equal(badPort.status, 403);
    const noPort = await rawRequest(s.port, { url: '/api/ping', headers: { Host: '127.0.0.1' } });
    assert.equal(noPort.status, 403);
    for (const host of [`localhost:${s.port}`, `LOCALHOST:${s.port}`, `127.0.0.1:${s.port}`, `[::1]:${s.port}`]) {
      const ok = await rawRequest(s.port, { url: '/api/ping', headers: { Host: host } });
      assert.equal(ok.status, 200, host);
    }
  } finally { await s.close(); }
});

test('a stale baseRev gets 409 with the current board so the client can merge', async () => {
  const s = await boot();
  try {
    await s.put(0, { notes: [note('a')], trash: [] });
    const stale = await s.put(0, { notes: [note('b')], trash: [] });
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.error, 'conflict');
    assert.equal(body.rev, 1);
    assert.deepEqual(body.board.notes.map((n) => n.id), ['a']);
    assert.deepEqual((await s.get()).board.notes.map((n) => n.id), ['a'], 'a stale copy cannot overwrite newer data');

    const noRev = await fetch(`${s.base}/api/board`, { method: 'PUT', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ board: { notes: [], trash: [] } }) });
    assert.equal(noRev.status, 409, 'a missing baseRev is a stale one');
  } finally { await s.close(); }
});

test('malformed board data is rejected', async () => {
  const s = await boot();
  try {
    assert.equal((await s.put(0, { notes: 'x', trash: [] })).status, 400);
    assert.equal((await s.put(0, { notes: [{ nope: 1 }], trash: [] })).status, 400);
    assert.equal((await s.put(0, { notes: [{ id: '' }], trash: [] })).status, 400, 'an empty id');
    assert.equal((await s.put(0, { notes: [{ id: 'x'.repeat(65) }], trash: [] })).status, 400, 'an id longer than 64');
    assert.equal((await s.put(0, { notes: [{ id: 'x'.repeat(64) }], trash: [] })).status, 200, 'an id of exactly 64');
    assert.equal((await s.put(1, { notes: [], trash: 'x' })).status, 400);
    assert.equal((await s.put(1, null)).status, 400);
    const raw = await fetch(`${s.base}/api/board`, { method: 'PUT', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error, 'invalid_json');
    assert.equal((await s.get()).rev, 1, 'only the one valid save went through');
  } finally { await s.close(); }
});

test('a missing trash list means an empty one', async () => {
  const s = await boot();
  try {
    assert.equal((await s.put(0, { notes: [note('a')] })).status, 200);
    assert.deepEqual((await s.get()).board.trash, []);
  } finally { await s.close(); }
});

test('a daily backup holds the state before the overwrite', async () => {
  const s = await boot();
  try {
    await s.put(0, { notes: [note('first')], trash: [] });
    const backups = path.join(s.dir, 'backups');
    assert.equal(fs.readdirSync(backups).length, 0, 'the first save has nothing to back up');
    await s.put(1, { notes: [note('first'), note('second')], trash: [] });
    const file = path.join(backups, `board-${today()}.json`);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.id), ['first']);
    await s.put(2, { notes: [note('first'), note('second'), note('third')], trash: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.id), ['first'], "a day's backup is never overwritten");
  } finally { await s.close(); }
});

test('a sharp drop in the number of notes keeps an extra backup', async () => {
  const s = await boot();
  try {
    const many = Array.from({ length: 10 }, (_, i) => note(`n${i}`));
    await s.put(0, { notes: many, trash: [] });
    await s.put(1, { notes: many.slice(0, 2), trash: [] });
    const shrink = fs.readdirSync(path.join(s.dir, 'backups')).filter((f) => f.includes('before-shrink'));
    assert.equal(shrink.length, 1);
    assert.match(shrink[0], /^board-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-before-shrink\.json$/);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'backups', shrink[0]), 'utf8'));
    assert.equal(saved.notes.length, 10, 'the backup holds all 10 notes from before the drop');
  } finally { await s.close(); }
});

test('a small board that shrinks does not trigger the extra backup', async () => {
  const s = await boot();
  try {
    const few = Array.from({ length: 7 }, (_, i) => note(`n${i}`));
    await s.put(0, { notes: few, trash: [] });
    await s.put(1, { notes: few.slice(0, 1), trash: [] });
    assert.equal(fs.readdirSync(path.join(s.dir, 'backups')).filter((f) => f.includes('before-shrink')).length, 0, 'under 8 notes: no alarm');
  } finally { await s.close(); }
});

test('old backups are pruned: 60 daily copies and 30 special ones are kept', async () => {
  const dir = tempDir();
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  // 70 daily copies (ten days in each of seven months of 2025) and 35 special ones.
  const dailies = [];
  for (let m = 1; m <= 7; m++) for (let d = 1; d <= 10; d++) dailies.push(`2025-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  for (const name of dailies) fs.writeFileSync(path.join(backups, `board-${name}.json`), '{}');
  const specials = Array.from({ length: 35 }, (_, i) => `board-2025-02-${String((i % 28) + 1).padStart(2, '0')}_10-00-${String(i).padStart(2, '0')}-manual.json`);
  for (const name of specials) fs.writeFileSync(path.join(backups, name), '{}');
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ app: APP_ID, schema: 1, rev: 1, savedAt: null, notes: [note('a')], trash: [] }));
  const s = await boot({ dir });
  try {
    assert.equal((await s.put(1, { notes: [note('a'), note('b')], trash: [] })).status, 200);
    const names = fs.readdirSync(backups);
    const daily = names.filter((f) => /^board-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    const special = names.filter((f) => /-(before-shrink|manual)\.json$/.test(f)).sort();
    assert.equal(daily.length, 60, `daily copies: ${daily.length}`);
    assert.equal(special.length, 30, `special copies: ${special.length}`);
    assert.ok(daily.includes(`board-${today()}.json`), "today's copy survives");
    assert.ok(!daily.includes('board-2025-01-01.json'), 'the oldest daily copy is gone');
    assert.ok(!special.includes(specials.slice().sort()[0]), 'the oldest special copy is gone');
  } finally { await s.close(); }
});

test('a damaged board.json is recovered from the newest backup', async () => {
  const s = await boot();
  await s.put(0, { notes: [note('keep-me')], trash: [] });
  await s.put(1, { notes: [note('keep-me'), note('lost')], trash: [] });
  await s.close({ keep: true });
  try {
    fs.writeFileSync(path.join(s.dir, 'board.json'), '{"notes": [ trunc');
    const s2 = await boot({ dir: s.dir });
    try {
      const board = await s2.get();
      assert.deepEqual(board.board.notes.map((n) => n.id), ['keep-me']);
      assert.equal(board.rev, 2, "the restored board's revision is the backup's (1) plus one");
      assert.ok(fs.readdirSync(s.dir).some((f) => /^board\.corrupt-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(f)), 'the damaged file is kept for inspection');
    } finally { await s2.close({ keep: true }); }
  } finally { removeDir(s.dir); }
});

test('a board.json that is valid JSON but not a board counts as damaged; with no backup the board starts empty', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ notes: 5 }));
  const s = await boot({ dir });
  try {
    const got = await s.get();
    assert.equal(got.rev, 0);
    assert.deepEqual(got.board, { notes: [], trash: [], zones: [], zonesTrash: [] });
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('board.corrupt-')));
  } finally { await s.close(); }
});

test('a restarted server remembers the data and the revision number', async () => {
  const s = await boot();
  const saved = await (await s.put(0, { notes: [note('persisted')], trash: [note('gone', { del: 5 })] })).json();
  await s.close({ keep: true });
  try {
    const s2 = await boot({ dir: s.dir });
    try {
      const board = await s2.get();
      assert.equal(board.rev, 1);
      assert.equal(board.savedAt, saved.savedAt);
      assert.deepEqual(board.board.notes.map((n) => n.id), ['persisted']);
      assert.deepEqual(board.board.trash.map((n) => n.id), ['gone']);
    } finally { await s2.close({ keep: true }); }
  } finally { removeDir(s.dir); }
});

test('the revision endpoint and the info endpoint describe the server', async () => {
  const s = await boot();
  try {
    await s.put(0, { notes: [note('a'), note('b')], trash: [note('c', { del: 1 })], zones: [zone('z')] });
    assert.deepEqual(await (await fetch(`${s.base}/api/rev`)).json(), { rev: 1 });
    const info = await s.info();
    assert.equal(info.app, APP_ID);
    assert.equal(info.version, PACKAGE.version);
    assert.equal(info.channel, 'source');
    assert.equal(info.platform, process.platform);
    assert.equal(info.dataDir, path.resolve(s.dir));
    assert.equal(info.port, s.port);
    assert.equal(info.rev, 1);
    assert.equal(info.notes, 2);
    assert.equal(info.trash, 1);
    assert.equal(info.zones, 1);
    assert.equal(info.windows, 0);
    assert.ok(Array.isArray(info.backups));
    assert.equal(typeof info.uptimeSec, 'number');
    assert.ok(info.uptimeSec >= 0 && info.uptimeSec < 60);
  } finally { await s.close(); }
});

test('/api/info reports how this copy was packaged', async () => {
  const source = await boot();
  const packaged = await boot({ buildInfo: { channel: 'linux-deb' } });
  try {
    assert.equal((await source.info()).channel, 'source');
    assert.equal((await packaged.info()).channel, 'linux-deb');
  } finally { await source.close(); await packaged.close(); }
});

test('a manual backup copies the board and the info endpoint lists the newest backups first', async () => {
  const s = await boot();
  try {
    assert.deepEqual(await (await fetch(`${s.base}/api/backup`, { method: 'POST', headers: WRITE })).json(), { file: null }, 'nothing to back up yet');
    await s.put(0, { notes: [note('a')], trash: [] });
    const res = await fetch(`${s.base}/api/backup`, { method: 'POST', headers: WRITE });
    assert.equal(res.status, 200);
    const { file } = await res.json();
    assert.match(file, /^board-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-manual\.json$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'backups', file), 'utf8')).notes.map((n) => n.id), ['a']);
    assert.equal((await s.info()).backups[0], file);
    assert.equal((await fetch(`${s.base}/api/backup`, { method: 'POST' })).status, 403, 'needs the custom header');
  } finally { await s.close(); }
});

test('the server writes a log with its start-up line', async () => {
  const s = await boot();
  try {
    const log = fs.readFileSync(path.join(s.dir, 'server.log'), 'utf8');
    assert.match(log, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Stick Note \S+ is running at http:\/\/127\.0\.0\.1:\d+\/ \(data: /m);
  } finally { await s.close(); }
});

test('a data folder with spaces and non-ASCII letters works', async () => {
  const parent = tempDir();
  const dir = path.join(parent, 'Dữ liệu — Stick Note');
  const s = await boot({ dir });
  try {
    assert.equal((await s.put(0, { notes: [note('a', { t: 'Tiếng Việt' })], trash: [] })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8')).notes[0].t, 'Tiếng Việt');
    assert.equal((await s.info()).dataDir, path.resolve(dir));
  } finally { await s.close(); removeDir(parent); }
});

// ---------------------------------------------------------------- zones

test('zones are saved, read back and survive a restart, with non-ASCII labels intact', async () => {
  const s = await boot();
  const label = 'Hóa đơn — quan trọng';
  await s.put(0, {
    notes: [note('n1')], trash: [],
    zones: [zone('z1', { t: label, k: 'important', p: 1 })],
    zonesTrash: [zone('z0', { del: 5 })],
  });
  await s.close({ keep: true });
  try {
    const s2 = await boot({ dir: s.dir });
    try {
      const got = await s2.get();
      assert.deepEqual(got.board.zones.map((z) => z.id), ['z1']);
      assert.equal(got.board.zones[0].t, label);
      assert.equal(got.board.zones[0].p, 1);
      assert.deepEqual(got.board.zonesTrash.map((z) => z.id), ['z0']);
      const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'board.json'), 'utf8'));
      assert.equal(onDisk.zones.length, 1);
      assert.equal(onDisk.schema, 1, 'zones are an additive field: the schema number stays the same');
      assert.equal((await s2.info()).zones, 1);
    } finally { await s2.close({ keep: true }); }
  } finally { removeDir(s.dir); }
});

test('a save from a client that does not know zones keeps the zones on disk; an empty list clears them', async () => {
  const s = await boot();
  try {
    await s.put(0, { notes: [note('a')], trash: [], zones: [zone('z1')], zonesTrash: [zone('z2', { del: 3 })] });
    // A window still running the interface of version 1.1 leaves the zone fields out altogether.
    assert.equal((await s.put(1, { notes: [note('a'), note('b')], trash: [] })).status, 200);
    let got = await s.get();
    assert.deepEqual(got.board.notes.map((n) => n.id), ['a', 'b']);
    assert.deepEqual(got.board.zones.map((z) => z.id), ['z1'], 'the zones are untouched');
    assert.deepEqual(got.board.zonesTrash.map((z) => z.id), ['z2']);
    // An explicit empty list is a real change, not an omission.
    assert.equal((await s.put(2, { notes: [note('a')], trash: [], zones: [], zonesTrash: [] })).status, 200);
    got = await s.get();
    assert.deepEqual(got.board.zones, []);
    assert.deepEqual(got.board.zonesTrash, []);
  } finally { await s.close(); }
});

test('a board file written by version 1.1 (no zones) opens, and the first save adds the zone lists', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ app: APP_ID, schema: 1, rev: 4, savedAt: null, notes: [note('old')], trash: [] }));
  const s = await boot({ dir });
  try {
    const got = await s.get();
    assert.equal(got.rev, 4);
    assert.deepEqual(got.board.notes.map((n) => n.id), ['old']);
    assert.deepEqual(got.board.zones, []);
    assert.deepEqual(got.board.zonesTrash, []);
    assert.equal((await s.put(4, { notes: [note('old')], trash: [], zones: [zone('z')], zonesTrash: [] })).status, 200);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'));
    assert.deepEqual(onDisk.zones.map((z) => z.id), ['z']);
  } finally { await s.close(); }
});

test('malformed zone data is rejected, and the answer to a stale save carries the zones', async () => {
  const s = await boot();
  try {
    assert.equal((await s.put(0, { notes: [], trash: [], zones: 'x' })).status, 400);
    assert.equal((await s.put(0, { notes: [], trash: [], zones: [{ nope: 1 }] })).status, 400);
    assert.equal((await s.put(0, { notes: [], trash: [], zones: null })).status, 400);
    assert.equal((await s.put(0, { notes: [], trash: [], zonesTrash: 5 })).status, 400);
    assert.equal((await s.get()).rev, 0, 'nothing was written');

    await s.put(0, { notes: [], trash: [], zones: [zone('z1')], zonesTrash: [] });
    const stale = await s.put(0, { notes: [], trash: [], zones: [zone('z2')], zonesTrash: [] });
    assert.equal(stale.status, 409);
    assert.deepEqual((await stale.json()).board.zones.map((z) => z.id), ['z1']);
  } finally { await s.close(); }
});

test('a damaged board.json is recovered from a backup that still holds the zones', async () => {
  const s = await boot();
  await s.put(0, { notes: [note('keep-me')], trash: [], zones: [zone('keep-zone')], zonesTrash: [] });
  await s.put(1, { notes: [note('keep-me')], trash: [], zones: [zone('keep-zone'), zone('lost-zone')], zonesTrash: [] });
  await s.close({ keep: true });
  try {
    fs.writeFileSync(path.join(s.dir, 'board.json'), '{"notes": [ trunc');
    const s2 = await boot({ dir: s.dir });
    try {
      assert.deepEqual((await s2.get()).board.zones.map((z) => z.id), ['keep-zone']);
    } finally { await s2.close({ keep: true }); }
  } finally { removeDir(s.dir); }
});

// ---------------------------------------------------------------- images

test('images are stored by content, deduplicated and served with long-lived caching', async () => {
  const s = await boot();
  try {
    const up = () => fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: PNG });
    const first = await (await up()).json();
    const second = await (await up()).json();
    assert.match(first.id, /^[a-f0-9]{40}\.png$/);
    assert.equal(first.id, second.id);
    assert.equal(fs.readdirSync(path.join(s.dir, 'images')).length, 1);

    const img = await fetch(`${s.base}/img/${first.id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(img.headers.get('content-length'), String(PNG.length));
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

    // The name is the SHA-1 of the content, so a picture added by one version is found by another.
    const { createHash } = await import('node:crypto');
    assert.equal(first.id, `${createHash('sha1').update(PNG).digest('hex')}.png`);
  } finally { await s.close(); }
});

test('every supported image format is recognised by its content and served with its own type', async () => {
  const s = await boot();
  try {
    const samples = {
      png: PNG,
      jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.alloc(20, 7)]),
      gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20, 7)]),
      webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20, 7)]),
    };
    const types = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    for (const [ext, bytes] of Object.entries(samples)) {
      // The declared Content-Type is ignored: the first bytes decide.
      const res = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'text/plain' }, body: bytes });
      assert.equal(res.status, 200, ext);
      const { id } = await res.json();
      assert.match(id, new RegExp(`^[a-f0-9]{40}\\.${ext}$`));
      assert.equal((await fetch(`${s.base}/img/${id}`)).headers.get('content-type'), types[ext]);
    }
  } finally { await s.close(); }
});

test('images: non-images, bad ids and path traversal are rejected', async () => {
  const s = await boot();
  try {
    const junk = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: Buffer.from('<script>alert(1)</script> this is not an image') });
    assert.equal(junk.status, 415);
    assert.equal((await junk.json()).error, 'unsupported_image');
    const svg = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE }, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
    assert.equal(svg.status, 415, 'SVG can carry scripts and is not accepted');
    const tiny = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE }, body: Buffer.alloc(5) });
    assert.equal(tiny.status, 415, 'too short to be an image');
    assert.equal((await fetch(`${s.base}/img/${'a'.repeat(40)}.png`)).status, 404);
    assert.equal((await fetch(`${s.base}/img/..%2f..%2fboard.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/img/not-an-id`)).status, 404);
    assert.equal((await fetch(`${s.base}/img/${'A'.repeat(40)}.png`)).status, 404, 'ids are lower case');
    assert.equal((await fetch(`${s.base}/img/${'a'.repeat(40)}.svg`)).status, 404);
    const noHeader = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
    assert.equal(noHeader.status, 403);
    assert.equal(fs.readdirSync(path.join(s.dir, 'images')).length, 0, 'nothing was stored');
  } finally { await s.close(); }
});

test('an image id may be percent-encoded in the address', async () => {
  const s = await boot();
  try {
    const { id } = await (await fetch(`${s.base}/api/images`, { method: 'POST', headers: WRITE, body: PNG })).json();
    const encoded = `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`;
    assert.equal((await rawRequest(s.port, { url: `/img/${encoded}`, headers: { Host: `127.0.0.1:${s.port}` } })).status, 200);
    assert.equal((await rawRequest(s.port, { url: `/img/${id.slice(0, 5)}%zz${id.slice(5)}`, headers: { Host: `127.0.0.1:${s.port}` } })).status, 400, 'a broken percent escape is a bad request');
  } finally { await s.close(); }
});

test('a thumbnail is accepted only when its original exists', async () => {
  const s = await boot();
  try {
    const post = (of, body = PNG) => fetch(`${s.base}/api/thumb?of=${of}`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body });
    assert.equal((await post(`${'b'.repeat(40)}.png`)).status, 400, 'no such original');
    assert.equal((await post('../../etc/passwd')).status, 400, 'bad id');
    assert.equal((await fetch(`${s.base}/api/thumb`, { method: 'POST', headers: WRITE, body: PNG })).status, 400, 'no id at all');
    const { id } = await (await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: PNG })).json();
    const res = await post(id);
    assert.equal(res.status, 200);
    const thumb = await res.json();
    assert.equal(thumb.id, `${id.split('.')[0]}.thumb.png`);
    assert.equal((await fetch(`${s.base}/img/${thumb.id}`)).status, 200);
    const notAThumb = await post(id, Buffer.from('GIF89a' + 'x'.repeat(20)));
    assert.equal(notAThumb.status, 415, 'a GIF cannot be a thumbnail');
    assert.equal((await notAThumb.json()).error, 'unsupported_thumb');
    assert.equal((await post(id, Buffer.from('plain text, not a picture'))).status, 415);
    assert.equal((await fetch(`${s.base}/api/thumb?of=${id}`, { method: 'POST', body: PNG })).status, 403, 'needs the custom header');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- static files and routing

test('static files: CSP is set, traversal is blocked, unknown paths return 404', async () => {
  const s = await boot();
  try {
    const index = await fetch(`${s.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    assert.ok((await index.text()).includes('Stick Note'));

    const js = await fetch(`${s.base}/js/main.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(js.headers.get('content-security-policy'), null, 'the policy is only sent with pages');
    const body = Buffer.from(await js.arrayBuffer());
    assert.deepEqual(body, fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'public', 'js', 'main.js')), 'the served file is the one in public/');

    const etag = js.headers.get('etag');
    assert.ok(etag, 'a validator is sent');
    const cached = await fetch(`${s.base}/js/main.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(`${s.base}/js/main.js`, { headers: { 'If-None-Match': 'W/"nope"' } })).status, 200);

    assert.equal((await fetch(`${s.base}/nope.html`)).status, 404);
    assert.equal((await fetch(`${s.base}/js/`)).status, 404, 'a folder is not a file');
    assert.equal((await rawRequest(s.port, { url: '/..%5c..%5cserver.js', headers: { Host: `127.0.0.1:${s.port}` } })).status === 200, false);
    assert.equal((await rawRequest(s.port, { url: '/%2e%2e/server.js', headers: { Host: `127.0.0.1:${s.port}` } })).status === 200, false);
    assert.equal((await fetch(`${s.base}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${s.base}/js/main.js`, { method: 'DELETE' })).status, 405);
  } finally { await s.close(); }
});

test('every file of the web interface is served with the right type', async () => {
  const s = await boot();
  try {
    const expected = { '.html': /^text\/html; charset=utf-8$/, '.js': /^text\/javascript; charset=utf-8$/, '.css': /^text\/css; charset=utf-8$/, '.json': /^application\/json; charset=utf-8$/, '.svg': /^image\/svg\+xml$/, '.png': /^image\/png$/, '.ico': /^image\/x-icon$/ };
    const publicDir = path.join(import.meta.dirname, '..', '..', 'public');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const files = walk(publicDir);
    assert.ok(files.length > 20);
    for (const file of files) {
      const rel = path.relative(publicDir, file).split(path.sep).join('/');
      const res = await fetch(`${s.base}/${rel.split('/').map(encodeURIComponent).join('/')}`);
      assert.equal(res.status, 200, rel);
      assert.match(res.headers.get('content-type'), expected[path.extname(file)], rel);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(file), rel);
    }
    const icon = await fetch(`${s.base}/favicon.ico`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml', '/favicon.ico is answered with the SVG icon');
  } finally { await s.close(); }
});

test('dot segments are resolved like a browser does, and escapes from the web folder are refused', async () => {
  const s = await boot();
  try {
    const get = (url) => rawRequest(s.port, { url, headers: { Host: `127.0.0.1:${s.port}` } });
    assert.equal((await get('/js/../css/app.css')).status, 200);
    assert.equal((await get('/./js/main.js')).status, 200);
    assert.equal((await get('/js/%2e%2e/css/app.css')).status, 200);
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/js/../../package.json', '/..%2fpackage.json', '/..%5cpackage.json', '/js/..%5c..%5cpackage.json', '/%00', '/js/main.js%00.png', '/img/..%2f..%2fpackage.json']) {
      const res = await get(url);
      assert.notEqual(res.status, 200, url);
      assert.ok(!res.body.toString().includes('"name": "stick-note"'), `${url} must not leak package.json`);
    }
  } finally { await s.close(); }
});

test('unknown API routes and unexpected methods get the documented answers', async () => {
  const s = await boot();
  try {
    const unknown = await fetch(`${s.base}/api/nope`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not_found', message: 'No such API endpoint' });
    assert.equal((await fetch(`${s.base}/api/ping`, { method: 'PUT' })).status, 403, 'a write without the header is refused first');
    const put = await fetch(`${s.base}/api/ping`, { method: 'PUT', headers: WRITE });
    assert.equal(put.status, 404);
    assert.equal((await fetch(`${s.base}/api/board`, { method: 'POST', headers: WRITE })).status, 404);
    assert.equal((await fetch(`${s.base}/api/ping/`)).status, 404, 'routes match exactly');
    assert.equal((await fetch(`${s.base}/api/board`, { method: 'OPTIONS' })).status, 403, 'a CORS preflight is refused');
    assert.equal((await rawRequest(s.port, { method: 'HEAD', url: '/api/ping', headers: { Host: `127.0.0.1:${s.port}` } })).status, 404, 'HEAD is not GET for the API');
  } finally { await s.close(); }
});

test('HEAD on a file sends the headers of a GET and no body', async () => {
  const s = await boot();
  try {
    const host = { Host: `127.0.0.1:${s.port}` };
    const get = await rawRequest(s.port, { url: '/js/main.js', headers: host });
    const head = await rawRequest(s.port, { method: 'HEAD', url: '/js/main.js', headers: host });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(get.body.length));
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers.etag, get.headers.etag);

    const { id } = await (await fetch(`${s.base}/api/images`, { method: 'POST', headers: WRITE, body: PNG })).json();
    const imageHead = await rawRequest(s.port, { method: 'HEAD', url: `/img/${id}`, headers: host });
    assert.equal(imageHead.status, 200);
    assert.equal(imageHead.body.length, 0);
    assert.equal(imageHead.headers['content-length'], String(PNG.length));
  } finally { await s.close(); }
});

test('POST /api/shutdown needs the custom header, answers, and then the program exits cleanly', async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(`${s.base}/api/shutdown`, { method: 'POST' })).status, 403);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.exit, null, 'a refused request does not stop the server');
    const res = await fetch(`${s.base}/api/shutdown`, { method: 'POST', headers: WRITE });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const done = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
    assert.ok(done, 'the program exits after the shutdown request');
    assert.equal(done.code, 0);
  } finally { await s.close(); }
});
