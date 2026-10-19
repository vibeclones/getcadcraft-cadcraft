/* SPDX-License-Identifier: Apache-2.0 */
/**
 * install.js — installation plans (0.4 part 2, E.8): outlets, switches and luminaires placed on a building plan, each
 * on a circuit; the load per circuit; cable lengths measured along drawn routes. DOM-free.
 *
 * Symbols (IEC 60617 part 11 style, our own drawings) are blocks EL_INST_<KEY> drawn 6 mm across at paper size and
 * placed at the plan's scale (a 1:50 plan in millimetres: scale 50). Attributes: CIRCUIT (visible), LOAD (watts,
 * planning value; invisible), TAG, DESC, MFR, PART, ORDER, and the constant EL ("role=install" / "role=board").
 * A distribution board (EL_INST_BOARD, TAG "DB1", VOLTAGE) is where a circuit's cable starts.
 * LibraryCraft items placed in the drawing count too: their CC-ELEC-KW / CC-ELEC-AMPS × CC-ELEC-VOLTS attributes
 * are their load, and a CIRCUIT value set on them (Properties, ELCIRCUIT) puts them on a circuit.
 *
 * Routes are lines and polylines on a layer starting with EL-ROUTE (cable trays, conduits, the way a cable runs).
 * A circuit's cable length = the length of the union of the shortest routes from its board to each of its devices
 * (shared runs counted once), plus an allowance at each device and at the board. A device or board joins the routes
 * when its insertion point is within `reach` of one (a short drop, counted).
 */

import { t } from './text.js';
import { writeMeta, readMeta, META_TAG, ensureBlock } from './symbols.js';
import { segDist2 } from './wires.js';
import { fullTag } from './model.js';

/** Metres per drawing unit (doc.meta.units, the DXF $INSUNITS names; unitless = millimetres, as CadCraft's 3D reads it). */
export const UNIT_M = { '': 0.001, inches: 0.0254, feet: 0.3048, millimeters: 0.001, centimeters: 0.01, meters: 1, yards: 0.9144 };
export const mPerUnit = (units) => UNIT_M[units || ''] ?? 0.001;
/** The scale a symbol is placed at in a plan of these units (a 1:50 plan). */
export const defaultScale = (units) => ({ meters: 0.05, centimeters: 5, inches: 2, feet: 1 / 6 })[units] ?? 50;

const L = (x1, y1, x2, y2) => ({ type: 'line', layer: '0', color: null, x1, y1, x2, y2 });
const C = (cx, cy, r) => ({ type: 'circle', layer: '0', color: null, cx, cy, r });
const A = (cx, cy, r, d0, d1) => ({ type: 'arc', layer: '0', color: null, cx, cy, r, a0: (d0 * Math.PI) / 180, a1: (d1 * Math.PI) / 180 });
const T = (x, y, s, h = 1.8) => ({ type: 'text', layer: '0', color: null, x, y, h, rot: 0, s, ha: 'center', va: 'middle' });
const HALF = (x0, y0, x1, y1) => ({ type: 'hatch', layer: '0', color: null, solid: true, loops: [[x0, y0, x1, y0, x0, y1]] });
const R = (x0, y0, x1, y1) => ({ type: 'poly', layer: '0', color: null, closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x, y, b: 0 })) });

/** Installation symbols: key, group, load (W, a planning default), draw → entities (base point on the wall / centre). */
export const INSTALL = [
  { key: 'socket', group: 'outlets', load: 200, draw: () => [A(0, 0, 3, 0, 180), L(-3, 0, 3, 0), L(0, 3, 0, 4.5)] },
  { key: 'socket.double', group: 'outlets', load: 400, draw: () => [A(0, 0, 3, 0, 180), L(-3, 0, 3, 0), L(-1, 3, -1, 4.5), L(1, 3, 1, 4.5)] },
  { key: 'socket.earth', group: 'outlets', load: 200, draw: () => [A(0, 0, 3, 0, 180), L(-3, 0, 3, 0), L(0, 3, 0, 4.5), L(-3, 3, 3, 3)] },
  { key: 'socket.3ph', group: 'outlets', load: 3000, draw: () => [A(0, 0, 3, 0, 180), L(-3, 0, 3, 0), L(-1.2, 2.7, -1.6, 4.4), L(0, 3, 0, 4.5), L(1.2, 2.7, 1.6, 4.4)] },
  { key: 'switch', group: 'switches', load: 0, draw: () => [C(0, 0, 1.2), L(0.85, 0.85, 3.4, 3.4), L(3.4, 3.4, 4.3, 2.5)] },
  { key: 'switch.2way', group: 'switches', load: 0, draw: () => [C(0, 0, 1.2), L(0.85, 0.85, 3.4, 3.4), L(3.4, 3.4, 4.3, 2.5), L(-0.85, -0.85, -3.4, -3.4), L(-3.4, -3.4, -4.3, -2.5)] },
  { key: 'switch.dimmer', group: 'switches', load: 0, draw: () => [C(0, 0, 1.2), L(0.85, 0.85, 3.4, 3.4), L(3.4, 3.4, 4.3, 2.5), L(-0.6, -2.2, 0.6, -2.2), L(0.6, -2.2, 0.6, -1.6)] },
  { key: 'pushbutton', group: 'switches', load: 0, draw: () => [C(0, 0, 1.6), C(0, 0, 0.6)] },
  { key: 'sensor', group: 'switches', load: 2, draw: () => [C(0, 0, 2), A(0, 0, 3, 30, 150), A(0, 0, 3.8, 45, 135)] },
  { key: 'luminaire', group: 'lights', load: 60, draw: () => [C(0, 0, 3), L(-2.12, -2.12, 2.12, 2.12), L(-2.12, 2.12, 2.12, -2.12)] },
  { key: 'downlight', group: 'lights', load: 10, draw: () => [C(0, 0, 2), C(0, 0, 0.8)] },
  { key: 'luminaire.linear', group: 'lights', load: 36, draw: () => [L(-5, 0, 5, 0), L(-5, -1.2, -5, 1.2), L(5, -1.2, 5, 1.2)] },
  { key: 'luminaire.emergency', group: 'lights', load: 5, draw: () => [C(0, 0, 3), L(-2.12, -2.12, 2.12, 2.12), L(-2.12, 2.12, 2.12, -2.12), HALF(-3, -0.5, 3, 0.5)] },
  { key: 'junction', group: 'other', load: 0, draw: () => [C(0, 0, 1.5), { type: 'hatch', layer: '0', color: null, solid: true, loops: [ring(0, 0, 0.7)] }] },
  { key: 'appliance', group: 'other', load: 2000, draw: () => [R(-3, -3, 3, 3), T(0, 0, 'A', 2.5)] },
  { key: 'board', group: 'boards', load: 0, role: 'board', draw: () => [R(-5, -2, 5, 2), HALF(-5, -2, 5, 2)] },
];
function ring(cx, cy, r, n = 12) { const o = []; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; o.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); } return o; }

export const INSTALL_GROUPS = ['outlets', 'switches', 'lights', 'other', 'boards'];
const BY_KEY = new Map(INSTALL.map((s) => [s.key, s]));
export const installSymbol = (key) => BY_KEY.get(key) || null;
export const installBlockName = (key) => ('EL_INST_' + key).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 31);

const ad = (tag, x, y, h, o = {}) => ({ tag, prompt: o.prompt || tag, def: o.def || '', x, y, h, rot: 0, ha: o.ha || 'left', va: o.va || 'baseline', wf: 1, layer: '0', color: null, ...(o.invisible ? { invisible: true } : {}), ...(o.constant ? { constant: true } : {}) });

export function installBlock(key) {
  const s = installSymbol(key);
  if (!s) throw new Error('Unknown installation symbol ' + key);   // i18n-ignore
  const role = s.role || 'install';
  const attdefs = role === 'board'
    ? [ad('TAG', 0, 2.8, 2.5, { ha: 'center', prompt: t('prompt.board') }), ad('DESC', 0, -4.6, 1.8, { ha: 'center', prompt: t('prompt.description') }), ad('VOLTAGE', 0, -4.6, 1.8, { invisible: true, def: '230', prompt: t('prompt.voltage-v') }),
      ad('MFR', 0, 0, 1.8, { invisible: true }), ad('PART', 0, 0, 1.8, { invisible: true }), ad('ORDER', 0, 0, 1.8, { invisible: true })]
    : [ad('CIRCUIT', 3.2, -3.4, 1.8, { prompt: t('prompt.circuit') }), ad('LOAD', 3.2, -5.6, 1.8, { invisible: true, def: String(s.load), prompt: t('prompt.load-w') }),
      ad('TAG', 3.2, 3.4, 1.8, { invisible: true, prompt: t('prompt.tag') }), ad('DESC', 3.2, 3.4, 1.8, { invisible: true, prompt: t('prompt.description') }),
      ad('MFR', 0, 0, 1.8, { invisible: true }), ad('PART', 0, 0, 1.8, { invisible: true }), ad('ORDER', 0, 0, 1.8, { invisible: true })];
  attdefs.push(ad(META_TAG, 0, 0, 1, { invisible: true, constant: true, def: writeMeta({ sym: key, role, load: s.load }) }));
  return { name: installBlockName(key), base: { x: 0, y: 0 }, entities: s.draw(), attdefs };
}

/** A circuit definition: EL_CIRCUIT — a small label placed by the board; its attributes are the circuit's data. */
export function circuitBlock() {
  return { name: 'EL_CIRCUIT', base: { x: 0, y: 0 }, entities: [L(0, -0.8, 0, 0.8)],
    attdefs: [ad('CIRCUIT', 1, 0, 2.5, { va: 'middle', prompt: t('prompt.circuit') }), ad('DESC', 12, 0, 1.8, { va: 'middle', prompt: t('prompt.description') }),
      ad('BOARD', 0, 0, 1.8, { invisible: true, prompt: t('prompt.board') }), ad('BREAKER', 0, 0, 1.8, { invisible: true, def: '16', prompt: t('prompt.breaker-a') }),
      ad('CURVE', 0, 0, 1.8, { invisible: true, def: 'B', prompt: t('prompt.breaker-curve') }), ad('PHASE', 0, 0, 1.8, { invisible: true, def: 'L1', prompt: t('prompt.phase') }),
      ad('VOLTAGE', 0, 0, 1.8, { invisible: true, def: '230', prompt: t('prompt.voltage-v') }), ad('PF', 0, 0, 1.8, { invisible: true, def: '1', prompt: t('prompt.power-factor') }),
      ad('CABLE', 0, 0, 1.8, { invisible: true, prompt: t('prompt.cable-type') }),
      ad(META_TAG, 0, 0, 1, { invisible: true, constant: true, def: writeMeta({ sym: 'circuit', role: 'circuit' }) })] };
}

/** Values a newly placed installation symbol starts with. */
export function installAttrs(key, values = {}) {
  const s = installSymbol(key);
  if (s?.role === 'board') return { TAG: '', DESC: '', VOLTAGE: '230', ...values };
  return { CIRCUIT: '', LOAD: String(s?.load ?? 0), TAG: '', DESC: '', ...values };
}

// ------------------------------------------------------------------------------------------------ loads and circuits

const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

/** Library items placed by CadCraft (CC-ELEC-* attributes) as loads: watts or null. */
export function libraryLoad(attrs) {
  const kw = num(attrs['CC-ELEC-KW']);
  if (kw > 0) return kw * 1000;
  const amps = num(attrs['CC-ELEC-AMPS']), volts = num(attrs['CC-ELEC-VOLTS']);
  if (amps > 0 && volts > 0) { const ph = num(attrs['CC-ELEC-PHASE']); return amps * volts * (ph === 3 ? Math.sqrt(3) : 1); }
  const hp = num(attrs['CC-ELEC-HP']);
  if (hp > 0) return hp * 746;
  return null;
}

/**
 * The installation in a scanned drawing (model.js): boards, every load with its circuit, the circuits.
 * doc is needed for library items (blocks without the EL attribute). → {boards, loads, circuits: Map name → circuit}
 * circuit: {name, board, def (EL_CIRCUIT item or null), loads [], watts, phase, voltage, breaker, pf, desc}
 */
export function installation(doc, model) {
  const boards = model.installs.filter((i) => i.role === 'board').map((b) => ({ ...b, tag: String(b.attrs.TAG || '').trim(), voltage: num(b.attrs.VOLTAGE) || 230 }));
  const loads = model.installs.filter((i) => i.role === 'install').map((i) => ({ ...i, circuit: String(i.attrs.CIRCUIT || '').trim(), watts: Math.max(0, num(i.attrs.LOAD) || 0), label: t('inst.' + i.sym) }));
  // library items with electrical data
  for (const sp of model.spaces) for (const e of sp.map.values()) {
    if (e.type !== 'insert' || !e.attrs) continue;
    const blk = doc.blocks.get(e.block);
    if (readMeta(blk)) continue;
    const w = libraryLoad(e.attrs);
    if (w === null && !e.attrs.CIRCUIT) continue;
    loads.push({ uid: sp.key + ':' + e.id, id: e.id, space: sp, e, blk, sym: 'library', role: 'install', attrs: e.attrs, at: { x: e.x, y: e.y }, circuit: String(e.attrs.CIRCUIT || '').trim(), watts: w ?? 0, label: String(e.attrs['CC-ITEM-NAME'] || e.block), library: true });
  }
  const circuits = new Map();
  const get = (name) => {
    let c = circuits.get(name);
    if (!c) circuits.set(name, (c = { name, board: null, boardTag: '', def: null, loads: [], watts: 0, phase: 'L1', voltage: 230, breaker: 0, curve: 'B', pf: 1, desc: '', cable: '' }));
    return c;
  };
  for (const d of model.circuits) {
    const name = String(d.attrs.CIRCUIT || '').trim();
    if (!name) continue;
    const c = get(name);
    if (c.def) { (c.dupDefs ||= []).push(d); continue; }
    c.def = d;
    c.boardTag = String(d.attrs.BOARD || '').trim();
    c.phase = String(d.attrs.PHASE || 'L1').trim().toUpperCase() || 'L1';
    c.voltage = num(d.attrs.VOLTAGE) || 230;
    c.breaker = num(d.attrs.BREAKER) || 0;
    c.curve = String(d.attrs.CURVE || '').trim();
    c.pf = Math.min(1, Math.max(0.1, num(d.attrs.PF) || 1));
    c.desc = String(d.attrs.DESC || '');
    c.cable = String(d.attrs.CABLE || '');
  }
  for (const l of loads) if (l.circuit) { const c = get(l.circuit); c.loads.push(l); c.watts += l.watts; }
  for (const c of circuits.values()) {
    c.board = boards.find((b) => b.tag && b.tag === c.boardTag) || (boards.length === 1 ? boards[0] : null);
    if (!c.def && c.board) c.voltage = c.board.voltage;
    c.amps = currentOf(c);
  }
  return { boards, loads, circuits };
}

/** Current drawn by a circuit (A): single phase W / (V·pf); three phase ("3P", "L1L2L3") W / (√3·V·pf). */
export function currentOf(c) {
  const three = /^(3P|L1L2L3|3)$/i.test(c.phase);
  const v = c.voltage || 230;
  return c.watts / ((three ? Math.sqrt(3) : 1) * v * (c.pf || 1));
}

/** Put a set of loads on a circuit (inside a change). Library items get a CIRCUIT value they carry as an attribute. */
export function assignCircuit(doc, loads, circuit) {
  let n = 0;
  for (const l of loads) {
    const cur = l.space.map.get(l.id);
    if (!cur || String(cur.attrs?.CIRCUIT || '') === circuit) continue;
    const next = { ...cur, attrs: { ...(cur.attrs || {}), CIRCUIT: circuit } };
    if (l.library && !(l.blk?.attdefs || []).some((d) => d.tag === 'CIRCUIT')) {
      // a library block has no CIRCUIT definition: give the value a place of its own so it shows and saves
      next.attloc = { ...(cur.attloc || {}), CIRCUIT: { x: 0, y: 0, h: 2.5 * Math.abs(cur.sx || 1), rot: 0, ha: 'left', va: 'baseline', wf: 1, layer: cur.layer || '0', color: null, invisible: false } };
    }
    doc.update(l.id, next, l.space.map);
    n++;
  }
  return n;
}

/** Define (or redefine) a circuit: an EL_CIRCUIT label at `at` (inside a change). */
export function defineCircuit(doc, map, at, values, scale = 1, existing = null) {
  ensureBlock(doc, circuitBlock());
  const attrs = { CIRCUIT: '', DESC: '', BOARD: '', BREAKER: '16', CURVE: 'B', PHASE: 'L1', VOLTAGE: '230', PF: '1', CABLE: '', ...(existing?.e.attrs || {}), ...values };
  if (existing) return doc.update(existing.id, { ...existing.e, attrs }, existing.space.map);
  return doc.add({ type: 'insert', block: 'EL_CIRCUIT', x: at.x, y: at.y, sx: scale, sy: scale, rot: 0, layer: 'EL-CIRCUIT', attrs }, map);
}

// ------------------------------------------------------------------------------------------------ routes and lengths

/** The route network of one space: nodes and edges, routes split where an end lands on another route. */
export function routeGraph(routes, { tol = 1e-6 } = {}) {
  const nodes = [], edges = [];
  const nodeAt = (p) => {
    for (const n of nodes) if (Math.hypot(n.x - p.x, n.y - p.y) <= tol) return n.i;
    nodes.push({ i: nodes.length, x: p.x, y: p.y, adj: [] });
    return nodes.length - 1;
  };
  // segments, with the extra points that land on them (other routes' ends)
  const segs = [];
  for (const r of routes) for (let i = 0; i + 1 < r.pts.length; i++) segs.push({ a: r.pts[i], b: r.pts[i + 1], cuts: [] });
  const ends = routes.flatMap((r) => [r.pts[0], r.pts[r.pts.length - 1]]);
  for (const s of segs) for (const p of ends) { const q = segDist2(p, s.a, s.b); if (q.d2 <= Math.max(tol, 1e-9) ** 2 && q.u > 1e-9 && q.u < 1 - 1e-9) s.cuts.push(q.u); }
  for (const s of segs) {
    const us = [0, ...[...new Set(s.cuts)].sort((x, y) => x - y), 1];
    for (let k = 0; k + 1 < us.length; k++) {
      const p = { x: s.a.x + (s.b.x - s.a.x) * us[k], y: s.a.y + (s.b.y - s.a.y) * us[k] }, q = { x: s.a.x + (s.b.x - s.a.x) * us[k + 1], y: s.a.y + (s.b.y - s.a.y) * us[k + 1] };
      const i = nodeAt(p), j = nodeAt(q), len = Math.hypot(q.x - p.x, q.y - p.y);
      if (i === j || len <= 0) continue;
      const e = { i, j, len, k: edges.length };
      edges.push(e);
      nodes[i].adj.push(e); nodes[j].adj.push(e);
    }
  }
  return { nodes, edges };
}

/** Attach a point to the graph: the nearest point on an edge within reach → a new node (the edge split). → node index or -1. */
export function attach(g, p, reach) {
  let best = null;
  for (const e of g.edges) {
    if (e.dead) continue;
    const a = g.nodes[e.i], b = g.nodes[e.j];
    const q = segDist2(p, a, b);
    if (q.d2 <= reach * reach && (!best || q.d2 < best.q.d2)) best = { e, q };
  }
  if (!best) return -1;
  const { e, q } = best;
  const drop = Math.sqrt(q.d2);
  let mid;
  if (q.u <= 1e-9) mid = e.i;
  else if (q.u >= 1 - 1e-9) mid = e.j;
  else {
    mid = g.nodes.length;
    g.nodes.push({ i: mid, x: q.q.x, y: q.q.y, adj: [] });
    e.dead = true;
    const a = { i: e.i, j: mid, len: e.len * q.u, k: g.edges.length }, b = { i: mid, j: e.j, len: e.len * (1 - q.u), k: g.edges.length + 1 };
    g.edges.push(a, b);
    g.nodes[e.i].adj = g.nodes[e.i].adj.filter((x) => x !== e).concat(a);
    g.nodes[e.j].adj = g.nodes[e.j].adj.filter((x) => x !== e).concat(b);
    g.nodes[mid].adj.push(a, b);
  }
  // the drop from the point to the route
  const n = g.nodes.length;
  g.nodes.push({ i: n, x: p.x, y: p.y, adj: [] });
  const d = { i: n, j: mid, len: drop, k: g.edges.length, drop: true };
  g.edges.push(d);
  g.nodes[n].adj.push(d); g.nodes[mid].adj.push(d);
  return n;
}

/** Shortest paths from one node (Dijkstra). → {dist[], via[] (edge index)}. */
export function shortest(g, from) {
  const dist = new Array(g.nodes.length).fill(Infinity), via = new Array(g.nodes.length).fill(-1), done = new Array(g.nodes.length).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) break;
    done[u] = true;
    for (const e of g.nodes[u].adj) {
      if (e.dead) continue;
      const v = e.i === u ? e.j : e.i;
      if (dist[u] + e.len < dist[v]) { dist[v] = dist[u] + e.len; via[v] = e.k; }
    }
  }
  return { dist, via };
}

/**
 * Cable length of every circuit, in metres. opts: reach (drawing units; default 0.5 m), atDevice / atBoard (metres added
 * at each device and at the board; defaults 0.5 and 1). → Map circuit name → {metres, routed (bool), unreached [load],
 * reason ('no-board' | 'no-route' | '')}.
 */
export function cableLengths(doc, model, inst, { reach, atDevice = 0.5, atBoard = 1 } = {}) {
  const mpu = mPerUnit(doc.meta.units);
  reach = reach ?? 0.5 / mpu;
  const out = new Map();
  for (const c of inst.circuits.values()) {
    if (!c.loads.length) { out.set(c.name, { metres: 0, routed: false, unreached: [], reason: '' }); continue; }
    if (!c.board) { out.set(c.name, { metres: 0, routed: false, unreached: c.loads, reason: 'no-board' }); continue; }
    const sp = c.board.space;
    const g = routeGraph(model.routes.filter((r) => r.space.key === sp.key));   // by key: inst may come from another scan of the drawing
    const start = attach(g, c.board.at, reach);
    if (start < 0) { out.set(c.name, { metres: 0, routed: false, unreached: c.loads, reason: 'no-route' }); continue; }
    const targets = c.loads.map((l) => ({ l, n: l.space.key === sp.key ? attach(g, l.at, reach) : -1 }));
    const { dist, via } = shortest(g, start);
    const used = new Set(), unreached = [];
    for (const { l, n } of targets) {
      if (n < 0 || dist[n] === Infinity) { unreached.push(l); continue; }
      for (let v = n; v !== start;) { const e = g.edges[via[v]]; used.add(e.k); v = e.i === v ? e.j : e.i; }
    }
    let len = 0;
    for (const k of used) len += g.edges[k].len;
    const reached = targets.length - unreached.length;
    const metres = reached ? len * mpu + reached * atDevice + atBoard : 0;
    out.set(c.name, { metres, routed: reached > 0, unreached, reason: unreached.length ? 'no-route' : '' });
  }
  return out;
}

export { fullTag };
