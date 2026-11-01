/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ckeep.js — constraints that come through MIRROR and TRIM (0.4 C16; owner: cad-draw). No DOM: the Node tests run it.
 * Both run inside the command's doc.change(), so the geometry and its constraints are one undo step.
 *
 *   mirrorConstraints(doc, pairs)          pairs [[sourceId, copyId]]: the constraints among the sources, copied onto
 *                                          the copies, with signs and sides worked out again on the mirrored geometry
 *                                          (dimensional ones get new names, as a paste does). → how many were added
 *   trimConstraints(doc, oldE, pieces)     oldE: the object before the cut; pieces [{ id, e, t0, t1 }] (line/arc
 *                                          parameters 0…1 of the original, the first piece keeps oldE's id). Each
 *                                          constraint on the object moves to the piece that still has what it holds;
 *                                          ones that held the part that went, or a length the cut changed, are
 *                                          dropped. → { kept, dropped }
 */

import { clipConstraints, pasteConstraints, makeConstraint, dropDimParams, DIMENSIONAL } from './gcons.js';

const isDim = (c) => !!DIMENSIONAL[c.type];

/** The constraint with its signs, sides and fixed values taken from the geometry as it is now. */
function reSign(doc, c) {
  const r = makeConstraint(doc, c.type, c.refs, { id: c.id, name: c.name, value: c.value });
  if (!r.c) return null;
  const n = r.c, out = { ...c };
  for (const k of ['sign', 'kind', 'pair', 'value', 'fixed']) {
    if (k === 'value' && isDim(c)) continue;   // a dimension keeps its value (a mirror changes no length or angle)
    if (n[k] !== undefined) out[k] = n[k]; else if (k !== 'value') delete out[k];
  }
  if (c.type === 'angle' && c.dirs) {
    // the same sector as before (each leg's side), so only the turn's sense is worked out again
    const get = (id) => doc.model.get(id);
    const L = (i) => { const e = get(c.refs[i].e); return e && e.type === 'line' ? e : null; };
    const l1 = L(0), l2 = L(1);
    if (l1 && l2) {
      const u = [(l1.x2 - l1.x1) * c.dirs[0], (l1.y2 - l1.y1) * c.dirs[0]], v = [(l2.x2 - l2.x1) * c.dirs[1], (l2.y2 - l2.y1) * c.dirs[1]];
      out.sign = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) >= 0 ? 1 : -1;
      out.dirs = c.dirs.slice();
    }
  }
  return out;
}

/** After an in-place change (MIRROR erasing its source): signs and sides again for the constraints among `ids`. */
export function resignAmong(doc, ids) {
  if (!doc.inModel || !doc.constraints.length) return 0;
  let n = 0;
  const cs = doc.constraints.map((c) => { if (!c.refs.every((r) => ids.has(r.e))) return c; const k = reSign(doc, c); if (k) { n++; return k; } return c; });
  if (n) doc.setParametric({ constraints: cs, params: doc.params });
  return n;
}

export function mirrorConstraints(doc, pairs) {
  if (!doc.inModel || !doc.constraints.length || !pairs.length) return 0;
  const index = new Map(pairs.map(([src], i) => [src, i]));
  const list = clipConstraints(doc, index);
  if (!list.length) return 0;
  const before = new Set(doc.constraints.map((c) => c.id));
  const n = pasteConstraints(doc, list, pairs.map(([, copy]) => copy));
  if (!n) return 0;
  const cs = doc.constraints.map((c) => (before.has(c.id) ? c : reSign(doc, c) || c));
  doc.setParametric({ constraints: cs, params: doc.params });
  return n;
}

/** What a reference holds on a line or an arc: an end ('start' | 'end'), its middle, or the curve as a whole. */
function refWhat(type, k) {
  if (type === 'line') return k === 'p1' ? 'start' : k === 'p2' ? 'end' : k === 'mid' ? 'mid' : k === 'L' ? 'curve' : null;
  if (type === 'arc') return k === 's' ? 'start' : k === 'e' ? 'end' : k === 'mid' ? 'mid' : k === 'c' || k === 'R' ? 'circle' : null;
  if (type === 'circle') return k === 'c' || k === 'R' ? 'circle' : null;
  return null;
}
/** Constraints that hold a curve's length or sweep (changed by a cut). */
const LENGTHY = new Set(['equal']);
/** Rules about a line's direction, which every piece of a cut line still meets. */
const CLONE = new Set(['horizontal', 'vertical', 'parallel', 'perpendicular']);

export function trimConstraints(doc, oldE, pieces) {
  if (!doc.constraints.length) return { kept: 0, dropped: 0 };
  const id = oldE.id;
  const mine = doc.constraints.filter((c) => c.refs.some((r) => r.e === id));
  if (!mine.length) return { kept: 0, dropped: 0 };
  const others = doc.constraints.filter((c) => !c.refs.some((r) => r.e === id));
  const withStart = pieces.find((p) => p.t0 <= 1e-9), withEnd = pieces.find((p) => p.t1 >= 1 - 1e-9);
  const keep = [], dropped = [];
  for (const c of mine) {
    if (oldE.type === 'poly' || !pieces.length) { dropped.push(c); continue; }   // a polyline's vertices are numbered again
    let ok = true, onAll = false;
    const refs = c.refs.map((r) => {
      if (r.e !== id) return r;
      const what = refWhat(oldE.type, r.k);
      if (what === 'start' && withStart) return { e: withStart.id, k: r.k };
      if (what === 'end' && withEnd) {
        const piece = withEnd;
        // a circle cut to an arc has ends of its own; an arc keeps its keys; a line's far end is p2 on its piece
        return { e: piece.id, k: r.k };
      }
      if (what === 'curve' || what === 'circle') {
        if (LENGTHY.has(c.type) || (what === 'circle' && c.type === 'angle')) { ok = false; return r; }   // the length or the sweep changed
        if (c.type === 'fix') { ok = false; return r; }
        onAll = CLONE.has(c.type) && c.refs.filter((q) => q.e === id).length === 1;   // a direction rule: every piece keeps it
        return { e: pieces[0].id, k: r.k };
      }
      ok = false;   // the middle moved, or the end it held is gone
      return r;
    });
    if (!ok) { dropped.push(c); continue; }
    if (c.type === 'angle' && c.refs.length === 1) { dropped.push(c); continue; }   // an arc's sweep
    keep.push({ ...c, refs });
    // the same rule on the other pieces too (horizontal, parallel to …, tangent to …): copies without a name
    if (onAll) for (const p of pieces.slice(1)) keep.push({ ...c, id: undefined, refs: refs.map((r, i) => (c.refs[i].e === id ? { e: p.id, k: r.k } : r)) });
  }
  // fresh ids for the copies, then signs from the cut geometry
  const ids = new Set([...others, ...keep].map((c) => c.id).filter(Boolean));
  let n = 1;
  const fresh = () => { while (ids.has('k' + n)) n++; ids.add('k' + n); return 'k' + n; };
  const out = keep.map((c) => reSign(doc, c.id ? c : { ...c, id: fresh() })).filter(Boolean);
  const lost = keep.length - out.length;
  doc.setParametric({ constraints: [...others, ...out], params: dropDimParams(doc.params, dropped) });
  return { kept: out.length, dropped: dropped.length + lost };
}
