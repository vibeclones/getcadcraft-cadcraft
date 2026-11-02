/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pipe.js — a pipe run (0.5 MQ.2): its data, fittings and valves, single- or double-line plan, 3D solid and schedule rows.
 * DOM-free (tested in Node).
 *
 * A run is an add-on object of kind `pipe` in the 'world' frame: its data holds the centerline in drawing coordinates.
 *   { id, u 'in'|'mm' (how sizes are named: NPS or DN), k (inches per drawing unit), mat, cls, sys, tag,
 *     pts [[x, y]…], segs [{size}] (size = a nominal size of tables.js), z (centerline elevation at the start, drawing units),
 *     slope (fall per run, ≥ 0, in the direction drawn), lines 'single'|'double', sym (symbol length, drawing units),
 *     valves [{s (along the run, drawing units), type}], links {taps, s, e} (worked out by main.js, as for ducts) }
 *
 *   cleanPipe(raw) · transformPipe(d, m) · linkPipes(runs) · layoutPipe(d) · drawPipe(d) · pipeRings(d) / pipeSolid(d)
 *   sizeLabel(d, size) · fittingsOf(d) · lengthsOf(d) · schedule(runs)
 */

import { t, fmtNum, segs as segsOf, pathLength, nearestOnPath, turnOf, bendAt, line, arcThrough, textAlong, textWidth, profile, placeRing, tube, newRunId } from './mep-core.js';
import { MATERIALS, CLASSES, DEFAULT_CLASS, pipeSize, bendRadius, minDrainSlope, steelWeightLbFt, steelWeightKgM } from './tables.js';
import { VALVES, drawSymbol, placeEnts } from './symbols.js';

export const VERSION = 1;
export const SYSTEMS = ['cw', 'hw', 'hwr', 'san', 'vent', 'storm', 'chw', 'hhw', 'gas', 'fire', 'other'];
export const DRAINS = ['san', 'storm'];
export const LINES = ['single', 'double'];
export const LIMITS = { pts: 100, valves: 100, text: 40 };

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const pick = (v, list, d) => (list.includes(v) ? v : d);

/** Untrusted data → a clean run, or null. */
export function cleanPipe(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.pts) || !Array.isArray(raw.segs)) return null;
  const mat = pick(raw.mat, MATERIALS, 'steel');
  const cls = pick(String(raw.cls ?? ''), CLASSES[mat], DEFAULT_CLASS[mat]);
  const pts = [];
  for (const p of raw.pts.slice(0, LIMITS.pts)) {
    if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1]) || Math.abs(p[0]) > 1e12 || Math.abs(p[1]) > 1e12) return null;
    if (pts.length && Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) <= 1e-9) continue;
    pts.push([p[0], p[1]]);
  }
  if (pts.length < 2) return null;
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = raw.segs[Math.min(i, raw.segs.length - 1)];
    const size = s && typeof s === 'object' ? String(s.size ?? '') : '';
    if (!pipeSize(mat, cls, size)) return null;
    segs.push({ size });
  }
  const k = fin(raw.k) && raw.k > 0 && raw.k < 1e9 ? raw.k : 1;
  const total = pathLength(pts);
  const valves = [];
  for (const v of Array.isArray(raw.valves) ? raw.valves.slice(0, LIMITS.valves) : []) {
    if (!v || !fin(v.s) || v.s < 0 || v.s > total || !VALVES.includes(v.type)) continue;
    valves.push({ s: v.s, type: v.type });
  }
  valves.sort((a, b) => a.s - b.s);
  return {
    id: typeof raw.id === 'string' && /^[a-z0-9]{4,16}$/.test(raw.id) ? raw.id : newRunId(),
    u: raw.u === 'mm' ? 'mm' : 'in', k, mat, cls, sys: pick(raw.sys, SYSTEMS, 'cw'), tag: str(raw.tag, LIMITS.text), pts, segs,
    z: fin(raw.z) && Math.abs(raw.z) < 1e12 ? raw.z : 0,
    slope: fin(raw.slope) && raw.slope >= 0 && raw.slope <= 1 ? raw.slope : 0,
    lines: pick(raw.lines, LINES, 'single'),
    sym: fin(raw.sym) && raw.sym > 0 && raw.sym < 1e9 ? raw.sym : 12 / k,
    valves,
    links: cleanLinks(raw.links, segs.length, mat, cls),
  };
}

function cleanLinks(raw, nSegs, mat, cls) {
  const out = { taps: [], s: null, e: null };
  if (!raw || typeof raw !== 'object') return out;
  for (const tp of Array.isArray(raw.taps) ? raw.taps.slice(0, 200) : []) {
    if (!tp || !Number.isInteger(tp.seg) || tp.seg < 0 || tp.seg >= nSegs || !fin(tp.at) || !fin(tp.w) || tp.w <= 0 || (tp.side !== 1 && tp.side !== -1)) continue;
    out.taps.push({ seg: tp.seg, at: tp.at, w: tp.w, side: tp.side, by: typeof tp.by === 'string' ? tp.by.slice(0, 16) : '' });
  }
  for (const k of ['s', 'e']) {
    const l = raw[k];
    if (!l || typeof l !== 'object' || !fin(l.cut) || l.cut < 0 || !fin(l.ang)) continue;
    out[k] = { on: typeof l.on === 'string' ? l.on.slice(0, 16) : '', cut: l.cut, ang: l.ang, kind: pick(l.kind, ['tee', 'wye'], 'tee'), main: typeof l.main === 'string' ? l.main.slice(0, 10) : '' };
  }
  return out;
}

/** A move / rotate / scale / mirror baked into the run: points and valve positions move, sizes stay. */
export function transformPipe(d, m) {
  const out = structuredClone(d);
  out.pts = d.pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  if (sc > 1e-12 && Math.abs(sc - 1) > 1e-12) { out.k = d.k / sc; out.z = d.z * sc; out.sym = d.sym * sc; out.valves = d.valves.map((v) => ({ ...v, s: v.s * sc })); }
  out.links = { taps: [], s: null, e: null };
  return out;
}

// ------------------------------------------------------------------------------------------------ sizes
export const sizeOf = (d, size) => pipeSize(d.mat, d.cls, size);
/** Outside diameter in drawing units. */
export const odOf = (d, size) => sizeOf(d, size).od / d.k;
/** 2" or DN50 (steel and PVC), 1/2" or 1/2 (15.9 mm) for copper and PEX in a metric drawing. */
export function sizeLabel(d, size) {
  const p = sizeOf(d, size);
  if (d.u === 'in') return t('size.in', { s: size });
  if ((d.mat === 'steel' || d.mat === 'pvc') && p.dn) return t('size.dn', { dn: p.dn });
  return t('size.cts', { s: size, mm: fmtNum(p.od * 25.4, 1) });
}
export const matLabel = (d) => t('mat.' + d.mat + '.' + d.cls);
export const isDrain = (d) => DRAINS.includes(d.sys);
/** Elevation of the centerline `s` along the run (plan distance, drawing units). */
export const zAt = (d, s) => d.z - d.slope * s;

// ------------------------------------------------------------------------------------------------ links
/** As linkRuns for ducts: a run's end on another run's centerline (not at its ends) is a branch — a tee, or a wye at an angle. */
export function linkPipes(runs) {
  const out = new Map(runs.map((r) => [r.id, { taps: [], s: null, e: null }]));
  for (const B of runs) {
    const bs = segsOf(B.data.pts);
    if (!bs.length) continue;
    for (const end of ['s', 'e']) {
      const seg = end === 's' ? bs[0] : bs[bs.length - 1];
      const p = end === 's' ? seg.a : seg.b;
      const into = end === 's' ? seg.t : { x: -seg.t.x, y: -seg.t.y };
      const tol = 1e-7 * Math.max(1, Math.abs(p.x), Math.abs(p.y));
      for (const A of runs) {
        if (A === B) continue;
        const near = nearestOnPath(A.data.pts, p);
        const total = pathLength(A.data.pts);
        if (!near || near.dist > tol || near.s <= tol || near.s >= total - tol) continue;
        const ga = segsOf(A.data.pts)[near.seg];
        const cr = ga.t.x * into.y - ga.t.y * into.x, sin = Math.abs(cr);
        if (sin < 0.2) continue;
        const ang = Math.round((Math.asin(Math.min(1, sin)) * 180) / Math.PI * 10) / 10;
        const msize = A.data.segs[near.seg].size, bsize = B.data.segs[end === 's' ? 0 : B.data.segs.length - 1].size;
        out.get(B.id)[end] = { on: A.id, cut: odOf(A.data, msize) / 2 / sin, ang, kind: Math.abs(90 - ang) <= 15 ? 'tee' : 'wye', main: msize };
        out.get(A.id).taps.push({ seg: near.seg, at: near.at, w: odOf(B.data, bsize) / sin, side: cr > 0 ? 1 : -1, by: B.id });
        break;
      }
    }
  }
  for (const l of out.values()) l.taps.sort((a, b) => a.seg - b.seg || a.at - b.at);
  return out;
}

// ------------------------------------------------------------------------------------------------ layout
/**
 * Elbows on turns (bend radius from tables.js: ASME B16.9 long radius for steel), reducers on size changes (concentric, drawn
 * 1.5 × the larger OD long, after the corner's elbow), branch ends cut back to the main's side (double line).
 */
export function layoutPipe(d) {
  const G = segsOf(d.pts), n = G.length;
  const trimS = new Array(n).fill(0), trimE = new Array(n).fill(0);
  const elbows = [], reducers = [], problems = [];
  for (let i = 1; i < n; i++) {
    const A = G[i - 1], B = G[i], sa = d.segs[i - 1].size, sb = d.segs[i].size;
    const turn = turnOf(A.t, B.t), theta = Math.abs(turn);
    if (theta > (179 * Math.PI) / 180) { problems.push({ kind: 'hairpin', at: i }); continue; }
    if (theta > Math.PI / 180) {
      const R = bendRadius(sizeOf(d, sa)) / d.k, T = R * Math.tan(theta / 2);
      trimE[i - 1] += T; trimS[i] += T;
      elbows.push({ at: i, V: A.b, tin: A.t, tout: B.t, theta, side: turn >= 0 ? 1 : -1, R, T, size: sa });
    }
    if (sa !== sb) {
      const len = 1.5 * Math.max(odOf(d, sa), odOf(d, sb));
      reducers.push({ seg: i, s: trimS[i], len, from: sa, to: sb });
      trimS[i] += len;
    }
  }
  const taps = [];
  for (const end of ['s', 'e']) {
    const l = d.links?.[end];
    if (!l || !n) continue;
    const i = end === 's' ? 0 : n - 1;
    if (end === 's') trimS[0] = Math.max(trimS[0], l.cut); else trimE[n - 1] = Math.max(trimE[n - 1], l.cut);
    taps.push({ end, seg: i, cut: l.cut, size: d.segs[i].size, kind: l.kind, ang: l.ang, main: l.main });
  }
  const pieces = G.map((g, i) => {
    const s0 = trimS[i], s1 = g.len - trimE[i];
    if (s1 < s0 - 1e-9) problems.push({ kind: 'short', at: i });
    return { seg: i, s0, s1: Math.max(s0, s1) };
  });
  if (isDrain(d)) {
    const need = Math.max(...d.segs.map((s) => minDrainSlope(sizeOf(d, s.size).nps)));
    if (d.slope < need - 1e-12) problems.push({ kind: d.slope > 0 ? 'slope' : 'flat', need });
  }
  return { segs: G, pieces, elbows, reducers, taps, problems };
}

// ------------------------------------------------------------------------------------------------ 2D
const at = (g, s) => ({ x: g.a.x + g.t.x * s, y: g.a.y + g.t.y * s });
const off = (p, n, o) => ({ x: p.x + n.x * o, y: p.y + n.y * o });
const segLine = (out, a, b) => { if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) out.push(line(a, b)); };

/** Valve sizes on this run: the symbol's length and height (double line: big enough to show past the pipe). */
function valveBox(d, size) {
  const od = odOf(d, size);
  if (d.lines === 'double') { const l = Math.max(d.sym, 2.5 * od); return { l, h: Math.max(l / 2, 1.4 * od) }; }
  return { l: d.sym, h: d.sym / 2 };
}
/** Where each valve sits: { s, type, seg, at, l, h, p, t }. */
export function valvesOf(d) {
  const G = segsOf(d.pts);
  return d.valves.map((v) => {
    let i = 0;
    while (i < G.length - 1 && v.s > G[i].s0 + G[i].len) i++;
    const g = G[i], a = Math.max(0, Math.min(g.len, v.s - g.s0));
    return { ...v, seg: i, at: a, ...valveBox(d, d.segs[i].size), p: at(g, a), t: g.t };
  });
}

/** Subtract [a, b] intervals (sorted) from [s0, s1] → the pieces left. */
function minus(s0, s1, gaps) {
  const out = [];
  let s = s0;
  for (const [a, b] of gaps) { if (b <= s || a >= s1) continue; if (a > s) out.push([s, a]); s = Math.max(s, b); }
  if (s < s1) out.push([s, s1]);
  return out;
}

/** The plan of a run: CadCraft entities in drawing coordinates. */
export function drawPipe(d) {
  const L = layoutPipe(d), out = [], G = L.segs;
  const V = valvesOf(d);
  const valveGaps = (seg) => V.filter((v) => v.seg === seg).map((v) => [v.at - v.l / 2, v.at + v.l / 2]);
  if (d.lines === 'single') {
    // the centerline: straight from corner to corner, broken at valves
    G.forEach((g, i) => { for (const [a, b] of minus(0, g.len, valveGaps(i))) segLine(out, at(g, a), at(g, b)); });
    for (const r of L.reducers) {
      const g = G[r.seg], p = at(g, r.s + r.len / 2);
      out.push(...placeEnts(drawSymbol('reducer', d.sym * 0.6, d.sym * 0.4), p, Math.atan2(g.t.y, g.t.x)));
    }
  } else {
    const joints = new Map();
    const joint = (p, n, W) => { const k = Math.round(p.x * 1e6) + ':' + Math.round(p.y * 1e6); if (!joints.has(k)) { joints.set(k, 1); out.push(line(off(p, n, W / 2), off(p, n, -W / 2))); } };
    for (const pc of L.pieces) {
      const g = G[pc.seg], W = odOf(d, d.segs[pc.seg].size);
      for (const side of [1, -1]) {
        const gaps = [...(d.links?.taps || []).filter((tp) => tp.seg === pc.seg && tp.side === side).map((tp) => [tp.at - tp.w / 2, tp.at + tp.w / 2]), ...valveGaps(pc.seg)].sort((a, b) => a[0] - b[0]);
        for (const [a, b] of minus(pc.s0, pc.s1, gaps)) segLine(out, off(at(g, a), g.n, side * W / 2), off(at(g, b), g.n, side * W / 2));
      }
      joint(at(g, pc.s0), g.n, W);
      joint(at(g, pc.s1), g.n, W);
    }
    for (const e of L.elbows) {
      const W = odOf(d, e.size), b = bendAt(e.V, e.tin, e.tout, e.R), ccw = b.side > 0;
      out.push(arcThrough(b.c, e.R + W / 2, b.a1, b.a2, ccw));
      if (e.R - W / 2 > 1e-9) out.push(arcThrough(b.c, e.R - W / 2, b.a1, b.a2, ccw));
    }
    for (const r of L.reducers) {
      const g = G[r.seg], a = at(g, r.s), b = at(g, r.s + r.len), wa = odOf(d, r.from), wb = odOf(d, r.to);
      for (const side of [1, -1]) segLine(out, off(a, g.n, side * wa / 2), off(b, g.n, side * wb / 2));
      joint(a, g.n, wa); joint(b, g.n, wb);
    }
  }
  for (const v of V) out.push(...placeEnts(drawSymbol(v.type, v.l, v.h), v.p, Math.atan2(v.t.y, v.t.x)));
  // labels: the size and system beside the longest straight piece of each size, and the slope of a sloped run
  const th = d.sym * 0.4;
  const done = new Set();
  const order = L.pieces.map((p, i) => ({ ...p, len: p.s1 - p.s0, i })).sort((a, b) => b.len - a.len);
  for (const pc of order) {
    const size = d.segs[pc.seg].size;
    if (done.has(size) || pc.len <= 0) continue;
    const label = sizeLabel(d, size) + ' ' + t('sys.short.' + d.sys) + (d.tag ? ' ' + d.tag : '');
    if (textWidth(label, th) > pc.len * 0.9) continue;
    done.add(size);
    const g = G[pc.seg], W = d.lines === 'double' ? odOf(d, size) : 0;
    const flip = Math.cos(Math.atan2(g.t.y, g.t.x)) < -1e-9 || (Math.abs(g.t.x) < 1e-9 && g.t.y < 0) ? -1 : 1;
    out.push(textAlong(off(at(g, (pc.s0 + pc.s1) / 2), g.n, flip * (W / 2 + th)), g.t, label, th));
  }
  if (d.slope > 0 && order.length) {
    const pc = order[0], g = G[pc.seg], W = d.lines === 'double' ? odOf(d, d.segs[pc.seg].size) : 0;
    const p = off(at(g, (pc.s0 + pc.s1) / 2), g.n, -(W / 2 + th * 1.5));
    out.push(...placeEnts(drawSymbol('flow', th * 1.5, th), off(p, g.t, -textWidth('0000', th)), Math.atan2(g.t.y, g.t.x)));
    out.push(textAlong(p, g.t, slopeText(d), th));
  }
  return out;
}

/** "1/4 in/ft" (imperial, in eighths and sixteenths when they fit) or "2 %". */
export function slopeText(d) {
  if (d.u === 'mm') return t('slope.pct', { p: fmtNum(d.slope * 100, 2) });
  const inPerFt = d.slope * 12, x16 = Math.round(inPerFt * 16);
  const frac = Math.abs(inPerFt * 16 - x16) < 1e-6 && x16 > 0 && x16 < 16 ? (() => { let n = x16, q = 16; while (n % 2 === 0) { n /= 2; q /= 2; } return n + '/' + q; })() : fmtNum(inPerFt, 3);
  return t('slope.in', { s: frac });
}

// ------------------------------------------------------------------------------------------------ 3D
/** The run's cross-sections (16 sides) along its centerline, elbows stepped ≤ 15°, the centerline falling with the slope. */
export function pipeRings(d) {
  const L = layoutPipe(d), G = L.segs;
  if (!G.length) return [];
  const N = 16;
  const prof = (size) => profile('round', odOf(d, size), odOf(d, size), N);
  const ring = (size, p, dir, s) => placeRing(prof(size), p, dir, zAt(d, s) - odOf(d, size) / 2);
  const rings = [ring(d.segs[0].size, G[0].a, G[0].t, 0)];
  const byV = new Map(L.elbows.map((e) => [e.at, e])), red = new Map(L.reducers.map((r) => [r.seg, r]));
  for (let i = 1; i < G.length; i++) {
    const e = byV.get(i), size = d.segs[i - 1].size, sV = G[i].s0;
    if (e) {
      const b = bendAt(e.V, e.tin, e.tout, e.R), steps = Math.max(2, Math.ceil(e.theta / (Math.PI / 12)));
      const a0 = Math.atan2(e.tin.y, e.tin.x);
      for (let k = 0; k <= steps; k++) {
        const phi = (e.theta * k) / steps, a = b.a1 + b.side * phi;
        const p = { x: b.c.x + e.R * Math.cos(a), y: b.c.y + e.R * Math.sin(a) };
        rings.push(ring(size, p, { x: Math.cos(a0 + b.side * phi), y: Math.sin(a0 + b.side * phi) }, sV - e.T + e.R * phi));
      }
    } else rings.push(ring(size, G[i].a, G[i].t, sV));
    const r = red.get(i);
    if (r) {
      rings.push(ring(r.from, at(G[i], r.s), G[i].t, sV + r.s));
      rings.push(ring(r.to, at(G[i], r.s + r.len), G[i].t, sV + r.s + r.len));
    }
  }
  const last = G[G.length - 1];
  rings.push(ring(d.segs[d.segs.length - 1].size, last.b, last.t, last.s0 + last.len));
  return rings;
}
export const pipeSolid = (d) => tube(pipeRings(d));

// ------------------------------------------------------------------------------------------------ schedule
/** Drawing units → feet or metres (by the run's naming system). */
const lenOut = (d, du) => (d.u === 'in' ? (du * d.k) / 12 : (du * d.k * 25.4) / 1000);
const fall = (d) => Math.sqrt(1 + d.slope * d.slope);

/** The run's pipe by size: [{ size, len (true, ft or m), plan (drawing units), marks [[x, y]…] (the centerline, one polyline per stretch of one size) }]. */
export function lengthsOf(d) {
  const G = segsOf(d.pts), out = new Map();
  let cur = null;
  G.forEach((g, i) => {
    const size = d.segs[i].size;
    const r = out.get(size) || { size, len: 0, plan: 0, marks: [] };
    r.plan += g.len; r.len += lenOut(d, g.len) * fall(d);
    if (cur && cur.size === size) cur.pts.push([g.b.x, g.b.y]);
    else { cur = { size, pts: [[g.a.x, g.a.y], [g.b.x, g.b.y]] }; r.marks.push(cur.pts); }
    out.set(size, r);
  });
  return [...out.values()];
}

/** Each fitting and valve of a run: { kind, name, size, x, y }. */
export function fittingsOf(d) {
  const L = layoutPipe(d), out = [], G = L.segs;
  const sz = (s) => sizeLabel(d, s);
  for (const e of L.elbows) {
    const deg = (e.theta * 180) / Math.PI;
    const name = Math.abs(deg - 90) <= 2 ? t('fit.elbow90', { size: sz(e.size) }) : Math.abs(deg - 45) <= 2 ? t('fit.elbow45', { size: sz(e.size) }) : t('fit.elbow', { deg: Math.round(deg), size: sz(e.size) });
    out.push({ kind: 'elbow', name, size: e.size, x: e.V.x, y: e.V.y });
  }
  for (const r of L.reducers) {
    const c = at(G[r.seg], r.s + r.len / 2);
    out.push({ kind: 'reducer', name: t('fit.reducer', { from: sz(r.from), to: sz(r.to) }), size: r.from, x: c.x, y: c.y });
  }
  for (const tp of L.taps) {
    const g = G[tp.seg], p = tp.end === 's' ? g.a : g.b;
    const main = tp.main && sizeOf(d, tp.main) ? tp.main : tp.size;
    const name = t(tp.kind === 'wye' ? 'fit.wye' : main === tp.size ? 'fit.tee' : 'fit.tee.red', { main: sz(main), branch: sz(tp.size) });
    out.push({ kind: tp.kind, name, size: main, x: p.x, y: p.y });
  }
  for (const v of valvesOf(d)) out.push({ kind: 'valve', name: t('valve.' + v.type, { size: sz(d.segs[v.seg].size) }), size: d.segs[v.seg].size, x: v.p.x, y: v.p.y, type: v.type });
  return out;
}

/**
 * The schedule of a set of runs. → { u, pipes: [{key, name, mat, cls, size, len, weight?, marks, slope}], fittings: [{key, name,
 * kind, mat, n, at}], runs: [{tag, sys, mat, len, z0, z1, slope}], totals: {len, fittings, valves, weight}, problems }
 * Pipe length is centerline length (through the fittings, center to center), along the slope; weight for steel only.
 */
export function schedule(runs) {
  const u = runs[0]?.u || 'in';
  const pipes = new Map(), fits = new Map(), list = [], problems = [];
  for (const d0 of runs) {
    const d = d0.u === u ? d0 : { ...d0, u };
    for (const r of lengthsOf(d)) {
      const key = d.mat + '|' + d.cls + '|' + r.size + '|' + (d.slope > 0 ? 's' + d.slope : 'level');
      const p = sizeOf(d, r.size);
      const row = pipes.get(key) || { key, name: t('row.pipe', { size: sizeLabel(d, r.size), mat: matLabel(d) }), mat: d.mat, cls: d.cls, size: r.size, len: 0, marks: [], slope: d.slope, sys: d.sys };
      row.len += r.len;
      for (const m of r.marks) row.marks.push(m);
      if (d.mat === 'steel') row.weight = u === 'in' ? steelWeightLbFt(p.od, p.wall) * row.len : steelWeightKgM(p.od * 25.4, p.wall * 25.4) * row.len;
      pipes.set(key, row);
    }
    for (const f of fittingsOf(d)) {
      const key = f.name + '|' + d.mat + '|' + d.cls;
      const row = fits.get(key) || { key, name: t('row.fit', { name: f.name, mat: matLabel(d) }), kind: f.kind, mat: d.mat, sys: d.sys, n: 0, at: [] };
      row.n++; row.at.push([f.x, f.y]);
      fits.set(key, row);
    }
    const total = pathLength(d.pts);
    list.push({ id: d.id, tag: d.tag, sys: d.sys, mat: d.mat, cls: d.cls, len: lenOut(d, total) * fall(d), z0: d.z, z1: zAt(d, total), slope: d.slope });
    for (const p of layoutPipe(d).problems) problems.push({ tag: d.tag || d.id, ...p });
  }
  // two rows for the same pipe that differ only by slope: one row (the slope is a drawing detail)
  const merged = new Map();
  for (const r of pipes.values()) {
    const k = r.mat + '|' + r.cls + '|' + r.size;
    const m = merged.get(k);
    if (!m) merged.set(k, { ...r, marks: r.marks.map((pts) => ({ pts, slope: r.slope })) });
    else { m.len += r.len; if (r.weight !== undefined) m.weight = (m.weight || 0) + r.weight; for (const pts of r.marks) m.marks.push({ pts, slope: r.slope }); }
  }
  const pl = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const fl = [...fits.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  return {
    u, pipes: pl, fittings: fl, runs: list, problems,
    totals: { len: pl.reduce((s, r) => s + r.len, 0), fittings: fl.filter((f) => f.kind !== 'valve').reduce((s, f) => s + f.n, 0), valves: fl.filter((f) => f.kind === 'valve').reduce((s, f) => s + f.n, 0), weight: pl.reduce((s, r) => s + (r.weight || 0), 0) },
  };
}
