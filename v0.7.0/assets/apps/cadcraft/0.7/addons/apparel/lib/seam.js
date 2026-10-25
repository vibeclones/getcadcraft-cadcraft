/* SPDX-License-Identifier: Apache-2.0 */
/**
 * seam.js — seam allowance (track AP, AP.3): the cut line drawn round a piece's sew line. No DOM.
 *
 * A piece keeps its **sew line** (counter-clockwise; curve.js). Each edge (corner to corner) has its own allowance width,
 * 0 = none on that edge; a piece with no allowance at all is a net pattern and its cut line is the sew line. At each
 * corner where the cut lines of two edges meet, a **corner rule** says how they join (pattern makers' terms):
 *
 *   follow    the two cut lines run on until they meet (the default)
 *   square    the wider allowance is cut off square: the corner is the line at right angles to that edge through the corner
 *   mitre     the corner is cut straight across, from where one cut line ends to where the next begins
 *   reverse   turned back (hems): the wider allowance is folded back over the sew line, so its end follows the
 *             neighbouring edge's cut line mirrored in that sew line
 *
 * Inside corners (the outline turns inward) always trim the two cut lines where they cross; the rule does not apply.
 *
 *   RULES                                  the corner rules, in menu order
 *   cutLine(pts, sa)                       → [{x, y}] closed (first point not repeated) — the cut line
 *   offsetOpen(path, w)                    → [{x, y}] a polyline moved w to its right (outward on a CCW outline)
 *   widthOf(sa, edgeStart) · ruleOf(sa, corner)
 *
 * `sa` = { w: default width, e: { <edge start index>: width }, k: { <corner index>: rule } } | null.
 */

import { edges, edgePath, lineHit } from './curve.js';

export const RULES = ['follow', 'square', 'mitre', 'reverse'];
const FAR = 20;   // a meeting point further than FAR × the wider allowance from the corner is not used (near-parallel edges)

export const widthOf = (sa, i) => {
  if (!sa) return 0;
  const v = sa.e && Object.prototype.hasOwnProperty.call(sa.e, i) ? sa.e[i] : sa.w;
  return Number.isFinite(v) && v > 0 ? v : 0;
};
export const ruleOf = (sa, i) => (sa && sa.k && RULES.includes(sa.k[i]) ? sa.k[i] : 'follow');

const unit = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); return L > 1e-12 ? { x: dx / L, y: dy / L } : null; };
const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
const right = (t) => ({ x: t.y, y: -t.x });
const cross = (a, b) => a.x * b.y - a.y * b.x;
/** Where the infinite lines (p, u) and (q, v) meet. */
const meet = (p, u, q, v) => lineHit(p, add(p, u), q, add(q, v));

/** Drop points closer than eps to the one before (zero-length segments break the joins). */
function clean(path, eps = 1e-9) {
  const out = [];
  for (const p of path) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > eps) out.push({ x: p.x, y: p.y });
  return out;
}

/** A polyline moved w to its right; neighbouring segments joined where their moved lines meet. */
export function offsetOpen(path, w) {
  const p = clean(path);
  if (p.length < 2 || !(w > 0)) return p.map((q) => ({ ...q }));
  const segs = [];
  for (let i = 0; i + 1 < p.length; i++) { const t = unit(p[i], p[i + 1]); if (t) segs.push({ a: p[i], b: p[i + 1], t, n: right(t) }); }
  if (!segs.length) return [p[0]];
  const out = [add(segs[0].a, segs[0].n, w)];
  for (let i = 0; i + 1 < segs.length; i++) {
    const s = segs[i], u = segs[i + 1];
    const a = add(s.b, s.n, w), b = add(u.a, u.n, w);
    const hit = Math.abs(cross(s.t, u.t)) > 1e-9 ? meet(a, s.t, b, u.t) : null;
    if (hit && Math.hypot(hit.x - s.b.x, hit.y - s.b.y) < w * 4) out.push({ x: hit.x, y: hit.y });
    else { out.push(a); out.push(b); }
  }
  const last = segs[segs.length - 1];
  out.push(add(last.b, last.n, w));
  return out;
}

/** The closed path offset by w all round (one smooth edge, no corners). */
function offsetClosed(path, w) {
  const p = clean(path);
  if (p.length > 1 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) < 1e-9) p.pop();
  if (!(w > 0)) return p;
  const n = p.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    const t1 = unit(a, b), t2 = unit(b, c);
    if (!t1 || !t2) continue;
    const q1 = add(b, right(t1), w), q2 = add(b, right(t2), w);
    const hit = Math.abs(cross(t1, t2)) > 1e-9 ? meet(q1, t1, q2, t2) : null;
    out.push(hit && Math.hypot(hit.x - b.x, hit.y - b.y) < w * 4 ? { x: hit.x, y: hit.y } : add(b, right({ x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 }), w));
  }
  return out;
}

/** A closed path without points that lie on the straight line between their neighbours (joins leave some). */
function straighten(c) {
  let out = c.slice();
  for (let pass = 0; pass < 3 && out.length > 3; pass++) {
    const keep = out.filter((p, i) => {
      const a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length];
      const ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-9 || lv < 1e-9) return false;
      return Math.abs(ux * vy - uy * vx) > 1e-9 * lu * lv;
    });
    if (keep.length === out.length) break;
    out = keep;
  }
  return out;
}

/** Inside corner: cut the tail of A and the head of B where they cross. → { a, b } trimmed, or null. */
function trimCross(A, B) {
  const nA = Math.min(A.length - 1, 64), nB = Math.min(B.length - 1, 64);
  for (let i = A.length - 2; i >= A.length - 1 - nA && i >= 0; i--) {
    for (let j = 0; j < nB && j + 1 < B.length; j++) {
      const h = lineHit(A[i], A[i + 1], B[j], B[j + 1]);
      if (h && h.s >= -1e-9 && h.s <= 1 + 1e-9 && h.t >= -1e-9 && h.t <= 1 + 1e-9) return { a: [...A.slice(0, i + 1), { x: h.x, y: h.y }], b: [{ x: h.x, y: h.y }, ...B.slice(j + 1)] };
    }
  }
  return null;
}

/**
 * The join at corner C between the cut line A (ending) and B (starting). wA, wB the edges' widths, tA / tB the sew line's
 * directions arriving at and leaving C. → the points to put between A's last point and B's first (A and B may be trimmed).
 */
function join(C, A, B, wA, wB, tA, tB, rule) {
  const a = A[A.length - 1], b = B[0];
  const uA = A.length > 1 ? unit(A[A.length - 2], a) || tA : tA;   // the cut lines' own directions at the corner
  const uB = B.length > 1 ? unit(b, B[1]) || tB : tB;
  const turn = cross(tA, tB);
  const wMax = Math.max(wA, wB, 1e-9);
  const near = (h) => h && Math.hypot(h.x - C.x, h.y - C.y) <= FAR * wMax;
  if (turn < -1e-9) {   // inside corner: trim where they cross
    const tr = trimCross(A, B);
    if (tr) { A.splice(0, A.length, ...tr.a); B.splice(0, B.length, ...tr.b); return []; }
    const h = meet(a, uA, b, uB);
    return near(h) ? [h] : [];
  }
  if (Math.abs(turn) <= 1e-9 && tA.x * tB.x + tA.y * tB.y > 0) return [];   // straight on: a change of width is a step
  if (rule === 'mitre') return [];
  const hemB = wB >= wA;   // the wider allowance is the one squared off / turned back
  if (rule === 'square') {
    // the narrower cut line runs on to the wider edge's sew line; from there straight out, at right angles, to its cut line
    if (hemB) { const X = meet(a, uA, C, tB); const Y = near(X) && meet(X, right(tB), b, uB); return near(Y) ? [X, Y] : []; }
    const X = meet(b, uB, C, tA); const Y = near(X) && meet(X, right(tA), a, uA); return near(Y) ? [Y, X] : [];
  }
  if (rule === 'reverse') {
    const refl = (v, axis) => { const d = v.x * axis.x + v.y * axis.y; return { x: 2 * d * axis.x - v.x, y: 2 * d * axis.y - v.y }; };
    if (hemB) {
      // A's cut line runs on to B's sew line (the fold), then mirrored in it down to B's cut line
      const F = meet(a, uA, C, tB);
      if (!near(F)) return [];
      const G = meet(F, refl(uA, tB), b, uB);
      return near(G) ? [F, G] : [F];
    }
    const F = meet(b, uB, C, tA);   // B's cut line traced back to A's sew line
    if (!near(F)) return [];
    const G = meet(F, refl({ x: -uB.x, y: -uB.y }, tA), a, uA);
    return near(G) ? [G, F] : [F];
  }
  const h = meet(a, uA, b, uB);   // follow
  return near(h) ? [h] : [];
}

/** The cut line of a piece: its sew line (pts, CCW) with the allowance `sa` round it. */
export function cutLine(pts, sa) {
  const es = edges(pts, true);
  if (!es.length) return [];
  const paths = es.map((e) => edgePath(pts, e, true));
  if (es.length === 1 && es[0].smooth) return offsetClosed(paths[0], widthOf(sa, 0));
  const parts = es.map((e, i) => {
    const w = widthOf(sa, e.start);
    return { w, path: paths[i], cut: w > 0 ? offsetOpen(paths[i], w) : clean(paths[i]) };
  });
  const tIn = (p) => unit(p[p.length - 2] || p[0], p[p.length - 1]) || { x: 1, y: 0 };
  const tOut = (p) => unit(p[0], p[1] || p[0]) || { x: 1, y: 0 };
  const joins = [];
  for (let k = 0; k < parts.length; k++) {
    const A = parts[k], B = parts[(k + 1) % parts.length];
    const corner = es[(k + 1) % parts.length].start;
    const C = { x: pts[corner].x, y: pts[corner].y };
    const pa = clean(A.path), pb = clean(B.path);
    joins[k] = join(C, A.cut, B.cut, A.w, B.w, tIn(pa), tOut(pb), ruleOf(sa, corner));
  }
  const out = [];
  for (let k = 0; k < parts.length; k++) { out.push(...parts[k].cut, ...joins[k]); }
  const c = clean(out);
  if (c.length > 1 && Math.hypot(c[0].x - c[c.length - 1].x, c[0].y - c[c.length - 1].y) <= 1e-9) c.pop();
  return straighten(c);
}
