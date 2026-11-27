// Hằng số dùng chung cho cả store, giao diện và tương tác.

export const COLORS = [
  { key: 'yellow', name: 'Vàng' },
  { key: 'pink', name: 'Hồng' },
  { key: 'blue', name: 'Xanh dương' },
  { key: 'green', name: 'Xanh lá' },
  { key: 'orange', name: 'Cam' },
  { key: 'purple', name: 'Tím' },
  { key: 'white', name: 'Trắng' },
];
export const COLOR_KEYS = COLORS.map((c) => c.key);

export const NOTE_W = 220; // chiều rộng mặc định của mảnh giấy chữ
export const NOTE_H = 112; // chiều cao tối thiểu mặc định
export const MIN_W = 120;
export const MAX_W = 1200;
export const THUMB_MAX_W = 460; // note ảnh rộng hơn mức này thì dùng ảnh gốc thay vì ảnh thu nhỏ
export const TRASH_KEEP_DAYS = 60;
