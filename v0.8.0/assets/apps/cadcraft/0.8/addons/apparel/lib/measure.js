/* SPDX-License-Identifier: Apache-2.0 */
/**
 * measure.js — measuring patterns (track AP, AP.6). No DOM.
 *
 *   edgeAt(data, p) → { i (edge start), d (distance along it), dist } — the sew line edge nearest p
 *   edgeLength(data, i, size?) · along(data, a, b, size?) → { fwd, back } lengths round the sew line from a to b (points
 *   {x, y}, snapped to the line), forward = the way the outline runs (counter-clockwise), back = the other way
 *   walk(A, ia, B, ib, { size, reverse }) → { lenA, lenB, diff, pairs: [{ a, b, off }], onlyA, onlyB } — seam walking:
 *     edge ia of piece A against edge ib of piece B. Sewn face to face, two counter-clockwise edges run opposite ways, so
 *     B is walked from its end unless reverse === false. Notches pair up in order along the seam; `off` = how far B's
 *     notch lands from A's (B minus A, along the seam).
 *   pieceRows(data) → one row per size: { size, sewPerimeter, cutPerimeter, sewArea, cutArea } (drawing units, units²)
 *   toCsv(columns, rows) → CSV text (cells that start = + - @ get a leading ', CRLF), no BOM
 */

import { ptsOf, edges, edgePath, nearest, length, area } from './curve.js';
import { cutLine, widthOf } from './seam.js';
import { gradedPts, gradeData } from './grade.js';

const sewAt = (data, size) => ptsOf(size && data.sizes ? gradedPts(data, size) : data.pts);

export function edgeAt(data, p) {
  const pts = ptsOf(data.pts);
  let best = null;
  for (const e of edges(pts, true)) { const h = nearest(edgePath(pts, e, true), p); if (!best || h.dist < best.dist) best = { i: e.start, d: h.d, dist: h.dist }; }
  return best;
}

export function edgeLength(data, i, size) {
  const pts = sewAt(data, size);
  const e = edges(pts, true).find((x) => x.start === i);
  return e ? length(edgePath(pts, e, true)) : 0;
}

/** Lengths round the sew line between two places on it (each snapped to the line). */
export function along(data, a, b, size) {
  const pts = sewAt(data, size);
  const es = edges(pts, true);
  // one continuous path round the outline, starting at the first edge
  const path = [];
  for (const e of es) { const p = edgePath(pts, e, true); if (path.length) p.shift(); path.push(...p); }
  const L = length(path);
  const da = nearest(path, a).d, db = nearest(path, b).d;
  const fwd = ((db - da) % L + L) % L;
  return { fwd, back: (L - fwd) % L, total: L };
}

/** Seam walking: edge ia of A against edge ib of B. */
export function walk(A, ia, B, ib, { size = null, reverse = true } = {}) {
  const lenA = edgeLength(A, ia, size), lenB = edgeLength(B, ib, size);
  const notchA = (A.notches || []).filter((n) => n.i === ia).map((n) => Math.min(n.d, lenA)).sort((x, y) => x - y);
  let notchB = (B.notches || []).filter((n) => n.i === ib).map((n) => Math.min(n.d, lenB));
  notchB = (reverse ? notchB.map((d) => lenB - d) : notchB).sort((x, y) => x - y);
  const pairs = [];
  for (let k = 0; k < Math.min(notchA.length, notchB.length); k++) pairs.push({ a: notchA[k], b: notchB[k], off: notchB[k] - notchA[k] });
  return { lenA, lenB, diff: lenB - lenA, pairs, onlyA: notchA.slice(pairs.length), onlyB: notchB.slice(pairs.length) };
}

/** One row per size (just one, the base, when the piece has no size range). */
export function pieceRows(data) {
  const sizes = data.sizes ? data.sizes.list : [data.size || ''];
  return sizes.map((size) => {
    const d = data.sizes ? gradeData(data, size) : data;
    const pts = ptsOf(d.pts);
    const es = edges(pts, true);
    const sp = [];
    for (const e of es) { const p = edgePath(pts, e, true); if (sp.length) p.shift(); sp.push(...p); }
    const hasSa = !!d.sa && es.some((e) => widthOf(d.sa, e.start) > 0);
    const cut = hasSa ? cutLine(pts, d.sa) : sp.slice(0, -1);
    const closedLen = (q) => length([...q, q[0]]);
    return { size, sewPerimeter: length(sp), cutPerimeter: hasSa ? closedLen(cut) : length(sp), sewArea: Math.abs(area(sp)), cutArea: Math.abs(area(cut)) };
  });
}

const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // text a spreadsheet would run as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function toCsv(columns, rows) {
  return [columns.map((c) => cell(c.label)).join(','), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(','))].join('\r\n') + '\r\n';
}
