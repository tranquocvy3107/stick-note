// Gọi máy chủ cục bộ. Mọi request ghi đều kèm header X-Stick-Note để server từ chối trang web lạ.

const WRITE_HEADERS = { 'X-Stick-Note': '1' };

async function check(res) {
  if (res.ok) return res;
  let message = res.statusText || `Lỗi ${res.status}`;
  try {
    const body = await res.json();
    if (body && body.error) message = body.error;
  } catch { /* không có nội dung JSON */ }
  throw Object.assign(new Error(message), { status: res.status });
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

  // Trả về { conflict: false, rev } hoặc { conflict: true, rev, board } khi cửa sổ khác đã lưu trước.
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
};
