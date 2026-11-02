/* SPDX-License-Identifier: Apache-2.0 */
/**
 * print.js — printing patterns (track AP, AP.8), through CadCraft's own plot pipeline (plot.js displayList → toPdfPages):
 * true vectors at 1:1, Helvetica text, one PDF. No DOM.
 *
 *   PAPERS                         home printer papers: a4 (210 × 297 mm), letter (8.5 × 11 in)
 *   printDoc(doc, pieces, size, draw) → { pd, ents } — a drawing holding the pieces in one size (each piece's graphics in
 *                                  that size as a block, placed where the piece is)
 *   fullSize(doc, pieces, sizes, { draw, margin }) → [{ list, name }] — one page per size, as big as the pieces (plotters)
 *   tiled(doc, pieces, sizes, { draw, paper, overlap, margin, t }) → [{ list, name }] — per size: a cover page (the test
 *                                  square, the tile map) and one page per tile that has something on it; each tile carries its
 *                                  name (row letter + column number), the neighbours' names, match marks in the overlap and a
 *                                  trim line
 *   testSquare(u) → { side (mm), label }   10 cm in metric drawings, 4 in in drawings in inches
 *   MAX_PAGE                       the biggest PDF page side (200 in = 5080 mm)
 *
 * `pieces` = [{ e (the block reference), data }]; `draw(data)` = the piece's graphics (main.js graphics()); `size` null =
 * the piece as drawn. A page list item = { list (a plot.js display list, in mm), name }.
 */

import { Doc } from '../../../doc.js';
import { displayList } from '../../../plot.js';
import { emptyBounds, primBounds, growPt, validBounds, textCorners } from '../../../geom.js';
import { gradeData } from './grade.js';

export const PAPERS = { a4: { w: 210, h: 297, label: 'A4' }, letter: { w: 215.9, h: 279.4, label: 'Letter' } };
export const MAX_PAGE = 5080;
const MM = { mm: 1, in: 25.4 };

export const testSquare = (u) => (u === 'in' ? { side: 101.6, label: '4 in' } : { side: 100, label: '10 cm' });

/** A drawing with the pieces in one size. */
export function printDoc(doc, pieces, size, draw) {
  const pd = new Doc();
  for (const [k, l] of doc.layers) pd.layers.set(k, { ...l });
  pd.meta = { ...doc.meta };
  const ents = [];
  pieces.forEach(({ e, data }, i) => {
    const d = size && data.sizes && data.sizes.list.includes(size) ? gradeData(data, size) : { ...data };
    delete d.nest;
    const name = '*PRINT' + i;
    pd.blocks.set(name, { name, base: { x: 0, y: 0 }, entities: draw(d).map((x) => ({ ...x })) });
    ents.push({ type: 'insert', block: name, x: e.x || 0, y: e.y || 0, rot: e.rot || 0, sx: e.sx ?? 1, sy: e.sy ?? 1, layer: e.layer || '0', color: e.color ?? null, id: i + 1 });
  });
  return { pd, ents };
}

/** Bounds (drawing units) of what entities draw. */
function boundsOf(pd, ents) {
  const b = emptyBounds();
  const l = displayList(pd, { w: 0, h: 0, views: [{ clip: null, m: null, entities: ents }] });
  for (const s of l.views[0].strokes) for (const q of s.prims) primBounds(q, b);
  for (const t of l.views[0].texts) for (const p of textCorners(t.e)) growPt(b, p.x, p.y);
  for (const f of l.views[0].fills) for (const lp of f.loops) for (let i = 0; i + 1 < lp.length; i += 2) growPt(b, lp[i], lp[i + 1]);
  return validBounds(b) ? b : null;
}

const unitsOf = (pieces) => (pieces.some((p) => p.data.u === 'in') ? 'in' : 'mm');
const sizesOf = (pieces, sizes) => (sizes && sizes.length ? sizes : [null]);

/** Plain marks (lines and text, in mm) drawn on a page over the pieces. */
const marksView = (ents) => ({ pd: new Doc(), view: { clip: null, m: null, entities: ents } });

/** Full size: one page per size, the pieces at 1:1 with a margin round them. */
export function fullSize(doc, pieces, sizes, { draw, margin = 10, t = (k) => k } = {}) {
  const out = [];
  const k = MM[unitsOf(pieces)];
  for (const size of sizesOf(pieces, sizes)) {
    const { pd, ents } = printDoc(doc, pieces, size, draw);
    const b = boundsOf(pd, ents);
    if (!b) continue;
    const w = (b.maxX - b.minX) * k + 2 * margin, h = (b.maxY - b.minY) * k + 2 * margin + 8;
    const m = [k, 0, 0, k, margin - b.minX * k, margin - b.minY * k];
    const list = displayList(pd, { w, h, name: size || '', views: [{ clip: null, m, entities: ents }] }, { mono: true });
    const label = [{ type: 'text', x: margin, y: h - 6, h: 3.5, rot: 0, s: t('print.full.label', { size: size || t('print.asdrawn') }), ha: 'left', va: 'baseline' }];
    const mv = marksView(label);
    list.views.push(...displayList(mv.pd, { w, h, views: [mv.view] }, { mono: true }).views);
    out.push({ list, name: size ? t('print.page.size', { size }) : t('print.page.all'), w, h, tooBig: w > MAX_PAGE || h > MAX_PAGE });
  }
  return out;
}

const rowName = (r) => { let s = ''; let n = r + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
export const tileName = (r, c) => rowName(r) + (c + 1);

/**
 * Tiled for home printers. Content is cut into tiles of the paper's printable area (margin all round); neighbouring tiles
 * overlap by `overlap` mm. Rows are lettered from the top, columns numbered from the left: tile "B3".
 */
export function tiled(doc, pieces, sizes, { draw, paper = 'a4', overlap = 10, margin = 10, t = (k) => k } = {}) {
  const P = PAPERS[paper] || PAPERS.a4;
  const u = unitsOf(pieces), k = MM[u];
  const out = [];
  const pw = P.w - 2 * margin, ph = P.h - 2 * margin - 8;   // 8 mm at the top for the tile's name line
  const sx = pw - overlap, sy = ph - overlap;
  for (const size of sizesOf(pieces, sizes)) {
    const { pd, ents } = printDoc(doc, pieces, size, draw);
    const b = boundsOf(pd, ents);
    if (!b) continue;
    const W = (b.maxX - b.minX) * k, H = (b.maxY - b.minY) * k;
    const cols = Math.max(1, Math.ceil((W - overlap) / sx - 1e-9)), rows = Math.max(1, Math.ceil((H - overlap) / sy - 1e-9));
    // the content in mm, its top-left at (0, 0) of the tile grid, y up; tile (r, c) covers x c·sx … c·sx + pw, y −(r·sy + ph) … −r·sy
    const base = [k, 0, 0, k, -b.minX * k, -b.maxY * k];
    const full = displayList(pd, { w: 0, h: 0, views: [{ clip: null, m: base, entities: ents }] }, { mono: true });
    const inks = [];   // which tiles have anything on them
    // a point is on every tile whose area holds it (the overlaps belong to two)
    const hit = (x, y) => {
      const c0 = Math.max(0, Math.ceil((x - pw) / sx - 1e-9)), c1 = Math.min(cols - 1, Math.floor(x / sx + 1e-9));
      const r0 = Math.max(0, Math.ceil((-y - ph) / sy - 1e-9)), r1 = Math.min(rows - 1, Math.floor(-y / sy + 1e-9));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) inks[r * cols + c] = true;
    };
    const step = Math.min(sx, sy) / 4;
    const seg = (x1, y1, x2, y2) => { const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step)); for (let i = 0; i <= n; i++) hit(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n); };
    for (const st of full.views[0].strokes) for (const q of st.prims) {
      if (q.k === 'L') seg(q.x1, q.y1, q.x2, q.y2);
      else { const n = 16; for (let i = 0; i < n; i++) { const a0 = q.a0 + (q.a1 - q.a0) * i / n, a1 = q.a0 + (q.a1 - q.a0) * (i + 1) / n; seg(q.cx + q.r * Math.cos(a0), q.cy + q.r * Math.sin(a0), q.cx + q.r * Math.cos(a1), q.cy + q.r * Math.sin(a1)); } }
    }
    for (const tx of full.views[0].texts) hit(tx.e.x, tx.e.y);
    const pages = [];
    // the cover: the test square and the tile map
    const sq = testSquare(u);
    const cover = [];
    const L = (x1, y1, x2, y2, extra = {}) => cover.push({ type: 'line', x1, y1, x2, y2, ...extra });
    const T = (x, y, s, h = 4, ha = 'left', ww = 0) => cover.push({ type: 'text', x, y, h, rot: 0, s, ha, va: 'baseline', ...(ww ? { ww } : {}) });
    T(margin, P.h - margin - 6, t('print.cover.title', { size: size || t('print.asdrawn') }), 5);
    T(margin, P.h - margin - 13, t('print.cover.how', { paper: P.label, overlap: (u === 'in' ? +(overlap / 25.4).toFixed(2) + ' in' : +overlap.toFixed(1) + ' mm') }), 3.2, 'left', P.w - 2 * margin);
    const sqx = margin, sqy = P.h - margin - 30 - sq.side;
    cover.push({ type: 'poly', closed: true, pts: [[sqx, sqy], [sqx + sq.side, sqy], [sqx + sq.side, sqy + sq.side], [sqx, sqy + sq.side]].map(([x, y]) => ({ x, y, b: 0 })) });
    T(sqx + sq.side / 2, sqy + sq.side / 2, t('print.cover.square', { side: sq.label }), 4, 'center');
    T(sqx, sqy - 6, t('print.cover.check', { side: sq.label }), 3.2, 'left', P.w - 2 * margin);
    // the map: every tile as a box with its name, filled tiles bold, the pieces' outline scaled into it
    const mapTop = sqy - 20, mapH = mapTop - margin, mapW = P.w - 2 * margin;
    const gw = cols * sx + overlap, gh = rows * sy + overlap;
    const s = Math.min(mapW / gw, mapH / gh);
    const mx = margin, my = mapTop;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = mx + c * sx * s, y0 = my - r * sy * s, x1 = x0 + pw * s, y1 = y0 - ph * s;
      cover.push({ type: 'poly', closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x, y, b: 0 })), lt: inks[r * cols + c] ? undefined : 'DASHED', lts: 0.05 });
      T((x0 + x1) / 2, (y0 + y1) / 2, tileName(r, c), Math.min(6, Math.max(2, pw * s / 6)), 'center');
    }
    const coverList = displayList(new Doc(), { w: P.w, h: P.h, views: [{ clip: null, m: null, entities: cover }] }, { mono: true });
    // the pieces on the map, scaled down
    const mapM = [k * s, 0, 0, k * s, mx - b.minX * k * s, my - b.maxY * k * s];
    coverList.views.unshift(...displayList(pd, { w: 0, h: 0, views: [{ clip: null, m: mapM, entities: ents }] }, { mono: true }).views);
    coverList.name = t('print.page.cover', { size: size || '' });
    pages.push({ list: coverList, name: t('print.page.cover', { size: size || t('print.asdrawn') }), cover: true });
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!inks[r * cols + c]) continue;
      const tx = c * sx, ty = -r * sy;   // the tile's top-left in content mm
      const m = [k, 0, 0, k, margin - tx - b.minX * k, (P.h - margin - 8) - ty - b.maxY * k];
      const clip = [{ x: margin, y: margin }, { x: margin + pw, y: margin }, { x: margin + pw, y: margin + ph }, { x: margin, y: margin + ph }];
      const list = displayList(pd, { w: P.w, h: P.h, name: tileName(r, c), views: [{ clip, m, entities: ents }] }, { mono: true });
      const marks = [];
      const ML = (x1, y1, x2, y2, extra = {}) => marks.push({ type: 'line', x1, y1, x2, y2, ...extra });
      const MT = (x, y, s2, h = 3, ha = 'left', rot = 0) => marks.push({ type: 'text', x, y, h, rot, s: s2, ha, va: 'baseline' });
      // trim line round the printable area; the overlap shown dashed
      const X0 = margin, Y0 = margin, X1 = margin + pw, Y1 = margin + ph;
      marks.push({ type: 'poly', closed: true, pts: [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]].map(([x, y]) => ({ x, y, b: 0 })) });
      if (c + 1 < cols) ML(X1 - overlap, Y0, X1 - overlap, Y1, { lt: 'DASHED', lts: 0.1 });
      if (r + 1 < rows) ML(X0, Y0 + overlap, X1, Y0 + overlap, { lt: 'DASHED', lts: 0.1 });
      // match marks: diamonds in the middle of each overlap, on both pages that share it, named after the pair
      const diamond = (x, y, label) => { const d = 3; marks.push({ type: 'poly', closed: true, pts: [[x, y - d], [x + d, y], [x, y + d], [x - d, y]].map(([a, b2]) => ({ x: a, y: b2, b: 0 })) }); ML(x - d, y, x + d, y); ML(x, y - d, x, y + d); MT(x + d + 1, y + 1, label, 2.5); };
      const midX = (X1 - overlap / 2), midY = (Y0 + overlap / 2);
      if (c + 1 < cols) for (const f of [0.25, 0.75]) diamond(midX, Y0 + ph * f, tileName(r, c) + '|' + tileName(r, c + 1));
      if (c > 0) for (const f of [0.25, 0.75]) diamond(X0 + overlap / 2, Y0 + ph * f, tileName(r, c - 1) + '|' + tileName(r, c));
      if (r + 1 < rows) for (const f of [0.25, 0.75]) diamond(X0 + pw * f, midY, tileName(r, c) + '/' + tileName(r + 1, c));
      if (r > 0) for (const f of [0.25, 0.75]) diamond(X0 + pw * f, Y1 - overlap / 2, tileName(r - 1, c) + '/' + tileName(r, c));
      // the tile's name, its neighbours and the size
      const nb = [r > 0 ? t('print.up', { n: tileName(r - 1, c) }) : '', c > 0 ? t('print.left', { n: tileName(r, c - 1) }) : '', c + 1 < cols ? t('print.right', { n: tileName(r, c + 1) }) : '', r + 1 < rows ? t('print.down', { n: tileName(r + 1, c) }) : ''].filter(Boolean).join(', ');
      MT(X0, Y1 + 3, t('print.tile', { n: tileName(r, c), size: size || t('print.asdrawn'), rows, cols }) + (nb ? '  (' + nb + ')' : ''), 3.2);
      const mv = displayList(new Doc(), { w: P.w, h: P.h, views: [{ clip: null, m: null, entities: marks }] }, { mono: true });
      list.views.push(...mv.views);
      pages.push({ list, name: tileName(r, c) + (size ? ' ' + size : ''), tile: tileName(r, c) });
    }
    out.push(...pages.map((p) => ({ ...p, size, rows, cols })));
  }
  return out;
}
