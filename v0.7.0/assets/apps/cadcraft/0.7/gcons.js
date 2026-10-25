/* SPDX-License-Identifier: Apache-2.0 */
/**
 * gcons.js — 2D constraints on a CadCraft drawing (DOM-free; bin/test-cadcraft-constraints.mjs runs it).
 *
 * The constraints live in the undoable document, beside the parameter table (doc.js):
 *   doc.constraints = [{ id: 'k3', type, refs: [{ e: entityId, k }], …type fields }]
 *   doc.params      = { vars, links }   (params.js; dimensional constraints are parameters too, see below)
 * Both are replaced, never edited in place: doc.setParametric({ constraints, params }) inside doc.change() is one
 * undo step with whatever geometry moved.
 *
 * Geometric (GEOMETRIC): coincident (PP, PL point on a line or its extension, PR point on a circle/arc),
 * collinear (LL), concentric (RR), fix (P a point, E a whole object; `value` [x, y] / `fixed` {field: value}),
 * parallel, perpendicular (LL), horizontal, vertical (L, or PP), tangent (LR `sign` = side; RR, `kind` 'int' +
 * `sign` for one inside the other), symmetric (PPL, LLL with `pair` 0|1 = which ends match, RRL), equal (LL, RR).
 * Dimensional (DIMENSIONAL): hdist, vdist (PP, `sign` = which way), dist (PP, PL, LL), radius, diameter (R),
 * angle (LL with `dirs` [±1, ±1] and `sign`; R = an arc's sweep). Each has `name` (d1, rad1, dia1, ang1 as AutoCAD
 * names them), `value` (its last resolved number: lengths in drawing units, angles in degrees) and `off` (where
 * its label sits, relative to what it measures). Its expression is the parameter of the same name
 * (params.vars), and params.links holds { target: 'c:<id>', expr: '<name>' }, so names and user parameters share
 * one table, a name can be used in any expression, and typing a value into a driven constraint solves the
 * parameter behind it (params.js driveBack). See params-doc.js.
 *
 * Moving constrained geometry (MOVE, ROTATE, grips, Properties…) goes through doc.change(), which calls
 * afterEdit(): what the edit moved is pinned, the rest follows; if that cannot be met the pins come off; if it
 * still cannot be met the edit is refused (rolled back) and doc.note() says why. Erasing an object drops its
 * constraints (a dimensional one's parameter is written into anything that used it).
 *
 * Files (dxf.js, dwg-save.js, dwg-import.js): each constrained entity carries one CADCRAFT xdata string
 * "CCREF:<key>" (key "1", "2"…), and an unused block CADCRAFT_PARAMETRIC holds POINT entities, each with one
 * CADCRAFT string "CCPARAM:<n>:<text>" — the JSON below cut into 230-character pieces (one string per entity, so files
 * written by earlier builds read the same way). References go through the keys, never
 * through handles, so they survive any program renumbering handles; a program that drops the xdata or the block
 * just leaves plain geometry.
 *   { format: 'cadcraft-parametric', version: 1, refs: { key: entityType }, constraints: [… refs: [{ r: key, k }]],
 *     params: { vars, links } }
 */

import { solveSystem, analyze, components, residualOk, refKind, refPoint, refLine, refCircle, fieldsOf, getField, segCount, SOLVABLE } from './gsolve.js';
import { removeVar, removeLink, readParams, emptyParams, cloneParams, hasParams, varByName, nameProblem } from './params.js';
import { formatNumber, literal, NAME_RE } from './expr.js';

import { t } from './i18n.js';
const TAU = Math.PI * 2;

export const GEOMETRIC = {
  horizontal: { get label() { return t('gcons.type.horizontal'); }, sigs: ['L', 'PP'], glyph: 'H' },
  vertical: { get label() { return t('gcons.type.vertical'); }, sigs: ['L', 'PP'], glyph: 'V' },
  perpendicular: { get label() { return t('gcons.type.perpendicular'); }, sigs: ['LL'], glyph: '⊥' },
  parallel: { get label() { return t('gcons.type.parallel'); }, sigs: ['LL'], glyph: '∥' },
  tangent: { get label() { return t('gcons.type.tangent'); }, sigs: ['LR', 'RR'], glyph: 'T' },
  coincident: { get label() { return t('gcons.type.coincident'); }, sigs: ['PP', 'PL', 'PR'], glyph: '•' },
  concentric: { get label() { return t('gcons.type.concentric'); }, sigs: ['RR'], glyph: '◎' },
  collinear: { get label() { return t('gcons.type.collinear'); }, sigs: ['LL'], glyph: '⫽' },
  symmetric: { get label() { return t('gcons.type.symmetric'); }, sigs: ['PPL', 'LLL', 'RRL'], glyph: '⇔' },
  equal: { get label() { return t('gcons.type.equal'); }, sigs: ['LL', 'RR'], glyph: '=' },
  fix: { get label() { return t('gcons.type.fix'); }, sigs: ['P', 'E'], glyph: '⊕' },
};
export const DIMENSIONAL = {
  hdist: { get label() { return t('gcons.dimtype.hdist'); }, prefix: 'd', sigs: ['PP'], kind: 'length' },
  vdist: { get label() { return t('gcons.dimtype.vdist'); }, prefix: 'd', sigs: ['PP'], kind: 'length' },
  dist: { get label() { return t('gcons.dimtype.dist'); }, prefix: 'd', sigs: ['PP', 'PL', 'LL'], kind: 'length' },
  radius: { get label() { return t('gcons.dimtype.radius'); }, prefix: 'rad', sigs: ['R'], kind: 'length' },
  diameter: { get label() { return t('gcons.dimtype.diameter'); }, prefix: 'dia', sigs: ['R'], kind: 'length' },
  angle: { get label() { return t('gcons.dimtype.angle'); }, prefix: 'ang', sigs: ['LL', 'R'], kind: 'angle' },
};
export const TYPES = { ...GEOMETRIC, ...DIMENSIONAL };
export const isDim = (c) => !!DIMENSIONAL[c?.type];
export const targetKey = (c) => 'c:' + c.id;
export const LIMITS = Object.freeze({ constraints: 20000, payload: 8_000_000 });
export const PARAM_BLOCK = 'CADCRAFT_PARAMETRIC';

// ---------------------------------------------------------------- references

/** Where a constraint can grab an object: its points (P), and the curve itself (L / R). */
export function constraintPoints(e) {
  const out = [];
  const add = (k) => { const p = refPoint(e, k); if (p) out.push({ k, x: p.x, y: p.y }); };
  switch (e?.type) {
    case 'line': add('p1'); add('p2'); add('mid'); break;
    case 'circle': add('c'); break;
    case 'arc': add('s'); add('e'); add('c'); add('mid'); break;
    case 'point': add('p'); break;
    case 'poly': e.pts.forEach((_, i) => add('v' + i)); break;
    default: break;
  }
  return out;
}
/** The point reference of `e` nearest p (and how far). */
export function nearestPointRef(e, p) {
  let best = null;
  for (const q of constraintPoints(e)) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (!best || d < best.d) best = { k: q.k, d, x: q.x, y: q.y };
  }
  return best;
}
/** The curve reference at p: a line, a circle/arc, or the polyline segment nearest p. */
export function curveRef(e, p) {
  if (!e) return null;
  if (e.type === 'line') return 'L';
  if (e.type === 'circle' || e.type === 'arc') return 'R';
  if (e.type === 'poly') {
    let best = null, bd = Infinity;
    for (let i = 0; i < segCount(e); i++) {
      const d = segDist(e, i, p);
      if (d < bd) { bd = d; best = 's' + i; }
    }
    return best;
  }
  return null;
}
function segDist(e, i, p) {
  const a = e.pts[i], b = e.pts[(i + 1) % e.pts.length];
  if (Math.abs(a.b || 0) > 1e-12) {
    const k = refCircle(e, 's' + i);
    return Math.abs(Math.hypot(p.x - k.cx, p.y - k.cy) - k.r);
  }
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-300;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export const kindOfRef = (doc, r) => refKind(doc.model.get(r.e), r.k);
/** The signature a list of refs has ('PPL' …), or null when one does not resolve. */
export function signature(doc, refs) {
  let s = '';
  for (const r of refs) { const k = kindOfRef(doc, r); if (!k) return null; s += k; }
  return s;
}

/** Plain words for a reference: "the end of line 12", "polyline 4, segment 2". */
export function describeRef(doc, r) {
  const e = doc.model.get(r.e);
  if (!e) return t('gcons.deleted_object');
  const n = t('gcons.ref.object', { type: TYPE_WORD.includes(e.type) ? t('gcons.word.' + e.type) : e.type, id: r.e });
  switch (r.k) {
    case '*': case 'L': case 'R': case 'p': return n;
    case 'p1': case 's': return t('gcons.ref.start', { obj: n });
    case 'p2': case 'e': return t('gcons.ref.end', { obj: n });
    case 'mid': return t('gcons.ref.mid', { obj: n });
    case 'c': return t('gcons.ref.centre', { obj: n });
    default: return t(r.k[0] === 'v' ? 'gcons.ref.vertex' : 'gcons.ref.segment', { obj: n, i: +r.k.slice(1) + 1 });
  }
}
const TYPE_WORD = ['line', 'circle', 'arc', 'poly', 'point'];   // gcons.word.<type>
export function describeConstraint(doc, c) {
  const T = TYPES[c.type];
  const what = c.refs.map((r) => describeRef(doc, r)).join(', ');
  return isDim(c) ? t('gcons.describe.dim', { name: c.name, kind: T.label.toLowerCase(), what }) : t('gcons.describe', { label: T.label, what });
}

// ---------------------------------------------------------------- making constraints

const getter = (doc) => (id) => doc.model.get(id);
export const nextId = (cs) => 'k' + (cs.reduce((m, c) => Math.max(m, parseInt(String(c.id).slice(1), 10) || 0), 0) + 1);
/** The next free name with this prefix (d1, d2 …) in the parameter table. */
export function nextName(params, prefix, taken = new Set()) {
  for (let i = 1; ; i++) { const n = prefix + i; if (!varByName(params, n) && !taken.has(n)) return n; }
}

/**
 * A new constraint from the current geometry: signs, sides, the value a dimension measures now. → { c } | { error }.
 * opts: { id, name, loc ({x,y}: a dimension's label), value }.
 */
export function makeConstraint(doc, type, refs, opts = {}) {
  const T = TYPES[type];
  if (!T) return { error: t('gcons.unknown', { type }) };
  if (!doc.inModel && opts.space !== 'model') return { error: t('gcons.constraints_work_model_tab') };
  for (const r of refs) {
    const e = doc.model.get(r.e);
    if (!e || !SOLVABLE.has(e.type)) return { error: t('gcons.constraints_work_lines_polylines') };
  }
  const sig = signature(doc, refs);
  if (!sig || !T.sigs.includes(sig)) return { error: t('gcons.needs', { what: T.label, sigs: sigWords(T.sigs) }) };
  if (new Set(refs.map((r) => r.e + ':' + r.k)).size !== refs.length) return { error: t('gcons.pick_two_different_things') };
  const c = { id: opts.id || nextId(doc.constraints), type, refs: refs.map((r) => ({ e: r.e, k: r.k })) };
  const get = getter(doc);
  const P = (i) => refPoint(get(refs[i].e), refs[i].k);
  const L = (i) => refLine(get(refs[i].e), refs[i].k);
  const C = (i) => refCircle(get(refs[i].e), refs[i].k);
  switch (type) {
    case 'fix':
      if (sig === 'P') { const p = P(0); c.value = [p.x, p.y]; }
      else { const e = get(refs[0].e); c.fixed = Object.fromEntries(fieldsOf(e).map((f) => [f, getField(e, f)])); }
      break;
    case 'tangent':
      if (sig === 'LR') { c.sign = sdist(C(1), L(0)) >= 0 ? 1 : -1; }
      else {
        const a = C(0), b = C(1), d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
        if (d < Math.max(a.r, b.r) - 1e-12) { c.kind = 'int'; c.sign = a.r >= b.r ? 1 : -1; }
      }
      break;
    case 'symmetric':
      if (sig === 'LLL') {
        const a = L(0), b = L(1), m = L(2);
        const same = Math.hypot(...mirrorGap({ x: a.x1, y: a.y1 }, { x: b.x1, y: b.y1 }, m)) + Math.hypot(...mirrorGap({ x: a.x2, y: a.y2 }, { x: b.x2, y: b.y2 }, m));
        const swap = Math.hypot(...mirrorGap({ x: a.x1, y: a.y1 }, { x: b.x2, y: b.y2 }, m)) + Math.hypot(...mirrorGap({ x: a.x2, y: a.y2 }, { x: b.x1, y: b.y1 }, m));
        c.pair = swap < same ? 1 : 0;
      }
      break;
    case 'hdist': case 'vdist': {
      const a = P(0), b = P(1), d = type === 'hdist' ? b.x - a.x : b.y - a.y;
      c.sign = d >= 0 ? 1 : -1;
      break;
    }
    case 'dist':
      if (sig === 'PL') c.sign = sdist(P(0), L(1)) >= 0 ? 1 : -1;
      else if (sig === 'LL') { const l2 = L(1); c.sign = sdist({ x: l2.x1, y: l2.y1 }, L(0)) >= 0 ? 1 : -1; }
      break;
    case 'angle':
      if (sig === 'LL') {
        const l1 = L(0), l2 = L(1);
        const u = [l1.x2 - l1.x1, l1.y2 - l1.y1], v = [l2.x2 - l2.x1, l2.y2 - l2.y1];
        if (Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-9 * Math.hypot(...u) * Math.hypot(...v)) return { error: t('gcons.those_lines_parallel_there') };
        let s1 = 1, s2 = 1;
        if (opts.loc) {
          // the sector holding the label: each leg points from the corner toward the side the label is on
          const x = intersectLines(l1, l2);
          const w = [opts.loc.x - x.x, opts.loc.y - x.y];
          const bis = (a, b) => [a[0] / Math.hypot(...a) + b[0] / Math.hypot(...b), a[1] / Math.hypot(...a) + b[1] / Math.hypot(...b)];
          let best = -Infinity;
          for (const a of [1, -1]) for (const b of [1, -1]) {
            const m = bis(u.map((q) => q * a), v.map((q) => q * b)), sc = (m[0] * w[0] + m[1] * w[1]) / (Math.hypot(...m) || 1);
            if (sc > best) { best = sc; s1 = a; s2 = b; }
          }
        }
        c.dirs = [s1, s2];
        const uu = u.map((q) => q * s1), vv = v.map((q) => q * s2);
        c.sign = Math.atan2(uu[0] * vv[1] - uu[1] * vv[0], uu[0] * vv[0] + uu[1] * vv[1]) >= 0 ? 1 : -1;
      } else if (get(refs[0].e).type !== 'arc') return { error: t('gcons.angle_needs_two_lines') };
      break;
    default: break;
  }
  if (isDim(c)) {
    c.name = opts.name || nextName(doc.params, DIMENSIONAL[type].prefix);
    c.value = opts.value ?? measure(doc, c);
    c.off = labelOffset(doc, c, opts.loc);
  }
  return { c };
}
function sigWords(sigs) {
  const W = { P: t('gcons.sig.point'), L: t('gcons.sig.line'), R: t('gcons.circle_arc'), E: t('gcons.an_object') };
  return sigs.map((s) => s.split('').map((k) => W[k]).reduce((a, b) => t('gcons.sig.and', { a, b }))).reduce((a, b) => t('gcons.sig.or', { a, b }));
}
/** Signed distance of a point (or a circle's centre) from the infinite line l, left of its direction positive. */
const sdist = (p, l) => {
  const px = p.x ?? p.cx, py = p.y ?? p.cy, ux = l.x2 - l.x1, uy = l.y2 - l.y1;
  return (ux * (py - l.y1) - uy * (px - l.x1)) / (Math.hypot(ux, uy) || 1e-300);
};
function mirrorGap(a, b, l) {
  const ux = l.x2 - l.x1, uy = l.y2 - l.y1, L2 = ux * ux + uy * uy || 1e-300;
  const t = ((a.x - l.x1) * ux + (a.y - l.y1) * uy) / L2, fx = l.x1 + t * ux, fy = l.y1 + t * uy;
  return [2 * fx - a.x - b.x, 2 * fy - a.y - b.y];
}
function intersectLines(l1, l2) {
  const d1x = l1.x2 - l1.x1, d1y = l1.y2 - l1.y1, d2x = l2.x2 - l2.x1, d2y = l2.y2 - l2.y1;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-300) return { x: l1.x1, y: l1.y1 };
  const t = ((l2.x1 - l1.x1) * d2y - (l2.y1 - l1.y1) * d2x) / den;
  return { x: l1.x1 + d1x * t, y: l1.y1 + d1y * t };
}

/** What a dimensional constraint measures in the drawing now (≥ 0; degrees for angles). */
export function measure(doc, c, get = getter(doc)) {
  const P = (i) => refPoint(get(c.refs[i].e), c.refs[i].k);
  const L = (i) => refLine(get(c.refs[i].e), c.refs[i].k);
  const C = (i) => refCircle(get(c.refs[i].e), c.refs[i].k);
  const K = (i) => refKind(get(c.refs[i].e), c.refs[i].k);
  const s = c.sign || 1;
  switch (c.type) {
    case 'hdist': return s * (P(1).x - P(0).x);
    case 'vdist': return s * (P(1).y - P(0).y);
    case 'dist':
      if (K(1) === 'P') return Math.hypot(P(1).x - P(0).x, P(1).y - P(0).y);
      if (K(0) === 'P') return s * sdist(P(0), L(1));
      { const l2 = L(1); return s * sdist({ x: l2.x1, y: l2.y1 }, L(0)); }
    case 'radius': return C(0).r;
    case 'diameter': return 2 * C(0).r;
    case 'angle': {
      if (K(0) === 'R') { const e = get(c.refs[0].e); let sw = (e.a1 - e.a0) % TAU; if (sw <= 0) sw += TAU; return sw * 180 / Math.PI; }
      const l1 = L(0), l2 = L(1), [s1, s2] = c.dirs || [1, 1];
      const u = [(l1.x2 - l1.x1) * s1, (l1.y2 - l1.y1) * s1], v = [(l2.x2 - l2.x1) * s2, (l2.y2 - l2.y1) * s2];
      return s * Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) * 180 / Math.PI;
    }
    default: return 0;
  }
}

/** Where a dimension's label sits, kept relative to what it measures (so it follows the geometry). */
function labelOffset(doc, c, loc) {
  const a = anchor(doc, c);
  if (!a) return [0, 0];
  if (c.type === 'angle') {
    const r = loc ? Math.hypot(loc.x - a.x, loc.y - a.y) : a.r * 0.6;
    return [Math.max(r, 1e-9), 0];
  }
  if (!loc) {
    if (c.type === 'radius' || c.type === 'diameter') return [a.r * 0.7071 * 1.6, a.r * 0.7071 * 1.6];
    const n = a.n || [0, 1];
    return [n[0] * a.size * 0.25, n[1] * a.size * 0.25];
  }
  return [loc.x - a.x, loc.y - a.y];
}
/** The reference point a dimension's label hangs from: the middle of what it measures, a centre, a corner. */
function anchor(doc, c, get = getter(doc)) {
  try {
    const P = (i) => refPoint(get(c.refs[i].e), c.refs[i].k);
    const L = (i) => refLine(get(c.refs[i].e), c.refs[i].k);
    const C = (i) => refCircle(get(c.refs[i].e), c.refs[i].k);
    const K = (i) => refKind(get(c.refs[i].e), c.refs[i].k);
    switch (c.type) {
      case 'hdist': case 'vdist': case 'dist': {
        const [p, q] = dimPoints(c, get, P, L, K);
        const dx = q.x - p.x, dy = q.y - p.y, L2 = Math.hypot(dx, dy) || 1;
        const n = c.type === 'hdist' ? [0, 1] : c.type === 'vdist' ? [-1, 0] : [-dy / L2, dx / L2];
        return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, n, size: Math.max(L2, 1e-6) };
      }
      case 'radius': case 'diameter': { const k = C(0); return { x: k.cx, y: k.cy, r: k.r }; }
      case 'angle': {
        if (K(0) === 'R') { const e = get(c.refs[0].e); return { x: e.cx, y: e.cy, r: e.r }; }
        const l1 = L(0), l2 = L(1), x = intersectLines(l1, l2);
        return { x: x.x, y: x.y, r: Math.min(Math.hypot(l1.x2 - l1.x1, l1.y2 - l1.y1), Math.hypot(l2.x2 - l2.x1, l2.y2 - l2.y1)) };
      }
      default: return null;
    }
  } catch { return null; }
}
/** The two points a linear dimensional constraint measures between. */
function dimPoints(c, get, P, L, K) {
  if (K(1) === 'P') return [P(0), P(1)];
  if (K(0) === 'P') { const p = P(0); return [p, foot(p, L(1))]; }
  const l2 = L(1), p = { x: l2.x1, y: l2.y1 };
  return [foot(p, L(0)), p];
}
function foot(p, l) {
  const ux = l.x2 - l.x1, uy = l.y2 - l.y1, L2 = ux * ux + uy * uy || 1e-300;
  const t = ((p.x - l.x1) * ux + (p.y - l.y1) * uy) / L2;
  return { x: l.x1 + t * ux, y: l.y1 + t * uy };
}

// ---------------------------------------------------------------- display

/** The label of a dimensional constraint: "d1=40", or "fx: d1=width/2" when an expression drives it. */
export function labelOf(c, params) {
  const v = params ? varByName(params, c.name) : null;
  const expr = v ? v.expr : formatNumber(round6(c.value));
  const lit = literal(expr);
  if (lit !== null) return c.name + '=' + fmtValue(c, c.value);
  return 'fx: ' + c.name + '=' + expr;
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
export const fmtValue = (c, v) => (c.type === 'angle' ? formatNumber(round6(v)) + '°' : formatNumber(round6(v)));

/**
 * A dimension entity (dims.js shape) that draws a dimensional constraint where it is now, labelled. Null when
 * the geometry makes it undrawable (parallel lines for an angle, a zero-length span).
 */
export function dimEntityFor(doc, c, st = null) {
  const get = getter(doc);
  if (!c.refs.every((r) => get(r.e) && refKind(get(r.e), r.k))) return null;
  const P = (i) => refPoint(get(c.refs[i].e), c.refs[i].k);
  const L = (i) => refLine(get(c.refs[i].e), c.refs[i].k);
  const C = (i) => refCircle(get(c.refs[i].e), c.refs[i].k);
  const K = (i) => refKind(get(c.refs[i].e), c.refs[i].k);
  const a = anchor(doc, c, get);
  if (!a) return null;
  const off = c.off || [0, 0];
  const base = { type: 'dim', layer: '0', color: null, text: labelOf(c, doc.params), st: { ...(st || doc.current?.dim || {}) } };
  switch (c.type) {
    case 'hdist': case 'vdist': case 'dist': {
      const [p1, p2] = dimPoints(c, get, P, L, K);
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1e-12) return null;
      const loc = { x: a.x + off[0], y: a.y + off[1] };
      if (c.type === 'dist') return { ...base, kind: 'aligned', p1, p2, loc };
      return { ...base, kind: 'linear', p1, p2, loc, rot: c.type === 'hdist' ? 0 : Math.PI / 2 };
    }
    case 'radius': case 'diameter': {
      const k = C(0), d = Math.hypot(off[0], off[1]) || 1;
      const u = { x: off[0] / d, y: off[1] / d };
      return { ...base, kind: c.type, c: { x: k.cx, y: k.cy }, p1: { x: k.cx + u.x * k.r, y: k.cy + u.y * k.r }, loc: { x: k.cx + off[0], y: k.cy + off[1] } };
    }
    case 'angle': {
      const R = off[0] || a.r * 0.6;
      if (K(0) === 'R') {
        const e = get(c.refs[0].e);
        let sw = (e.a1 - e.a0) % TAU; if (sw <= 0) sw += TAU;
        const m = e.a0 + sw / 2, cen = { x: e.cx, y: e.cy };
        return { ...base, kind: 'angular', c: cen, p1: { x: cen.x + Math.cos(e.a0) * e.r, y: cen.y + Math.sin(e.a0) * e.r }, p2: { x: cen.x + Math.cos(e.a1) * e.r, y: cen.y + Math.sin(e.a1) * e.r }, loc: { x: cen.x + Math.cos(m) * R, y: cen.y + Math.sin(m) * R } };
      }
      const l1 = L(0), l2 = L(1), [s1, s2] = c.dirs || [1, 1];
      const u = [(l1.x2 - l1.x1) * s1, (l1.y2 - l1.y1) * s1], v = [(l2.x2 - l2.x1) * s2, (l2.y2 - l2.y1) * s2];
      const lu = Math.hypot(...u), lv = Math.hypot(...v);
      if (Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-9 * lu * lv) return null;
      const b = [u[0] / lu + v[0] / lv, u[1] / lu + v[1] / lv], lb = Math.hypot(...b) || 1;
      const cen = { x: a.x, y: a.y };
      return { ...base, kind: 'angular', c: cen, p1: { x: cen.x + u[0] / lu * R, y: cen.y + u[1] / lu * R }, p2: { x: cen.x + v[0] / lv * R, y: cen.y + v[1] / lv * R }, loc: { x: cen.x + b[0] / lb * R, y: cen.y + b[1] / lb * R } };
    }
    default: return null;
  }
}

/** Where each object's constraint bar goes: { entityId → { x, y, list: [constraint] } } (coincident ones excluded). */
export function barsFor(doc) {
  const out = new Map();
  for (const c of doc.constraints) {
    if (isDim(c) || c.type === 'coincident') continue;
    for (const r of c.refs) {
      const e = doc.model.get(r.e);
      if (!e) continue;
      if (!out.has(r.e)) out.set(r.e, { e, list: [] });
      const b = out.get(r.e);
      if (!b.list.includes(c)) b.list.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------- solving

/**
 * Solve the groups of `constraints` that touch `only` (ids; null = every group) against the drawing.
 * pinned: Set('<id>|<field>') held where they are (a dragged grip); when that cannot be met the pins come off
 * (unless `strict`). → { ok, updates: Map(id → entity), conflicts: [cid], freed }.
 */
export function solveConstraints(doc, constraints, { pinned = null, only = null, strict = false, get = getter(doc) } = {}) {
  const updates = new Map();
  let freed = false;
  const conflicts = [];
  const groups = components(constraints).filter((g) => !only || g.some((c) => c.refs.some((r) => only.has(r.e))));
  for (const g of groups) {
    const cur = (id) => updates.get(id) || get(id);
    let r = solveSystem(g, cur, { pinned });
    if (!r.ok && pinned && pinned.size && !strict) { r = solveSystem(g, cur); freed = true; }
    if (r.ok) {
      // a solution that collapses a line, a segment or a radius to nothing is no solution (H + V on one line)
      const flat = [...r.updates].filter(([id, e]) => collapsed(cur(id), e)).map(([id]) => id);
      if (flat.length) { conflicts.push(...g.filter((c) => c.refs.some((q) => flat.includes(q.e))).map((c) => c.id)); continue; }
    }
    if (!r.ok) { conflicts.push(...(r.worst.length ? r.worst : g.map((c) => c.id))); continue; }
    for (const [id, e] of r.updates) updates.set(id, e);
  }
  return { ok: conflicts.length === 0, updates, conflicts, freed };
}

/** Did solving shrink a line, a polyline segment or a radius to (almost) nothing? */
function collapsed(was, now) {
  const tiny = (a, b) => b < 1e-6 * Math.max(a, 1e-300) && a > 1e-9;
  if (now.type === 'line') return tiny(Math.hypot(was.x2 - was.x1, was.y2 - was.y1), Math.hypot(now.x2 - now.x1, now.y2 - now.y1));
  if (now.type === 'circle' || now.type === 'arc') return tiny(was.r, now.r);
  if (now.type === 'poly') {
    for (let i = 0; i < segCount(now); i++) {
      const j = (i + 1) % now.pts.length;
      if (tiny(Math.hypot(was.pts[j].x - was.pts[i].x, was.pts[j].y - was.pts[i].y), Math.hypot(now.pts[j].x - now.pts[i].x, now.pts[j].y - now.pts[i].y))) return true;
    }
  }
  return false;
}

/** Degrees of freedom, conflicts and redundancies of the constrained geometry (cached per drawing version). */
export function status(doc) {
  if (doc._pstatus && doc._pstatus.version === doc.version && doc._pstatus.constraints === doc.constraints) return doc._pstatus.value;
  const value = { count: doc.constraints.length, dof: 0, conflicts: [], redundant: [], determined: new Set(), objects: 0 };
  const cs = doc.constraints.filter((c) => c.refs.every((r) => doc.model.get(r.e)));
  for (const g of components(cs)) {
    const a = analyze(g, getter(doc));
    value.dof += a.dof; value.conflicts.push(...a.conflicts); value.redundant.push(...a.redundant);
    for (const id of a.determined) value.determined.add(id);
  }
  value.objects = new Set(cs.flatMap((c) => c.refs.map((r) => r.e))).size;
  doc._pstatus = { version: doc.version, constraints: doc.constraints, value };
  return value;
}
export function statusText(doc) {
  const s = status(doc);
  if (!s.count) return t('gcons.no_constraints');
  const count = t('gcons.status.count', { n: s.count, objects: t('gcons.n.objects', { n: s.objects }) });
  const state = s.conflicts.length ? t('gcons.status.notmet', { n: s.conflicts.length })
    : s.redundant.length ? t('gcons.status.over', { n: s.redundant.length })
      : s.dof === 0 ? t('gcons.fully_constrained') : t('gcons.status.dof', { n: s.dof });
  return t('gcons.status.line', { count, state });
}

/** Parameters of dimensional constraints that are going away: their values are written into anything using them. */
export function dropDimParams(params, dropped) {
  const p = cloneParams(params);
  for (const c of dropped) {
    if (!isDim(c)) continue;
    removeLink(p, targetKey(c));
    if (varByName(p, c.name)) removeVar(p, c.name, { inline: true });
  }
  return p;
}

/** Does a constraint still fit the drawing (its objects there, its references the right kinds)? */
export function fits(doc, c) {
  const sig = signature(doc, c.refs);
  return !!sig && TYPES[c.type].sigs.includes(sig);
}

/**
 * doc.change() calls this before it records a change (pending ops still open): drop constraints whose objects
 * went, then re-solve what moved, with the moved fields pinned. → null, or { refuse: message } (the change is
 * then rolled back by doc.change).
 */
export function afterEdit(doc, ops) {
  if (doc.solving || !doc.constraints.length) return null;
  const model = doc.model;
  const before = new Map();
  for (const op of ops) if (op.map === model && op.id !== undefined && !before.has(op.id)) before.set(op.id, op.before);
  if (!before.size) return null;
  const refIds = new Set();
  for (const c of doc.constraints) for (const r of c.refs) refIds.add(r.e);
  const hit = [...before.keys()].filter((id) => refIds.has(id));
  if (!hit.length) return null;
  const keep = [], dropped = [];
  for (const c of doc.constraints) (fits(doc, c) ? keep : dropped).push(c);
  // what moved: each changed field of each constrained object is held where the edit put it
  const pinned = new Set();
  for (const id of hit) {
    const was = before.get(id), now = model.get(id);
    if (!was || !now || was.type !== now.type) continue;
    if (now.type === 'poly' && (was.pts.length !== now.pts.length || was.closed !== now.closed)) continue;
    for (const f of fieldsOf(now)) {
      const a = getField(was, f), b = getField(now, f);
      if (Math.abs(a - b) > 1e-12 * Math.max(1, Math.abs(a))) pinned.add(id + '|' + f);
    }
  }
  const notes = [];
  if (dropped.length) {
    doc.setParametric({ constraints: keep, params: dropDimParams(doc.params, dropped) });
    notes.push(t('gcons.note.dropped', { n: dropped.length }));
  }
  if (pinned.size) {
    const movedIds = new Set([...pinned].map((k) => +k.split('|')[0]));
    const wasGet = (id) => (before.has(id) ? before.get(id) : model.get(id));
    // a group that was not met before this edit (an imported drawing, say) is left as it is
    const groups = components(keep).filter((g) => g.some((c) => c.refs.some((r) => movedIds.has(r.e))) && residualOk(g, wasGet));
    if (groups.length) {
      const r = solveConstraints(doc, groups.flat(), { pinned, only: movedIds });
      if (!r.ok) {
        const names = [...new Set(r.conflicts)].map((id) => keep.find((c) => c.id === id)).filter(Boolean).slice(0, 3).map((c) => describeConstraint(doc, c));
        return { refuse: t('gcons.refuse.follow', { names: names.join('; ') }) };
      }
      // pins off and everything went straight back: the edit cannot happen at all (fully constrained, or fixed)
      if (r.freed && [...movedIds].every((id) => { const e = r.updates.get(id), was = before.get(id); return !was || !e || fieldsOf(e).every((f) => Math.abs(getField(e, f) - getField(was, f)) <= 1e-7 * Math.max(1, Math.abs(getField(was, f)))); })) {
        const held = keep.filter((c) => c.refs.some((q) => movedIds.has(q.e)) && (c.type === 'fix' || isDim(c))).slice(0, 3).map((c) => describeConstraint(doc, c));
        return { refuse: t(held.length ? 'gcons.refuse.hold.list' : 'gcons.refuse.hold', { n: movedIds.size, list: held.join('; ') }) };
      }
      const followers = [...r.updates.keys()].filter((id) => !movedIds.has(id)).length;
      for (const [id, e] of r.updates) doc.update(id, e, model);
      if (r.freed) notes.push(t('gcons.constraints_held_what_you'));
      else if (followers) notes.push(t('gcons.note.followed', { n: followers }));
    }
  }
  if (notes.length) doc.note?.(notes.join(' '));
  return null;
}

// ---------------------------------------------------------------- files

/** The parametric data of a drawing for a file. → null when there is none, else { refs: Map(id → key), points: [[strings]], text }. */
export function forFile(doc) {
  const cs = doc.constraints.filter((c) => c.refs.every((r) => doc.model.get(r.e)));
  if (!cs.length && !hasParams(doc.params)) return null;
  const refs = new Map();
  const types = {};
  for (const c of cs) for (const r of c.refs) if (!refs.has(r.e)) { const key = String(refs.size + 1); refs.set(r.e, key); types[key] = doc.model.get(r.e).type; }
  const payload = { format: 'cadcraft-parametric', version: 1, refs: types, constraints: cs.map((c) => ({ ...c, refs: c.refs.map((r) => ({ r: refs.get(r.e), k: r.k })) })), params: cloneParams(doc.params) };
  const text = JSON.stringify(payload).replace(/[^\x21-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  const points = [];
  for (let i = 0; i < text.length; i += 230) points.push(['CCPARAM:' + (points.length + 1) + ':' + text.slice(i, i + 230)]);
  return { refs, points, text };
}

/** The payload text from the CADCRAFT_PARAMETRIC block's points (each `cc` = CADCRAFT xdata strings). */
export function parametricText(ents) {
  const parts = [];
  for (const e of ents || []) {
    if (!Array.isArray(e.cc)) continue;
    const m = /^CCPARAM:(\d{1,7}):(.*)$/s.exec(String(e.cc[0] ?? ''));
    if (m) parts.push({ n: +m[1], s: m[2] });
  }
  parts.sort((a, b) => a.n - b.n);
  return parts.map((p) => p.s).join('');
}
export const isParamBlock = (name) => String(name || '').toUpperCase() === PARAM_BLOCK;

/** The CCREF key in an entity's CADCRAFT xdata strings, or null. */
export function refKeyIn(strings) {
  if (!Array.isArray(strings)) return null;
  for (const s of strings) { const m = /^CCREF:(\d{1,9})$/.exec(String(s)); if (m) return m[1]; }
  return null;
}
/** The first string of an entity's CADCRAFT xdata (the drawing model's { APPNAME: [[code, value]…] }), or null. */
export function cadcraftString(xdata) {
  if (!xdata || typeof xdata !== 'object') return null;
  const k = Object.keys(xdata).find((n) => n.toUpperCase() === 'CADCRAFT');
  const first = k && Array.isArray(xdata[k]) ? xdata[k][0] : null;
  return Array.isArray(first) && first[0] === 1000 ? String(first[1] ?? '') : null;
}
/** dwg-import.js: tag a converted entity with what CadCraft wrote in its CADCRAFT xdata. */
export function tagFromXdata(conv, xdata) {
  if (!conv || Array.isArray(conv)) return conv;
  const first = cadcraftString(xdata);
  if (first === null) return conv;
  const key = refKeyIn([first]);
  if (key) conv.ccref = key;
  if (first.startsWith('CCPARAM:')) conv.cc = [first];
  return conv;
}

const REF_KEY = /^(p1|p2|mid|L|c|R|s|e|p|\*|[vs]\d{1,6})$/;
const FIELD_KEY = /^(x1|y1|x2|y2|cx|cy|r|a0|a1|x|y|\d{1,6}[xy])$/;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Untrusted parametric data (a file's payload, text or object) + the file's entities (Map key → { id, type })
 * → { constraints, params, notes }. Constraints whose objects are missing or changed kind are dropped (said).
 */
export function resolveParametric(raw, refMap) {
  const notes = [];
  const empty = { constraints: [], params: emptyParams(), notes };
  let p = raw;
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.payload) { notes.push(t('gcons.file.too_large')); return empty; }
    try { p = JSON.parse(raw); } catch { notes.push(t('gcons.file.unreadable')); return empty; }
  }
  if (!p || typeof p !== 'object' || p.format !== 'cadcraft-parametric' || p.version !== 1 || !Array.isArray(p.constraints)) {
    notes.push(t('gcons.file.unknown_form'));
    return empty;
  }
  if (p.constraints.length > LIMITS.constraints) { notes.push(t('gcons.file.too_many')); return empty; }
  const out = [];
  let lost = 0;
  const ids = new Set();
  for (const c of p.constraints) {
    const k = cleanConstraint(c, refMap);
    if (!k || ids.has(k.id)) { lost++; continue; }
    ids.add(k.id);
    out.push(k);
  }
  // names of dimensional constraints must be unique and valid
  const names = new Set();
  const kept = [];
  for (const c of out) {
    if (isDim(c)) { if (names.has(c.name)) { lost++; continue; } names.add(c.name); }
    kept.push(c);
  }
  let params = emptyParams();
  if (p.params) {
    const links = Array.isArray(p.params.links) ? p.params.links.filter((l) => l && typeof l.target === 'string' && kept.some((c) => isDim(c) && targetKey(c) === l.target)) : [];
    const droppedLinks = (Array.isArray(p.params.links) ? p.params.links.length : 0) - links.length;
    try { params = readParams({ vars: p.params.vars ?? [], links }, { targetKeys: new Set(kept.filter(isDim).map(targetKey)) }); }
    catch (err) { notes.push(t('gcons.note.params_unreadable', { why: err.message })); params = emptyParams(); }
    if (droppedLinks > 0) notes.push(t('gcons.note.links_dropped', { n: droppedLinks }));
  }
  // every dimensional constraint has its parameter and link (a file from elsewhere may lack them)
  for (const c of kept) {
    if (!isDim(c)) continue;
    if (!varByName(params, c.name)) {
      if (nameProblem(c.name, params)) { c.name = nextName(params, DIMENSIONAL[c.type].prefix); }
      params.vars.push({ name: c.name, expr: formatNumber(round6(c.value)) });
    }
    if (!params.links.some((l) => l.target === targetKey(c))) params.links.push({ target: targetKey(c), expr: c.name });
  }
  if (lost) notes.push(t('gcons.note.lost', { n: lost }));
  return { constraints: kept, params, notes };
}

function cleanConstraint(c, refMap) {
  if (!c || typeof c !== 'object' || !TYPES[c.type] || typeof c.id !== 'string' || !/^k\d{1,9}$/.test(c.id) || !Array.isArray(c.refs) || c.refs.length < 1 || c.refs.length > 3) return null;
  const refs = [];
  let sig = '';
  for (const r of c.refs) {
    if (!r || typeof r.k !== 'string' || !REF_KEY.test(r.k)) return null;
    let id;
    if (refMap) {
      const m = refMap.get(String(r.r));
      if (!m) return null;
      id = m.id;
      if (m.e) { const k = refKind(m.e, r.k); if (!k) return null; sig += k; }   // the object read must still fit
    } else { if (!Number.isInteger(r.e)) return null; id = r.e; }
    refs.push({ e: id, k: r.k });
  }
  if (sig && !TYPES[c.type].sigs.includes(sig)) return null;
  const k = { id: c.id, type: c.type, refs };
  if (c.sign === 1 || c.sign === -1) k.sign = c.sign;
  if (c.kind === 'int') k.kind = 'int';
  if (c.pair === 0 || c.pair === 1) k.pair = c.pair;
  if (Array.isArray(c.dirs) && c.dirs.length === 2 && c.dirs.every((d) => d === 1 || d === -1)) k.dirs = [...c.dirs];
  if (c.type === 'fix') {
    if (Array.isArray(c.value) && c.value.length === 2 && c.value.every(fin)) k.value = [...c.value];
    else if (c.fixed && typeof c.fixed === 'object' && !Array.isArray(c.fixed)) {
      k.fixed = {};
      for (const [f, v] of Object.entries(c.fixed)) { if (!FIELD_KEY.test(f) || !fin(v)) return null; k.fixed[f] = v; }
    } else return null;
  } else if (DIMENSIONAL[c.type]) {
    if (!fin(c.value) || typeof c.name !== 'string' || !NAME_RE.test(c.name)) return null;
    k.value = c.value; k.name = c.name;
    k.off = Array.isArray(c.off) && c.off.length === 2 && c.off.every(fin) ? [...c.off] : [0, 0];
  }
  return k;
}

/** After doc.load: drop constraints that do not fit what was read (an entity of another kind under the same key). */
export function keepFitting(doc, constraints) {
  const ok = [], bad = [];
  for (const c of constraints) (fitsIn(doc.model, c) ? ok : bad).push(c);
  return { ok, bad };
}
function fitsIn(model, c) {
  let s = '';
  for (const r of c.refs) { const k = refKind(model.get(r.e), r.k); if (!k) return false; s += k; }
  return TYPES[c.type].sigs.includes(s);
}

// ---------------------------------------------------------------- clipboard

/** Constraints among copied objects, refs as indexes into the clip's entity list (`index`: Map id → index). */
export function clipConstraints(doc, index) {
  if (!doc.inModel) return [];
  const out = [];
  for (const c of doc.constraints) {
    if (!c.refs.every((r) => index.has(r.e))) continue;
    const k = { ...c, refs: c.refs.map((r) => ({ i: index.get(r.e), k: r.k })) };
    if (isDim(c)) {
      const v = varByName(doc.params, c.name);
      k.expr = v ? v.expr : formatNumber(c.value);
    }
    out.push(k);
  }
  return out;
}
/** Untrusted clipboard constraints → clean ones (refs by index), or throws. */
export function readClipConstraints(list, nEntities) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > LIMITS.constraints) throw new Error(t('gcons.constraints_bad'));
  return list.map((c) => {
    const refs = Array.isArray(c?.refs) ? c.refs.map((r) => ({ r: Number.isInteger(r?.i) && r.i >= 0 && r.i < nEntities ? String(r.i) : null, k: r?.k })) : null;
    const map = new Map(Array.from({ length: nEntities }, (_, i) => [String(i), { id: i }]));
    const k = cleanConstraint({ ...c, refs }, map);
    if (!k) throw new Error(t('gcons.constraint_bad'));
    if (isDim(k)) k.expr = typeof c.expr === 'string' && c.expr.length <= 1000 ? c.expr : formatNumber(k.value);
    return { ...k, refs: k.refs.map((r) => ({ i: r.e, k: r.k })) };
  });
}
/**
 * Paste: constraints for the new entities (ids[i] = the new id of clip entity i), moved by dx, dy. Inside the
 * paste's doc.change(). Dimensional ones get fresh names; their expression is kept when every name in it exists
 * here, else its number. → how many were added.
 */
export function pasteConstraints(doc, list, ids, dx = 0, dy = 0) {
  if (!list?.length || !doc.inModel) return 0;
  const cs = doc.constraints.slice();
  const params = cloneParams(doc.params);
  let n = 0;
  for (const c of list) {
    if (!c.refs.every((r) => ids[r.i] !== undefined && doc.model.get(ids[r.i]))) continue;
    const k = { ...c, id: nextId(cs), refs: c.refs.map((r) => ({ e: ids[r.i], k: r.k })) };
    delete k.expr;
    if (k.type === 'fix') {
      if (k.value) k.value = [k.value[0] + dx, k.value[1] + dy];
      if (k.fixed) { const f = { ...k.fixed }; for (const key of Object.keys(f)) { if (/^(x1|x2|cx|x|\d+x)$/.test(key)) f[key] += dx; else if (/^(y1|y2|cy|y|\d+y)$/.test(key)) f[key] += dy; } k.fixed = f; }
    }
    if (!fitsIn(doc.model, k)) continue;
    if (isDim(k)) {
      k.name = nextName(params, DIMENSIONAL[k.type].prefix);
      const uses = (c.expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((w) => !literalWord(w));
      const keepExpr = uses.every((w) => varByName(params, w)) && literal(c.expr) === null;
      params.vars.push({ name: k.name, expr: keepExpr ? c.expr : formatNumber(round6(k.value)) });
      params.links.push({ target: targetKey(k), expr: k.name });
    }
    cs.push(k); n++;
  }
  if (n) doc.setParametric({ constraints: cs, params });
  return n;
}
const literalWord = (w) => /^(mm|cm|m|in|ft|deg|rad|pi|sin|cos|tan|asin|acos|atan|atan2|sqrt|pow|exp|ln|log|abs|sign|ceil|floor|int|round|min|max|if|e)$/i.test(w);

export { refKind, refPoint, refLine, refCircle, SOLVABLE };
