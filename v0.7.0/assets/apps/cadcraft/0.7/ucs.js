/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ucs.js — the user coordinate system of a drawing (0.5 DR.8). DOM-free.
 *
 * A UCS here is 2D: an origin and the angle of its X axis, `{ x, y, ang }` in world units and radians; `null` is the world
 * itself. It changes how points are typed and read (x,y and d<a are in the UCS), how ortho, polar tracking, the grid and
 * the crosshair line up, and which way new text and horizontal / vertical dimensions run. It never changes the drawing:
 * objects stay in world coordinates, and setting a UCS (or turning the view with PLAN) is not an edit — no undo step, no
 * unsaved mark. The doc keeps `doc.ucs` (current), `doc.ucsPrev` (UCS Previous, this session) and `doc.ucsNamed`
 * ([{ name, x, y, ang }], UCS NA Save/Restore; the file's UCS table, cad-files).
 *
 *   toWorld(u, p) / toUcs(u, p)        a point between the UCS and the world
 *   vecToWorld(u, v) / vecToUcs(u, v)  a direction (no origin)
 *   angToWorld(u, a) / angToUcs(u, a)  an angle (radians) measured from the UCS X axis / the world X axis
 *   cleanUcs(v)                        untrusted data (a file, LISP, the clipboard) → { x, y, ang } | null (null = world)
 *   ucsData(v)                         the same as a record, the world included ({ x: 0, y: 0, ang: 0 })
 *   threePoint(o, px)                  origin + a point on the positive X axis → UCS | null
 *   fromObject(e, pick, blocks)        UCS Object: origin and X axis taken from an object (null when it has none)
 *   setUcs(doc, u, { remember })       make u current (the old one goes on the Previous stack); → u
 *   activeUcs(doc)                     the UCS in force where the doc is open (model only; sheets are paper coordinates)
 *   UCS_NAME_RE                        the names UCS NA accepts
 */
import { normAngle, dist, prims, primParam, primPoint, EPS, TAU } from './geom.js';

export const UCS_NAME_RE = /^[^<>/\\":;?*|,=`]{1,255}$/;

const isWorld = (u) => { if (!u) return true; const a = normAngle(u.ang); return Math.abs(u.x) < 1e-12 && Math.abs(u.y) < 1e-12 && Math.min(a, TAU - a) < 1e-12; };

/** null for the world; else the UCS with its angle in [0, 2π). */
export function cleanUcs(v) {
  if (!v || typeof v !== 'object') return null;
  const x = +v.x, y = +v.y, ang = +v.ang;
  if (![x, y, ang].every(Number.isFinite) || Math.abs(x) > 1e15 || Math.abs(y) > 1e15) return null;
  const u = { x, y, ang: normAngle(ang) };
  return isWorld(u) ? null : u;
}

export function vecToWorld(u, v) {
  if (!u) return { x: v.x, y: v.y };
  const c = Math.cos(u.ang), s = Math.sin(u.ang);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
export function vecToUcs(u, v) {
  if (!u) return { x: v.x, y: v.y };
  const c = Math.cos(u.ang), s = Math.sin(u.ang);
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c };
}
export function toWorld(u, p) {
  if (!u) return { x: p.x, y: p.y };
  const w = vecToWorld(u, p);
  return { x: u.x + w.x, y: u.y + w.y };
}
export function toUcs(u, p) {
  if (!u) return { x: p.x, y: p.y };
  return vecToUcs(u, { x: p.x - u.x, y: p.y - u.y });
}
export const angToWorld = (u, a) => (u ? a + u.ang : a);
export const angToUcs = (u, a) => (u ? a - u.ang : a);

/** A UCS record as data (the world included: { x: 0, y: 0, ang: 0 }), or null when it is not one. */
export function ucsData(v) {
  if (!v || typeof v !== 'object') return null;
  const x = +v.x, y = +v.y, ang = +v.ang;
  return [x, y, ang].every(Number.isFinite) && Math.abs(x) <= 1e15 && Math.abs(y) <= 1e15 ? { x, y, ang: normAngle(ang) } : null;
}

/** UCS 3point (in 2D): the origin and a point on the positive X axis. */
export function threePoint(o, px) {
  if (dist(o, px) < EPS) return null;
  return cleanUcs({ x: o.x, y: o.y, ang: Math.atan2(px.y - o.y, px.x - o.x) }) || { x: 0, y: 0, ang: 0 };
}

/**
 * UCS Object, as AutoCAD sets it for 2D objects: a line from its end nearer the pick, X along it; an arc or circle at its
 * centre, X toward the pick (an arc: its start); a polyline from the start of the segment picked, X along it; text, a block
 * reference and a point at their insertion point, X along their rotation; a construction line at its point, X along it.
 */
export function fromObject(e, pick = null, blocks = null) {
  if (!e) return null;
  const mk = (x, y, ang) => cleanUcs({ x, y, ang }) || { x: 0, y: 0, ang: 0 };
  switch (e.type) {
    case 'line': {
      const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
      if (dist(a, b) < EPS) return null;
      return pick && dist(pick, b) < dist(pick, a) ? mk(b.x, b.y, Math.atan2(a.y - b.y, a.x - b.x)) : mk(a.x, a.y, Math.atan2(b.y - a.y, b.x - a.x));
    }
    case 'circle': return mk(e.cx, e.cy, pick ? Math.atan2(pick.y - e.cy, pick.x - e.cx) : 0);
    case 'arc': return mk(e.cx, e.cy, e.a0);
    case 'poly': {
      const ps = prims(e, blocks);
      if (!ps.length) return null;
      let best = 0, bd = Infinity;
      if (pick) ps.forEach((q, i) => { const d = dist(primPoint(q, primParam(q, pick)), pick); if (d < bd) { bd = d; best = i; } });
      const q = ps[best], s = primPoint(q, q.rev ? 1 : 0), t = primPoint(q, q.rev ? 0.999 : 0.001);
      return mk(s.x, s.y, Math.atan2(t.y - s.y, t.x - s.x));
    }
    case 'text': case 'insert': return mk(e.x, e.y, e.rot || 0);
    case 'point': return mk(e.x, e.y, 0);
    case 'xline': case 'ray': return mk(e.x, e.y, Math.atan2(e.dy, e.dx));
    case 'dim': return e.p1 ? mk(e.p1.x, e.p1.y, e.rot || 0) : null;
    default: return null;
  }
}

/** The UCS that applies where the doc is open: the model's (a viewport entered too); sheets work in paper coordinates. */
export const activeUcs = (doc) => (doc && doc.inModel ? doc.ucs || null : null);

/** Make u the current UCS (null = world). The one it replaces goes on the Previous stack (≤ 10) unless `remember` is false. */
export function setUcs(doc, u, { remember = true } = {}) {
  const next = cleanUcs(u);
  if (remember) {
    doc.ucsPrev ||= [];
    doc.ucsPrev.push(doc.ucs || null);
    if (doc.ucsPrev.length > 10) doc.ucsPrev.shift();
  }
  doc.ucs = next;
  return next;
}
