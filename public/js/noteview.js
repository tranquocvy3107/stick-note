// Vẽ mảnh giấy ra DOM: dựng, cập nhật, tô link. File này không xử lý sự kiện chuột/phím
// (việc đó nằm ở interactions.js), chỉ đảm bảo DOM luôn khớp với dữ liệu trong store.

import { h, splitLinks, shortUrl, breakable } from './util.js';
import { icon } from './icons.js';
import { COLORS, THUMB_MAX_W } from './constants.js';
import { state, on } from './store.js';

function toolButton(act, iconName, title) {
  return h('button', { type: 'button', class: 'tbtn', dataset: { act }, title, 'aria-label': title }, icon(iconName, 17));
}

function buildTools(n) {
  const isImage = n.k === 'image';
  const kids = [];
  if (isImage) kids.push(toolButton('view', 'expand', 'Xem ảnh lớn'));
  kids.push(toolButton('edit', 'pencil', isImage ? 'Sửa chú thích (Enter)' : 'Sửa chữ (Enter)'));
  kids.push(toolButton('copy', 'copy', isImage ? 'Copy ảnh' : 'Copy nội dung (Ctrl+C)'));
  kids.push(
    h('div', { class: 'color-wrap' },
      toolButton('color', 'palette', 'Đổi màu giấy'),
      h('div', { class: 'palette', role: 'menu' },
        COLORS.map((c) => h('button', { type: 'button', class: 'swatch', dataset: { color: c.key }, title: c.name, 'aria-label': c.name })),
      ),
    ),
  );
  kids.push(toolButton('pin', 'pin', 'Ghim vị trí'));
  kids.push(toolButton('del', 'trash', 'Bỏ vào thùng rác (Delete)'));
  return h('div', { class: 'tools' }, kids);
}

// Chữ thường giữ nguyên, link thành <a> kèm nút copy. Không dùng innerHTML nên an toàn với mọi nội dung.
export function renderText(container, text) {
  const frag = document.createDocumentFragment();
  for (const tok of splitLinks(text)) {
    if (tok.type === 'text') {
      frag.append(tok.value);
      continue;
    }
    frag.append(
      h('span', { class: 'lk' },
        h('a', { href: tok.href, target: '_blank', rel: 'noopener noreferrer', title: tok.href, draggable: 'false' }, breakable(shortUrl(tok.value))),
        h('button', { type: 'button', class: 'lk-copy', dataset: { url: tok.href }, title: 'Copy link', 'aria-label': 'Copy link' }, icon('copy', 12)),
      ),
    );
  }
  container.replaceChildren(frag);
}

// Thanh công cụ chỉ được dựng khi cần (di chuột vào hoặc chọn mảnh giấy), và chỉ giữ vài thanh cùng lúc.
// Mỗi thanh gồm khoảng 35 phần tử (nút, biểu tượng, bảng màu): dựng sẵn cho cả nghìn mảnh giấy sẽ
// khiến trình duyệt chậm hẳn dù chúng đang ẩn.
const MAX_LIVE_TOOLS = 12;
const liveTools = [];

function syncTools(el, n) {
  const pin = el._tools?.querySelector('[data-act="pin"]');
  if (!pin) return;
  const title = n.lock ? 'Bỏ ghim (cho phép kéo)' : 'Ghim vị trí (không kéo nhầm)';
  pin.classList.toggle('on', !!n.lock);
  pin.title = title;
  pin.setAttribute('aria-label', title);
  pin.setAttribute('aria-pressed', n.lock ? 'true' : 'false');
}

function dropTools(el) {
  const i = liveTools.indexOf(el);
  if (i >= 0) liveTools.splice(i, 1);
  if (el._tools) {
    el._tools.remove();
    el._tools = null;
  }
}

export function ensureTools(el) {
  if (el._tools) {
    const i = liveTools.indexOf(el);
    if (i >= 0 && i < liveTools.length - 1) {
      liveTools.splice(i, 1);
      liveTools.push(el);
    }
    return;
  }
  const n = state.notes.get(el.dataset.id);
  if (!n) return;
  el._tools = buildTools(n);
  el.prepend(el._tools);
  syncTools(el, n);
  liveTools.push(el);
  for (let i = 0; liveTools.length > MAX_LIVE_TOOLS && i < liveTools.length;) {
    const old = liveTools[i];
    if (old === el || old.classList.contains('sel') || old.matches(':hover')) {
      i++;
      continue;
    }
    dropTools(old);
  }
}

export function buildNote(n) {
  const el = h('div', { class: 'note', dataset: { id: n.id } }, h('div', { class: 'pin' }));
  if (n.k === 'image') {
    const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
    // Ảnh thu nhỏ lỗi thì dùng ảnh gốc.
    img.addEventListener('error', () => {
      if (img.dataset.orig && img.dataset.src !== img.dataset.orig) {
        img.dataset.src = img.dataset.orig;
        img.src = img.dataset.orig;
      }
    });
    el.append(h('div', { class: 'media' }, img));
  }
  el.append(h('div', { class: 'body' }), h('div', { class: 'grip', title: 'Kéo để đổi kích thước' }));
  return el;
}

export function placeAt(el, x, y) {
  el.style.translate = `${x}px ${y}px`;
}

function applyPlacement(el, n, tilt) {
  placeAt(el, n.x, n.y);
  el.style.rotate = tilt ? `${n.r}deg` : '0deg';
  el.style.width = `${n.w}px`;
  el.style.minHeight = n.h ? `${n.h}px` : '';
  el.style.zIndex = String(n.z);
}

function updateMedia(el, n) {
  const media = el.querySelector('.media');
  const img = media?.firstElementChild;
  if (!img) return;
  if (n.iw && n.ih) media.style.aspectRatio = `${n.iw} / ${n.ih}`;
  const original = `/img/${n.img}`;
  const src = n.th && n.w <= THUMB_MAX_W ? `/img/${n.th}` : original;
  img.dataset.orig = original;
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    img.src = src;
  }
}

export function updateNote(el, n, { tilt = true } = {}) {
  el.dataset.color = n.c;
  el.classList.toggle('pinned', !!n.lock);
  el.classList.toggle('is-image', n.k === 'image');
  applyPlacement(el, n, tilt);
  syncTools(el, n);

  if (n.k === 'image') updateMedia(el, n);

  // Đang sửa thì thân là ô nhập, đừng đè lên.
  if (!el.classList.contains('editing') && el._text !== n.t) {
    renderText(el.querySelector('.body'), n.t || '');
    el._text = n.t;
  }
}

function leave(el) {
  dropTools(el);
  el.classList.add('leaving');
  el.style.pointerEvents = 'none';
  setTimeout(() => el.remove(), 200);
}

// Giữ các phần tử DOM khớp với store. Mảnh giấy nào đổi thì chỉ cập nhật đúng mảnh đó.
export function createLayer(world, getSettings) {
  const els = new Map();

  function sync(id) {
    const n = state.notes.get(id);
    let el = els.get(id);
    if (!n) {
      if (el) {
        els.delete(id);
        leave(el);
      }
      return;
    }
    if (!el) {
      el = buildNote(n);
      els.set(id, el);
      world.append(el);
    }
    updateNote(el, n, getSettings());
  }

  function syncAll() {
    for (const [id, el] of els) {
      if (!state.notes.has(id)) {
        els.delete(id);
        dropTools(el);
        el.remove();
      }
    }
    for (const id of state.notes.keys()) sync(id);
  }

  on('notes', (d) => {
    if (d.reset) {
      syncAll();
      return;
    }
    d.removed?.forEach(sync);
    d.changed?.forEach(sync);
  });

  return {
    get: (id) => els.get(id),
    entries: () => els.entries(),
    sync,
    syncAll,
    ensureTools,
  };
}
