/* SPDX-License-Identifier: Apache-2.0 */
/**
 * duct.js — a duct run (0.5 MQ.1): its data, the fittings it gets, its double-line plan, its 3D solid and its schedule rows.
 * DOM-free (tested in Node).
 *
 * A run is an add-on object of kind `duct` in the 'world' frame: its data holds the centreline in drawing coordinates.
 *   { id, u 'in'|'mm' (size units), k (size units per drawing unit), sys, tag, pts [[x, y]…], segs [{s, w, h, q?}],
 *     z (bottom of duct, drawing units), elbow 'radius'|'mitred', r (centreline radius ÷ width), mat, labels,
 *     links: { taps [{seg, at, w, side, by}], s {on, cut, ang, kind, main}|null, e … } }
 * segs[i] is the section from pts[i] to pts[i+1]: s 'rect' (w wide on plan × h high), 'round' (w = h = diameter), 'oval'
 * (flat oval w × h, flat side down); q = its airflow (cfm or L/s), optional. `links` is worked out by main.js from the
 * other runs (a run whose end sits on another's centreline is a branch: a tee, a round takeoff or a lateral there).
 *
 *   cleanDuct(raw)              untrusted data → data | null
 *   transformDuct(d, m)         a move/rotate/scale/mirror baked into the data
 *   linkRuns(runs)              Map id → links (taps on mains, branch ends)
 *   layoutDuct(d)               the fittings and straight pieces: { pieces, elbows, transitions, taps, problems }
 *   drawDuct(d)                 CadCraft entities: double lines, elbows, transitions, joints, size labels
 *   ductRings(d) / ductSolid(d) the 3D tube (drawing units)
 *   ductRows(list) · schedule(list) the schedule: straight duct by size (length, sheet metal area), fittings, sections
 */

import { t, fmtNum, segs as segsOf, pathLength, nearestOnPath, turnOf, bendAt, line, arcThrough, textAlong, textWidth, profile, placeRing, tube, newRunId } from './mep-core.js';
import { section, sectionLoss } from './sizing.js';

export const VERSION = 1;
export const SHAPES = ['rect', 'round', 'oval'];
export const SYSTEMS = ['supply', 'return', 'exhaust', 'outside', 'other'];
export const MATERIALS = ['galv', 'smooth', 'board', 'flex'];
export const ELBOWS = ['radius', 'mitred'];
export const TRANSITION_DEG = 15;                     // each side of a transition slopes at most this much (a default, not a code value)
export const MIN_TRANSITION = { in: 6, mm: 150 };     // the shortest transition drawn
export const COLLAR = { in: 2, mm: 50 };              // a branch's collar (the takeoff's own length)
export const LIMITS = { pts: 100, size: 1e5, q: 1e8, text: 40 };   // 100 points keeps a run's data well inside the 12 000 characters an object holds
export const DEFAULT_R = { rect: 1, round: 1.5, oval: 1.5 };

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const pick = (v, list, d) => (list.includes(v) ? v : d);

/** A section cleaned: { s, w, h, q? } or null. Round sections have h = w. */
export function cleanSeg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = pick(raw.s, SHAPES, 'rect');
  const w = raw.w, h = s === 'round' ? raw.w : raw.h;
  if (!fin(w) || !fin(h) || w <= 0 || h <= 0 || w > LIMITS.size || h > LIMITS.size) return null;
  if (s === 'oval' && w < h) return null;
  const out = { s, w, h };
  if (fin(raw.q) && raw.q > 0 && raw.q < LIMITS.q) out.q = raw.q;
  return out;
}

/** Untrusted data (a file, another version) → a clean run, or null when it cannot be one. */
export function cleanDuct(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.pts) || !Array.isArray(raw.segs)) return null;
  const pts = [];
  for (const p of raw.pts.slice(0, LIMITS.pts)) {
    if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1]) || Math.abs(p[0]) > 1e12 || Math.abs(p[1]) > 1e12) return null;
    if (pts.length && Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) <= 1e-9) continue;
    pts.push([p[0], p[1]]);
  }
  if (pts.length < 2) return null;
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = cleanSeg(raw.segs[Math.min(i, raw.segs.length - 1)]);
    if (!s) return null;
    segs.push(s);
  }
  const u = raw.u === 'mm' ? 'mm' : 'in';
  const k = fin(raw.k) && raw.k > 0 && raw.k < 1e9 ? raw.k : 1;
  const out = {
    id: typeof raw.id === 'string' && /^[a-z0-9]{4,16}$/.test(raw.id) ? raw.id : newRunId(),
    u, k, sys: pick(raw.sys, SYSTEMS, 'supply'), tag: str(raw.tag, LIMITS.text), pts, segs,
    z: fin(raw.z) && Math.abs(raw.z) < 1e12 ? raw.z : 0,
    elbow: pick(raw.elbow, ELBOWS, 'radius'),
    r: fin(raw.r) && raw.r >= 0.5 && raw.r <= 5 ? raw.r : DEFAULT_R[segs[0].s],
    mat: pick(raw.mat, MATERIALS, 'galv'),
    labels: raw.labels !== false,
    links: cleanLinks(raw.links, segs.length),
  };
  return out;
}

function cleanLinks(raw, nSegs) {
  const out = { taps: [], s: null, e: null };
  if (!raw || typeof raw !== 'object') return out;
  for (const tp of Array.isArray(raw.taps) ? raw.taps.slice(0, 200) : []) {
    if (!tp || !Number.isInteger(tp.seg) || tp.seg < 0 || tp.seg >= nSegs || !fin(tp.at) || !fin(tp.w) || tp.w <= 0 || (tp.side !== 1 && tp.side !== -1)) continue;
    out.taps.push({ seg: tp.seg, at: tp.at, w: tp.w, side: tp.side, by: typeof tp.by === 'string' ? tp.by.slice(0, 16) : '' });
  }
  for (const k of ['s', 'e']) {
    const l = raw[k];
    if (!l || typeof l !== 'object' || !fin(l.cut) || l.cut < 0 || !fin(l.ang)) continue;
    const main = cleanSeg(l.main);
    out[k] = { on: typeof l.on === 'string' ? l.on.slice(0, 16) : '', cut: l.cut, ang: l.ang, kind: pick(l.kind, ['tee', 'takeoff', 'lateral'], 'tee'), ...(main ? { main } : {}) };
  }
  return out;
}

/** A move / rotate / scale / mirror (matrix [a, b, c, d, e, f]) baked into the run: points move, sizes stay, drawn widths follow a scale. */
export function transformDuct(d, m) {
  const out = structuredClone(d);
  out.pts = d.pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  if (sc > 1e-12 && Math.abs(sc - 1) > 1e-12) { out.k = d.k / sc; out.z = d.z * sc; }
  out.links = { taps: [], s: null, e: null };   // worked out again from where everything is now
  return out;
}

// ------------------------------------------------------------------------------------------------ sizes in drawing units
/** Plan width and height of a section in drawing units. */
export const planW = (d, s) => s.w / d.k;
export const heightOf = (d, s) => s.h / d.k;
const same = (a, b) => a.s === b.s && Math.abs(a.w - b.w) < 1e-9 && Math.abs(a.h - b.h) < 1e-9;

/** "24×12", "Ø14", "30×12 flat oval" (size units, no unit name). */
export function sizeText(s) {
  return sizeOnly(s);
}
function sizeOnly(s) {
  if (s.s === 'round') return t('size.round', { d: fmtNum(s.w, 1) });
  if (s.s === 'oval') return t('size.oval', { w: fmtNum(s.w, 1), h: fmtNum(s.h, 1) });
  return t('size.rect', { w: fmtNum(s.w, 1), h: fmtNum(s.h, 1) });
}

// ------------------------------------------------------------------------------------------------ links between runs
/**
 * Work out branches: a run's end on another run's centreline (not at its ends) is a branch there. runs = [{ id, data }].
 * → Map id → { taps, s, e } (drawing units; `at` along the main's segment, `cut` = how far the branch stops short of the
 * main's centreline: half the main's width over the sine of the angle between them).
 */
export function linkRuns(runs) {
  const out = new Map(runs.map((r) => [r.id, { taps: [], s: null, e: null }]));
  for (const B of runs) {
    const bs = segsOf(B.data.pts);
    if (!bs.length) continue;
    for (const end of ['s', 'e']) {
      const seg = end === 's' ? bs[0] : bs[bs.length - 1];
      const p = end === 's' ? seg.a : seg.b;
      const into = end === 's' ? seg.t : { x: -seg.t.x, y: -seg.t.y };   // pointing from the joint into the branch
      const tol = 1e-7 * Math.max(1, Math.abs(p.x), Math.abs(p.y));
      for (const A of runs) {
        if (A === B) continue;
        const near = nearestOnPath(A.data.pts, p);
        const total = pathLength(A.data.pts);
        if (!near || near.dist > tol || near.s <= tol || near.s >= total - tol) continue;
        const ga = segsOf(A.data.pts)[near.seg];
        const cr = ga.t.x * into.y - ga.t.y * into.x, sin = Math.abs(cr);
        if (sin < 0.2) continue;   // running along the main, not off it
        const ms = A.data.segs[near.seg], bsec = B.data.segs[end === 's' ? 0 : B.data.segs.length - 1];
        const ang = Math.round((Math.asin(Math.min(1, sin)) * 180) / Math.PI * 10) / 10;
        const kind = bsec.s !== 'rect' ? 'takeoff' : Math.abs(90 - ang) <= 15 ? 'tee' : 'lateral';
        out.get(B.id)[end] = { on: A.id, cut: planW(A.data, ms) / 2 / sin, ang, kind, main: { s: ms.s, w: ms.w, h: ms.h } };
        out.get(A.id).taps.push({ seg: near.seg, at: near.at, w: planW(B.data, bsec) / sin, side: cr > 0 ? 1 : -1, by: B.id });
        break;
      }
    }
  }
  for (const l of out.values()) l.taps.sort((a, b) => a.seg - b.seg || a.at - b.at);
  return out;
}

// ------------------------------------------------------------------------------------------------ layout
/**
 * The run's fittings and straight pieces (drawing units). Elbows sit on turns (radius: centreline radius r × the width,
 * tangent length R·tan(θ/2); mitred: W/2·tan(θ/2)); a size change makes a transition just downstream of the corner (after
 * its elbow), as long as its sides need to slope no more than TRANSITION_DEG; a branch end is cut back to the main's side
 * and gets a collar. → { segs, pieces [{seg, s0, s1}], elbows, transitions, taps, problems }
 */
export function layoutDuct(d) {
  const G = segsOf(d.pts), n = G.length;
  const trimS = new Array(n).fill(0), trimE = new Array(n).fill(0);
  const elbows = [], transitions = [], problems = [];
  const minT = MIN_TRANSITION[d.u] / d.k, tanA = Math.tan((TRANSITION_DEG * Math.PI) / 180);
  for (let i = 1; i < n; i++) {
    const A = G[i - 1], B = G[i], sa = d.segs[i - 1], sb = d.segs[i];
    const turn = turnOf(A.t, B.t), theta = Math.abs(turn);
    if (theta > (179 * Math.PI) / 180) { problems.push({ kind: 'hairpin', at: i }); continue; }
    if (theta > Math.PI / 180) {
      const W = planW(d, sa);
      const mitred = d.elbow === 'mitred';
      const R = mitred ? 0 : d.r * W;
      const T = mitred ? (W / 2) * Math.tan(theta / 2) : R * Math.tan(theta / 2);
      trimE[i - 1] += T; trimS[i] += T;
      elbows.push({ at: i, V: A.b, tin: A.t, tout: B.t, theta, side: turn >= 0 ? 1 : -1, R, T, sec: sa, mitred, len: mitred ? 2 * T : R * theta });
    }
    if (!same(sa, sb)) {
      const dW = Math.abs(sa.w - sb.w) / 2, dH = Math.abs(sa.h - sb.h);   // flat bottom: the top takes the whole height change
      const L = Math.max(Math.max(dW, dH) / tanA / d.k, minT);
      transitions.push({ seg: i, s: trimS[i], len: L, from: sa, to: sb });
      trimS[i] += L;
    }
  }
  const taps = [];
  for (const end of ['s', 'e']) {
    const l = d.links?.[end];
    if (!l || !n) continue;
    const i = end === 's' ? 0 : n - 1, sec = d.segs[i];
    const c = COLLAR[d.u] / d.k;
    if (end === 's') trimS[0] = Math.max(trimS[0], l.cut); else trimE[n - 1] = Math.max(trimE[n - 1], l.cut);
    taps.push({ end, seg: i, cut: l.cut, collar: c, sec, kind: l.kind, ang: l.ang, main: l.main || null });
  }
  const pieces = G.map((g, i) => {
    const s0 = trimS[i], s1 = g.len - trimE[i];
    if (s1 < s0 - 1e-9) problems.push({ kind: 'short', at: i });
    return { seg: i, s0, s1: Math.max(s0, s1) };
  });
  return { segs: G, pieces, elbows, transitions, taps, problems };
}

// ------------------------------------------------------------------------------------------------ 2D
const at = (g, s) => ({ x: g.a.x + g.t.x * s, y: g.a.y + g.t.y * s });
const off = (p, n, o) => ({ x: p.x + n.x * o, y: p.y + n.y * o });

/** The plan of a run: CadCraft entities in drawing coordinates. */
export function drawDuct(d) {
  const L = layoutDuct(d), out = [], joints = new Map();
  const joint = (p, n, W) => {
    const k = Math.round(p.x * 1e6) + ':' + Math.round(p.y * 1e6);
    if (!joints.has(k)) { joints.set(k, true); out.push(line(off(p, n, W / 2), off(p, n, -W / 2))); }
  };
  const segLine = (a, b) => { if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) out.push(line(a, b)); };
  for (const pc of L.pieces) {
    const g = L.segs[pc.seg], sec = d.segs[pc.seg], W = planW(d, sec);
    for (const side of [1, -1]) {
      // the side line with the openings where branches come in
      const gaps = (d.links?.taps || []).filter((tp) => tp.seg === pc.seg && tp.side === side).map((tp) => [tp.at - tp.w / 2, tp.at + tp.w / 2]).sort((a, b) => a[0] - b[0]);
      let s = pc.s0;
      for (const [g0, g1] of gaps) {
        if (g1 <= s || g0 >= pc.s1) continue;
        if (g0 > s) segLine(off(at(g, s), g.n, side * W / 2), off(at(g, g0), g.n, side * W / 2));
        s = Math.max(s, g1);
      }
      if (s < pc.s1) segLine(off(at(g, s), g.n, side * W / 2), off(at(g, pc.s1), g.n, side * W / 2));
    }
    joint(at(g, pc.s0), g.n, W);
    joint(at(g, pc.s1), g.n, W);
    if (d.labels && pc.s1 - pc.s0 > 0) {
      const label = sizeText(sec) + (sec.q ? ' ' + t(d.u === 'in' ? 'label.q.in' : 'label.q.mm', { q: fmtNum(sec.q, 0) }) : '');
      let h = 0.3 * Math.min(W, heightOf(d, sec) * 2);
      const room = (pc.s1 - pc.s0) * 0.8;
      if (textWidth(label, h) > room) h *= room / textWidth(label, h);
      if (h >= 0.08 * W) out.push(textAlong(at(g, (pc.s0 + pc.s1) / 2), g.t, label, h));
    }
  }
  for (const e of L.elbows) {
    const W = planW(d, e.sec);
    if (e.mitred) {
      const nin = { x: -e.tin.y, y: e.tin.x }, nout = { x: -e.tout.y, y: e.tout.x };
      const bis = { x: nin.x + nout.x, y: nin.y + nout.y }, bl = Math.hypot(bis.x, bis.y), c = Math.cos(e.theta / 2);
      const p1 = { x: e.V.x - e.tin.x * e.T, y: e.V.y - e.tin.y * e.T }, p2 = { x: e.V.x + e.tout.x * e.T, y: e.V.y + e.tout.y * e.T };
      const M = (o) => ({ x: e.V.x + (bis.x / bl) * o / c, y: e.V.y + (bis.y / bl) * o / c });
      for (const o of [W / 2, -W / 2]) { segLine(off(p1, nin, o), M(o)); segLine(M(o), off(p2, nout, o)); }
      segLine(M(W / 2), M(-W / 2));
    } else {
      const b = bendAt(e.V, e.tin, e.tout, e.R);
      const ccw = b.side > 0;
      out.push(arcThrough(b.c, e.R + W / 2, b.a1, b.a2, ccw));
      if (e.R - W / 2 > 1e-9) out.push(arcThrough(b.c, e.R - W / 2, b.a1, b.a2, ccw));
    }
  }
  for (const tr of L.transitions) {
    const g = L.segs[tr.seg], a = at(g, tr.s), b = at(g, tr.s + tr.len);
    const wa = planW(d, tr.from), wb = planW(d, tr.to);
    for (const side of [1, -1]) segLine(off(a, g.n, side * wa / 2), off(b, g.n, side * wb / 2));
    joint(a, g.n, wa);
    joint(b, g.n, wb);
  }
  for (const tp of L.taps) {
    // the collar's far joint (its near end is the main's side, drawn by the piece's own joint)
    const g = L.segs[tp.seg], W = planW(d, tp.sec);
    const s = tp.end === 's' ? tp.cut + tp.collar : g.len - tp.cut - tp.collar;
    if (s > 0 && s < g.len) joint(at(g, s), g.n, W);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ 3D
/** The run's cross-sections along its centreline (drawing units), from the first point to the last, elbows stepped ≤ 15°. */
export function ductRings(d) {
  const L = layoutDuct(d), G = L.segs;
  if (!G.length) return [];
  const N = d.segs.every((s) => s.s === 'rect') ? 4 : 24;
  const prof = (s) => profile(s.s, planW(d, s), heightOf(d, s), N);
  const rings = [placeRing(prof(d.segs[0]), G[0].a, G[0].t, d.z)];
  const byVertex = new Map(L.elbows.map((e) => [e.at, e]));
  const trBySeg = new Map(L.transitions.map((x) => [x.seg, x]));
  for (let i = 1; i < G.length; i++) {
    const e = byVertex.get(i), pa = prof(d.segs[i - 1]);
    if (e && e.mitred) {
      const bis = { x: e.tin.x + e.tout.x, y: e.tin.y + e.tout.y }, bl = Math.hypot(bis.x, bis.y);
      const dir = { x: bis.x / bl, y: bis.y / bl };
      rings.push(placeRing(pa, e.V, dir, d.z, 1 / Math.cos(e.theta / 2)));
    } else if (e) {
      const b = bendAt(e.V, e.tin, e.tout, e.R), steps = Math.max(2, Math.ceil(e.theta / (Math.PI / 12)));
      for (let k = 0; k <= steps; k++) {
        const phi = (e.theta * k) / steps, a = b.a1 + b.side * phi;
        const p = { x: b.c.x + e.R * Math.cos(a), y: b.c.y + e.R * Math.sin(a) };
        const dir = { x: Math.cos(Math.atan2(e.tin.y, e.tin.x) + b.side * phi), y: Math.sin(Math.atan2(e.tin.y, e.tin.x) + b.side * phi) };
        rings.push(placeRing(pa, p, dir, d.z));
      }
    } else rings.push(placeRing(pa, G[i].a, G[i].t, d.z));
    const tr = trBySeg.get(i);
    if (tr) {
      rings.push(placeRing(pa, at(G[i], tr.s), G[i].t, d.z));
      rings.push(placeRing(prof(tr.to), at(G[i], tr.s + tr.len), G[i].t, d.z));
    }
  }
  const last = G[G.length - 1];
  rings.push(placeRing(prof(d.segs[d.segs.length - 1]), last.b, last.t, d.z));
  return rings;
}
/** The run as one closed solid: polygons in drawing units (faces outward). */
export const ductSolid = (d) => tube(ductRings(d));

// ------------------------------------------------------------------------------------------------ schedule
/** Length in drawing units → feet or metres; area of a perimeter (size units) over a length (drawing units) → ft² or m². */
const lenOut = (d, du) => (d.u === 'in' ? (du * d.k) / 12 : (du * d.k) / 1000);
const areaOut = (d, perim, du) => (d.u === 'in' ? (perim * du * d.k) / 144 : (perim * du * d.k) / 1e6);

/** Each fitting of one run: { key, name, kind, area (each, ft²/m²), sec, x, y }. */
export function fittingsOf(d) {
  const L = layoutDuct(d), out = [];
  const sizeText = (s) => sizeOnly(s) + ' ' + t('unit.' + d.u);
  for (const e of L.elbows) {
    const deg = Math.round((e.theta * 180) / Math.PI);
    const p = section(e.sec.s, e.sec.w, e.sec.h).perimeter;
    const name = e.mitred ? t('fit.elbow.mitred', { deg, size: sizeText(e.sec) })
      : t(e.sec.s === 'rect' ? 'fit.elbow.rect' : 'fit.elbow.round', { deg, size: sizeText(e.sec), r: fmtNum(d.r, 2) });
    out.push({ kind: 'elbow', name, area: areaOut(d, p, e.len), sec: e.sec, x: e.V.x, y: e.V.y, deg });
  }
  for (const tr of L.transitions) {
    const a = tr.from, b = tr.to, Ls = tr.len * d.k;   // size units
    let area;
    if (a.s === 'rect' && b.s === 'rect') {
      // four flat trapezoids (flat bottom, centred on plan): bottom (wa+wb)/2·L, top the same over its slope,
      // the two sides (ha+hb)/2 over the slope of the side wall
      const bot = ((a.w + b.w) / 2) * Ls, top = ((a.w + b.w) / 2) * Math.hypot(Ls, a.h - b.h);
      const sides = 2 * ((a.h + b.h) / 2) * Math.hypot(Ls, (a.w - b.w) / 2);
      area = bot + top + sides;
    } else {
      // average perimeter × slant length: exact for a concentric round reducer (π (r1 + r2) s), close for the others
      const pa = section(a.s, a.w, a.h).perimeter, pb = section(b.s, b.w, b.h).perimeter;
      area = ((pa + pb) / 2) * Math.hypot(Ls, (Math.max(a.w, a.h) - Math.max(b.w, b.h)) / 2);
    }
    area = d.u === 'in' ? area / 144 : area / 1e6;
    const g = segsOf(d.pts)[tr.seg], c = at(g, tr.s + tr.len / 2);
    const name = t(a.s === 'round' && b.s === 'round' ? 'fit.reducer' : 'fit.transition', { from: sizeText(a), to: sizeText(b) });
    out.push({ kind: 'transition', name, area, sec: b, x: c.x, y: c.y });
  }
  for (const tp of L.taps) {
    const p = section(tp.sec.s, tp.sec.w, tp.sec.h).perimeter;
    const vars = { size: sizeText(tp.sec), main: tp.main ? sizeText(tp.main) : '', deg: fmtNum(tp.ang, 0) };
    const name = t(tp.kind === 'takeoff' ? (tp.sec.s === 'oval' ? 'fit.takeoff.oval' : 'fit.takeoff') : tp.kind === 'lateral' ? 'fit.lateral' : 'fit.tee', vars);
    const g = segsOf(d.pts)[tp.seg], c = at(g, tp.end === 's' ? tp.cut : g.len - tp.cut);
    out.push({ kind: tp.kind, name, area: areaOut(d, p, tp.collar), sec: tp.sec, x: c.x, y: c.y });
  }
  return out;
}

/** The straight pieces of one run: { sec, len (ft/m), area (ft²/m²), pts [[a], [b]] (drawing coordinates) }. */
export function straightsOf(d) {
  const L = layoutDuct(d);
  return L.pieces.filter((p) => p.s1 - p.s0 > 1e-9).map((p) => {
    const g = L.segs[p.seg], sec = d.segs[p.seg], du = p.s1 - p.s0;
    const a = at(g, p.s0), b = at(g, p.s1);
    return { sec, len: lenOut(d, du), area: areaOut(d, section(sec.s, sec.w, sec.h).perimeter, du), pts: [[a.x, a.y], [b.x, b.y]] };
  });
}

/**
 * The schedule of a set of runs (all in one size unit: the first run's; runs in the other are converted). →
 * { u, ducts: [{key, name, sec, len, area, perimeter}], fittings: [{key, name, n, areaEach, area}], sections: [{run,
 *   tag, sys, seg, sec, q, V, rate, len}], totals: {len, area, fittings}, problems: [{tag, kind}] }
 */
export function schedule(runs) {
  const u = runs[0]?.u || 'in';
  const ducts = new Map(), fits = new Map(), sections = [], problems = [];
  const conv = (d) => (d.u === u ? d : convertRun(d, u));
  for (const raw of runs) {
    const d = conv(raw);
    for (const s of straightsOf(d)) {
      const key = s.sec.s + ':' + s.sec.w + 'x' + s.sec.h + ':' + d.mat;
      const row = ducts.get(key) || { key, name: t('row.duct.' + s.sec.s, { size: sizeText(s.sec) + ' ' + t('unit.' + u), mat: t('mat.' + d.mat) }), sec: { s: s.sec.s, w: s.sec.w, h: s.sec.h }, mat: d.mat, len: 0, area: 0, perimeter: section(s.sec.s, s.sec.w, s.sec.h).perimeter, pieces: [] };
      row.len += s.len; row.area += s.area; row.pieces.push(s.pts);
      ducts.set(key, row);
    }
    for (const f of fittingsOf(d)) {
      const key = f.name + '|' + d.mat;
      const row = fits.get(key) || { key, name: t('row.fit', { name: f.name, unit: t('unit.' + u), mat: t('mat.' + d.mat) }), kind: f.kind, mat: d.mat, n: 0, areaEach: f.area, area: 0, at: [] };
      row.n++; row.area += f.area; row.at.push([f.x, f.y]);
      fits.set(key, row);
    }
    const G = segsOf(d.pts);
    d.segs.forEach((sec, i) => {
      const r = sec.q ? sectionLoss({ q: sec.q, shape: sec.s, w: sec.w, h: sec.h, u, mat: d.mat }) : null;
      sections.push({ run: d.id, tag: d.tag, sys: d.sys, seg: i, sec, q: sec.q || null, V: r ? r.V : null, rate: r ? r.rate : null, len: lenOut(d, G[i].len) });
    });
    for (const p of layoutDuct(d).problems) problems.push({ tag: d.tag || d.id, kind: p.kind, at: p.at });
  }
  const dl = [...ducts.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const fl = [...fits.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  return {
    u, ducts: dl, fittings: fl, sections, problems,
    totals: { len: dl.reduce((s, r) => s + r.len, 0), area: dl.reduce((s, r) => s + r.area, 0) + fl.reduce((s, r) => s + r.area, 0), fittings: fl.reduce((s, r) => s + r.n, 0) },
  };
}

/** A run with its sizes and airflows in the other unit system (in ↔ mm; cfm ↔ L/s), its geometry unchanged. */
export function convertRun(d, u) {
  if (d.u === u) return d;
  const f = u === 'mm' ? 25.4 : 1 / 25.4, fq = u === 'mm' ? 0.47194745 : 1 / 0.47194745;
  return { ...d, u, k: d.k * f, segs: d.segs.map((s) => ({ ...s, w: s.w * f, h: s.h * f, ...(s.q ? { q: s.q * fq } : {}) })) };
}
