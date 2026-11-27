// Tests for the data store (zones, trash, undo, merging with another window). The store has no DOM code, so it
// runs in Node; the server is replaced by a tiny fake `fetch`. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../public/js/store.js';

// ---------------------------------------------------------------- a fake server

let serverBoard;
let puts;
let conflictNext;

const reply = (status, body) => ({ ok: status < 400, status, statusText: '', json: async () => body });

globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  if (path.startsWith('/api/board') && init.method === 'PUT') {
    puts.push(JSON.parse(init.body));
    if (conflictNext) {
      const c = conflictNext;
      conflictNext = null;
      return reply(409, c);
    }
    serverBoard.rev += 1;
    return reply(200, { rev: serverBoard.rev, savedAt: 'now' });
  }
  if (path.startsWith('/api/board')) return reply(200, serverBoard);
  if (path.startsWith('/api/rev')) return reply(200, { rev: serverBoard.rev });
  throw new Error(`unexpected request: ${path}`);
};

// Start every test from the given board, with an empty undo history.
async function fresh(board = { notes: [], trash: [] }) {
  await settled(); // the previous test may have left an unsaved change behind
  serverBoard = { rev: 0, board };
  puts = [];
  conflictNext = null;
  await store.load();
  while (store.canUndo()) store.popCheckpoint();
  return store.state;
}

// Wait until the store has saved everything (its own timer may also be saving in the background).
async function settled() {
  for (let i = 0; i < 100 && store.isDirty(); i++) {
    await store.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ids = (list) => [...list].map((x) => x.id).sort();
const events = (name) => {
  const seen = [];
  const off = store.on(name, (d) => seen.push(d));
  return { seen, off };
};

// ---------------------------------------------------------------- zones

test('addZone makes a valid zone with a "z" id, a time stamp and a saved copy', async () => {
  const state = await fresh();
  const ev = events('zones');
  const z = store.addZone({ x: 10.04, y: 20, w: 50, h: 40, t: 'Taxes', k: 'important', p: 1 });
  ev.off();
  assert.match(z.id, /^z/);
  assert.equal(z.k, 'important');
  assert.equal(z.p, 1);
  assert.equal(z.w, 120, 'too small: raised to the minimum');
  assert.equal(z.h, 90);
  assert.ok(z.mt > 0 && z.ts === z.mt);
  assert.deepEqual(ids(state.zones.values()), [z.id]);
  assert.deepEqual(ev.seen, [{ changed: [z.id] }]);
  assert.deepEqual(ids(store.serialize().zones), [z.id]);
  assert.ok(store.isDirty());
});

test('serialize leaves out default values and always carries all four lists', async () => {
  await fresh();
  const plain = store.addZone({ x: 1.26, y: 2, w: 300.4, h: 200.6, k: 'normal' });
  const out = store.serialize();
  assert.deepEqual(Object.keys(out).sort(), ['notes', 'trash', 'zones', 'zonesTrash']);
  const saved = out.zones.find((z) => z.id === plain.id);
  assert.ok(!('p' in saved), 'a zone that is not private has no p');
  assert.ok(!('t' in saved), 'an unnamed zone has no label');
  assert.deepEqual([saved.x, saved.y, saved.w, saved.h], [1.3, 2, 300, 201], 'geometry is rounded');
});

test('updateZones re-checks every value and bumps the modification time', async () => {
  await fresh();
  const z = store.addZone({ x: 0, y: 0, w: 400, h: 300 });
  const before = z.mt;
  await new Promise((r) => setTimeout(r, 3));
  store.updateZones([z.id], { k: 'nonsense', w: 10, t: 'x'.repeat(500), p: 1 });
  const got = store.getZone(z.id);
  assert.equal(got.k, 'normal', 'an unknown kind is refused');
  assert.equal(got.w, 120, 'the minimum width holds');
  assert.equal(got.t.length, 80, 'the label is cut to its limit');
  assert.equal(got.p, 1);
  assert.ok(got.mt > before);
  store.updateZones([z.id], (old) => ({ x: old.x + 5 }));
  assert.equal(store.getZone(z.id).x, 5, 'a function can compute the change from the old zone');
  store.updateZones(['missing'], { k: 'low' }); // quietly ignored
});

test('moveZones rounds, moves only the zones named and bumps their time', async () => {
  await fresh();
  const a = store.addZone({ x: 0, y: 0, w: 300, h: 200 });
  const b = store.addZone({ x: 500, y: 500, w: 300, h: 200 });
  store.moveZones(new Map([[a.id, { x: 12.34, y: -7.77 }], ['gone', { x: 1, y: 1 }]]));
  assert.deepEqual([store.getZone(a.id).x, store.getZone(a.id).y], [12.3, -7.8]);
  assert.deepEqual([store.getZone(b.id).x, store.getZone(b.id).y], [500, 500]);
});

test('removeZones sends zones to the trash and leaves the notes alone; restoreZone brings them back', async () => {
  const state = await fresh();
  const note = store.addNote({ x: 50, y: 50, t: 'inside the zone' });
  const z = store.addZone({ x: 0, y: 0, w: 400, h: 300, t: 'Keep' });
  const trashEvents = events('trash');
  const zoneEvents = events('zones');
  store.removeZones([z.id, 'missing']);
  assert.equal(state.zones.size, 0);
  assert.deepEqual(ids(state.zonesTrash), [z.id]);
  assert.ok(state.zonesTrash[0].del > 0, 'the deletion time is recorded');
  assert.deepEqual(ids(state.notes.values()), [note.id], 'the note inside is untouched');
  assert.equal(state.notes.get(note.id).x, 50);
  assert.deepEqual(zoneEvents.seen.at(-1), { removed: [z.id] });
  assert.equal(trashEvents.seen.length, 1);

  const back = store.restoreZone(z.id);
  assert.equal(back.id, z.id);
  assert.ok(!('del' in back));
  assert.equal(state.zonesTrash.length, 0);
  assert.equal(state.zones.get(z.id).t, 'Keep');
  assert.equal(store.restoreZone('nope'), null);
  trashEvents.off();
  zoneEvents.off();
});

test('purgeTrash can delete one item of either kind, or empty everything', async () => {
  const state = await fresh();
  const n1 = store.addNote({ t: 'one' });
  const n2 = store.addNote({ t: 'two' });
  const z1 = store.addZone({ w: 300, h: 200 });
  const z2 = store.addZone({ w: 300, h: 200 });
  store.removeNotes([n1.id, n2.id]);
  store.removeZones([z1.id, z2.id]);
  assert.equal(state.trash.length + state.zonesTrash.length, 4);
  store.purgeTrash([n1.id, z1.id]);
  assert.deepEqual(ids(state.trash), [n2.id]);
  assert.deepEqual(ids(state.zonesTrash), [z2.id]);
  store.purgeTrash();
  assert.deepEqual([state.trash.length, state.zonesTrash.length], [0, 0]);
});

// ---------------------------------------------------------------- undo and redo

test('undo and redo cover zones: creating, moving, changing and deleting', async () => {
  const state = await fresh();

  store.checkpoint();
  const z = store.addZone({ x: 0, y: 0, w: 400, h: 300, t: 'A' });
  store.checkpoint();
  store.moveZones(new Map([[z.id, { x: 100, y: 100 }]]));
  store.checkpoint();
  store.updateZones([z.id], { k: 'low', p: 1 });
  store.checkpoint();
  store.removeZones([z.id]);
  assert.equal(state.zones.size, 0);

  assert.ok(store.undo());
  assert.equal(state.zones.get(z.id).k, 'low', 'the delete is undone, with the zone as it was');
  assert.equal(state.zones.get(z.id).p, 1);
  assert.equal(state.zonesTrash.length, 0);
  assert.ok(store.undo());
  assert.equal(state.zones.get(z.id).k, 'normal');
  assert.equal(state.zones.get(z.id).p, 0);
  assert.ok(store.undo());
  assert.deepEqual([state.zones.get(z.id).x, state.zones.get(z.id).y], [0, 0]);
  assert.ok(store.undo());
  assert.equal(state.zones.size, 0, 'the zone was never created');
  assert.ok(!store.undo(), 'nothing left to undo');

  assert.ok(store.redo());
  assert.equal(state.zones.size, 1);
  assert.ok(store.redo());
  assert.deepEqual([state.zones.get(z.id).x, state.zones.get(z.id).y], [100, 100]);
});

test('an undone zone counts as freshly edited, so it wins when merged with another window', async () => {
  const state = await fresh();
  const z = store.addZone({ x: 0, y: 0, w: 400, h: 300 });
  store.checkpoint();
  store.moveZones(new Map([[z.id, { x: 50, y: 50 }]]));
  const movedAt = state.zones.get(z.id).mt;
  await new Promise((r) => setTimeout(r, 3));
  store.undo();
  assert.ok(state.zones.get(z.id).mt > movedAt);
});

test('moving a zone and its notes in one undo step is undone in one step', async () => {
  const state = await fresh();
  const z = store.addZone({ x: 0, y: 0, w: 400, h: 300 });
  const n = store.addNote({ x: 100, y: 100, t: 'carried' });
  store.checkpoint();
  store.moveZones(new Map([[z.id, { x: 300, y: 300 }]]));
  store.moveNotes(new Map([[n.id, { x: 400, y: 400 }]]));
  assert.deepEqual([state.zones.get(z.id).x, state.notes.get(n.id).x], [300, 400]);
  store.undo();
  assert.deepEqual([state.zones.get(z.id).x, state.notes.get(n.id).x], [0, 100]);
});

// ---------------------------------------------------------------- saving and merging

test('every save carries zones and zonesTrash', async () => {
  await fresh();
  const z = store.addZone({ x: 0, y: 0, w: 300, h: 200, t: 'Saved' });
  const gone = store.addZone({ x: 0, y: 0, w: 300, h: 200 });
  store.removeZones([gone.id]);
  await settled();
  const sent = puts.at(-1).board;
  assert.deepEqual(ids(sent.zones), [z.id]);
  assert.deepEqual(ids(sent.zonesTrash), [gone.id]);
});

test('a board from version 1.1 (no zone lists) loads with no zones', async () => {
  const state = await fresh({ notes: [{ id: 'n1', x: 1, y: 2, t: 'old' }], trash: [] });
  assert.deepEqual(ids(state.notes.values()), ['n1']);
  assert.equal(state.zones.size, 0);
  assert.equal(state.zonesTrash.length, 0);
});

test('a save refused as stale is merged with the other window: zones from both sides survive', async () => {
  const state = await fresh();
  const mine = store.addZone({ x: 0, y: 0, w: 300, h: 200, t: 'mine' });
  const theirs = { id: 'zOther', x: 900, y: 0, w: 300, h: 200, k: 'low', t: 'theirs', ts: 5, mt: 5 };
  conflictNext = { error: 'conflict', message: 'x', rev: 9, board: { notes: [], trash: [], zones: [theirs], zonesTrash: [] } };
  const merged = events('merged');
  await store.flush();
  merged.off();
  assert.equal(merged.seen.length, 1, 'the interface is told about the merge');
  assert.deepEqual(ids(state.zones.values()), [mine.id, 'zOther'].sort());
  assert.equal(state.rev, 9);
  // The merged board is saved again right away.
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ids(puts.at(-1).board.zones), [mine.id, 'zOther'].sort());
});

test('a zone deleted in another window after my last edit stays deleted after the merge', async () => {
  const state = await fresh();
  const z = store.addZone({ x: 0, y: 0, w: 300, h: 200 });
  const deletedElsewhere = { ...z, del: z.mt + 1000, mt: z.mt + 1000 };
  conflictNext = { error: 'conflict', message: 'x', rev: 3, board: { notes: [], trash: [], zones: [], zonesTrash: [deletedElsewhere] } };
  await store.flush();
  assert.equal(state.zones.size, 0);
  assert.deepEqual(ids(state.zonesTrash), [z.id]);
});
