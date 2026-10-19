/* SPDX-License-Identifier: Apache-2.0 */
/**
 * collide.js — keep solids from passing through each other while they move. No DOM, no three.js.
 *
 *   const c = collider(sc, { moving(o, t), ignore(o, t) })   sc = sceneOf(model) before the move
 *   c.clamp(delta) → { delta, hit }                          the longest part of a straight move that
 *                                                            stays clear (hit = it was shortened)
 *
 * moving(o, 'e'|'f') — the faces and edges that travel rigidly (a selection, the groups in it, a pushed face).
 * ignore(o, 'e'|'f') — geometry that is neither in the way nor travelling: loose geometry stuck to what moves
 *                      (it stretches), the pushed face's own solid.
 * Everything else is in the way. Touching is fine — faces lying on each other, edges meeting along a face,
 * a box set down on a box — only passing into the inside counts: an edge crossing a face's interior, or a point
 * of one solid's face inside the other (three rays agree). Things already overlapping when the move starts are
 * left out, so they can still be pulled apart. The path is sampled (finer for thin things) and the first contact
 * is found by bisection, so a fast move does not jump through a thin wall. Translations only: rotate and scale
 * are not checked.
 */
import { add, sub, mul, dot, cross, len, norm } from './vec.js';

const TOL = 1e-5;           // 10 µm: closer than this counts as touching
const MAX_STEPS = 160;

export function collider(sc, { moving, ignore = () => false }) {
  const mov = { faces: [], edges: [] };
  const objs = new Map();   // key → { faces, edges }
  const obj = (o) => {
    const k = o.path.join('/');
    if (!objs.has(k)) objs.set(k, { key: k, faces: [], edges: [] });
    return objs.get(k);
  };
  for (const f of sc.faces) {
    if (moving(f, 'f')) mov.faces.push(prepFace(f));
    else if (!ignore(f, 'f')) obj(f).faces.push(prepFace(f));
  }
  for (const e of sc.edges) {
    if (moving(e, 'e')) mov.edges.push({ a: e.a, b: e.b });
    else if (!ignore(e, 'e')) obj(e).edges.push({ a: e.a, b: e.b });
  }
  let statics = [...objs.values()].filter((o) => o.faces.length || o.edges.length);
  for (const o of statics) o.bb = bboxOf(o);
  mov.bb = bboxOf(mov);
  const empty = !mov.faces.length && !mov.edges.length;
  // already overlapping at the start: not in the way
  if (!empty) statics = statics.filter((o) => !hits(mov, o, [0, 0, 0]));
  const size = (bb) => (bb ? Math.min(...[0, 1, 2].map((k) => Math.max(bb.max[k] - bb.min[k], 0)).filter((v) => v > TOL * 10)) : Infinity);
  const thin = Math.max(0.005, Math.min(size(mov.bb), ...statics.map((o) => size(o.bb))));

  function blocked(d) {
    for (const o of statics) if (hits(mov, o, d)) return true;
    return false;
  }
  return {
    empty,
    clamp(delta) {
      if (empty || !statics.length || len(delta) <= TOL) return { delta, hit: false };
      const steps = Math.min(MAX_STEPS, Math.max(4, Math.ceil(len(delta) / (thin / 2))));
      let lo = 0, hi = null;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (blocked(mul(delta, t))) { hi = t; break; }
        lo = t;
      }
      if (hi === null) return { delta, hit: false };
      for (let k = 0; k < 24; k++) {
        const m = (lo + hi) / 2;
        if (blocked(mul(delta, m))) hi = m; else lo = m;
      }
      return { delta: mul(delta, lo), hit: true };
    },
  };
}

function prepFace(f) {
  // the face's outline (and holes) = triangle sides used once
  const seen = new Map();
  const k = (p) => p.map((x) => Math.round(x / TOL)).join(',');
  for (const [a, b, c] of f.tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) {
    const key = [k(p), k(q)].sort().join('|');
    if (seen.has(key)) seen.delete(key); else seen.set(key, [p, q]);
  }
  return { tris: f.tris, n: f.n, d: f.plane.d, bnd: [...seen.values()], pts: f.tris.map(([a, b, c]) => mul(add(add(a, b), c), 1 / 3)) };
}

function bboxOf(o) {
  let bb = null;
  const put = (p) => {
    if (!bb) bb = { min: p.slice(), max: p.slice() };
    for (let i = 0; i < 3; i++) { if (p[i] < bb.min[i]) bb.min[i] = p[i]; if (p[i] > bb.max[i]) bb.max[i] = p[i]; }
  };
  for (const f of o.faces) for (const t of f.tris) for (const p of t) put(p);
  for (const e of o.edges) { put(e.a); put(e.b); }
  return bb;
}

/** Do the moving pieces, shifted by d, pass into static object o? */
function hits(mov, o, d) {
  if (!mov.bb || !o.bb) return false;
  for (let i = 0; i < 3; i++) if (mov.bb.min[i] + d[i] >= o.bb.max[i] - TOL || mov.bb.max[i] + d[i] <= o.bb.min[i] + TOL) return false;
  const neg = mul(d, -1);
  // an edge through the inside of a face, either way round
  for (const e of mov.edges) for (const f of o.faces) if (crosses(add(e.a, d), add(e.b, d), f, null)) return true;
  for (const e of o.edges) for (const f of mov.faces) if (crosses(e.a, e.b, f, d)) return true;
  // a point of one inside the other (one box wholly inside another, or sliding in flush)
  for (const f of mov.faces) for (const p of f.pts) if (inside(add(p, d), o.faces, null)) return true;
  for (const f of o.faces) for (const p of f.pts) if (inside(add(p, neg), mov.faces, null)) return true;
  return false;
}

/** Segment p–q crosses face f's interior (f shifted by s): ends strictly on both sides, crossing point
 * inside the face and clear of its outline. */
function crosses(p, q, f, s) {
  const dd = s ? f.d + dot(f.n, s) : f.d;
  const sp = dot(f.n, p) - dd, sq = dot(f.n, q) - dd;
  if (!((sp > TOL && sq < -TOL) || (sp < -TOL && sq > TOL))) return false;
  const t = sp / (sp - sq);
  let x = add(p, mul(sub(q, p), t));
  if (s) x = sub(x, s);                       // test against the unshifted face
  if (!inFace(x, f)) return false;
  for (const [a, b] of f.bnd) if (segDist(x, a, b) <= TOL) return false;
  return true;
}

function inFace(x, f) {
  for (const [a, b, c] of f.tris) {
    const n = cross(sub(b, a), sub(c, a));
    const nn = dot(n, n);
    if (nn < 1e-24) continue;
    const u = dot(cross(sub(c, b), sub(x, b)), n) / nn, v = dot(cross(sub(a, c), sub(x, c)), n) / nn;
    if (u >= -1e-9 && v >= -1e-9 && 1 - u - v >= -1e-9) return true;
  }
  return false;
}

function segDist(x, a, b) {
  const ab = sub(b, a), l2 = dot(ab, ab);
  const t = l2 ? Math.max(0, Math.min(1, dot(sub(x, a), ab) / l2)) : 0;
  return len(sub(x, add(a, mul(ab, t))));
}

const RAYS = [norm([0.5773, 0.5774, 0.5775]), norm([-0.6123, 0.2189, 0.7597]), norm([0.1931, -0.8972, -0.3973])];
/** Is p inside the closed surface made of faces? Three rays must all cross it an odd number of times;
 * a point on the surface is not inside. */
function inside(p, faces) {
  for (const r of RAYS) {
    let n = 0;
    for (const f of faces) {
      let crossed = false;
      for (const [a, b, c] of f.tris) {
        const t = rayTriT(p, r, a, b, c);
        if (t === null) continue;
        if (t <= TOL) return false;
        crossed = true;
        break;
      }
      if (crossed) n++;
    }
    if (n % 2 === 0) return false;
  }
  return true;
}

function rayTriT(o, d, a, b, c) {
  const e1 = sub(b, a), e2 = sub(c, a), pv = cross(d, e2), det = dot(e1, pv);
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det, s = sub(o, a), u = dot(s, pv) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = cross(s, e1), v = dot(d, q) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = dot(e2, q) * inv;
  return t >= -TOL ? Math.max(t, 0) : null;
}
