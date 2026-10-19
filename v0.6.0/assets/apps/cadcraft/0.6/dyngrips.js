/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dyngrips.js — the grips of a dynamic block reference (0.5 DB.5), where AutoCAD draws them. DOM-free.
 *
 *   dynGrips(doc, insert) → [{ x, y, key, shape, node, kind, name, ux?, uy? }] in world coordinates
 *     key    'dyn:vis' (the visibility grip: a click opens the list of states) | 'dyn:<node>:<part>' (the others)
 *     shape  'vis' (a small down triangle) | 'arrow' (linear: a triangle pointing along ux, uy) | 'flip' | 'point'
 *   dynGripActs(key) → true for the grips that do something today (the visibility one; DB.7 adds the rest)
 *
 * Positions come from the values the file holds (dyn-blocks.js, docs/DWG-DYNAMIC-BLOCKS.md), in the definition's own
 * coordinates, placed through the reference's insert matrix: visibility at its parameter's point (else the block's base),
 * a linear parameter at its two ends, a flip parameter halfway along its line, a point or base point at the point.
 */
import { insertMatrix, mApply } from './geom.js';
import { visibilityOf } from './dyn-blocks.js';

const fin = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

export function dynGrips(doc, e) {
  if (!e || e.type !== 'insert') return [];
  const B = doc.blocks.get(e.block);
  const def = B?.dyn ? (B.dyn.def ? B : doc.blocks.get(B.dyn.of)) : null;
  if (!def) return [];
  const m = insertMatrix(e, B), P = (p) => mApply(m, p), out = [];
  const names = new Map((def.dyn.params || []).map((p) => [p.node, p.name]));
  const vis = visibilityOf(doc, e);
  if (vis) {
    const v = (e.dyn?.values || []).find((x) => x.kind === 'visibility');
    const at = fin(v?.point) ? v.point : fin(def.dyn.vis?.point) ? def.dyn.vis.point : (B.base || { x: 0, y: 0 });
    out.push({ ...P(at), key: 'dyn:vis', shape: 'vis', kind: 'visibility', name: vis.label });
  }
  for (const v of e.dyn?.values || []) {
    const name = names.get(v.node) || v.kind;
    if (v.kind === 'linear' && fin(v.p1) && fin(v.p2)) {
      const a = P(v.p1), b = P(v.p2), L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      out.push({ ...b, key: 'dyn:' + v.node + ':p2', shape: 'arrow', ux, uy, node: v.node, kind: 'linear', name });
      out.push({ ...a, key: 'dyn:' + v.node + ':p1', shape: 'arrow', ux: -ux, uy: -uy, node: v.node, kind: 'linear', name });
    } else if (v.kind === 'flip' && fin(v.p1) && fin(v.p2)) {
      const a = P(v.p1), b = P(v.p2);
      out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, key: 'dyn:' + v.node + ':flip', shape: 'flip', ux: b.x - a.x, uy: b.y - a.y, node: v.node, kind: 'flip', name });
    } else if ((v.kind === 'point' || v.kind === 'basepoint') && fin(v.point)) {
      out.push({ ...P(v.point), key: 'dyn:' + v.node + ':pt', shape: 'point', node: v.node, kind: v.kind, name });
    }
  }
  return out;
}

export const dynGripActs = (key) => key === 'dyn:vis';
