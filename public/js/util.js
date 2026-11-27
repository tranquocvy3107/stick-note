// Shared helpers. Nothing here touches the DOM at import time, so it can be tested in Node.

export const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const round = (v, digits = 0) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export function debounce(fn, ms) {
  let timer = 0;
  let lastArgs = [];
  const run = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      fn(...lastArgs);
    }, ms);
  };
  run.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    fn(...lastArgs);
  };
  run.cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };
  return run;
}

// Order notes the way you read: row by row from the top, left to right within a row.
// Notes whose tops differ by less than `rowGap` px count as one row (hand-placed notes are rarely aligned).
export function readingOrder(notes, rowGap = 70) {
  const sorted = [...notes].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const n of sorted) {
    const row = rows[rows.length - 1];
    if (row && n.y - row.top < rowGap) row.items.push(n);
    else rows.push({ top: n.y, items: [n] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

// Strip diacritics and lowercase so search is forgiving: "Đường Hầm" -> "duong ham" (Vietnamese đ included).
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

// ---------------------------------------------------------------- link

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

// Trim trailing punctuation that usually is not part of a link: "see https://a.com/x." -> "https://a.com/x"
function trimUrl(url) {
  for (;;) {
    const last = url[url.length - 1];
    if (!last) return url;
    if (/[.,;:!?'"»…*]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' || last === ']' || last === '}') {
      const open = { ')': '(', ']': '[', '}': '{' }[last];
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

// Split text into plain-text parts and links.
// -> [{ type: 'text', value }, { type: 'link', value, href }]
export function splitLinks(text) {
  const out = [];
  let last = 0;
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!url) continue;
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'link', value: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

// Show a link compactly: drop the protocol and www, and shorten the middle when it is very long.
export function shortUrl(url) {
  let s = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  // Non-English links are usually percent-encoded (%E1%BB%87): show them as readable text. The real link is unchanged.
  try { s = decodeURI(s); } catch { /* a broken escape sequence: keep the text as it is */ }
  if (s.length > 46) s = `${s.slice(0, 32)}…${s.slice(-10)}`;
  return s;
}

// Insert a zero-width space (U+200B) after / ? & = _ . - so long links wrap at natural places
// instead of in the middle of a word. Display only: the real link and the copied text are unchanged.
export function breakable(text) {
  return text.replace(/([/?&=_.-])(?=[^/?&=_.-])/g, '$1​');
}

// ---------------------------------------------------------------- time

/**
 * "just now", "5 minutes ago", "3 hours ago", "2 days ago", then a plain date.
 * The words come from Intl, so they follow the interface language; `justNow` is the translated phrase for under 45 s.
 */
export function timeAgo(ts, { now = Date.now(), lang = 'en', justNow = 'just now' } = {}) {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return justNow;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 31) return rtf.format(-days, 'day');
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(ts);
}

// ---------------------------------------------------------------- DOM

// Create an element quickly: h('div', { class: 'a', dataset: { id: 1 }, onclick: fn }, 'text', child)
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function isTextField(el) {
  return !!el && el.nodeType === 1 && (el.matches?.('input, textarea, select, [contenteditable="true"]') ?? false);
}

// Copy text to the clipboard, falling back to execCommand when the Clipboard API is refused.
export async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
