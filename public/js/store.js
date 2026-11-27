// The data store: notes, trash, undo/redo and autosave.
//
// Every change goes through the functions in this file so that they always: update `mt`
// (the last-modified time, used when merging), mark the board "unsaved", and emit an event for the UI to redraw.
//
// Events:
//   'notes'  { changed?: id[], removed?: id[], reset?: true }
//   'trash'  (the trash changed)
//   'status' 'loading' | 'saved' | 'pending' | 'saving' | 'error'
//   'merged' (changes from another window were just merged in)

import { api } from './api.js';
import { mergeBoards } from './merge.js';
import { uid, clamp, round } from './util.js';
import { COLOR_KEYS, NOTE_W, MIN_W, MAX_W, TRASH_KEEP_DAYS } from './constants.js';

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
  zmax: 1,
  rev: 0,
  status: 'loading',
  savedAt: 0,
};

export const getNote = (id) => state.notes.get(id);

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

function setData(notes, trash) {
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
  state.zmax = zmax;
}

export function serialize() {
  return {
    notes: [...state.notes.values()].map(compact),
    trash: state.trash.map(compact),
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
      // Another window saved first: merge note by note, then save the merged board.
      const merged = mergeBoards(serialize(), res.board);
      state.rev = res.rev;
      setData(merged.notes, merged.trash);
      dirty = true;
      emit('notes', { reset: true });
      emit('trash');
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
  const keep = state.trash.filter((n) => (n.del || n.mt) >= cutoff);
  if (keep.length !== state.trash.length) {
    state.trash = keep;
    touch();
  }
}

export async function load() {
  setStatus('loading');
  const { rev, board } = await api.getBoard();
  state.rev = rev;
  setData(board.notes || [], board.trash || []);

  // The last window closed before it could save (or the server was down): merge the unsaved work back in.
  const pending = readPending();
  if (pending && pending.board && Date.now() - (pending.at || 0) < 30 * 86_400_000) {
    const merged = mergeBoards(pending.board, serialize());
    setData(merged.notes, merged.trash);
    dirty = true;
    schedule(200);
  }
  clearPending();
  purgeOldTrash();
  setStatus(dirty ? 'pending' : 'saved');
  emit('notes', { reset: true });
  emit('trash');
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
    setData(res.board.notes || [], res.board.trash || []);
    emit('notes', { reset: true });
    emit('trash');
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
  return map;
}

function travel(from, to) {
  if (!from.length) return false;
  to.push(snapshot());
  const before = fingerprints();
  const data = JSON.parse(from.pop());
  setData(data.notes, data.trash);
  // A note that just returned to an earlier state counts as freshly edited, so it wins when merged with another window.
  const now = Date.now();
  for (const [id, fp] of fingerprints()) {
    if (before.get(id) === fp) continue;
    const n = state.notes.get(id) || state.trash.find((t) => t.id === id);
    if (n) n.mt = now;
  }
  touch();
  emit('notes', { reset: true });
  emit('trash');
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

// ids = undefined: empty the whole trash.
export function purgeTrash(ids) {
  const before = state.trash.length;
  state.trash = ids ? state.trash.filter((n) => !ids.includes(n.id)) : [];
  if (state.trash.length !== before) {
    touch();
    emit('trash');
  }
}
