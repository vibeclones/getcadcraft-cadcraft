/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cheatsheet.js — the 40 everyday commands of the one-page cheat sheet (0.7 D7.06 b). DOM-free. The same list makes the help page
 * (help/cheat-sheet.md) and the PDFs (cheat-sheet.pdf, cheat-sheet.es-MX.pdf) through tools/cadcraft-test/make-cheat-sheet.mjs, and
 * bin/test-cadcraft.mjs checks that every alias is really the command next to it and that the page and the list agree.
 */
export const CHEAT_GROUPS = ['draw', 'modify', 'dim', 'blocks', 'view', 'file'];
export const CHEAT = [
  ['draw', 'LINE', 'L'], ['draw', 'PLINE', 'PL'], ['draw', 'CIRCLE', 'C'], ['draw', 'ARC', 'A'], ['draw', 'RECTANG', 'REC'], ['draw', 'POLYGON', 'POL'],
  ['draw', 'ELLIPSE', 'EL'], ['draw', 'TEXT', 'DT'], ['draw', 'MTEXT', 'T'], ['draw', 'HATCH', 'H'],
  ['modify', 'MOVE', 'M'], ['modify', 'COPY', 'CO'], ['modify', 'ROTATE', 'RO'], ['modify', 'SCALE', 'SC'], ['modify', 'MIRROR', 'MI'], ['modify', 'OFFSET', 'O'],
  ['modify', 'TRIM', 'TR'], ['modify', 'EXTEND', 'EX'], ['modify', 'FILLET', 'F'], ['modify', 'CHAMFER', 'CHA'], ['modify', 'ERASE', 'E'], ['modify', 'EXPLODE', 'X'],
  ['modify', 'STRETCH', 'S'], ['modify', 'ARRAY', 'AR'], ['modify', 'JOIN', 'J'], ['modify', 'BREAK', 'BR'],
  ['dim', 'DIMLINEAR', 'DLI'], ['dim', 'DIMALIGNED', 'DAL'], ['dim', 'DIMRADIUS', 'DRA'], ['dim', 'DIMANGULAR', 'DAN'],
  ['blocks', 'BLOCK', 'B'], ['blocks', 'INSERT', 'I'], ['blocks', 'LAYER', 'LA'],
  ['view', 'ZOOM', 'Z'], ['view', 'DIST', 'DI'], ['view', 'LIST', 'LI'], ['view', 'MATCHPROP', 'MA'],
  ['file', 'UNDO', 'U'], ['file', 'SAVE', 'SAVE'], ['file', 'PLOT', 'PLOT'],
].map(([group, cmd, alias]) => ({ group, cmd, alias }));
/** A command's line on the sheet: its language key (keys are lower case; the command name stays as typed). */
export const cheatKey = (cmd) => 'cheat.cmd.' + cmd.toLowerCase();
