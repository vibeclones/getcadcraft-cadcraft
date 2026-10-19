/* SPDX-License-Identifier: Apache-2.0 */
/**
 * wires.js — wires, connections, junction dots and wire numbers (0.4 part 2, E.2). DOM-free.
 *
 * A wire is a line or polyline on a wire layer (model.js `isWireLayer`), so a schematic is plain geometry in any CAD
 * program. What connects, and how (`netlist`), in each space separately:
 *   - a wire's end on another wire's end                     → connected (two ends = a corner; three or more = a junction)
 *   - a wire's end on another wire's middle                  → connected, a T junction (gets a dot)
 *   - a wire's end, or a wire passing, on a symbol's pin     → connected to that pin
 *   - two wires crossing with no end there                   → NOT connected (a crossing)
 *   - a terminal passes its potential through (both pins on one net)
 * A net ("potential") is everything joined that way. Wire numbers (`numberWires`) are EL_WIRENO inserts (attribute
 * WIRENO; LOCK = 1 keeps a number you typed) placed beside the net's longest segment; numbering follows a scheme
 * (`format`): "{sheet}", "{path}", "{seq}" (and "{seq:02}" style padding), one number per net, or per wire.
 * Junction dots (`updateDots`) are EL_DOT inserts at T junctions and where three or more wire ends meet.
 */

import { ensureBlock, helperBlock } from './symbols.js';
import { cmpNumber } from './model.js';
import { pathAt as pathOf } from './project.js';

export const TOL = 0.05;          // drawing units (millimetres on a sheet)
export const ASSOC = 3;           // how close a wire number must be to its wire

// ------------------------------------------------------------------------------------------------ geometry

const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
/** Distance² from p to segment ab, and where along it (0…1). */
export function segDist2(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let u = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  const q = { x: a.x + u * dx, y: a.y + u * dy };
  return { d2: d2(p, q), u, q };
}
const segs = (pts) => { const out = []; for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]); return out; };

/** A small grid index of points for "what is near here". */
class Grid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  key(x, y) { return Math.floor(x / this.cell) + ',' + Math.floor(y / this.cell); }
  add(p, v) { const k = this.key(p.x, p.y); let a = this.m.get(k); if (!a) this.m.set(k, (a = [])); a.push([p, v]); }
  near(p, r) {
    const out = [], c = this.cell, x0 = Math.floor((p.x - r) / c), x1 = Math.floor((p.x + r) / c), y0 = Math.floor((p.y - r) / c), y1 = Math.floor((p.y + r) / c);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) for (const [q, v] of this.m.get(i + ',' + j) || []) if (d2(p, q) <= r * r) out.push(v);
    return out;
  }
}

/** Segments by the grid cells their box covers, for "which segments pass near this point". */
class SegGrid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  add(a, b, v, pad) {
    const c = this.cell, x0 = Math.floor((Math.min(a.x, b.x) - pad) / c), x1 = Math.floor((Math.max(a.x, b.x) + pad) / c);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / c), y1 = Math.floor((Math.max(a.y, b.y) + pad) / c);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 1e6) return;   // a runaway coordinate: never index it
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const k = i + ',' + j; let l = this.m.get(k); if (!l) this.m.set(k, (l = [])); l.push(v); }
  }
  at(p) { return this.m.get(Math.floor(p.x / this.cell) + ',' + Math.floor(p.y / this.cell)) || []; }
}

class DSU {
  constructor() { this.p = new Map(); }
  find(a) { if (!this.p.has(a)) this.p.set(a, a); let r = a; while (this.p.get(r) !== r) r = this.p.get(r); let x = a; while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

// ------------------------------------------------------------------------------------------------ netlist

/**
 * Connections in a scanned drawing (model.js `scan`). → {
 *   nets: [{ key, wires: [wire], pins: [{device, tag, label, x, y}], start: {sheet, path, at} }],
 *   netOfWire: Map wire uid → net, netOfPin: Map "device uid|pin tag" → net,
 *   junctions: [{space, x, y}], dangling: [{wire, x, y}], throughPins: [{device, tag, wire}] }
 * joinTerminals: false keeps a terminal's two sides apart (the terminal plan asks what each side reaches).
 */
export function netlist(model, { tol = TOL, joinTerminals = true } = {}) {
  const dsu = new DSU();
  const junctions = [], dangling = [], through = [];
  const bySpace = new Map();
  for (const w of model.wires) { let s = bySpace.get(w.space.key); if (!s) bySpace.set(w.space.key, (s = { wires: [], devices: [] })); s.wires.push(w); }
  for (const d of model.devices) { let s = bySpace.get(d.space.key); if (!s) bySpace.set(d.space.key, (s = { wires: [], devices: [] })); s.devices.push(d); }
  const pinKey = (d, p) => 'p:' + d.uid + '|' + p.tag;
  for (const d of model.devices) {
    for (const p of d.pins) dsu.find(pinKey(d, p));
    if (joinTerminals && d.role === 'terminal' && d.pins.length >= 2) for (const p of d.pins.slice(1)) dsu.union(pinKey(d, d.pins[0]), pinKey(d, p));
  }
  for (const [, s] of bySpace) {
    const cell = Math.max(tol * 20, 1);
    const ends = new Grid(cell), pins = new Grid(cell);
    for (const w of s.wires) { dsu.find('w:' + w.uid); ends.add(w.pts[0], { w, i: 0 }); ends.add(w.pts[w.pts.length - 1], { w, i: 1 }); }
    for (const d of s.devices) for (const p of d.pins) pins.add(p, { d, p });
    const tol2 = tol * tol;
    const sg = new SegGrid(5);
    for (const o of s.wires) { const ss = segs(o.pts); ss.forEach(([a, b], k) => sg.add(a, b, { o, k, a, b, last: ss.length - 1 }, tol)); }
    // a point → its junction record (wire contributions meeting there)
    const meet = new Grid(cell);
    const meets = [];
    const meetAt = (p) => { const hit = meet.near(p, tol)[0]; if (hit) return hit; const m = { x: p.x, y: p.y, n: 0, pin: false, space: s.wires[0]?.space }; meet.add(p, m); meets.push(m); return m; };
    for (const w of s.wires) {
      for (const [i, p] of [[0, w.pts[0]], [1, w.pts[w.pts.length - 1]]]) {
        let joined = false;
        const m = meetAt(p);
        m.n++;
        for (const o of ends.near(p, tol)) if (o.w !== w || o.i !== i) { dsu.union('w:' + w.uid, 'w:' + o.w.uid); joined = true; }
        for (const { d, p: pin } of pins.near(p, tol)) { dsu.union('w:' + w.uid, pinKey(d, pin)); joined = true; m.pin = true; }
        // on another wire's middle (or this wire's own, for a loop); an inner corner of a polyline is its middle too
        const seen = new Set();
        for (const { o, k, a, b, last } of sg.at(p)) {
          if (seen.has(o)) continue;
          if (segDist2(p, a, b).d2 > tol2) continue;
          if ((k === 0 && d2(p, a) <= tol2) || (k === last && d2(p, b) <= tol2)) continue;
          if (o === w && ((i === 0 && k === 0) || (i === 1 && k === last))) continue;
          seen.add(o);
          dsu.union('w:' + w.uid, 'w:' + o.uid); joined = true;
          m.n += 2;
        }
        if (!joined) dangling.push({ wire: w, x: p.x, y: p.y });
      }
    }
    // pins a wire passes through (not at its end)
    for (const d of s.devices) for (const pin of d.pins) {
      const hit = new Set();
      for (const { o, k, a, b, last } of sg.at(pin)) {
        if (hit.has(o)) continue;
        if (segDist2(pin, a, b).d2 <= tol2 && !(k === 0 && d2(pin, a) <= tol2) && !(k === last && d2(pin, b) <= tol2)) hit.add(o);
      }
      for (const w of hit) { dsu.union('w:' + w.uid, pinKey(d, pin)); through.push({ device: d, tag: pin.tag, wire: w }); }
    }
    for (const m of meets) if (m.n >= 3 && !m.pin) junctions.push({ space: m.space, x: m.x, y: m.y });
  }
  // collect nets
  const nets = new Map();
  const netFor = (root) => { let n = nets.get(root); if (!n) nets.set(root, (n = { key: root, wires: [], pins: [] })); return n; };
  const netOfWire = new Map(), netOfPin = new Map();
  for (const w of model.wires) { const n = netFor(dsu.find('w:' + w.uid)); n.wires.push(w); netOfWire.set(w.uid, n); }
  for (const d of model.devices) for (const p of d.pins) {
    const n = netFor(dsu.find(pinKey(d, p)));
    n.pins.push({ device: d, tag: p.tag, label: p.label, x: p.x, y: p.y });
    netOfPin.set(d.uid + '|' + p.tag, n);
  }
  const list = [...nets.values()].filter((n) => n.wires.length);
  for (const n of list) {
    let best = null;
    for (const w of n.wires) for (const p of w.pts) {
      const cand = { sheet: w.sheet, path: w.path, at: p, w };
      if (!best || cmpNumber(cand.sheet.number, best.sheet.number) < 0 || (cand.sheet === best.sheet && (p.y > best.at.y + 1e-9 || (Math.abs(p.y - best.at.y) <= 1e-9 && p.x < best.at.x)))) best = cand;
    }
    // the path of the start point itself
    const g = best.sheet.grid;
    best.path = g ? pathOf(g, best.at) : 0;
    n.start = best;
  }
  return { nets: list, netOfWire, netOfPin, junctions, dangling, throughPins: through };
}


// ------------------------------------------------------------------------------------------------ wire numbers

/** Fill a numbering scheme: "{sheet}.{path}.{seq}", "{seq:03}", "W{seq}" … */
export function formatNumber(format, v) {
  return String(format || '{sheet}.{path}.{seq}').replace(/\{(sheet|path|seq)(?::(0\d))?\}/g, (m, k, pad) => {
    const s = String(v[k] ?? '');
    return pad ? s.padStart(Number(pad), '0') : s;
  });
}

/** Where a wire number goes on a net: the middle of its longest segment on its first sheet. → {x, y, rot, wire}. */
export function numberSpot(net) {
  let best = null;
  const sheet = net.start.sheet;
  for (const w of net.wires) {
    if (w.sheet !== sheet && net.wires.some((x) => x.sheet === sheet)) continue;
    for (const [a, b] of segs(w.pts)) {
      const len = Math.sqrt(d2(a, b));
      if (!best || len > best.len + 1e-9) best = { len, a, b, w };
    }
  }
  if (!best) return null;
  let ang = Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x);
  if (ang > Math.PI / 2 + 1e-9) ang -= Math.PI; else if (ang <= -Math.PI / 2 + 1e-9) ang += Math.PI;   // text reads left to right or bottom to top
  return { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2, rot: ang, wire: best.w };
}

/** The net each wire number sits on (nearest segment within ASSOC). → Map wireno uid → net | null. */
export function wirenoNets(model, nl, assoc = ASSOC) {
  const out = new Map();
  for (const wn of model.wirenos) {
    let best = null;
    for (const w of model.wires) {
      if (w.space.key !== wn.space.key) continue;
      for (const [a, b] of segs(w.pts)) { const r = segDist2(wn.at, a, b); if (r.d2 <= assoc * assoc && (!best || r.d2 < best.d2)) best = { d2: r.d2, w }; }
    }
    out.set(wn.uid, best ? nl.netOfWire.get(best.w.uid) : null);
  }
  return out;
}

/**
 * Number the wires (inside doc.change — the caller's). opts: format, per ('net' | 'wire'), start (first seq), clean
 * (remove wire numbers that sit on no wire), layer. Locked numbers stay and are never given to another net.
 * → {added, changed, removed, kept, numbers: Map net key → number}.
 */
export function numberWires(doc, model, nl, { format = '{sheet}.{path}.{seq}', per = 'net', start = 1, clean = true, layer = 'EL-WIRENO' } = {}) {
  ensureBlock(doc, helperBlock('wireno'));
  const owners = wirenoNets(model, nl);
  // groups to number: nets, or every wire on its own
  const groups = per === 'wire'
    ? nl.nets.flatMap((n) => n.wires.map((w) => ({ key: 'w:' + w.uid, wires: [w], pins: [], start: { sheet: w.sheet, path: w.sheet.grid ? pathOf(w.sheet.grid, w.pts[0]) : 0, at: w.pts[0] }, net: n })))
    : nl.nets.map((n) => ({ key: n.key, wires: n.wires, pins: n.pins, start: n.start, net: n }));
  const wirenosOf = new Map(groups.map((g) => [g.key, []]));
  const groupOfWire = new Map();
  for (const g of groups) for (const w of g.wires) groupOfWire.set(w.uid, g);
  const orphans = [];
  for (const wn of model.wirenos) {
    const net = owners.get(wn.uid);
    if (!net) { orphans.push(wn); continue; }
    let g = null;
    if (per === 'wire') {
      // nearest wire of that net
      let best = null;
      for (const w of net.wires) for (const [a, b] of segs(w.pts)) { const r = segDist2(wn.at, a, b); if (!best || r.d2 < best.d2) best = { d2: r.d2, w }; }
      g = best && groupOfWire.get(best.w.uid);
    } else g = groups.find((x) => x.net === net);
    if (g) wirenosOf.get(g.key).push(wn); else orphans.push(wn);
  }
  const used = new Set();
  for (const g of groups) for (const wn of wirenosOf.get(g.key)) if (wn.locked && wn.value) used.add(wn.value);
  groups.sort((a, b) => cmpNumber(a.start.sheet.number, b.start.sheet.number) || (a.start.path - b.start.path) || (b.start.at.y - a.start.at.y) || (a.start.at.x - b.start.at.x));
  const seqOf = new Map();
  const numbers = new Map();
  const r = { added: 0, changed: 0, removed: 0, kept: 0, numbers };
  for (const g of groups) {
    const mine = wirenosOf.get(g.key);
    const locked = mine.find((wn) => wn.locked && wn.value);
    let value;
    if (locked) value = locked.value;
    else {
      const k = g.start.sheet.number + '|' + g.start.path;
      let seq = seqOf.get(k) ?? start;
      do { value = formatNumber(format, { sheet: g.start.sheet.number, path: g.start.path, seq }); seq++; } while (used.has(value));
      seqOf.set(k, seq);
      used.add(value);
    }
    numbers.set(g.key, value);
    if (!mine.length) {
      const spot = numberSpot(g);
      if (!spot) continue;
      doc.add({ type: 'insert', block: 'EL_WIRENO', x: spot.x, y: spot.y, sx: 1, sy: 1, rot: spot.rot, layer, attrs: { WIRENO: value, LOCK: '' } }, spot.wire.space.map);
      r.added++;
      continue;
    }
    for (const wn of mine) {
      if (wn.locked && wn.value) { r.kept++; continue; }
      if (wn.value === value) { r.kept++; continue; }
      doc.update(wn.id, { ...wn.e, attrs: { ...(wn.e.attrs || {}), WIRENO: value } }, wn.space.map);
      r.changed++;
    }
  }
  if (clean) for (const wn of orphans) { doc.remove(wn.id, wn.space.map); r.removed++; }
  return r;
}

// ------------------------------------------------------------------------------------------------ junction dots

/** Put dots where junctions are and take away the ones that no longer mark one (inside a change). → {added, removed}. */
export function updateDots(doc, model, nl, { tol = TOL } = {}) {
  const want = nl.junctions.map((j) => ({ ...j, have: false }));
  let added = 0, removed = 0;
  const t2 = Math.max(tol, 0.2) ** 2;
  for (const dot of model.dots) {
    const hit = want.find((j) => !j.have && j.space?.key === dot.space.key && d2(j, dot.at) <= t2);
    if (hit) hit.have = true;
    else { doc.remove(dot.id, dot.space.map); removed++; }
  }
  const missing = want.filter((j) => !j.have);
  if (missing.length) ensureBlock(doc, helperBlock('dot'));
  for (const j of missing) {
    const w = model.wires.find((x) => x.space.key === j.space?.key && x.pts.some((p, i) => i + 1 < x.pts.length && segDist2(j, p, x.pts[i + 1]).d2 <= t2));
    doc.add({ type: 'insert', block: 'EL_DOT', x: j.x, y: j.y, sx: 1, sy: 1, rot: 0, layer: w?.layer || 'EL-WIRE' }, j.space.map);
    added++;
  }
  return { added, removed };
}

/** The wire number(s) shown on a net, for lists: "2.4.1" (several distinct ones joined with ", "). */
export function netNumber(model, nl, net, owners = wirenoNets(model, nl)) {
  const vals = new Set();
  for (const wn of model.wirenos) if (owners.get(wn.uid) === net && wn.value) vals.add(wn.value);
  return [...vals].join(', ');
}
