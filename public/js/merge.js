// Merge two versions of the board, e.g. when two windows are open at once or unsaved work is recovered.
// Rule: for each note (and each zone) keep the copy that was edited later (mt).
// A trashed item is dated by when it was deleted (also stored in mt).
// Nothing is ever lost: anything present on only one side is kept.

// Merge one kind of item (notes or zones) that lives in a list plus its trash list.
function mergeKind(local, remote, listKey, trashKey) {
  const picked = new Map();

  const consider = (item, trashed) => {
    const t = item.mt || item.ts || 0;
    const cur = picked.get(item.id);
    if (!cur || t > cur.t || (t === cur.t && trashed && !cur.trashed)) {
      picked.set(item.id, { item, trashed, t });
    }
  };

  for (const side of [remote, local]) {
    for (const item of side?.[listKey] || []) consider(item, false);
    for (const item of side?.[trashKey] || []) consider(item, true);
  }

  const items = [];
  const trash = [];
  for (const { item, trashed } of picked.values()) (trashed ? trash : items).push(item);
  return [items, trash];
}

export function mergeBoards(local, remote) {
  const [notes, trash] = mergeKind(local, remote, 'notes', 'trash');
  const [zones, zonesTrash] = mergeKind(local, remote, 'zones', 'zonesTrash');
  return { notes, trash, zones, zonesTrash };
}
