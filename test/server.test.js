// Kiểm thử máy chủ: API, bảo mật, ảnh, backup và khôi phục. Chạy: npm test

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
const note = (id, extra = {}) => ({ id, k: 'text', x: 10, y: 20, w: 220, t: `ghi chú ${id}`, mt: 1, ...extra });

async function boot(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stick-note-test-'))) {
  const app = createApp({ port: 0, dataDir: dir, logToConsole: false });
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

// Gửi request với header Host tùy ý (fetch không cho đổi Host).
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

test('ping cho biết đây là Stick Note', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/ping`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).app, APP_ID);
  } finally { await s.close(); }
});

test('bảng trống, lưu rồi đọc lại đúng nguyên văn tiếng Việt', async () => {
  const s = await boot();
  try {
    const empty = await s.get();
    assert.equal(empty.rev, 0);
    assert.deepEqual(empty.board, { notes: [], trash: [] });

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
    assert.equal(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')).length, 0, 'không để lại file tạm');
  } finally { await s.close(); }
});

test('request ghi phải có header riêng và Origin hợp lệ', async () => {
  const s = await boot();
  try {
    const board = { notes: [note('n1')], trash: [] };
    assert.equal((await s.put(0, board, {})).status, 403, 'thiếu header');
    assert.equal((await s.put(0, board, { ...WRITE, Origin: 'https://evil.example' })).status, 403, 'Origin lạ');
    assert.equal((await s.put(0, board, { ...WRITE, Origin: s.base })).status, 200, 'Origin của chính app');
    assert.equal((await s.get()).rev, 1);
  } finally { await s.close(); }
});

test('từ chối Host lạ (chống DNS rebinding)', async () => {
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

test('baseRev cũ nhận 409 kèm bảng hiện tại để gộp', async () => {
  const s = await boot();
  try {
    await s.put(0, { notes: [note('a')], trash: [] });
    const stale = await s.put(0, { notes: [note('b')], trash: [] });
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.rev, 1);
    assert.deepEqual(body.board.notes.map((n) => n.id), ['a']);
    assert.deepEqual((await s.get()).board.notes.map((n) => n.id), ['a'], 'bản cũ không ghi đè được');
  } finally { await s.close(); }
});

test('từ chối dữ liệu bảng sai định dạng', async () => {
  const s = await boot();
  try {
    assert.equal((await s.put(0, { notes: 'x', trash: [] })).status, 400);
    assert.equal((await s.put(0, { notes: [{ nope: 1 }], trash: [] })).status, 400);
    assert.equal((await s.put(0, null)).status, 400);
    const raw = await fetch(`${s.base}/api/board`, { method: 'PUT', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(raw.status, 400);
    assert.equal((await s.get()).rev, 0, 'dữ liệu cũ vẫn nguyên');
  } finally { await s.close(); }
});

test('mỗi ngày có một bản backup, là trạng thái trước khi ghi đè', async () => {
  const s = await boot();
  try {
    await s.put(0, { notes: [note('first')], trash: [] });
    const backups = path.join(s.dir, 'backups');
    assert.equal(fs.readdirSync(backups).length, 0, 'lần ghi đầu chưa có gì để backup');
    await s.put(1, { notes: [note('first'), note('second')], trash: [] });
    const file = path.join(backups, `board-${today()}.json`);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.id), ['first']);
    await s.put(2, { notes: [note('first'), note('second'), note('third')], trash: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.id), ['first'], 'không ghi đè backup của ngày');
  } finally { await s.close(); }
});

test('số mảnh giấy giảm mạnh thì giữ thêm một bản backup riêng', async () => {
  const s = await boot();
  try {
    const many = Array.from({ length: 10 }, (_, i) => note(`n${i}`));
    await s.put(0, { notes: many, trash: [] });
    await s.put(1, { notes: many.slice(0, 2), trash: [] });
    const shrink = fs.readdirSync(path.join(s.dir, 'backups')).filter((f) => f.includes('before-shrink'));
    assert.equal(shrink.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'backups', shrink[0]), 'utf8'));
    assert.equal(saved.notes.length, 10, 'bản backup chứa đủ 10 mảnh trước khi giảm');
  } finally { await s.close(); }
});

test('board.json hỏng thì tự khôi phục từ backup mới nhất', async () => {
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
      assert.ok(fs.readdirSync(s.dir).some((f) => f.startsWith('board.corrupt-')), 'file hỏng được giữ lại để xem');
    } finally { await s2.close({ keep: true }); }
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('khởi động lại server vẫn nhớ dữ liệu và số revision', async () => {
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

test('ảnh: tải lên theo nội dung, trùng thì dùng chung, phục vụ với cache lâu dài', async () => {
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

test('ảnh: từ chối file không phải ảnh, id sai và đường dẫn thoát thư mục', async () => {
  const s = await boot();
  try {
    const junk = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: Buffer.from('<script>alert(1)</script> this is not an image') });
    assert.equal(junk.status, 415);
    assert.equal((await fetch(`${s.base}/img/${'a'.repeat(40)}.png`)).status, 404);
    assert.equal((await fetch(`${s.base}/img/..%2f..%2fboard.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/img/not-an-id`)).status, 404);
    const noHeader = await fetch(`${s.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
    assert.equal(noHeader.status, 403);
  } finally { await s.close(); }
});

test('ảnh thu nhỏ chỉ nhận khi ảnh gốc đã có', async () => {
  const s = await boot();
  try {
    const post = (of) => fetch(`${s.base}/api/thumb?of=${of}`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: PNG });
    assert.equal((await post(`${'b'.repeat(40)}.png`)).status, 400, 'gốc chưa có');
    assert.equal((await post('../../etc/passwd')).status, 400, 'id sai');
    const { id } = await (await fetch(`${s.base}/api/images`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'image/png' }, body: PNG })).json();
    const res = await post(id);
    assert.equal(res.status, 200);
    const thumb = await res.json();
    assert.equal(thumb.id, `${id.split('.')[0]}.thumb.png`);
    assert.equal((await fetch(`${s.base}/img/${thumb.id}`)).status, 200);
  } finally { await s.close(); }
});

test('file tĩnh: có CSP, chặn thoát thư mục, 404 khi không có', async () => {
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

test('sniffImage nhận đúng định dạng theo nội dung chứ không theo đuôi', () => {
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'gif');
  assert.equal(sniffImage(Buffer.from('RIFF....WEBPVP8 ')), 'webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(Buffer.alloc(3)), null);
});
