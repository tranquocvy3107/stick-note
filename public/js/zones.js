// Zones: labelled rectangles drawn behind the notes. This file is the pure logic (geometry, which notes sit in
// which zone, normalising saved data). It never touches the DOM or the store, so it can be tested in Node.
//
// A note belongs to a zone when the CENTRE of the note is inside the zone. Membership is never stored: it follows
// from where things are, so it cannot drift out of step, and a zone never rearranges what lies inside it
// (the product rule "position is sacred": only an explicit drag by the owner moves anything).

import { clamp } from './util.js';
import {
  NOTE_H, ZONE_KINDS, ZONE_MIN_W, ZONE_MIN_H, ZONE_LABEL_MAX, ZONE_WRAP_PAD, ZONE_SCREEN_W, ZONE_SCREEN_H,
} from './constants.js';

const num = (v, fallback) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? +v : fallback);

/**
 * A zone as saved in board.json:
 *   { id, x, y, w, h, k: 'important'|'normal'|'low', p?: 1 (private), t?: label, ts, mt }
 * (trashed zones also carry `del`). `mt` decides merges, so every change must update it (store.js does).
 */
export function normalizeZone(raw, now = Date.now()) {
  const z = {
    id: String(raw.id),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    w: Math.max(ZONE_MIN_W, num(raw.w, ZONE_MIN_W)),
    h: Math.max(ZONE_MIN_H, num(raw.h, ZONE_MIN_H)),
    k: ZONE_KINDS.includes(raw.k) ? raw.k : 'normal',
    p: raw.p ? 1 : 0,
    t: typeof raw.t === 'string' ? raw.t.slice(0, ZONE_LABEL_MAX) : '',
    ts: num(raw.ts, now),
    mt: num(raw.mt, num(raw.ts, now)),
  };
  if (raw.del) z.del = num(raw.del, now);
  return z;
}

// ---------------------------------------------------------------- geometry (rectangles are { x, y, w, h })

export const rectOf = (z) => ({ x: z.x, y: z.y, w: z.w, h: z.h });

export function containsPoint(rect, p) {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

/** The middle of a note. `height` is its real height on screen when known; otherwise its minimum height. */
export function noteCentre(note, height = 0) {
  return { x: note.x + note.w / 2, y: note.y + (height || note.h || NOTE_H) / 2 };
}

/** Is `inner` entirely inside `outer` (give or take `tolerance`)? */
export function rectInside(inner, outer, tolerance = 1) {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.w <= outer.x + outer.w + tolerance
    && inner.y + inner.h <= outer.y + outer.h + tolerance;
}

/** The ids of the notes whose centre is inside `rect`. `heightOf(note)` gives a note's real height (optional). */
export function notesInside(rect, notes, heightOf = () => 0) {
  const ids = [];
  for (const n of notes) if (containsPoint(rect, noteCentre(n, heightOf(n)))) ids.push(n.id);
  return ids;
}

/**
 * What travels along when `zone` is dragged: the notes whose centre is inside it and the zones that lie entirely
 * inside it. Pinned notes (lock) stay where they are, because pinning means "never move this by accident";
 * `pinned` counts them so the interface can say so.
 */
export function carriedBy(zone, notes, zones, heightOf = () => 0) {
  const noteIds = [];
  let pinned = 0;
  for (const n of notes) {
    if (!containsPoint(zone, noteCentre(n, heightOf(n)))) continue;
    if (n.lock) pinned++;
    else noteIds.push(n.id);
  }
  // A zone of exactly the same size is a twin, not a child: dragging one must not drag the other.
  const zoneIds = zones
    .filter((o) => o.id !== zone.id && rectInside(o, zone) && (o.w < zone.w - 1 || o.h < zone.h - 1))
    .map((o) => o.id);
  return { noteIds, zoneIds, pinned };
}

export function boundsOf(rects) {
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** A rectangle that wraps all of `rects` with some air around it (the G shortcut). Nothing is moved. */
export function wrapRect(rects, pad = ZONE_WRAP_PAD) {
  const b = boundsOf(rects);
  return b && { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

/** The size of a new zone in board units: it covers about the same part of the screen at any zoom level. */
export function defaultZoneSize(zoom) {
  const k = 1 / (zoom || 1);
  return {
    w: clamp(Math.round(ZONE_SCREEN_W * k), 200, 4000),
    h: clamp(Math.round(ZONE_SCREEN_H * k), 140, 2700),
  };
}

/** The rectangle between two corners, whichever way it was dragged. */
export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Grow a rectangle to the minimum zone size, keeping its top-left corner. */
export function atLeastMinimum(rect) {
  return { ...rect, w: Math.max(rect.w, ZONE_MIN_W), h: Math.max(rect.h, ZONE_MIN_H) };
}

/**
 * Resize by dragging a handle ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw') by (dx, dy) board units.
 * The opposite edges stay put and the rectangle never gets smaller than the minimum.
 */
export function resizeRect(rect, handle, dx, dy, minW = ZONE_MIN_W, minH = ZONE_MIN_H) {
  let { x, y, w, h } = rect;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes('e')) w = Math.max(minW, w + dx);
  if (handle.includes('s')) h = Math.max(minH, h + dy);
  if (handle.includes('w')) {
    const nx = Math.min(x + dx, right - minW);
    w = right - nx;
    x = nx;
  }
  if (handle.includes('n')) {
    const ny = Math.min(y + dy, bottom - minH);
    h = bottom - ny;
    y = ny;
  }
  return { x, y, w, h };
}

// ---------------------------------------------------------------- stacking and cover

const area = (z) => z.w * z.h;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Draw order: the biggest zone first (at the bottom), so a small zone inside a big one is always reachable. */
export function sortForRender(zones) {
  return [...zones].sort((a, b) => area(b) - area(a) || a.ts - b.ts || byId(a, b));
}

/** Smallest first: the innermost zone around a point comes first. */
export function sortSmallestFirst(zones) {
  return sortForRender(zones).reverse();
}

/** The zones that contain `point`, in the order of `zones` (pass them smallest first to get the innermost first). */
export function zonesAround(point, zones) {
  return zones.filter((z) => containsPoint(z, point));
}
