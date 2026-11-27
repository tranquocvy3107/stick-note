// Image handling in the browser: read the size, make a thumbnail, convert to PNG, then upload to the server.
// The original is stored untouched (never re-compressed). Thumbnails only keep the board light when it holds many images.

import { api } from './api.js';
import { t } from './i18n.js';

const SERVER_FORMATS = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const THUMB_LONG_SIDE = 900;
const MAX_BYTES = 25 * 1024 * 1024;

export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}

function canvasToBlob(source, type, quality, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('image.encodeFailed')))), type, quality);
  });
}

export async function toPngBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    return await canvasToBlob(bitmap, 'image/png', undefined, bitmap.width, bitmap.height);
  } finally {
    bitmap.close?.();
  }
}

// Upload an image to the server. Returns { img, th, iw, ih } for building an image note.
export async function storeImage(file) {
  if (file.size > MAX_BYTES) throw new Error(t('image.tooBig'));
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(t('image.unreadable'));
  }
  try {
    const iw = bitmap.width;
    const ih = bitmap.height;
    const upload = SERVER_FORMATS.has(file.type) ? file : await canvasToBlob(bitmap, 'image/png', undefined, iw, ih);
    const { id } = await api.uploadImage(upload);

    let th = '';
    const longSide = Math.max(iw, ih);
    if (upload.type !== 'image/gif' && longSide > THUMB_LONG_SIDE + 60) {
      const k = THUMB_LONG_SIDE / longSide;
      const thumb = await canvasToBlob(bitmap, 'image/webp', 0.86, Math.round(iw * k), Math.round(ih * k));
      th = (await api.uploadThumb(id, thumb)).id;
    }
    return { img: id, th, iw, ih };
  } finally {
    bitmap.close?.();
  }
}
