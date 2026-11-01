/* SPDX-License-Identifier: Apache-2.0 */
/**
 * grade.js — sizes and grading (track AP, AP.4). No DOM.
 *
 * A style has a **size range** (named sizes in order) and a **base size**: the size the pieces are drawn in. Every piece of
 * the style carries the range (`data.sizes = { list: ['XS', 'S', 'M', 'L', 'XL'], base: 'M' }`). A **grade rule** belongs to
 * a point of the piece and says how far it moves, in x and y, in each size **measured from the base size** — the same shape
 * as a RUL file (docs/APPAREL-DXF.md §2): `data.grades = { <point key>: [dx, dy, dx, dy, …] }`, one pair per size in the
 * range's order, the base size's pair 0 0. Point keys are the grip keys (piece.js): `p<i>` sew line points, `ga gb` grain
 * line, `fa fb` fold line, `l<i>.<j>` internal lines, `d<i> b<i> h<i>` drill holes, buttons, buttonholes, `lab` the label.
 *
 * A corner with no rule stays where it is. A **curve point** with no rule moves in proportion between the nearest points of
 * its edge that do move (by distance along the edge), so curves stay smooth when only the corners are graded. Notches keep
 * their distance along their edge. Editing the base size re-grades every size: the other sizes are never stored.
 *
 *   MAX_SIZES · cleanSizes(raw) · cleanGrades(raw, sizes, data) · sizeIndex(data, size)
 *   ruleOf(data, key) → [dx, dy, …] | null · setRule(data, key, rule) (a copy) · moveOf(rule, i) → [dx, dy]
 *   uniform(sizes, step) → a rule moving `step` [dx, dy] per size away from the base (negative below it)
 *   flip(rule, 'x' | 'y') · proportional(data, keyA, keyB) → { <key>: rule } for the sew line points between A and B
 *   gradedPts(data, size) → the sew line at that size ([[x, y, c]]) · gradeData(data, size) → the whole piece at that size
 *   parseSizes(text) → ['XS', 'S', …]
 */

import { ptsOf, edges, sampled, cumulative } from './curve.js';

export const MAX_SIZES = 60;
const fin = (v) => Number.isFinite(v) && Math.abs(v) <= 1e6;
const KEY = /^(p\d+|ga|gb|fa|fb|l\d+\.\d+|d\d+|b\d+|h\d+|lab)$/;

/** Size names typed in one line: "XS S M L XL", "34, 36, 38", "6/8 10/12". */
export function parseSizes(text) {
  const out = [];
  for (const s of String(text ?? '').split(/[\s,;]+/)) { const n = s.trim().slice(0, 12); if (n && !out.includes(n)) out.push(n); }
  return out.slice(0, MAX_SIZES);
}

/** A size range from a file or the clipboard → { list, base } | null. */
export function cleanSizes(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.list)) return null;
  const list = [];
  for (const s of raw.list.slice(0, MAX_SIZES)) { const n = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12) : ''; if (n && !list.includes(n)) list.push(n); }
  if (!list.length) return null;
  return { list, base: list.includes(raw.base) ? raw.base : list[0] };
}

/** Grade rules from a file → { key: rule } with every rule the right length and every number finite. */
export function cleanGrades(raw, sizes, data) {
  const out = {};
  if (!raw || typeof raw !== 'object' || !sizes) return out;
  const n = sizes.list.length * 2, b = sizes.list.indexOf(sizes.base);
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY.test(k) || !Array.isArray(v) || v.length !== n || !v.every((x) => fin(+x))) continue;
    if (k[0] === 'p' && !(data?.pts?.[+k.slice(1)])) continue;
    const r = v.map(Number);
    r[2 * b] = 0; r[2 * b + 1] = 0;   // the base size never moves
    out[k] = r;
  }
  return out;
}

export const sizeIndex = (data, size) => (data.sizes ? data.sizes.list.indexOf(size ?? data.sizes.base) : -1);
export const ruleOf = (data, key) => (data.grades && Array.isArray(data.grades[key]) ? data.grades[key] : null);
export const moveOf = (rule, i) => (rule && i >= 0 && 2 * i + 1 < rule.length ? [rule[2 * i], rule[2 * i + 1]] : [0, 0]);
const r6 = (v) => +(+v).toFixed(6);

/** The piece with one rule set (null / all zero = removed). A copy. */
export function setRule(data, key, rule) {
  const d = structuredClone(data);
  d.grades = d.grades || {};
  if (!rule || rule.every((v) => Math.abs(v) < 1e-12)) delete d.grades[key];
  else d.grades[key] = rule.map(r6);
  return d;
}

/** A rule moving `step` per size: base 0, each size above +step, each below −step. */
export function uniform(sizes, step) {
  const b = sizes.list.indexOf(sizes.base);
  return sizes.list.flatMap((_, i) => [r6((i - b) * step[0]), r6((i - b) * step[1])]);
}

export function flip(rule, axis) { return rule.map((v, i) => r6(((i % 2 === 0) === (axis === 'x') ? -v : v))); }

/** Where each sew line point sits along the sampled outline, and the outline's length. */
function along(pts) {
  const { path, at } = sampled(pts, true);
  const cum = cumulative(path);
  return { d: at.map((s) => cum[Math.max(0, s)]), L: cum[cum.length - 1] };
}

/** Rules for the sew line points strictly between A and B (going round the way the outline runs), in proportion to distance. */
export function proportional(data, keyA, keyB) {
  const ia = /^p(\d+)$/.exec(keyA)?.[1], ib = /^p(\d+)$/.exec(keyB)?.[1];
  const out = {};
  if (ia === undefined || ib === undefined || ia === ib) return out;
  const pts = ptsOf(data.pts), n = pts.length, a = +ia, b = +ib;
  const ra = ruleOf(data, keyA) || zero(data), rb = ruleOf(data, keyB) || zero(data);
  const { d, L } = along(pts);
  const span = ((d[b] - d[a]) % L + L) % L || L;
  for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) {
    const s = (((d[i] - d[a]) % L + L) % L) / span;
    out['p' + i] = ra.map((v, k) => r6(v + (rb[k] - v) * s));
  }
  return out;
}
const zero = (data) => new Array((data.sizes?.list.length || 0) * 2).fill(0);

/** The sew line at a size: ruled points move by their rule; unruled curve points in proportion within their edge. */
export function gradedPts(data, size) {
  const i = sizeIndex(data, size);
  const raw = data.pts || [];
  if (i < 0 || i === sizeIndex(data)) return raw.map((p) => [...p]);
  const pts = ptsOf(raw);
  const move = raw.map((_, k) => { const r = ruleOf(data, 'p' + k); return r ? moveOf(r, i) : null; });
  const { d, L } = along(pts);
  for (const e of edges(pts, true)) {
    // anchors inside this edge: its corners (moved or not) and every ruled point
    const idx = e.idx;
    const anchor = idx.map((k, j) => move[k] !== null || !pts[k].c || j === 0 || j === idx.length - 1);
    for (let j = 1; j + 1 < idx.length; j++) {
      const k = idx[j];
      if (anchor[j]) continue;
      let lo = j - 1; while (!anchor[lo]) lo--;
      let hi = j + 1; while (!anchor[hi]) hi++;
      const kl = idx[lo], kh = idx[hi];
      const ml = move[kl] || [0, 0], mh = move[kh] || [0, 0];
      const dl = d[kl], dk = ((d[k] - dl) % L + L) % L, dh = ((d[kh] - dl) % L + L) % L || L;
      const s = dh > 1e-12 ? dk / dh : 0;
      move[k] = [ml[0] + (mh[0] - ml[0]) * s, ml[1] + (mh[1] - ml[1]) * s];
    }
  }
  return raw.map((p, k) => { const m = move[k] || [0, 0]; return [r6(p[0] + m[0]), r6(p[1] + m[1]), p[2]]; });
}

/** The whole piece at a size (sew line, marks, label); its size name set; no grading left on it. */
export function gradeData(data, size) {
  const i = sizeIndex(data, size);
  const d = structuredClone(data);
  if (i < 0) return d;
  d.pts = gradedPts(data, size);
  const mv = (key, p) => { const m = moveOf(ruleOf(data, key), i); return [r6(p[0] + m[0]), r6(p[1] + m[1]), ...p.slice(2)]; };
  if (d.grain) { d.grain.a = mv('ga', d.grain.a); d.grain.b = mv('gb', d.grain.b); }
  if (d.fold) { d.fold.a = mv('fa', d.fold.a); d.fold.b = mv('fb', d.fold.b); }
  d.lines = (d.lines || []).map((l, li) => ({ ...l, p: l.p.map((p, j) => mv('l' + li + '.' + j, p)) }));
  d.drills = (d.drills || []).map((p, k) => mv('d' + k, p));
  d.buttons = (d.buttons || []).map((p, k) => mv('b' + k, p));
  d.holes = (d.holes || []).map((p, k) => mv('h' + k, p));
  if (d.label) d.label = mv('lab', d.label);
  d.size = data.sizes.list[i];
  delete d.grades;
  delete d.nest;
  return d;
}

/** The piece with a new size range: rules kept by size name, new sizes start at 0 (said by `added`). → { data, added } */
export function withSizes(data, sizes) {
  const d = structuredClone(data);
  const old = data.sizes;
  d.sizes = { list: [...sizes.list], base: sizes.base };
  d.size = sizes.base;
  const added = sizes.list.filter((s) => !old || !old.list.includes(s));
  const grades = {};
  const nb = sizes.list.indexOf(sizes.base);
  for (const [k, r] of Object.entries(data.grades || {})) {
    if (!old) continue;
    // moves measured from the old base; a new base re-measures them from itself
    const ob = old.list.indexOf(sizes.base);
    const shift = ob >= 0 ? moveOf(r, ob) : [0, 0];
    const nr = sizes.list.flatMap((s) => { const i = old.list.indexOf(s); const m = i >= 0 ? moveOf(r, i) : shift; return [r6(m[0] - shift[0]), r6(m[1] - shift[1])]; });
    nr[2 * nb] = 0; nr[2 * nb + 1] = 0;
    if (nr.some((v) => Math.abs(v) > 1e-12)) grades[k] = nr;
  }
  d.grades = grades;
  return { data: d, added };
}

/** A rule as typed for one size after another, "dx,dy" each, measured from the base. → rule | null */
export function parseMove(text) {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*[,; ]\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*$/.exec(String(text ?? ''));
  return m ? [+m[1], +m[2]] : null;
}
