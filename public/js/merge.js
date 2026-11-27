// Merge two versions of the board, e.g. when two windows are open at once or unsaved work is recovered.
// Rule: for each note (by id) keep the copy that was edited later (mt).
// A note in the trash is dated by when it was deleted (also stored in mt).
// No note is ever lost: anything present on only one side is kept.

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
