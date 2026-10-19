/* SPDX-License-Identifier: Apache-2.0 */
/**
 * walk.js — what a set of entities draws as, for any output (the screen in view.js, paper in
 * plot.js). No DOM. Blocks and dimensions are expanded, colours resolved (by layer, by block),
 * hidden layers skipped, and everything put through an optional transform `m`:
 *
 *   walk(doc, entities, out, { m, plot })
 *     out.stroke(color, prims, lw, o) lines and arcs (geom.js primitives), already transformed and cut into the dashes of
 *                                     their linetype (0.4 C8, linetypes.js); lw = the lineweight in mm (-3 = default)
 *     out.fill(color, loops, solid, o) hatches: loops of [x, y, x, y, …] (a pattern hatch.js knows comes as strokes)
 *     out.text(color, e, o)           a text entity, already transformed (its `obl`, the oblique angle, passes through)
 *
 * `o` (0.4 part 2, track P; absent = opaque) = { alpha, wipe }: alpha 0–1 = 1 − transparency/100 (the object's `tr`;
 * ByLayer = its layer's `tr`, ByBlock = the reference's); `wipe: true` on a solid fill = paint it in the background
 * colour (a dimension's text background, DIMTFILL 1; white on a plot). A polyline with widths (`w`, `pts[i].sw/ew`)
 * comes as filled bands, with no centre line for those segments; a hatch's background colour (`bg`) as a solid fill
 * under it.
 *     out.point(color, x, y)
 *     out.viewport(e)                 a layout viewport (its border also comes as a stroke)
 *
 * `plot: true` also skips layers set not to plot. Colours are 'ink' or '#rrggbb'.
 * A block reference's attributes (geom.attrTexts) come out as text after its block; invisible
 * attributes are never drawn.
 */

import { prims, txPrim, txEntity, insertMatrix, ellipsePoints, mMul, mApply, dimParts, attrTexts, TAU } from './geom.js';
import { resolveColor } from './doc.js';
import { hatchLines } from './hatch.js';
import { leaderGeometry } from './leader.js';
import { resolveLt, resolveLw, patternOf, dashPrims } from './linetypes.js';

export function walk(doc, entities, out, { m = null, plot = false } = {}) {
  const shown = (name) => {
    const l = doc.layers.get(name);
    return !l || (l.on && !l.frozen && (!plot || l.plot !== false));
  };
  const P = (mm, x, y) => (mm ? mApply(mm, { x, y }) : { x, y });
  const ltscale = doc.meta?.ltscale > 0 ? doc.meta.ltscale : 1;
  const patterns = new Map();
  const pattern = (name) => { if (!patterns.has(name)) patterns.set(name, patternOf(doc, name)); return patterns.get(name); };
  // lines in the object's own coordinates, dashed by its linetype there (so a scaled block scales its dashes), then placed
  const strokeOf = (e, ps, color, lw, mm, ctx, o) => {
    const pat = pattern(resolveLt(doc, e, ctx.lt, ctx.layer));
    const d = pat ? dashPrims(ps, pat, ltscale * (e.lts > 0 ? e.lts : 1)) : ps;
    out.stroke(color, mm ? d.flatMap((q) => txPrim(q, mm)) : d, lw, o);
  };
  const txLoops = (loops, mm) => (mm ? loops.map((l) => { const o = []; for (let i = 0; i + 1 < l.length; i += 2) { const p = mApply(mm, { x: l[i], y: l[i + 1] }); o.push(p.x, p.y); } return o; }) : loops);
  // transparency (P.5): the object's, else its layer's (ByLayer), else the reference's (ByBlock) → an alpha, or undefined
  const trOf = (e, blkTr, parentLayer) => {
    const v = e.tr;
    if (v === 'ByBlock') return blkTr;
    if (Number.isFinite(v)) return v;
    const l = doc.layers.get(e.layer === '0' && parentLayer ? parentLayer : e.layer);
    return Number.isFinite(l?.tr) ? l.tr : undefined;
  };
  const optsOf = (tr) => (Number.isFinite(tr) && tr > 0 ? { alpha: Math.max(0, Math.min(1, 1 - tr / 100)) } : undefined);

  const emit = (e, byBlock, parentLayer, mm, depth, blk = {}) => {
    if (depth > 16) return;
    const color = resolveColor(doc, e, byBlock, parentLayer);
    const lw = resolveLw(doc, e, blk.lw, parentLayer);
    const ctx = { lt: blk.lt, layer: parentLayer };
    const tr = trOf(e, blk.tr, parentLayer), o = optsOf(tr);
    switch (e.type) {
      case 'insert': case 'dim': case 'mleader': {
        let parts, m2 = mm;
        if (e.type === 'insert') {
          const blk = doc.blocks.get(e.block);
          if (!blk) return;
          // the block, then its attributes (visible ones with a value; same layer and colour rules)
          parts = blk.attdefs?.length || e.attrs ? [...blk.entities, ...attrTexts(e, blk)] : blk.entities;
          const im = insertMatrix(e, blk);
          m2 = mm ? mMul(mm, im) : im;
        } else parts = e.type === 'mleader' ? leaderGeometry(e) : dimParts(e, doc.blocks);   // a multileader draws itself, like a dimension
        const layer = e.layer === '0' && parentLayer ? parentLayer : e.layer;
        const inner = { lt: resolveLt(doc, e, blk.lt, parentLayer), lw, tr };   // what ByBlock means inside
        for (const c of parts) {
          if (!shown(c.layer === '0' ? layer : c.layer)) continue;
          emit(c, color, layer, m2, depth + 1, e.type === 'insert' ? inner : { lt: 'Continuous', lw, tr });   // dimension and leader lines stay solid
        }
        return;
      }
      case 'text': out.text(color, mm ? txEntity(e, mm) : e, o); return;
      case 'point': { const p = P(mm, e.x, e.y); out.point(color, p.x, p.y); return; }
      case 'hatch': {
        if (e.bg !== undefined && e.bg !== null && !e.solid) out.fill(resolveColor(doc, { ...e, color: e.bg }, byBlock, parentLayer), txLoops(e.loops, mm), true, o);   // background colour under the pattern
        const lines = hatchLines(e, doc);   // a known pattern draws its lines (hatch.js); others show as a tone, as before
        if (lines) { out.stroke(color, mm ? lines.flatMap((q) => txPrim(q, mm)) : lines, lw, o); return; }
        out.fill(color, txLoops(e.loops, mm), !!e.solid, e.wipe && e.solid && e.color === 'bg' ? { ...(o || {}), wipe: true } : o);   // DIMTFILL 1: the background; 2: its own colour
        return;
      }
      case 'ellipse': {
        const pts = ellipsePoints(e, 96);
        const ps = [];
        for (let i = 0; i + 1 < pts.length; i++) ps.push({ k: 'L', x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
        strokeOf(e, ps, color, lw, mm, ctx, o);
        return;
      }
      case 'poly': {
        const b = polyBands(e);
        if (!b) { strokeOf(e, prims(e, null), color, lw, mm, ctx, o); return; }
        if (b.loops.length) out.fill(color, txLoops(b.loops, mm), true, o);
        if (b.plain.length) strokeOf(e, b.plain, color, lw, mm, ctx, o);
        return;
      }
      default: strokeOf(e, prims(e, null), color, lw, mm, ctx, o);
    }
  };

  for (const e of entities) {
    if (e.type === 'viewport') {
      // the view shows whatever its layer; the border follows the layer like anything else
      out.viewport?.(e);
      if (shown(e.layer)) out.stroke(resolveColor(doc, e), mm2(prims(e, null), m), resolveLw(doc, e), optsOf(trOf(e, undefined, null)));
      continue;
    }
    if (shown(e.layer)) emit(e, null, null, m, 0);
  }
}

const mm2 = (ps, m) => (m ? ps.flatMap((q) => txPrim(q, m)) : ps);

/**
 * A polyline's widths (P.7: global `w`, per segment `pts[i].sw` / `ew`) → { loops (one filled band per wide segment, as
 * [x, y, …] rings), plain (prims of the segments without width) }, or null when it has no width at all. Arcs (bulges) are
 * followed in steps of at most 10°, the width changing evenly along each segment, as AutoCAD draws them.
 */
export function polyBands(e) {
  const pts = e.pts || [];
  const g = Number.isFinite(e.w) && e.w > 0 ? e.w : 0;
  if (!g && !pts.some((p) => p.sw > 0 || p.ew > 0)) return null;
  const n = pts.length, segs = e.closed ? n : n - 1;
  const loops = [], plain = [];
  for (let i = 0; i < segs; i++) {
    const a = pts[i], q = pts[(i + 1) % n];
    const ws = Number.isFinite(a.sw) ? a.sw : g, we = Number.isFinite(a.ew) ? a.ew : g;
    const one = prims({ type: 'poly', closed: false, pts: [{ x: a.x, y: a.y, b: a.b || 0 }, { x: q.x, y: q.y }] }, null);
    if (!(ws > 0 || we > 0)) { plain.push(...one); continue; }
    const p = one[0];
    if (!p) continue;
    // points along the segment with their unit normals (left side)
    const along = [];
    if (p.k === 'L') {
      const L = Math.hypot(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L, ny = (p.x2 - p.x1) / L;
      along.push([p.x1, p.y1, nx, ny, 0], [p.x2, p.y2, nx, ny, 1]);
    } else {
      // an A primitive runs counter-clockwise from a0 to a1; the polyline may run either way
      let sweep = (p.a1 - p.a0 + TAU) % TAU || TAU;
      const ccw = (a.b || 0) > 0;
      const k = Math.max(2, Math.ceil(sweep / (Math.PI / 18)));
      for (let j = 0; j <= k; j++) {
        const t = j / k, ang = ccw ? p.a0 + sweep * t : p.a1 - sweep * t;
        const cx = Math.cos(ang), cy = Math.sin(ang);
        along.push([p.cx + p.r * cx, p.cy + p.r * cy, ccw ? -cx : cx, ccw ? -cy : cy, t]);
      }
    }
    const left = [], right = [];
    for (const [x, y, nx, ny, t] of along) {
      const h = (ws + (we - ws) * t) / 2;
      left.push(x + nx * h, y + ny * h);
      right.unshift(x - nx * h, y - ny * h);
    }
    const ring = [...left, ...right];
    ring.push(ring[0], ring[1]);
    loops.push(ring);
  }
  return { loops, plain };
}