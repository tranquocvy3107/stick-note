# Stick Note — whiteboard giấy nhớ của riêng tôi

App ghi chú cá nhân, chạy trên máy tính Windows của chủ dự án. Chỉ có **một tấm whiteboard** duy nhất. Muốn ghi gì thì kéo một mảnh giấy từ khay vào bảng, viết (chữ, link, ảnh) rồi để nguyên đó. Không thư mục, không thẻ, không danh sách: **vị trí trên bảng chính là cách tổ chức**. Bảng đầy dần, lộn xộn cũng được, vì chủ dự án nhớ từng thứ nằm ở đâu rồi quay lại đọc, bấm link, copy.

## Quy tắc làm việc với chủ dự án (đọc đầu tiên)

> Nếu có bất cứ thắc mắc nào, hãy hỏi tôi. Nếu thiếu thông tin gì, hãy yêu cầu tôi cung cấp.

- Gặp điều chưa rõ thì **hỏi trước, đừng tự đoán rồi làm tiếp**. Dùng công cụ AskUserQuestion, gom các câu hỏi lại thành một lần hỏi và đặt phương án bạn khuyến nghị lên đầu.
- Thiếu thông tin (đường dẫn, tài khoản, quyết định, ví dụ cụ thể...) thì **nói rõ đang cần gì và yêu cầu tôi cung cấp**. Không tự bịa giá trị tạm.
- Trả lời tôi bằng **tiếng Việt**. Code, tên biến, tên file và commit message dùng tiếng Anh.
- Làm xong thì nói rõ đã làm gì, đã kiểm tra bằng cách nào và còn gì chưa kiểm tra được.

## Nguyên tắc sản phẩm (không được phá)

1. **Vị trí là thiêng liêng.** App không bao giờ tự sắp xếp, căn chỉnh, dời, gom nhóm hay sắp lại mảnh giấy. Mảnh giấy chỉ di chuyển khi tôi kéo nó. (Chỗ duy nhất đặt "tránh chồng khít" là `freeSpot` khi tạo giấy mới tại giữa màn hình.)
2. **Giao diện chỉ có tấm bảng.** Không thêm trang, thư mục, thẻ, danh sách hay màn hình quản lý. Mọi nút điều khiển phải nhỏ, nằm ở rìa và không che bảng.
3. **Ghi nhanh.** Từ lúc có ý định đến lúc có chữ trên bảng phải ngắn nhất có thể: kéo giấy từ khay, nhấp đúp lên bảng, phím `N`, hoặc `Ctrl+V` (chữ, link, ảnh).
4. **Đọc và dùng lại nhanh.** Link bấm mở được và copy được ngay. Ảnh xem được và copy được.
5. **Không mất dữ liệu.** Lưu tự động, ghi file an toàn, có backup hằng ngày, xóa là vào thùng rác và hoàn tác được. Mọi thay đổi có thể làm mất dữ liệu phải hỏi tôi trước.
6. **Bảng nhớ chỗ tôi đang xem.** Mở lại thấy đúng vùng và mức zoom lần trước.

## Quyết định đã chốt với chủ dự án

- Hình thức: **app chạy trên máy tính** (Windows), mở thành cửa sổ app riêng, chạy offline. Không deploy online, không phụ thuộc Claude.
- Bảng: **rộng vô hạn** (kéo nền để di chuyển, Ctrl+cuộn để zoom), nhớ vùng đang xem.
- Nội dung mảnh giấy: **chữ, link và ảnh/screenshot** (dán bằng Ctrl+V hoặc kéo thả).
- Công nghệ: Node.js (máy đã cài) cùng frontend JavaScript thuần. **Không dùng thư viện ngoài** để app chạy ngay, không cần `npm install`. Muốn thêm thư viện thì phải hỏi tôi trước.
- Dữ liệu: file JSON và thư mục ảnh nằm trên máy, trong thư mục `data/` (đã `.gitignore`, không bao giờ commit).

## Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `start.bat` hoặc `npm start` | Bật server nền (nếu chưa chạy) rồi mở cửa sổ app Edge/Chrome `--app`. Từ terminal phải gõ `.\start.bat`: máy này đặt `NoDefaultCurrentDirectoryInExePath=1` nên gõ trần `start.bat` không chạy |
| `start-debug.bat` hoặc `npm run serve` | Chạy server ở chế độ thường, in log ra màn hình, tại http://127.0.0.1:4747/ |
| `npm test` | Chạy toàn bộ kiểm thử (`node --test`, không cần cài gì) |
| `node tools/make-ico.mjs ...` | Ghép PNG thành `public/icons/app.ico` (xem đầu file) |
| `tools/create-shortcut.ps1` | Tạo shortcut Desktop có icon riêng |

Biến môi trường: `PORT` (mặc định 4747), `STICK_NOTE_DATA` (thư mục dữ liệu, mặc định `./data`), `STICK_NOTE_IDLE_MS` (bao lâu không có cửa sổ nào thì server nền tự tắt, mặc định 300000), `STICK_NOTE_BROWSER` (đường dẫn trình duyệt để mở cửa sổ app), `STICK_NOTE_NO_OPEN=1` (không mở cửa sổ, chỉ in dòng `OPEN <url>`, dùng khi kiểm thử).

**Khi kiểm thử, luôn trỏ `STICK_NOTE_DATA` sang thư mục tạm và dùng cổng khác (ví dụ 4748)** để không đụng dữ liệu thật hay bản đang chạy của tôi.

## Kiến trúc

Không có bước build. Trình duyệt nạp thẳng ES module trong `public/js`.

```
server.js              Máy chủ Node không phụ thuộc gì: file tĩnh, API, lưu dữ liệu, backup, launcher
public/index.html      Toàn bộ khung HTML (không có script nội tuyến vì CSP chặn)
public/css/app.css     Mọi kiểu dáng, có sẵn giao diện sáng và tối
public/js/
  main.js              Ráp các phần lại, nạp dữ liệu, nhịp tim, lưu khi đóng cửa sổ
  store.js             Dữ liệu (mảnh giấy, thùng rác), hoàn tác, tự lưu, xử lý xung đột. Mọi thay đổi dữ liệu đi qua đây
  merge.js             Gộp hai phiên bản bảng theo từng mảnh giấy (thuần, có test)
  api.js               Gọi server (mọi request ghi kèm header X-Stick-Note)
  view.js              Khung nhìn vô hạn: tọa độ, kéo, cuộn, zoom, animation
  noteview.js          Vẽ mảnh giấy ra DOM (link tự nhận, ảnh), thanh công cụ dựng theo nhu cầu
  interactions.js      Mọi thao tác chuột/cảm ứng/phím: chọn, kéo, đổi cỡ, sửa chữ, copy, xóa, hoàn tác
  capture.js           Mọi đường đưa thứ gì đó lên bảng: khay giấy, nhấp đúp, dán, kéo thả từ ngoài
  image.js             Đọc ảnh, tạo ảnh thu nhỏ, tải lên server
  ui.js                Thanh zoom, tìm kiếm, menu, thùng rác, xem ảnh lớn, hướng dẫn, thông báo
  util.js              Hàm thuần: nhận link, rút gọn link, bỏ dấu để tìm, thứ tự đọc...
  icons.js, constants.js
test/                  logic.test.js (hàm thuần) và server.test.js (API, bảo mật, backup, khôi phục)
tools/                 make-ico.mjs, create-shortcut.ps1, release-notes.mjs, icon-src/ (PNG vẽ từ public/icons/icon.svg)
.github/workflows/     ci.yml (kiểm thử), release.yml (đóng gói và phát hành khi đẩy tag vX.Y.Z)
docs/                  Ảnh chụp màn hình cho README (không vào gói phát hành)
CHANGELOG.md, LICENSE  Nhật ký thay đổi (nguồn của ghi chú phát hành) và giấy phép MIT
data/                  Dữ liệu thật của tôi, tạo khi chạy: board.json, images/, backups/, server.log
```

### Mô hình dữ liệu

`data/board.json`: `{ app, schema: 1, rev, savedAt, notes: [...], trash: [...] }`.

Mảnh giấy: `{ id, k: 'text'|'image', x, y, w, h?, c (màu), r (độ nghiêng), z, lock?, t (chữ hoặc chú thích), ts, mt }`. Ảnh thêm `img`, `th` (ảnh thu nhỏ), `iw`, `ih`. Trong thùng rác có thêm `del`. `mt` (thời điểm sửa cuối) là thứ quyết định khi gộp, nên **mọi thay đổi phải cập nhật `mt`** (đi qua các hàm của `store.js` là tự có). Vùng đang xem (x, y, zoom) lưu trong `localStorage`, không nằm trong `board.json`, để hai cửa sổ không giành nhau.

### Lưu và đồng bộ

- Client lưu sau 350 ms kể từ thay đổi cuối. `PUT /api/board` kèm `baseRev`; server từ chối `409` nếu `rev` đã khác, kèm bảng hiện tại. Client gộp bằng `mergeBoards` rồi lưu lại. Nhờ vậy mở hai cửa sổ không bao giờ ghi đè nhau.
- Lỗi lưu: thử lại với độ trễ tăng dần (tối đa 15 giây), ghi bản dự phòng vào `localStorage['stick-note:pending']`, hiện dải đỏ sau 4 giây. Lần mở sau, bản dự phòng được gộp lại.
- Server ghi file an toàn (ghi tạm, fsync, đổi tên). Backup: một bản mỗi ngày (60 ngày), thêm một bản `before-shrink` khi số mảnh giấy giảm dưới 60%, và bản `manual`. `board.json` hỏng thì tự khôi phục từ backup mới nhất.
- Ảnh lưu theo hash nội dung (`<sha1>.png`), không bao giờ ghi đè hay tự xóa. Ảnh của mảnh giấy đã xóa hẳn vẫn nằm trong `images/` (chưa có công cụ dọn).
- Server chỉ nghe `127.0.0.1`, kiểm tra Host, Origin và header `X-Stick-Note`, có CSP chặn script nội tuyến. Server nền tự tắt khi không còn nhịp tim (`/api/ping` mỗi 20 giây) từ cửa sổ nào.

### API

`GET /api/ping`, `GET /api/rev`, `GET|PUT /api/board`, `POST /api/images`, `POST /api/thumb?of=<id>`, `GET /img/<id>`, `GET /api/info`, `POST /api/backup`, `POST /api/open-data-folder`.

## Phát hành phiên bản mới

Repo: https://github.com/tranquocvy3107/stick-note (công khai, giấy phép MIT), nhánh chính `main`. CI (`.github/workflows/ci.yml`) chạy `npm test` trên Windows và Ubuntu mỗi lần đẩy lên `main`. Phát hành tự động bằng GitHub Actions:

1. Sửa `version` trong `package.json` (server tự đọc từ đây) và thêm mục `## [x.y.z] - YYYY-MM-DD` vào đầu `CHANGELOG.md` (thêm cả dòng liên kết ở cuối file).
2. Chạy `npm test`, commit, đẩy lên `main`, đợi CI xanh.
3. Tạo tag và đẩy: `git tag vx.y.z` rồi `git push origin vx.y.z`. Workflow `release.yml` kiểm tra tag khớp `package.json`, chạy test, đóng gói `stick-note-x.y.z.zip` bằng `git archive` (thứ nào ghi `export-ignore` trong `.gitattributes` thì không vào gói), kèm file SHA-256, rồi tạo GitHub Release với ghi chú lấy từ `CHANGELOG.md` (`tools/release-notes.mjs`).
4. Kiểm tra bằng `gh release view vx.y.z`, tải gói về một thư mục tạm, giải nén và chạy thử.

Mỗi lần phát hành hay đẩy lên GitHub phải hỏi tôi trước, vì repo công khai. Không bao giờ đưa `data/` hay dữ liệu cá nhân vào repo. Commit dùng địa chỉ email noreply của GitHub (đặt bằng `git config user.email` trong repo), không dùng email thật.

## Bẫy đã gặp (đừng lặp lại)

- **Không dùng biến CSS đổi mỗi khung hình trên phần tử cha của mảnh giấy.** Biến CSS được kế thừa, đổi nó buộc trình duyệt tính lại style cả nghìn phần tử (từng mất 160 ms mỗi lần kéo bảng với 1.500 mảnh giấy). Lưới nền được gán thẳng `background-size/position` trong `view.js`.
- **Thanh công cụ của mảnh giấy dựng theo nhu cầu** (`ensureTools`, tối đa 12 thanh cùng lúc). Dựng sẵn cho mọi mảnh giấy là hơn 50.000 phần tử ẩn và làm bố cục chậm hẳn.
- **Không để focus nằm lại trên link hay nút trong mảnh giấy** (`mousedown` được `preventDefault`, click vẫn chạy). Nếu không, `Enter` sau đó sẽ "bấm" lại link thay vì sửa chữ.
- Kéo bắt đầu từ link vẫn phải kéo được mảnh giấy mà không mở link (`suppressClickUntil`, ngưỡng kéo 4 px).
- Giấy mới mà để trống thì tự bỏ và rút lại bước hoàn tác (`popCheckpoint`), để lịch sử hoàn tác không rác.
- Khi đang gõ bằng bộ gõ (Telex, VNI), bỏ qua `Esc`/`Enter` (`e.isComposing`).
- `translate` và `rotate` của mảnh giấy dùng thuộc tính CSS riêng (không gộp vào `transform`) để hiệu ứng "thẳng lên khi sửa" và "nâng lên khi kéo" độc lập nhau.

## Kiểm thử trong môi trường của Claude

- Khung trình duyệt tích hợp thường ở trạng thái ẩn: `requestAnimationFrame` không chạy, animation và ảnh chụp bị trễ (chờ ≥ 1 giây rồi mới chụp), clipboard bị từ chối, trang không có focus. Đừng kết luận "lỗi" chỉ từ ảnh chụp ngay sau thao tác, hãy đọc giá trị thật bằng JavaScript.
- Chụp giao diện bằng Edge thật: `msedge --headless=new --screenshot=... --window-size=1440,900 <url>`.
- `window.stickNote` (trong Console) lộ ra `store`, `view`, `layer`, `inter`, `ui`, `capture` để kiểm thử và gỡ lỗi.
- Kéo thả bằng công cụ trình duyệt không truyền được phím Shift; kiểm thử chọn vùng bằng PointerEvent giả lập có `shiftKey: true`.

## Chưa làm, có thể làm tiếp (hỏi tôi trước khi làm)

- Dọn ảnh mồ côi trong `data/images/` (ảnh của mảnh giấy đã xóa hẳn).
- Xuất/nhập một file duy nhất (hiện sao lưu bằng cách chép thư mục `data/`).
- Danh sách việc cần làm (ô tick) trong mảnh giấy chữ.
- Dùng trên điện thoại (cần cách truy cập từ xa và đăng nhập, đã bàn là ngoài phạm vi hiện tại).
- `will-change: transform` tạm thời khi kéo/zoom nếu bảng lên tới hàng nghìn mảnh giấy mà vẫn giật (chưa đo được trên máy thật).
