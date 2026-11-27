// The viewport of the infinite board: pan, scroll, zoom.
// This file only does coordinate maths and sets the transform; it knows nothing about notes.
//
// "world" coordinates are where notes sit on the board. "screen" coordinates are pixels on the display.
//   screen = world * z + (x, y)

import { clamp } from './util.js';

export const MIN_Z = 0.1;
export const MAX_Z = 4;

const easeOut = (t) => 1 - (1 - t) ** 3;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createView(board, world, { isBlocked = () => false } = {}) {
  const v = { x: 0, y: 0, z: 1 };
  const subs = new Set();
  let raf = 0;

  function apply() {
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    // The dot grid follows the board and gets sparser as you zoom out so it never gets dense.
    // Set on the style directly rather than through a CSS variable: variables are inherited by every note,
    // and changing one every frame would force the browser to recalculate the style of thousands of elements.
    let gs = 28 * v.z;
    while (gs < 14) gs *= 2;
    board.style.backgroundSize = `${gs}px ${gs}px`;
    board.style.backgroundPosition = `${v.x - gs / 2}px ${v.y - gs / 2}px`;
    subs.forEach((fn) => fn(v));
  }

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const size = () => ({ w: board.clientWidth, h: board.clientHeight });
  const toWorld = (sx, sy) => ({ x: (sx - v.x) / v.z, y: (sy - v.y) / v.z });
  const toScreen = (wx, wy) => ({ x: wx * v.z + v.x, y: wy * v.z + v.y });

  function set(x, y, z) {
    stop();
    v.x = x;
    v.y = y;
    v.z = clamp(z, MIN_Z, MAX_Z);
    apply();
  }

  function panBy(dx, dy) {
    stop();
    v.x += dx;
    v.y += dy;
    apply();
  }

  function zoomAt(sx, sy, factor) {
    stop();
    const z = clamp(v.z * factor, MIN_Z, MAX_Z);
    const k = z / v.z;
    v.x = sx - (sx - v.x) * k;
    v.y = sy - (sy - v.y) * k;
    v.z = z;
    apply();
  }

  function animateTo(target, ms = 280) {
    stop();
    const from = { ...v };
    const to = { x: target.x, y: target.y, z: clamp(target.z, MIN_Z, MAX_Z) };
    const same = Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5 && Math.abs(from.z - to.z) < 0.001;
    if (same) return;
    if (reducedMotion()) {
      set(to.x, to.y, to.z);
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const p = clamp((now - t0) / ms, 0, 1);
      const e = easeOut(p);
      v.z = from.z * (to.z / from.z) ** e; // interpolate zoom logarithmically so it feels natural
      v.x = from.x + (to.x - from.x) * e;
      v.y = from.y + (to.y - from.y) * e;
      apply();
      raf = p < 1 ? requestAnimationFrame(step) : 0;
    };
    raf = requestAnimationFrame(step);
  }

  // Zoom in/out around the centre of the screen (the +/- buttons and shortcuts).
  function zoomStep(dir, ms = 180) {
    const { w, h } = size();
    const z = clamp(v.z * (dir > 0 ? 1.25 : 0.8), MIN_Z, MAX_Z);
    const k = z / v.z;
    animateTo({ x: w / 2 - (w / 2 - v.x) * k, y: h / 2 - (h / 2 - v.y) * k, z }, ms);
  }

  function zoomReset() {
    const { w, h } = size();
    const k = 1 / v.z;
    animateTo({ x: w / 2 - (w / 2 - v.x) * k, y: h / 2 - (h / 2 - v.y) * k, z: 1 });
  }

  function centerOn(wx, wy, z = v.z) {
    const { w, h } = size();
    animateTo({ x: w / 2 - wx * z, y: h / 2 - wy * z, z });
  }

  // Zoom so a whole rectangle (world coordinates) is visible.
  function fitRect(r, { pad = 90, maxZ = 1 } = {}) {
    const { w, h } = size();
    const z = clamp(Math.min((w - pad * 2) / Math.max(r.w, 1), (h - pad * 2) / Math.max(r.h, 1)), MIN_Z, maxZ);
    animateTo({ x: w / 2 - (r.x + r.w / 2) * z, y: h / 2 - (r.y + r.h / 2) * z, z });
  }

  // If a rectangle (world coordinates) is outside the view, pan so it is centred. The zoom stays as it is.
  function ensureVisible(r, margin = 80) {
    const { w, h } = size();
    const a = toScreen(r.x, r.y);
    const b = toScreen(r.x + r.w, r.y + r.h);
    const inside = a.x >= margin && a.y >= margin && b.x <= w - margin && b.y <= h - margin;
    if (inside) return;
    centerOn(r.x + r.w / 2, r.y + r.h / 2);
  }

  const home = () => animateTo({ x: 0, y: 0, z: 1 });

  // ---- mouse wheel / touchpad: scroll = pan, Ctrl + scroll (or a two-finger pinch) = zoom
  board.addEventListener('wheel', (e) => {
    if (isBlocked()) return;
    e.preventDefault();
    let { deltaX, deltaY } = e;
    if (e.deltaMode === 1) { deltaX *= 16; deltaY *= 16; }
    else if (e.deltaMode === 2) { deltaX *= innerWidth; deltaY *= innerHeight; }

    if (e.ctrlKey || e.metaKey) {
      // A touchpad pinch produces small deltas; a mouse wheel produces large ones (~100).
      const speed = Math.abs(deltaY) < 40 ? 0.012 : 0.0018;
      zoomAt(e.clientX, e.clientY, Math.exp(-deltaY * speed));
    } else if (e.shiftKey && deltaX === 0) {
      panBy(-deltaY, 0);
    } else {
      panBy(-deltaX, -deltaY);
    }
  }, { passive: false });

  return {
    v,
    size,
    toWorld,
    toScreen,
    set,
    panBy,
    zoomAt,
    zoomStep,
    zoomReset,
    animateTo,
    centerOn,
    fitRect,
    ensureVisible,
    home,
    stop,
    apply,
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
