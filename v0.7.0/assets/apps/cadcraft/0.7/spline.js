/* SPDX-License-Identifier: Apache-2.0 */
/**
 * spline.js — real splines (0.7 D7.10): SPLINE, SPLINEDIT, PEDIT's curves. No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 * A spline object: { type: 'spline', degree (1–5, 3 by default), closed, fit?: [{x, y}], ctrl: [{x, y}], knots: [number],
 *                    weights?: [number] (one per control point; rational when they are not all 1), st?, et?: {x, y} (the
 *                    start / end tangent direction of a fit-point spline), periodic?: true (a closed spline made of a wrapped
 *                    control polygon) }
 * It is always drawn from `ctrl` + `knots` (+ `weights`): a B-spline of `degree`. `fit` is what a person edits when the spline
 * came from fit points; the control points are worked out from it (a clamped cubic through them, parameters by chord length,
 * the end tangents as given — the same curve cc-dwg works out for a DWG's fit-point splines, lib/dwg/spline-fit.js), so
 * editing a fit point rebuilds `ctrl` and `knots`. A spline with no `fit` is edited by its control points.
 *
 *   fitSpline(fit, { closed, st, et, degree })   → a spline object through those points (null when it cannot)
 *   cvSpline(ctrl, { degree, closed, weights })  → a spline object with that control polygon (clamped; closed = periodic)
 *   domain(e)                                    → [u0, u1] the parameter range that is drawn
 *   pointAt(e, u)                                → { x, y }
 *   points(e, { tol })                           → the curve as points, no further than `tol` (drawing units) from it
 *   polyline(e, precision)                       → points for a polyline: `precision` segments per knot span (PEDIT / SPLINEDIT)
 *   splineEnds(e)                                → { start, end }
 *   rebuild(e)                                   → e with ctrl / knots worked out again from its fit points
 *   editFit(e, i, pt) / addFit(e, pt, at) / deleteFit(e, i) / moveCtrl(e, i, pt) / setWeight(e, i, w) / reverse(e) / setClosed(e, on)
 *   insertKnot(e, u)                             → the same curve with one more control point (Boehm)
 *   toFit(e, n)                                  → fit points sampled on the curve (a spline given by control points becomes a fit one)
 *   fromPolylinePts(pts)                         → fitSpline through a polyline's vertices
 */
import { fitSplineControl } from './dwg/spline-fit.js';

const EPS = 1e-12;
const MAX_POINTS = 4000;

const P = (x, y) => ({ x, y });
const clean = (pts) => (pts || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => P(p.x, p.y));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (v) => { const L = Math.hypot(v.x, v.y); return L > EPS ? P(v.x / L, v.y / L) : null; };

/** Clamped uniform knots for n control points of degree p: p + 1 zeros, 1 … n − p − 1, p + 1 of n − p. */
export function clampedKnots(n, p) {
  const k = [];
  for (let i = 0; i <= p; i++) k.push(0);
  for (let i = 1; i < n - p; i++) k.push(i);
  for (let i = 0; i <= p; i++) k.push(n - p);
  return k;
}

/** A spline through fit points: a clamped cubic with chord-length parameters (the same one a DWG's fit-point spline means). */
export function fitSpline(fit, { closed = false, st = null, et = null, degree = 3 } = {}) {
  let pts = clean(fit);
  // drop repeated neighbours: the curve cannot pass the same place twice in a row
  pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-9);
  if (closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= 1e-9) pts.pop();
  if (pts.length < 2) return null;
  if (pts.length === 2) {   // a straight curve through two points: a degree-1 spline would not be a spline any more, keep a cubic with its control points on the line
    const [a, b] = pts;
    const ctrl = [a, P(a.x + (b.x - a.x) / 3, a.y + (b.y - a.y) / 3), P(a.x + 2 * (b.x - a.x) / 3, a.y + 2 * (b.y - a.y) / 3), b];
    return { type: 'spline', degree: 3, closed: false, fit: pts, ctrl, knots: clampedKnots(4, 3) };
  }
  const us = unit(st || P(0, 0)), ue = unit(et || P(0, 0));   // the end derivatives are given to the solver as unit directions
  st = us; et = ue;
  let q = pts, t0 = st ? { x: st.x, y: st.y, z: 0 } : null, t1 = et ? { x: et.x, y: et.y, z: 0 } : null;
  if (closed) {
    // a closed curve: the first point again at the end, both ends leaving along the chord across the join (one smooth curve)
    const a = pts[pts.length - 1], b = pts[0], c = pts[1];
    const dir = unit(P(c.x - a.x, c.y - a.y)) || P(1, 0);
    q = [...pts, P(b.x, b.y)];
    t0 = { x: dir.x, y: dir.y, z: 0 }; t1 = { x: dir.x, y: dir.y, z: 0 };
  }
  const r = fitSplineControl(q.map((p) => ({ x: p.x, y: p.y, z: 0 })), degree, t0, t1, 0);
  if (!r) return null;
  const e = { type: 'spline', degree: 3, closed: !!closed, fit: pts, ctrl: r.control.map((p) => P(p.x, p.y)), knots: r.knots };
  if (st && !closed) e.st = P(st.x, st.y);
  if (et && !closed) e.et = P(et.x, et.y);
  return e;
}

/** A spline with a control polygon. Closed: the polygon wraps (periodic, uniform knots). */
export function cvSpline(ctrl, { degree = 3, closed = false, weights = null } = {}) {
  const c = clean(ctrl);
  const p = Math.max(1, Math.min(5, degree | 0 || 3));
  const w = Array.isArray(weights) && weights.length === c.length && weights.every((x) => Number.isFinite(x) && x > 0) && weights.some((x) => Math.abs(x - 1) > 1e-12) ? weights.slice() : null;
  if (c.length < p + 1 || (closed && c.length < 3)) return null;
  if (!closed) return { type: 'spline', degree: p, closed: false, ctrl: c, knots: clampedKnots(c.length, p), ...(w ? { weights: w } : {}) };
  const wrap = c.concat(c.slice(0, p)), ww = w ? w.concat(w.slice(0, p)) : null;
  const knots = [];
  for (let i = 0; i < wrap.length + p + 1; i++) knots.push(i);
  return { type: 'spline', degree: p, closed: true, periodic: true, ctrl: wrap, knots, ...(ww ? { weights: ww } : {}) };
}

/** The parameter range that is drawn (a clamped spline: the whole knot vector; a periodic one: between its p-th and n-th knot). */
export function domain(e) {
  const k = e.knots, p = e.degree, n = e.ctrl.length;
  return [k[p], k[n]];
}

/** The curve at parameter u (de Boor; rational when `weights` are not all 1). */
export function pointAt(e, u) {
  const p = e.degree, n = e.ctrl.length, k = e.knots;
  const [lo, hi] = [k[p], k[n]];
  if (u <= lo) u = lo;
  if (u >= hi) u = hi - 1e-12 * Math.max(1, Math.abs(hi - lo));
  let span = p;
  while (span < n - 1 && u >= k[span + 1]) span++;
  const w = e.weights;
  const d = [];
  for (let j = 0; j <= p; j++) { const q = e.ctrl[span - p + j], wt = w ? w[span - p + j] : 1; d.push([q.x * wt, q.y * wt, wt]); }
  for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
    const i = span - p + j, den = k[i + p - r + 1] - k[i], a = den === 0 ? 0 : (u - k[i]) / den;
    d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
  }
  return P(d[p][0] / d[p][2], d[p][1] / d[p][2]);
}

/** Knot spans with some length (the intervals the curve is drawn over). */
function spans(e) {
  const k = e.knots, p = e.degree, n = e.ctrl.length, out = [];
  for (let i = p; i < n; i++) if (k[i + 1] - k[i] > EPS) out.push([k[i], k[i + 1]]);
  return out;
}

const cache = new WeakMap();
/** The curve as points: each span in as many pieces as keep it within `tol` of the true curve (flatness by the control polygon). */
export function points(e, { tol = 0 } = {}) {
  const key = tol > 0 ? tol : 0;
  const hit = cache.get(e);
  if (hit && hit.key === key) return hit.pts;
  const pts = [];
  if (!valid(e)) { cache.set(e, { key, pts }); return pts; }
  const sp = spans(e);
  const ctrl = e.ctrl;
  const w = Math.max(...ctrl.map((q) => q.x)) - Math.min(...ctrl.map((q) => q.x)), h = Math.max(...ctrl.map((q) => q.y)) - Math.min(...ctrl.map((q) => q.y));
  const size = Math.max(w, h, 1e-9);
  const eps = key || size * 4e-4;
  let budget = MAX_POINTS;
  for (let s = 0; s < sp.length; s++) {
    const [a, b] = sp[s];
    // pieces from the length of the control polygon over this span: more bend = more pieces
    const i0 = Math.min(e.ctrl.length - 1, e.degree + s);
    let poly = 0;
    for (let j = Math.max(0, i0 - e.degree); j < Math.min(e.ctrl.length - 1, i0); j++) poly += dist(e.ctrl[j], e.ctrl[j + 1]);
    const n = Math.max(4 * Math.max(1, e.degree - 1), Math.min(Math.floor(budget / Math.max(1, sp.length - s)), Math.ceil(Math.sqrt(poly / eps))));
    for (let i = s === 0 ? 0 : 1; i <= n; i++) pts.push(pointAt(e, a + (b - a) * (i / n)));
    budget -= n;
  }
  // the closing point is the true end of the curve
  if (pts.length) pts[pts.length - 1] = pointAt(e, domain(e)[1]);
  cache.set(e, { key, pts });
  return pts;
}

export function valid(e) {
  return !!e && Array.isArray(e.ctrl) && Array.isArray(e.knots) && Number.isInteger(e.degree) && e.degree >= 1 && e.ctrl.length > e.degree
    && e.knots.length === e.ctrl.length + e.degree + 1 && e.ctrl.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) && e.knots.every(Number.isFinite)
    && (!e.weights || (e.weights.length === e.ctrl.length && e.weights.every((x) => Number.isFinite(x) && x > 0)));
}

export function splineEnds(e) {
  const [a, b] = domain(e);
  return { start: pointAt(e, a), end: pointAt(e, b) };
}

/** Points for a polyline: `precision` segments in each knot span (at least 1; PEDIT / SPLINEDIT › Convert to polyline). */
export function polyline(e, precision = 10) {
  const n = Math.max(1, Math.min(99, precision | 0 || 10));
  const sp = spans(e), out = [];
  sp.forEach(([a, b], s) => { for (let i = s === 0 ? 0 : 1; i <= n; i++) out.push(pointAt(e, a + (b - a) * (i / n))); });
  if (out.length) out[out.length - 1] = pointAt(e, domain(e)[1]);
  return e.closed && out.length > 2 && dist(out[0], out[out.length - 1]) < 1e-9 ? out.slice(0, -1) : out;
}

/** Control points and knots worked out again from the fit points (after one of them changed). */
export function rebuild(e) {
  if (!e.fit) return e;
  const n = fitSpline(e.fit, { closed: e.closed, st: e.st, et: e.et, degree: e.degree });
  if (!n) return e;
  const { id, layer, color, lt, lw, lts, tr, ...rest } = e;
  void rest;
  return { ...e, ctrl: n.ctrl, knots: n.knots, fit: n.fit, degree: n.degree, closed: n.closed };
}

export const editFit = (e, i, pt) => (e.fit && i >= 0 && i < e.fit.length ? rebuild({ ...e, fit: e.fit.map((p, j) => (j === i ? P(pt.x, pt.y) : p)) }) : e);
/** Insert a fit point at position `at` (default: where it is nearest along the curve's fit order, i.e. at the end). */
export function addFit(e, pt, at = e.fit ? e.fit.length : 0) {
  if (!e.fit) return e;
  const f = e.fit.slice();
  f.splice(Math.max(0, Math.min(f.length, at)), 0, P(pt.x, pt.y));
  return rebuild({ ...e, fit: f });
}
export function deleteFit(e, i) {
  if (!e.fit || e.fit.length <= 2 || i < 0 || i >= e.fit.length) return e;
  return rebuild({ ...e, fit: e.fit.filter((_, j) => j !== i) });
}
/** Move a control point (the spline is then edited by its control points: its fit points are dropped). */
export function moveCtrl(e, i, pt) {
  if (i < 0 || i >= e.ctrl.length) return e;
  const ctrl = e.ctrl.map((p, j) => (j === i ? P(pt.x, pt.y) : p));
  if (e.periodic) {   // the wrapped copies move together
    const n = e.ctrl.length - e.degree;
    if (i < e.degree) ctrl[n + i] = P(pt.x, pt.y); else if (i >= n) ctrl[i - n] = P(pt.x, pt.y);
  }
  const { fit, st, et, ...rest } = e;
  void fit; void st; void et;
  return { ...rest, ctrl };
}
export function setWeight(e, i, w) {
  if (!(w > 0) || i < 0 || i >= e.ctrl.length) return e;
  const weights = (e.weights || e.ctrl.map(() => 1)).slice();
  weights[i] = w;
  if (e.periodic) { const n = e.ctrl.length - e.degree; if (i < e.degree) weights[n + i] = w; else if (i >= n) weights[i - n] = w; }
  const { fit, st, et, ...rest } = e;
  void fit; void st; void et;
  return { ...rest, weights: weights.every((x) => Math.abs(x - 1) < 1e-12) ? undefined : weights };
}

export function reverse(e) {
  const k = e.knots, hi = k[k.length - 1] + k[0];
  const knots = k.map((x) => hi - x).reverse();
  const out = { ...e, ctrl: e.ctrl.slice().reverse(), knots };
  if (e.weights) out.weights = e.weights.slice().reverse();
  if (e.fit) { out.fit = e.fit.slice().reverse(); if (e.st || e.et) { out.st = e.et ? P(-e.et.x, -e.et.y) : undefined; out.et = e.st ? P(-e.st.x, -e.st.y) : undefined; if (!out.st) delete out.st; if (!out.et) delete out.et; } }
  return out;
}

/** Sample n fit points on the curve (evenly in parameter): a spline given by control points becomes a fit-point one. */
export function toFit(e, n = 12) {
  const [a, b] = domain(e), pts = [];
  const m = Math.max(3, n);
  for (let i = 0; i < m; i++) pts.push(pointAt(e, a + (b - a) * (e.closed ? i / m : i / (m - 1))));
  return fitSpline(pts, { closed: e.closed });
}

/** Close or open a spline. Closing a fit spline joins its end to its start smoothly; a control one becomes periodic. */
export function setClosed(e, on) {
  if (!!e.closed === !!on) return e;
  if (e.fit) { const n = fitSpline(e.fit, { closed: on, degree: e.degree }); return n ? { ...n } : e; }
  if (on) { const base = e.periodic ? e.ctrl.slice(0, e.ctrl.length - e.degree) : e.ctrl; return cvSpline(base, { degree: e.degree, closed: true, weights: e.weights ? e.weights.slice(0, base.length) : null }) || e; }
  const base = e.periodic ? e.ctrl.slice(0, e.ctrl.length - e.degree) : e.ctrl;
  return cvSpline(base, { degree: e.degree, closed: false, weights: e.weights ? e.weights.slice(0, base.length) : null }) || e;
}

/**
 * The same curve with one more control point at parameter u (Boehm knot insertion) — SPLINEDIT › Refine › Add control point.
 * Fit data is dropped (the curve now has more control points than fit points describe).
 */
export function insertKnot(e, u) {
  const p = e.degree, k = e.knots, n = e.ctrl.length;
  const [lo, hi] = domain(e);
  if (!(u > lo + EPS && u < hi - EPS)) return e;
  let s = p;
  while (s < n - 1 && u >= k[s + 1]) s++;
  const w = e.weights || e.ctrl.map(() => 1);
  const Q = [], W = [];
  const hom = (i) => [e.ctrl[i].x * w[i], e.ctrl[i].y * w[i], w[i]];
  for (let i = 0; i <= n; i++) {
    if (i <= s - p) { Q.push(hom(i)); continue; }
    if (i > s) { Q.push(hom(i - 1)); continue; }
    const den = k[i + p] - k[i], a = den === 0 ? 0 : (u - k[i]) / den;
    const A = hom(i - 1), B = hom(i);
    Q.push([(1 - a) * A[0] + a * B[0], (1 - a) * A[1] + a * B[1], (1 - a) * A[2] + a * B[2]]);
  }
  const knots = [...k.slice(0, s + 1), u, ...k.slice(s + 1)];
  const ctrl = Q.map((q) => P(q[0] / q[2], q[1] / q[2]));
  const rational = Q.some((q) => Math.abs(q[2] - 1) > 1e-12);
  W.push(...Q.map((q) => q[2]));
  const { fit, st, et, ...rest } = e;
  void fit; void st; void et;
  return { ...rest, ctrl, knots, ...(rational ? { weights: W } : { weights: undefined }) };
}

/** A fit spline through a polyline's vertices (PEDIT / SPLINE › Object). */
export function fromPolylinePts(pts, closed = false) { return fitSpline(pts, { closed }); }

/** Fingerprint-friendly copy for the file side: control points with their weights. */
export function toModel(e) {
  return { degree: e.degree, closed: !!e.closed, periodic: !!e.periodic, ctrl: e.ctrl, knots: e.knots, weights: e.weights || null, fit: e.fit || null };
}

/**
 * A spline as a file holds it → a spline object, or null. `d` = { degree, closed, periodic, ctrl, weights, knots, fit, st, et }
 * (points {x, y}). Control points + knots win when they agree (degree + 1 more knots than control points); else the fit points
 * make the curve; else a lone control polygon makes a clamped spline of the highest degree it can have.
 */
export function fromFile(d) {
  const p = Math.max(1, Math.min(5, d.degree | 0 || 3));
  const ctrl = clean(d.ctrl), fit = clean(d.fit);
  const nz = (v) => (v && Number.isFinite(v.x) && Number.isFinite(v.y) && (Math.abs(v.x) > EPS || Math.abs(v.y) > EPS) ? P(v.x, v.y) : null);
  const st = nz(d.st), et = nz(d.et);
  if (ctrl.length > p && Array.isArray(d.knots) && d.knots.length === ctrl.length + p + 1 && d.knots.every(Number.isFinite)) {
    const w = Array.isArray(d.weights) && d.weights.length === ctrl.length && d.weights.every((x) => Number.isFinite(x) && x > 0) && d.weights.some((x) => Math.abs(x - 1) > 1e-12) ? d.weights.slice() : null;
    const e = { type: 'spline', degree: p, closed: !!d.closed, ...(d.periodic ? { periodic: true } : {}), ctrl, knots: d.knots.slice(), ...(w ? { weights: w } : {}),
      ...(fit.length >= 2 ? { fit } : {}), ...(st && fit.length >= 2 ? { st } : {}), ...(et && fit.length >= 2 ? { et } : {}) };
    if (valid(e) && domain(e)[1] > domain(e)[0]) return e;
  }
  if (fit.length >= 2) return fitSpline(fit, { closed: !!d.closed, st, et, degree: p });
  if (ctrl.length >= 2) return cvSpline(ctrl, { degree: Math.min(p, ctrl.length - 1), closed: !!d.closed && ctrl.length > p + 1 });
  return null;
}
