// Draws zones into the DOM: the rectangle behind the notes, its name tab, and, for the selected zone, the bar with
// its options and the resize handles. It also keeps each note's "faded" (low priority) and "veiled" (private) look
// in step with the zone the note sits in. Mouse and keyboard handling is in zoneinteractions.js.
//
// Layout notes:
//  - Zones live in #zones, the first child of #world, and are positioned with left/top, not `translate`:
//    `translate` would make every zone a stacking context and trap its name tab underneath the notes.
//  - The zone itself lets the pointer through (so the board keeps working inside a zone: pan, double-click for a note,
//    press and hold for a nested zone). Only the name tab, and the bar and handles of the selected zone, take clicks.
//  - Nothing here is set on the notes' parent every frame (see the traps in CLAUDE.md): the one CSS variable that
//    follows the zoom lives on #zones, whose children are only the few zones.

import { h, clamp } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { state, on } from './store.js';
import { ZONE_KINDS } from './constants.js';
import { noteCentre, containsPoint, sortForRender, sortSmallestFirst } from './zones.js';

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const kindName = (k) => t(`zone.kind.${k}`);

function setTitle(el, text) {
  el.title = text;
  el.setAttribute('aria-label', text);
}

function setIcon(button, name, size) {
  if (button._ico === name) return;
  button._ico = name;
  button.replaceChildren(icon(name, size));
}

function buildZone() {
  const tab = h('div', { class: 'ztab' },
    h('span', { class: 'zdot' }),
    h('span', { class: 'ztext' }),
    h('button', { type: 'button', class: 'zlock', dataset: { zact: 'reveal' } }),
  );
  return h('div', { class: 'zone' }, h('div', { class: 'zbox' }), h('div', { class: 'zhead' }, tab));
}

// The bar of the selected zone: kind, private, show/hide, trash.
function buildBar() {
  const button = (act, iconName) => h('button', { type: 'button', class: 'tbtn', dataset: { zact: act } }, icon(iconName, 17));
  return h('div', { class: 'zbar', role: 'toolbar' },
    ZONE_KINDS.map((k) => h('button', { type: 'button', class: 'zkind', dataset: { zact: 'kind', k } }, h('span', { class: 'zdot' }))),
    h('span', { class: 'zsep' }),
    button('private', 'lock'),
    button('reveal', 'eye'),
    button('del', 'trash'),
  );
}

export function createZoneLayer(root, layer, view) {
  const els = new Map();
  const revealedNotes = new Set(); // notes the owner clicked open inside a private zone (until the window reloads)
  const revealedZones = new Set(); // private zones whose notes are all shown
  let selected = null;
  let looksQueued = false;
  let lookAll = false;
  const lookIds = new Set();
  let hadZones = false;

  // ---- one zone

  function syncBar(el, z) {
    const bar = el._bar;
    if (!bar) return;
    for (const b of bar.querySelectorAll('.zkind')) {
      const isOn = b.dataset.k === z.k;
      b.classList.toggle('on', isOn);
      b.setAttribute('aria-pressed', String(isOn));
      setTitle(b, kindName(b.dataset.k));
    }
    const priv = bar.querySelector('[data-zact="private"]');
    priv.classList.toggle('on', !!z.p);
    priv.setAttribute('aria-pressed', String(!!z.p));
    setTitle(priv, z.p ? t('zone.tool.public') : t('zone.tool.private'));
    const reveal = bar.querySelector('[data-zact="reveal"]');
    const shown = revealedZones.has(z.id);
    reveal.hidden = !z.p;
    setIcon(reveal, shown ? 'eyeoff' : 'eye', 17);
    setTitle(reveal, shown ? t('zone.tool.hide') : t('zone.tool.reveal'));
    setTitle(bar.querySelector('[data-zact="del"]'), t('zone.tool.del'));
  }

  function updateZone(el, z) {
    Object.assign(el.style, { left: `${z.x}px`, top: `${z.y}px`, width: `${z.w}px`, height: `${z.h}px` });
    el.dataset.kind = z.k;
    const shown = !!z.p && revealedZones.has(z.id);
    el.classList.toggle('private', !!z.p);
    el.classList.toggle('revealed', shown);
    el.classList.toggle('unnamed', !z.t);
    if (!el.classList.contains('editing')) el.querySelector('.ztext').textContent = z.t || kindName(z.k);
    el.querySelector('.ztab').title = t('zone.tab');
    const lock = el.querySelector('.zlock');
    setIcon(lock, shown ? 'eye' : 'lock', 13);
    setTitle(lock, shown ? t('zone.tool.hide') : t('zone.tool.reveal'));
    syncBar(el, z);
  }

  function ensureParts(el) {
    if (el._bar) return;
    el._bar = buildBar();
    el.querySelector('.zhead').append(el._bar);
    el._handles = HANDLES.map((handle) => h('div', { class: `zh zh-${handle}`, dataset: { h: handle } }));
    el.append(...el._handles);
    const z = state.zones.get(el.dataset.id);
    if (z) syncBar(el, z);
  }

  function dropParts(el) {
    el._bar?.remove();
    el._handles?.forEach((handle) => handle.remove());
    el._bar = null;
    el._handles = null;
  }

  // The name tab and bar sit above the zone. Near the top of the screen they move inside it instead.
  function updateFlip(el) {
    if (el) el.toggleAttribute('data-flip', el.getBoundingClientRect().top < 72);
  }

  function leave(el) {
    dropParts(el);
    el.classList.add('leaving');
    el.style.pointerEvents = 'none';
    setTimeout(() => el.remove(), 200);
  }

  function sync(id) {
    const z = state.zones.get(id);
    let el = els.get(id);
    if (!z) {
      if (el) {
        els.delete(id);
        leave(el);
      }
      return;
    }
    if (!el) {
      el = buildZone();
      el.dataset.id = id;
      els.set(id, el);
      root.append(el);
    }
    updateZone(el, z);
  }

  // Draw order: the biggest zone first, so a small zone inside a big one is always on top of it.
  function order() {
    let cursor = root.firstElementChild;
    for (const z of sortForRender([...state.zones.values()])) {
      const el = els.get(z.id);
      if (!el) continue;
      if (el === cursor) cursor = cursor.nextElementSibling;
      else root.insertBefore(el, cursor);
    }
  }

  function syncAll() {
    for (const [id, el] of els) {
      if (!state.zones.has(id)) {
        els.delete(id);
        dropParts(el);
        el.remove();
      }
    }
    for (const id of state.zones.keys()) sync(id);
    order();
  }

  // ---- selection

  function setSelected(id) {
    const next = id && els.has(id) ? id : null;
    if (selected && selected !== next) {
      const old = els.get(selected);
      if (old) {
        old.classList.remove('sel');
        dropParts(old);
      }
    }
    selected = next;
    if (!selected) return;
    const el = els.get(selected);
    el.classList.add('sel');
    ensureParts(el);
    updateFlip(el);
  }

  // ---- how a note looks because of the zone it sits in

  // Faded: the innermost zone around its centre is "low priority". Veiled: any private zone around it, unless the
  // owner revealed that zone or this note. Done in one pass over the notes whenever notes or zones change.
  function refreshLooks() {
    looksQueued = false;
    const everything = lookAll;
    const only = [...lookIds];
    lookAll = false;
    lookIds.clear();
    const zones = sortSmallestFirst([...state.zones.values()]);
    if (!zones.length && !hadZones) return;
    hadZones = zones.length > 0;
    const targets = everything ? layer.entries() : only.map((id) => [id, layer.get(id)]);
    for (const [id, el] of targets) {
      const n = state.notes.get(id);
      if (!n || !el) continue;
      let fade = false;
      let veil = false;
      if (zones.length) {
        const c = noteCentre(n, el.offsetHeight);
        let innermost = true;
        for (const z of zones) {
          if (!containsPoint(z, c)) continue;
          if (innermost) fade = z.k === 'low';
          innermost = false;
          if (z.p && !revealedZones.has(z.id)) veil = true;
        }
        if (veil && revealedNotes.has(id)) veil = false;
      }
      if (el._zfade !== fade) {
        el._zfade = fade;
        el.classList.toggle('zfade', fade);
      }
      if (el._zveil !== veil) {
        el._zveil = veil;
        el.classList.toggle('zveil', veil);
      }
    }
  }

  // With note ids: only those notes are looked at again (a note was moved or clicked). Without: every note
  // (a zone changed, or the board was reloaded).
  function scheduleLooks(ids) {
    if (ids) ids.forEach((id) => lookIds.add(id));
    else lookAll = true;
    if (looksQueued) return;
    looksQueued = true;
    queueMicrotask(refreshLooks);
  }

  const isVeiled = (id) => !!layer.get(id)?.classList.contains('zveil');

  function revealNote(id) {
    if (revealedNotes.has(id)) return;
    revealedNotes.add(id);
    scheduleLooks([id]);
  }

  function toggleReveal(zoneId) {
    if (revealedZones.has(zoneId)) {
      revealedZones.delete(zoneId);
      revealedNotes.clear(); // "hide again" also covers the notes that were opened one by one
    } else {
      revealedZones.add(zoneId);
    }
    sync(zoneId);
    scheduleLooks();
  }

  // Hide everything again (used when a zone is made private, so its notes are covered at once).
  function hideAll() {
    revealedNotes.clear();
    revealedZones.clear();
    for (const id of els.keys()) sync(id);
    scheduleLooks();
  }

  // ---- wiring

  on('zones', (d) => {
    if (d.reset) {
      syncAll();
    } else {
      d.removed?.forEach(sync);
      d.changed?.forEach(sync);
      order();
    }
    if (selected && !state.zones.has(selected)) setSelected(null);
    scheduleLooks();
  });
  on('notes', (d) => {
    if (d.reset) scheduleLooks();
    else if (d.changed) scheduleLooks(d.changed);
  });

  // Name tabs and handles keep a readable size when the board is zoomed out. Writing the variable makes the browser
  // recalculate every zone, so while zooming it is written at most about ten times a second.
  let zkApplied = 1;
  let zkAt = 0;
  let zkTimer = 0;
  const applyZk = () => {
    zkTimer = 0;
    zkAt = performance.now();
    const k = Math.round(clamp(1 / view.v.z, 1, 3.2) * 1000) / 1000;
    if (k === zkApplied) return;
    zkApplied = k;
    root.style.setProperty('--zk', String(k));
    if (selected) updateFlip(els.get(selected));
  };
  view.onChange(() => {
    const since = performance.now() - zkAt;
    if (since >= 100) applyZk();
    else if (!zkTimer) zkTimer = setTimeout(applyZk, 100 - since);
  });
  applyZk();

  return {
    root,
    get: (id) => els.get(id),
    entries: () => els.entries(),
    sync,
    syncAll,
    selected: () => selected,
    setSelected,
    updateFlip,
    isVeiled,
    revealNote,
    toggleReveal,
    hideAll,
    refreshLooks: scheduleLooks,
  };
}
