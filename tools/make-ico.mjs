// Combine several PNG files into one .ico file (Windows uses it for shortcuts and the application icon).
//
// Usage:  node tools/make-ico.mjs public/icons/app.ico tools/icon-src/icon-16.png tools/icon-src/icon-32.png ...
//
// The source of the icon is public/icons/icon.svg. The PNGs in tools/icon-src were rendered from that SVG
// (draw the SVG on a canvas at each size and export a PNG). If you change the SVG, re-render the PNGs and run the command again.

import fs from 'node:fs';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('Usage: node tools/make-ico.mjs <out.ico> <image1.png> [image2.png ...]');
  process.exit(1);
}

const frames = inputs.map((file) => {
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
});
frames.sort((a, b) => a.width - b.width);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(frames.length, 4);

let offset = 6 + 16 * frames.length;
const entries = frames.map((f) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(f.width >= 256 ? 0 : f.width, 0); // 0 means 256
  e.writeUInt8(f.height >= 256 ? 0 : f.height, 1);
  e.writeUInt8(0, 2); // number of colours
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(f.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += f.data.length;
  return e;
});

fs.writeFileSync(out, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]));
console.log(`Wrote ${out}: ${frames.map((f) => `${f.width}px`).join(', ')}`);
