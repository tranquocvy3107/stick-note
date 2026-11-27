// Kiểm thử phần logic thuần của giao diện (không cần trình duyệt). Chạy: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks, shortUrl, breakable, fold, timeAgo, clamp, readingOrder } from '../public/js/util.js';
import { mergeBoards } from '../public/js/merge.js';

const links = (text) => splitLinks(text).filter((t) => t.type === 'link').map((t) => t.value);
const texts = (text) => splitLinks(text).filter((t) => t.type === 'text').map((t) => t.value);

test('splitLinks: tách link và bỏ dấu câu ở cuối', () => {
  const parts = splitLinks('Xem https://a.com/x. Rồi quay lại');
  assert.deepEqual(parts.map((p) => p.value), ['Xem ', 'https://a.com/x', '. Rồi quay lại']);
  assert.equal(parts[1].type, 'link');
  assert.equal(parts[1].href, 'https://a.com/x');
});

test('splitLinks: giữ ngoặc đơn cân bằng trong link (Wikipedia), bỏ ngoặc thừa', () => {
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(links('(xem https://a.com/x)'), ['https://a.com/x']);
  assert.deepEqual(texts('(xem https://a.com/x)'), ['(xem ', ')']);
});

test('splitLinks: www. được thêm https, nhiều link, tiếng Việt xung quanh', () => {
  const parts = splitLinks('Tài liệu: www.example.com/abc, và http://localhost:3000/a?b=1&c=2\nhết');
  const found = parts.filter((p) => p.type === 'link');
  assert.equal(found.length, 2);
  assert.equal(found[0].href, 'https://www.example.com/abc');
  assert.equal(found[1].href, 'http://localhost:3000/a?b=1&c=2');
  assert.equal(parts.map((p) => p.value).join(''), 'Tài liệu: www.example.com/abc, và http://localhost:3000/a?b=1&c=2\nhết');
});

test('splitLinks: không biến chữ thường và giao thức nguy hiểm thành link', () => {
  assert.deepEqual(links('javascript:alert(1) và file.txt và node.js và ASP.NET'), []);
  assert.deepEqual(links(''), []);
  assert.deepEqual(splitLinks('chỉ có chữ'), [{ type: 'text', value: 'chỉ có chữ' }]);
});

test('splitLinks: nối các đoạn lại luôn ra đúng văn bản gốc', () => {
  const samples = [
    'a https://x.com/p.q?r=1#h) b',
    'https://a.com https://b.com',
    '"https://quoted.com/path"',
    'cuối câu https://a.com/b!',
  ];
  for (const s of samples) assert.equal(splitLinks(s).map((p) => p.value).join(''), s);
});

test('shortUrl: bỏ giao thức, www, dấu / cuối và giải mã chữ Việt', () => {
  assert.equal(shortUrl('https://www.example.com/'), 'example.com');
  assert.equal(shortUrl('http://example.com/a/b'), 'example.com/a/b');
  assert.equal(shortUrl('https://vi.wikipedia.org/wiki/Vi%E1%BB%87t_Nam'), 'vi.wikipedia.org/wiki/Việt_Nam');
  assert.equal(shortUrl('https://a.com/%E0%A4%A'), 'a.com/%E0%A4%A', 'mã hóa dở dang thì giữ nguyên');
});

test('shortUrl: link quá dài được rút gọn ở giữa nhưng giữ đầu và đuôi', () => {
  const long = `https://example.com/${'a'.repeat(80)}/end-of-link`;
  const short = shortUrl(long);
  assert.ok(short.length < 50);
  assert.ok(short.startsWith('example.com/aaaa'));
  assert.equal(short.slice(-10), long.slice(-10), 'giữ nguyên 10 ký tự cuối của link');
  assert.ok(short.includes('…'));
});

test('breakable: chỉ thêm điểm xuống dòng, bỏ đi thì ra đúng chữ cũ', () => {
  const s = 'github.com/anthropics/claude-code/issues?id=1&x=2_y';
  const b = breakable(s);
  assert.ok(b.includes('​'));
  assert.equal(b.replaceAll('​', ''), s);
  assert.equal(breakable('khongcodau'), 'khongcodau');
});

test('fold: bỏ dấu tiếng Việt, đ thành d, không phân biệt hoa thường', () => {
  assert.equal(fold('Đường Hầm Cà Phê'), 'duong ham ca phe');
  assert.equal(fold('ĐỌC SAU'), 'doc sau');
  assert.ok(fold('Mua cà phê cho buổi họp').includes(fold('CA PHE')));
  assert.equal(fold(null), '');
});

test('timeAgo: mô tả thời gian bằng tiếng Việt', () => {
  const now = 1_700_000_000_000;
  assert.equal(timeAgo(now - 10_000, now), 'vừa xong');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5 phút trước');
  assert.equal(timeAgo(now - 3 * 3_600_000, now), '3 giờ trước');
  assert.equal(timeAgo(now - 2 * 86_400_000, now), '2 ngày trước');
  assert.match(timeAgo(now - 90 * 86_400_000, now), /^\d{2}\/\d{2}\/\d{4}$/);
});

test('readingOrder: hàng từ trên xuống, trong hàng từ trái sang phải, chịu được lệch tay', () => {
  const n = (id, x, y) => ({ id, x, y });
  // Hàng 1 dán lệch nhau vài chục px, hàng 2 ở dưới.
  const input = [n('r2-b', 400, 300), n('r1-c', 700, 56), n('r2-a', 50, 310), n('r1-a', 60, 100), n('r1-b', 330, 40)];
  assert.deepEqual(readingOrder(input).map((x) => x.id), ['r1-a', 'r1-b', 'r1-c', 'r2-a', 'r2-b']);
  assert.deepEqual(input.map((x) => x.id), ['r2-b', 'r1-c', 'r2-a', 'r1-a', 'r1-b'], 'không đổi mảng gốc');
  assert.deepEqual(readingOrder([]), []);
  assert.deepEqual(readingOrder([n('only', 1, 1)]).map((x) => x.id), ['only']);
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

// ---------------------------------------------------------------- gộp dữ liệu

const note = (id, mt, extra = {}) => ({ id, x: 0, y: 0, t: id, mt, ...extra });
const ids = (list) => list.map((n) => n.id).sort();

test('mergeBoards: giữ mọi mảnh giấy chỉ có ở một phía', () => {
  const merged = mergeBoards(
    { notes: [note('a', 1), note('local-only', 5)], trash: [] },
    { notes: [note('a', 1), note('remote-only', 6)], trash: [] },
  );
  assert.deepEqual(ids(merged.notes), ['a', 'local-only', 'remote-only']);
  assert.deepEqual(merged.trash, []);
});

test('mergeBoards: cùng một mảnh giấy thì bản sửa muộn hơn thắng, theo từng mảnh', () => {
  const local = { notes: [note('a', 10, { x: 100 }), note('b', 1, { x: 1 })], trash: [] };
  const remote = { notes: [note('a', 5, { x: 50 }), note('b', 9, { x: 90 })], trash: [] };
  const merged = mergeBoards(local, remote);
  const byId = Object.fromEntries(merged.notes.map((n) => [n.id, n]));
  assert.equal(byId.a.x, 100, 'a: bản local mới hơn');
  assert.equal(byId.b.x, 90, 'b: bản remote mới hơn');
});

test('mergeBoards: xóa muộn hơn sửa thì mảnh giấy vào thùng rác, sửa muộn hơn xóa thì còn nguyên', () => {
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

test('mergeBoards: bằng thời gian thì ưu tiên thùng rác (không làm sống lại mảnh đã xóa)', () => {
  const merged = mergeBoards(
    { notes: [note('a', 7)], trash: [] },
    { notes: [], trash: [note('a', 7, { del: 7 })] },
  );
  assert.deepEqual(ids(merged.trash), ['a']);
});

test('mergeBoards: chịu được dữ liệu thiếu', () => {
  assert.deepEqual(mergeBoards({}, undefined), { notes: [], trash: [] });
  assert.deepEqual(ids(mergeBoards({ notes: [note('a', 1)] }, null).notes), ['a']);
});
