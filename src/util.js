// Small file-system and formatting helpers.

import fs from 'node:fs';

/** Identify an image by its first bytes (never by its file name or declared type). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head = buf.toString('latin1', 0, 4);
  if (head === 'GIF8') return 'gif';
  if (head === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Local calendar day, e.g. 2026-11-27. */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Local timestamp that is safe in file names, e.g. 2026-11-27_09-41-05. */
export const stamp = (d = new Date()) => `${localDay(d)}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write a file safely: write to a temp file, fsync, then rename over the real file. */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 5) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
      sleepSync(40 * (i + 1)); // cloud-sync clients and antivirus sometimes hold a file briefly
    }
  }
}
