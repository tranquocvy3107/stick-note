// Khung nhìn của bảng vô hạn: kéo, cuộn, zoom.
// File này chỉ làm toán tọa độ và gán transform, không biết gì về mảnh giấy.
//
// Tọa độ "world" là tọa độ của mảnh giấy trên bảng. Tọa độ "screen" là pixel trên màn hình.
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
    // Lưới chấm bám theo bảng; thưa dần khi thu nhỏ để không bị dày đặc.
    // Gán thẳng vào style chứ không dùng biến CSS: biến CSS được kế thừa xuống mọi mảnh giấy,
    // đổi nó mỗi khung hình sẽ buộc trình duyệt tính lại style của cả nghìn phần tử.
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
      v.z = from.z * (to.z / from.z) ** e; // zoom nội suy theo log cho tự nhiên
      v.x = from.x + (to.x - from.x) * e;
      v.y = from.y + (to.y - from.y) * e;
      apply();
      raf = p < 1 ? requestAnimationFrame(step) : 0;
    };
    raf = requestAnimationFrame(step);
  }

  // Phóng to/thu nhỏ quanh tâm màn hình (nút +/-, phím tắt).
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

  // Thu phóng để thấy trọn một hình chữ nhật (tọa độ world).
  function fitRect(r, { pad = 90, maxZ = 1 } = {}) {
    const { w, h } = size();
    const z = clamp(Math.min((w - pad * 2) / Math.max(r.w, 1), (h - pad * 2) / Math.max(r.h, 1)), MIN_Z, maxZ);
    animateTo({ x: w / 2 - (r.x + r.w / 2) * z, y: h / 2 - (r.y + r.h / 2) * z, z });
  }

  // Nếu hình chữ nhật (world) đang nằm ngoài tầm nhìn thì dời bảng để nó vào giữa. Giữ nguyên zoom.
  function ensureVisible(r, margin = 80) {
    const { w, h } = size();
    const a = toScreen(r.x, r.y);
    const b = toScreen(r.x + r.w, r.y + r.h);
    const inside = a.x >= margin && a.y >= margin && b.x <= w - margin && b.y <= h - margin;
    if (inside) return;
    centerOn(r.x + r.w / 2, r.y + r.h / 2);
  }

  const home = () => animateTo({ x: 0, y: 0, z: 1 });

  // ---- cuộn chuột / touchpad: cuộn = di chuyển, Ctrl + cuộn (hoặc chụm 2 ngón) = zoom
  board.addEventListener('wheel', (e) => {
    if (isBlocked()) return;
    e.preventDefault();
    let { deltaX, deltaY } = e;
    if (e.deltaMode === 1) { deltaX *= 16; deltaY *= 16; }
    else if (e.deltaMode === 2) { deltaX *= innerWidth; deltaY *= innerHeight; }

    if (e.ctrlKey || e.metaKey) {
      // Chụm 2 ngón trên touchpad cho delta nhỏ; con lăn chuột cho delta lớn (~100).
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
