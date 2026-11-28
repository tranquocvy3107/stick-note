// Contract tests: size limits, concurrency, broken clients and unusual data. The server must stay alive and
// keep the data intact whatever arrives.
// Run with: npm test   (Rust: STICK_NOTE_BIN=<program> node --test test/contract)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PNG, WRITE, boot, note, rawRequest, sleep, until } from './harness.mjs';

const MiB = 1024 * 1024;
const alive = async (s) => (await fetch(`${s.base}/api/ping`, { signal: AbortSignal.timeout(3000) })).ok;
const png = (size) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 1)]); // still starts like a PNG

test('an image of exactly 25 MiB is accepted, one byte more is refused with 413, and the server carries on', async () => {
  const s = await boot();
  try {
    const post = (body) => fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body });
    const big = await post(png(25 * MiB));
    assert.equal(big.status, 200);
    const tooBig = await post(png(25 * MiB + 1));
    assert.equal(tooBig.status, 413);
    const body = await tooBig.json();
    assert.equal(body.error, 'payload_too_large');
    assert.equal(fs.readdirSync(path.join(s.dir, 'images')).length, 1, 'only the first image was stored');
    assert.ok(await alive(s));
  } finally { await s.close(); }
});

test('a thumbnail of exactly 8 MiB is accepted, one byte more is refused with 413', async () => {
  const s = await boot();
  try {
    const { id } = await (await fetch(`${s.base}/api/images`, { method: 'POST', headers: WRITE, body: PNG })).json();
    const post = (body) => fetch(`${s.base}/api/thumb?of=${id}`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body });
    assert.equal((await post(png(8 * MiB))).status, 200);
    const tooBig = await post(png(8 * MiB + 1));
    assert.equal(tooBig.status, 413);
    assert.equal((await tooBig.json()).error, 'payload_too_large');
    assert.ok(await alive(s));
  } finally { await s.close(); }
});

test('a board of more than 64 MiB is refused with 413 and the saved data is untouched', async () => {
  const s = await boot();
  try {
    await s.put(0, { notes: [note('safe')], trash: [] });
    const huge = JSON.stringify({ baseRev: 1, board: { notes: [note('big', { t: 'x'.repeat(65 * MiB) })], trash: [] } });
    const res = await fetch(`${s.base}/api/board`, { method: 'PUT', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: huge });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, 'payload_too_large');
    const got = await s.get();
    assert.equal(got.rev, 1);
    assert.deepEqual(got.board.notes.map((n) => n.id), ['safe']);
  } finally { await s.close(); }
});

test('a big board (3000 notes, several MB) makes the round trip unchanged', async () => {
  const s = await boot();
  try {
    const notes = Array.from({ length: 3000 }, (_, i) => note(`n${i}`, { x: i * 7.5, y: -i, t: `Ghi chú số ${i} — ${'đ'.repeat(300)}`, r: -0.5 }));
    const res = await s.put(0, { notes, trash: [] });
    assert.equal(res.status, 200);
    const got = await s.get();
    assert.equal(got.board.notes.length, 3000);
    assert.equal(JSON.stringify(got.board.notes), JSON.stringify(notes));
    const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'board.json'), 'utf8'));
    assert.equal(JSON.stringify(onDisk.notes), JSON.stringify(notes));
    assert.ok((fs.statSync(path.join(s.dir, 'board.json')).size) > 1 * MiB);
  } finally { await s.close(); }
});

test('text with a lone half of an emoji (a broken surrogate pair) does not stop the board from saving', async () => {
  const s = await boot();
  try {
    // JSON.stringify writes it as the escape \ud83d. Servers must not turn that into a refusal to save.
    const res = await s.put(0, { notes: [note('broken', { t: 'cut in the middle: \ud83d' }), note('fine', { t: 'ok 😀' })], trash: [] });
    assert.equal(res.status, 200);
    const got = await s.get();
    assert.deepEqual(got.board.notes.map((n) => n.id), ['broken', 'fine']);
    assert.equal(typeof got.board.notes[0].t, 'string');
    assert.equal(got.board.notes[1].t, 'ok 😀', 'a complete emoji is untouched');
    JSON.parse(fs.readFileSync(path.join(s.dir, 'board.json'), 'utf8'));
  } finally { await s.close(); }
});

test('eight windows saving at the same moment: exactly one wins, the others get 409', async () => {
  const s = await boot();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.put(0, { notes: [note(`from-${i}`)], trash: [] })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200);
    assert.equal((await winner.json()).rev, 1);
    const got = await s.get();
    assert.equal(got.rev, 1);
    assert.equal(got.board.notes.length, 1);
    assert.equal(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally { await s.close(); }
});

test('the same picture uploaded six times at once is stored once, intact', async () => {
  const s = await boot();
  try {
    const picture = png(2 * MiB);
    const results = await Promise.all(Array.from({ length: 6 }, () => fetch(`${s.base}/api/images`, { method: 'POST', headers: WRITE, body: picture })));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
    const ids = new Set((await Promise.all(results.map((r) => r.json()))).map((b) => b.id));
    assert.equal(ids.size, 1);
    const files = fs.readdirSync(path.join(s.dir, 'images'));
    assert.deepEqual(files, [[...ids][0]]);
    assert.deepEqual(fs.readFileSync(path.join(s.dir, 'images', files[0])), picture);
  } finally { await s.close(); }
});

test('saves and reads at the same time never show a half-written board', async () => {
  const s = await boot();
  try {
    let rev = 0;
    let stop = false;
    const reader = (async () => {
      let reads = 0;
      while (!stop) {
        const res = await fetch(`${s.base}/api/board`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body.board.notes));
        assert.equal(body.board.notes.length, body.rev, 'the notes always belong to the revision they are delivered with');
        reads += 1;
      }
      return reads;
    })();
    const notes = [];
    for (let i = 0; i < 25; i++) {
      notes.push(note(`n${i}`, { t: 'y'.repeat(2000) }));
      const res = await s.put(rev, { notes: notes.slice(), trash: [] });
      assert.equal(res.status, 200);
      rev = (await res.json()).rev;
    }
    stop = true;
    assert.ok(await reader > 0);
    assert.equal((await s.get()).rev, 25);
  } finally { await s.close(); }
});

test('a client that disappears in the middle of an upload does no harm', async () => {
  const s = await boot();
  try {
    await new Promise((resolve) => {
      const socket = net.connect(s.port, '127.0.0.1', () => {
        socket.write(`POST /api/images HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nX-Stick-Note: 1\r\nContent-Length: 1000000\r\n\r\n`);
        socket.write(Buffer.alloc(1000, 1));
        setTimeout(() => { socket.destroy(); resolve(); }, 100);
      });
      socket.on('error', () => {});
    });
    await sleep(200);
    assert.ok(await alive(s));
    assert.equal(fs.readdirSync(path.join(s.dir, 'images')).length, 0);
    assert.equal(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally { await s.close(); }
});

test('garbage on the socket gets no answer worth trusting and does not stop the server', async () => {
  const s = await boot();
  try {
    for (const junk of [Buffer.from([0, 1, 2, 3, 255, 254, 13, 10, 13, 10]), Buffer.from('NOT HTTP AT ALL\r\n\r\n'), Buffer.from(`GET /${'a'.repeat(200_000)} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`)]) {
      await new Promise((resolve) => {
        const socket = net.connect(s.port, '127.0.0.1', () => socket.write(junk));
        socket.on('data', () => {});
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
        setTimeout(() => { socket.destroy(); resolve(); }, 500);
      });
    }
    assert.ok(await alive(s));
  } finally { await s.close(); }
});

test('many requests on one connection (keep-alive) are all answered', async () => {
  const s = await boot();
  try {
    const answers = await new Promise((resolve, reject) => {
      const socket = net.connect(s.port, '127.0.0.1');
      let data = '';
      socket.on('data', (c) => { data += c; });
      socket.on('error', reject);
      socket.on('connect', () => {
        for (let i = 0; i < 20; i++) socket.write(`GET /api/rev HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n${i === 19 ? 'Connection: close\r\n' : ''}\r\n`);
      });
      socket.on('close', () => resolve(data));
    });
    assert.equal((answers.match(/HTTP\/1\.1 200/g) || []).length, 20);
  } finally { await s.close(); }
});

test('the server keeps working after a long run of mixed requests', async () => {
  const s = await boot();
  try {
    const { id } = await (await fetch(`${s.base}/api/images`, { method: 'POST', headers: WRITE, body: PNG })).json();
    let rev = 0;
    for (let i = 0; i < 40; i++) {
      const res = await s.put(rev, { notes: [note(`n${i}`)], trash: [] });
      rev = (await res.json()).rev;
      await Promise.all([fetch(`${s.base}/img/${id}`).then((r) => r.arrayBuffer()), fetch(`${s.base}/`).then((r) => r.text()), s.info(), rawRequest(s.port, { url: '/nope', headers: { Host: `127.0.0.1:${s.port}` } })]);
    }
    assert.equal(rev, 40);
    assert.ok(await until(async () => (await s.info()).rev === 40));
  } finally { await s.close(); }
});
