/* SPDX-License-Identifier: Apache-2.0 */
/**
 * lasso.js — lasso selection in CadCraft (0.4 part 2, T.4): exact hits on CadCraft's geometry. DOM-free: bin/test-cadcraft.mjs
 * drives it. The parts every 2D app shares are in lasso-core.js.
 *
 * Press and drag on an empty spot draws a freehand lasso. Its mode follows the first move, as in AutoCAD: to the right =
 * window (objects wholly inside), to the left = crossing (inside or touching); Space while dragging cycles window →
 * crossing → fence (objects the path itself crosses). A click, then a second click, still draws the rectangle.
 *
 *   lassoHits(entities, pts, mode, blocks, boundsOf?) → [ids]   mode 'window' | 'crossing' | 'fence'
 *   pointInPoly(p, pts) → bool          thin(pts, minStep) → pts (drops points closer than minStep to the last kept)
 *   lassoMode(start, cur, minPx) → 'window' | 'crossing' | null (screen points; null until the pointer has moved minPx sideways)
 *   nextMode(mode) → the mode Space switches to
 */

import { prims, primPoint, intersect, entityBounds, validBounds, emptyBounds, growPt, fenceHits, dist, EPS, UNBOUNDED } from './geom.js';
import { pointInPoly } from './lasso-core.js';
// the modes, the first-move rule, Space and path thinning are shared with the other 2D apps (lasso-core.js, a copied module)
export { LASSO_MODES, nextMode, lassoMode, thin, pointInPoly } from './lasso-core.js';

function edgesOf(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (dist(a, b) > EPS) out.push({ k: 'L', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

/**
 * Objects a lasso selects. Window: every part of the object inside the closed lasso (no piece crosses its outline).
 * Crossing: any part inside or crossing it. Fence: the path (left open) crosses the object.
 */
export function lassoHits(entities, pts, mode, blocks, boundsOf = (e) => entityBounds(e, blocks)) {
  const list = [...entities];
  if (mode === 'fence') return fenceHits(list, pts, blocks);
  if (pts.length < 3) return [];
  const lb = emptyBounds();
  for (const p of pts) growPt(lb, p.x, p.y);
  const edges = edgesOf(pts);
  const out = [];
  for (const e of list) {
    if (UNBOUNDED.has(e.type)) {   // a construction line (0.5 DR.6) is never inside a lasso; crossing, it is caught where it cuts or starts inside
      if (mode === 'crossing' && (prims(e).some((p) => edges.some((ed) => intersect(p, ed).length)) || (e.type === 'ray' && pointInPoly(e, pts)))) out.push(e.id);
      continue;
    }
    const b = boundsOf(e);
    if (!b || !validBounds(b)) continue;
    if (b.maxX < lb.minX || b.minX > lb.maxX || b.maxY < lb.minY || b.minY > lb.maxY) continue;
    const boxInside = b.minX >= lb.minX && b.maxX <= lb.maxX && b.minY >= lb.minY && b.maxY <= lb.maxY;
    if (mode === 'window' && !boxInside) continue;
    const ps = e.type === 'point' ? [] : prims(e, blocks);
    const cuts = ps.some((p) => edges.some((ed) => intersect(p, ed).length));
    if (mode === 'window') {
      if (cuts) continue;
      const probe = e.type === 'point' ? [{ x: e.x, y: e.y }] : ps.length ? ps.map((p) => primPoint(p, 0)) : [{ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }];
      if (probe.every((q) => pointInPoly(q, pts))) out.push(e.id);
      continue;
    }
    if (cuts) { out.push(e.id); continue; }
    if (e.type === 'point') { if (pointInPoly(e, pts)) out.push(e.id); continue; }
    if (ps.some((p) => pointInPoly(primPoint(p, 0), pts))) { out.push(e.id); continue; }
    // a lasso drawn inside a text's or a hatch's box touches it (as a crossing window does)
    if ((e.type === 'text' || e.type === 'hatch') && pts.some((q) => q.x >= b.minX && q.x <= b.maxX && q.y >= b.minY && q.y <= b.maxY)) out.push(e.id);
  }
  return out;
}
