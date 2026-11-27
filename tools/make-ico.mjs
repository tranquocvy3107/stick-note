// Ghép nhiều file PNG thành một file .ico (Windows dùng cho shortcut và biểu tượng ứng dụng).
//
// Dùng:  node tools/make-ico.mjs public/icons/app.ico tools/icon-src/icon-16.png tools/icon-src/icon-32.png ...
//
// Nguồn của biểu tượng là public/icons/icon.svg. Các PNG trong tools/icon-src được vẽ ra từ file SVG đó
// (vẽ SVG lên canvas ở từng kích thước rồi xuất PNG). Sửa SVG thì vẽ lại các PNG rồi chạy lại lệnh trên.

import fs from 'node:fs';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('Cách dùng: node tools/make-ico.mjs <ra.ico> <anh1.png> [anh2.png ...]');
  process.exit(1);
}

const frames = inputs.map((file) => {
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} không phải PNG`);
  return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
});
frames.sort((a, b) => a.width - b.width);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // dành riêng
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(frames.length, 4);

let offset = 6 + 16 * frames.length;
const entries = frames.map((f) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(f.width >= 256 ? 0 : f.width, 0); // 0 nghĩa là 256
  e.writeUInt8(f.height >= 256 ? 0 : f.height, 1);
  e.writeUInt8(0, 2); // số màu
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bit mỗi điểm ảnh
  e.writeUInt32LE(f.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += f.data.length;
  return e;
});

fs.writeFileSync(out, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]));
console.log(`Đã ghi ${out}: ${frames.map((f) => `${f.width}px`).join(', ')}`);
