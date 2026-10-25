/* SPDX-License-Identifier: Apache-2.0 */
/**
 * curve.js — pattern outlines as pattern makers and the DXF-AAMA format keep them (docs/APPAREL-DXF.md §4): a list of
 * points, each a **corner** (c = 0, a turn point) or a **curve point** (c = 1). Curves run smooth through curve points
 * (centripetal Catmull–Rom), straight between two corners. An **edge** (a seam) is the run from one corner to the next;
 * an outline with no corner at all is one closed smooth edge starting at point 0. No DOM, no imports.
 *
 *   P(x, y, c) / ptsOf(raw)          point arrays [x, y, c] ↔ {x, y, c}
 *   corners(pts)                     indices of the corners (every edge starts at one)
 *   edges(pts, closed)               → [{ start, end, idx: [point indices from start to end] }]
 *   edgePath(pts, edge, closed)      → [{x, y}] sampled from the edge's first point to its last
 *   sampled(pts, closed)             → { path: [{x, y}], at: [sample index of every point] } — the whole outline
 *   length(path) · cumulative(path) · pointAt(path, d) → {x, y, tx, ty, i} · nearest(path, p) → {d, dist, x, y}
 *   area(path) (signed, CCW +) · centroid(path) · bounds(path) · orientCCW(pts)
 *   lineHit(a, b, c, d) · outward(tx, ty) (the outward normal of a CCW outline)
 */

export const STEPS = 16;   // samples per curved span (a span = between two neighbouring points)

export const P = (x, y, c = 0) => [x, y, c ? 1 : 0];
export const ptsOf = (raw) => (Array.isArray(raw) ? raw.map((p) => ({ x: +p[0], y: +p[1], c: p[2] ? 1 : 0 })) : []);
export const rawOf = (pts) => pts.map((p) => [p.x, p.y, p.c ? 1 : 0]);

/** Indices of the corners. */
export function corners(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) if (!pts[i].c) out.push(i);
  return out;
}

/** Edges: corner to next corner (closed: wrapping round; open: the ends count as corners). */
export function edges(pts, closed = true) {
  const n = pts.length;
  if (n < 2) return [];
  if (!closed) {
    const cs = corners(pts).filter((i) => i > 0 && i < n - 1);
    const stops = [0, ...cs, n - 1];
    const out = [];
    for (let k = 0; k + 1 < stops.length; k++) { const idx = []; for (let i = stops[k]; i <= stops[k + 1]; i++) idx.push(i); out.push({ start: stops[k], end: stops[k + 1], idx }); }
    return out;
  }
  const cs = corners(pts);
  if (!cs.length) { const idx = []; for (let i = 0; i <= n; i++) idx.push(i % n); return [{ start: 0, end: 0, idx, smooth: true }]; }
  const out = [];
  for (let k = 0; k < cs.length; k++) {
    const a = cs[k], b = cs[(k + 1) % cs.length];
    const idx = [a];
    let i = a;
    do { i = (i + 1) % n; idx.push(i); } while (i !== b);
    out.push({ start: a, end: b, idx });
  }
  return out;
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dst = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** One centripetal Catmull–Rom span p1 → p2 (p0, p3 its neighbours), `steps` samples after p1 (p2 included). */
function crSpan(p0, p1, p2, p3, steps) {
  const tj = (ti, a, b) => ti + Math.max(Math.sqrt(dst(a, b)), 1e-9);
  const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const t = t1 + (t2 - t1) * (s / steps);
    const L = (pa, pb, ta, tb) => { const k = (tb - ta) < 1e-12 ? 0 : (t - ta) / (tb - ta); return { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k }; };
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
    const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    out.push(L(B1, B2, t1, t2));
  }
  out[out.length - 1] = { x: p2.x, y: p2.y };
  return out;
}

/** The sampled path of one edge (closed outline, or one run of an open line). */
export function edgePath(pts, edge, closed = true) {
  const n = pts.length;
  const at = (i) => pts[((i % n) + n) % n];
  const idx = edge.idx;
  const out = [{ x: pts[idx[0]].x, y: pts[idx[0]].y }];
  for (let k = 0; k + 1 < idx.length; k++) {
    const p1 = pts[idx[k]], p2 = pts[idx[k + 1]];
    const curved = idx.length > 2 && (p1.c || p2.c || edge.smooth);
    if (!curved) { out.push({ x: p2.x, y: p2.y }); continue; }
    // neighbours inside the edge; at a corner end, reflect (a free end: the curve leaves the corner pointing at the next point)
    let p0, p3;
    if (k > 0) p0 = pts[idx[k - 1]];
    else if (edge.smooth && closed) p0 = at(idx[0] - 1);
    else p0 = { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    if (k + 2 < idx.length) p3 = pts[idx[k + 2]];
    else if (edge.smooth && closed) p3 = at(idx[k + 1] + 1);
    else p3 = { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    out.push(...crSpan(p0, p1, p2, p3, STEPS));
  }
  return out;
}

/** The whole outline sampled; at[i] = the sample index of point i (closed: the last sample repeats the first point). */
export function sampled(pts, closed = true) {
  const es = edges(pts, closed);
  const path = [];
  const at = new Array(pts.length).fill(-1);
  for (const e of es) {
    const p = edgePath(pts, e, closed);
    const base = path.length ? path.length - 1 : 0;
    if (path.length) p.shift();
    let s = base;
    // the points of the edge sit at the span boundaries: STEPS samples per curved span, 1 per straight one
    for (let k = 0; k < e.idx.length; k++) {
      if (at[e.idx[k]] < 0 || (k === 0 && path.length === 0)) at[e.idx[k]] = s;
      if (k + 1 < e.idx.length) { const curved = e.idx.length > 2 && (pts[e.idx[k]].c || pts[e.idx[k + 1]].c || e.smooth); s += curved ? STEPS : 1; }
    }
    path.push(...p);
  }
  if (!path.length && pts.length) path.push({ x: pts[0].x, y: pts[0].y });
  return { path, at };
}

export function length(path) {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += dst(path[i - 1], path[i]);
  return L;
}

export function cumulative(path) {
  const c = [0];
  for (let i = 1; i < path.length; i++) c.push(c[i - 1] + dst(path[i - 1], path[i]));
  return c;
}

/** The point at distance d along a path (clamped), with the unit tangent there. */
export function pointAt(path, d, cum = cumulative(path)) {
  if (path.length < 2) return { x: path[0]?.x ?? 0, y: path[0]?.y ?? 0, tx: 1, ty: 0, i: 0 };
  const L = cum[cum.length - 1];
  const t = Math.min(Math.max(d, 0), L);
  let i = 1;
  while (i < cum.length - 1 && cum[i] < t) i++;
  const a = path[i - 1], b = path[i];
  const seg = cum[i] - cum[i - 1];
  const k = seg > 1e-12 ? (t - cum[i - 1]) / seg : 0;
  const len = Math.max(dst(a, b), 1e-12);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, tx: (b.x - a.x) / len, ty: (b.y - a.y) / len, i: i - 1 };
}

/** The nearest point of a path to p: its distance along the path and from p. */
export function nearest(path, p) {
  let best = { d: 0, dist: Infinity, x: path[0]?.x ?? 0, y: path[0]?.y ?? 0, i: 0 };
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const v = sub(b, a), L2 = v.x * v.x + v.y * v.y;
    const k = L2 > 1e-18 ? Math.min(1, Math.max(0, ((p.x - a.x) * v.x + (p.y - a.y) * v.y) / L2)) : 0;
    const q = { x: a.x + v.x * k, y: a.y + v.y * k };
    const dd = dst(p, q);
    if (dd < best.dist) best = { d: run + Math.sqrt(L2) * k, dist: dd, x: q.x, y: q.y, i: i - 1 };
    run += Math.sqrt(L2);
  }
  return best;
}

/** Signed area (counter-clockwise positive) of a closed path. */
export function area(path) {
  let a = 0;
  for (let i = 0, n = path.length; i < n; i++) { const p = path[i], q = path[(i + 1) % n]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

export function centroid(path) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = path.length; i < n; i++) {
    const p = path[i], q = path[(i + 1) % n], k = p.x * q.y - q.x * p.y;
    a += k; cx += (p.x + q.x) * k; cy += (p.y + q.y) * k;
  }
  if (Math.abs(a) < 1e-12) { const b = bounds(path); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function bounds(path) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of path) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { minX, minY, maxX, maxY };
}

/** The same points, counter-clockwise (pieces are kept CCW so "outward" is always to the right of travel). */
export function orientCCW(pts) {
  if (pts.length < 3) return pts;
  const { path } = sampled(pts, true);
  if (area(path) >= 0) return pts;
  return [pts[0], ...pts.slice(1).reverse()];
}

/** Where segments ab and cd cross: { x, y, s, t } (s along ab, t along cd, both 0…1 inside) | null when parallel. */
export function lineHit(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-14) return null;
  const q = sub(c, a);
  const u = (q.x * s.y - q.y * s.x) / den, v = (q.x * r.y - q.y * r.x) / den;
  return { x: a.x + r.x * u, y: a.y + r.y * u, s: u, t: v };
}

/** The outward normal of a CCW outline at a tangent (right of travel). */
export const outward = (tx, ty) => ({ x: ty, y: -tx });
