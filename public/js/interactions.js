// Everything the user does on the board: select, drag, resize, edit text, shortcuts, copy, delete, undo.
//
// How it works: mouse and touch gestures (dragging a note, dragging the background, area select, resize,
// two-finger pinch) are each one "gesture" at a time. While dragging we only change the DOM, to stay smooth;
// the store is written once on release (one undo step).

import * as store from './store.js';
import { clamp, isTextField, readingOrder, writeClipboardText } from './util.js';
import { MIN_W, MAX_W, NOTE_H } from './constants.js';
import { imgUrl } from './api.js';
import { placeAt } from './noteview.js';
import { toPngBlob } from './image.js';
import { t } from './i18n.js';

const DRAG_THRESHOLD = 4; // px: moving less than this still counts as a click, so clicking a link never drags by accident

export function createInteractions({ board, world, view, layer, ui }) {
  const { state } = store;
  const selection = new Set();
  const pointers = new Map();
  let gesture = null;
  let editing = null;
  let spaceDown = false;
  let lastPointer = null;
  let suppressClickUntil = 0;
  let lastTap = { t: 0, x: 0, y: 0, key: '' };
  let capture = null;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const selected = () => [...selection];

  // ------------------------------------------------------------ selection

  // The toolbar sits above a note. If the note is close to the top or left edge of the screen,
  // flip the toolbar below / to the right so it is not cut off.
  function updateFlip(el) {
    const r = el.getBoundingClientRect();
    el.toggleAttribute('data-flip-y', r.top < 64);
    el.toggleAttribute('data-flip-x', r.right < 200);
  }

  function setSelection(ids) {
    const next = new Set(ids.filter((id) => state.notes.has(id)));
    for (const id of selection) if (!next.has(id)) layer.get(id)?.classList.remove('sel');
    for (const id of next) {
      const el = layer.get(id);
      if (!el) continue;
      el.classList.add('sel');
      if (next.size <= 8) {
        layer.ensureTools(el);
        updateFlip(el);
      }
    }
    selection.clear();
    next.forEach((id) => selection.add(id));
  }

  store.on('notes', (d) => {
    if (d.reset || d.removed) setSelection(selected());
  });

  world.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('.note');
    if (!el) return;
    layer.ensureTools(el);
    updateFlip(el);
  });
  view.onChange(() => {
    if (selection.size === 0 || selection.size > 8) return;
    for (const id of selection) {
      const el = layer.get(id);
      if (el) updateFlip(el);
    }
  });

  // ------------------------------------------------------------ double click (shared by mouse and touch)

  function isDoubleTap(e, key) {
    const now = performance.now();
    const dbl = key === lastTap.key && now - lastTap.t < 380 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
    lastTap = dbl ? { t: 0, x: 0, y: 0, key: '' } : { t: now, x: e.clientX, y: e.clientY, key };
    return dbl;
  }

  // ------------------------------------------------------------ editing text

  function startEdit(id, { isNew = false } = {}) {
    const n = state.notes.get(id);
    const el = layer.get(id);
    if (!n || !el) return;
    if (editing && editing.id === id) {
      editing.ta.focus({ preventScroll: true });
      return;
    }
    endEdit();
    setSelection([id]);

    const ta = document.createElement('textarea');
    ta.className = 'editor';
    ta.value = n.t || '';
    ta.rows = 1;
    ta.placeholder = n.k === 'image' ? t('edit.placeholder.image') : t('edit.placeholder.text');
    ta.setAttribute('aria-label', n.k === 'image' ? t('edit.label.image') : t('edit.label.text'));
    const fit = () => {
      ta.style.height = '0px';
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return; // mid-composition in an input method (Telex, VNI, Pinyin...): let it handle Esc/Enter
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endEdit();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        endEdit();
      }
    });
    // Clicking outside finishes editing. Ignored when the whole window loses focus (switching apps to copy a link).
    ta.addEventListener('blur', () => {
      if (!document.hasFocus()) return;
      setTimeout(() => {
        if (editing && editing.ta === ta && document.activeElement !== ta) endEdit();
      }, 0);
    });

    el.querySelector('.body').replaceChildren(ta);
    el._text = null; // force the body to be redrawn when editing ends
    el.classList.add('editing');
    editing = { id, ta, original: n.t || '', isNew };
    fit();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function endEdit() {
    if (!editing) return;
    const { id, ta, original, isNew } = editing;
    editing = null;
    layer.get(id)?.classList.remove('editing');
    const n = state.notes.get(id);
    const text = ta.value.replace(/\s+$/, '').replace(/^\n+/, '');
    if (n) {
      if (n.k === 'text' && text.trim() === '') {
        if (isNew) {
          // A new note left empty: drop it rather than leaving a blank slip.
          store.discardNote(id);
          store.popCheckpoint();
        } else {
          store.checkpoint();
          store.removeNotes([id]);
          announceDeleted(1);
        }
        setSelection([]);
      } else if (text !== original) {
        if (!isNew) store.checkpoint(); // a new note already got a checkpoint when it was created: one undo step covers both
        store.updateNotes([id], { t: text });
      }
    }
    layer.sync(id);
  }

  // ------------------------------------------------------------ delete, copy, colour, pin

  function announceDeleted(count) {
    ui.toast(t('toast.trashed', { count }), { action: t('common.undo'), run: undo });
  }

  function deleteIds(ids) {
    const list = ids.filter((id) => state.notes.has(id));
    if (!list.length) return;
    endEdit();
    store.checkpoint();
    store.removeNotes(list);
    announceDeleted(list.length);
  }

  async function copyImage(n) {
    try {
      let blob = await (await fetch(imgUrl(n.img))).blob();
      if (blob.type !== 'image/png') blob = await toPngBlob(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      ui.toast(t('toast.imageCopied'));
    } catch (err) {
      ui.toast(err && err.name === 'NotAllowedError'
        ? t('toast.imageCopyDenied')
        : t('toast.imageCopyFailed', { message: err && err.message ? err.message : err }), { ms: 5000 });
    }
  }

  // The text of the notes in reading order (top to bottom, left to right), separated by a blank line.
  function collectText(ids) {
    const notes = readingOrder(ids.map((id) => state.notes.get(id)).filter(Boolean));
    return { notes, text: notes.map((n) => n.t || '').filter(Boolean).join('\n\n') };
  }
  const copiedMessage = (count) => t('toast.copied', { count });

  // Used by the buttons on a note.
  async function copyNotes(ids) {
    const { notes, text } = collectText(ids);
    if (!notes.length) return;
    if (notes.length === 1 && notes[0].k === 'image') return copyImage(notes[0]);
    if (!text) {
      ui.toast(t('toast.nothingToCopy'));
      return;
    }
    const ok = await writeClipboardText(text);
    ui.toast(ok ? copiedMessage(notes.length) : t('toast.copyDenied'));
  }

  function applyColor(ids, color) {
    endEdit();
    store.checkpoint();
    store.updateNotes(ids, { c: color });
  }

  function togglePin(ids) {
    const allPinned = ids.every((id) => state.notes.get(id)?.lock);
    store.checkpoint();
    store.updateNotes(ids, { lock: allPinned ? 0 : 1 });
    ui.toast(allPinned ? t('toast.unpinned') : t('toast.pinned'), { ms: 2200 });
  }

  function undo() {
    endEdit();
    if (store.undo()) {
      setSelection([]);
      ui.toast(t('toast.undone'), { ms: 1400 });
    }
  }
  function redo() {
    endEdit();
    if (store.redo()) {
      setSelection([]);
      ui.toast(t('toast.redone'), { ms: 1400 });
    }
  }

  // ------------------------------------------------------------ gestures

  function capturePointer(id) {
    try { board.setPointerCapture(id); } catch { /* the pointer has already ended */ }
  }
  function releasePointer(id) {
    try { board.releasePointerCapture(id); } catch { /* nothing to release */ }
  }
  function cancelGesture() {
    const g = gesture;
    gesture = null;
    g?.onUp?.(null, true);
  }

  // Drag the background (or hold Space, or use the middle mouse button) to move the board.
  function beginPan(e) {
    let last = { x: e.clientX, y: e.clientY };
    board.classList.add('panning');
    capturePointer(e.pointerId);
    gesture = {
      type: 'pan',
      pointerId: e.pointerId,
      onMove(ev) {
        view.panBy(ev.clientX - last.x, ev.clientY - last.y);
        last = { x: ev.clientX, y: ev.clientY };
      },
      onUp() {
        board.classList.remove('panning');
        releasePointer(e.pointerId);
      },
    };
  }

  // Press on the background: dragging moves the board, a plain click clears the selection, a double click makes a new note.
  function beginBackgroundPress(e) {
    const start = { x: e.clientX, y: e.clientY };
    let last = { ...start };
    let panning = false;
    gesture = {
      type: 'bg',
      pointerId: e.pointerId,
      onMove(ev) {
        if (!panning) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
          panning = true;
          board.classList.add('panning');
          capturePointer(e.pointerId);
        }
        view.panBy(ev.clientX - last.x, ev.clientY - last.y);
        last = { x: ev.clientX, y: ev.clientY };
      },
      onUp(ev, cancelled) {
        board.classList.remove('panning');
        releasePointer(e.pointerId);
        if (panning || cancelled) return;
        endEdit();
        setSelection([]);
        if (isDoubleTap(ev, 'bg')) capture?.createAt(ev.clientX, ev.clientY);
      },
    };
  }

  // Area select (hold Shift and drag on the background).
  function beginMarquee(e) {
    const box = ui.marqueeEl;
    const start = { x: e.clientX, y: e.clientY };
    const rects = [];
    for (const [id, el] of layer.entries()) {
      const n = state.notes.get(id);
      if (n) rects.push({ id, x: n.x, y: n.y, w: n.w, h: el.offsetHeight });
    }
    const base = e.ctrlKey || e.metaKey ? new Set(selection) : new Set();
    endEdit();
    capturePointer(e.pointerId);
    box.hidden = false;
    gesture = {
      type: 'marquee',
      pointerId: e.pointerId,
      onMove(ev) {
        const x1 = Math.min(start.x, ev.clientX);
        const y1 = Math.min(start.y, ev.clientY);
        const x2 = Math.max(start.x, ev.clientX);
        const y2 = Math.max(start.y, ev.clientY);
        Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
        const a = view.toWorld(x1, y1);
        const b = view.toWorld(x2, y2);
        const hits = rects.filter((r) => r.x < b.x && r.x + r.w > a.x && r.y < b.y && r.y + r.h > a.y).map((r) => r.id);
        setSelection([...base, ...hits]);
      },
      onUp() {
        releasePointer(e.pointerId);
        box.hidden = true;
      },
    };
  }

  // Press on a note: select it, drag it, or double-click to edit.
  function beginNotePress(e, noteEl) {
    const id = noteEl.dataset.id;
    const note = state.notes.get(id);
    if (!note) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const targetEl = e.target;

    if (editing && editing.id !== id) endEdit();
    let collapseOnUp = false;
    if (additive) {
      if (selection.has(id)) {
        setSelection(selected().filter((x) => x !== id));
        return;
      }
      setSelection([...selection, id]);
    } else if (!selection.has(id)) {
      setSelection([id]);
    } else if (selection.size > 1) {
      collapseOnUp = true; // several are selected: a click without dragging narrows the selection to this one
    }

    const ids = selected();
    store.bringToFront(ids);

    const start = { x: e.clientX, y: e.clientY };
    const origins = new Map(ids.map((i) => {
      const m = state.notes.get(i);
      return [i, { x: m.x, y: m.y }];
    }));
    const movable = ids.filter((i) => !state.notes.get(i).lock);
    let dragging = false;
    let warned = false;

    gesture = {
      type: 'note',
      pointerId: e.pointerId,
      onMove(ev) {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!dragging) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          if (!movable.length) {
            if (!warned) {
              warned = true;
              ui.toast(t('toast.pinnedHint'));
            }
            return;
          }
          dragging = true;
          capturePointer(ev.pointerId);
          movable.forEach((i) => layer.get(i)?.classList.add('dragging'));
        }
        const k = view.v.z;
        for (const i of movable) {
          const o = origins.get(i);
          const el = layer.get(i);
          if (el) placeAt(el, o.x + dx / k, o.y + dy / k);
        }
        ui.setTrash({ armed: true, over: ui.overTrash(ev.clientX, ev.clientY) });
      },
      onUp(ev, cancelled) {
        releasePointer(e.pointerId);
        ui.setTrash({ armed: false, over: false });

        if (dragging) {
          suppressClickUntil = performance.now() + 120;
          movable.forEach((i) => layer.get(i)?.classList.remove('dragging'));
          if (cancelled) {
            movable.forEach((i) => layer.sync(i)); // put them back where they were
            return;
          }
          if (ui.overTrash(ev.clientX, ev.clientY)) {
            movable.forEach((i) => layer.sync(i));
            deleteIds(movable);
            return;
          }
          const k = view.v.z;
          const dx = (ev.clientX - start.x) / k;
          const dy = (ev.clientY - start.y) / k;
          store.checkpoint();
          store.moveNotes(new Map(movable.map((i) => [i, { x: origins.get(i).x + dx, y: origins.get(i).y + dy }])));
          return;
        }

        if (cancelled) return;
        if (collapseOnUp) setSelection([id]);
        if (!additive && isDoubleTap(ev, id)) {
          suppressClickUntil = performance.now() + 120; // keep the second click from opening a link
          const current = state.notes.get(id);
          if (current && current.k === 'image' && targetEl.closest('.media')) ui.openLightbox(current);
          else startEdit(id);
        }
      },
    };
  }

  // Drag the bottom-right corner to resize.
  function beginResize(e, noteEl) {
    const id = noteEl.dataset.id;
    const note = state.notes.get(id);
    if (!note) return;
    e.preventDefault();
    setSelection([id]);
    store.bringToFront([id]);
    const start = { x: e.clientX, y: e.clientY };
    const w0 = note.w;
    const h0 = noteEl.offsetHeight;
    let changed = false;
    capturePointer(e.pointerId);
    noteEl.classList.add('resizing');
    gesture = {
      type: 'resize',
      pointerId: e.pointerId,
      onMove(ev) {
        const k = view.v.z;
        noteEl.style.width = `${clamp(w0 + (ev.clientX - start.x) / k, MIN_W, MAX_W)}px`;
        if (note.k !== 'image') noteEl.style.minHeight = `${Math.max(0, h0 + (ev.clientY - start.y) / k)}px`;
        changed = true;
      },
      onUp(ev, cancelled) {
        releasePointer(e.pointerId);
        noteEl.classList.remove('resizing');
        if (cancelled || !changed) {
          layer.sync(id);
          return;
        }
        const w = Math.round(parseFloat(noteEl.style.width));
        const minH = note.k === 'image' ? 0 : Math.round(parseFloat(noteEl.style.minHeight) || 0);
        store.checkpoint();
        store.updateNotes([id], { w, h: minH > NOTE_H ? minH : 0 });
      },
    };
  }

  // Two-finger pinch on a touch screen: zoom and pan the board.
  function beginPinch() {
    cancelGesture();
    const pts = () => [...pointers.values()];
    const mid = (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
    let p = pts();
    let d0 = dist(p[0], p[1]) || 1;
    let m0 = mid(p);
    gesture = {
      type: 'pinch',
      onMove() {
        p = pts();
        if (p.length < 2) return;
        const d = dist(p[0], p[1]) || 1;
        const m = mid(p);
        view.zoomAt(m.x, m.y, d / d0);
        view.panBy(m.x - m0.x, m.y - m0.y);
        d0 = d;
        m0 = m;
      },
      onUp() {},
    };
  }

  // ------------------------------------------------------------ pointer events

  function onPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.pointerType === 'mouse') pointers.clear(); // in case a stale pointer was left behind
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      beginPinch();
      return;
    }
    if (pointers.size > 2) return;

    const target = e.target;
    if (!target.closest('.color-wrap')) closePalettes();
    ui.closePopovers();
    if (target.closest('textarea.editor')) return; // typing text
    if (target.closest('.tools') || target.closest('.lk-copy')) return; // buttons on a note handle themselves on click

    if (e.button === 1 || spaceDown) {
      e.preventDefault();
      beginPan(e);
      return;
    }
    const noteEl = target.closest('.note');
    if (noteEl) {
      if (target.closest('.grip')) beginResize(e, noteEl);
      else beginNotePress(e, noteEl);
      return;
    }
    if (e.shiftKey) beginMarquee(e);
    else beginBackgroundPress(e);
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.target instanceof Element && board.contains(e.target)) lastPointer = { x: e.clientX, y: e.clientY };
    if (gesture && (gesture.type === 'pinch' || gesture.pointerId === e.pointerId)) gesture.onMove?.(e);
  }

  function onPointerEnd(e) {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.type === 'pinch') {
      if (pointers.size < 2) {
        const g = gesture;
        gesture = null;
        g.onUp?.(e, false);
      }
      return;
    }
    if (gesture.pointerId === e.pointerId) {
      const g = gesture;
      gesture = null;
      g.onUp?.(e, e.type === 'pointercancel');
    }
  }

  board.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
  board.addEventListener('pointerleave', () => { lastPointer = null; });

  // After a drag the browser still fires a click: block it so a link is not opened by mistake.
  board.addEventListener('click', (e) => {
    if (performance.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  board.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('textarea')) e.preventDefault();
  });
  // Block the browser's native drag and drop (images, links): we have our own.
  document.addEventListener('dragstart', (e) => {
    if (!isTextField(e.target)) e.preventDefault();
  });

  // ------------------------------------------------------------ buttons on a note

  function closePalettes() {
    world.querySelectorAll('.color-wrap.open').forEach((el) => el.classList.remove('open'));
  }

  // Clicking a note must not leave focus on a link or button inside it: otherwise pressing Enter
  // afterwards would "click" that link again instead of editing the text. Cancel the default of mousedown (click still works).
  world.addEventListener('mousedown', (e) => {
    if (!e.target.closest('textarea')) e.preventDefault();
  });

  world.addEventListener('click', (e) => {
    const linkCopy = e.target.closest('.lk-copy');
    if (linkCopy) {
      e.preventDefault();
      e.stopPropagation();
      writeClipboardText(linkCopy.dataset.url).then((ok) => ui.toast(ok ? t('toast.linkCopied') : t('toast.copyDenied'), { ms: 1800 }));
      linkCopy.blur();
      return;
    }
    const noteEl = e.target.closest('.note');
    if (!noteEl) return;
    const id = noteEl.dataset.id;
    const targets = selection.has(id) ? selected() : [id];

    const swatch = e.target.closest('.swatch');
    if (swatch) {
      applyColor(targets, swatch.dataset.color);
      closePalettes();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    btn.blur();
    switch (btn.dataset.act) {
      case 'edit': startEdit(id); break;
      case 'copy': copyNotes(targets); break;
      case 'view': ui.openLightbox(state.notes.get(id)); break;
      case 'pin': togglePin(targets); break;
      case 'del': deleteIds(targets); break;
      case 'color': {
        const wrap = btn.closest('.color-wrap');
        const open = !wrap.classList.contains('open');
        closePalettes();
        wrap.classList.toggle('open', open);
        break;
      }
      default: break;
    }
  });

  // ------------------------------------------------------------ keyboard

  const interactiveTarget = (el) => !!el?.closest?.('button, a, input, textarea, select');

  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const inField = isTextField(e.target);
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === ' ' && !e.repeat && !interactiveTarget(e.target) && !ui.blocking()) {
      spaceDown = true;
      board.classList.add('hand');
    }

    if (e.key === 'Escape') {
      if (ui.escape()) return;
      if (editing) { endEdit(); return; }
      if (gesture) { cancelGesture(); return; }
      if (selection.size) setSelection([]);
      return;
    }

    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'f') { e.preventDefault(); ui.openSearch(); return; }
      if (key === '=' || key === '+') { e.preventDefault(); view.zoomStep(1); return; }
      if (key === '-') { e.preventDefault(); view.zoomStep(-1); return; }
      if (key === '0') { e.preventDefault(); view.zoomReset(); return; }
      if (inField || ui.blocking()) return;
      if (key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (key === 'y') { e.preventDefault(); redo(); return; }
      if (key === 'a') { e.preventDefault(); setSelection([...state.notes.keys()]); return; }
      return; // Ctrl+C / Ctrl+V are handled by the copy / paste events
    }

    if (inField || ui.blocking()) return;

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (selection.size) { e.preventDefault(); deleteIds(selected()); }
        break;
      case 'Enter':
        if (selection.size === 1 && !interactiveTarget(e.target)) { e.preventDefault(); startEdit(selected()[0]); }
        break;
      case '/':
        e.preventDefault();
        ui.openSearch();
        break;
      case '?':
        ui.toggleHelp();
        break;
      case 'n':
      case 'N':
        if (!e.shiftKey) { e.preventDefault(); capture?.createAtPointer(); }
        break;
      case 'Home':
        view.home();
        break;
      case 'ArrowLeft': view.panBy(e.shiftKey ? 240 : 80, 0); e.preventDefault(); break;
      case 'ArrowRight': view.panBy(e.shiftKey ? -240 : -80, 0); e.preventDefault(); break;
      case 'ArrowUp': view.panBy(0, e.shiftKey ? 240 : 80); e.preventDefault(); break;
      case 'ArrowDown': view.panBy(0, e.shiftKey ? -240 : -80); e.preventDefault(); break;
      default:
        if (e.code === 'Digit1' && e.shiftKey) { e.preventDefault(); ui.fitAll(); }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      board.classList.remove('hand');
    }
  });

  window.addEventListener('blur', () => {
    pointers.clear();
    spaceDown = false;
    board.classList.remove('hand');
  });

  // Ctrl+C with notes selected (and no text highlighted anywhere): copy the notes' content.
  document.addEventListener('copy', (e) => {
    if (isTextField(e.target) || isTextField(document.activeElement) || ui.blocking()) return;
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) return;
    if (!selection.size) return;
    const { notes, text } = collectText(selected());
    if (!notes.length) return;
    e.preventDefault();
    if (notes.length === 1 && notes[0].k === 'image') {
      copyImage(notes[0]);
    } else if (!text) {
      ui.toast(t('toast.nothingToCopy'));
    } else if (e.clipboardData) {
      // Write straight inside the copy event: it needs no clipboard permission, so it is the most reliable way.
      e.clipboardData.setData('text/plain', text);
      ui.toast(copiedMessage(notes.length), { ms: 1800 });
    } else {
      copyNotes(selected());
    }
  });

  return {
    selection,
    setSelection,
    startEdit,
    endEdit,
    isEditing: () => !!editing,
    undo,
    redo,
    deleteIds,
    copyNotes,
    lastPointer: () => lastPointer,
    setCapture(c) { capture = c; },
  };
}
