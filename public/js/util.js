// Tiện ích dùng chung. Không chạm vào DOM khi import, để test được bằng Node.

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

// Sắp mảnh giấy theo thứ tự đọc: từng hàng từ trên xuống, trong mỗi hàng từ trái sang phải.
// Các mảnh lệch nhau dưới `rowGap` px theo chiều dọc được coi là cùng một hàng (giấy dán tay hiếm khi thẳng hàng).
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

// Bỏ dấu tiếng Việt và đưa về chữ thường để tìm kiếm: "Đường Hầm" -> "duong ham"
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

// Cắt bỏ dấu câu ở cuối mà thường không thuộc về link: "xem https://a.com/x." -> "https://a.com/x"
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

// Tách văn bản thành các đoạn chữ thường và link.
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

// Hiển thị link gọn: bỏ giao thức và www, rút ngắn ở giữa nếu quá dài.
export function shortUrl(url) {
  let s = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  // Link tiếng Việt thường bị mã hóa (%E1%BB%87): hiện lại thành chữ cho dễ đọc. Link thật vẫn giữ nguyên.
  try { s = decodeURI(s); } catch { /* mã hóa dở dang thì giữ nguyên */ }
  if (s.length > 46) s = `${s.slice(0, 32)}…${s.slice(-10)}`;
  return s;
}

// Chèn ký tự "cho phép xuống dòng" (U+200B) sau / ? & = _ . - để link dài xuống dòng ở chỗ tự nhiên
// thay vì bị cắt giữa một chữ. Chỉ dùng cho phần hiển thị; link thật và nội dung copy không bị đổi.
export function breakable(text) {
  return text.replace(/([/?&=_.-])(?=[^/?&=_.-])/g, '$1​');
}

// ---------------------------------------------------------------- thời gian

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'vừa xong';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} ngày trước`;
  const date = new Date(ts);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

// ---------------------------------------------------------------- DOM

// Tạo phần tử nhanh: h('div', { class: 'a', dataset: { id: 1 }, onclick: fn }, 'chữ', child)
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

// Chép chữ vào clipboard, có phương án dự phòng khi trình duyệt từ chối Clipboard API.
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
