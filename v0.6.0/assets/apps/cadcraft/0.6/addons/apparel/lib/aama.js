/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — the strings here are the DXF-AAMA / ASTM / RUL file formats' own keywords, never shown as UI text. */
/**
 * aama.js — DXF-AAMA and ASTM D6673 pattern files, out and in (track AP, AP.7; the format as docs/APPAREL-DXF.md maps it from
 * public descriptions and nine pattern programs' files — no other reader's code). No DOM.
 *
 * OUT  writeAama(pieces, opts) → { dxf (text), rul (text | null), notes [] }
 *   pieces = [{ data, place: { x, y, rot, sx, sy } }] (the object's data and its block reference's placement)
 *   opts   = { standard: 'aama' | 'astm', grading: 'rul' | 'nested' | 'none', style, author, date (Date), sizes (to write) }
 *   An R12 ASCII DXF: one block per piece (nested: per piece per size, named "<piece>_<size>"), inserted at 0,0 with the
 *   piece where it lies in the drawing; layers 1 cut line (ASTM also 84), 14 sew line (ASTM also 87), 2 / 3 turn and curve
 *   points, 4 / 80 / 82 notches (slit / T / V) with their angle (group 50, into the piece), 7 grain line, 6 fold line, 8 internal
 *   lines (ASTM also 85), 13 drill holes, buttons and buttonholes as internal lines with a layer 19 text; the piece's text on
 *   layer 1 and the style's header in model space. RUL grading: every graded point carries "# n" (its rule); the RUL file lists
 *   the rules, each an x y pair per size measured from the sample (base) size, in the file's units. Our own piece data rides
 *   on the cut line as xdata under CC_APPAREL, so a file we wrote reads back exactly.
 *
 * IN   readAama(dxf, rul?) → { pieces: [{ data, place }], header: {…}, notes [] }
 *   Ours (CC_APPAREL xdata) come back as they were. Anyone else's: the cut line (84 over 1), the sew line (87 / 14, Lectra: 0)
 *   with the seam allowance read per edge from the distance between them, turn / curve points, notches (4, 80–83), grain,
 *   fold, internal lines, drill holes, the piece text; grading from the RUL (rule numbers on the points) or from blocks per
 *   size. readDxfGroups(text) is the tokenizer; parseRul(text) the RUL reader.
 */

import { encodeItems, decodeItems, DATA } from '../../objects.js';
import { ptsOf, rawOf, edges, edgePath, sampled, nearest, orientCCW, area, length } from './curve.js';
import { cutLine, widthOf } from './seam.js';
import { notchPlace, placeNotch, emptyPiece, cleanPiece, bulgePoints } from './piece.js';
import { gradeData, gradedPts } from './grade.js';

export const APPID = 'CC_APPAREL';
const NOTCH_LAYER = { slit: '4', t: '80', v: '82' };
const LAYER_NOTCH = { 4: 'slit', 80: 't', 81: 'slit', 82: 'v', 83: 'slit' };

// ============================================================================================== writing
const f = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };
/** DXF R12 text: printable ASCII, anything else as \U+XXXX. */
const dxfText = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, (c) => '\\U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
const blockName = (s) => (String(s || 'PIECE').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'PIECE').slice(0, 64);

class Out {
  constructor() { this.l = []; }
  g(code, v) { this.l.push(String(code).padStart(3, ' '), String(v)); }
  text() { return this.l.join('\r\n') + '\r\n'; }
}

/** Transform a piece-frame point by its placement. */
function placer(place) {
  const { x = 0, y = 0, rot = 0, sx = 1, sy = 1 } = place || {};
  const c = Math.cos(rot), s = Math.sin(rot);
  return (p) => ({ x: x + c * sx * p.x - s * sy * p.y, y: y + s * sx * p.x + c * sy * p.y });
}
const flipped = (place) => ((place?.sx ?? 1) * (place?.sy ?? 1) < 0);

/** Everything one piece shows, in drawing coordinates, at one size: the lists the file needs. */
function geometryOf(data, place, size) {
  const d = size && data.sizes ? gradeData(data, size) : data;
  const P = placer(place);
  const pts = ptsOf(d.pts);
  const sew = sampled(pts, true).path.slice(0, -1);
  const hasSa = !!d.sa && edges(pts, true).some((e) => widthOf(d.sa, e.start) > 0);
  const cut = hasSa ? cutLine(pts, d.sa) : sew;
  // which sew samples are our corners (turn points) — the rest are curve points
  const { at } = sampled(pts, true);
  const corner = new Set(at.filter((s, i) => s >= 0 && !pts[i].c));
  const notches = (d.notches || []).map((n) => { const q = notchPlace(d, n); return q ? { x: q.x, y: q.y, nx: -q.nx, ny: -q.ny, k: n.k } : null; }).filter(Boolean);
  let order = (a) => a;
  if (flipped(place)) order = (a) => a.slice().reverse();   // a mirrored piece runs clockwise: write it counter-clockwise
  return {
    d, hasSa,
    cut: order(cut.map(P)), sew: order(sew.map(P)), sewCorner: order(sew.map((_, i) => corner.has(i))),
    cutCorner: order(cut.map((p, i, arr) => { const a = arr[(i - 1 + arr.length) % arr.length], b = arr[(i + 1) % arr.length]; const t1 = Math.atan2(p.y - a.y, p.x - a.x), t2 = Math.atan2(b.y - p.y, b.x - p.x); let dd = Math.abs(t2 - t1); if (dd > Math.PI) dd = 2 * Math.PI - dd; return dd > 0.17; })),
    notches: notches.map((n) => { const q = P(n); const o = P({ x: n.x + n.nx, y: n.y + n.ny }); return { ...q, ang: Math.atan2(o.y - q.y, o.x - q.x) * 180 / Math.PI, k: n.k }; }),
    grain: d.grain ? [P({ x: d.grain.a[0], y: d.grain.a[1] }), P({ x: d.grain.b[0], y: d.grain.b[1] })] : null,
    fold: d.fold ? [P({ x: d.fold.a[0], y: d.fold.a[1] }), P({ x: d.fold.b[0], y: d.fold.b[1] })] : null,
    lines: (d.lines || []).map((l) => sampled(ptsOf(l.p), false).path.map(P)),
    drills: (d.drills || []).map((q) => P({ x: q[0], y: q[1] })),
    buttons: (d.buttons || []).map((b) => ({ c: P({ x: b[0], y: b[1] }), r: b[2] / 2 })),
    holes: (d.holes || []).map((h) => { const a = h[3] * Math.PI / 180, L = h[2] / 2; return [P({ x: h[0] - Math.cos(a) * L, y: h[1] - Math.sin(a) * L }), P({ x: h[0] + Math.cos(a) * L, y: h[1] + Math.sin(a) * L })]; }),
  };
}

/** Rules for the points written: a move per size for every point (the same count in every size), deduplicated. */
class RuleBook {
  constructor(sizes) { this.sizes = sizes; this.list = []; this.byKey = new Map(); }
  /** moves = [[dx, dy] per size] → its number (identical rules share one). All zero → the zero rule. */
  add(moves) {
    const r = moves.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    const k = JSON.stringify(r);
    if (!this.byKey.has(k)) { this.list.push(r); this.byKey.set(k, this.list.length); }
    return this.byKey.get(k);
  }
}

export function writeAama(pieces, opts = {}) {
  const std = opts.standard === 'astm' ? 'astm' : 'aama';
  const notes = [];
  const u = pieces.some((p) => p.data.u === 'in') ? 'in' : 'mm';
  // the sizes: the first graded piece's range (others are matched by name)
  const range = pieces.find((p) => p.data.sizes)?.data.sizes || null;
  let grading = opts.grading || (range ? 'rul' : 'none');
  if (!range) grading = 'none';
  const sizes = range ? (opts.sizes && opts.sizes.length ? range.list.filter((s) => opts.sizes.includes(s)) : range.list) : [];
  if (range && !sizes.includes(range.base) && grading === 'rul') sizes.splice(range.list.indexOf(range.base), 0, range.base);
  const base = range ? range.base : '';
  const book = new RuleBook(sizes);
  const o = new Out();
  // ---- header
  o.g(999, 'CadCraft Apparel');
  o.g(0, 'SECTION'); o.g(2, 'HEADER');
  o.g(9, '$ACADVER'); o.g(1, 'AC1009');
  o.g(9, '$INSBASE'); o.g(10, 0); o.g(20, 0); o.g(30, 0);
  o.g(9, '$MEASUREMENT'); o.g(70, u === 'in' ? 0 : 1);
  o.g(0, 'ENDSEC');
  // ---- tables
  const layers = ['0', '1', '2', '3', '4', '6', '7', '8', '13', '14', '15', '19', '80', '82', ...(std === 'astm' ? ['84', '85', '87'] : [])];
  o.g(0, 'SECTION'); o.g(2, 'TABLES');
  o.g(0, 'TABLE'); o.g(2, 'LTYPE'); o.g(70, 1);
  o.g(0, 'LTYPE'); o.g(2, 'CONTINUOUS'); o.g(70, 0); o.g(3, 'Solid line'); o.g(72, 65); o.g(73, 0); o.g(40, 0);
  o.g(0, 'ENDTAB');
  o.g(0, 'TABLE'); o.g(2, 'LAYER'); o.g(70, layers.length);
  for (const l of layers) { o.g(0, 'LAYER'); o.g(2, l); o.g(70, 0); o.g(62, 7); o.g(6, 'CONTINUOUS'); }
  o.g(0, 'ENDTAB');
  o.g(0, 'TABLE'); o.g(2, 'STYLE'); o.g(70, 1);
  o.g(0, 'STYLE'); o.g(2, 'STANDARD'); o.g(70, 0); o.g(40, 0); o.g(41, 1); o.g(50, 0); o.g(71, 0); o.g(42, 2.5); o.g(3, 'txt'); o.g(4, '');
  o.g(0, 'ENDTAB');
  o.g(0, 'TABLE'); o.g(2, 'APPID'); o.g(70, 2);
  o.g(0, 'APPID'); o.g(2, 'ACAD'); o.g(70, 0);
  o.g(0, 'APPID'); o.g(2, APPID); o.g(70, 0);
  o.g(0, 'ENDTAB');
  o.g(0, 'ENDSEC');
  // ---- blocks
  const blocks = [];
  const used = new Set();
  const uniq = (n) => { let s = n, k = 2; while (used.has(s.toUpperCase())) s = n + '_' + k++; used.add(s.toUpperCase()); return s; };
  const th = u === 'in' ? 0.04 : 1;   // rule number text height
  o.g(0, 'SECTION'); o.g(2, 'BLOCKS');
  for (const p of pieces) {
    const d = p.data;
    const own = d.sizes && range && d.sizes.list.join() === range.list.join() && d.sizes.base === range.base;
    if (d.sizes && !own) notes.push({ key: 'aama.note.range', vars: { name: d.name } });
    const rowsOf = grading === 'nested' && d.sizes ? sizes.filter((s) => d.sizes.list.includes(s)) : [d.sizes ? d.sizes.base : null];
    for (const size of rowsOf) {
      const name = uniq(blockName(d.name || 'Piece') + (grading === 'nested' && size ? '_' + size : ''));
      blocks.push(name);
      const g = geometryOf(d, p.place, size);
      // rules for RUL grading: every written point's move in every size (same sampling in every size)
      let ruleAt = null;
      if (grading === 'rul' && d.sizes) {
        const per = sizes.map((s) => geometryOf(d, p.place, s));
        const ok = (key) => per.every((q) => q[key].length === g[key].length);
        if (!ok('cut') || !ok('sew')) { notes.push({ key: 'aama.note.points', vars: { name: d.name } }); }
        ruleAt = (key, i) => (ok(key) ? book.add(per.map((q) => [q[key][i].x - g[key][i].x, q[key][i].y - g[key][i].y])) : null);
        ruleAt.of = (pick) => book.add(per.map((q) => { const a = pick(q), b = pick(g); return a && b ? [a.x - b.x, a.y - b.y] : [0, 0]; }));
      }
      o.g(0, 'BLOCK'); o.g(8, '0'); o.g(2, name); o.g(70, 0); o.g(10, 0); o.g(20, 0); o.g(30, 0); o.g(3, name);
      const poly = (layer, list, closed, xdata = null) => {
        o.g(0, 'POLYLINE'); o.g(8, layer); o.g(66, 1); o.g(10, 0); o.g(20, 0); o.g(30, 0); o.g(70, closed ? 1 : 0);
        if (xdata) { o.g(1001, APPID); for (const [c, v] of xdata) o.g(c, v); }
        for (const q of list) { o.g(0, 'VERTEX'); o.g(8, layer); o.g(10, f(q.x)); o.g(20, f(q.y)); o.g(30, 0); }
        o.g(0, 'SEQEND'); o.g(8, layer);
      };
      const point = (layer, q, ang = null) => { o.g(0, 'POINT'); o.g(8, layer); o.g(10, f(q.x)); o.g(20, f(q.y)); o.g(30, 0); if (ang !== null) o.g(50, f(ang)); };
      const text = (layer, q, s, h) => { o.g(0, 'TEXT'); o.g(8, layer); o.g(10, f(q.x)); o.g(20, f(q.y)); o.g(30, 0); o.g(40, f(h)); o.g(1, dxfText(s)); };
      const line = (layer, a, b) => { o.g(0, 'LINE'); o.g(8, layer); o.g(10, f(a.x)); o.g(20, f(a.y)); o.g(30, 0); o.g(11, f(b.x)); o.g(21, f(b.y)); o.g(31, 0); };
      const rule = (layer, q, n) => { if (n) text(layer, q, '# ' + n, th); };
      // our own data, so a file we wrote reads back as it was
      let xd = null;
      if (grading === 'nested' && size && size !== d.sizes?.base) xd = encodeItems(DATA, null, 1, { sizeOf: d.name || name, size });   // another size of a piece whose base block carries the data
      else {
        try { xd = encodeItems(DATA, null, 1, { piece: d, place: p.place || {} }); } catch { notes.push({ key: 'aama.note.big', vars: { name: d.name } }); }
      }
      poly('1', g.cut, true, xd);
      if (std === 'astm') poly('84', g.cut, true);
      g.cut.forEach((q, i) => { point(g.cutCorner[i] ? '2' : '3', q); if (ruleAt) rule(std === 'astm' ? '1' : (g.cutCorner[i] ? '2' : '3'), q, ruleAt('cut', i)); });
      if (g.hasSa) {
        poly('14', g.sew, true);
        if (std === 'astm') poly('87', g.sew, true);
        g.sew.forEach((q, i) => { point(g.sewCorner[i] ? '2' : '3', q); if (ruleAt) rule(std === 'astm' ? '14' : (g.sewCorner[i] ? '2' : '3'), q, ruleAt('sew', i)); });
      }
      g.notches.forEach((n, i) => { point(NOTCH_LAYER[n.k] || '4', n, n.ang); if (ruleAt) rule(NOTCH_LAYER[n.k] || '4', n, ruleAt.of((q) => q.notches[i])); });
      if (g.grain) { line('7', g.grain[0], g.grain[1]); if (ruleAt) { rule('7', g.grain[0], ruleAt.of((q) => q.grain?.[0])); rule('7', g.grain[1], ruleAt.of((q) => q.grain?.[1])); } }
      if (g.fold) line('6', g.fold[0], g.fold[1]);
      g.lines.forEach((l, li) => { poly('8', l, false); if (std === 'astm') poly('85', l, false); if (ruleAt) l.forEach((q, j) => rule('8', q, ruleAt.of((x) => x.lines[li]?.[j]))); });
      g.drills.forEach((q, i) => { point('13', q); if (ruleAt) rule('13', q, ruleAt.of((x) => x.drills[i])); });
      for (const b of g.buttons) { const n = 16; const ring = []; for (let i = 0; i < n; i++) ring.push({ x: b.c.x + b.r * Math.cos(i * 2 * Math.PI / n), y: b.c.y + b.r * Math.sin(i * 2 * Math.PI / n) }); poly('8', ring, true); text('19', b.c, 'Button', th * 2); }
      for (const h of g.holes) { line('8', h[0], h[1]); text('19', h[0], 'Buttonhole', th * 2); }
      // the piece's text
      const at = sampled(ptsOf(g.d.pts), true).path;
      const mid = placer(p.place)({ x: at.reduce((s2, q) => s2 + q.x, 0) / at.length, y: at.reduce((s2, q) => s2 + q.y, 0) / at.length });
      const lh = u === 'in' ? 0.2 : 5;
      const lines = [['Piece Name', d.name], ['Size', size || d.size || base], ['Quantity', d.qty ?? 1], ['Category', d.cat], ['Annotation', d.note], ['Material', d.fabric]];
      if (d.pair) lines.push(['Flip', 'X']);
      if (d.fold) lines.push(['Fold', 'Y']);
      lines.forEach(([k, v], i) => text('1', { x: mid.x, y: mid.y - i * lh * 1.5 }, k + ': ' + (v ?? ''), lh));
      text('15', { x: mid.x, y: mid.y + lh * 2 }, d.name || name, lh);
      o.g(0, 'ENDBLK'); o.g(8, '0');
    }
  }
  o.g(0, 'ENDSEC');
  // ---- entities: the inserts, anything extra (a marker's fabric) and the style's header
  o.g(0, 'SECTION'); o.g(2, 'ENTITIES');
  for (const b of blocks) { o.g(0, 'INSERT'); o.g(8, '1'); o.g(2, b); o.g(10, 0); o.g(20, 0); o.g(30, 0); }
  for (const x of opts.extra || []) {
    o.g(0, 'POLYLINE'); o.g(8, x.layer || '0'); o.g(66, 1); o.g(10, 0); o.g(20, 0); o.g(30, 0); o.g(70, x.closed ? 1 : 0);
    for (const q of x.pts) { o.g(0, 'VERTEX'); o.g(8, x.layer || '0'); o.g(10, f(q.x)); o.g(20, f(q.y)); o.g(30, 0); }
    o.g(0, 'SEQEND'); o.g(8, x.layer || '0');
  }
  const dt = opts.date instanceof Date ? opts.date : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const style = opts.style || pieces.find((p) => p.data.style)?.data.style || 'Pattern';
  const head = [
    ['Style Name', style], ['Creation Date', p2(dt.getDate()) + '-' + p2(dt.getMonth() + 1) + '-' + dt.getFullYear()], ['Creation Time', p2(dt.getHours()) + ':' + p2(dt.getMinutes())],
    ['Author', opts.author || 'CadCraft'], ['Product', 'CadCraft Apparel'], ['Version', '1'],
    ...(range ? [['Sample Size', base]] : []), ...(grading === 'rul' ? [['Grade Rule Table', style]] : []),
    ['Units', u === 'in' ? 'ENGLISH' : 'METRIC'],
    ['Standard Version', std === 'astm' ? 'ASTM/D13Proposal 1 Version: D 6673-04' : 'ANSI/AAMA-292-B'],
  ];
  head.forEach(([k, v], i) => { o.g(0, 'TEXT'); o.g(8, '1'); o.g(10, 0); o.g(20, f(-(i + 1) * (u === 'in' ? 0.3 : 8))); o.g(30, 0); o.g(40, u === 'in' ? 0.2 : 5); o.g(1, dxfText(k + ': ' + v)); });
  o.g(0, 'ENDSEC');
  o.g(0, 'EOF');
  let rul = null;
  if (grading === 'rul') {
    const L = [];
    L.push('ASTM/D13 Proposal 1 Version: D 6673-04', 'AUTHOR: ' + (opts.author || 'CadCraft'), 'PRODUCT: CadCraft Apparel', 'CREATION DATE: ' + head[1][1], 'CREATION TIME: ' + head[2][1],
      'UNITS: ' + (u === 'in' ? 'ENGLISH' : 'METRIC'), 'GRADE RULE TABLE: ' + dxfText(style), 'NUMBER OF SIZES: ' + sizes.length, 'SIZE LIST: ' + sizes.join(' '), 'SAMPLE SIZE: ' + base);
    book.list.forEach((r, i) => {
      L.push('RULE: DELTA ' + (i + 1));
      for (let k = 0; k < r.length; k += 4) L.push(r.slice(k, k + 4).map(([x, y]) => x.toFixed(2).padStart(9) + y.toFixed(2).padStart(9)).join(''));
    });
    L.push('END');
    rul = L.join('\r\n') + '\r\n';
  }
  return { dxf: o.text(), rul, notes, sizes, rules: book.list.length };
}

// ============================================================================================== reading
/** DXF text → [[code, value]] (codes as numbers, values as strings; leading/trailing spaces trimmed). */
export function readDxfGroups(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(c)) { i--; continue; }   // a stray line: resync
    out.push([c, lines[i + 1].replace(/^\s+|\s+$/g, '')]);
  }
  return out;
}

const unescape = (s) => String(s).replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/%%[cdp]/gi, '');

/** The entities of a run of groups (a block or the entities section). */
function entitiesOf(g, i0, stop) {
  const ents = [];
  let i = i0;
  while (i < g.length && !stop(g[i])) {
    if (g[i][0] !== 0) { i++; continue; }
    const type = g[i][1];
    const e = { type, layer: '0', xd: {} };
    i++;
    let app = null;
    const verts = [];
    while (i < g.length && g[i][0] !== 0) {
      const [c, v] = g[i];
      if (c === 1001) { app = v.toUpperCase(); e.xd[app] = []; }
      else if (app && c >= 1000) e.xd[app].push([c, c === 1070 || c === 1071 ? Number(v) : v]);
      else if (c === 8) e.layer = v;
      else if (type === 'LWPOLYLINE' && c === 10) verts.push({ x: +v, y: 0, b: 0 });
      else if (type === 'LWPOLYLINE' && c === 20 && verts.length) verts[verts.length - 1].y = +v;
      else if (type === 'LWPOLYLINE' && c === 42 && verts.length) verts[verts.length - 1].b = +v;
      else e[c] = v;
      i++;
    }
    if (type === 'LWPOLYLINE') { e.pts = verts; e.closed = (+e[70] & 1) === 1; }
    if (type === 'POLYLINE') {
      e.closed = (+e[70] & 1) === 1;
      e.pts = [];
      while (i < g.length && g[i][0] === 0 && g[i][1] === 'VERTEX') {
        i++;
        const v = { x: 0, y: 0, b: 0 };
        while (i < g.length && g[i][0] !== 0) { const [c, val] = g[i]; if (c === 10) v.x = +val; else if (c === 20) v.y = +val; else if (c === 42) v.b = +val; i++; }
        e.pts.push(v);
      }
      if (i < g.length && g[i][1] === 'SEQEND') { i++; while (i < g.length && g[i][0] !== 0) i++; }
    }
    ents.push(e);
  }
  return { ents, i };
}

/** The parts of a DXF the format uses: blocks (name → entities), model space entities. */
export function readDxfParts(text) {
  const g = readDxfGroups(text);
  const blocks = new Map();
  let ents = [];
  for (let i = 0; i < g.length; i++) {
    if (g[i][0] === 0 && g[i][1] === 'SECTION' && g[i + 1]?.[0] === 2) {
      const sec = g[i + 1][1];
      i += 2;
      if (sec === 'BLOCKS') {
        while (i < g.length && !(g[i][0] === 0 && g[i][1] === 'ENDSEC')) {
          if (g[i][0] === 0 && g[i][1] === 'BLOCK') {
            let name = '';
            i++;
            while (i < g.length && g[i][0] !== 0) { if (g[i][0] === 2) name = g[i][1]; i++; }
            const r = entitiesOf(g, i, (x) => x[0] === 0 && x[1] === 'ENDBLK');
            blocks.set(name, r.ents);
            i = r.i;
          } else i++;
        }
      } else if (sec === 'ENTITIES') {
        const r = entitiesOf(g, i, (x) => x[0] === 0 && x[1] === 'ENDSEC');
        ents = r.ents;
        i = r.i;
      } else while (i < g.length && !(g[i][0] === 0 && g[i][1] === 'ENDSEC')) i++;
    }
  }
  return { blocks, ents };
}

/** The RUL file → { units, sizes, sample, rules: Map(n → [[dx, dy] per size]) } | null. */
export function parseRul(text) {
  if (!text) return null;
  const out = { units: 'METRIC', sizes: [], sample: '', rules: new Map(), name: '' };
  let cur = null;
  for (const raw of String(text).split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^RULE:\s*DELTA\s+(\d+)/i.exec(line))) { cur = []; out.rules.set(+m[1], cur); continue; }
    if ((m = /^UNITS:\s*(\S+)/i.exec(line))) { out.units = m[1].toUpperCase(); continue; }
    if ((m = /^SIZE LIST:\s*(.*)$/i.exec(line))) { out.sizes = m[1].trim().split(/\s+/).filter(Boolean); continue; }
    if ((m = /^SAMPLE SIZE:\s*(.*)$/i.exec(line))) { out.sample = m[1].trim(); continue; }
    if ((m = /^GRADE RULE TABLE:\s*(.*)$/i.exec(line))) { out.name = m[1].trim(); continue; }
    if (/^END$/i.test(line)) { cur = null; continue; }
    if (/^[A-Za-z][A-Za-z /]*:/.test(line)) continue;   // other header lines
    if (cur) {
      const nums = line.replace(/,/g, ' ').trim().split(/\s+/).map(Number);
      if (nums.some((x) => !Number.isFinite(x))) continue;
      for (let k = 0; k + 1 < nums.length; k += 2) cur.push([nums[k], nums[k + 1]]);
    }
  }
  if (!out.sizes.length) return null;
  return out;
}

const RULE_RE = /^#\s*-?\s*(\d+)$/;
const near = (a, b, tol) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
const headerOf = (ents) => {
  const h = {};
  for (const e of ents) if (e.type === 'TEXT' && e[1]) { const m = /^([^:]+):\s*(.*)$/.exec(unescape(e[1])); if (m) h[m[1].trim().toLowerCase()] = m[2].trim(); }
  return h;
};
const polyPts = (e) => {
  if (e.type === 'LINE') return [{ x: +e[10], y: +e[20] }, { x: +e[11], y: +e[21] }];
  const v = e.pts || [];
  const out = [];
  for (let i = 0; i < v.length; i++) {
    out.push({ x: v[i].x, y: v[i].y });
    if (v[i].b && (i + 1 < v.length || e.closed)) for (const q of bulgePoints(v[i], v[(i + 1) % v.length], v[i].b).slice(0, -1)) out.push({ x: q.x, y: q.y });
  }
  return out;
};
const dedupe = (pts) => { const o = []; for (const p of pts) if (!o.length || !near(o[o.length - 1], p, 1e-9)) o.push(p); if (o.length > 2 && near(o[0], o[o.length - 1], 1e-9)) o.pop(); return o; };

/** A block of someone else's file → a piece (base size). → { data, rules: Map(point index → rule n) } | null */
function pieceFromBlock(name, ents, header, u) {
  const by = (layers, types) => ents.filter((e) => layers.includes(e.layer) && (!types || types.includes(e.type)));
  const polys = (layers) => by(layers, ['POLYLINE', 'LWPOLYLINE']).map(polyPts).map(dedupe).filter((p) => p.length >= 3);
  const longest = (list) => list.sort((a, b) => length([...b, b[0]]) - length([...a, a[0]]))[0] || null;
  const cut = longest(polys(['84'])) || longest(polys(['1']));
  if (!cut) return null;
  let sew = longest(polys(['87'])) || longest(polys(['14']));
  if (!sew) { const zero = longest(polys(['0'])); if (zero && Math.abs(area(zero)) < Math.abs(area(cut))) sew = zero; }   // Lectra AAMA keeps its sew line on layer 0
  const turn = by(['2'], ['POINT']).map((e) => ({ x: +e[10], y: +e[20] }));
  const tolOf = (pts) => { let b = 0; for (const p of pts) b = Math.max(b, Math.abs(p.x), Math.abs(p.y)); return Math.max(1e-6, b * 1e-7) + (u === 'in' ? 0.001 : 0.02); };
  const flags = (line) => {
    const tol = tolOf(line);
    return line.map((p, i) => {
      if (turn.some((q) => near(q, p, tol))) return 0;
      const a = line[(i - 1 + line.length) % line.length], b = line[(i + 1) % line.length];
      const t1 = Math.atan2(p.y - a.y, p.x - a.x), t2 = Math.atan2(b.y - p.y, b.x - p.x);
      let d = Math.abs(t2 - t1); if (d > Math.PI) d = 2 * Math.PI - d;
      return d > 0.35 ? 0 : 1;   // a turn over 20° with no point telling us: a corner
    });
  };
  const main = sew || cut;
  let pts = main.map((p, i, arr) => ({ ...p, c: flags(arr)[i] }));
  if (!pts.some((p) => !p.c)) pts[0].c = 0;
  pts = orientCCW(pts);
  const data = { ...emptyPiece(u), pts: rawOf(pts.map((p) => ({ x: +p.x.toFixed(6), y: +p.y.toFixed(6), c: p.c }))) };
  // allowance per edge: how far the cut line is from each edge of the sew line
  if (sew) {
    const sp = ptsOf(data.pts), e2 = {};
    let all = [];
    for (const ed of edges(sp, true)) {
      const path = edgePath(sp, ed, true);
      const ds = path.slice(1, -1).concat(path.length <= 2 ? [{ x: (path[0].x + path[1].x) / 2, y: (path[0].y + path[1].y) / 2 }] : []).map((q) => nearest([...cut, cut[0]], q).dist).sort((a, b) => a - b);
      const w = ds.length ? +ds[Math.floor(ds.length / 2)].toFixed(u === 'in' ? 4 : 2) : 0;
      e2[ed.start] = w; all.push(w);
    }
    all = all.sort((a, b) => a - b);
    const common = all[Math.floor(all.length / 2)] || 0;
    const e3 = {};
    for (const [k, w] of Object.entries(e2)) if (Math.abs(w - common) > (u === 'in' ? 0.002 : 0.05)) e3[k] = w;
    data.sa = { w: common, e: e3, k: {} };
  }
  // marks
  const sewPts = ptsOf(data.pts);
  for (const e of ents) {
    const L = +e.layer;
    if (e.type === 'POINT' && LAYER_NOTCH[L]) { const q = { x: +e[10], y: +e[20] }; const n = placeNotch(data, q, LAYER_NOTCH[L]); if (n) data.notches.push(n); }
    else if (e.type === 'POINT' && L === 13) data.drills.push([+e[10], +e[20]]);
    else if (e.type === 'LINE' && L === 7 && !data.grain) data.grain = { a: [+e[10], +e[20]], b: [+e[11], +e[21]], s: 'both' };
    else if (e.type === 'LINE' && L === 6 && !data.fold) data.fold = { a: [+e[10], +e[20]], b: [+e[11], +e[21]] };
    else if ((e.type === 'LINE' || e.type === 'POLYLINE' || e.type === 'LWPOLYLINE') && (L === 8 || L === 85)) {
      if (L === 85 && by(['8']).length) continue;   // the curve copy of an internal line already read
      const p = dedupe(polyPts(e));
      if (p.length >= 2 && data.lines.length < 200) data.lines.push({ p: p.slice(0, 500).map((q) => [+q.x.toFixed(6), +q.y.toFixed(6), 0]) });
    }
  }
  // the piece's words
  const tx = {};
  for (const e of ents) if (e.type === 'TEXT' && (e.layer === '1' || e.layer === '15') && e[1]) { const m = /^([^:]+):\s*(.*)$/.exec(unescape(e[1])); if (m) tx[m[1].trim().toLowerCase()] = m[2].trim(); }
  data.name = (tx['piece name'] || name).slice(0, 200);
  data.size = (tx['size'] || tx['sample size'] || header['sample size'] || '').slice(0, 40);
  data.qty = Math.max(0, Math.min(999, parseInt(tx['quantity'], 10) || 1));
  data.cat = (tx['category'] || '').slice(0, 200);
  data.fabric = (tx['material'] || '').slice(0, 200);
  data.note = (tx['annotation'] || '').slice(0, 1000);
  data.style = (header['style name'] || '').slice(0, 200);
  data.pair = /x|y/i.test(tx['flip'] || '');
  // rule numbers on the sew line points (or the cut line's nearest numbered point)
  const nums = ents.filter((e) => e.type === 'TEXT' && RULE_RE.test(String(e[1] || '').trim())).map((e) => ({ x: +e[10], y: +e[20], n: +RULE_RE.exec(String(e[1]).trim())[1], layer: e.layer }));
  const rules = new Map();
  const tol = tolOf(main);
  const sa = data.sa?.w || 0;
  sewPts.forEach((p, i) => {
    let r = nums.find((q) => near(q, p, tol));
    if (!r && sa > 0) { let best = null; for (const q of nums) { const dd = Math.hypot(q.x - p.x, q.y - p.y); if (dd <= sa * 2.5 + tol && (!best || dd < best.dd)) best = { ...q, dd }; } r = best; }
    if (r) rules.set(i, r.n);
  });
  const markRules = new Map();
  if (data.grain) { for (const [k, xy] of [['ga', data.grain.a], ['gb', data.grain.b]]) { const r = nums.find((q) => near(q, { x: xy[0], y: xy[1] }, tol)); if (r) markRules.set(k, r.n); } }
  data.drills.forEach((d, i) => { const r = nums.find((q) => near(q, { x: d[0], y: d[1] }, tol)); if (r) markRules.set('d' + i, r.n); });
  return { data, rules, markRules };
}

/** Units of the file: "Units:" text wins; else $MEASUREMENT; else millimetres. */
const unitsOf = (header, rul) => {
  const s = String(header['units'] || rul?.units || '').toUpperCase();
  return s.startsWith('ENG') ? 'in' : 'mm';
};

export function readAama(dxfText, rulText = null) {
  const notes = [];
  const { blocks, ents } = readDxfParts(dxfText);
  const header = headerOf(ents);
  const rul = parseRul(rulText);
  const u = unitsOf(header, rul);
  const pieces = [];
  const inserts = ents.filter((e) => e.type === 'INSERT' && blocks.has(e[2]));
  const names = inserts.length ? [...new Set(inserts.map((e) => e[2]))] : [...blocks.keys()].filter((n) => !n.startsWith('*') && !n.startsWith('$'));   // R12: $MODEL_SPACE, $PAPER_SPACE
  // 1. ours: the cut line carries our data
  const theirs = [];
  for (const n of names) {
    const list = blocks.get(n) || [];
    const own = list.find((e) => e.xd && e.xd[APPID]);
    const dec = own ? decodeItems(own.xd[APPID]) : null;
    const d = dec && dec.data && dec.data.piece ? cleanPiece(dec.data.piece) : null;
    if (d) { pieces.push({ data: d, place: cleanPlace(dec.data.place) }); continue; }
    if (own) continue;   // one of our nested sizes: its base carries the data
    theirs.push(n);
  }
  // 2. everyone else's: blocks per piece (per size when nested)
  const sample = header['sample size'] || rul?.sample || '';
  const groups = new Map();   // piece name → [{ block, size }]
  for (const n of theirs) {
    const list = blocks.get(n) || [];
    const tx = {};
    for (const e of list) if (e.type === 'TEXT' && e.layer === '1' && e[1]) { const m = /^([^:]+):\s*(.*)$/.exec(unescape(e[1])); if (m) tx[m[1].trim().toLowerCase()] = m[2].trim(); }
    const size = tx['size'] || '';
    const pname = tx['piece name'] || (size && n.endsWith('_' + size) ? n.slice(0, -size.length - 1) : n);
    if (!groups.has(pname)) groups.set(pname, []);
    groups.get(pname).push({ block: n, size });
  }
  for (const [pname, list] of groups) {
    const nested = list.length > 1 && list.every((x) => x.size) && new Set(list.map((x) => x.size)).size === list.length;
    if (list.length > 1 && !nested) {   // the same name on different pieces: each on its own
      for (const x of list) { const got = pieceFromBlock(x.block, blocks.get(x.block) || [], header, u); const c2 = got && fitPiece(got.data); if (c2) pieces.push({ data: c2, place: {} }); else if (!got) notes.push({ key: 'aama.note.nooutline', vars: { name: pname } }); }
      continue;
    }
    const baseEntry = nested ? (list.find((x) => x.size === sample) || list[Math.floor((list.length - 1) / 2)]) : list[0];
    const got = pieceFromBlock(baseEntry.block, blocks.get(baseEntry.block) || [], header, u);
    if (!got) { notes.push({ key: 'aama.note.nooutline', vars: { name: pname } }); continue; }
    const d = got.data;
    if (nested) {
      // every size drawn: rules = the difference, point by point, where the outlines have the same points
      const sizes = list.map((x) => x.size);
      const per = list.map((x) => (x === baseEntry ? got : pieceFromBlock(x.block, blocks.get(x.block) || [], header, u)));
      const same = per.every((q) => q && q.data.pts.length === d.pts.length);
      d.sizes = { list: sizes, base: baseEntry.size };
      d.size = baseEntry.size;
      d.grades = {};
      if (same) {
        d.pts.forEach((p, i) => { const r = per.flatMap((q) => [+(q.data.pts[i][0] - p[0]).toFixed(4), +(q.data.pts[i][1] - p[1]).toFixed(4)]); if (r.some((v) => Math.abs(v) > 1e-9)) d.grades['p' + i] = r; });
      } else notes.push({ key: 'aama.note.nestpoints', vars: { name: pname } });
    } else if (rul && got.rules.size) {
      const sizes = rul.sizes, bi = sizes.indexOf(rul.sample);
      const k = (rul.units.startsWith('ENG') ? 25.4 : 1) / (u === 'in' ? 25.4 : 1);
      d.sizes = { list: sizes, base: bi >= 0 ? rul.sample : sizes[0] };
      d.size = d.sizes.base;
      d.grades = {};
      const put = (key, n) => {
        const r = rul.rules.get(n);
        if (!r || r.length < sizes.length) return;
        const b = bi >= 0 ? r[bi] : [0, 0];
        const flat = sizes.flatMap((_, i) => [+((r[i][0] - b[0]) * k).toFixed(4), +((r[i][1] - b[1]) * k).toFixed(4)]);
        if (flat.some((v) => Math.abs(v) > 1e-9)) d.grades[key] = flat;
      };
      for (const [i, n] of got.rules) put('p' + i, n);
      for (const [key, n] of got.markRules) put(key, n);
    } else if (got.rules.size && !rul) notes.push({ key: 'aama.note.norul', vars: { name: pname } });
    let clean = fitPiece(cleanPiece(d));
    if (!clean && d.sizes) {   // too many sizes × points for one object: the sample size alone
      const plain = cleanPiece({ ...d, sizes: undefined, grades: undefined });
      clean = fitPiece(plain);
      if (clean) notes.push({ key: 'aama.note.ungraded', vars: { name: pname, n: d.sizes.list.length } });
    }
    if (clean) pieces.push({ data: clean, place: {} });
    else notes.push({ key: 'aama.note.toobig', vars: { name: pname } });
  }
  return { pieces, header, notes, units: u };
}

/** Douglas–Peucker over a run of points: the indices to keep (first and last always). */
function keepRun(pts, a, b, tol, keep) {
  let worst = -1, wd = tol;
  const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
  for (let i = a + 1; i < b; i++) {
    const d = L > 1e-12 ? Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L : Math.hypot(pts[i].x - A.x, pts[i].y - A.y);
    if (d > wd) { wd = d; worst = i; }
  }
  if (worst < 0) return;
  keep.add(worst);
  keepRun(pts, a, worst, tol, keep);
  keepRun(pts, worst, b, tol, keep);
}

/**
 * A piece that fits in a CadCraft object (its JSON ≤ limit): grade rules rounded, then curve points thinned within a growing
 * tolerance (corners, and every point a notch or allowance refers to, are kept; a thinned point's rule goes — the points
 * either side carry the curve, and unruled curve points follow in proportion). → piece | null (still too big).
 */
export function fitPiece(d, limit = 11500) {
  if (!d) return null;
  const size = (x) => JSON.stringify(x).length;
  if (size(d) <= limit) return d;
  const r = structuredClone(d);
  for (const k of Object.keys(r.grades || {})) r.grades[k] = r.grades[k].map((v) => +v.toFixed(r.u === 'in' ? 4 : 2));
  r.pts = r.pts.map((p) => [+p[0].toFixed(r.u === 'in' ? 5 : 3), +p[1].toFixed(r.u === 'in' ? 5 : 3), p[2]]);
  if (size(r) <= limit) return r;
  const unit = r.u === 'in' ? 1 / 25.4 : 1;
  for (const tol of [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1]) {
    const pts = ptsOf(r.pts), n = pts.length;
    const keep = new Set(pts.map((p, i) => (!p.c ? i : -1)).filter((i) => i >= 0));
    for (const nn of r.notches || []) keep.add(nn.i);
    if (!keep.size) keep.add(0);
    const ks = [...keep].sort((a, b) => a - b);
    for (let k = 0; k < ks.length; k++) {
      const a = ks[k], b = k + 1 < ks.length ? ks[k + 1] : ks[0] + n;
      const run = []; for (let i = a; i <= b; i++) run.push(pts[i % n]);
      const kk = new Set();
      keepRun(run, 0, run.length - 1, tol * unit, kk);
      for (const j of kk) keep.add((a + j) % n);
    }
    const order = [...keep].sort((a, b) => a - b);
    const map = new Map(order.map((old, i) => [old, i]));
    const t = structuredClone(r);
    t.pts = order.map((i) => r.pts[i]);
    t.notches = (r.notches || []).map((x) => ({ ...x, i: map.get(x.i) })).filter((x) => x.i !== undefined);
    if (t.sa) { const re = (o) => Object.fromEntries(Object.entries(o || {}).map(([k2, v]) => [map.get(+k2), v]).filter(([k2]) => k2 !== undefined)); t.sa = { ...t.sa, e: re(t.sa.e), k: re(t.sa.k) }; }
    if (t.grades) t.grades = Object.fromEntries(Object.entries(t.grades).map(([k2, v]) => { const m = /^p(\d+)$/.exec(k2); if (!m) return [k2, v]; const ni = map.get(+m[1]); return ni === undefined ? null : ['p' + ni, v]; }).filter(Boolean));
    if (size(t) <= limit) return t;
  }
  return null;
}

function cleanPlace(p) {
  const n = (v, d = 0) => (Number.isFinite(+v) && Math.abs(+v) < 1e7 ? +v : d);
  return { x: n(p?.x), y: n(p?.y), rot: n(p?.rot), sx: n(p?.sx, 1) || 1, sy: n(p?.sy, 1) || 1 };
}
export { gradedPts };
