// Tests for the pure logic of the interface (no browser needed). Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks, shortUrl, breakable, fold, timeAgo, clamp, readingOrder } from '../public/js/util.js';
import { mergeBoards } from '../public/js/merge.js';

const links = (text) => splitLinks(text).filter((t) => t.type === 'link').map((t) => t.value);
const texts = (text) => splitLinks(text).filter((t) => t.type === 'text').map((t) => t.value);

test('splitLinks: separates links and drops trailing punctuation', () => {
  const parts = splitLinks('See https://a.com/x. Then come back');
  assert.deepEqual(parts.map((p) => p.value), ['See ', 'https://a.com/x', '. Then come back']);
  assert.equal(parts[1].type, 'link');
  assert.equal(parts[1].href, 'https://a.com/x');
});

test('splitLinks: keeps balanced parentheses inside a link (Wikipedia) and drops extra ones', () => {
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(links('(see https://a.com/x)'), ['https://a.com/x']);
  assert.deepEqual(texts('(see https://a.com/x)'), ['(see ', ')']);
});

test('splitLinks: www. gets https, several links, non-ASCII text around them', () => {
  const sample = 'Tài liệu: www.example.com/abc, và http://localhost:3000/a?b=1&c=2\nhết';
  const parts = splitLinks(sample);
  const found = parts.filter((p) => p.type === 'link');
  assert.equal(found.length, 2);
  assert.equal(found[0].href, 'https://www.example.com/abc');
  assert.equal(found[1].href, 'http://localhost:3000/a?b=1&c=2');
  assert.equal(parts.map((p) => p.value).join(''), sample);
});

test('splitLinks: plain words and dangerous protocols never become links', () => {
  assert.deepEqual(links('javascript:alert(1) and file.txt and node.js and ASP.NET'), []);
  assert.deepEqual(links(''), []);
  assert.deepEqual(splitLinks('just words'), [{ type: 'text', value: 'just words' }]);
});

test('splitLinks: joining the parts always gives back the original text', () => {
  const samples = [
    'a https://x.com/p.q?r=1#h) b',
    'https://a.com https://b.com',
    '"https://quoted.com/path"',
    'end of sentence https://a.com/b!',
  ];
  for (const s of samples) assert.equal(splitLinks(s).map((p) => p.value).join(''), s);
});

test('shortUrl: drops the protocol, www and trailing slash, and decodes percent-encoded text', () => {
  assert.equal(shortUrl('https://www.example.com/'), 'example.com');
  assert.equal(shortUrl('http://example.com/a/b'), 'example.com/a/b');
  assert.equal(shortUrl('https://vi.wikipedia.org/wiki/Vi%E1%BB%87t_Nam'), 'vi.wikipedia.org/wiki/Việt_Nam');
  assert.equal(shortUrl('https://a.com/%E0%A4%A'), 'a.com/%E0%A4%A', 'a broken escape sequence is left as it is');
});

test('shortUrl: a very long link is shortened in the middle but keeps its start and end', () => {
  const long = `https://example.com/${'a'.repeat(80)}/end-of-link`;
  const short = shortUrl(long);
  assert.ok(short.length < 50);
  assert.ok(short.startsWith('example.com/aaaa'));
  assert.equal(short.slice(-10), long.slice(-10), 'the last 10 characters of the link are kept');
  assert.ok(short.includes('…'));
});

test('breakable: only adds break opportunities; removing them gives the original text', () => {
  const s = 'github.com/anthropics/claude-code/issues?id=1&x=2_y';
  const b = breakable(s);
  assert.ok(b.includes('​'));
  assert.equal(b.replaceAll('​', ''), s);
  assert.equal(breakable('nopunctuation'), 'nopunctuation');
});

test('fold: strips diacritics, maps đ to d and ignores case (search is forgiving)', () => {
  // Vietnamese fixtures: the original author searches notes written with and without diacritics.
  assert.equal(fold('Đường Hầm Cà Phê'), 'duong ham ca phe');
  assert.equal(fold('ĐỌC SAU'), 'doc sau');
  assert.ok(fold('Mua cà phê cho buổi họp').includes(fold('CA PHE')));
  assert.equal(fold('Crème brûlée'), 'creme brulee');
  assert.equal(fold(null), '');
});

test('timeAgo: relative time follows the interface language, then falls back to a date', () => {
  const now = 1_700_000_000_000;
  assert.equal(timeAgo(now - 10_000, { now, justNow: 'just now' }), 'just now');
  assert.equal(timeAgo(now - 5 * 60_000, { now, lang: 'en' }), '5 minutes ago');
  assert.equal(timeAgo(now - 3 * 3_600_000, { now, lang: 'en' }), '3 hours ago');
  assert.equal(timeAgo(now - 2 * 86_400_000, { now, lang: 'en' }), '2 days ago');
  assert.equal(timeAgo(now - 5 * 60_000, { now, lang: 'vi' }), '5 phút trước');
  assert.match(timeAgo(now - 90 * 86_400_000, { now, lang: 'en' }), /2023/);
});

test('readingOrder: rows top to bottom, left to right within a row, tolerant of sloppy placement', () => {
  const n = (id, x, y) => ({ id, x, y });
  // Row 1 notes are a few dozen px out of line; row 2 is below.
  const input = [n('r2-b', 400, 300), n('r1-c', 700, 56), n('r2-a', 50, 310), n('r1-a', 60, 100), n('r1-b', 330, 40)];
  assert.deepEqual(readingOrder(input).map((x) => x.id), ['r1-a', 'r1-b', 'r1-c', 'r2-a', 'r2-b']);
  assert.deepEqual(input.map((x) => x.id), ['r2-b', 'r1-c', 'r2-a', 'r1-a', 'r1-b'], 'the input array is not modified');
  assert.deepEqual(readingOrder([]), []);
  assert.deepEqual(readingOrder([n('only', 1, 1)]).map((x) => x.id), ['only']);
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

// ---------------------------------------------------------------- merging

const note = (id, mt, extra = {}) => ({ id, x: 0, y: 0, t: id, mt, ...extra });
const ids = (list) => list.map((n) => n.id).sort();

test('mergeBoards: keeps every note that exists on only one side', () => {
  const merged = mergeBoards(
    { notes: [note('a', 1), note('local-only', 5)], trash: [] },
    { notes: [note('a', 1), note('remote-only', 6)], trash: [] },
  );
  assert.deepEqual(ids(merged.notes), ['a', 'local-only', 'remote-only']);
  assert.deepEqual(merged.trash, []);
});

test('mergeBoards: for the same note the later edit wins, note by note', () => {
  const local = { notes: [note('a', 10, { x: 100 }), note('b', 1, { x: 1 })], trash: [] };
  const remote = { notes: [note('a', 5, { x: 50 }), note('b', 9, { x: 90 })], trash: [] };
  const merged = mergeBoards(local, remote);
  const byId = Object.fromEntries(merged.notes.map((n) => [n.id, n]));
  assert.equal(byId.a.x, 100, 'a: the local copy is newer');
  assert.equal(byId.b.x, 90, 'b: the remote copy is newer');
});

test('mergeBoards: a later delete sends the note to the trash, a later edit keeps it', () => {
  const deletedLater = mergeBoards(
    { notes: [note('a', 5)], trash: [] },
    { notes: [], trash: [note('a', 9, { del: 9 })] },
  );
  assert.deepEqual(ids(deletedLater.notes), []);
  assert.deepEqual(ids(deletedLater.trash), ['a']);

  const editedLater = mergeBoards(
    { notes: [note('a', 20)], trash: [] },
    { notes: [], trash: [note('a', 9, { del: 9 })] },
  );
  assert.deepEqual(ids(editedLater.notes), ['a']);
  assert.deepEqual(ids(editedLater.trash), []);
});

test('mergeBoards: on a tie the trash wins (a deleted note is never resurrected)', () => {
  const merged = mergeBoards(
    { notes: [note('a', 7)], trash: [] },
    { notes: [], trash: [note('a', 7, { del: 7 })] },
  );
  assert.deepEqual(ids(merged.trash), ['a']);
});

test('mergeBoards: tolerates missing data', () => {
  assert.deepEqual(mergeBoards({}, undefined), { notes: [], trash: [], zones: [], zonesTrash: [] });
  assert.deepEqual(ids(mergeBoards({ notes: [note('a', 1)] }, null).notes), ['a']);
});

// Zones follow the same rules as notes, in their own lists.
const zoneItem = (id, mt, extra = {}) => ({ id, x: 0, y: 0, w: 300, h: 200, k: 'normal', t: id, mt, ...extra });

test('mergeBoards: zones are merged like notes (later edit wins, later delete trashes, one-sided zones are kept)', () => {
  const merged = mergeBoards(
    {
      notes: [], trash: [],
      zones: [zoneItem('moved', 10, { x: 100 }), zoneItem('local-only', 1), zoneItem('doomed', 5)],
      zonesTrash: [],
    },
    {
      notes: [], trash: [],
      zones: [zoneItem('moved', 5, { x: 50 }), zoneItem('remote-only', 2)],
      zonesTrash: [zoneItem('doomed', 9, { del: 9 })],
    },
  );
  const byId = Object.fromEntries(merged.zones.map((z) => [z.id, z]));
  assert.deepEqual(ids(merged.zones), ['local-only', 'moved', 'remote-only']);
  assert.equal(byId.moved.x, 100, 'the local copy is newer');
  assert.deepEqual(ids(merged.zonesTrash), ['doomed'], 'the later delete wins');
});

test('mergeBoards: notes and zones never mix, even with the same id', () => {
  const merged = mergeBoards(
    { notes: [note('same', 5)], zones: [zoneItem('same', 5)] },
    { notes: [], trash: [note('same', 9, { del: 9 })], zones: [], zonesTrash: [] },
  );
  assert.deepEqual(ids(merged.notes), [], 'the note was trashed later');
  assert.deepEqual(ids(merged.trash), ['same']);
  assert.deepEqual(ids(merged.zones), ['same'], 'the zone with the same id is unaffected');
  assert.deepEqual(merged.zonesTrash, []);
});

test('mergeBoards: a board from before zones existed merges cleanly with one that has zones', () => {
  const old = { notes: [note('a', 1)], trash: [] }; // 1.1: no zones fields at all
  const fresh = { notes: [note('a', 1)], trash: [], zones: [zoneItem('z', 3)], zonesTrash: [] };
  assert.deepEqual(ids(mergeBoards(old, fresh).zones), ['z']);
  assert.deepEqual(ids(mergeBoards(fresh, old).zones), ['z']);
});
