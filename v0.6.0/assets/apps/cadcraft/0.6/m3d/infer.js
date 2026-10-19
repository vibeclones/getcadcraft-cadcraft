/* SPDX-License-Identifier: Apache-2.0 */
/**
 * infer.js — picking and inference snapping. No DOM, no three.js (tests drive it with a Camera).
 *
 *   const sc = sceneOf(model)                       world-space faces/edges with their paths (cache by model.version)
 *   infer(sc, cam, x, y, opts) → {p, kind, tip, …}  what the cursor snaps to
 *   pick(sc, cam, x, y, {path}) → {t, id} | null    what a click selects in the open context
 *   pickWindow(sc, cam, rect, crossing, {path})     window (fully inside) or crossing (touching)
 *
 * Inference kinds: end, mid, center (of the face under the cursor), guidept, origin (points) · lock (a locked direction) · axis-x/y/z (from
 * the start point along red/green/blue) · parallel, perp (to the last edge hovered) · edge, guide
 * (on a line) · face · plane (on the drawing plane) · ground. A point snap wins inside its radius,
 * then axis/parallel/perpendicular, then on-edge, then on-face. Things hidden behind a face do not snap.
 * A point or edge snap that lies on the face under the cursor carries that face too (`face`), so a
 * rectangle or circle started there takes the face's plane (0.4 U.2).
 */
import { add, sub, mul, dot, cross, len, norm, dist, apply, rayTri, rayToSegment, lineLine, rayPlane, closestOnLine, planeFrom, applyDir } from './vec.js';
import { faceTris, faceNormal } from './model.js';
import { t } from "./i18n.js";

/** Inference tips in the page's language (getters: read when asked for). */
export const TIPS = Object.defineProperties({}, Object.fromEntries(['end', 'mid', 'center', 'guidept', 'origin', 'edge', 'guide', 'face', 'ground', 'plane', 'axis-x', 'axis-y', 'axis-z', 'parallel', 'perp', 'lock'].map((k) => [k, { get: () => t('m3d.tip.' + k.toLowerCase().replace(/[^a-z0-9]+/g, '_')), enumerable: true }])));

/** Flatten the model into world space once per version. */
export function sceneOf(model) {
  const faces = [], edges = [];
  // the active section cut (0.4 M7): what lies on the side it cuts away cannot be snapped to or picked either
  const cut = model.activeCut ? model.activeCut() : null;
  const keep = cut ? (p) => dot(sub(p, cut.p), cut.n) <= 1e-9 : null;
  // hidden things (0.4 M17) are left out: they cannot be snapped to, picked or window-selected
  (model.walkShown ? model.walkShown.bind(model) : model.walk.bind(model))((def, m, path) => {
    for (const [id, f] of def.faces) {
      if (f.hidden) continue;
      const tris = faceTris(def, f).map((t) => t.map((v) => apply(m, def.verts.get(v))));
      const n = norm(applyDir(m, faceNormal(def, f)));
      const P = apply(m, def.verts.get(f.loops[0][0]));
      if (keep && !tris.some((t) => t.some(keep))) continue;
      faces.push({ path, def: def.id, id, tris, n, plane: { n, d: dot(n, P) } });
    }
    for (const [id, e] of def.edges) {
      if (e.hidden) continue;
      const a = apply(m, def.verts.get(e.a)), b = apply(m, def.verts.get(e.b));
      if (keep && !keep(a) && !keep(b)) continue;
      edges.push({ path, def: def.id, id, a, b, soft: !!e.soft });
    }
  });
  return { faces, edges, guides: model.guides, version: model.version, keep };
}

const startsWith = (path, pre) => pre.every((x, i) => path[i] === x);

function faceHit(sc, ray, filter) {
  let best = null;
  for (const f of sc.faces) {
    if (filter && !filter(f)) continue;
    for (const [a, b, c] of f.tris) {
      const t = rayTri(ray.o, ray.d, a, b, c);
      if (t === null || (best && t >= best.t)) continue;
      const p = add(ray.o, mul(ray.d, t));
      if (sc.keep && !sc.keep(p)) continue;
      best = { t, f, p };
    }
  }
  return best;
}

/**
 * opts: from (start point), lockDir (a direction the result must stay on), ref (an edge {a,b} for
 * parallel/perpendicular), axes ({x,y,z} of the open context), plane (fallback drawing plane {n,d}),
 * skip(o, 'e'|'f') → true for things being moved (they must not snap to themselves), radius (px),
 * snap (false: no points, axes or edges — only a locked direction, faces, the drawing plane and the ground).
 */
export function infer(sc, cam, x, y, opts = {}) {
  const R = opts.radius ?? 12;
  const ray = cam.ray(x, y);
  const vp = cam.viewProj();
  const axes = opts.axes || { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const skip = typeof opts.skip === 'function' ? opts.skip : () => false;
  const visible = (fo) => !skip(fo, 'f');
  const hit = faceHit(sc, ray, visible);
  // is p hidden behind a face? (a ray of its own from the eye)
  const ax0 = cam.axes().z;
  const depthOk = (p) => {
    if (!hit) return true;
    let o, d, tp;
    if (cam.persp) { o = cam.eye; tp = dist(p, o); d = mul(sub(p, o), 1 / tp); }
    else { d = mul(ax0, -1); o = sub(p, mul(d, cam.far)); tp = cam.far; }
    const h2 = faceHit(sc, { o, d }, visible);
    return !h2 || h2.t >= tp - (tp * 1e-4 + 1e-5);
  };
  const scr = (p) => cam.project(p, vp);
  const sd = (p) => { const s = scr(p); return s ? Math.hypot(s[0] - x, s[1] - y) : Infinity; };

  // points
  let pt = null;
  const pts = [];
  const tryPt = (p, kind, bias, extra) => {
    if (sc.keep && !sc.keep(p)) return;
    const d = sd(p) + bias;
    if (d < R) pts.push({ p, kind, d, ...extra });
  };
  const snap = opts.snap !== false;
  for (const e of snap ? sc.edges : []) {
    if (skip(e, 'e')) continue;
    tryPt(e.a, 'end', -3, { edge: e });
    tryPt(e.b, 'end', -3, { edge: e });
    tryPt(mul(add(e.a, e.b), 0.5), 'mid', 0, { edge: e });
  }
  if (snap && hit) tryPt(faceCenter(hit.f), 'center', 0, { face: hit.f });
  if (snap) {
    for (const [gid, g] of sc.guides || []) if (g.kind === 'point') tryPt(g.p, 'guidept', -1, { guide: gid });
    tryPt(opts.origin || [0, 0, 0], 'origin', 1);
  }
  pts.sort((a, b) => a.d - b.d);
  for (const c of pts.slice(0, 6)) if (depthOk(c.p)) { pt = c; break; }

  // a locked direction (Shift or an arrow key) keeps the point on that line
  if (opts.from && opts.lockDir) {
    const d = norm(opts.lockDir);
    let p;
    if (pt) p = closestOnLine(pt.p, opts.from, d).p;
    else {
      const ll = lineLine(ray.o, ray.d, opts.from, d);
      p = ll ? ll.p2 : opts.from;
    }
    return { p, kind: 'lock', tip: (pt ? t('m3d.tip.locked_on', { tip: TIPS[pt.kind] }) : TIPS.lock), dir: d, lockKind: opts.lockKind };
  }
  // the face under the cursor, when p lies on it (in its plane, inside its outline or on it)
  const faceAt = (p) => (hit && onFace(hit.f, p) ? hit.f : undefined);
  if (pt) return { p: pt.p, kind: pt.kind, tip: TIPS[pt.kind], edge: pt.edge, guide: pt.guide, face: pt.face || faceAt(pt.p) };

  // lines from the start point: red/green/blue axes, parallel/perpendicular to the reference edge
  let ax = null;
  if (opts.from && snap) {
    const cands = [['axis-x', axes.x], ['axis-y', axes.y], ['axis-z', axes.z]];
    if (opts.ref) {
      const u = norm(sub(opts.ref.b, opts.ref.a));
      if (len(u)) {
        cands.push(['parallel', u]);
        const pn = opts.plane ? opts.plane.n : axes.z;
        const pp = norm(cross(pn, u));
        if (len(pp)) cands.push(['perp', pp]);
      }
    }
    for (const [kind, dir] of cands) {
      const ll = lineLine(ray.o, ray.d, opts.from, dir);
      if (!ll || ll.t < 0) continue;
      const d = sd(ll.p2);
      if (d < R && (!ax || d < ax.d) && dist(ll.p2, opts.from) > 1e-9) ax = { p: ll.p2, kind, d, dir: norm(dir) };
    }
  }

  // on an edge or a guide line
  let on = null;
  const ons = [];
  for (const e of snap ? sc.edges : []) {
    if (skip(e, 'e')) continue;
    const r = rayToSegment(ray.o, ray.d, e.a, e.b);
    if (r.t < 0 || (sc.keep && !sc.keep(r.onSeg))) continue;
    const d = sd(r.onSeg);
    if (d < R * 0.75) ons.push({ p: r.onSeg, kind: 'edge', d, edge: e });
  }
  for (const [gid, g] of snap ? sc.guides || [] : []) {
    if (g.kind !== 'line') continue;
    const ll = lineLine(ray.o, ray.d, g.p, g.d);
    if (!ll || ll.t < 0) continue;
    const d = sd(ll.p2);
    if (d < R * 0.75) ons.push({ p: ll.p2, kind: 'guide', d, guide: gid, gline: g });
  }
  ons.sort((a, b) => a.d - b.d);
  for (const c of ons.slice(0, 6)) if (depthOk(c.p)) { on = c; break; }

  if (ax && on) {
    // where the axis line meets the edge/guide: a strong point
    const od = on.edge ? sub(on.edge.b, on.edge.a) : on.gline.d;
    const oa = on.edge ? on.edge.a : on.gline.p;
    const ll = lineLine(opts.from, ax.dir, oa, od);
    if (ll && dist(ll.p1, ll.p2) < 1e-6 && sd(ll.p1) < R) return { p: ll.p1, kind: ax.kind, tip: t(on.kind === 'guide' ? 'm3d.tip.axis_guide' : 'm3d.tip.axis_edge', { axis: TIPS[ax.kind] }), dir: ax.dir, edge: on.edge };
  }
  if (ax && (!on || ax.d <= on.d)) return { p: ax.p, kind: ax.kind, tip: TIPS[ax.kind], dir: ax.dir };
  if (on) return { p: on.p, kind: on.kind, tip: TIPS[on.kind], edge: on.edge, guide: on.guide, face: faceAt(on.p) };
  if (hit) return { p: hit.p, kind: 'face', tip: TIPS.face, face: hit.f };
  // nothing under the cursor: the drawing plane, or the ground
  const pl = opts.plane || (opts.from ? horizontalOrFacing(cam, opts.from) : opts.ground || { n: [0, 0, 1], d: 0 });
  const g = rayPlane(ray.o, ray.d, pl);
  if (g && g.t > 0) return { p: g.p, kind: opts.plane ? 'plane' : 'ground', tip: opts.plane ? TIPS.plane : (opts.from ? '' : TIPS.ground) };
  const fb = rayPlane(ray.o, ray.d, planeFrom(cam.axes().z, opts.from || cam.target));
  return { p: fb ? fb.p : cam.target.slice(), kind: 'none', tip: '' };
}

/** The area centroid of a scene face (holes left out, since its triangles leave them out). */
export function faceCenter(f) {
  let A = 0, c = [0, 0, 0];
  for (const [a, b, d] of f.tris) {
    const w = len(cross(sub(b, a), sub(d, a)));
    A += w; c = add(c, mul(add(add(a, b), d), w / 3));
  }
  return A > 0 ? mul(c, 1 / A) : f.tris[0][0].slice();
}
/** Is p on scene face f: in its plane and inside its outline, or on it (within 1 µm, scaled with the size)? */
export function onFace(f, p) {
  const tol = 1e-6 * Math.max(1, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  if (Math.abs(dot(f.n, p) - f.plane.d) > tol) return false;
  for (const [a, b, c] of f.tris) if (triDist(p, a, b, c) <= tol) return true;
  return false;
}
/** Distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function triDist(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist(p, add(a, mul(ab, d1 / (d1 - d3))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist(p, add(a, mul(ac, d2 / (d2 - d6))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return dist(p, add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)))));
  const den = 1 / (va + vb + vc);
  return dist(p, add(a, add(mul(ab, vb * den), mul(ac, vc * den))));
}

/** A horizontal plane through p, unless we look at it edge-on — then a vertical one facing us. */
function horizontalOrFacing(cam, p) {
  const z = cam.axes().z;
  if (Math.abs(z[2]) > 0.08) return { n: [0, 0, 1], d: p[2] };
  const n = norm([z[0], z[1], 0]);
  return { n, d: dot(n, p) };
}

/** The thing a click selects inside the open context (`path`): {t: 'e'|'f'|'i'|'g', id, …} or null. */
export function pick(sc, cam, x, y, { path = [], radius = 7 } = {}) {
  const ray = cam.ray(x, y), vp = cam.viewProj();
  const inCtx = (o) => startsWith(o.path, path);
  const asSel = (o, t) => (o.path.length > path.length ? { t: 'i', id: o.path[path.length] } : { t, id: o.id });
  const hit = faceHit(sc, ray, inCtx);
  let best = null;
  for (const e of sc.edges) {
    if (!inCtx(e) || e.soft) continue;
    const r = rayToSegment(ray.o, ray.d, e.a, e.b);
    if (r.t < 0 || (sc.keep && !sc.keep(r.onSeg))) continue;
    const s = cam.project(r.onSeg, vp);
    if (!s) continue;
    const d = Math.hypot(s[0] - x, s[1] - y);
    if (d > radius || (best && d >= best.d)) continue;
    if (hit && r.t > hit.t + Math.max(1e-4, hit.t * 1e-3)) continue;
    best = { d, sel: asSel(e, 'e') };
  }
  if (best) return best.sel;
  if (hit) return asSel(hit.f, 'f');
  for (const [gid, g] of sc.guides || []) {
    const s = cam.project(g.kind === 'point' ? g.p : lineLine(ray.o, ray.d, g.p, g.d)?.p2 || g.p, vp);
    if (s && Math.hypot(s[0] - x, s[1] - y) <= radius) return { t: 'g', id: gid };
  }
  return null;
}

/** Window (left to right: wholly inside) or crossing (right to left: touching) selection. */
export function pickWindow(sc, cam, rect, crossing, { path = [] } = {}) {
  const vp = cam.viewProj();
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1), y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  const inside = (s) => s && s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1;
  const segIn = (a, b) => {
    const A = cam.project(a, vp), B = cam.project(b, vp);
    if (!A || !B) return false;
    return crossing ? segRect(A, B, x0, y0, x1, y1) : inside(A) && inside(B);
  };
  // per selectable item: every segment must pass (window) / any segment (crossing)
  const items = new Map();
  const put = (k, sel, okv) => {
    const it = items.get(k) || { sel, all: true, any: false };
    it.all = it.all && okv; it.any = it.any || okv;
    items.set(k, it);
  };
  for (const e of sc.edges) {
    if (!startsWith(e.path, path)) continue;
    const deeper = e.path.length > path.length;
    const sel = deeper ? { t: 'i', id: e.path[path.length] } : { t: 'e', id: e.id };
    if (!deeper && e.soft) continue;
    put(sel.t + sel.id, sel, segIn(e.a, e.b));
  }
  for (const f of sc.faces) {
    if (!startsWith(f.path, path)) continue;
    const deeper = f.path.length > path.length;
    const sel = deeper ? { t: 'i', id: f.path[path.length] } : { t: 'f', id: f.id };
    let all = true, any = false;
    for (const [a, b, c] of f.tris) for (const [p, q] of [[a, b], [b, c], [c, a]]) { const o = segIn(p, q); all = all && o; any = any || o; }
    if (crossing && !any) {
      // the window may sit wholly inside a face
      const c = [(x0 + x1) / 2, (y0 + y1) / 2];
      for (const [a, b, cc] of f.tris) {
        const A = cam.project(a, vp), B = cam.project(b, vp), C = cam.project(cc, vp);
        if (A && B && C && inTri2(c, A, B, C)) { any = true; break; }
      }
    }
    const it = items.get(sel.t + sel.id) || { sel, all: true, any: false };
    it.all = it.all && all; it.any = it.any || any;
    items.set(sel.t + sel.id, it);
  }
  return [...items.values()].filter((it) => (crossing ? it.any : it.all)).map((it) => it.sel);
}

function inTri2(p, a, b, c) {
  const s = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const d1 = s(a, b, p), d2 = s(b, c, p), d3 = s(c, a, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
/** Does segment A–B touch the rectangle? (Liang–Barsky) */
export function segRect(A, B, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1;
  const dx = B[0] - A[0], dy = B[1] - A[1];
  for (const [p, q] of [[-dx, A[0] - x0], [dx, x1 - A[0]], [-dy, A[1] - y0], [dy, y1 - A[1]]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/**
 * A dimension as drawn: dimLayout(model, dm, cam) → {pa, pb (measured points), qa, qb (the dimension line), L (length),
 * A, B (its screen ends, or null), M (screen middle, where the text goes)}. The offset is kept square to the measured line.
 */
export function dimLayout(model, dm, cam, vp = cam.viewProj()) {
  if (dm.kind === 'rad' || dm.kind === 'dia') return radialLayout(dm.c.path && model.radialAt ? model.radialAt(dm.c) : { c: dm.c.p, r: dm.c.r, n: dm.c.n }, dm, cam, vp);
  if (dm.kind === 'ang') return angleLayout(model.dimEnds(dm), dm.off, cam, vp);
  const [pa, pb] = model.dimEnds(dm);
  const ab = sub(pb, pa), L = len(ab);
  let off = dm.off;
  if (L > 1e-12) { const u = mul(ab, 1 / L); off = sub(off, mul(u, dot(off, u))); }
  const qa = add(pa, off), qb = add(pb, off);
  const A = cam.project(qa, vp), B = cam.project(qb, vp);
  return { kind: 'len', pa, pb, qa, qb, L, A, B, M: A && B ? [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2] : null, segs: A && B ? [[A, B]] : [] };
}
/** Two directions square to n (a plane's own axes), the first toward `hint` when it is not along n. */
function planeAxes(n, hint) {
  let u = sub(hint || [1, 0, 0], mul(n, dot(hint || [1, 0, 0], n)));
  if (len(u) < 1e-9) u = Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]);
  u = norm(u);
  return [u, cross(n, u)];
}
/**
 * A radius or diameter dimension (0.4 M5) as drawn: {kind, C (centre), P (on the curve, toward the text), Q (across it,
 * for a diameter), T (the text's point), L (the radius or diameter), lines (world segments to draw), arrows ([tip, from]
 * pairs), M (screen text point), segs (screen segments, for picking)}. g = {c, r, n} from model.radialAt.
 */
function radialLayout(g, dm, cam, vp) {
  if (!g) return { kind: dm.kind, L: 0, lines: [], arrows: [], M: null, segs: [] };
  const n = norm(g.n);
  let w = sub(dm.off, mul(n, dot(dm.off, n)));
  if (len(w) < 1e-9) w = mul(planeAxes(n)[0], g.r * 1.5);
  const u = norm(w), P = add(g.c, mul(u, g.r)), Q = add(g.c, mul(u, -g.r)), T = add(g.c, w);
  const out = len(w) > g.r, dia = dm.kind === 'dia';
  const lines = [[dia ? Q : g.c, out ? T : P]];
  const arrows = [[P, g.c]];
  if (dia) arrows.push([Q, g.c]);
  const proj = (p) => cam.project(p, vp);
  const segs = lines.map(([a, b]) => [proj(a), proj(b)]).filter(([a, b]) => a && b);
  return { kind: dm.kind, C: g.c, P, Q, T, L: dia ? 2 * g.r : g.r, live: g.live !== false, lines, arrows, M: proj(T), segs };
}
/**
 * An angle dimension (0.4 M5) as drawn: {kind: 'ang', o, L (the angle, radians), arc (world points along the dimension
 * arc), lines (extension lines from the corner), arrows, M (screen text point), segs}. ends = [o, a, b] (world);
 * off (world, from o) picks the angle — between the two lines, or one of the three beside them — and the arc's radius.
 */
export function angleLayout([o, a, b], off, cam, vp) {
  const u = norm(sub(a, o)), v0 = norm(sub(b, o));
  let n = cross(u, v0);
  const empty = { kind: 'ang', o, L: 0, arc: [], lines: [], arrows: [], M: null, segs: [] };
  if (len(n) < 1e-9 || !len(u) || !len(v0)) return empty;
  n = norm(n);
  const e2 = cross(n, u), th = Math.atan2(dot(v0, e2), dot(v0, u));   // 0 < th < π: the angle between the lines
  const w = sub(off, mul(n, dot(off, n)));
  const R = Math.max(len(w), 1e-6);
  let phi = Math.atan2(dot(w, e2), dot(w, u));
  if (phi < 0) phi += 2 * Math.PI;
  // the four angles the two lines make, each [start, sweep]: u→v, v→−u, −u→−v, −v→u
  const S = [[0, th], [th, Math.PI - th], [Math.PI, th], [Math.PI + th, Math.PI - th]];
  const [s0, sw] = S.find(([s, k]) => phi >= s - 1e-12 && phi <= s + k + 1e-12) || S[0];
  const at = (ang, r = R) => add(o, add(mul(u, r * Math.cos(ang)), mul(e2, r * Math.sin(ang))));
  const N = Math.max(4, Math.ceil(sw / (Math.PI / 48)));
  const arc = Array.from({ length: N + 1 }, (_, i) => at(s0 + (sw * i) / N));
  const lines = [[o, at(s0, R * 1.08)], [o, at(s0 + sw, R * 1.08)]];
  const arrows = [[arc[0], arc[1]], [arc[N], arc[N - 1]]];
  const proj = (p) => cam.project(p, vp);
  const segs = [];
  for (let i = 0; i < N; i++) { const A = proj(arc[i]), B = proj(arc[i + 1]); if (A && B) segs.push([A, B]); }
  return { kind: 'ang', o, L: sw, arc, lines, arrows, M: proj(at(s0 + sw / 2)), segs };
}
/** A dimension's text: a length, R and Ø before a radius and a diameter, degrees for an angle. fmt(m) writes a length. */
export function dimText(l, fmt) {
  if (l.kind === 'rad') return t('m3d.dim.radius', { len: fmt(l.L) });
  if (l.kind === 'dia') return t('m3d.dim.diameter', { len: fmt(l.L) });
  if (l.kind === 'ang') return t('m3d.dim.angle', { deg: formatDeg((l.L * 180) / Math.PI) });
  return fmt(l.L);
}
/**
 * A section plane as drawn (0.4 M7): {corners (a rectangle on the plane, around the model's extent there), arrows
 * ([from, to] at each corner, toward the side it cuts away)}. s = {p, n}.
 */
export function sectionLayout(model, s) {
  const n = norm(s.n), [u, v] = planeAxes(n, Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]);
  const bb = model.bbox ? model.bbox() : null;
  let u0 = -1, u1 = 1, v0 = -1, v1 = 1;
  if (bb) {
    u0 = v0 = Infinity; u1 = v1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c = [i & 1 ? bb.max[0] : bb.min[0], i & 2 ? bb.max[1] : bb.min[1], i & 4 ? bb.max[2] : bb.min[2]], q = sub(c, s.p);
      const a = dot(q, u), b = dot(q, v);
      u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
    }
    const pad = Math.max(u1 - u0, v1 - v0, 0.5) * 0.08;
    u0 -= pad; u1 += pad; v0 -= pad; v1 += pad;
  }
  const at = (a, b) => add(s.p, add(mul(u, a), mul(v, b)));
  const corners = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  const k = Math.max(u1 - u0, v1 - v0) * 0.07;
  return { corners, arrows: corners.map((c) => [c, add(c, mul(n, k))]) };
}
/** The section plane under screen point x, y ({t: 's', id} or null): on its outline or its arrows. */
export function pickSection(model, cam, x, y, radius = 6) {
  if (!model.sections?.size || model.sectionView?.planes === false) return null;
  const vp = cam.viewProj();
  let best = null;
  for (const [id, s] of model.sections) {
    const l = sectionLayout(model, s), P = l.corners.map((p) => cam.project(p, vp));
    if (P.some((q) => !q)) continue;
    const segs = [...P.map((q, i) => [q, P[(i + 1) % 4]]), ...l.arrows.map(([a, b]) => [cam.project(a, vp), cam.project(b, vp)]).filter(([a, b]) => a && b)];
    const d = Math.min(...segs.map(([A, B]) => segDist2(x, y, A, B)));
    if (d <= radius && (!best || d < best.d)) best = { d, id };
  }
  return best ? { t: 's', id: best.id } : null;
}
/** Degrees to 0.1°, without a trailing .0. */
export const formatDeg = (d) => String(Math.round(d * 10) / 10);
/** The box of a dimension's text centred on screen point M (the view draws it; a click inside picks it). */
export const dimTextBox = (M, text) => { const w = text.length * 7 + 12; return { x: M[0] - w / 2, y: M[1] - 10, w, h: 20 }; };
/** The dimension under screen point x, y ({t: 'd', id} or null): on its line or its text. fmt(m) writes a length. */
export function pickDim(model, cam, x, y, fmt, radius = 6) {
  if (!model.dims?.size) return null;
  const vp = cam.viewProj();
  let best = null;
  for (const [id, dm] of model.dims) {
    const l = dimLayout(model, dm, cam, vp);
    if (!l.M) continue;
    const b = dimTextBox(l.M, dimText(l, fmt));
    const d = x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h ? 0 : Math.min(Infinity, ...l.segs.map(([A, B]) => segDist2(x, y, A, B)));
    if (d <= radius && (!best || d < best.d)) best = { d, id };
  }
  return best ? { t: 'd', id: best.id } : null;
}
function segDist2(x, y, A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L2)) : 0;
  return Math.hypot(x - (A[0] + dx * t), y - (A[1] + dy * t));
}

/** The point where the pick ray meets the line through `o` along `dir` (push/pull, move along an axis). */
export function alongLine(cam, x, y, o, dir) {
  const ray = cam.ray(x, y);
  const ll = lineLine(ray.o, ray.d, o, dir);
  return ll ? { p: ll.p2, s: ll.s } : null;
}
export { rayPlane, planeFrom };
