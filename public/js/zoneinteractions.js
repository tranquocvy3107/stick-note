// What the owner does with zones: draw, move, resize, rename, change kind, make private, delete.
//
// interactions.js owns the pointer pipeline (one gesture at a time) and the shortcuts; it hands over everything
// that is zone business and lends the shared tools through `tools`. As with notes, a drag only changes the DOM and
// the store is written once on release, so one drag is one undo step.
//
// Product rule, enforced here: a zone never rearranges what lies inside it. The only thing that moves notes is the
// owner dragging a zone, and then the notes inside travel together, exactly as they were.

import * as store from './store.js';
import { t } from './i18n.js';
import { round } from './util.js';
import { NOTE_H, ZONE_KINDS, ZONE_LABEL_MAX } from './constants.js';
import {
  carriedBy, defaultZoneSize, rectFromPoints, atLeastMinimum, resizeRect, wrapRect, rectOf,
} from './zones.js';
import { placeAt } from './noteview.js';

const DRAG_THRESHOLD = 4; // px: moving less than this is a click
const MIN_DRAW_PX = 24; // a zone drawn shorter than this is taken as "never mind"

/**
 * tools (from interactions.js):
 *   setGesture(g)           make g the current gesture
 *   capturePointer(id), releasePointer(id)
 *   endEdit()               finish editing a note's text
 *   clearNotes()            deselect all notes
 *   noteIds()               ids of the selected notes
 *   isDoubleTap(e, key)     double click / double tap detection shared with notes
 *   suppressClick(ms)       swallow the click the browser sends after a drag
 *   lastPointer()           last pointer position over the board, or null
 *   undo()
 */
export function createZoneInteractions({ board, view, layer, zoneLayer, ui, tools }) {
  const { state } = store;
  const heightOf = (note) => layer.get(note.id)?.offsetHeight || 0;
  let labelEdit = null; // { id, input, original, isNew }

  // ------------------------------------------------------------ selection

  function select(id) {
    tools.endEdit();
    tools.clearNotes();
    zoneLayer.setSelected(id);
  }
  const clear = () => zoneLayer.setSelected(null);

  // ------------------------------------------------------------ the name

  function startLabelEdit(id, { isNew = false } = {}) {
    const z = state.zones.get(id);
    const el = zoneLayer.get(id);
    if (!z || !el) return;
    if (labelEdit && labelEdit.id === id) {
      labelEdit.input.focus();
      return;
    }
    endLabelEdit();
    select(id);

    const input = document.createElement('input');
    input.className = 'zinput';
    input.type = 'text';
    input.value = z.t || '';
    input.maxLength = ZONE_LABEL_MAX;
    input.placeholder = t('zone.label.placeholder');
    input.setAttribute('aria-label', t('zone.label.aria'));
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // mid-composition in an input method (Telex, VNI, Pinyin...): let it handle Esc/Enter
      if (e.key === 'Enter') {
        e.preventDefault();
        endLabelEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endLabelEdit(true);
      }
    });
    // Clicking elsewhere finishes. Ignored when the whole window loses focus (switching apps).
    input.addEventListener('blur', () => {
      if (!document.hasFocus()) return;
      setTimeout(() => {
        if (labelEdit && labelEdit.input === input && document.activeElement !== input) endLabelEdit();
      }, 0);
    });

    el.classList.add('editing');
    el.querySelector('.ztext').replaceChildren(input);
    labelEdit = { id, input, original: z.t || '', isNew };
    input.focus({ preventScroll: true });
    input.select();
  }

  function endLabelEdit(cancel = false) {
    if (!labelEdit) return;
    const { id, input, original, isNew } = labelEdit;
    labelEdit = null;
    zoneLayer.get(id)?.classList.remove('editing');
    const text = input.value.trim().slice(0, ZONE_LABEL_MAX);
    if (!cancel && state.zones.has(id) && text !== original) {
      if (!isNew) store.checkpoint(); // a new zone already got a checkpoint when it was drawn: one undo step covers both
      store.updateZones([id], { t: text });
    }
    zoneLayer.sync(id); // puts the name (or the kind's name) back into the tab
  }

  // ------------------------------------------------------------ creating

  // rect: board coordinates. The zone is selected and its name is ready to be typed.
  function create(rect, { kind = 'normal' } = {}) {
    tools.endEdit();
    endLabelEdit();
    store.checkpoint();
    const z = store.addZone({ ...rect, k: kind });
    const el = zoneLayer.get(z.id);
    if (el) {
      el.classList.add('just-drawn');
      el.addEventListener('animationend', () => el.classList.remove('just-drawn'), { once: true });
    }
    startLabelEdit(z.id, { isNew: true });
    return z;
  }

  // A zone centred on a board point, as big as a new zone should look on screen at the current zoom.
  function createAt(wx, wy) {
    const { w, h } = defaultZoneSize(view.v.z);
    return create({ x: wx - w / 2, y: wy - h / 2, w, h });
  }

  function createAtPointer() {
    const p = tools.lastPointer();
    const sz = view.size();
    const c = view.toWorld(p ? p.x : sz.w / 2, p ? p.y : sz.h / 2);
    return createAt(c.x, c.y);
  }

  function createAtCenter() {
    const sz = view.size();
    const c = view.toWorld(sz.w / 2, sz.h / 2);
    return createAt(c.x, c.y);
  }

  // G: a zone around the selected notes. Nothing is moved.
  function wrapSelected() {
    const rects = tools.noteIds()
      .map((id) => {
        const n = state.notes.get(id);
        const el = layer.get(id);
        return n && { x: n.x, y: n.y, w: n.w, h: el ? el.offsetHeight : n.h || NOTE_H };
      })
      .filter(Boolean);
    if (!rects.length) {
      ui.toast(t('toast.zoneNeedsNotes'), { ms: 3800 });
      return null;
    }
    return create(wrapRect(rects));
  }

  // Press and hold on the empty board, then drag: a rubber band follows the pointer, and letting go makes the zone.
  // `start` is where the pointer went down (screen px). Returns the gesture that takes over from the plain press.
  function drawGesture(e, start) {
    const band = ui.zoneDrawEl;
    const paint = (p) => {
      Object.assign(band.style, {
        left: `${Math.min(start.x, p.x)}px`,
        top: `${Math.min(start.y, p.y)}px`,
        width: `${Math.abs(start.x - p.x)}px`,
        height: `${Math.abs(start.y - p.y)}px`,
      });
    };
    tools.capturePointer(e.pointerId);
    board.classList.add('drawing');
    band.hidden = false;
    paint(start);
    return {
      type: 'zdraw',
      pointerId: e.pointerId,
      onMove(ev) {
        paint({ x: ev.clientX, y: ev.clientY });
      },
      onUp(ev, cancelled) {
        band.hidden = true;
        board.classList.remove('drawing');
        tools.releasePointer(e.pointerId);
        if (cancelled || !ev) return;
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < MIN_DRAW_PX) return; // held but never dragged
        tools.suppressClick(150);
        create(atLeastMinimum(rectFromPoints(view.toWorld(start.x, start.y), view.toWorld(ev.clientX, ev.clientY))));
      },
    };
  }

  // ------------------------------------------------------------ moving

  // Press on a zone's name tab: select it; drag to move it with what is inside; double-click to rename.
  function beginTabPress(e, zoneEl) {
    const id = zoneEl.dataset.id;
    const zone = state.zones.get(id);
    if (!zone) return;
    if (labelEdit && labelEdit.id !== id) endLabelEdit();
    select(id);

    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let carried = null;
    let carriedZones = [];
    let carriedNotes = [];
    const origin = { x: zone.x, y: zone.y };

    // While dragging, a zone's parts are shifted with `translate`, which costs the browser almost nothing. Changing
    // `left` and `top` instead makes it lay out the whole board again every frame (about 5 ms with 1,500 notes);
    // the real position is written once, on release.
    const shift = (el, dx, dy) => {
      const value = `${dx}px ${dy}px`;
      for (const part of el.children) part.style.translate = value;
    };
    const unshift = (el) => {
      if (el) for (const part of el.children) part.style.translate = '';
    };
    const restore = () => {
      zoneLayer.sync(id);
      carriedZones.forEach((c) => zoneLayer.sync(c.id));
      carriedNotes.forEach((c) => layer.sync(c.id));
    };
    const liftOff = () => {
      zoneEl.classList.remove('dragging');
      unshift(zoneEl);
      carriedZones.forEach((c) => unshift(zoneLayer.get(c.id)));
      carriedNotes.forEach((c) => layer.get(c.id)?.classList.remove('dragging'));
    };

    tools.setGesture({
      type: 'zone',
      pointerId: e.pointerId,
      onMove(ev) {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!dragging) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          dragging = true;
          tools.capturePointer(ev.pointerId);
          carried = carriedBy(zone, state.notes.values(), [...state.zones.values()], heightOf);
          carriedZones = carried.zoneIds.map((zid) => state.zones.get(zid)).map((z) => ({ id: z.id, x: z.x, y: z.y }));
          carriedNotes = carried.noteIds.map((nid) => state.notes.get(nid)).map((n) => ({ id: n.id, x: n.x, y: n.y }));
          zoneEl.classList.add('dragging');
          carriedNotes.forEach((c) => layer.get(c.id)?.classList.add('dragging'));
        }
        const k = view.v.z;
        shift(zoneEl, dx / k, dy / k);
        for (const c of carriedZones) {
          const el = zoneLayer.get(c.id);
          if (el) shift(el, dx / k, dy / k);
        }
        for (const c of carriedNotes) {
          const el = layer.get(c.id);
          if (el) placeAt(el, c.x + dx / k, c.y + dy / k);
        }
      },
      onUp(ev, cancelled) {
        tools.releasePointer(e.pointerId);
        if (dragging) {
          tools.suppressClick(120);
          liftOff();
          if (cancelled || !ev) {
            restore(); // put everything back where it was
            return;
          }
          const k = view.v.z;
          const dx = (ev.clientX - start.x) / k;
          const dy = (ev.clientY - start.y) / k;
          store.checkpoint();
          store.moveZones(new Map([
            [id, { x: origin.x + dx, y: origin.y + dy }],
            ...carriedZones.map((c) => [c.id, { x: c.x + dx, y: c.y + dy }]),
          ]));
          store.moveNotes(new Map(carriedNotes.map((c) => [c.id, { x: c.x + dx, y: c.y + dy }])));
          zoneLayer.updateFlip(zoneEl);
          if (carried.pinned) ui.toast(t('toast.zonePinned', { count: carried.pinned }), { ms: 4800 });
          return;
        }
        if (cancelled || !ev) return;
        if (tools.isDoubleTap(ev, id)) startLabelEdit(id);
      },
    });
  }

  // ------------------------------------------------------------ resizing

  function beginResize(e, zoneEl, handle) {
    const id = zoneEl.dataset.id;
    const zone = state.zones.get(id);
    if (!zone) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const r0 = rectOf(zone);
    let rect = r0;
    let changed = false;
    tools.capturePointer(e.pointerId);
    zoneEl.classList.add('resizing');
    tools.setGesture({
      type: 'zresize',
      pointerId: e.pointerId,
      onMove(ev) {
        const k = view.v.z;
        rect = resizeRect(r0, handle, (ev.clientX - start.x) / k, (ev.clientY - start.y) / k);
        Object.assign(zoneEl.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
        changed = true;
      },
      onUp(ev, cancelled) {
        tools.releasePointer(e.pointerId);
        zoneEl.classList.remove('resizing');
        if (cancelled || !changed) {
          zoneLayer.sync(id);
          return;
        }
        store.checkpoint();
        store.updateZones([id], { x: round(rect.x, 1), y: round(rect.y, 1), w: round(rect.w, 0), h: round(rect.h, 0) });
        zoneLayer.updateFlip(zoneEl);
      },
    });
  }

  // ------------------------------------------------------------ the options of a zone

  function setKind(id, kind) {
    const z = state.zones.get(id);
    if (!z || z.k === kind || !ZONE_KINDS.includes(kind)) return;
    store.checkpoint();
    store.updateZones([id], { k: kind });
  }

  function togglePrivate(id) {
    const z = state.zones.get(id);
    if (!z) return;
    store.checkpoint();
    store.updateZones([id], { p: z.p ? 0 : 1 });
    if (!z.p) {
      zoneLayer.hideAll(); // it was just made private: cover its notes at once, even ones opened earlier
      ui.toast(t('toast.zonePrivate'), { ms: 3800 });
    }
  }

  const toggleReveal = (id) => zoneLayer.toggleReveal(id);

  function deleteZone(id) {
    const z = state.zones.get(id);
    if (!z) return;
    endLabelEdit(true);
    store.checkpoint();
    store.removeZones([id]);
    ui.toast(t('toast.zoneTrashed'), { action: t('common.undo'), run: tools.undo });
  }

  // Clicks on the buttons of the bar and on the lock in the name tab. Returns true when it handled the click.
  function onWorldClick(e) {
    const button = e.target.closest?.('[data-zact]');
    const zoneEl = button?.closest('.zone');
    if (!zoneEl) return false;
    e.preventDefault();
    e.stopPropagation();
    button.blur();
    const id = zoneEl.dataset.id;
    switch (button.dataset.zact) {
      case 'kind': setKind(id, button.dataset.k); break;
      case 'private': togglePrivate(id); break;
      case 'reveal': toggleReveal(id); break;
      case 'del': deleteZone(id); break;
      default: break;
    }
    return true;
  }

  // Keys that mean something while a zone is selected. Returns true when it handled the key.
  function onKeyDown(e) {
    const id = zoneLayer.selected();
    if (!id) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteZone(id);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startLabelEdit(id);
      return true;
    }
    return false;
  }

  return {
    select,
    clear,
    selected: () => zoneLayer.selected(),
    create,
    createAt,
    createAtPointer,
    createAtCenter,
    wrapSelected,
    drawGesture,
    beginTabPress,
    beginResize,
    startLabelEdit,
    endLabelEdit,
    isEditing: () => !!labelEdit,
    setKind,
    togglePrivate,
    toggleReveal,
    deleteZone,
    onWorldClick,
    onKeyDown,
  };
}
