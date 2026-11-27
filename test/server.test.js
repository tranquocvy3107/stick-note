// Server tests: API, security, images, backups and recovery. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, sniffImage, APP_ID } from '../server.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const WRITE = { 'X-Stick-Note': '1' };

const pad2 = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const note = (id, extra = {}) => ({ id, k: 'text', x: 10, y: 20, w: 220, t: `note ${id}`, mt: 1, ...extra });

async function boot(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stick-note-test-')), options = {}) {
  const app = createApp({ port: 0, dataDir: dir, logToConsole: false, buildInfo: {}, ...options });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  return {
    app, dir, port, base,
    put: (baseRev, board, headers = WRITE) => fetch(`${base}/api/board`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ baseRev, board }),
    }),
    get: async () => (await fetch(`${base}/api/board`)).json(),
    async close({ keep = false } = {}) {
      await app.stop();
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Send a request with an arbitrary Host header (fetch does not allow changing it).
function rawRequest(port, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('ping identifies the server as Stick Note', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/ping`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).app, APP_ID);
  } finally { await s.close(); }
});

test('an empty board is saved and read back with non-ASCII text intact', async () => {
  const s = await boot();
  try {
    const empty = await s.get();
    assert.equal(empty.rev, 0);
    assert.deepEqual(empty.board, { notes: [], trash: [], zones: [], zonesTrash: [] });

    // Vietnamese sample: diacritics and a percent-free URL must survive the round trip byte for byte.
    const text = 'Họp thứ Hai 10h — https://example.com/Việt_Nam?q=đ&x=1';
    const res = await s.put(0, { notes: [note('n1', { t: text })], trash: [] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rev, 1);

    const after = await s.get();
    assert.equal(after.rev, 1);
    assert.equal(after.board.notes[0].t, text);

    const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'board.json'), 'utf8'));
    assert.equal(onDisk.rev, 1);
    assert.equal(onDisk.notes[0].t, text);
    assert.equal(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files are left behind');
  } finally { await s.close(); }
});

test('writes need the custom header and a valid Origin', async () => {
  const s = await boot();
  try {
    const board = { notes: [note('n1')], trash: [] };
    const noHeader = await s.put(0, board, {});
    assert.equal(noHeader.status, 403, 'missing header');
    assert.equal((await noHeader.json()).error, 'missing_header');
    const evil = await s.put(0, board, { ...WRITE, Origin: 'https://evil.example' });
    assert.equal(evil.status, 403, 'foreign Origin');
    assert.equal((await evil.json()).error, 'bad_origin');
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
    const ok = await rawRequest(s.port, { url: '/api/ping', headers: { Host: `localhost:${s.port}` } });
    assert.equal(ok.status, 200);
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
  } finally { await s.close(); }
});

test('malformed board data is rejected', async () => {
  const s = await boot();
  try {
    assert.equal((await s.put(0, { notes: 'x', trash: [] })).status, 400);
    assert.equal((await s.put(0, { notes: [{ nope: 1 }], trash: [] })).status, 400);
    assert.equal((await s.put(0, null)).status, 400);
    const raw = await fetch(`${s.base}/api/board`, { method: 'PUT', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error, 'invalid_json');
    assert.equal((await s.get()).rev, 0, 'existing data is untouched');
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
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'backups', shrink[0]), 'utf8'));
    assert.equal(saved.notes.length, 10, 'the backup holds all 10 notes from before the drop');
  } finally { await s.close(); }
});

test('a damaged board.json is recovered from the newest backup', async () => {
  const s = await boot();
  await s.put(0, { notes: [note('keep-me')], trash: [] });
  await s.put(1, { notes: [note('keep-me'), note('lost')], trash: [] });
  await s.close({ keep: true });
  try {
    fs.writeFileSync(path.join(s.dir, 'board.json'), '{"notes": [ trunc');
    const s2 = await boot(s.dir);
    try {
      const board = await s2.get();
      assert.deepEqual(board.board.notes.map((n) => n.id), ['keep-me']);
      assert.ok(fs.readdirSync(s.dir).some((f) => f.startsWith('board.corrupt-')), 'the damaged file is kept for inspection');
    } finally { await s2.close({ keep: true }); }
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('a restarted server remembers the data and the revision number', async () => {
  const s = await boot();
  await s.put(0, { notes: [note('persisted')], trash: [note('gone', { del: 5 })] });
  await s.close({ keep: true });
  try {
    const s2 = await boot(s.dir);
    try {
      const board = await s2.get();
      assert.equal(board.rev, 1);
      assert.deepEqual(board.board.notes.map((n) => n.id), ['persisted']);
      assert.deepEqual(board.board.trash.map((n) => n.id), ['gone']);
    } finally { await s2.close({ keep: true }); }
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- zones

const zone = (id, extra = {}) => ({ id, x: 40, y: 60, w: 400, h: 260, k: 'normal', t: `zone ${id}`, mt: 1, ...extra });

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
    const s2 = await boot(s.dir);
    try {
      const got = await s2.get();
      assert.deepEqual(got.board.zones.map((z) => z.id), ['z1']);
      assert.equal(got.board.zones[0].t, label);
      assert.equal(got.board.zones[0].p, 1);
      assert.deepEqual(got.board.zonesTrash.map((z) => z.id), ['z0']);
      const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'board.json'), 'utf8'));
      assert.equal(onDisk.zones.length, 1);
      assert.equal(onDisk.schema, 1, 'zones are an additive field: the schema number stays the same');
      assert.equal((await (await fetch(`${s2.base}/api/info`)).json()).zones, 1);
    } finally { await s2.close({ keep: true }); }
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stick-note-test-'));
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ app: APP_ID, schema: 1, rev: 4, savedAt: null, notes: [note('old')], trash: [] }));
  const s = await boot(dir);
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
    const s2 = await boot(s.dir);
    try {
      assert.deepEqual((await s2.get()).board.zones.map((z) => z.id), ['keep-zone']);
    } finally { await s2.close({ keep: true }); }
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

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
    assert.match(img.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  } finally { await s.close(); }
});

test('images: non-images, bad ids and path traversal are rejected', async () => {
  const s = await boot();
  try {
    const junk = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: Buffer.from('<script>alert(1)</script> this is not an image') });
    assert.equal(junk.status, 415);
    assert.equal((await junk.json()).error, 'unsupported_image');
    assert.equal((await fetch(`${s.base}/img/${'a'.repeat(40)}.png`)).status, 404);
    assert.equal((await fetch(`${s.base}/img/..%2f..%2fboard.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/img/not-an-id`)).status, 404);
    const noHeader = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
    assert.equal(noHeader.status, 403);
  } finally { await s.close(); }
});

test('a thumbnail is accepted only when its original exists', async () => {
  const s = await boot();
  try {
    const post = (of) => fetch(`${s.base}/api/thumb?of=${of}`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: PNG });
    assert.equal((await post(`${'b'.repeat(40)}.png`)).status, 400, 'no such original');
    assert.equal((await post('../../etc/passwd')).status, 400, 'bad id');
    const { id } = await (await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: PNG })).json();
    const res = await post(id);
    assert.equal(res.status, 200);
    const thumb = await res.json();
    assert.equal(thumb.id, `${id.split('.')[0]}.thumb.png`);
    assert.equal((await fetch(`${s.base}/img/${thumb.id}`)).status, 200);
  } finally { await s.close(); }
});

test('static files: CSP is set, traversal is blocked, unknown paths return 404', async () => {
  const s = await boot();
  try {
    const index = await fetch(`${s.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
    assert.ok((await index.text()).includes('Stick Note'));

    const js = await fetch(`${s.base}/js/main.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    const etag = js.headers.get('etag');
    const cached = await fetch(`${s.base}/js/main.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);

    assert.equal((await fetch(`${s.base}/nope.html`)).status, 404);
    assert.equal((await rawRequest(s.port, { url: '/..%5c..%5cserver.js', headers: { Host: `127.0.0.1:${s.port}` } })).status === 200, false);
    assert.equal((await rawRequest(s.port, { url: '/%2e%2e/server.js', headers: { Host: `127.0.0.1:${s.port}` } })).status === 200, false);
    assert.equal((await fetch(`${s.base}/`, { method: 'POST' })).status, 405);
  } finally { await s.close(); }
});

test('/api/info reports how this copy was packaged', async () => {
  const source = await boot();
  const packaged = await boot(undefined, { buildInfo: { channel: 'linux-deb' } });
  try {
    assert.equal((await (await fetch(`${source.base}/api/info`)).json()).channel, 'source');
    assert.equal((await (await fetch(`${packaged.base}/api/info`)).json()).channel, 'linux-deb');
  } finally { await source.close(); await packaged.close(); }
});

test('POST /api/shutdown needs the custom header and calls the shutdown hook', async () => {
  let called = 0;
  const s = await boot(undefined, { onShutdown: () => { called += 1; } });
  try {
    assert.equal((await fetch(`${s.base}/api/shutdown`, { method: 'POST' })).status, 403);
    assert.equal(called, 0);
    const res = await fetch(`${s.base}/api/shutdown`, { method: 'POST', headers: WRITE });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(called, 1);
  } finally { await s.close(); }
});

test('sniffImage detects the format from content, not from the file name', () => {
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'gif');
  assert.equal(sniffImage(Buffer.from('RIFF....WEBPVP8 ')), 'webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.alloc(3)), null);
});
