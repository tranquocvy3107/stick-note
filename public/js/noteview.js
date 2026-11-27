// Draws notes into the DOM: builds them, updates them, turns links into anchors. This file does not handle
// mouse or keyboard events (interactions.js does that); it only keeps the DOM in step with the store.

import { h, splitLinks, shortUrl, breakable } from './util.js';
import { icon } from './icons.js';
import { COLOR_KEYS, THUMB_MAX_W } from './constants.js';
import { t } from './i18n.js';
import { state, on } from './store.js';

function toolButton(act, iconName, title) {
  return h('button', { type: 'button', class: 'tbtn', dataset: { act }, title, 'aria-label': title }, icon(iconName, 17));
}

function buildTools(n) {
  const isImage = n.k === 'image';
  const kids = [];
  if (isImage) kids.push(toolButton('view', 'expand', t('tool.view')));
  kids.push(toolButton('edit', 'pencil', isImage ? t('tool.edit.image') : t('tool.edit.text')));
  kids.push(toolButton('copy', 'copy', isImage ? t('tool.copy.image') : t('tool.copy.text')));
  kids.push(
    h('div', { class: 'color-wrap' },
      toolButton('color', 'palette', t('tool.color')),
      h('div', { class: 'palette', role: 'menu' },
        COLOR_KEYS.map((key) => h('button', { type: 'button', class: 'swatch', dataset: { color: key }, title: t(`color.${key}`), 'aria-label': t(`color.${key}`) })),
      ),
    ),
  );
  kids.push(toolButton('pin', 'pin', t('tool.pin')));
  kids.push(toolButton('del', 'trash', t('tool.del')));
  return h('div', { class: 'tools' }, kids);
}

// Plain text stays as it is; links become <a> with a copy button. No innerHTML, so any content is safe.
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
        h('button', { type: 'button', class: 'lk-copy', dataset: { url: tok.href }, title: t('link.copy'), 'aria-label': t('link.copy') }, icon('copy', 12)),
      ),
    );
  }
  container.replaceChildren(frag);
}

// A note's toolbar is only built when needed (hover or selection), and only a few are kept alive at once.
// Each toolbar is about 35 elements (buttons, icons, the colour palette): building them up front for
// thousands of notes would slow the browser down badly even while they are hidden.
const MAX_LIVE_TOOLS = 12;
const liveTools = [];

function syncTools(el, n) {
  const pin = el._tools?.querySelector('[data-act="pin"]');
  if (!pin) return;
  const title = n.lock ? t('tool.unpin') : t('tool.pin');
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
    // If the thumbnail fails to load, fall back to the original.
    img.addEventListener('error', () => {
      if (img.dataset.orig && img.dataset.src !== img.dataset.orig) {
        img.dataset.src = img.dataset.orig;
        img.src = img.dataset.orig;
      }
    });
    el.append(h('div', { class: 'media' }, img));
  }
  el.append(h('div', { class: 'body' }), h('div', { class: 'grip', title: t('tool.resize') }));
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

  // While editing, the body is the text box: do not overwrite it.
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

// Keep the DOM elements in step with the store. Only the notes that changed are updated.
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
