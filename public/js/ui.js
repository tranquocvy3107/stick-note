// Giao diện quanh tấm bảng: trạng thái lưu, thanh zoom, tìm kiếm, menu, thùng rác, xem ảnh lớn, hướng dẫn.
// Mọi nút đều nhỏ và nằm ở rìa để không che bảng.

import * as store from './store.js';
import { api, imgUrl } from './api.js';
import { h, fold, timeAgo, debounce, readingOrder } from './util.js';
import { icon, hydrateIcons } from './icons.js';

const $ = (selector) => document.querySelector(selector);

const SETTINGS_KEY = 'stick-note:settings';

export function loadSettings() {
  const defaults = { tilt: true, theme: 'auto' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* bỏ qua */ }
}

const STATUS_TEXT = {
  loading: 'Đang mở…',
  saved: 'Đã lưu',
  pending: 'Đang lưu…',
  saving: 'Đang lưu…',
  error: 'Chưa lưu được, đang thử lại',
};
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Tự động', light: 'Sáng', dark: 'Tối' };

export function createUI({ board, view, layer, settings, onTiltChange }) {
  hydrateIcons();
  let inter = null;

  const menu = $('#menu');
  const menuBtn = $('#btn-menu');
  const searchBar = $('#searchbar');
  const searchInput = $('#search-input');
  const searchCount = $('#search-count');
  const drawer = $('#drawer');
  const lightbox = $('#lightbox');
  const help = $('#help');
  const trashBtn = $('#trash');
  const toastEl = $('#toast');

  // ------------------------------------------------------------ thông báo nhỏ

  let toastTimer = 0;
  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
  }
  function toast(message, { action, run, ms = 4200 } = {}) {
    clearTimeout(toastTimer);
    toastEl.replaceChildren(h('span', { class: 'toast-msg' }, message));
    if (action) {
      toastEl.append(h('button', { type: 'button', onclick: () => { hideToast(); run?.(); } }, action));
    }
    toastEl.hidden = false;
    toastEl.classList.remove('in');
    void toastEl.offsetWidth; // chạy lại hiệu ứng xuất hiện
    toastEl.classList.add('in');
    toastTimer = setTimeout(hideToast, ms);
  }

  // ------------------------------------------------------------ trạng thái lưu

  const statusEl = $('#status');
  const statusText = $('#status-text');
  function renderStatus(status) {
    statusEl.dataset.state = status;
    statusText.textContent = STATUS_TEXT[status] || '';
    if (status === 'saved' && store.state.savedAt) {
      statusEl.title = `Đã lưu lúc ${new Date(store.state.savedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  store.on('status', renderStatus);
  renderStatus(store.state.status);

  // Lỗi lưu kéo dài (máy chủ đã tắt) thì báo rõ bằng một dải đỏ, không chặn thao tác.
  // Giữa các lần thử lại trạng thái nhảy qua "đang lưu", nên chỉ một lần lưu thành công mới tắt dải này.
  const banner = $('#banner');
  let bannerTimer = 0;
  let failingSince = 0;
  store.on('status', (status) => {
    if (status === 'saved') {
      failingSince = 0;
      clearTimeout(bannerTimer);
      banner.hidden = true;
    } else if (status === 'error' && !failingSince) {
      failingSince = performance.now();
      bannerTimer = setTimeout(() => { if (failingSince) banner.hidden = false; }, 4000);
    }
  });
  store.on('merged', () => toast('Đã gộp thay đổi từ một cửa sổ khác', { ms: 3000 }));

  // ------------------------------------------------------------ zoom

  const zoomLabel = $('#zoom-label');
  // Đổi chữ làm trình duyệt bố cục lại, nên khi đang zoom liên tục chỉ cập nhật nhãn vài lần mỗi giây.
  let labelPainted = 0;
  let labelTimer = 0;
  const paintZoomLabel = () => {
    labelTimer = 0;
    labelPainted = performance.now();
    zoomLabel.textContent = `${Math.round(view.v.z * 100)}%`;
  };
  view.onChange(() => {
    const since = performance.now() - labelPainted;
    if (since > 120) paintZoomLabel();
    else if (!labelTimer) labelTimer = setTimeout(paintZoomLabel, 120 - since);
  });
  $('#btn-zoom-in').addEventListener('click', () => view.zoomStep(1));
  $('#btn-zoom-out').addEventListener('click', () => view.zoomStep(-1));
  zoomLabel.addEventListener('click', () => view.zoomReset());
  $('#btn-home').addEventListener('click', () => view.home());
  $('#btn-fit').addEventListener('click', () => fitAll());

  function fitAll() {
    const rects = [];
    for (const [id, el] of layer.entries()) {
      const n = store.state.notes.get(id);
      if (n) rects.push({ x: n.x, y: n.y, w: n.w, h: el.offsetHeight });
    }
    if (!rects.length) {
      view.home();
      return;
    }
    const x1 = Math.min(...rects.map((r) => r.x));
    const y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.w));
    const y2 = Math.max(...rects.map((r) => r.y + r.h));
    view.fitRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, { maxZ: 1 });
  }

  // ------------------------------------------------------------ gợi ý khi bảng trống

  const hint = $('#hint');
  function refreshHint() {
    hint.hidden = store.state.status === 'loading' || store.state.notes.size > 0;
  }
  store.on('notes', refreshHint);
  store.on('status', refreshHint);

  // ------------------------------------------------------------ tìm kiếm

  let matches = [];
  let matchIndex = -1;

  function updateCount() {
    if (!searchInput.value.trim()) searchCount.textContent = '';
    else if (!matches.length) searchCount.textContent = 'Không thấy';
    else searchCount.textContent = `${matchIndex + 1}/${matches.length}`;
  }

  function pulse(el) {
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), 1100);
  }

  function goMatch(i) {
    if (!matches.length) return;
    matchIndex = (i + matches.length) % matches.length;
    const n = matches[matchIndex];
    const el = layer.get(n.id);
    if (el) {
      view.ensureVisible({ x: n.x, y: n.y, w: n.w, h: el.offsetHeight });
      pulse(el);
    }
    updateCount();
  }

  function runSearch(jump = true) {
    const q = fold(searchInput.value.trim());
    matches = [];
    for (const n of store.state.notes.values()) {
      const el = layer.get(n.id);
      if (!el) continue;
      const hit = !!q && fold(n.t).includes(q);
      el.classList.toggle('hit', hit);
      el.classList.toggle('dim', !!q && !hit);
      if (hit) matches.push(n);
    }
    matches = readingOrder(matches);
    board.classList.toggle('searching', !!q);
    matchIndex = matches.length ? 0 : -1;
    updateCount();
    if (jump && matches.length) goMatch(0);
  }

  function clearSearchMarks() {
    for (const [, el] of layer.entries()) el.classList.remove('hit', 'dim', 'pulse');
    board.classList.remove('searching');
  }

  function openSearch() {
    searchBar.hidden = false;
    searchInput.focus();
    searchInput.select();
    if (searchInput.value) runSearch(false);
  }
  function closeSearch() {
    searchBar.hidden = true;
    searchInput.value = '';
    matches = [];
    matchIndex = -1;
    updateCount();
    clearSearchMarks();
  }

  const refreshSearch = debounce(() => { if (!searchBar.hidden) runSearch(false); }, 150);
  store.on('notes', refreshSearch);
  searchInput.addEventListener('input', () => runSearch(true));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goMatch(matchIndex + (e.shiftKey ? -1 : 1));
    }
  });
  $('#btn-search').addEventListener('click', () => (searchBar.hidden ? openSearch() : closeSearch()));
  $('#search-next').addEventListener('click', () => goMatch(matchIndex + 1));
  $('#search-prev').addEventListener('click', () => goMatch(matchIndex - 1));
  $('#search-close').addEventListener('click', closeSearch);

  // ------------------------------------------------------------ menu

  function applyTheme() {
    if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = settings.theme;
    $('#theme-label').textContent = THEME_LABEL[settings.theme];
  }
  function menuItem(act) {
    return menu.querySelector(`[data-act="${act}"]`);
  }
  function syncMenuState() {
    menuItem('tilt').setAttribute('aria-checked', String(settings.tilt));
    $('#theme-label').textContent = THEME_LABEL[settings.theme];
  }

  function toggleMenu(open) {
    const show = open ?? menu.hidden;
    menu.hidden = !show;
    menuBtn.setAttribute('aria-expanded', String(show));
    if (show) {
      const s = store.state;
      $('#menu-foot').textContent = `${s.notes.size} mảnh giấy · ${s.trash.length} trong thùng rác`;
      syncMenuState();
    }
  }
  menuBtn.addEventListener('click', () => toggleMenu());
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('#menu, #btn-menu')) toggleMenu(false);
  });

  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'tilt') {
      settings.tilt = !settings.tilt;
      saveSettings(settings);
      btn.setAttribute('aria-checked', String(settings.tilt));
      onTiltChange();
      return;
    }
    if (act === 'theme') {
      settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
      saveSettings(settings);
      applyTheme();
      return;
    }
    toggleMenu(false);
    try {
      if (act === 'fit') fitAll();
      else if (act === 'home') view.home();
      else if (act === 'help') toggleHelp(true);
      else if (act === 'folder') {
        await api.openDataFolder();
      } else if (act === 'backup') {
        const res = await api.backupNow();
        toast(res.file ? `Đã sao lưu: ${res.file}` : 'Chưa có dữ liệu để sao lưu', { ms: 4000 });
      }
    } catch (err) {
      toast(`Không thực hiện được: ${err.message || err}`, { ms: 5000 });
    }
  });
  applyTheme();
  syncMenuState();

  // ------------------------------------------------------------ thùng rác

  const badge = $('#trash-badge');
  const list = $('#drawer-list');

  function overTrash(x, y) {
    const r = trashBtn.getBoundingClientRect();
    return x >= r.left - 16 && x <= r.right + 16 && y >= r.top - 16 && y <= r.bottom + 16;
  }
  function setTrash({ armed, over }) {
    trashBtn.classList.toggle('armed', !!armed);
    trashBtn.classList.toggle('over', !!over);
  }

  // Nút cần bấm hai lần cho việc xóa hẳn: lần đầu đổi chữ, lần hai mới làm.
  function twoStep(btn, confirmText, action) {
    const original = btn.textContent;
    let armedTimer = 0;
    btn.addEventListener('click', () => {
      if (btn.dataset.armed === '1') {
        clearTimeout(armedTimer);
        btn.dataset.armed = '';
        btn.textContent = original;
        action();
        return;
      }
      btn.dataset.armed = '1';
      btn.textContent = confirmText;
      armedTimer = setTimeout(() => {
        btn.dataset.armed = '';
        btn.textContent = original;
      }, 3000);
    });
  }

  function snippet(n) {
    const text = (n.t || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 110 ? `${text.slice(0, 110)}…` : text;
    return n.k === 'image' ? 'Ảnh' : '(trống)';
  }

  function trashRow(n) {
    const preview = n.k === 'image'
      ? h('img', { class: 'tr-img', src: imgUrl(n.th || n.img), alt: '', draggable: 'false' })
      : null;
    const row = h('div', { class: 'tr-item', dataset: { color: n.c } },
      preview,
      h('div', { class: 'tr-body' },
        h('div', { class: 'tr-text' }, snippet(n)),
        h('div', { class: 'tr-meta' }, `Xóa ${timeAgo(n.del || n.mt)}`),
      ),
      h('div', { class: 'tr-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => restore(n.id) }, icon('restore', 15), 'Khôi phục'),
      ),
    );
    const purge = h('button', { type: 'button', class: 'btn small ghost-danger' }, 'Xóa hẳn');
    twoStep(purge, 'Chắc chắn?', () => store.purgeTrash([n.id]));
    row.querySelector('.tr-actions').append(purge);
    return row;
  }

  function renderTrash() {
    const items = [...store.state.trash].sort((a, b) => (b.del || 0) - (a.del || 0));
    badge.hidden = items.length === 0;
    badge.textContent = items.length > 99 ? '99+' : String(items.length);
    $('#drawer-empty').hidden = items.length === 0;
    if (drawer.hidden) return;
    if (!items.length) {
      list.replaceChildren(h('p', { class: 'drawer-empty-note' }, 'Thùng rác trống.'));
      return;
    }
    list.replaceChildren(...items.map(trashRow));
  }
  store.on('trash', renderTrash);

  function restore(id) {
    store.checkpoint();
    const n = store.restoreNote(id);
    if (!n) return;
    const el = layer.get(n.id);
    view.ensureVisible({ x: n.x, y: n.y, w: n.w, h: el ? el.offsetHeight : 120 });
    inter?.setSelection([n.id]);
    toast('Đã khôi phục mảnh giấy', { action: 'Hoàn tác', run: () => inter?.undo() });
  }

  function toggleDrawer(open) {
    const show = open ?? drawer.hidden;
    drawer.hidden = !show;
    if (show) renderTrash();
  }
  trashBtn.addEventListener('click', () => toggleDrawer());
  $('#drawer-close').addEventListener('click', () => toggleDrawer(false));
  twoStep($('#drawer-empty'), 'Bấm lần nữa để xóa hẳn tất cả', () => store.purgeTrash());
  renderTrash();

  // ------------------------------------------------------------ xem ảnh lớn

  const lbImg = $('#lb-img');
  let lbNoteId = null;
  function openLightbox(n) {
    if (!n || n.k !== 'image') return;
    lbNoteId = n.id;
    lbImg.src = imgUrl(n.img);
    $('#lb-open').href = imgUrl(n.img);
    $('#lb-caption').textContent = n.t || '';
    lightbox.hidden = false;
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lbImg.removeAttribute('src');
    lbNoteId = null;
  }
  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-copy').addEventListener('click', () => { if (lbNoteId) inter?.copyNotes([lbNoteId]); });
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target === lbImg) closeLightbox();
  });

  // ------------------------------------------------------------ hướng dẫn

  function toggleHelp(open) {
    const show = open ?? help.hidden;
    help.hidden = !show;
  }
  $('#help-close').addEventListener('click', () => toggleHelp(false));
  help.addEventListener('click', (e) => { if (e.target === help) toggleHelp(false); });

  // ------------------------------------------------------------ mất kết nối máy chủ

  const offline = $('#offline');
  function showOffline(show) {
    offline.hidden = !show;
  }

  // ------------------------------------------------------------ điều phối

  const blocking = () => !lightbox.hidden || !help.hidden;

  function closePopovers() {
    if (!menu.hidden) toggleMenu(false);
  }

  // Esc đóng lớp trên cùng đang mở. Trả về true nếu đã đóng thứ gì đó.
  function escape() {
    if (!lightbox.hidden) { closeLightbox(); return true; }
    if (!help.hidden) { toggleHelp(false); return true; }
    if (!menu.hidden) { toggleMenu(false); return true; }
    if (!searchBar.hidden) { closeSearch(); return true; }
    if (!drawer.hidden) { toggleDrawer(false); return true; }
    return false;
  }

  return {
    marqueeEl: $('#marquee'),
    toast,
    setTrash,
    overTrash,
    openLightbox,
    closePopovers,
    escape,
    blocking,
    openSearch,
    toggleHelp,
    fitAll,
    refreshHint,
    showOffline,
    bind(interactions) { inter = interactions; },
  };
}
