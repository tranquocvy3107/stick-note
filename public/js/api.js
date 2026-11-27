// Talking to the local server. Every write request carries an X-Stick-Note header so the server can reject foreign web pages.

const WRITE_HEADERS = { 'X-Stick-Note': '1' };

// Errors from the server look like { error: 'code', message: 'English explanation' }.
async function check(res) {
  if (res.ok) return res;
  let message = res.statusText || `Error ${res.status}`;
  let code = '';
  try {
    const body = await res.json();
    if (body && body.message) message = body.message;
    if (body && body.error) code = body.error;
  } catch { /* no JSON body */ }
  throw Object.assign(new Error(message), { status: res.status, code });
}

export const imgUrl = (id) => `/img/${id}`;

export const api = {
  async getBoard() {
    const res = await check(await fetch('/api/board', { cache: 'no-store' }));
    return res.json(); // { rev, board: { notes, trash } }
  },

  async getRev() {
    const res = await check(await fetch('/api/rev', { cache: 'no-store' }));
    return (await res.json()).rev;
  },

  // Resolves to { conflict: false, rev } or, when another window saved first, { conflict: true, rev, board }.
  async putBoard(baseRev, board, { keepalive = false } = {}) {
    const res = await fetch('/api/board', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...WRITE_HEADERS },
      body: JSON.stringify({ baseRev, board }),
      keepalive,
    });
    if (res.status === 409) return { conflict: true, ...(await res.json()) };
    await check(res);
    return { conflict: false, ...(await res.json()) };
  },

  async uploadImage(blob) {
    const res = await check(await fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream', ...WRITE_HEADERS },
      body: blob,
    }));
    return res.json(); // { id }
  },

  async uploadThumb(originalId, blob) {
    const res = await check(await fetch(`/api/thumb?of=${encodeURIComponent(originalId)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream', ...WRITE_HEADERS },
      body: blob,
    }));
    return res.json(); // { id }
  },

  ping() {
    return fetch('/api/ping', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
  },

  async info() {
    const res = await check(await fetch('/api/info', { cache: 'no-store' }));
    return res.json();
  },

  async backupNow() {
    const res = await check(await fetch('/api/backup', { method: 'POST', headers: WRITE_HEADERS }));
    return res.json();
  },

  async openDataFolder() {
    const res = await check(await fetch('/api/open-data-folder', { method: 'POST', headers: WRITE_HEADERS }));
    return res.json();
  },

  // Ask the server to quit (used by "Quit Stick Note").
  async shutdown() {
    const res = await check(await fetch('/api/shutdown', { method: 'POST', headers: WRITE_HEADERS }));
    return res.json();
  },
};
