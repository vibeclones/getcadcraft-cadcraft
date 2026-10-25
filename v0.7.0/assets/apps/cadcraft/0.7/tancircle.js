/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tancircle.js — circles tangent to picked objects (0.5 DR.1 CIRCLE TTR, DR.2 Tan Tan Tan). DOM-free.
 *
 *   curveAt(e, pick, blocks) → the straight line or full circle under the pick: { k: 'L', x, y, dx, dy } (unit direction)
 *                              | { k: 'C', cx, cy, r }, or null (text, points …). A polyline gives the segment picked; a
 *                              block reference the piece inside it; an arc its whole circle.
 *   circleTTR(a, pa, b, pb, r) → { cx, cy, r } | null   tangent to a and b with radius r: the centre is where a and b,
 *                              each offset by r, cross; of every such circle the one whose touch points are nearest the
 *                              picks (as AutoCAD chooses)
 *   circleTTT(a, pa, b, pb, c, pc) → { cx, cy, r } | null   tangent to three (Apollonius: up to 8 for circles, 4 for three
 *                              lines), the one whose touch points are nearest the picks
 *   touchPoint(o, circle)      → where the circle touches o
 */
import { prims, primParam, primPoint, dist, EPS, FAR } from './geom.js';

export function curveAt(e, pick, blocks) {
  if (!e) return null;
  let best = null, bd = Infinity;
  for (const q of prims(e, blocks)) {
    if (q.box) continue;
    const d = dist(primPoint(q, primParam(q, pick)), pick);
    if (d < bd) { bd = d; best = q; }
  }
  if (!best) return null;
  if (best.k === 'L') {
    const L = Math.hypot(best.x2 - best.x1, best.y2 - best.y1);
    return L > EPS ? { k: 'L', x: best.x1, y: best.y1, dx: (best.x2 - best.x1) / L, dy: (best.y2 - best.y1) / L } : null;
  }
  return best.r > EPS ? { k: 'C', cx: best.cx, cy: best.cy, r: best.r } : null;
}

export function touchPoint(o, c) {
  if (o.k === 'L') { const t = (c.cx - o.x) * o.dx + (c.cy - o.y) * o.dy; return { x: o.x + o.dx * t, y: o.y + o.dy * t }; }
  const d = Math.hypot(c.cx - o.cx, c.cy - o.cy);
  if (d < EPS) return { x: o.cx + o.r, y: o.cy };
  const k = (c.cx - o.cx) / d, m = (c.cy - o.cy) / d;
  // the touch point lies on o, on the line through both centres, on the side of c (outside) or away (o inside c)
  const s = d > o.r || Math.abs(d - (o.r - c.r)) < Math.abs(d - (o.r + c.r)) ? 1 : -1;
  return { x: o.cx + k * o.r * s, y: o.cy + m * o.r * s };
}

/** Is circle c tangent to o (within a relative tolerance)? */
function tangent(o, c, tol) {
  if (o.k === 'L') return Math.abs(Math.abs((c.cx - o.x) * o.dy - (c.cy - o.y) * o.dx) - c.r) <= tol;
  const d = Math.hypot(c.cx - o.cx, c.cy - o.cy);
  return Math.abs(d - (o.r + c.r)) <= tol || Math.abs(d - Math.abs(o.r - c.r)) <= tol;
}

// ---- offsets and their crossings (TTR) ----
function offsets(o, r) {
  if (o.k === 'L') {
    const nx = -o.dy, ny = o.dx;
    return [1, -1].map((s) => ({ k: 'L', x: o.x + nx * r * s, y: o.y + ny * r * s, dx: o.dx, dy: o.dy }));
  }
  return [o.r + r, Math.abs(o.r - r)].filter((R) => R > EPS).map((R) => ({ k: 'C', cx: o.cx, cy: o.cy, r: R }));
}
function cross(a, b) {
  if (a.k === 'L' && b.k === 'L') {
    const den = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(den) < 1e-12) return [];
    const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / den;
    return [{ x: a.x + a.dx * t, y: a.y + a.dy * t }];
  }
  if (a.k === 'C' && b.k === 'L') return cross(b, a);
  if (a.k === 'L') {   // line × circle
    const fx = a.x - b.cx, fy = a.y - b.cy, B = fx * a.dx + fy * a.dy, C = fx * fx + fy * fy - b.r * b.r, D = B * B - C;
    if (D < -1e-12 * Math.max(1, b.r * b.r)) return [];
    const s = Math.sqrt(Math.max(0, D));
    return (s < 1e-12 ? [-B] : [-B + s, -B - s]).map((t) => ({ x: a.x + a.dx * t, y: a.y + a.dy * t }));
  }
  const dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy);
  if (d < EPS || d > a.r + b.r + 1e-9 * (a.r + b.r) || d < Math.abs(a.r - b.r) - 1e-9 * (a.r + b.r)) return [];
  const l = (a.r * a.r - b.r * b.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a.r * a.r - l * l));
  const mx = a.cx + dx * l / d, my = a.cy + dy * l / d;
  return h < 1e-12 ? [{ x: mx, y: my }] : [{ x: mx - dy * h / d, y: my + dx * h / d }, { x: mx + dy * h / d, y: my - dx * h / d }];
}
const scale = (...os) => Math.max(1, ...os.map((o) => (o.k === 'L' ? Math.hypot(o.x, o.y) : Math.hypot(o.cx, o.cy) + o.r)));

function nearestToPicks(cands, list) {
  let best = null, bd = Infinity;
  for (const c of cands) {
    const sc = list.reduce((s, [o, p]) => s + dist(touchPoint(o, c), p), 0);
    if (sc < bd - 1e-12) { bd = sc; best = c; }
  }
  return best;
}

export function circleTTR(a, pa, b, pb, r) {
  if (!a || !b || !(r > EPS)) return null;
  const tol = 1e-7 * scale(a, b, { k: 'C', cx: 0, cy: 0, r });
  const cands = [];
  for (const oa of offsets(a, r)) for (const ob of offsets(b, r)) for (const q of cross(oa, ob)) {
    const c = { cx: q.x, cy: q.y, r };
    if (Math.abs(q.x) < FAR && Math.abs(q.y) < FAR && tangent(a, c, tol) && tangent(b, c, tol)) cands.push(c);
  }
  return nearestToPicks(cands, [[a, pa], [b, pb]]);
}

// ---- three tangents (TTT): each object's equation with a side sign, solved by Newton from several starts ----
function residual(o, s, x, y, r) {
  if (o.k === 'L') return (x - o.x) * o.dy - (y - o.y) * o.dx - s * r;   // signed distance = ±r
  return Math.hypot(x - o.cx, y - o.cy) - (o.r + s * r);                   // s = 1 outside, −1 inside (or around: r − R below)
}
function residual2(o, s, x, y, r) { return o.k === 'C' && s === -1 ? Math.hypot(x - o.cx, y - o.cy) - Math.abs(o.r - r) : residual(o, s, x, y, r); }
function solve3(os, ss, x, y, r) {
  for (let it = 0; it < 60; it++) {
    const F = os.map((o, i) => residual2(o, ss[i], x, y, r));
    if (F.every((f) => Math.abs(f) < 1e-13 * Math.max(1, Math.abs(x), Math.abs(y), r))) break;
    const h = 1e-7 * Math.max(1, Math.abs(x), Math.abs(y), Math.abs(r));
    const J = os.map((o, i) => [
      (residual2(o, ss[i], x + h, y, r) - F[i]) / h,
      (residual2(o, ss[i], x, y + h, r) - F[i]) / h,
      (residual2(o, ss[i], x, y, r + h) - F[i]) / h,
    ]);
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(J);
    if (!Number.isFinite(D) || Math.abs(D) < 1e-18) return null;
    const col = (k) => J.map((row, i) => row.map((v, j) => (j === k ? -F[i] : v)));
    let dx = det(col(0)) / D, dy = det(col(1)) / D, dr = det(col(2)) / D;
    const step = Math.hypot(dx, dy, dr), lim = Math.max(1, Math.abs(r)) * 2;
    if (step > lim) { dx *= lim / step; dy *= lim / step; dr *= lim / step; }
    x += dx; y += dy; r += dr;
    if (!Number.isFinite(x + y + r)) return null;
  }
  return r > EPS ? { cx: x, cy: y, r } : null;
}
export function circleTTT(a, pa, b, pb, c, pc) {
  const os = [a, b, c];
  if (os.some((o) => !o)) return null;
  const tol = 1e-7 * scale(a, b, c);
  const seeds = [];
  const P = [pa, pb, pc], m = { x: (pa.x + pb.x + pc.x) / 3, y: (pa.y + pb.y + pc.y) / 3 };
  const spread = Math.max(1e-6, ...P.map((p) => dist(p, m)));
  for (const k of [0.5, 1, 2]) for (let i = 0; i < 6; i++) { const t = i * Math.PI / 3; seeds.push([m.x + Math.cos(t) * spread * (k - 0.5), m.y + Math.sin(t) * spread * (k - 0.5), spread * k * 0.6]); }
  const found = [];
  for (const s0 of [1, -1]) for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
    for (const [x, y, r] of seeds) {
      const sol = solve3(os, [s0, s1, s2], x, y, r);
      if (!sol || !os.every((o) => tangent(o, sol, tol * 10))) continue;
      if (!found.some((f) => Math.abs(f.cx - sol.cx) + Math.abs(f.cy - sol.cy) + Math.abs(f.r - sol.r) < tol * 100)) found.push(sol);
    }
  }
  return nearestToPicks(found, [[a, pa], [b, pb], [c, pc]]);
}
