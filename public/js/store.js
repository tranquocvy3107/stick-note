// The data store: notes, zones, trash, undo/redo and autosave.
//
// Every change goes through the functions in this file so that they always: update `mt`
// (the last-modified time, used when merging), mark the board "unsaved", and emit an event for the UI to redraw.
//
// Events:
//   'notes'  { changed?: id[], removed?: id[], reset?: true }
//   'zones'  { changed?: id[], removed?: id[], reset?: true }
//   'trash'  (the trash changed: it holds both notes and zones)
//   'status' 'loading' | 'saved' | 'pending' | 'saving' | 'error'
//   'merged' (changes from another window were just merged in)

import { api } from './api.js';
import { mergeBoards } from './merge.js';
import { uid, clamp, round } from './util.js';
import { COLOR_KEYS, NOTE_W, MIN_W, MAX_W, TRASH_KEEP_DAYS } from './constants.js';
import { normalizeZone } from './zones.js';

const listeners = {};
export function on(evt, fn) {
  (listeners[evt] ||= new Set()).add(fn);
  return () => listeners[evt].delete(fn);
}
function emit(evt, data) {
  for (const fn of listeners[evt] || []) {
    try { fn(data); } catch (err) { console.error(err); }
  }
}

export const state = {
  notes: new Map(),
  trash: [],
  zones: new Map(),
  zonesTrash: [],
  zmax: 1,
  rev: 0,
  status: 'loading',
  savedAt: 0,
};

export const getNote = (id) => state.notes.get(id);
export const getZone = (id) => state.zones.get(id);

// ---------------------------------------------------------------- normalising

const num = (v, fallback) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : fallback);

export function normalizeNote(raw) {
  const now = Date.now();
  const n = {
    id: String(raw.id),
    k: raw.k === 'image' ? 'image' : 'text',
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    w: clamp(num(raw.w, NOTE_W), MIN_W, MAX_W),
    h: Math.max(0, num(raw.h, 0)),
    c: COLOR_KEYS.includes(raw.c) ? raw.c : 'yellow',
    r: clamp(num(raw.r, 0), -15, 15),
    z: num(raw.z, 1),
    lock: raw.lock ? 1 : 0,
    t: typeof raw.t === 'string' ? raw.t : '',
    ts: num(raw.ts, now),
    mt: num(raw.mt, num(raw.ts, now)),
  };
  if (n.k === 'image') {
    n.img = typeof raw.img === 'string' ? raw.img : '';
    n.th = typeof raw.th === 'string' ? raw.th : '';
    n.iw = num(raw.iw, 0);
    n.ih = num(raw.ih, 0);
  }
  if (raw.del) n.del = num(raw.del, now);
  return n;
}

// Drop fields that hold their default value to keep the saved file small.
function compact(n) {
  const o = { ...n };
  if (!o.lock) delete o.lock;
  if (!o.h) delete o.h;
  if (!o.t) delete o.t;
  o.x = round(o.x, 1);
  o.y = round(o.y, 1);
  o.w = round(o.w, 0);
  if (o.h) o.h = round(o.h, 0);
  o.r = round(o.r, 2);
  return o;
}

// Same idea for zones: leave out fields that hold their default value, round the geometry.
function compactZone(z) {
  const o = { ...z };
  if (!o.p) delete o.p;
  if (!o.t) delete o.t;
  o.x = round(o.x, 1);
  o.y = round(o.y, 1);
  o.w = round(o.w, 0);
  o.h = round(o.h, 0);
  return o;
}

function setData(notes, trash, zones = [], zonesTrash = []) {
  state.notes = new Map();
  let zmax = 1;
  for (const raw of notes) {
    if (!raw || raw.id == null) continue;
    const n = normalizeNote(raw);
    state.notes.set(n.id, n);
    if (n.z > zmax) zmax = n.z;
  }
  state.trash = [];
  for (const raw of trash) {
    if (!raw || raw.id == null) continue;
    const n = normalizeNote(raw);
    if (!n.del) n.del = n.mt;
    state.trash.push(n);
  }
  state.zones = new Map();
  for (const raw of zones) {
    if (!raw || raw.id == null) continue;
    const z = normalizeZone(raw);
    state.zones.set(z.id, z);
  }
  state.zonesTrash = [];
  for (const raw of zonesTrash) {
    if (!raw || raw.id == null) continue;
    const z = normalizeZone(raw);
    if (!z.del) z.del = z.mt;
    state.zonesTrash.push(z);
  }
  state.zmax = zmax;
}

// Replace everything with a board as it comes from the server, a merge or a backup copy.
const applyBoard = (b) => setData(b.notes || [], b.trash || [], b.zones || [], b.zonesTrash || []);

// Tell every listener that all notes, zones and the trash were replaced.
function emitReset() {
  emit('notes', { reset: true });
  emit('zones', { reset: true });
  emit('trash');
}

export function serialize() {
  return {
    notes: [...state.notes.values()].map(compact),
    trash: state.trash.map(compact),
    zones: [...state.zones.values()].map(compactZone),
    zonesTrash: state.zonesTrash.map(compactZone),
  };
}

const snapshot = () => JSON.stringify(serialize());

// ---------------------------------------------------------------- saving

const PENDING_KEY = 'stick-note:pending';
let dirty = false;
let saving = false;
let timer = 0;
let retryMs = 0;

function setStatus(status) {
  if (state.status === status) return;
  state.status = status;
  emit('status', status);
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(flush, ms);
}

function touch() {
  dirty = true;
  if (state.status !== 'error') setStatus('pending');
  schedule(350);
}

function writePending() {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ at: Date.now(), board: serialize() }));
  } catch { /* localStorage is full or blocked: ignore */ }
}
function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}
function readPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function flush() {
  clearTimeout(timer);
  if (saving || !dirty) return;
  saving = true;
  dirty = false;
  setStatus('saving');
  try {
    const res = await api.putBoard(state.rev, serialize());
    if (res.conflict) {
      // Another window saved first: merge item by item (notes and zones), then save the merged board.
      const merged = mergeBoards(serialize(), res.board);
      state.rev = res.rev;
      applyBoard(merged);
      dirty = true;
      emitReset();
      emit('merged');
    } else {
      state.rev = res.rev;
      state.savedAt = Date.now();
      retryMs = 0;
    }
  } catch (err) {
    dirty = true;
    saving = false;
    retryMs = Math.min(15_000, retryMs ? retryMs * 2 : 1500);
    setStatus('error');
    writePending();
    schedule(retryMs);
    return;
  }
  saving = false;
  if (dirty) {
    schedule(0);
  } else {
    setStatus('saved');
    clearPending();
  }
}

// Called when the window closes: save whatever is pending and leave a safety copy in the browser.
export function flushOnExit() {
  if (!dirty && !saving) return;
  writePending();
  try {
    api.putBoard(state.rev, serialize(), { keepalive: true }).catch(() => {});
  } catch { /* body too large for keepalive: the safety copy above covers it */ }
}

export const isDirty = () => dirty || saving;

// ---------------------------------------------------------------- loading

function purgeOldTrash() {
  const cutoff = Date.now() - TRASH_KEEP_DAYS * 86_400_000;
  const fresh = (item) => (item.del || item.mt) >= cutoff;
  const keep = state.trash.filter(fresh);
  const keepZones = state.zonesTrash.filter(fresh);
  if (keep.length !== state.trash.length || keepZones.length !== state.zonesTrash.length) {
    state.trash = keep;
    state.zonesTrash = keepZones;
    touch();
  }
}

export async function load() {
  setStatus('loading');
  const { rev, board } = await api.getBoard();
  state.rev = rev;
  applyBoard(board);

  // The last window closed before it could save (or the server was down): merge the unsaved work back in.
  const pending = readPending();
  if (pending && pending.board && Date.now() - (pending.at || 0) < 30 * 86_400_000) {
    applyBoard(mergeBoards(pending.board, serialize()));
    dirty = true;
    schedule(200);
  }
  clearPending();
  purgeOldTrash();
  setStatus(dirty ? 'pending' : 'saved');
  emitReset();
}

// When the window regains focus: if another window saved changes, load the newer board.
export async function checkRemote() {
  if (dirty || saving) return;
  try {
    const rev = await api.getRev();
    if (rev === state.rev || dirty || saving) return;
    const res = await api.getBoard();
    if (dirty || saving) return;
    state.rev = res.rev;
    applyBoard(res.board);
    emitReset();
  } catch { /* offline: the next save will report it */ }
}

// ---------------------------------------------------------------- undo

const undoStack = [];
let redoStack = [];
const MAX_UNDO = 80;

export function checkpoint() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}
export const popCheckpoint = () => { undoStack.pop(); };
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function fingerprints() {
  const map = new Map();
  for (const n of state.notes.values()) map.set(n.id, JSON.stringify(compact(n)));
  for (const n of state.trash) map.set(n.id, JSON.stringify(compact(n)));
  for (const z of state.zones.values()) map.set(z.id, JSON.stringify(compactZone(z)));
  for (const z of state.zonesTrash) map.set(z.id, JSON.stringify(compactZone(z)));
  return map;
}

function travel(from, to) {
  if (!from.length) return false;
  to.push(snapshot());
  const before = fingerprints();
  applyBoard(JSON.parse(from.pop()));
  // An item that just returned to an earlier state counts as freshly edited, so it wins when merged with another window.
  const now = Date.now();
  for (const [id, fp] of fingerprints()) {
    if (before.get(id) === fp) continue;
    const item = state.notes.get(id) || state.trash.find((t) => t.id === id)
      || state.zones.get(id) || state.zonesTrash.find((t) => t.id === id);
    if (item) item.mt = now;
  }
  touch();
  emitReset();
  return true;
}
export const undo = () => travel(undoStack, redoStack);
export const redo = () => travel(redoStack, undoStack);

// ---------------------------------------------------------------- changes

export function addNote(fields) {
  const now = Date.now();
  const n = normalizeNote({
    id: uid(), k: 'text', x: 0, y: 0, w: NOTE_W, c: 'yellow', r: 0, t: '',
    ...fields, ts: now, mt: now, z: ++state.zmax,
  });
  state.notes.set(n.id, n);
  touch();
  emit('notes', { changed: [n.id] });
  return n;
}

export function updateNotes(ids, patch) {
  const now = Date.now();
  const changed = [];
  for (const id of ids) {
    const n = state.notes.get(id);
    if (!n) continue;
    Object.assign(n, typeof patch === 'function' ? patch(n) : patch, { mt: now });
    if ('w' in n) n.w = clamp(n.w, MIN_W, MAX_W);
    changed.push(id);
  }
  if (changed.length) {
    touch();
    emit('notes', { changed });
  }
}

// positions: Map<id, { x, y }>
export function moveNotes(positions) {
  const now = Date.now();
  const changed = [];
  for (const [id, p] of positions) {
    const n = state.notes.get(id);
    if (!n) continue;
    n.x = round(p.x, 1);
    n.y = round(p.y, 1);
    n.mt = now;
    changed.push(id);
  }
  if (changed.length) {
    touch();
    emit('notes', { changed });
  }
}

// Bring to the front when touched. This is not an undo step.
export function bringToFront(ids) {
  const list = ids.map((id) => state.notes.get(id)).filter(Boolean).sort((a, b) => a.z - b.z);
  if (!list.length) return;
  if (list.length === 1 && list[0].z === state.zmax) return;
  const now = Date.now();
  for (const n of list) {
    n.z = ++state.zmax;
    n.mt = now;
  }
  touch();
  emit('notes', { changed: list.map((n) => n.id) });
}

// Move to the trash (can be restored).
export function removeNotes(ids) {
  const now = Date.now();
  const removed = [];
  for (const id of ids) {
    const n = state.notes.get(id);
    if (!n) continue;
    state.notes.delete(id);
    state.trash.push({ ...n, del: now, mt: now });
    removed.push(id);
  }
  if (removed.length) {
    touch();
    emit('notes', { removed });
    emit('trash');
  }
}

// Delete outright, bypassing the trash. Only used for a note that was just created and left empty.
export function discardNote(id) {
  if (!state.notes.delete(id)) return;
  touch();
  emit('notes', { removed: [id] });
}

export function restoreNote(id) {
  const i = state.trash.findIndex((n) => n.id === id);
  if (i < 0) return null;
  const [n] = state.trash.splice(i, 1);
  delete n.del;
  n.mt = Date.now();
  n.z = ++state.zmax;
  state.notes.set(n.id, n);
  touch();
  emit('notes', { changed: [n.id] });
  emit('trash');
  return n;
}

// ids = undefined: empty the whole trash (notes and zones alike).
export function purgeTrash(ids) {
  const before = state.trash.length + state.zonesTrash.length;
  state.trash = ids ? state.trash.filter((n) => !ids.includes(n.id)) : [];
  state.zonesTrash = ids ? state.zonesTrash.filter((z) => !ids.includes(z.id)) : [];
  if (state.trash.length + state.zonesTrash.length !== before) {
    touch();
    emit('trash');
  }
}

// ---------------------------------------------------------------- zones

export function addZone(fields) {
  const now = Date.now();
  const z = normalizeZone({ k: 'normal', ...fields, id: uid('z'), ts: now, mt: now }, now);
  state.zones.set(z.id, z);
  touch();
  emit('zones', { changed: [z.id] });
  return z;
}

// patch: an object, or a function (zone) => object. Every value is checked again (minimum size, known kind, label length).
export function updateZones(ids, patch) {
  const now = Date.now();
  const changed = [];
  for (const id of ids) {
    const z = state.zones.get(id);
    if (!z) continue;
    state.zones.set(id, normalizeZone({ ...z, ...(typeof patch === 'function' ? patch(z) : patch), mt: now }, now));
    changed.push(id);
  }
  if (changed.length) {
    touch();
    emit('zones', { changed });
  }
}

// positions: Map<id, { x, y }>. Moving a zone together with its notes is two calls inside one undo step.
export function moveZones(positions) {
  const now = Date.now();
  const changed = [];
  for (const [id, p] of positions) {
    const z = state.zones.get(id);
    if (!z) continue;
    z.x = round(p.x, 1);
    z.y = round(p.y, 1);
    z.mt = now;
    changed.push(id);
  }
  if (changed.length) {
    touch();
    emit('zones', { changed });
  }
}

// Move to the trash (can be restored). The notes inside a zone are never touched.
export function removeZones(ids) {
  const now = Date.now();
  const removed = [];
  for (const id of ids) {
    const z = state.zones.get(id);
    if (!z) continue;
    state.zones.delete(id);
    state.zonesTrash.push({ ...z, del: now, mt: now });
    removed.push(id);
  }
  if (removed.length) {
    touch();
    emit('zones', { removed });
    emit('trash');
  }
}

// Delete outright, bypassing the trash. Only used for a zone that was drawn and immediately thrown away.
export function discardZone(id) {
  if (!state.zones.delete(id)) return;
  touch();
  emit('zones', { removed: [id] });
}

export function restoreZone(id) {
  const i = state.zonesTrash.findIndex((z) => z.id === id);
  if (i < 0) return null;
  const [z] = state.zonesTrash.splice(i, 1);
  delete z.del;
  z.mt = Date.now();
  state.zones.set(z.id, z);
  touch();
  emit('zones', { changed: [z.id] });
  emit('trash');
  return z;
}
