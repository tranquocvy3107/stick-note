// In ghi chú phát hành của một phiên bản: mục tương ứng trong CHANGELOG.md và hướng dẫn cài đặt.
// Dùng:  node tools/release-notes.mjs 1.0.0 > notes.md   (workflow release.yml gọi lệnh này)

import fs from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Cách dùng: node tools/release-notes.mjs <phiên bản>, ví dụ 1.0.0');
  process.exit(1);
}

const lines = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md chưa có mục "## [${version}]". Hãy thêm mục này trước khi phát hành.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (l.startsWith('## [') || /^\[[^\]]+\]:\s/.test(l)));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();

console.log(`${body}

## Cách cài và mở

1. Cần Windows 10/11, **Node.js 20.11 trở lên** và trình duyệt Edge hoặc Chrome. Không cần \`npm install\`.
2. Tải file **stick-note-${version}.zip** ở mục Assets bên dưới, giải nén ra một thư mục cố định.
3. Bấm đúp **start.bat**. Muốn có biểu tượng ngoài màn hình nền, chạy \`powershell -ExecutionPolicy Bypass -File tools\\create-shortcut.ps1\`.

Dữ liệu của bạn nằm trong thư mục \`data/\` cạnh app. Khi nâng cấp, giải nén bản mới ra thư mục mới rồi chép thư mục \`data/\` của bản cũ sang.

Kiểm tra file tải về: mã SHA-256 nằm trong **stick-note-${version}.zip.sha256**.`);
