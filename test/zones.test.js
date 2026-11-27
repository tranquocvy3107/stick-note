// Tests for the zone logic (geometry, membership, saved data). Pure functions: no browser needed. Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeZone, containsPoint, noteCentre, rectInside, notesInside, carriedBy, boundsOf, wrapRect, defaultZoneSize,
  rectFromPoints, atLeastMinimum, resizeRect, sortForRender, sortSmallestFirst, zonesAround,
} from '../public/js/zones.js';
import { NOTE_H, ZONE_MIN_W, ZONE_MIN_H, ZONE_LABEL_MAX, ZONE_WRAP_PAD } from '../public/js/constants.js';

const zone = (id, x, y, w, h, extra = {}) => ({ id, x, y, w, h, k: 'normal', ts: 1, mt: 1, ...extra });
const note = (id, x, y, extra = {}) => ({ id, x, y, w: 200, ...extra }); // 200 wide, minimum height NOTE_H (112)

test('normalizeZone: fills defaults, keeps good values and refuses nonsense', () => {
  const z = normalizeZone({ id: 7, x: '10', y: 20.5, w: 300, h: 200, k: 'low', p: 1, t: 'Taxes', ts: 5, mt: 9 });
  assert.deepEqual(z, { id: '7', x: 10, y: 20.5, w: 300, h: 200, k: 'low', p: 1, t: 'Taxes', ts: 5, mt: 9 });

  const bad = normalizeZone({ id: 'a', x: 'abc', y: null, w: 5, h: -3, k: 'huge', p: 'yes', t: 42 }, 1000);
  assert.equal(bad.x, 0);
  assert.equal(bad.y, 0);
  assert.equal(bad.w, ZONE_MIN_W, 'too narrow: raised to the minimum');
  assert.equal(bad.h, ZONE_MIN_H, 'too short: raised to the minimum');
  assert.equal(bad.k, 'normal', 'an unknown kind becomes normal');
  assert.equal(bad.p, 1);
  assert.equal(bad.t, '', 'a label that is not text is dropped');
  assert.equal(bad.ts, 1000);
  assert.equal(bad.mt, 1000);
  assert.ok(!('del' in bad));
  assert.equal(normalizeZone({ id: 'a', del: 77 }).del, 77, 'a trashed zone keeps its deletion time');
  assert.equal(normalizeZone({ id: 'a', t: 'x'.repeat(500) }).t.length, ZONE_LABEL_MAX, 'long labels are cut');
});

test('containsPoint: the edges count as inside', () => {
  const r = { x: 0, y: 0, w: 100, h: 50 };
  assert.ok(containsPoint(r, { x: 0, y: 0 }));
  assert.ok(containsPoint(r, { x: 100, y: 50 }));
  assert.ok(!containsPoint(r, { x: 100.5, y: 10 }));
  assert.ok(!containsPoint(r, { x: -1, y: 10 }));
});

test('noteCentre: uses the real height when known, then the note\'s own minimum, then the default', () => {
  assert.deepEqual(noteCentre(note('a', 10, 20), 300), { x: 110, y: 170 });
  assert.deepEqual(noteCentre(note('a', 10, 20, { h: 80 })), { x: 110, y: 60 });
  assert.deepEqual(noteCentre(note('a', 10, 20)), { x: 110, y: 20 + NOTE_H / 2 });
});

test('notesInside: a note belongs to a zone by its centre, not by touching it', () => {
  const z = zone('z', 0, 0, 400, 300);
  const notes = [
    note('inside', 50, 50),
    note('overhangs', 300, 100), // centre x = 400: on the edge, counts; most of the note sticks out
    note('mostly-in-centre-out', 250, 100), // centre x = 350: inside
    note('touches-only', 405, 100), // centre x = 505: outside although the note is near
    note('below', 50, 400),
  ];
  assert.deepEqual(notesInside(z, notes), ['inside', 'overhangs', 'mostly-in-centre-out']);
  // The real height of a tall note moves its centre: here it drops out of the zone.
  assert.deepEqual(notesInside(z, [note('tall', 50, 200)], () => 800), []);
  assert.deepEqual(notesInside(z, []), []);
});

test('rectInside: tolerance of a pixel, otherwise strict', () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 };
  assert.ok(rectInside({ x: 10, y: 10, w: 20, h: 20 }, outer));
  assert.ok(rectInside({ x: -1, y: 0, w: 101, h: 100 }, outer), 'one pixel of slack');
  assert.ok(!rectInside({ x: -2, y: 0, w: 50, h: 50 }, outer));
  assert.ok(!rectInside({ x: 60, y: 60, w: 50, h: 50 }, outer));
});

test('carriedBy: notes by centre, zones only when entirely inside, pinned notes stay, twins are not children', () => {
  const big = zone('big', 0, 0, 1000, 800);
  const child = zone('child', 100, 100, 300, 200);
  const overlapping = zone('overlap', 900, 100, 300, 200); // sticks out of big: independent
  const twin = zone('twin', 0, 0, 1000, 800);
  const outside = zone('outside', 2000, 0, 300, 200);
  const notes = [
    note('free', 500, 500),
    note('pinned', 600, 500, { lock: 1 }),
    note('far', 3000, 3000),
    note('in-child', 120, 120),
  ];
  const carried = carriedBy(big, notes, [big, child, overlapping, twin, outside]);
  assert.deepEqual(carried.noteIds, ['free', 'in-child']);
  assert.equal(carried.pinned, 1, 'the pinned note is counted but not carried');
  assert.deepEqual(carried.zoneIds, ['child']);

  // Dragging the child carries its note but not the big zone around it.
  const fromChild = carriedBy(child, notes, [big, child]);
  assert.deepEqual(fromChild.noteIds, ['in-child']);
  assert.deepEqual(fromChild.zoneIds, []);
});

test('boundsOf and wrapRect: the box around some rectangles, with air around it; nothing for an empty list', () => {
  const rects = [{ x: 10, y: 20, w: 100, h: 50 }, { x: 200, y: 0, w: 80, h: 40 }];
  assert.deepEqual(boundsOf(rects), { x: 10, y: 0, w: 270, h: 70 });
  assert.deepEqual(wrapRect(rects), {
    x: 10 - ZONE_WRAP_PAD, y: -ZONE_WRAP_PAD, w: 270 + ZONE_WRAP_PAD * 2, h: 70 + ZONE_WRAP_PAD * 2,
  });
  assert.deepEqual(wrapRect(rects, 0), { x: 10, y: 0, w: 270, h: 70 });
  assert.equal(boundsOf([]), null);
  assert.equal(wrapRect([]), null);
});

test('defaultZoneSize: covers about the same part of the screen at any zoom, within limits', () => {
  const at1 = defaultZoneSize(1);
  const at05 = defaultZoneSize(0.5);
  assert.equal(at05.w, at1.w * 2);
  assert.equal(at05.h, at1.h * 2);
  assert.ok(defaultZoneSize(4).w >= 200, 'zoomed far in: not tiny');
  assert.ok(defaultZoneSize(0.01).w <= 4000, 'zoomed far out: not absurd');
  assert.ok(defaultZoneSize(0).w > 0, 'a zero zoom is treated as 1');
});

test('rectFromPoints and atLeastMinimum', () => {
  assert.deepEqual(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, w: 40, h: 60 });
  assert.deepEqual(atLeastMinimum({ x: 5, y: 6, w: 10, h: 10 }), { x: 5, y: 6, w: ZONE_MIN_W, h: ZONE_MIN_H });
  assert.deepEqual(atLeastMinimum({ x: 5, y: 6, w: 500, h: 400 }), { x: 5, y: 6, w: 500, h: 400 });
});

test('resizeRect: each handle moves its own edges and the opposite ones stay put', () => {
  const r = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(resizeRect(r, 'e', 50, 999), { x: 100, y: 100, w: 450, h: 300 });
  assert.deepEqual(resizeRect(r, 's', 999, 40), { x: 100, y: 100, w: 400, h: 340 });
  assert.deepEqual(resizeRect(r, 'se', 10, 20), { x: 100, y: 100, w: 410, h: 320 });
  assert.deepEqual(resizeRect(r, 'w', -30, 0), { x: 70, y: 100, w: 430, h: 300 });
  assert.deepEqual(resizeRect(r, 'n', 0, -25), { x: 100, y: 75, w: 400, h: 325 });
  assert.deepEqual(resizeRect(r, 'nw', 20, 10), { x: 120, y: 110, w: 380, h: 290 });
  assert.deepEqual(resizeRect(r, 'ne', 20, -10), { x: 100, y: 90, w: 420, h: 310 });
  assert.deepEqual(resizeRect(r, 'sw', -20, 10), { x: 80, y: 100, w: 420, h: 310 });
});

test('resizeRect: never smaller than the minimum, and the far edge does not move when shrinking from the near one', () => {
  const r = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(resizeRect(r, 'e', -9999, 0), { x: 100, y: 100, w: ZONE_MIN_W, h: 300 });
  assert.deepEqual(resizeRect(r, 'w', 9999, 0), { x: 500 - ZONE_MIN_W, y: 100, w: ZONE_MIN_W, h: 300 });
  assert.deepEqual(resizeRect(r, 'n', 0, 9999), { x: 100, y: 400 - ZONE_MIN_H, w: 400, h: ZONE_MIN_H });
  assert.deepEqual(resizeRect(r, 's', 0, -9999), { x: 100, y: 100, w: 400, h: ZONE_MIN_H });
});

test('sortForRender: biggest first so a small zone inside a big one stays on top; ties are stable', () => {
  const a = zone('a', 0, 0, 100, 100, { ts: 5 });
  const b = zone('b', 0, 0, 500, 500, { ts: 9 });
  const c = zone('c', 0, 0, 100, 100, { ts: 2 });
  const d = zone('d', 0, 0, 100, 100, { ts: 2 });
  assert.deepEqual(sortForRender([a, b, c, d]).map((z) => z.id), ['b', 'c', 'd', 'a']);
  assert.deepEqual(sortSmallestFirst([a, b, c, d]).map((z) => z.id), ['a', 'd', 'c', 'b']);
  const input = [a, b];
  sortForRender(input);
  assert.deepEqual(input.map((z) => z.id), ['a', 'b'], 'the input array is not modified');
});

test('zonesAround: the zones that hold a point, keeping the order given (innermost first when sorted smallest first)', () => {
  const big = zone('big', 0, 0, 1000, 1000);
  const small = zone('small', 100, 100, 200, 200);
  const away = zone('away', 2000, 2000, 100, 100);
  const ordered = sortSmallestFirst([big, small, away]);
  assert.deepEqual(zonesAround({ x: 150, y: 150 }, ordered).map((z) => z.id), ['small', 'big']);
  assert.deepEqual(zonesAround({ x: 800, y: 800 }, ordered).map((z) => z.id), ['big']);
  assert.deepEqual(zonesAround({ x: -5, y: -5 }, ordered), []);
});
