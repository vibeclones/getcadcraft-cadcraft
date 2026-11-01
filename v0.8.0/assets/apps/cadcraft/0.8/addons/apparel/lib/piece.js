/* SPDX-License-Identifier: Apache-2.0 */
/**
 * piece.js — the pattern piece (track AP, AP.2): its data, how it draws, its grips, and how one is made from CadCraft
 * geometry. No DOM. The piece is the add-on object kind `piece` (docs/ADDONS-SPEC.md §6, local frame: the data is in the
 * piece's own frame, the block reference places it; MOVE / ROTATE / MIRROR change only the placement).
 *
 * Data (JSON, kept in the drawing as the object's xdata; version VERSION):
 *   name, style, size (the size this outline is: the base size), qty (cut quantity), fabric, cat (category), pair (cut as a
 *   mirrored pair: "cut 1 pair"), note
 *   u        'mm' | 'in' — the units the piece was drawn in (sizes of notches and text follow them)
 *   pts      [[x, y, c]] the SEW line, counter-clockwise; c = 1 curve point, 0 corner (curve.js)
 *   sa       null (net pattern) | { w, e: {edge start: width}, k: {corner: rule} } (seam.js)
 *   lines    [{ p: [[x, y, c]] }] internal lines (open)
 *   grain    { a: [x, y], b: [x, y], s: 'both' | 'one' | 'none' } | null — arrow style: arrowheads at both ends, at b, none
 *   fold     { a: [x, y], b: [x, y] } | null — the fold (mirror) line: the piece is cut on the fold there
 *   notches  [{ i: edge start (a corner index), d: distance along the edge, k: 'slit' | 'v' | 't', depth?, ang? (degrees
 *            off square to the edge) }]
 *   drills   [[x, y]] · buttons [[x, y, diameter]] · holes [[x, y, length, angle in degrees]] (buttonholes)
 *   label    [x, y] | null (null = the middle of the piece)
 *   sizes, grades: AP.4 (grade.js) — the size range and the grade rules; nest: true = draw every size stacked on the base
 *
 *   VERSION · KINDS · ARROWS · emptyPiece(u) · cleanPiece(raw) (untrusted: files, the clipboard) → piece | null
 *   drawPiece(data, opts) → CadCraft entities in the piece's frame (cut line, sew line, lines, grain, fold, notches, …)
 *   notchPlace(data, n) → { x, y, tx, ty, nx, ny, w } where the notch sits on the cut line (n = outward normal)
 *   placeNotch(data, p, kind) → a notch at the edge nearest p · sizesFor(u)
 *   gripsOf(data) · gripMove(data, key, to)
 *   fromPoly(e) / fromChain(ents) → { pts } (sew line, CCW) | { error } — PIECE's input
 *   labelLines(data, t) → the label's text lines
 */

import { ptsOf, rawOf, edges, edgePath, sampled, nearest, pointAt, cumulative, centroid, orientCCW, outward, area } from './curve.js';
import { cutLine, widthOf, RULES } from './seam.js';
import { cleanSizes, cleanGrades, gradedPts } from './grade.js';

export const VERSION = 1;
export const KINDS = ['slit', 'v', 't'];
export const ARROWS = ['both', 'one', 'none'];
export const MAX_PTS = 2000;
/** Colours of the sizes in the nest view (ACI): red, yellow, green, cyan, blue, magenta, then orange and violet shades. */
export const NEST_COLORS = [1, 2, 3, 4, 5, 6, 30, 200, 90, 150, 220, 40];

/** Default sizes by units: notch depth and width, text height, drill radius, button diameter, buttonhole length. */
export function sizesFor(u) {
  return u === 'in'
    ? { notch: 0.25, notchW: 0.125, text: 0.25, title: 0.375, drill: 0.0625, button: 0.5, hole: 0.625, arrow: 0.375, sa: 0.5 }
    : { notch: 6, notchW: 3, text: 6, title: 9, drill: 1.5, button: 12, hole: 16, arrow: 9, sa: 10 };
}

export function emptyPiece(u = 'mm') {
  return { name: '', style: '', size: '', qty: 1, fabric: '', cat: '', pair: false, note: '', u, pts: [], sa: null, lines: [], grain: null, fold: null, notches: [], drills: [], buttons: [], holes: [], label: null };
}

// ---------------------------------------------------------------------------------------------- untrusted data
const MAXC = 1e7;
const fin = (v) => Number.isFinite(v) && Math.abs(v) <= MAXC;
const str = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const xy = (v) => (Array.isArray(v) && fin(+v[0]) && fin(+v[1]) ? [+v[0], +v[1]] : null);
const ptList = (v, max = MAX_PTS) => (Array.isArray(v) ? v.slice(0, max).map((p) => (Array.isArray(p) && fin(+p[0]) && fin(+p[1]) ? [+p[0], +p[1], p[2] ? 1 : 0] : null)).filter(Boolean) : []);

/** A piece as read from a file or the clipboard: every field checked, unknown ones dropped. → piece | null (no outline). */
export function cleanPiece(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw.u === 'in' ? 'in' : 'mm';
  const p = emptyPiece(u);
  p.name = str(raw.name); p.style = str(raw.style); p.size = str(raw.size, 40); p.fabric = str(raw.fabric); p.cat = str(raw.cat); p.note = str(raw.note, 1000);
  p.qty = Number.isInteger(raw.qty) && raw.qty >= 0 && raw.qty <= 999 ? raw.qty : 1;
  p.pair = !!raw.pair;
  p.pts = ptList(raw.pts);
  if (p.pts.length < 3) return null;
  if (raw.sa && typeof raw.sa === 'object') {
    const w = fin(+raw.sa.w) && +raw.sa.w >= 0 ? +raw.sa.w : 0;
    const e = {}, k = {};
    for (const [i, v] of Object.entries(raw.sa.e || {})) if (/^\d+$/.test(i) && +i < p.pts.length && fin(+v) && +v >= 0) e[i] = +v;
    for (const [i, v] of Object.entries(raw.sa.k || {})) if (/^\d+$/.test(i) && +i < p.pts.length && RULES.includes(v)) k[i] = v;
    p.sa = { w, e, k };
  }
  p.lines = Array.isArray(raw.lines) ? raw.lines.slice(0, 200).map((l) => ({ p: ptList(l && l.p, 500) })).filter((l) => l.p.length >= 2) : [];
  if (raw.grain && xy(raw.grain.a) && xy(raw.grain.b)) p.grain = { a: xy(raw.grain.a), b: xy(raw.grain.b), s: ARROWS.includes(raw.grain.s) ? raw.grain.s : 'both' };
  if (raw.fold && xy(raw.fold.a) && xy(raw.fold.b)) p.fold = { a: xy(raw.fold.a), b: xy(raw.fold.b) };
  p.notches = Array.isArray(raw.notches) ? raw.notches.slice(0, 500).filter((n) => n && Number.isInteger(n.i) && n.i >= 0 && n.i < p.pts.length && fin(+n.d)).map((n) => {
    const o = { i: n.i, d: Math.max(0, +n.d), k: KINDS.includes(n.k) ? n.k : 'slit' };
    if (fin(+n.depth) && +n.depth > 0) o.depth = +n.depth;
    if (fin(+n.ang) && Math.abs(+n.ang) < 90) o.ang = +n.ang;
    return o;
  }) : [];
  const nums = (v, n, max = 500) => (Array.isArray(v) ? v.slice(0, max).filter((q) => Array.isArray(q) && q.length >= n && q.slice(0, n).every((x) => fin(+x))).map((q) => q.slice(0, n).map(Number)) : []);
  p.drills = nums(raw.drills, 2);
  p.buttons = nums(raw.buttons, 3).filter((b) => b[2] > 0);
  p.holes = nums(raw.holes, 4).filter((b) => b[2] > 0);
  p.label = xy(raw.label);
  const sizes = cleanSizes(raw.sizes);
  if (sizes) {
    p.sizes = sizes;
    p.grades = cleanGrades(raw.grades, sizes, p);
    p.size = sizes.base;
    if (raw.nest) p.nest = true;
  }
  return p;
}

// ---------------------------------------------------------------------------------------------- where things are
/** Where a notch sits: on the cut line, opposite its place on the sew line. n = outward normal. */
export function notchPlace(data, n) {
  const pts = ptsOf(data.pts);
  const e = edges(pts, true).find((x) => x.start === n.i);
  if (!e) return null;
  const path = edgePath(pts, e, true);
  const q = pointAt(path, n.d);
  const o = outward(q.tx, q.ty);
  const w = widthOf(data.sa, e.start);
  return { x: q.x + o.x * w, y: q.y + o.y * w, sx: q.x, sy: q.y, tx: q.tx, ty: q.ty, nx: o.x, ny: o.y, w };
}

/** A notch at the edge nearest p (piece frame). → the notch | null. */
export function placeNotch(data, p, kind = 'slit') {
  const pts = ptsOf(data.pts);
  let best = null;
  for (const e of edges(pts, true)) {
    const path = edgePath(pts, e, true);
    const h = nearest(path, p);
    if (!best || h.dist < best.dist) best = { i: e.start, d: h.d, dist: h.dist };
  }
  return best ? { i: best.i, d: +best.d.toFixed(4), k: KINDS.includes(kind) ? kind : 'slit' } : null;
}

// ---------------------------------------------------------------------------------------------- drawing
const poly = (pts, closed, extra = {}) => ({ type: 'poly', closed, pts: pts.map((p) => ({ x: p.x, y: p.y, b: 0 })), ...extra });
const line = (a, b, extra = {}) => ({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...extra });
const at = (v) => ({ x: v[0], y: v[1] });

/** The label's lines: name, style, size, how many to cut, fabric. `t` = the add-on's words. */
export function labelLines(data, t) {
  const out = [];
  if (data.name) out.push(data.name);
  if (data.style) out.push(t('label.style', { style: data.style }));
  if (data.size) out.push(t('label.size', { size: data.size }));
  const q = data.qty ?? 1;
  out.push(data.fold ? (data.pair ? t('label.cut.fold.pair', { n: q }) : t('label.cut.fold', { n: q })) : data.pair ? t('label.cut.pair', { n: q }) : t('label.cut', { n: q }));
  if (data.fabric) out.push(data.fabric);
  return out;
}

function arrowHead(tip, from, len) {
  const dx = tip.x - from.x, dy = tip.y - from.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, w = len * 0.35;
  const back = { x: tip.x - ux * len, y: tip.y - uy * len };
  return poly([{ x: back.x - uy * w, y: back.y + ux * w }, tip, { x: back.x + uy * w, y: back.y - ux * w }], false, { role: 'grain' });
}

/**
 * Everything a piece shows, in its own frame, as plain CadCraft entities (layer 0, colour by block, so the reference's layer
 * and colour rule). opts: { t (words), sizes (sizesFor(u) overrides), cut (precomputed cut line) }.
 */
export function drawPiece(data, opts = {}) {
  const t = opts.t || ((k) => k);
  const S = { ...sizesFor(data.u), ...(opts.sizes || {}) };
  const pts = ptsOf(data.pts);
  if (pts.length < 3) return [];
  const { path: sew } = sampled(pts, true);
  const hasSa = !!data.sa && edges(pts, true).some((e) => widthOf(data.sa, e.start) > 0);
  const cut = opts.cut || (hasSa ? cutLine(pts, data.sa) : sew.slice(0, -1));
  const out = [];
  out.push(poly(cut, true, { role: 'cut' }));
  if (hasSa) out.push(poly(sew.slice(0, -1), true, { lt: 'DASHED', lts: data.u === 'in' ? 0.25 : 0.25, role: 'sew' }));
  if (data.nest && data.sizes && data.sizes.list.length > 1) {
    data.sizes.list.forEach((size, i) => {
      if (size === data.sizes.base) return;
      const gp = ptsOf(gradedPts(data, size));
      const line = hasSa ? cutLine(gp, data.sa) : sampled(gp, true).path.slice(0, -1);
      out.push(poly(line, true, { color: NEST_COLORS[i % NEST_COLORS.length], role: 'nest', size }));
    });
  }
  for (const l of data.lines || []) {
    const lp = ptsOf(l.p);
    if (lp.length < 2) continue;
    const { path } = sampled(lp, false);
    out.push(poly(path, false, { role: 'line' }));
  }
  if (data.grain) {
    const a = at(data.grain.a), b = at(data.grain.b);
    out.push(line(a, b, { role: 'grain' }));
    if (data.grain.s !== 'none') out.push(arrowHead(b, a, S.arrow));
    if (data.grain.s === 'both') out.push(arrowHead(a, b, S.arrow));
  }
  if (data.fold) out.push(line(at(data.fold.a), at(data.fold.b), { lt: 'CENTER', lts: 0.25, role: 'fold' }));
  for (const n of data.notches || []) {
    const q = notchPlace(data, n);
    if (!q) continue;
    const depth = n.depth || S.notch;
    const a = ((n.ang || 0) * Math.PI) / 180;
    // the notch runs inward from the cut line; ang turns it off square
    const dx = -(q.nx * Math.cos(a) - q.ny * Math.sin(a)), dy = -(q.nx * Math.sin(a) + q.ny * Math.cos(a));
    const tip = { x: q.x + dx * depth, y: q.y + dy * depth };
    if (n.k === 'v') {
      const h = S.notchW / 2;
      out.push(poly([{ x: q.x + q.tx * h, y: q.y + q.ty * h }, tip, { x: q.x - q.tx * h, y: q.y - q.ty * h }], false, { role: 'notch' }));
    } else {
      out.push(line(q, tip, { role: 'notch' }));
      if (n.k === 't') { const h = S.notchW / 2; out.push(line({ x: tip.x + q.tx * h, y: tip.y + q.ty * h }, { x: tip.x - q.tx * h, y: tip.y - q.ty * h }, { role: 'notch' })); }
    }
  }
  for (const d of data.drills || []) {
    const c = at(d), r = S.drill;
    out.push({ type: 'circle', cx: c.x, cy: c.y, r, role: 'drill' });
    out.push(line({ x: c.x - r * 2, y: c.y }, { x: c.x + r * 2, y: c.y }, { role: 'drill' }), line({ x: c.x, y: c.y - r * 2 }, { x: c.x, y: c.y + r * 2 }, { role: 'drill' }));
  }
  for (const b of data.buttons || []) out.push({ type: 'circle', cx: b[0], cy: b[1], r: b[2] / 2, role: 'button' }, line({ x: b[0] - b[2] * 0.15, y: b[1] }, { x: b[0] + b[2] * 0.15, y: b[1] }, { role: 'button' }));
  for (const h of data.holes || []) {
    const a = (h[3] * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), L = h[2] / 2, bar = S.notchW / 2;
    const p0 = { x: h[0] - ux * L, y: h[1] - uy * L }, p1 = { x: h[0] + ux * L, y: h[1] + uy * L };
    out.push(line(p0, p1, { role: 'hole' }));
    for (const e of [p0, p1]) out.push(line({ x: e.x - uy * bar, y: e.y + ux * bar }, { x: e.x + uy * bar, y: e.y - ux * bar }, { role: 'hole' }));
  }
  const lines = labelLines(data, t);
  const c = data.label ? at(data.label) : centroid(sew);
  const gap = S.text * 1.6;
  lines.forEach((s, i) => {
    const h = i === 0 && data.name ? S.title : S.text;
    out.push({ type: 'text', x: c.x, y: c.y + ((lines.length - 1) / 2 - i) * gap, h, rot: 0, s, ha: 'center', va: 'middle', role: 'label' });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------- grips
/** Grips in the piece's frame: every sew line point, the grain line's ends, the fold line's, internal lines', drill holes, buttons, buttonholes, the label. */
export function gripsOf(data) {
  const g = [];
  (data.pts || []).forEach((p, i) => g.push({ x: p[0], y: p[1], key: 'p' + i }));
  if (data.grain) { g.push({ x: data.grain.a[0], y: data.grain.a[1], key: 'ga' }, { x: data.grain.b[0], y: data.grain.b[1], key: 'gb' }); }
  if (data.fold) { g.push({ x: data.fold.a[0], y: data.fold.a[1], key: 'fa' }, { x: data.fold.b[0], y: data.fold.b[1], key: 'fb' }); }
  (data.lines || []).forEach((l, i) => l.p.forEach((p, j) => g.push({ x: p[0], y: p[1], key: 'l' + i + '.' + j })));
  (data.drills || []).forEach((d, i) => g.push({ x: d[0], y: d[1], key: 'd' + i }));
  (data.buttons || []).forEach((d, i) => g.push({ x: d[0], y: d[1], key: 'b' + i }));
  (data.holes || []).forEach((d, i) => g.push({ x: d[0], y: d[1], key: 'h' + i }));
  if (data.label) g.push({ x: data.label[0], y: data.label[1], key: 'lab' });
  return g;
}

/** A grip dragged to `to` (piece frame). → new data | null (unknown grip). Moving an outline point keeps the piece CCW. */
export function gripMove(data, key, to) {
  const d = structuredClone(data);
  const xy2 = [+to.x.toFixed(6), +to.y.toFixed(6)];
  let m;
  if ((m = /^p(\d+)$/.exec(key)) && d.pts[+m[1]]) {
    d.pts[+m[1]] = [xy2[0], xy2[1], d.pts[+m[1]][2]];
    if (area(sampled(ptsOf(d.pts), true).path) < 0) return null;   // turned inside out: refuse
    return d;
  }
  if (key === 'ga' && d.grain) { d.grain.a = xy2; return d; }
  if (key === 'gb' && d.grain) { d.grain.b = xy2; return d; }
  if (key === 'fa' && d.fold) { d.fold.a = xy2; return d; }
  if (key === 'fb' && d.fold) { d.fold.b = xy2; return d; }
  if ((m = /^l(\d+)\.(\d+)$/.exec(key)) && d.lines[+m[1]]?.p[+m[2]]) { const q = d.lines[+m[1]].p[+m[2]]; d.lines[+m[1]].p[+m[2]] = [xy2[0], xy2[1], q[2] || 0]; return d; }
  if ((m = /^d(\d+)$/.exec(key)) && d.drills[+m[1]]) { d.drills[+m[1]] = xy2; return d; }
  if ((m = /^b(\d+)$/.exec(key)) && d.buttons[+m[1]]) { d.buttons[+m[1]] = [...xy2, d.buttons[+m[1]][2]]; return d; }
  if ((m = /^h(\d+)$/.exec(key)) && d.holes[+m[1]]) { d.holes[+m[1]] = [...xy2, d.holes[+m[1]][2], d.holes[+m[1]][3]]; return d; }
  if (key === 'lab') { d.label = xy2; return d; }
  return null;
}

// ---------------------------------------------------------------------------------------------- from CadCraft geometry
const ARC_STEP = Math.PI / 12;   // an arc becomes curve points every 15°
const SMOOTH = 2 * Math.PI / 180;   // a vertex where the direction turns less than 2° is a curve point

/** The points along a bulged segment a → b (excluding a, including b), all curve points but the last. */
export function bulgePoints(a, b, bulge) {
  if (!bulge) return [{ x: b.x, y: b.y, c: 0 }];
  const th = 4 * Math.atan(bulge);   // included angle (CCW +)
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const r = L / (2 * Math.sin(Math.abs(th) / 2));
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const h = r * Math.cos(Math.abs(th) / 2) * (Math.abs(th) > Math.PI ? -1 : 1);
  const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L, s = th > 0 ? 1 : -1;
  const cx = mx + nx * h * s, cy = my + ny * h * s;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const n = Math.max(2, Math.ceil(Math.abs(th) / ARC_STEP));
  const out = [];
  for (let i = 1; i <= n; i++) { const ang = a0 + (th * i) / n; out.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), c: i < n ? 1 : 0 }); }
  out[out.length - 1] = { x: b.x, y: b.y, c: 0 };
  return out;
}

/** Vertices where the outline runs on smoothly (tangent arcs, smooth polylines) become curve points. */
function markSmooth(pts) {
  const n = pts.length;
  return pts.map((p, i) => {
    if (p.c) return p;
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const t1 = Math.atan2(p.y - a.y, p.x - a.x), t2 = Math.atan2(b.y - p.y, b.x - p.x);
    let d = Math.abs(t2 - t1); if (d > Math.PI) d = 2 * Math.PI - d;
    const nearArc = a.c || b.c;
    return nearArc && d < SMOOTH ? { ...p, c: 1 } : p;
  });
}

function finish(list) {
  let pts = [];
  for (const p of list) if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) > 1e-9) pts.push(p);
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1e-6) pts.pop();
  if (pts.length < 3) return { error: 'few' };
  pts = orientCCW(markSmooth(pts));
  if (Math.abs(area(sampled(pts, true).path)) < 1e-9) return { error: 'flat' };
  if (pts.length > MAX_PTS) return { error: 'many' };
  return { pts: rawOf(pts.map((p) => ({ x: +p.x.toFixed(6), y: +p.y.toFixed(6), c: p.c }))) };
}

/** A closed polyline (or a circle / an ellipse) → the sew line. */
export function fromPoly(e) {
  if (!e) return { error: 'type' };
  if (e.type === 'circle') { const list = []; for (let i = 0; i < 12; i++) { const a = (i * Math.PI) / 6; list.push({ x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a), c: 1 }); } return finish(list); }
  if (e.type === 'ellipse') {
    const mx = e.mx, my = e.my, R = Math.hypot(mx, my), ang = Math.atan2(my, mx), r = R * e.ratio, list = [];
    for (let i = 0; i < 16; i++) { const t = (i * Math.PI) / 8; const x = R * Math.cos(t), y = r * Math.sin(t); list.push({ x: e.cx + x * Math.cos(ang) - y * Math.sin(ang), y: e.cy + x * Math.sin(ang) + y * Math.cos(ang), c: 1 }); }
    return finish(list);
  }
  if (e.type !== 'poly') return { error: 'type' };
  const v = e.pts || [];
  const closed = e.closed || (v.length > 2 && Math.hypot(v[0].x - v[v.length - 1].x, v[0].y - v[v.length - 1].y) < 1e-6);
  if (!closed) return { error: 'open' };
  const list = [{ x: v[0].x, y: v[0].y, c: 0 }];
  const n = v.length;
  for (let i = 0; i < n; i++) {
    const a = v[i], b = v[(i + 1) % n];
    if (i === n - 1 && !e.closed) break;
    list.push(...bulgePoints(a, b, a.b || 0));
  }
  return finish(list);
}

/** Lines, arcs and open polylines that join end to end into one closed outline → the sew line. */
export function fromChain(ents, tol = 1e-4) {
  const segs = [];
  for (const e of ents) {
    if (e.type === 'line') segs.push([{ x: e.x1, y: e.y1, c: 0 }, { x: e.x2, y: e.y2, c: 0 }]);
    else if (e.type === 'arc') {
      const sweep = ((e.a1 - e.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      const n = Math.max(2, Math.ceil(sweep / ARC_STEP));
      const s = [];
      for (let i = 0; i <= n; i++) { const a = e.a0 + (sweep * i) / n; s.push({ x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a), c: i > 0 && i < n ? 1 : 0 }); }
      segs.push(s);
    } else if (e.type === 'poly' && !e.closed) {
      const s = [{ x: e.pts[0].x, y: e.pts[0].y, c: 0 }];
      for (let i = 0; i + 1 < e.pts.length; i++) s.push(...bulgePoints(e.pts[i], e.pts[i + 1], e.pts[i].b || 0));
      segs.push(s);
    } else return { error: 'type' };
  }
  if (!segs.length) return { error: 'few' };
  const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;
  const chain = segs.shift();
  while (segs.length) {
    const end = chain[chain.length - 1];
    const k = segs.findIndex((s) => near(s[0], end) || near(s[s.length - 1], end));
    if (k < 0) return { error: 'gap' };
    let s = segs.splice(k, 1)[0];
    if (!near(s[0], end)) s = s.slice().reverse().map((p, i, arr) => ({ ...p, c: i === 0 || i === arr.length - 1 ? 0 : p.c }));
    chain.push(...s.slice(1));
  }
  if (!near(chain[0], chain[chain.length - 1])) return { error: 'open' };
  return finish(chain);
}

export { cumulative };
