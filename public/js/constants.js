// Constants shared by the store, the interface and the interactions.

export const COLOR_KEYS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple', 'white'];

export const NOTE_W = 220; // default width of a text note
export const NOTE_H = 112; // default minimum height
export const MIN_W = 120;
export const MAX_W = 1200;
export const THUMB_MAX_W = 460; // image notes wider than this use the original instead of the thumbnail
export const TRASH_KEEP_DAYS = 60;

// Zones: labelled rectangles behind the notes (see zones.js).
export const ZONE_KINDS = ['important', 'normal', 'low']; // a zone may also be private (a separate flag)
export const ZONE_MIN_W = 120;
export const ZONE_MIN_H = 90;
export const ZONE_LABEL_MAX = 80;
export const ZONE_WRAP_PAD = 28; // space left around the notes when a zone is wrapped around them (board units)
export const ZONE_SCREEN_W = 380; // a new zone covers about this much of the screen (px), whatever the zoom level
export const ZONE_SCREEN_H = 250;
export const ZONE_HOLD_MS = 400; // press and hold this long on the empty board, then drag, to draw a zone

// The help dialog: each row `x` has the messages `x.k` (the keys or gesture) and `x.d` (what it does).
export const HELP_SECTIONS = [
  { title: 'help.add.title', rows: ['help.add.tray', 'help.add.dbl', 'help.add.n', 'help.add.paste', 'help.add.drop'] },
  { title: 'help.note.title', rows: ['help.note.edit', 'help.note.drag', 'help.note.resize', 'help.note.link', 'help.note.copy', 'help.note.pin', 'help.note.delete'] },
  { title: 'help.zone.title', rows: ['help.zone.draw', 'help.zone.keys', 'help.zone.tray', 'help.zone.move', 'help.zone.kind', 'help.zone.private'] },
  { title: 'help.nav.title', rows: ['help.nav.drag', 'help.nav.zoom', 'help.nav.home', 'help.nav.fit', 'help.nav.search'] },
  { title: 'help.select.title', rows: ['help.select.area', 'help.select.add', 'help.select.all', 'help.select.undo'] },
];
