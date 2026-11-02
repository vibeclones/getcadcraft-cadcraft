/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dwg-vports.js — the split screen (`doc.vports`, panes.js shape) ↔ the VPORT table's `*ACTIVE` records, for every
 * writer and reader of CadCraft (dxf.js R12, dxf2000.js, dwg-save.js / cc-dwg, dwg-import.js). DOM-free.
 *
 *   vportRecords(vports, fallback, twist) → [{ x0, y0, x1, y1, cx, cy, h, aspect, tw, sheet? }]   active pane first
 *   vportsFrom(records)             → the panes.js shape, or null (one pane / corners that match no layout)
 *
 * A record's corners are fractions of the drawing window with y up (DXF 10/20, 11/21); `cx, cy` the view centre
 * (12/22), `h` the view height (40), `aspect` width ÷ height of the pane on screen (41), `tw` its view twist (radians; DXF
 * 51 in degrees; 0.5 DR.8: a pane's `tw`, or `twist` = doc.viewTwist for one pane). A pane that shows a sheet has
 * no place in the table: it is written as a model pane (the fallback view) with the sheet's name in CADCRAFT xdata
 * (`sheet`), which only CadCraft reads back.
 */

import { vportCorners, layoutFromCorners, cleanPanes } from './panes.js';

const SCREEN_ASPECT = 1.6;   // the drawing window's width ÷ height when the pane's own is unknown

/**
 * The records to write. `fallback` = { cx, cy, h } (the model's extents) for a pane without a model view; without one
 * such a pane gets cx = cy = h = null and the writer fills in its own extents. One pane (vports null) → one record over
 * the whole window.
 */
export function vportRecords(vports, fallback = null, twist = 0) {
  const v = cleanPanes(vports);
  const fb = fallback && num(fallback.h) > 0 ? { cx: num(fallback.cx), cy: num(fallback.cy), h: fallback.h } : { cx: null, cy: null, h: null };
  if (!v) return [{ x0: 0, y0: 0, x1: 1, y1: 1, ...fb, aspect: SCREEN_ASPECT, tw: num(twist) }];
  const corners = vportCorners(v.layout, v.fx, v.fy);
  const recs = corners.map((c, i) => {
    const p = v.list[i];
    const view = p && !p.sheet ? { cx: p.cx, cy: p.cy, h: p.h } : fb;
    return { ...c, ...view, aspect: ((c.x1 - c.x0) / (c.y1 - c.y0)) * SCREEN_ASPECT, tw: p && !p.sheet ? num(p.tw) : 0, ...(p?.sheet ? { sheet: p.sheet } : {}) };
  });
  const a = v.active;
  return [recs[a], ...recs.filter((_, i) => i !== a)];
}

/** Records read from a file (untrusted; any order, the first one the active pane) → panes.js shape or null. */
export function vportsFrom(records) {
  const rs = (Array.isArray(records) ? records : []).filter((r) => r && [r.x0, r.y0, r.x1, r.y1, r.cx, r.cy, r.h].every(Number.isFinite));
  if (rs.length < 2) return null;
  const fit = layoutFromCorners(rs);
  if (!fit) return null;
  const list = fit.order.map((k) => {
    const r = rs[k];
    return { cx: r.cx, cy: r.cy, h: r.h, ...(Number.isFinite(r.tw) && Math.abs(r.tw) > 1e-12 && Math.abs(r.tw) <= 100 ? { tw: r.tw } : {}), ...(typeof r.sheet === 'string' && r.sheet ? { sheet: r.sheet } : {}) };
  });
  return cleanPanes({ layout: fit.layout, fx: fit.fx, fy: fit.fy, active: Math.max(0, fit.order.indexOf(0)), list });
}

function num(x) { return Number.isFinite(x) ? x : 0; }
