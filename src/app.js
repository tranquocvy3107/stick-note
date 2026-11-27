// The Stick Note application: HTTP server, JSON API, storage and backups.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { APP_ID, DEFAULT_PORT, ROOT, VERSION, readBuildInfo } from './paths.js';
import { localDay, stamp, sniffImage, writeFileAtomic } from './util.js';
import { HTML_CSP, MIME, SECURITY_HEADERS, readBody, sendError, sendJson, sendText } from './http.js';
import { createPresence } from './presence.js';

const MAX_BOARD_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_THUMB_BYTES = 8 * 1024 * 1024;
const KEEP_DAILY_BACKUPS = 60;
const KEEP_SPECIAL_BACKUPS = 30;

const IMAGE_ID_RE = /^[a-f0-9]{40}(\.thumb)?\.(png|jpg|webp|gif)$/;
const ORIGINAL_ID_RE = /^[a-f0-9]{40}\.(png|jpg|webp|gif)$/;

function cleanList(list, max) {
  if (!Array.isArray(list) || list.length > max) return null;
  for (const n of list) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || n.id.length === 0 || n.id.length > 64) {
      return null;
    }
  }
  return list;
}

/**
 * Create the app. Nothing is listening until you call `listen()`.
 *
 * @param {object}   options
 * @param {number}   [options.port]        TCP port; 0 picks a free one (used by tests).
 * @param {string}   options.dataDir       Folder for board.json, images/ and backups/.
 * @param {string}   [options.publicDir]   Folder with the web interface.
 * @param {number}   [options.idleExitMs]  Quit this long after the last window said goodbye (0 = never). See presence.js.
 * @param {number}   [options.windowTtlMs] A window silent for this long is counted as gone (default: a week).
 * @param {boolean}  [options.logToConsole]
 * @param {Function} [options.onShutdown]  Called when the server should quit: a client asked (POST /api/shutdown)
 *                                         or no window is left. Without it the idle exit stops the server and the process.
 * @param {object}   [options.buildInfo]   Contents of build-info.json (how this copy was packaged).
 */
export function createApp({
  port = DEFAULT_PORT,
  dataDir,
  publicDir = path.join(ROOT, 'public'),
  idleExitMs = 0,
  windowTtlMs = undefined,
  logToConsole = true,
  onShutdown = null,
  buildInfo = readBuildInfo(),
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  dataDir = path.resolve(dataDir);
  publicDir = path.resolve(publicDir);

  const boardFile = path.join(dataDir, 'board.json');
  const imagesDir = path.join(dataDir, 'images');
  const backupsDir = path.join(dataDir, 'backups');
  const logFile = path.join(dataDir, 'server.log');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });

  let actualPort = port;
  const presence = createPresence({ idleExitMs, windowTtlMs });
  const startedAt = Date.now();

  function log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
    if (logToConsole) console.log(line);
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) {
        fs.renameSync(logFile, path.join(dataDir, 'server.old.log'));
      }
      fs.appendFileSync(logFile, line + '\n');
    } catch { /* a logging failure must never take the server down */ }
  }

  // ---- board.json -----------------------------------------------------
  function readBoardFile(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.notes)) throw new Error('not a valid board file');
    return {
      rev: Number(data.rev) || 0,
      notes: data.notes,
      trash: Array.isArray(data.trash) ? data.trash : [],
      // Zones arrived in 1.2: a board file written by an older version simply has none.
      zones: Array.isArray(data.zones) ? data.zones : [],
      zonesTrash: Array.isArray(data.zonesTrash) ? data.zonesTrash : [],
      savedAt: data.savedAt || null,
    };
  }

  function loadBoard() {
    const empty = { rev: 0, notes: [], trash: [], zones: [], zonesTrash: [], savedAt: null };
    if (!fs.existsSync(boardFile)) return empty;
    try {
      return readBoardFile(boardFile);
    } catch (err) {
      log('board.json is damaged:', err.message);
      try { fs.renameSync(boardFile, path.join(dataDir, `board.corrupt-${stamp()}.json`)); } catch { /* ignore */ }
      const candidates = fs.readdirSync(backupsDir).filter((f) => /^board-.*\.json$/.test(f)).sort().reverse();
      for (const f of candidates) {
        try {
          const restored = readBoardFile(path.join(backupsDir, f));
          restored.rev += 1;
          log('restored the board from backup', f);
          return restored;
        } catch { /* try the next backup */ }
      }
      return empty;
    }
  }

  let board = loadBoard();

  // What a client receives: the lists it edits (not rev or savedAt, which travel beside it).
  const boardContent = () => ({ notes: board.notes, trash: board.trash, zones: board.zones, zonesTrash: board.zonesTrash });

  function pruneBackups() {
    try {
      const files = fs.readdirSync(backupsDir);
      const daily = files.filter((f) => /^board-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const f of daily.slice(0, Math.max(0, daily.length - KEEP_DAILY_BACKUPS))) fs.unlinkSync(path.join(backupsDir, f));
      const special = files.filter((f) => /^board-.*-(before-shrink|manual)\.json$/.test(f)).sort();
      for (const f of special.slice(0, Math.max(0, special.length - KEEP_SPECIAL_BACKUPS))) fs.unlinkSync(path.join(backupsDir, f));
    } catch (err) {
      log('Could not prune old backups:', err.message);
    }
  }

  // Back up the previous state before overwriting it:
  //  - one copy per day (the last state of the previous save)
  //  - one extra copy when the number of notes drops sharply (mass deletion or a bug)
  function backupBeforeWrite(nextNotes) {
    if (!fs.existsSync(boardFile)) return;
    const daily = path.join(backupsDir, `board-${localDay()}.json`);
    if (!fs.existsSync(daily)) fs.copyFileSync(boardFile, daily);
    const before = board.notes.length;
    if (before >= 8 && nextNotes.length < before * 0.6) {
      fs.copyFileSync(boardFile, path.join(backupsDir, `board-${stamp()}-before-shrink.json`));
      log(`The number of notes dropped from ${before} to ${nextNotes.length}; saved a backup of the previous state.`);
    }
    pruneBackups();
  }

  // ---- request checks -------------------------------------------------
  const allowedHosts = () => [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`];
  const hostAllowed = (host) => !!host && allowedHosts().includes(host.toLowerCase());
  const originAllowed = (origin) => allowedHosts().some((h) => origin.toLowerCase() === `http://${h}`);

  // ---- API --------------------------------------------------------------
  async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;

    if (m !== 'GET' && m !== 'HEAD') {
      // Writes need a custom header: another website cannot send it without the browser
      // blocking the request at the preflight step.
      if (req.headers['x-stick-note'] !== '1') return sendError(res, 403, 'missing_header', 'The X-Stick-Note header is required');
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin)) return sendError(res, 403, 'bad_origin', 'Origin not allowed');
    }

    if (p === '/api/ping' && m === 'GET') {
      presence.ping(url.searchParams.get('w')); // the window's name; older versions send none
      return sendJson(res, 200, { app: APP_ID, version: VERSION, t: Date.now() });
    }

    if (p === '/api/bye' && m === 'POST') {
      presence.bye(url.searchParams.get('w'));
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/rev' && m === 'GET') return sendJson(res, 200, { rev: board.rev });

    if (p === '/api/board' && m === 'GET') {
      return sendJson(res, 200, { rev: board.rev, savedAt: board.savedAt, board: boardContent() });
    }

    if (p === '/api/board' && m === 'PUT') return putBoard(req, res);

    if (p === '/api/images' && m === 'POST') return uploadImage(req, res);
    if (p === '/api/thumb' && m === 'POST') return uploadThumb(req, res, url);

    if (p === '/api/info' && m === 'GET') {
      const backups = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.json')).sort().reverse();
      return sendJson(res, 200, {
        app: APP_ID, version: VERSION, channel: buildInfo.channel || 'source', platform: process.platform,
        dataDir, port: actualPort, rev: board.rev,
        notes: board.notes.length, trash: board.trash.length, zones: board.zones.length, windows: presence.count,
        backups: backups.slice(0, 10),
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
        const child = spawn(cmd, [dataDir], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => log('Could not open the data folder:', err.message));
        child.unref();
      } catch (err) {
        return sendError(res, 500, 'open_failed', err.message);
      }
      return sendJson(res, 200, { ok: true, dataDir });
    }

    if (p === '/api/shutdown' && m === 'POST') {
      sendJson(res, 200, { ok: true });
      if (onShutdown) setTimeout(onShutdown, 50); // let the response reach the client first
      return;
    }

    return sendError(res, 404, 'not_found', 'No such API endpoint');
  }

  async function putBoard(req, res) {
    let body;
    try {
      body = await readBody(req, MAX_BOARD_BYTES);
    } catch (err) {
      return sendError(res, err.status || 400, err.code || 'bad_request', err.message);
    }
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      return sendError(res, 400, 'invalid_json', 'The request body is not valid JSON');
    }
    const incoming = data && data.board;
    const notes = cleanList(incoming && incoming.notes, 50_000);
    const trash = cleanList(incoming ? incoming.trash ?? [] : null, 50_000);
    // Zones are optional on the way in: a window still running the interface of an older version does not know
    // about them and leaves them out, which must not wipe the zones already saved.
    const zones = incoming && incoming.zones === undefined ? board.zones : cleanList(incoming ? incoming.zones : null, 10_000);
    const zonesTrash = incoming && incoming.zonesTrash === undefined ? board.zonesTrash : cleanList(incoming ? incoming.zonesTrash : null, 10_000);
    if (!notes || !trash || !zones || !zonesTrash) return sendError(res, 400, 'invalid_board', 'The board data is malformed');

    if (Number(data.baseRev) !== board.rev) {
      // Not a plain error: the client merges this board with its own and saves again.
      return sendJson(res, 409, { error: 'conflict', message: 'The board changed elsewhere', rev: board.rev, board: boardContent() });
    }
    try {
      backupBeforeWrite(notes);
      const next = { app: APP_ID, schema: 1, rev: board.rev + 1, savedAt: new Date().toISOString(), notes, trash, zones, zonesTrash };
      writeFileAtomic(boardFile, JSON.stringify(next));
      board = next;
    } catch (err) {
      log('Could not write board.json:', err.message);
      return sendError(res, 500, 'write_failed', `Could not write the data: ${err.message}`);
    }
    return sendJson(res, 200, { rev: board.rev, savedAt: board.savedAt });
  }

  async function uploadImage(req, res) {
    let buf;
    try {
      buf = await readBody(req, MAX_IMAGE_BYTES);
    } catch (err) {
      return sendError(res, err.status || 400, err.code || 'bad_request', err.message);
    }
    const ext = sniffImage(buf);
    if (!ext) return sendError(res, 415, 'unsupported_image', 'Only PNG, JPEG, WebP and GIF images are accepted');
    const id = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
    const file = path.join(imagesDir, id);
    if (!fs.existsSync(file)) writeFileAtomic(file, buf);
    return sendJson(res, 200, { id });
  }

  async function uploadThumb(req, res, url) {
    const of = url.searchParams.get('of') || '';
    if (!ORIGINAL_ID_RE.test(of) || !fs.existsSync(path.join(imagesDir, of))) {
      return sendError(res, 400, 'unknown_image', 'The original image does not exist');
    }
    let buf;
    try {
      buf = await readBody(req, MAX_THUMB_BYTES);
    } catch (err) {
      return sendError(res, err.status || 400, err.code || 'bad_request', err.message);
    }
    const ext = sniffImage(buf);
    if (!ext || ext === 'gif') return sendError(res, 415, 'unsupported_thumb', 'A thumbnail must be PNG, JPEG or WebP');
    const id = `${of.split('.')[0]}.thumb.${ext}`;
    const file = path.join(imagesDir, id);
    if (!fs.existsSync(file)) writeFileAtomic(file, buf);
    return sendJson(res, 200, { id });
  }

  // ---- images and static files ----------------------------------------
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

  // ---- HTTP server ----------------------------------------------------
  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) return sendText(res, 403, 'Host not allowed');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendText(res, 400, 'Bad request'); }

    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        log('API error', req.method, url.pathname, err && err.stack ? err.stack : err);
        if (!res.headersSent) sendError(res, 500, 'server_error', 'Internal server error');
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
        presence.ping(); // starting counts as activity: the window that caused the start is about to say hello
        if (idleExitMs > 0) {
          // Often enough for the delay to be accurate, rarely enough to cost nothing.
          const tickMs = Math.min(10_000, Math.max(100, Math.floor(idleExitMs / 4)));
          let lastTick = Date.now();
          idleTimer = setInterval(() => {
            const now = Date.now();
            // The computer just woke from sleep and the clock jumped: give the windows time to say hello again.
            if (now - lastTick > Math.max(30_000, tickMs * 3)) presence.wake();
            lastTick = now;
            if (presence.shouldQuit()) {
              clearInterval(idleTimer);
              log('No window is open any more; shutting down.');
              if (onShutdown) onShutdown();
              else stop().then(() => process.exit(0));
            }
          }, tickMs);
        }
        log(`Stick Note ${VERSION} is running at http://127.0.0.1:${actualPort}/ (data: ${dataDir})`);
        resolve(actualPort);
      });
    });
  }

  return { server, listen, stop, log, get port() { return actualPort; }, dataDir };
}
