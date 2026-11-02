/* SPDX-License-Identifier: Apache-2.0 */
/**
 * project.js — the schematic project (0.4 part 2, E.5): sheet frames with a numbered path grid, schematic sheets as
 * CadCraft layouts, where a point is ("sheet.path"), and the sheet list. DOM-free.
 *
 * A sheet frame is a block EL_FRAME_<size> (A3 / A4 landscape, millimetres, base point at the paper's lower-left
 * corner) whose constant EL attribute says role=frame and where its path columns are:
 *   "v=1;sym=frame;role=frame;size=A3;cols=10;gx0=20;gx1=410;gy0=45;gy1=282"
 * The title block's values are the frame insert's attributes: PROJECT, TITLE, PLANT (=), LOC (+), DRAWN, DATE, REV,
 * SHEET (its number) and SHEETS (how many). tags.js takes plant and location from them; xref.js and the wire numbers
 * take the sheet number. Anything drawn inside a frame's border belongs to that sheet, so frames work on layouts (one
 * sheet per layout, as ELSHEET makes them) and side by side in model space alike.
 */

import { t } from './text.js';
import { readMeta, writeMeta, insertM, apply, META_TAG, TAG_TEXT_H, PIN_TEXT_H } from './symbols.js';

export const FRAMES = {
  A3: { w: 420, h: 297, cols: 10, paper: 'iso-a3' },
  A4: { w: 297, h: 210, cols: 8, paper: 'iso-a4' },
};
const LEFT = 20, MARGIN = 10, BAND = 5, TB = 30;

const L = (x1, y1, x2, y2) => ({ type: 'line', layer: '0', color: null, x1, y1, x2, y2 });
const R = (x0, y0, x1, y1) => ({ type: 'poly', layer: '0', color: null, closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x, y, b: 0 })) });
const T = (x, y, s, h, ha = 'center', va = 'middle') => ({ type: 'text', layer: '0', color: null, x, y, h, rot: 0, s, ha, va });
const ad = (tag, x, y, h, o = {}) => ({ tag, prompt: o.prompt || tag, def: o.def || '', x, y, h, rot: 0, ha: o.ha || 'left', va: o.va || 'baseline', wf: 1, layer: '0', color: null, ...(o.invisible ? { invisible: true } : {}), ...(o.constant ? { constant: true } : {}) });

export const frameBlockName = (size) => 'EL_FRAME_' + (FRAMES[size] ? size : 'A3');

/** The frame block for a paper size: border, path columns numbered top and bottom, title block with attributes. */
export function frameBlock(size = 'A3') {
  const f = FRAMES[size] || FRAMES.A3;
  size = FRAMES[size] ? size : 'A3';
  const { w, h, cols } = f;
  const gx0 = LEFT, gx1 = w - MARGIN, top = h - MARGIN, bot = MARGIN;
  const gy1 = top - BAND, gy0 = bot + TB + BAND;
  const colw = (gx1 - gx0) / cols;
  const ents = [R(gx0, bot, gx1, top), L(gx0, gy1, gx1, gy1), L(gx0, gy0, gx1, gy0), L(gx0, bot + TB, gx1, bot + TB)];
  for (let i = 0; i <= cols; i++) {
    const x = gx0 + i * colw;
    ents.push(L(x, gy1, x, top), L(x, bot + TB, x, gy0));
    if (i < cols) {
      const cx = x + colw / 2, n = String(i + 1);
      ents.push(T(cx, top - BAND / 2, n, 2.5), T(cx, bot + TB + BAND / 2, n, 2.5));
    }
  }
  // title block: | project (wide) | title (wide) | = plant | + location | drawn / date | rev | sheet |
  const tb0 = bot, tb1 = bot + TB, width = gx1 - gx0;
  const xs = [0, 0.26, 0.6, 0.7, 0.8, 0.9, 0.95, 1].map((k) => gx0 + k * width);
  for (const x of xs.slice(1, -1)) ents.push(L(x, tb0, x, tb1));
  ents.push(L(xs[4], tb0 + TB / 2, xs[5], tb0 + TB / 2));
  const cap = (x, s) => T(x + 1.5, tb1 - 2.5, s, 1.8, 'left');
  ents.push(cap(xs[0], t('frame.project')), cap(xs[1], t('frame.title')), cap(xs[2], '='), cap(xs[3], '+'), cap(xs[4], t('frame.drawn')),
    T(xs[4] + 1.5, tb0 + TB / 2 - 2.5, t('frame.date'), 1.8, 'left'), cap(xs[5], t('frame.rev')), cap(xs[6], t('frame.sheet')));
  const v = (tag, x, y, hh, o) => ad(tag, x, y, hh, o);
  const attdefs = [
    v('PROJECT', xs[0] + 2, tb0 + 10, 3.5, { prompt: t('prompt.project') }),
    v('TITLE', xs[1] + 2, tb0 + 10, 3.5, { prompt: t('prompt.sheet-title') }),
    v('PLANT', xs[2] + 2, tb0 + 10, TAG_TEXT_H, { prompt: t('prompt.plant') }),
    v('LOC', xs[3] + 2, tb0 + 10, TAG_TEXT_H, { prompt: t('prompt.location') }),
    v('DRAWN', xs[4] + 2, tb0 + TB / 2 + 3, PIN_TEXT_H, { prompt: t('prompt.drawn-by') }),
    v('DATE', xs[4] + 2, tb0 + 3, PIN_TEXT_H, { prompt: t('prompt.date') }),
    v('REV', xs[5] + 2, tb0 + 10, TAG_TEXT_H, { prompt: t('prompt.revision') }),
    v('SHEET', xs[6] + (xs[7] - xs[6]) / 2, tb0 + 14, 3.5, { ha: 'center', prompt: t('prompt.sheet-number') }),
    v('SHEETS', xs[6] + (xs[7] - xs[6]) / 2, tb0 + 6, PIN_TEXT_H, { ha: 'center', prompt: t('prompt.sheets') }),
    ad(META_TAG, 0, 0, 1, { invisible: true, constant: true, def: writeMeta({ sym: 'frame', role: 'frame', size, cols, gx0, gx1, gy0, gy1, w, h }) }),
  ];
  return { name: frameBlockName(size), base: { x: 0, y: 0 }, entities: ents, attdefs };
}

/** A frame insert's grid in world coordinates: {cols, x0, x1, y0, y1, box: [x0,y0,x1,y1] (the whole paper), m, inv}. */
export function frameGrid(e, blk, meta = readMeta(blk)) {
  if (!meta || meta.role !== 'frame') return null;
  const n = (k, d) => (Number.isFinite(+meta[k]) ? +meta[k] : d);
  const cols = Math.max(1, Math.min(100, Math.round(n('cols', 10))));
  const m = insertM(e, blk);
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  const corners = [[0, 0], [n('w', 420), 0], [n('w', 420), n('h', 297)], [0, n('h', 297)]].map(([x, y]) => apply(m, x, y));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  return { cols, gx0: n('gx0', 20), gx1: n('gx1', 410), gy0: n('gy0', 45), gy1: n('gy1', 282), m, inv, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

/** The path column (1…cols) of a world point inside a frame; 0 when it is left or right of the grid. */
export function pathAt(grid, p) {
  const q = apply(grid.inv, p.x, p.y);
  if (q.x < grid.gx0 || q.x > grid.gx1) return 0;
  const colw = (grid.gx1 - grid.gx0) / grid.cols;
  return Math.min(grid.cols, Math.floor((q.x - grid.gx0) / colw) + 1);
}

export const inBox = (box, p, pad = 0) => p.x >= box[0] - pad && p.x <= box[2] + pad && p.y >= box[1] - pad && p.y <= box[3] + pad;

/** "3.5" — a sheet and path, as cross-references and lists print it ("3" when the path is unknown). */
export const placeLabel = (sheet, path) => (path ? sheet + '.' + path : String(sheet));

/**
 * A new schematic sheet: a layout of the frame's paper with the frame placed at its corner (inside a change).
 * values = the title block's attributes. → the layout.
 */
export function addSheet(doc, { size = 'A3', name, values = {} } = {}) {
  size = FRAMES[size] ? size : 'A3';
  const f = FRAMES[size];
  const blk = frameBlock(size);
  if (!doc.blocks.has(blk.name)) doc.defineBlock(blk);
  const names = new Set(doc.layouts.map((l) => l.name));
  let n = doc.layouts.length + 1, nm = name || t('sheet.name', { n });
  for (let k = 2; names.has(nm); k++) nm = name ? name + ' (' + k + ')' : t('sheet.name', { n: ++n }) + (k > 1000 ? ' (' + k + ')' : '');
  const layout = { name: nm, paper: { key: f.paper, unit: 'mm', w: f.w, h: f.h, x0: 0, y0: 0 }, entities: new Map() };
  doc.setLayouts([...doc.layouts, layout]);
  const sheetNo = values.SHEET || String(nextSheetNumber(doc));
  doc.add({ type: 'insert', block: blk.name, x: 0, y: 0, sx: 1, sy: 1, rot: 0, layer: 'EL-FRAME', attrs: { PROJECT: '', TITLE: '', PLANT: '', LOC: '', DRAWN: '', DATE: '', REV: '', SHEETS: '', ...values, SHEET: sheetNo } }, layout.entities);
  return layout;
}

/** The next free sheet number (one more than the highest whole number in use). */
export function nextSheetNumber(doc) {
  let hi = 0;
  for (const sp of spacesOf(doc)) for (const e of sp.map.values()) {
    if (e.type !== 'insert') continue;
    const meta = readMeta(doc.blocks.get(e.block));
    if (meta?.role === 'frame') { const k = parseInt(e.attrs?.SHEET, 10); if (k > hi) hi = k; }
  }
  return hi + 1;
}

/** The drawing's spaces: model + every layout, each {key, name, map, layout}. */
export function spacesOf(doc) {
  if (!doc || !(doc.model instanceof Map)) return [];   // not a drawing (an exporter handed something else)
  return [{ key: 'model', name: t('space.model'), map: doc.model, layout: null }, ...(doc.layouts || []).map((l, i) => ({ key: 'L' + i, name: l.name, map: l.entities, layout: l }))];
}
