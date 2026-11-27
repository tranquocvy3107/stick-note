// The interface around the board: save status, zoom controls, search, menu, trash, image viewer, help.
// Every control is small and sits at the edge so the board stays clear.

import * as store from './store.js';
import { api, imgUrl } from './api.js';
import { h, fold, timeAgo, debounce, readingOrder } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { t, tNode, getLanguage, getChoice, setChoice, choiceLabel, LANGUAGES } from './i18n.js';
import { HELP_SECTIONS, TRASH_KEEP_DAYS } from './constants.js';

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
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

const STATUS_KEYS = {
  loading: 'status.loading',
  saved: 'status.saved',
  pending: 'status.pending',
  saving: 'status.saving',
  error: 'status.error',
};
const THEMES = ['auto', 'light', 'dark'];
const LANGUAGE_CHOICES = ['auto', ...LANGUAGES.map((l) => l.code)];

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
  const stopped = $('#stopped');
  const trashBtn = $('#trash');
  const toastEl = $('#toast');

  const timeOptions = () => ({ lang: getLanguage(), justNow: t('time.justNow') });

  // ------------------------------------------------------------ texts that need parameters

  // The tray slips are plain buttons in the HTML; their labels name the colour, so they are filled in here.
  // (The zone tile has no colour and is labelled in the HTML.)
  for (const pad of $('#dock').querySelectorAll('.pad[data-color]')) {
    const color = t(`color.${pad.dataset.color}`).toLocaleLowerCase(getLanguage());
    pad.title = t('dock.pad', { color });
    pad.setAttribute('aria-label', t('dock.padLabel', { color }));
  }
  $('#drawer-note').textContent = t('trash.note', { days: TRASH_KEEP_DAYS });

  function buildHelp() {
    const params = { days: TRASH_KEEP_DAYS };
    $('#help-grid').replaceChildren(...HELP_SECTIONS.map((section) => h('section', null,
      h('h3', null, t(section.title)),
      h('dl', null, section.rows.flatMap((row) => [
        h('dt', null, tNode(`${row}.k`, params)),
        h('dd', null, tNode(`${row}.d`, params)),
      ])),
    )));
  }
  buildHelp();

  // ------------------------------------------------------------ small notices

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
    void toastEl.offsetWidth; // restart the entrance animation
    toastEl.classList.add('in');
    toastTimer = setTimeout(hideToast, ms);
  }

  // ------------------------------------------------------------ save status

  const statusEl = $('#status');
  const statusText = $('#status-text');
  function renderStatus(status) {
    statusEl.dataset.state = status;
    statusText.textContent = STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : '';
    if (status === 'saved' && store.state.savedAt) {
      const time = new Date(store.state.savedAt).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
      statusEl.title = t('status.savedAt', { time });
    }
  }
  store.on('status', renderStatus);
  renderStatus(store.state.status);

  // A long save failure (the server went away) is announced by a red banner that does not block anything.
  // Between retries the status flips through "saving", so only a successful save clears the banner.
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
  store.on('merged', () => toast(t('toast.merged'), { ms: 3000 }));

  // ------------------------------------------------------------ zoom

  const zoomLabel = $('#zoom-label');
  // Changing text makes the browser lay out again, so while zooming continuously the label is updated only a few times a second.
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
    for (const z of store.state.zones.values()) rects.push({ x: z.x, y: z.y, w: z.w, h: z.h });
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

  // ------------------------------------------------------------ hint shown while the board is empty

  const hint = $('#hint');
  function refreshHint() {
    hint.hidden = store.state.status === 'loading' || store.state.notes.size > 0;
  }
  store.on('notes', refreshHint);
  store.on('status', refreshHint);

  // ------------------------------------------------------------ search

  let matches = [];
  let matchIndex = -1;

  function updateCount() {
    if (!searchInput.value.trim()) searchCount.textContent = '';
    else if (!matches.length) searchCount.textContent = t('search.none');
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
  }
  function menuItem(act) {
    return menu.querySelector(`[data-act="${act}"]`);
  }
  function syncMenuState() {
    menuItem('tilt').setAttribute('aria-checked', String(settings.tilt));
    $('#theme-label').textContent = t(`theme.${settings.theme}`);
    $('#lang-label').textContent = choiceLabel(getChoice());
  }

  // The version is shown at the bottom of the menu so a bug report can say which build it is.
  let appVersion = '';
  api.info().then((info) => { appVersion = info.version || ''; }).catch(() => {});

  function toggleMenu(open) {
    const show = open ?? menu.hidden;
    menu.hidden = !show;
    menuBtn.setAttribute('aria-expanded', String(show));
    if (show) {
      const s = store.state;
      const counts = t('menu.foot', { count: s.notes.size, trash: s.trash.length + s.zonesTrash.length });
      $('#menu-foot').textContent = appVersion ? `${counts} · v${appVersion}` : counts;
      syncMenuState();
    }
  }
  menuBtn.addEventListener('click', () => toggleMenu());
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('#menu, #btn-menu')) toggleMenu(false);
  });

  // Save anything still pending, then ask the server to quit and tell the user the window can be closed.
  async function quit() {
    const deadline = Date.now() + 3000;
    while (store.isDirty() && Date.now() < deadline) {
      await store.flush();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try { await api.shutdown(); } catch { /* the server is already gone */ }
    stopped.hidden = false;
    window.close(); // only works when the browser allows it; the message above covers the other case
  }

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
      syncMenuState();
      return;
    }
    if (act === 'language') {
      // Cycles Auto -> English -> Tiếng Việt -> ... and reloads so every text switches at once.
      setChoice(LANGUAGE_CHOICES[(LANGUAGE_CHOICES.indexOf(getChoice()) + 1) % LANGUAGE_CHOICES.length]);
      return;
    }
    toggleMenu(false);
    try {
      if (act === 'fit') fitAll();
      else if (act === 'home') view.home();
      else if (act === 'help') toggleHelp(true);
      else if (act === 'quit') await quit();
      else if (act === 'folder') {
        await api.openDataFolder();
      } else if (act === 'backup') {
        const res = await api.backupNow();
        toast(res.file ? t('toast.backedUp', { file: res.file }) : t('toast.nothingToBackUp'), { ms: 4000 });
      }
    } catch (err) {
      toast(t('toast.actionFailed', { message: err.message || err }), { ms: 5000 });
    }
  });
  applyTheme();
  syncMenuState();

  // ------------------------------------------------------------ trash

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

  // Deleting for good takes two clicks: the first changes the label, the second does it.
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
    return n.k === 'image' ? t('note.image') : t('note.empty');
  }

  function trashRow(n) {
    const preview = n.k === 'image'
      ? h('img', { class: 'tr-img', src: imgUrl(n.th || n.img), alt: '', draggable: 'false' })
      : null;
    const row = h('div', { class: 'tr-item', dataset: { color: n.c } },
      preview,
      h('div', { class: 'tr-body' },
        h('div', { class: 'tr-text' }, snippet(n)),
        h('div', { class: 'tr-meta' }, t('trash.deleted', { when: timeAgo(n.del || n.mt, timeOptions()) })),
      ),
      h('div', { class: 'tr-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => restore(n.id) }, icon('restore', 15), t('trash.restore')),
      ),
    );
    const purge = h('button', { type: 'button', class: 'btn small ghost-danger' }, t('trash.purge'));
    twoStep(purge, t('trash.sure'), () => store.purgeTrash([n.id]));
    row.querySelector('.tr-actions').append(purge);
    return row;
  }

  // A deleted zone: only its name and kind are worth showing. The notes that were inside never left the board.
  function zoneTrashRow(z) {
    const name = z.t || t(`zone.kind.${z.k}`);
    const row = h('div', { class: 'tr-item zrow', dataset: { kind: z.k } },
      h('div', { class: 'tr-body' },
        h('div', { class: 'tr-text' }, icon('zone', 15), t('trash.zone', { name })),
        h('div', { class: 'tr-meta' }, t('trash.deleted', { when: timeAgo(z.del || z.mt, timeOptions()) })),
      ),
      h('div', { class: 'tr-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => restoreZone(z.id) }, icon('restore', 15), t('trash.restore')),
      ),
    );
    const purge = h('button', { type: 'button', class: 'btn small ghost-danger' }, t('trash.purge'));
    twoStep(purge, t('trash.sure'), () => store.purgeTrash([z.id]));
    row.querySelector('.tr-actions').append(purge);
    return row;
  }

  function renderTrash() {
    // Notes and zones share one trash, newest deletion first.
    const items = [
      ...store.state.trash.map((item) => ({ item, zone: false })),
      ...store.state.zonesTrash.map((item) => ({ item, zone: true })),
    ].sort((a, b) => (b.item.del || 0) - (a.item.del || 0));
    badge.hidden = items.length === 0;
    badge.textContent = items.length > 99 ? '99+' : String(items.length);
    $('#drawer-empty').hidden = items.length === 0;
    if (drawer.hidden) return;
    if (!items.length) {
      list.replaceChildren(h('p', { class: 'drawer-empty-note' }, t('trash.isEmpty')));
      return;
    }
    list.replaceChildren(...items.map(({ item, zone }) => (zone ? zoneTrashRow(item) : trashRow(item))));
  }
  store.on('trash', renderTrash);

  function restoreZone(id) {
    store.checkpoint();
    const z = store.restoreZone(id);
    if (!z) return;
    view.ensureVisible({ x: z.x, y: z.y, w: z.w, h: z.h });
    inter?.zones.select(z.id);
    toast(t('trash.zoneRestored'), { action: t('common.undo'), run: () => inter?.undo() });
  }

  function restore(id) {
    store.checkpoint();
    const n = store.restoreNote(id);
    if (!n) return;
    const el = layer.get(n.id);
    view.ensureVisible({ x: n.x, y: n.y, w: n.w, h: el ? el.offsetHeight : 120 });
    inter?.setSelection([n.id]);
    toast(t('trash.restored'), { action: t('common.undo'), run: () => inter?.undo() });
  }

  function toggleDrawer(open) {
    const show = open ?? drawer.hidden;
    drawer.hidden = !show;
    if (show) renderTrash();
  }
  trashBtn.addEventListener('click', () => toggleDrawer());
  $('#drawer-close').addEventListener('click', () => toggleDrawer(false));
  twoStep($('#drawer-empty'), t('trash.emptyConfirm'), () => store.purgeTrash());
  renderTrash();

  // ------------------------------------------------------------ image viewer

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

  // ------------------------------------------------------------ help

  function toggleHelp(open) {
    const show = open ?? help.hidden;
    help.hidden = !show;
  }
  $('#help-close').addEventListener('click', () => toggleHelp(false));
  help.addEventListener('click', (e) => { if (e.target === help) toggleHelp(false); });

  // ------------------------------------------------------------ server unreachable

  const offline = $('#offline');
  function showOffline(show) {
    offline.hidden = !show;
  }

  // ------------------------------------------------------------ coordination

  const blocking = () => !lightbox.hidden || !help.hidden || !stopped.hidden;

  function closePopovers() {
    if (!menu.hidden) toggleMenu(false);
  }

  // Esc closes the topmost open layer. Returns true if it closed something.
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
    zoneDrawEl: $('#zdraw'),
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
