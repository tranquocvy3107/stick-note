// Every way of getting something onto the board:
//   - drag a slip from the tray (or click the tray)
//   - double-click the background, or press N
//   - paste (Ctrl+V): text, a link, an image or screenshot
//   - drag and drop from outside: links, text, images, .url/.txt files

import * as store from './store.js';
import { h, rand, round, isTextField } from './util.js';
import { NOTE_W, NOTE_H, ZONE_SCREEN_W, ZONE_SCREEN_H } from './constants.js';
import { storeImage, isImageFile } from './image.js';
import { t } from './i18n.js';

export function createCapture({ board, view, layer, inter, ui, dockEl }) {
  const { state } = store;
  const tilt = () => round(rand(-1.8, 1.8), 2);

  // If a note already sits almost exactly where the new one would go, shift it diagonally a little.
  function freeSpot(x, y) {
    const notes = [...state.notes.values()];
    for (let i = 0; i < 60; i++) {
      if (!notes.some((n) => Math.abs(n.x - x) < 14 && Math.abs(n.y - y) < 14)) break;
      x += 26;
      y += 26;
    }
    return { x, y };
  }

  // The board point under the pointer, or the middle of the screen if unknown.
  function pointerWorld() {
    const p = inter.lastPointer();
    const sz = view.size();
    return view.toWorld(p ? p.x : sz.w / 2, p ? p.y : sz.h / 2);
  }

  // ------------------------------------------------------------ blank notes to type into

  // Create a blank note centred on (cx, cy) (world coordinates) and start editing it right away.
  function createBlank({ cx, cy, color = 'yellow', r = tilt(), exact = false }) {
    let x = cx - NOTE_W / 2;
    let y = cy - NOTE_H / 2;
    if (!exact) ({ x, y } = freeSpot(x, y));
    inter.endEdit();
    store.checkpoint();
    const n = store.addNote({ x, y, c: color, r });
    const el = layer.get(n.id);
    if (el) {
      el.classList.add('just-dropped');
      el.addEventListener('animationend', () => el.classList.remove('just-dropped'), { once: true });
    }
    inter.setSelection([n.id]);
    inter.startEdit(n.id, { isNew: true });
    return n;
  }

  function createAt(clientX, clientY) {
    const p = view.toWorld(clientX, clientY);
    return createBlank({ cx: p.x, cy: p.y, exact: true });
  }

  function createAtPointer() {
    const p = pointerWorld();
    return createBlank({ cx: p.x, cy: p.y, exact: !!inter.lastPointer() });
  }

  function createAtCenter(color) {
    const sz = view.size();
    const p = view.toWorld(sz.w / 2, sz.h / 2);
    return createBlank({ cx: p.x, cy: p.y, color });
  }

  // ------------------------------------------------------------ existing text and links

  // texts: an array of strings, one note each. at: a world point (drag and drop) or none (paste).
  function createTexts(texts, at) {
    const list = texts.map((s) => s.replace(/\r\n?/g, '\n').trim()).filter(Boolean);
    if (!list.length) return [];
    const origin = at || pointerWorld();
    inter.endEdit();
    store.checkpoint();
    const ids = list.map((text, i) => {
      const wide = text.length > 360 || text.split('\n').length > 8;
      const w = wide ? 320 : NOTE_W;
      let x = origin.x - w / 2 + i * 30;
      let y = origin.y - 24 + i * 30;
      if (!at && i === 0) ({ x, y } = freeSpot(x, y));
      return store.addNote({ x, y, w, t: text, r: tilt() }).id;
    });
    inter.setSelection(ids);
    return ids;
  }

  // ------------------------------------------------------------ images

  async function addImages(files, at) {
    const images = files.filter(isImageFile);
    if (!images.length) return 0;
    ui.toast(t('toast.imagesLoading', { count: images.length }), { ms: 20_000 });
    const origin = at || pointerWorld();
    const made = [];
    let failed = '';
    let checkpointed = false;
    for (const file of images) {
      try {
        const info = await storeImage(file);
        const w = info.iw >= 320 ? 320 : Math.max(150, info.iw);
        if (!checkpointed) {
          inter.endEdit();
          store.checkpoint();
          checkpointed = true;
        }
        const i = made.length;
        const n = store.addNote({
          k: 'image', ...info, w,
          x: origin.x - w / 2 + i * 30,
          y: origin.y - 24 + i * 30,
          r: tilt(), c: 'white',
        });
        made.push(n.id);
      } catch (err) {
        failed = err.message || String(err);
      }
    }
    if (made.length) inter.setSelection(made);
    if (failed) ui.toast(t('toast.imageAddFailed', { message: failed }), { ms: 6000 });
    else ui.toast(t('toast.imagesAdded', { count: made.length }), { ms: 1800 });
    return made.length;
  }

  // Files dropped from outside: images, .url shortcuts, small text files.
  async function addFiles(files, at) {
    const images = [];
    const texts = [];
    let skipped = 0;
    for (const f of files) {
      if (isImageFile(f)) {
        images.push(f);
      } else if (/\.url$/i.test(f.name)) {
        const body = await f.text();
        const m = body.match(/^URL=(.+)$/im);
        if (m) texts.push(`${f.name.replace(/\.url$/i, '')}\n${m[1].trim()}`);
        else skipped++;
      } else if ((f.type.startsWith('text/') || /\.(txt|md)$/i.test(f.name)) && f.size <= 100_000) {
        texts.push(await f.text());
      } else {
        skipped++;
      }
    }
    if (texts.length) createTexts(texts, at);
    if (images.length) await addImages(images, texts.length ? { x: at.x, y: at.y + 150 } : at);
    if (skipped) ui.toast(t('toast.filesSkipped', { count: skipped }), { ms: 5000 });
  }

  // ------------------------------------------------------------ paste (Ctrl+V)

  document.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd || ui.blocking()) return;
    const files = [...cd.files].filter(isImageFile);
    const text = cd.getData('text/plain');
    // Typing in a text box: paste text as usual.
    if (isTextField(e.target) && (!files.length || text)) return;
    if (!files.length && !text.trim()) return;
    e.preventDefault();
    if (text.trim()) createTexts([text]);
    else addImages(files);
  });

  // ------------------------------------------------------------ drag and drop from outside

  board.addEventListener('dragover', (e) => {
    if (e.target.closest?.('textarea')) return;
    const types = e.dataTransfer?.types || [];
    if (types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      board.classList.add('dropping');
    }
  });
  board.addEventListener('dragleave', (e) => {
    if (!board.contains(e.relatedTarget)) board.classList.remove('dropping');
  });
  board.addEventListener('drop', (e) => {
    board.classList.remove('dropping');
    if (e.target.closest?.('textarea')) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    const at = view.toWorld(e.clientX, e.clientY);
    if (dt.files && dt.files.length) {
      addFiles([...dt.files], at);
      return;
    }
    const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    const text = uri || dt.getData('text/plain');
    if (text && text.trim()) createTexts([text], at);
  });
  window.addEventListener('dragend', () => board.classList.remove('dropping'));

  // ------------------------------------------------------------ the note tray

  // The tray holds the paper slips and, after a divider, a dashed tile for zones. Both are dragged onto the board the
  // same way; a slip makes a note, the tile draws a zone about as big as it looks on screen.
  function beginDockDrag(e, pad) {
    if (e.button !== 0) return;
    e.preventDefault();
    inter.endEdit();
    ui.closePopovers();

    const isZone = 'zone' in pad.dataset;
    const color = pad.dataset.color;
    const r = isZone ? 0 : tilt();
    const scale = isZone ? 1 : view.v.z;
    const gw = isZone ? ZONE_SCREEN_W : NOTE_W; // size of the ghost, in screen px at scale 1
    const gh = isZone ? ZONE_SCREEN_H : NOTE_H;
    const ghost = isZone ? h('div', { class: 'zone-ghost' }) : h('div', { class: 'note ghost', dataset: { color } });
    ghost.style.width = `${gw}px`;
    ghost.style[isZone ? 'height' : 'minHeight'] = `${gh}px`;
    ghost.hidden = true;
    document.body.append(ghost);

    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    try { pad.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    const place = (x, y) => {
      ghost.style.transform = `translate(${x - gw / 2}px, ${y - gh / 2}px) scale(${scale}) rotate(${r}deg)`;
    };
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
        moved = true;
        ghost.hidden = false;
      }
      if (moved) place(ev.clientX, ev.clientY);
    };
    const cleanup = () => {
      pad.removeEventListener('pointermove', onMove);
      pad.removeEventListener('pointerup', onUp);
      pad.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('keydown', onKey, true);
      try { pad.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      ghost.remove();
    };
    const onUp = (ev) => {
      cleanup();
      if (!moved) {
        // clicked without dragging: place it in the middle of the screen
        if (isZone) inter.zones.createAtCenter();
        else createAtCenter(color);
        return;
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!under || !board.contains(under)) return; // dropped on a toolbar or outside the board: cancel
      const p = view.toWorld(ev.clientX, ev.clientY);
      if (isZone) inter.zones.createAt(p.x, p.y);
      else createBlank({ cx: p.x, cy: p.y, color, r, exact: true });
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        cleanup();
      }
    };
    pad.addEventListener('pointermove', onMove);
    pad.addEventListener('pointerup', onUp);
    pad.addEventListener('pointercancel', cleanup);
    window.addEventListener('keydown', onKey, true);
  }

  for (const pad of dockEl.querySelectorAll('.pad')) {
    pad.addEventListener('pointerdown', (e) => beginDockDrag(e, pad));
    // Enter/Space on the button (keyboard): place the note (or zone) in the middle of the screen.
    pad.addEventListener('click', (e) => {
      if (e.detail !== 0) return;
      if ('zone' in pad.dataset) inter.zones.createAtCenter();
      else createAtCenter(pad.dataset.color);
    });
  }

  return { createAt, createAtPointer, createAtCenter, createTexts, addImages };
}
