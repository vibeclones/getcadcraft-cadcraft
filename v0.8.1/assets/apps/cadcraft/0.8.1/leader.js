/* SPDX-License-Identifier: Apache-2.0 */
/**
 * leader.js — multileaders (MLEADER; 0.4 C32; owner: cad-draw). No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 * A multileader is ONE entity that draws itself, like a dimension:
 *   { type: 'mleader', pts: [{x, y}, …],   the leader line: pts[0] is the arrowhead's tip, the last point the landing's start
 *     dir: 1 | -1,                         the landing (and the text) go right (1) or left (-1) from the last point
 *     s, h, ww?, ls?,                      the text: words, height, wrap width, line spacing (as paragraph text)
 *     st: { asz, dogleg, gap } }           arrow size, landing length, gap between the landing and the text
 * leaderGeometry(e) → the plain entities it draws: the leader (an open polyline with its landing), the arrowhead (a solid
 * hatch) and the text (left- or right-aligned on the landing, its first line centred on it) — on layer 0, colour by
 * block, so they take the multileader's own (walk.js expands it the way it expands a dimension).
 */

export const MLEADER_DEFAULTS = Object.freeze({ asz: 2.5, dogleg: 2.5, gap: 1 });

/** The style with every size, and the text height (falls back to the arrow size). */
export const leaderStyle = (e) => ({ ...MLEADER_DEFAULTS, ...(e.st || {}) });

/** Where the landing ends and the text starts. */
export function landing(e) {
  const st = leaderStyle(e), last = e.pts[e.pts.length - 1], dir = e.dir === -1 ? -1 : 1;
  const end = { x: last.x + dir * st.dogleg, y: last.y };
  return { start: last, end, text: { x: end.x + dir * st.gap, y: end.y } };
}

export function leaderGeometry(e) {
  if (!e.pts || e.pts.length < 2) return [];
  const st = leaderStyle(e), dir = e.dir === -1 ? -1 : 1;
  const L = landing(e);
  const base = { layer: '0', color: 0 };
  const out = [{ ...base, type: 'poly', closed: false, pts: [...e.pts, ...(st.dogleg > 0 ? [L.end] : [])].map((p) => ({ x: p.x, y: p.y, b: 0 })) }];
  // arrowhead: a solid triangle at the tip, pointing back along the first segment
  const tip = e.pts[0], nxt = e.pts[1], dx = tip.x - nxt.x, dy = tip.y - nxt.y, len = Math.hypot(dx, dy);
  if (len > 1e-12 && st.asz > 0) {
    const ux = dx / len, uy = dy / len, a = st.asz, w = a / 6;   // AutoCAD's closed filled arrow: length a, half width a/6
    const bx = tip.x - ux * a, by = tip.y - uy * a;
    out.push({ ...base, type: 'hatch', solid: true, loops: [[tip.x, tip.y, bx - uy * w, by + ux * w, bx + uy * w, by - ux * w]] });
  }
  if (String(e.s ?? '').trim()) {
    const h = e.h > 0 ? e.h : st.asz;
    // the first line's middle on the landing: hang the text from its top, half a capital height above
    out.push({ ...base, type: 'text', x: L.text.x, y: L.text.y + h / 2, h, rot: 0, s: String(e.s), ha: dir === 1 ? 'left' : 'right', va: 'top', wf: 1, ...(e.ww > 0 ? { ww: e.ww } : {}), ...(e.ls && e.ls !== 1 ? { ls: e.ls } : {}) });
  }
  return out;
}
