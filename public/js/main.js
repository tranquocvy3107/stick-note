// Start-up: wire the parts together, load the data and keep in touch with the server.

import * as store from './store.js';
import { api } from './api.js';
import { createView } from './view.js';
import { createLayer } from './noteview.js';
import { createZoneLayer } from './zoneview.js';
import { createInteractions } from './interactions.js';
import { createCapture } from './capture.js';
import { createUI, loadSettings } from './ui.js';
import { initI18n, applyStaticTranslations } from './i18n.js';
import { debounce, uid } from './util.js';

const VIEW_KEY = 'stick-note:view';
const WINDOW_KEY = 'stick-note:window';

// A name for this window, kept across reloads (sessionStorage belongs to the window). The server uses it to know
// which windows are open.
function windowId() {
  try {
    let id = sessionStorage.getItem(WINDOW_KEY);
    if (!id) {
      id = uid('w');
      sessionStorage.setItem(WINDOW_KEY, id);
    }
    return id;
  } catch {
    return uid('w'); // storage is blocked: a new name for every page load is still fine
  }
}

async function boot() {
  // The translations come from the server too. If it is still starting, show the offline notice
  // (the page's own English text) and keep trying instead of failing.
  for (;;) {
    try {
      await initI18n();
      break;
    } catch (err) {
      console.warn('Cannot load the translations yet:', err);
      document.documentElement.removeAttribute('data-i18n-pending');
      document.getElementById('offline').hidden = false;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
  applyStaticTranslations();

  const board = document.getElementById('board');
  const world = document.getElementById('world');
  const settings = loadSettings();

  let ui;
  const view = createView(board, world, { isBlocked: () => ui.blocking() });
  const layer = createLayer(world, () => settings);
  const zoneLayer = createZoneLayer(document.getElementById('zones'), layer, view);
  ui = createUI({ board, view, layer, settings, onTiltChange: () => layer.syncAll() });
  const inter = createInteractions({ board, world, view, layer, zoneLayer, ui });
  const capture = createCapture({ board, view, layer, inter, ui, dockEl: document.getElementById('dock') });
  inter.setCapture(capture);
  ui.bind(inter);

  // Reopen at the area and zoom level you left.
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite)) view.set(saved.x, saved.y, saved.z);
    else view.set(0, 0, 1);
  } catch {
    view.set(0, 0, 1);
  }
  const saveView = debounce(() => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view.v)); } catch { /* ignore */ }
  }, 300);
  view.onChange(saveView);

  // Load the data. If the server is not ready yet, say so and keep retrying.
  for (;;) {
    try {
      await store.load();
      ui.showOffline(false);
      break;
    } catch (err) {
      console.warn('Cannot reach the server yet:', err);
      ui.showOffline(true);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
  ui.refreshHint();

  // Tell the server this window is open, and say goodbye when it closes: the server quits by itself once no window
  // is left. The server does not count a quiet window as closed (a browser may freeze a hidden one for hours), so the
  // goodbye matters more than the heartbeat.
  const myId = windowId();
  api.ping(myId);
  setInterval(() => api.ping(myId), 20_000);
  const wake = () => { api.ping(myId); store.checkRemote(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  document.addEventListener('resume', wake); // the browser woke this window from a freeze
  window.addEventListener('pageshow', (e) => { if (e.persisted) wake(); });
  window.addEventListener('focus', () => store.checkRemote());
  window.addEventListener('beforeunload', () => { saveView.flush(); store.flushOnExit(); });
  window.addEventListener('pagehide', () => { store.flushOnExit(); api.bye(myId); });

  // For testing and debugging in the Console: window.stickNote
  window.stickNote = { store, view, layer, zoneLayer, inter, ui, capture };
}

boot().catch((err) => {
  console.error(err);
  document.documentElement.removeAttribute('data-i18n-pending');
  document.body.insertAdjacentHTML('beforeend', '<pre style="position:fixed;inset:20px;color:#b00;z-index:99;white-space:pre-wrap"></pre>');
  document.body.lastElementChild.textContent = `Stick Note hit an error while starting:\n${err && err.stack ? err.stack : err}`;
});
