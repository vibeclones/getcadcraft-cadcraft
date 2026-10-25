/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tracking.js — polar tracking and object snap tracking: where the pointer lines up with a base point or with
 * snap points the pointer has rested on. No DOM: bin/test-cadcraft.mjs runs it in Node. (0.4 C11; owner: cad-draw.)
 *
 *   POLAR_INCREMENTS                  the angle steps offered (degrees), as AutoCAD's
 *   polarTrack(base, cur, opt)        → { x, y, ang, d, ray } | null — the pointer pulled onto the nearest ray from the
 *                                       base at a multiple of opt.inc (degrees), when it is within opt.tol world units
 *   trackPoint(acquired, cur, opt)    → { x, y, rays: [{ from, ang }], kind: 'one' | 'two' } | null — the pointer on a
 *                                       ray through an acquired point (horizontal and vertical, or every polar angle
 *                                       with opt.polarAll), or where two rays cross (then both are given)
 * opt: { inc (deg), tol (world units: the screen tolerance ÷ zoom), base (for polar rays in trackPoint), polarAll,
 *       start (radians: where the angles count from — the UCS X axis, 0.5 DR.8) }
 */

export const POLAR_INCREMENTS = Object.freeze([90, 45, 30, 22.5, 18, 15, 10, 5]);

const RAD = Math.PI / 180;

/** The point on the ray from p at angle a (radians) nearest q, and how far q is from it; only ahead of p. */
function onRay(p, a, q) {
  const ux = Math.cos(a), uy = Math.sin(a);
  const t = (q.x - p.x) * ux + (q.y - p.y) * uy;
  if (t <= 0) return null;
  const x = p.x + ux * t, y = p.y + uy * t;
  return { x, y, t, off: Math.hypot(q.x - x, q.y - y) };
}

/** The angles (radians) of the rays at every multiple of inc degrees, counted from `start` (the UCS X axis, DR.8). */
function rayAngles(inc, start = 0) {
  const n = Math.max(1, Math.round(360 / inc)), out = [];
  for (let i = 0; i < n; i++) out.push(start + i * inc * RAD);
  return out;
}

export function polarTrack(base, cur, { inc = 90, tol = 1, start = 0 } = {}) {
  if (!base || !cur) return null;
  let best = null;
  for (const a of rayAngles(inc, start)) {
    const r = onRay(base, a, cur);
    if (r && r.off <= tol && (!best || r.off < best.off)) best = { ...r, ang: a };
  }
  if (!best) return null;
  return { x: best.x, y: best.y, ang: best.ang, d: best.t, ray: { from: base, ang: best.ang } };
}

export function trackPoint(acquired, cur, { inc = 90, tol = 1, base = null, polarAll = false, start = 0 } = {}) {
  if (!cur || !acquired?.length) return null;
  const angles = polarAll ? rayAngles(inc, start) : rayAngles(90, start);
  const rays = [];
  for (const p of acquired) for (const a of angles) rays.push({ from: p, ang: a });
  if (base && polarAll) for (const a of rayAngles(inc, start)) rays.push({ from: base, ang: a });
  // where two rays from different points cross near the pointer wins
  let best = null;
  for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) {
    const A = rays[i], B = rays[j];
    if (A.from === B.from) continue;
    const ax = Math.cos(A.ang), ay = Math.sin(A.ang), bx = Math.cos(B.ang), by = Math.sin(B.ang);
    const den = ax * by - ay * bx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((B.from.x - A.from.x) * by - (B.from.y - A.from.y) * bx) / den;
    const s = ((B.from.x - A.from.x) * ay - (B.from.y - A.from.y) * ax) / den;
    if (t <= 0 || s <= 0) continue;
    const x = A.from.x + ax * t, y = A.from.y + ay * t, off = Math.hypot(cur.x - x, cur.y - y);
    if (off <= tol && (!best || off < best.off)) best = { x, y, off, rays: [A, B], kind: 'two' };
  }
  if (best) return best;
  for (const R of rays) {
    if (base && R.from === base) continue;   // a ray from the base alone is polar tracking's job
    const r = onRay(R.from, R.ang, cur);
    if (r && r.off <= tol && (!best || r.off < best.off)) best = { x: r.x, y: r.y, off: r.off, rays: [R], kind: 'one' };
  }
  return best;
}
