#!/usr/bin/env node
// Stick Note — máy chủ cục bộ (không phụ thuộc thư viện ngoài).
//
// - Phục vụ giao diện web trong thư mục ./public
// - Lưu dữ liệu (board.json, ảnh, backup) trong thư mục ./data (đổi bằng STICK_NOTE_DATA)
// - Chỉ lắng nghe 127.0.0.1, từ chối request lạ (kiểm tra Host, Origin và header riêng)
//
// Cách chạy:
//   node server.js           chạy ở chế độ thường (xem log trên màn hình)
//   node server.js --open    bật server nền (nếu chưa chạy) rồi mở cửa sổ app
//   node server.js --bg      chế độ nền: tự thoát khi không còn cửa sổ nào mở

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const APP_ID = 'stick-note';
// Số phiên bản chỉ ghi ở một nơi là package.json.
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
export const DEFAULT_PORT = 4747;

const MAX_BOARD_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_THUMB_BYTES = 8 * 1024 * 1024;
const KEEP_DAILY_BACKUPS = 60;
const KEEP_SPECIAL_BACKUPS = 30;
const IDLE_EXIT_MS = Number(process.env.STICK_NOTE_IDLE_MS) || 300_000; // tự tắt khi không còn cửa sổ nào mở

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const IMAGE_ID_RE = /^[a-f0-9]{40}(\.thumb)?\.(png|jpg|webp|gif)$/;
const ORIGINAL_ID_RE = /^[a-f0-9]{40}\.(png|jpg|webp|gif)$/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// ---------------------------------------------------------------- tiện ích

export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head = buf.toString('latin1', 0, 4);
  if (head === 'GIF8') return 'gif';
  if (head === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const stamp = (d = new Date()) =>
  `${localDay(d)}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Ghi file an toàn: ghi ra file tạm, fsync rồi mới đổi tên đè lên file thật.
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 5) {
        try { fs.unlinkSync(tmp); } catch { /* bỏ qua */ }
        throw err;
      }
      sleepSync(40 * (i + 1)); // OneDrive / antivirus đôi khi giữ file trong chốc lát
    }
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Dữ liệu gửi lên quá lớn'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!failed) reject(err); });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(text);
}

function cleanList(list, max) {
  if (!Array.isArray(list) || list.length > max) return null;
  for (const n of list) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || n.id.length === 0 || n.id.length > 64) {
      return null;
    }
  }
  return list;
}

// ---------------------------------------------------------------- ứng dụng

export function createApp({ port = DEFAULT_PORT, dataDir, publicDir = path.join(ROOT, 'public'), idleExitMs = 0, logToConsole = true } = {}) {
  if (!dataDir) throw new Error('dataDir là bắt buộc');
  dataDir = path.resolve(dataDir);
  publicDir = path.resolve(publicDir);

  const boardFile = path.join(dataDir, 'board.json');
  const imagesDir = path.join(dataDir, 'images');
  const backupsDir = path.join(dataDir, 'backups');
  const logFile = path.join(dataDir, 'server.log');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });

  let actualPort = port;
  let lastBeat = Date.now();
  const startedAt = Date.now();

  function log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
    if (logToConsole) console.log(line);
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) {
        fs.renameSync(logFile, path.join(dataDir, 'server.old.log'));
      }
      fs.appendFileSync(logFile, line + '\n');
    } catch { /* log lỗi thì thôi, không được làm sập server */ }
  }

  // ---- board.json -----------------------------------------------------
  function readBoardFile(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.notes)) throw new Error('không đúng định dạng bảng');
    return {
      rev: Number(data.rev) || 0,
      notes: data.notes,
      trash: Array.isArray(data.trash) ? data.trash : [],
      savedAt: data.savedAt || null,
    };
  }

  function loadBoard() {
    const empty = { rev: 0, notes: [], trash: [], savedAt: null };
    if (!fs.existsSync(boardFile)) return empty;
    try {
      return readBoardFile(boardFile);
    } catch (err) {
      log('board.json bị hỏng:', err.message);
      try { fs.renameSync(boardFile, path.join(dataDir, `board.corrupt-${stamp()}.json`)); } catch { /* bỏ qua */ }
      const candidates = fs.readdirSync(backupsDir).filter((f) => /^board-.*\.json$/.test(f)).sort().reverse();
      for (const f of candidates) {
        try {
          const restored = readBoardFile(path.join(backupsDir, f));
          restored.rev += 1;
          log('đã khôi phục bảng từ backup', f);
          return restored;
        } catch { /* thử backup kế tiếp */ }
      }
      return empty;
    }
  }

  let board = loadBoard();

  function pruneBackups() {
    try {
      const files = fs.readdirSync(backupsDir);
      const daily = files.filter((f) => /^board-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const f of daily.slice(0, Math.max(0, daily.length - KEEP_DAILY_BACKUPS))) fs.unlinkSync(path.join(backupsDir, f));
      const special = files.filter((f) => /^board-.*-(before-shrink|manual)\.json$/.test(f)).sort();
      for (const f of special.slice(0, Math.max(0, special.length - KEEP_SPECIAL_BACKUPS))) fs.unlinkSync(path.join(backupsDir, f));
    } catch (err) {
      log('Không dọn được backup cũ:', err.message);
    }
  }

  // Sao lưu trạng thái cũ trước khi ghi đè:
  //  - mỗi ngày một bản (là trạng thái cuối của ngày hôm trước)
  //  - thêm một bản khi số mảnh giấy giảm mạnh (phòng xóa nhầm hàng loạt hoặc lỗi)
  function backupBeforeWrite(nextNotes) {
    if (!fs.existsSync(boardFile)) return;
    const daily = path.join(backupsDir, `board-${localDay()}.json`);
    if (!fs.existsSync(daily)) fs.copyFileSync(boardFile, daily);
    const before = board.notes.length;
    if (before >= 8 && nextNotes.length < before * 0.6) {
      fs.copyFileSync(boardFile, path.join(backupsDir, `board-${stamp()}-before-shrink.json`));
      log(`Số mảnh giấy giảm từ ${before} xuống ${nextNotes.length}, đã lưu bản backup trước đó.`);
    }
    pruneBackups();
  }

  // ---- kiểm tra request ----------------------------------------------
  const allowedHosts = () => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`];
  const hostAllowed = (host) => !!host && allowedHosts().includes(host.toLowerCase());
  const originAllowed = (origin) => allowedHosts().some((h) => origin.toLowerCase() === `http://${h}`);

  // ---- API --------------------------------------------------------------
  async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;

    if (m !== 'GET' && m !== 'HEAD') {
      // Các request ghi bắt buộc có header riêng: trang web lạ không thể gửi kèm
      // mà không bị trình duyệt chặn ở bước preflight.
      if (req.headers['x-stick-note'] !== '1') return sendJson(res, 403, { error: 'Thiếu header X-Stick-Note' });
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin)) return sendJson(res, 403, { error: 'Origin không được phép' });
    }

    if (p === '/api/ping' && m === 'GET') {
      lastBeat = Date.now();
      return sendJson(res, 200, { app: APP_ID, version: VERSION, t: Date.now() });
    }

    if (p === '/api/rev' && m === 'GET') return sendJson(res, 200, { rev: board.rev });

    if (p === '/api/board' && m === 'GET') {
      return sendJson(res, 200, { rev: board.rev, savedAt: board.savedAt, board: { notes: board.notes, trash: board.trash } });
    }

    if (p === '/api/board' && m === 'PUT') return putBoard(req, res);

    if (p === '/api/images' && m === 'POST') return uploadImage(req, res);
    if (p === '/api/thumb' && m === 'POST') return uploadThumb(req, res, url);

    if (p === '/api/info' && m === 'GET') {
      const backups = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.json')).sort().reverse();
      return sendJson(res, 200, {
        app: APP_ID, version: VERSION, dataDir, port: actualPort, rev: board.rev,
        notes: board.notes.length, trash: board.trash.length, backups: backups.slice(0, 10),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    if (p === '/api/backup' && m === 'POST') {
      if (!fs.existsSync(boardFile)) return sendJson(res, 200, { file: null });
      const name = `board-${stamp()}-manual.json`;
      fs.copyFileSync(boardFile, path.join(backupsDir, name));
      pruneBackups();
      return sendJson(res, 200, { file: name });
    }

    if (p === '/api/open-data-folder' && m === 'POST') {
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      try {
        spawn(cmd, [dataDir], { detached: true, stdio: 'ignore' }).unref();
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
      return sendJson(res, 200, { ok: true, dataDir });
    }

    return sendJson(res, 404, { error: 'Không tìm thấy' });
  }

  async function putBoard(req, res) {
    let body;
    try {
      body = await readBody(req, MAX_BOARD_BYTES);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'JSON không hợp lệ' });
    }
    const incoming = data && data.board;
    const notes = cleanList(incoming && incoming.notes, 50_000);
    const trash = cleanList(incoming ? incoming.trash ?? [] : null, 50_000);
    if (!notes || !trash) return sendJson(res, 400, { error: 'Dữ liệu bảng không hợp lệ' });

    if (Number(data.baseRev) !== board.rev) {
      return sendJson(res, 409, { error: 'conflict', rev: board.rev, board: { notes: board.notes, trash: board.trash } });
    }
    try {
      backupBeforeWrite(notes);
      const next = { app: APP_ID, schema: 1, rev: board.rev + 1, savedAt: new Date().toISOString(), notes, trash };
      writeFileAtomic(boardFile, JSON.stringify(next));
      board = next;
    } catch (err) {
      log('Lỗi ghi board.json:', err.message);
      return sendJson(res, 500, { error: 'Không ghi được dữ liệu: ' + err.message });
    }
    return sendJson(res, 200, { rev: board.rev, savedAt: board.savedAt });
  }

  async function uploadImage(req, res) {
    let buf;
    try {
      buf = await readBody(req, MAX_IMAGE_BYTES);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
    const ext = sniffImage(buf);
    if (!ext) return sendJson(res, 415, { error: 'Chỉ nhận ảnh PNG, JPEG, WebP hoặc GIF' });
    const id = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
    const file = path.join(imagesDir, id);
    if (!fs.existsSync(file)) writeFileAtomic(file, buf);
    return sendJson(res, 200, { id });
  }

  async function uploadThumb(req, res, url) {
    const of = url.searchParams.get('of') || '';
    if (!ORIGINAL_ID_RE.test(of) || !fs.existsSync(path.join(imagesDir, of))) {
      return sendJson(res, 400, { error: 'Ảnh gốc không tồn tại' });
    }
    let buf;
    try {
      buf = await readBody(req, MAX_THUMB_BYTES);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
    const ext = sniffImage(buf);
    if (!ext || ext === 'gif') return sendJson(res, 415, { error: 'Ảnh thu nhỏ phải là PNG, JPEG hoặc WebP' });
    const id = `${of.split('.')[0]}.thumb.${ext}`;
    const file = path.join(imagesDir, id);
    if (!fs.existsSync(file)) writeFileAtomic(file, buf);
    return sendJson(res, 200, { id });
  }

  // ---- ảnh và file tĩnh ---------------------------------------------
  function serveImage(req, res, url) {
    let id;
    try { id = decodeURIComponent(url.pathname.slice('/img/'.length)); } catch { return sendText(res, 400, 'Bad request'); }
    if (!IMAGE_ID_RE.test(id)) return sendText(res, 404, 'Not found');
    const file = path.join(imagesDir, id);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendText(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(id)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...SECURITY_HEADERS,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return sendText(res, 400, 'Bad request'); }
    if (rel.includes('\0')) return sendText(res, 400, 'Bad request');
    if (rel === '/') rel = '/index.html';
    if (rel === '/favicon.ico') rel = '/icons/icon.svg';
    const abs = path.normalize(path.join(publicDir, rel));
    if (abs !== publicDir && !abs.startsWith(publicDir + path.sep)) return sendText(res, 403, 'Forbidden');
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) return sendText(res, 404, 'Not found');
      const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
      const ext = path.extname(abs).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        ETag: etag,
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      };
      if (ext === '.html') headers['Content-Security-Policy'] = HTML_CSP;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
    });
  }

  // ---- HTTP server ---------------------------------------------------
  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) return sendText(res, 403, 'Host không được phép');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendText(res, 400, 'Bad request'); }

    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        log('Lỗi API', req.method, url.pathname, err && err.stack ? err.stack : err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Lỗi máy chủ' });
        else res.destroy();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    if (url.pathname.startsWith('/img/')) return serveImage(req, res, url);
    return serveStatic(req, res, url);
  });

  let idleTimer = null;

  function stop() {
    if (idleTimer) clearInterval(idleTimer);
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        actualPort = server.address().port;
        lastBeat = Date.now();
        if (idleExitMs > 0) {
          let lastTick = Date.now();
          idleTimer = setInterval(() => {
            const now = Date.now();
            // Máy vừa ngủ dậy: đồng hồ nhảy vọt, cho cửa sổ app thời gian gửi lại nhịp tim.
            if (now - lastTick > 30_000) lastBeat = now;
            lastTick = now;
            if (now - lastBeat > idleExitMs) {
              log('Không còn cửa sổ nào đang mở, server tự tắt.');
              stop().then(() => process.exit(0));
            }
          }, 10_000);
        }
        log(`Stick Note ${VERSION} đang chạy tại http://127.0.0.1:${actualPort}/ (dữ liệu: ${dataDir})`);
        resolve(actualPort);
      });
    });
  }

  return { server, listen, stop, log, get port() { return actualPort; }, dataDir };
}

// ---------------------------------------------------------------- khởi chạy

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).app === APP_ID); } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function findBrowser() {
  const override = process.env.STICK_NOTE_BROWSER;
  if (override && fs.existsSync(override)) return override;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  const list =
    process.platform === 'win32'
      ? [
          pf86 && path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          pf && path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          pf86 && path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  return list.filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

// Mở thành cửa sổ app riêng (không thanh địa chỉ, không tab).
function openWindow(url) {
  if (process.env.STICK_NOTE_NO_OPEN) {
    console.log('OPEN ' + url);
    return;
  }
  const exe = findBrowser();
  if (exe) {
    spawn(exe, [`--app=${url}`, '--window-size=1440,900'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const dataDir = path.resolve(process.env.STICK_NOTE_DATA || path.join(ROOT, 'data'));
  const url = `http://127.0.0.1:${port}/`;
  const running = await probe(port);

  if (args.has('--open')) {
    if (!running) {
      spawn(process.execPath, [fileURLToPath(import.meta.url), '--bg'], {
        detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
      }).unref();
      const ok = await waitFor(() => probe(port), 10_000);
      if (!ok) {
        console.error(`Không khởi động được Stick Note ở cổng ${port}.`);
        console.error('Hãy chạy "node server.js" để xem thông báo lỗi chi tiết.');
        process.exit(1);
      }
    }
    openWindow(url);
    return;
  }

  if (running) {
    console.log(`Stick Note đã chạy sẵn tại ${url}`);
    return;
  }

  const app = createApp({ port, dataDir, idleExitMs: args.has('--bg') ? IDLE_EXIT_MS : 0, logToConsole: !args.has('--bg') });
  process.on('uncaughtException', (err) => { app.log('uncaughtException', err && err.stack ? err.stack : err); });
  process.on('unhandledRejection', (err) => { app.log('unhandledRejection', err && err.stack ? err.stack : err); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.stop().then(() => process.exit(0)));
  try {
    await app.listen();
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      if (await probe(port)) return; // một bản khác vừa chạy xong, dùng luôn
      console.error(`Cổng ${port} đang bị chương trình khác dùng. Đặt cổng khác, ví dụ: set PORT=4848`);
    } else {
      console.error('Không khởi động được server:', err);
    }
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
