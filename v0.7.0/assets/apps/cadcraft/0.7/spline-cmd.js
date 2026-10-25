/* SPDX-License-Identifier: Apache-2.0 */
/**
 * spline-cmd.js — SPLINE, SPLINEDIT and PEDIT (0.7 D7.10). Registers its commands in the command registry when imported
 * (cadcraft.js imports it; Node tests too). The curves and their editing are spline.js's (DOM-free).
 *
 *   SPLINE (SPL)      points through which the curve passes (Fit) or a control polygon (CV, with a degree); Close; Undo;
 *                     tangents at the ends for a fit spline; Object turns a polyline into a spline through its vertices
 *   SPLINEDIT (SPE)   Fit data (add, delete, move, purge, tangents), Edit vertex (add a control point, move, weight), Open / Close,
 *                     Reverse, Convert to polyline (with a precision), Undo, Exit
 *   PEDIT (PE)        a polyline (a line, an arc or a spline can be turned into one): Close / Open, Join, Width, Fit curve,
 *                     Spline curve, Decurve, Ltype gen, Reverse, Multiple
 */
import { t } from './i18n.js';
import { commandRegistry } from './commands.js';
import { joinEntities, distToEntity, normAngle } from './geom.js';
import * as S from './spline.js';

const def = commandRegistry.add, opt = commandRegistry.option;
const ent = (c, e) => ({ layer: c.doc.current.layer, color: c.doc.current.color, ...c.doc.currentStyle(), ...e });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const kw = (r, d) => (r && typeof r === 'object' ? r.option : r) || d;
const P = (p) => ({ x: p.x, y: p.y });

/** The index of the point nearest to `p` in a list. */
const nearest = (list, p) => { let bi = -1, bd = Infinity; list.forEach((q, i) => { const d = dist(q, p); if (d < bd) { bd = d; bi = i; } }); return bi; };

// ---------------------------------------------------------------------------------------------------- SPLINE

def('SPLINE', ['SPL'], async (c) => {
  let method = c.engine.splineMethod || 'F', degree = c.engine.splineDegree || 3;
  const pts = [];
  let closed = false;
  const build = (extra = []) => {
    const all = [...pts, ...extra];
    if (method === 'F') return all.length >= 2 ? S.fitSpline(all, { closed: closed && extra.length === 0, degree: 3 }) : null;
    return all.length > degree ? S.cvSpline(all, { degree, closed: closed && extra.length === 0 }) : null;
  };
  // the first point, or Method / Object
  for (;;) {
    const first = await c.point(t('cmd.spline.first', { method: t(method === 'F' ? 'cmd.spline.fit' : 'cmd.spline.cv') }), { none: true, options: [opt('M', t('cmd.spline.method')), opt('O', t('cmd.spline.object'))] });
    if (!first) return;
    if (first.option === 'M') {
      const k = kw(await c.keyword(t('cmd.spline.method.ask'), { options: [opt('F', t('cmd.spline.fit')), opt('C', t('cmd.spline.cv'))], default: method === 'F' ? 'F' : 'C' }), method);
      method = k === 'C' ? 'C' : 'F';
      if (method === 'C') { const d = await c.number(t('cmd.spline.degree'), { default: degree }); if (Number.isInteger(d) && d >= 1 && d <= 5) degree = d; }
      c.engine.splineMethod = method; c.engine.splineDegree = degree;
      continue;
    }
    if (first.option === 'O') { await fromObjects(c); return; }
    pts.push(P(first));
    break;
  }
  c.engine.lastPoint = pts[0];
  for (;;) {
    c.preview((cur) => { const e = build([P(cur)]); return e ? [e] : []; });
    const options = [...(pts.length >= 2 ? [opt('C', t('cmd.spline.close'))] : []), opt('U', t('opt.undo'))];
    const p = await c.point(t('cmd.spline.next'), { base: pts[pts.length - 1], options, none: true });
    if (!p) break;
    if (p.option === 'U') { if (pts.length > 1) pts.pop(); continue; }
    if (p.option === 'C') { closed = true; break; }
    if (dist(pts[pts.length - 1], p) < 1e-12) continue;
    pts.push(P(p));
  }
  let st = null, et = null;
  if (method === 'F' && !closed && pts.length >= 2) {
    // the tangents at the ends: a point gives the direction from the end; Enter leaves the curve to find its own
    const first = pts[0], last = pts[pts.length - 1];
    const dir = (from, p) => (p && !p.option && dist(from, p) > 1e-12 ? { x: p.x - from.x, y: p.y - from.y } : null);
    c.preview((cur) => { const e = S.fitSpline(pts, { st: dir(first, cur) }); return e ? [e] : []; });
    st = dir(first, await c.point(t('cmd.spline.tan.start'), { base: first, none: true }));
    c.preview((cur) => { const e = S.fitSpline(pts, { st, et: dir(last, cur) }); return e ? [e] : []; });
    et = dir(last, await c.point(t('cmd.spline.tan.end'), { base: last, none: true }));
    c.preview(null);
  }
  const e = method === 'F' ? S.fitSpline(pts, { closed, st, et, degree: 3 }) : S.cvSpline(pts, { degree, closed });
  if (!e) { c.print(t('cmd.spline.few')); return; }
  c.add(ent(c, e));
  c.print(t('cmd.spline.made', { kind: t(method === 'F' ? 'cmd.spline.fit' : 'cmd.spline.cv'), n: pts.length }));
}, { help: () => t('cmd.spline.help') });

function unit(v) { const L = Math.hypot(v.x, v.y); return L > 1e-12 ? { x: v.x / L, y: v.y / L } : null; }

/** SPLINE › Object: polylines (and lines, arcs) become splines through their vertices; the originals are deleted. */
async function fromObjects(c) {
  const ids = await c.select(t('cmd.spline.object.select'));
  const list = [...ids].map((id) => c.doc.get(id)).filter((e) => e && c.doc.editable(e));
  let n = 0;
  c.doc.change('SPLINE', () => {
    for (const e of list) {
      let pts = null;
      if (e.type === 'poly' && e.pts.length >= 2) pts = polyVertices(e);
      else if (e.type === 'line') pts = [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
      const sp = pts && S.fromPolylinePts(pts, e.type === 'poly' && !!e.closed);
      if (!sp) continue;
      c.doc.remove(e.id);
      c.doc.add({ ...sp, layer: e.layer, color: e.color ?? null, ...(e.lt ? { lt: e.lt } : {}), ...(e.lw !== undefined ? { lw: e.lw } : {}) });
      n++;
    }
  });
  c.print(n ? t('cmd.spline.object.done', { n }) : t('cmd.spline.object.none'));
}
/** The corner points of a polyline as a curve should pass them: the frame it was fitted from when it has one. */
function polyVertices(e) { return (e.frame || e.pts).map((p) => ({ x: p.x, y: p.y })); }

// ---------------------------------------------------------------------------------------------------- SPLINEDIT

def('SPLINEDIT', ['SPE'], async (c) => {
  const pre = [...c.host.selection].map((id) => c.doc.get(id)).find((e) => e?.type === 'spline');
  let id = pre?.id;
  if (!id) {
    const pick = await c.entity(t('cmd.splinedit.pick'));
    if (!pick || pick.option) return;
    id = pick.id ?? pick;
    if (c.doc.get(id)?.type !== 'spline') { c.print(t('cmd.splinedit.notspline')); return; }
  }
  const cur = () => c.doc.get(id);
  const set = (label, next) => { if (!next || next === cur()) return false; c.doc.change(label, () => c.doc.update(id, { ...next })); return true; };
  c.host.setSelection(new Set([id]));
  for (;;) {
    const e = cur();
    if (!e) return;
    const hasFit = !!e.fit;
    const k = kw(await c.keyword(t('cmd.splinedit.option'), { options: [...(hasFit ? [opt('F', t('cmd.splinedit.fitdata'))] : []), opt('E', t('cmd.splinedit.vertex')), opt('P', t('cmd.splinedit.convert')), opt('O', e.closed ? t('cmd.splinedit.open') : t('cmd.splinedit.close')), opt('R', t('cmd.splinedit.reverse')), opt('U', t('opt.undo')), opt('X', t('cmd.splinedit.exit'))], default: 'X' }), 'X');
    if (k === 'X') break;
    if (k === 'U') { c.doc.undo(); if (!cur()) return; continue; }
    if (k === 'R') { set('SPLINEDIT', S.reverse(e)); c.print(t('cmd.splinedit.reversed')); continue; }
    if (k === 'O') { const n = S.setClosed(e, !e.closed); if (set('SPLINEDIT', n)) c.print(t(n.closed ? 'cmd.splinedit.closed' : 'cmd.splinedit.opened')); continue; }
    if (k === 'P') {
      const prec = await c.number(t('cmd.splinedit.precision'), { default: 10 });
      const pts = S.polyline(e, Number.isInteger(prec) && prec >= 1 && prec <= 99 ? prec : 10);
      if (pts.length < 2) continue;
      c.doc.change('SPLINEDIT', () => { c.doc.remove(id); c.doc.add({ type: 'poly', layer: e.layer, color: e.color ?? null, closed: !!e.closed, pts: pts.map((p) => ({ x: p.x, y: p.y, b: 0 })) }); });
      c.print(t('cmd.splinedit.converted', { n: pts.length }));
      return;
    }
    if (k === 'F') await fitData(c, id, cur, set);
    else if (k === 'E') await vertexData(c, id, cur, set);
  }
}, { help: () => t('cmd.splinedit.help') });

async function fitData(c, id, cur, set) {
  for (;;) {
    const e = cur();
    if (!e?.fit) return;
    c.print(t('cmd.splinedit.fit.n', { n: e.fit.length }));
    const k = kw(await c.keyword(t('cmd.splinedit.fit.option'), { options: [opt('A', t('cmd.splinedit.add')), opt('D', t('cmd.splinedit.delete')), opt('M', t('cmd.splinedit.move')), opt('P', t('cmd.splinedit.purge')), opt('T', t('cmd.splinedit.tangents')), opt('X', t('cmd.splinedit.exit'))], default: 'X' }), 'X');
    if (k === 'X') return;
    if (k === 'P') { const { fit, st, et, ...rest } = e; void fit; void st; void et; set('SPLINEDIT', rest); c.print(t('cmd.splinedit.purged')); return; }
    if (k === 'A') {
      const p = await c.point(t('cmd.splinedit.fit.add'));
      if (!p || p.option) continue;
      // after the fit point nearest to it along the curve's order: between its two nearest neighbours
      const i = nearest(e.fit, p);
      const after = (i + 1 < e.fit.length && (i === 0 || dist(p, e.fit[i + 1]) < dist(p, e.fit[i - 1]))) ? i + 1 : i;
      set('SPLINEDIT', S.addFit(e, P(p), after));
    } else if (k === 'D') {
      const p = await c.point(t('cmd.splinedit.fit.pick'));
      if (!p || p.option) continue;
      if (e.fit.length <= 2) { c.print(t('cmd.splinedit.fit.two')); continue; }
      set('SPLINEDIT', S.deleteFit(e, nearest(e.fit, p)));
    } else if (k === 'M') {
      const p = await c.point(t('cmd.splinedit.fit.pick'));
      if (!p || p.option) continue;
      const i = nearest(e.fit, p);
      c.preview((cur2) => [S.editFit(e, i, cur2)]);
      const q = await c.point(t('cmd.splinedit.fit.new'), { base: e.fit[i], none: true });
      c.preview(null);
      if (q && !q.option) set('SPLINEDIT', S.editFit(e, i, P(q)));
    } else if (k === 'T') {
      const a = e.fit[0], b = e.fit[e.fit.length - 1];
      const dir = (from, p) => (p && !p.option && dist(from, p) > 1e-12 ? unit({ x: p.x - from.x, y: p.y - from.y }) : null);
      const s = dir(a, await c.point(t('cmd.spline.tan.start'), { base: a, none: true }));
      const en = dir(b, await c.point(t('cmd.spline.tan.end'), { base: b, none: true }));
      const next = { ...e }; delete next.st; delete next.et;
      if (s) next.st = s; if (en) next.et = en;
      set('SPLINEDIT', S.rebuild(next));
    }
  }
}

async function vertexData(c, id, cur, set) {
  for (;;) {
    const e = cur();
    if (!e) return;
    const k = kw(await c.keyword(t('cmd.splinedit.vertex.option'), { options: [opt('A', t('cmd.splinedit.refine')), opt('M', t('cmd.splinedit.move')), opt('W', t('cmd.splinedit.weight')), opt('X', t('cmd.splinedit.exit'))], default: 'X' }), 'X');
    if (k === 'X') return;
    const shown = e.periodic ? e.ctrl.slice(0, e.ctrl.length - e.degree) : e.ctrl;
    if (k === 'A') {
      // where along the curve: the parameter nearest the picked point
      const p = await c.point(t('cmd.splinedit.vertex.add'));
      if (!p || p.option) continue;
      const [lo, hi] = S.domain(e);
      let bu = lo, bd = Infinity;
      for (let i = 0; i <= 400; i++) { const u = lo + (hi - lo) * (i / 400), q = S.pointAt(e, u), d = dist(q, p); if (d < bd) { bd = d; bu = u; } }
      const n = S.insertKnot(e, bu);
      if (n !== e) { set('SPLINEDIT', n); c.print(t('cmd.splinedit.refined', { n: n.ctrl.length })); }
      continue;
    }
    const p = await c.point(t('cmd.splinedit.vertex.pick'));
    if (!p || p.option) continue;
    const i = nearest(shown, p);
    if (k === 'M') {
      c.preview((cur2) => [S.moveCtrl(e, i, cur2)]);
      const q = await c.point(t('cmd.splinedit.vertex.new'), { base: shown[i], none: true });
      c.preview(null);
      if (q && !q.option) set('SPLINEDIT', S.moveCtrl(e, i, P(q)));
    } else if (k === 'W') {
      const w = await c.number(t('cmd.splinedit.weight.ask', { w: (e.weights?.[i] ?? 1) }), { default: e.weights?.[i] ?? 1 });
      if (w > 0) set('SPLINEDIT', S.setWeight(e, i, w)); else c.print(t('cmd.splinedit.weight.bad'));
    }
  }
}

// ---------------------------------------------------------------------------------------------------- PEDIT

/** A line, an arc or a spline as a polyline (spline: `precision` segments per knot span). */
function toPoly(e, precision = 10) {
  if (e.type === 'poly') return e;
  const base = { type: 'poly', layer: e.layer, color: e.color ?? null, ...(e.lt ? { lt: e.lt } : {}), ...(e.lw !== undefined ? { lw: e.lw } : {}) };
  if (e.type === 'line') return { ...base, closed: false, pts: [{ x: e.x1, y: e.y1, b: 0 }, { x: e.x2, y: e.y2, b: 0 }] };
  if (e.type === 'arc') {
    let a1 = e.a1; const a0 = e.a0;
    while (a1 <= a0) a1 += Math.PI * 2;
    return { ...base, closed: false, pts: [{ x: e.cx + e.r * Math.cos(a0), y: e.cy + e.r * Math.sin(a0), b: Math.tan((a1 - a0) / 4) }, { x: e.cx + e.r * Math.cos(a1), y: e.cy + e.r * Math.sin(a1), b: 0 }] };
  }
  if (e.type === 'spline') { const pts = S.polyline(e, precision); return { ...base, closed: !!e.closed, pts: pts.map((p) => ({ x: p.x, y: p.y, b: 0 })) }; }
  return null;
}

/** Fit curve / spline curve through (or along) a polyline's vertices, as a polyline with many short segments; the corners stay in `frame`. */
export function curvePoly(e, kind, perSpan = 8) {
  const frame = (e.frame || e.pts).map((p) => ({ x: p.x, y: p.y, b: 0 }));
  if (frame.length < 3) return e;
  const sp = kind === 'fit' ? S.fitSpline(frame, { closed: !!e.closed }) : S.cvSpline(frame, { degree: kind === 'quad' ? 2 : 3, closed: !!e.closed });
  if (!sp) return e;
  const pts = S.polyline(sp, perSpan).map((p) => ({ x: p.x, y: p.y, b: 0 }));
  if (pts.length < 2) return e;
  return { ...e, pts, frame, curve: kind };
}
export function decurvePoly(e) { if (!e.frame) return e; const out = { ...e, pts: e.frame.map((p) => ({ ...p })) }; delete out.frame; delete out.curve; return out; }
export function reversePoly(e) {
  const n = e.pts.length;
  const pts = e.pts.slice().reverse().map((p, j) => ({ ...p, b: e.closed ? -(e.pts[(n - 2 - j + n) % n].b || 0) : (j < n - 1 ? -(e.pts[n - 2 - j].b || 0) : 0) }));
  const out = { ...e, pts };
  if (e.frame) out.frame = e.frame.slice().reverse().map((p) => ({ ...p }));
  return out;
}

def('PEDIT', ['PE'], async (c) => {
  let multi = false;
  let ids;
  const pre = [...c.host.selection].map((id) => c.doc.get(id)).filter((e) => e && ['poly', 'line', 'arc', 'spline'].includes(e.type));
  if (pre.length) ids = new Set(pre.map((e) => e.id));
  else {
    const p = await c.entity(t('cmd.pedit.pick'), { options: [opt('M', t('cmd.pedit.multiple'))] });
    if (!p) return;
    if (p.option === 'M') { multi = true; ids = await c.select(t('cmd.pedit.select')); } else ids = new Set([p.id ?? p]);
  }
  let list = [...ids].map((id) => c.doc.get(id)).filter((e) => e && c.doc.editable(e) && ['poly', 'line', 'arc', 'spline'].includes(e.type));
  if (!list.length) { c.print(t('cmd.pedit.none')); return; }
  // lines, arcs and splines become polylines when asked
  const foreign = list.filter((e) => e.type !== 'poly');
  if (foreign.length) {
    const spl = foreign.some((e) => e.type === 'spline');
    const y = kw(await c.keyword(t(spl ? 'cmd.pedit.turn.spline' : 'cmd.pedit.turn', { n: foreign.length }), { options: [opt('Y', t('opt.yes')), opt('N', t('opt.no'))], default: 'Y' }), 'Y');
    if (y !== 'Y') { list = list.filter((e) => e.type === 'poly'); if (!list.length) return; } else {
      let prec = 10;
      if (spl) { const v = await c.number(t('cmd.pedit.precision'), { default: 10 }); if (Number.isInteger(v) && v >= 1 && v <= 99) prec = v; }
      const map = new Map();
      c.doc.change('PEDIT', () => {
        for (const e of foreign) { const p = toPoly(e, prec); if (!p) continue; c.doc.remove(e.id); const made = c.doc.add(p); map.set(e.id, made.id); }
      });
      list = list.map((e) => (map.has(e.id) ? c.doc.get(map.get(e.id)) : e)).filter(Boolean);
      c.print(t('cmd.pedit.turned', { n: map.size }));
    }
  }
  const idsOf = () => list.map((e) => e.id);
  const live = () => idsOf().map((id) => c.doc.get(id)).filter(Boolean);
  const apply = (label, fn) => { c.doc.change(label, () => { for (const e of live()) { const n = fn(e); if (n && n !== e) c.doc.update(e.id, { ...n }); } }); };
  c.host.setSelection(new Set(idsOf()));
  for (;;) {
    const es = live();
    if (!es.length) return;
    const e0 = es[0];
    const hasCurve = es.some((e) => e.frame);
    const options = [opt(es.every((e) => e.closed) ? 'O' : 'C', es.every((e) => e.closed) ? t('cmd.pedit.open') : t('cmd.pedit.close')), ...(multi || es.length === 1 ? [opt('J', t('cmd.pedit.join'))] : []),
      opt('W', t('cmd.pedit.width')), opt('F', t('cmd.pedit.fit')), opt('S', t('cmd.pedit.spline')), opt('D', t('cmd.pedit.decurve')), opt('L', t('cmd.pedit.ltgen')), opt('R', t('cmd.pedit.reverse')), opt('U', t('opt.undo')), opt('X', t('cmd.pedit.exit'))];
    const k = kw(await c.keyword(t('cmd.pedit.option'), { options, default: 'X' }), 'X');
    if (k === 'X') break;
    if (k === 'U') { c.doc.undo(); continue; }
    if (k === 'C') apply('PEDIT', (e) => ({ ...e, closed: true }));
    else if (k === 'O') apply('PEDIT', (e) => ({ ...e, closed: false }));
    else if (k === 'W') {
      const w = await c.distance(t('cmd.pedit.width.ask'), { default: e0.w || 0 });
      if (typeof w === 'number' && w >= 0) apply('PEDIT', (e) => { const n = { ...e, pts: e.pts.map((p) => { const q = { ...p }; delete q.sw; delete q.ew; return q; }) }; if (w > 0) n.w = w; else delete n.w; return n; });
    } else if (k === 'F') apply('PEDIT', (e) => curvePoly(e, 'fit'));
    else if (k === 'S') apply('PEDIT', (e) => curvePoly(e, 'cubic'));
    else if (k === 'D') { if (!hasCurve) c.print(t('cmd.pedit.nodecurve')); apply('PEDIT', (e) => decurvePoly(e)); }
    else if (k === 'L') apply('PEDIT', (e) => ({ ...e, lgen: e.lgen === false ? true : false }));
    else if (k === 'R') apply('PEDIT', (e) => reversePoly(e));
    else if (k === 'J') {
      const fuzz = await c.distance(t('cmd.pedit.fuzz'), { default: c.engine.peditFuzz ?? 0 });
      c.host.setSelection(new Set());   // the selection prompt would take the polyline itself as the answer
      const more = await c.select(t('cmd.pedit.join.select'));
      const target = live()[0];
      const others = [...more].map((id) => c.doc.get(id)).filter((e) => e && e.id !== target.id && ['line', 'arc', 'poly'].includes(e.type) && c.doc.editable(e));
      if (!others.length) { c.print(t('cmd.pedit.join.none')); continue; }
      c.engine.peditFuzz = typeof fuzz === 'number' ? fuzz : 0;
      const r = joinEntities([target, ...others], c.engine.peditFuzz > 0 ? c.engine.peditFuzz : null);
      if (!r.results.length) { c.print(t('cmd.pedit.join.none')); continue; }
      let first = null;
      c.doc.change('PEDIT', () => {
        for (const { from, to } of r.results) {
          for (const fid of from) c.doc.remove(fid);
          const x = { ...to }; delete x.id;
          const pl = to.type === 'poly' ? x : toPoly(x);
          const made = c.doc.add({ ...pl, layer: target.layer, color: target.color ?? null });
          first ||= made;
        }
      });
      list = [first].filter(Boolean);
      c.host.setSelection(new Set(idsOf()));
      c.print(t('cmd.pedit.joined', { n: r.results.reduce((a, x) => a + x.from.length, 0) }));
    }
    if (k !== 'J') c.host.setSelection(new Set(idsOf()));
  }
}, { help: () => t('cmd.pedit.help') });
