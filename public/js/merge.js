// Gộp hai phiên bản của bảng, ví dụ khi bạn mở hai cửa sổ cùng lúc hoặc khôi phục dữ liệu chưa lưu.
// Quy tắc: với mỗi mảnh giấy (theo id) lấy bản được sửa muộn hơn (mt).
// Mảnh giấy nằm trong thùng rác tính theo thời điểm xóa (cũng được ghi vào mt).
// Không có mảnh giấy nào bị mất: cái gì chỉ có ở một phía thì được giữ nguyên.

export function mergeBoards(local, remote) {
  const picked = new Map();

  const consider = (note, trashed) => {
    const t = note.mt || note.ts || 0;
    const cur = picked.get(note.id);
    if (!cur || t > cur.t || (t === cur.t && trashed && !cur.trashed)) {
      picked.set(note.id, { note, trashed, t });
    }
  };

  for (const side of [remote, local]) {
    for (const n of side?.notes || []) consider(n, false);
    for (const n of side?.trash || []) consider(n, true);
  }

  const notes = [];
  const trash = [];
  for (const { note, trashed } of picked.values()) (trashed ? trash : notes).push(note);
  return { notes, trash };
}
