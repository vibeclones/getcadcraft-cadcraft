/* SPDX-License-Identifier: Apache-2.0 */
/**
 * gview.js — constraints on the drawing's overlay canvas (view.js calls view.extraOverlay; params-panel.js sets it).
 * Model space only. Nothing here is plotted or saved as geometry.
 *
 *   drawParametric(ctx, view, doc, state)
 *     state = { bars: 'all' | 'none', hidden: Set(entity ids), dims: bool, selected: constraint id | null, hits: [] }
 *   Constraint bars: a row of small glyph boxes beside each constrained line, segment, circle or point (H V ⊥ ∥ T ◎ ⫽
 *   ⇔ = ⊕, as AutoCAD's bars); coincident constraints are small squares on the point. Dimensional constraints draw
 *   as dimensions in their own colour with "d1=40" (or "fx: d1=width/2"), at a fixed size on screen.
 *   Every glyph and label is recorded in state.hits ({ x, y, w, h (CSS px), cid, kind: 'bar' | 'dim' }) for picking.
 */

import { GEOMETRIC, isDim, dimEntityFor, refPoint, refKind, refLine, refCircle } from './gcons.js';
import { dimParts } from './geom.js';

const BOX = 15;

export function drawParametric(ctx, view, doc, state) {
  state.hits = [];
  if (!doc.inModel || !doc.constraints.length) return;
  const d = view.dpr;
  const col = colours(view);
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const sel = state.selected ? doc.constraints.find((c) => c.id === state.selected) : null;
  // the selected constraint's objects, highlighted
  if (sel) {
    ctx.strokeStyle = col.sel; ctx.lineWidth = 3; ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (const r of sel.refs) { const e = doc.model.get(r.e); if (e) view.traceEntity(ctx, e); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  // dimensional constraints
  if (state.dims !== false) {
    for (const c of doc.constraints) {
      if (!isDim(c)) continue;
      const st = { ...(doc.current?.dim || {}) };
      st.scale = 11 / (view.zoom * (st.txt || 2.5));   // fixed size on screen, as AutoCAD shows them
      const de = dimEntityFor(doc, c, st);
      if (!de) continue;
      const parts = dimParts(de, null);
      const colr = c.id === state.selected ? col.sel : col.dim;
      ctx.strokeStyle = colr; ctx.fillStyle = colr; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      for (const p of parts) if (p.type !== 'text' && p.type !== 'hatch') view.traceEntity(ctx, p);
      ctx.stroke();
      for (const p of parts) if (p.type === 'hatch') fillLoops(ctx, view, p.loops);
      const texts = parts.filter((p) => p.type === 'text');
      for (const t of texts) {
        const s = view.toScreen(t.x, t.y);
        ctx.save();
        ctx.translate(s.x, s.y); ctx.rotate(-(t.rot || 0));
        ctx.font = '600 12px ' + view.colors.font;
        ctx.textAlign = t.ha === 'center' ? 'center' : t.ha === 'right' ? 'right' : 'left';
        ctx.textBaseline = t.va === 'middle' ? 'middle' : t.va === 'top' ? 'top' : 'alphabetic';
        const w = ctx.measureText(t.s).width;
        const x0 = t.ha === 'center' ? -w / 2 : t.ha === 'right' ? -w : 0, y0 = t.va === 'middle' ? -7 : t.va === 'top' ? 0 : -11;
        ctx.fillStyle = col.bg; ctx.globalAlpha = 0.85; ctx.fillRect(x0 - 2, y0 - 1, w + 4, 15); ctx.globalAlpha = 1;
        ctx.fillStyle = colr; ctx.fillText(t.s, 0, 0);
        ctx.restore();
        const c0 = Math.cos(t.rot || 0), s0 = Math.sin(t.rot || 0);
        const cx = s.x + (x0 + w / 2) * c0 + (y0 + 7) * s0, cy = s.y - (x0 + w / 2) * s0 + (y0 + 7) * c0;
        const hw = Math.abs(c0) * w / 2 + Math.abs(s0) * 8, hh = Math.abs(s0) * w / 2 + Math.abs(c0) * 8;
        state.hits.push({ x: cx - hw, y: cy - hh, w: 2 * hw, h: 2 * hh, cid: c.id, kind: 'dim' });
      }
    }
  }
  if (state.bars === 'none') return;
  // coincident: a small square on the point
  for (const c of doc.constraints) {
    if (c.type !== 'coincident' || c.refs.some((r) => state.hidden?.has(r.e))) continue;
    const e = doc.model.get(c.refs[0].e);
    if (!e) continue;
    const p = refPoint(e, c.refs[0].k);
    if (!p) continue;
    const s = view.toScreen(p.x, p.y);
    ctx.fillStyle = c.id === state.selected ? col.sel : col.bar;
    ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    state.hits.push({ x: s.x - 5, y: s.y - 5, w: 10, h: 10, cid: c.id, kind: 'bar' });
  }
  // bars: one per constrained line / segment / circle / point
  const bars = new Map();
  for (const c of doc.constraints) {
    if (isDim(c) || c.type === 'coincident') continue;
    for (const r of c.refs) {
      if (state.hidden?.has(r.e)) continue;
      const key = r.e + '|' + r.k;
      if (!bars.has(key)) bars.set(key, { r, list: [] });
      const b = bars.get(key);
      if (!b.list.includes(c)) b.list.push(c);
    }
  }
  ctx.font = '600 11px ' + view.colors.font;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const { r, list } of bars.values()) {
    const e = doc.model.get(r.e);
    if (!e) continue;
    const at = anchor(e, r.k);
    if (!at) continue;
    const s = view.toScreen(at.x, at.y);
    if (s.x < -50 || s.y < -50 || s.x > view.w + 50 || s.y > view.h + 50) continue;
    const x0 = s.x + at.dx * 14 - (list.length * BOX) / 2, y0 = s.y + at.dy * 14 - BOX / 2;
    list.forEach((c, i) => {
      const x = x0 + i * BOX;
      const on = c.id === state.selected;
      ctx.fillStyle = on ? col.sel : col.barBg; ctx.fillRect(x, y0, BOX, BOX);
      ctx.strokeStyle = col.bar; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y0 + 0.5, BOX - 1, BOX - 1);
      ctx.fillStyle = on ? col.bg : col.bar;
      ctx.fillText(GEOMETRIC[c.type]?.glyph || '?', x + BOX / 2, y0 + BOX / 2 + 0.5);
      state.hits.push({ x, y: y0, w: BOX, h: BOX, cid: c.id, kind: 'bar' });
    });
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

/** Where a reference's bar sits: a point on it, and which way (screen) to push the bar off it. */
function anchor(e, k) {
  try {
    const kind = k === '*' ? (e.type === 'line' ? 'L' : e.type === 'point' ? 'P' : e.type === 'poly' ? 'L' : 'R') : refKind(e, k);
    const kk = k === '*' ? (e.type === 'line' ? 'L' : e.type === 'point' ? 'p' : e.type === 'poly' ? 's0' : 'R') : k;
    if (kind === 'P') { const p = refPoint(e, kk); return { ...p, dx: 1, dy: 1 }; }
    if (kind === 'L') {
      const l = refLine(e, kk), L = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) || 1;
      // screen y runs down: the left-hand normal (−uy, ux) in world is (−uy, −ux) on screen
      return { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2, dx: (l.y2 - l.y1) / L, dy: (l.x2 - l.x1) / L };
    }
    const c = refCircle(e, kk);
    return { x: c.cx + c.r * Math.SQRT1_2, y: c.cy + c.r * Math.SQRT1_2, dx: 1, dy: -1 };
  } catch { return null; }
}

function fillLoops(ctx, view, loops) {
  ctx.beginPath();
  for (const l of loops || []) {
    for (let i = 0; i + 1 < l.length; i += 2) { const s = view.toScreen(l[i], l[i + 1]); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); }
    ctx.closePath();
  }
  ctx.fill();
}

const cache = new WeakMap();
function colours(view) {
  const hit = cache.get(view);
  if (hit && hit.dark === view.dark && hit.bgKey === view.colors.bg) return hit;
  let dim = view.dark ? '#b79cf0' : '#6a3fb5', bar = view.colors.ink2;
  try {
    const cs = getComputedStyle(document.documentElement);
    dim = cs.getPropertyValue('--layer-violet').trim() || dim;
  } catch { /* no DOM (tests) */ }
  const v = { dark: view.dark, bgKey: view.colors.bg, dim, bar, barBg: view.colors.bg, bg: view.colors.bg, sel: view.colors.snap };
  cache.set(view, v);
  return v;
}

/** The constraint under a screen point, or null (labels first, then bars). */
export function hitAt(state, sx, sy) {
  const hits = state.hits || [];
  for (const kind of ['dim', 'bar']) for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.kind === kind && sx >= h.x - 1 && sx <= h.x + h.w + 1 && sy >= h.y - 1 && sy <= h.y + h.h + 1) return h;
  }
  return null;
}
