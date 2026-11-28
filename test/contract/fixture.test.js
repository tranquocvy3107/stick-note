// Compatibility with the data of earlier versions: a data folder written by the Node.js server of version 1.2.1
// (test/fixtures/node-1.2.1, synthetic notes only) must open, and what the program writes next must keep the layout.
//
// Why this exists: people have notes in this format, and they must be able to go back to an earlier version too.
// The fixture is frozen: never regenerate it, because it is what the old program wrote.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, boot, note, tempDir, today } from './harness.mjs';

const FIXTURE = path.join(REPO, 'test', 'fixtures', 'node-1.2.1');
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function copyFixture() {
  const dir = tempDir('stick-note-fixture-');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test('a data folder written by the Node.js server 1.2.1 opens with everything in it', async () => {
  const dir = copyFixture();
  const original = read(dir, 'board.json');
  const s = await boot({ dir });
  try {
    const got = await s.get();
    assert.equal(got.rev, original.rev);
    assert.equal(got.savedAt, original.savedAt);
    for (const key of ['notes', 'trash', 'zones', 'zonesTrash']) {
      assert.equal(JSON.stringify(got.board[key]), JSON.stringify(original[key]), `${key}: same content, same key order`);
    }
    assert.equal(got.board.notes[0].t, 'Họp thứ Hai 10h, phòng 3 — https://example.com/Việt_Nam?q=đ&x=1');
    assert.equal(got.board.notes[2].k, 'image');

    // The pictures are served, byte for byte.
    for (const name of fs.readdirSync(path.join(dir, 'images'))) {
      const res = await fetch(`${s.base}/img/${name}`);
      assert.equal(res.status, 200, name);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(path.join(dir, 'images', name)), name);
    }
    const info = await s.info();
    assert.deepEqual([info.rev, info.notes, info.trash, info.zones], [3, 3, 1, 1]);
    assert.ok(info.backups.includes('board-2026-11-28.json'), 'the backups of the old version are listed');
  } finally { await s.close(); }
});

test('the first save over the old data keeps the file layout, leaves untouched notes as they were and backs up the old state', async () => {
  const dir = copyFixture();
  const original = read(dir, 'board.json');
  const s = await boot({ dir });
  try {
    const before = await s.get();
    const saved = await s.put(before.rev, { ...before.board, notes: [...before.board.notes, note('n4', { t: 'new note' })] });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).rev, 4);

    const written = read(dir, 'board.json');
    assert.deepEqual(Object.keys(written), Object.keys(original), 'the same keys in the same order as the old version wrote');
    assert.equal(written.schema, 1);
    assert.equal(JSON.stringify(written.notes.slice(0, 3)), JSON.stringify(original.notes), 'notes nobody changed are written back as they were');
    assert.equal(written.notes[3].id, 'n4');
    assert.equal(JSON.stringify(written.zonesTrash), JSON.stringify(original.zonesTrash));

    const backup = path.join(dir, 'backups', `board-${today()}.json`);
    assert.ok(fs.existsSync(backup), "today's backup exists");
    assert.equal(fs.readdirSync(path.join(dir, 'images')).length, 2, 'the pictures are untouched');
  } finally { await s.close(); }
});

test('a damaged board.json next to the backups of the old version is recovered from them', async () => {
  const dir = copyFixture();
  fs.writeFileSync(path.join(dir, 'board.json'), '{"app":"stick-note","notes":[ cut off');
  const s = await boot({ dir });
  try {
    const got = await s.get();
    assert.deepEqual(got.board.notes.map((n) => n.id), ['n1', 'n2'], "the old version's newest backup holds the state after its first save");
    assert.equal(got.rev, 2, "the backup's revision (1) plus one");
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('board.corrupt-')), 'the damaged file is kept for inspection');
    assert.equal((await s.put(2, { notes: [note('after')], trash: [] })).status, 200, 'saving works again');
  } finally { await s.close(); }
});

test('the server of the old version could read what this program writes: same layout, plain JSON, UTF-8', async () => {
  const dir = copyFixture();
  const s = await boot({ dir });
  try {
    const got = await s.get();
    assert.equal((await s.put(got.rev, got.board)).status, 200);
    const text = fs.readFileSync(path.join(dir, 'board.json'), 'utf8');
    assert.ok(text.startsWith('{"app":"stick-note","schema":1,"rev":4,"savedAt":"'), 'compact JSON starting with the same keys');
    assert.ok(!text.trimEnd().includes('\n'), 'a single line, as before');
    assert.ok(text.includes('Họp thứ Hai 10h, phòng 3 — https://example.com/Việt_Nam?q=đ&x=1'), 'non-ASCII text is stored as UTF-8, not as escapes');
    assert.notEqual(text.charCodeAt(0), 0xfeff, 'no byte order mark');
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally { await s.close(); }
});
