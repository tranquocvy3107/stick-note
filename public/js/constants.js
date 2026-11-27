// Constants shared by the store, the interface and the interactions.

export const COLOR_KEYS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'white'];

export const NOTE_W = 220; // default width of a text note
export const NOTE_H = 112; // default minimum height
export const MIN_W = 120;
export const MAX_W = 1200;
export const THUMB_MAX_W = 460; // image notes wider than this use the original instead of the thumbnail
export const TRASH_KEEP_DAYS = 60;

// The help dialog: each row `x` has the messages `x.k` (the keys or gesture) and `x.d` (what it does).
export const HELP_SECTIONS = [
  { title: 'help.add.title', rows: ['help.add.tray', 'help.add.dbl', 'help.add.n', 'help.add.paste', 'help.add.drop'] },
  { title: 'help.note.title', rows: ['help.note.edit', 'help.note.drag', 'help.note.resize', 'help.note.link', 'help.note.copy', 'help.note.pin', 'help.note.delete'] },
  { title: 'help.nav.title', rows: ['help.nav.drag', 'help.nav.zoom', 'help.nav.home', 'help.nav.fit', 'help.nav.search'] },
  { title: 'help.select.title', rows: ['help.select.area', 'help.select.add', 'help.select.all', 'help.select.undo'] },
];
