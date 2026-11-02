/* SPDX-License-Identifier: Apache-2.0 */
/**
 * designblocks.js — design blocks (0.5 WL.35): part of a schematic (symbols, wires, wire numbers, text, frames of
 * geometry) saved once and placed again, retagged and renumbered. DOM-free; tested in Node (test/test.mjs § Design blocks).
 *
 *   capture(doc, ids, base, name)  → a design block { format, version, name, created, entities, blocks } — the objects
 *                                    relative to the base point, with every block definition they use (nested ones too)
 *   read(raw)                      → a clean design block, or null (untrusted: a file someone sent, or localStorage)
 *   place(doc, db, at, opts)       → { ids, tagged, terminals, numbered, kept } (inside the caller's doc.change: one undo
 *                                    step). Symbols get new tags (the drawing's tag scheme; a contact follows its coil when
 *                                    the coil came in the same block, else keeps its tag), terminals new numbers on their
 *                                    strip, cross-references are worked out again, and only the new wires get numbers:
 *                                    every number already in the drawing stays.
 *   leftOut(doc, ids)              → how many of the selected objects a design block cannot carry (dimensions, leaders…)
 * A block of the same name already in the drawing wins over the one in the design block (as pasting does).
 */

import { readMeta } from './symbols.js';
import { scan } from './model.js';
import { netlist, numberWires, updateDots } from './wires.js';
import { autoTag, updateXrefs } from './devices.js';

export const FORMAT = 'cadcraft-electrical-design-block';
export const VERSION = 1;
export const LIMITS = { entities: 5000, blocks: 300, points: 20000, text: 2000, name: 80, json: 4 * 1024 * 1024 };
const TYPES = new Set(['line', 'poly', 'circle', 'arc', 'ellipse', 'text', 'point', 'insert', 'hatch']);
const RETAG = new Set(['coil', 'device', 'plc']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const fin = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;

/** An entity moved by (dx, dy): every coordinate field each type has (attribute spots of an insert too). */
export function moved(e, dx, dy) {
  const o = clone(e);
  const xy = (p) => { p.x += dx; p.y += dy; };
  switch (o.type) {
    case 'line': o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; break;
    case 'poly': o.pts.forEach(xy); break;
    case 'circle': case 'arc': case 'ellipse': o.cx += dx; o.cy += dy; break;
    case 'hatch': o.loops = o.loops.map((l) => l.map((v, i) => v + (i % 2 ? dy : dx))); break;
    default: o.x += dx; o.y += dy;
  }
  if (o.attloc) for (const k of Object.keys(o.attloc)) xy(o.attloc[k]);
  return o;
}

function strip(e) {
  const o = clone(e);
  delete o.id; delete o.xd;
  return o;
}

/** Every block an entity list uses, nested ones too: Map name → definition (copies). */
function blocksUsed(doc, entities, out = new Map()) {
  for (const e of entities) {
    if (e.type !== 'insert' || out.has(e.block)) continue;
    const b = doc.blocks.get(e.block);
    if (!b) continue;
    const def = { name: b.name, base: clone(b.base || { x: 0, y: 0 }), entities: [...(b.entities instanceof Map ? b.entities.values() : b.entities || [])].map(strip) };
    if (b.attdefs) def.attdefs = clone(b.attdefs);
    out.set(e.block, def);
    blocksUsed(doc, def.entities, out);
  }
  return out;
}

export function leftOut(doc, ids) {
  return ids.map((id) => doc.get(id)).filter((e) => e && !TYPES.has(e.type)).length;
}

export function capture(doc, ids, base, name) {
  const ents = ids.map((id) => doc.get(id)).filter((e) => e && TYPES.has(e.type));
  const entities = ents.map((e) => moved(strip(e), -base.x, -base.y));
  return { format: FORMAT, version: VERSION, name: String(name).trim().slice(0, LIMITS.name), created: new Date().toISOString(),
    entities, blocks: [...blocksUsed(doc, ents).values()] };
}

/** One untrusted entity → a clean copy, or null. */
function cleanEntity(e) {
  if (!e || typeof e !== 'object' || !TYPES.has(e.type)) return null;
  const o = { type: e.type, layer: typeof e.layer === 'string' ? e.layer.slice(0, 255) : '0', color: e.color === null || e.color === undefined ? null : (Number.isInteger(e.color) && e.color >= 0 && e.color <= 256) || /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : null };
  for (const k of ['lt', 'lw', 'lts']) if (e[k] !== undefined && (typeof e[k] === 'string' ? e[k].length < 80 : fin(e[k]))) o[k] = e[k];
  const nums = (...ks) => ks.every((k) => fin(e[k])) && (ks.forEach((k) => { o[k] = e[k]; }), true);
  switch (e.type) {
    case 'line': return nums('x1', 'y1', 'x2', 'y2') ? o : null;
    case 'circle': return nums('cx', 'cy', 'r') ? o : null;
    case 'arc': return nums('cx', 'cy', 'r', 'a0', 'a1') ? o : null;
    case 'ellipse': return nums('cx', 'cy', 'mx', 'my', 'ratio', 't0', 't1') ? o : null;
    case 'point': return nums('x', 'y') ? o : null;
    case 'poly':
      if (!Array.isArray(e.pts) || e.pts.length < 2 || e.pts.length > LIMITS.points || !e.pts.every((p) => p && fin(p.x) && fin(p.y) && (p.b === undefined || fin(p.b)))) return null;
      o.pts = e.pts.map((p) => ({ x: p.x, y: p.y, b: p.b || 0 })); o.closed = !!e.closed; return o;
    case 'hatch':
      if (!Array.isArray(e.loops) || e.loops.length > 500 || !e.loops.every((l) => Array.isArray(l) && l.length >= 6 && l.length <= LIMITS.points && l.every(fin))) return null;
      o.loops = e.loops.map((l) => l.slice()); o.solid = !!e.solid; if (typeof e.pattern === 'string') o.pattern = e.pattern.slice(0, 64); return o;
    case 'text':
      if (!nums('x', 'y', 'h') || typeof e.s !== 'string') return null;
      o.s = e.s.slice(0, LIMITS.text); o.rot = fin(e.rot) ? e.rot : 0;
      for (const k of ['ha', 'va']) if (typeof e[k] === 'string' && e[k].length < 12) o[k] = e[k];
      for (const k of ['wf', 'ww', 'ls']) if (fin(e[k])) o[k] = e[k];
      return o;
    case 'insert':
      if (!nums('x', 'y') || typeof e.block !== 'string' || !e.block || e.block.length > 255) return null;
      o.block = e.block; o.sx = fin(e.sx) ? e.sx : 1; o.sy = fin(e.sy) ? e.sy : 1; o.rot = fin(e.rot) ? e.rot : 0;
      if (e.attrs && typeof e.attrs === 'object') { o.attrs = {}; for (const [k, v] of Object.entries(e.attrs).slice(0, 200)) if (/^[A-Z0-9_$-]{1,64}$/.test(k)) o.attrs[k] = String(v ?? '').slice(0, LIMITS.text); }
      if (e.attloc && typeof e.attloc === 'object') { o.attloc = {}; for (const [k, v] of Object.entries(e.attloc).slice(0, 200)) if (/^[A-Z0-9_$-]{1,64}$/.test(k) && v && fin(v.x) && fin(v.y)) o.attloc[k] = clone(v); }
      return o;
  }
  return null;
}

export function read(raw) {
  let d = raw;
  if (typeof raw === 'string') { if (raw.length > LIMITS.json) return null; try { d = JSON.parse(raw); } catch { return null; } }
  if (!d || typeof d !== 'object' || d.format !== FORMAT || d.version !== VERSION || typeof d.name !== 'string' || !d.name.trim()) return null;
  if (!Array.isArray(d.entities) || d.entities.length > LIMITS.entities || !Array.isArray(d.blocks) || d.blocks.length > LIMITS.blocks) return null;
  const entities = d.entities.map(cleanEntity).filter(Boolean);
  if (!entities.length) return null;
  const blocks = [];
  for (const b of d.blocks) {
    if (!b || typeof b.name !== 'string' || !b.name || b.name.length > 255 || !Array.isArray(b.entities) || b.entities.length > LIMITS.entities) continue;
    const def = { name: b.name, base: b.base && fin(b.base.x) && fin(b.base.y) ? { x: b.base.x, y: b.base.y } : { x: 0, y: 0 }, entities: b.entities.map(cleanEntity).filter(Boolean) };
    if (Array.isArray(b.attdefs)) def.attdefs = b.attdefs.slice(0, 200).filter((a) => a && typeof a.tag === 'string' && /^[A-Z0-9_$-]{1,64}$/.test(a.tag) && fin(a.x) && fin(a.y)).map(clone);
    blocks.push(def);
  }
  // every insert must point at a block it brings or a name the drawing may have (placing checks again)
  return { format: FORMAT, version: VERSION, name: d.name.trim().slice(0, LIMITS.name), created: typeof d.created === 'string' ? d.created.slice(0, 40) : '', entities, blocks };
}

export function place(doc, db, at, { scheme = 'path', strip: termStrip = '-X1', format = '{sheet}.{path}.{seq}', per = 'net', layer = 'EL-WIRENO' } = {}) {
  for (const b of db.blocks) if (!doc.blocks.get(b.name)) doc.defineBlock(clone(b));
  const roleOf = (e) => (e.type === 'insert' ? readMeta(doc.blocks.get(e.block))?.role || null : null);
  const ids = [], oldTag = new Map();
  for (const src of db.entities) {
    if (src.type === 'insert' && !doc.blocks.get(src.block)) continue;   // a block it does not bring and the drawing lacks
    const e = moved(src, at.x, at.y);
    const role = roleOf(e);
    if (role) {
      const a = { ...(e.attrs || {}) };
      oldTag.set(ids.length, a.TAG || '');
      for (const k of Object.keys(a)) if (/^XREF\d?$/.test(k)) a[k] = '';
      if (RETAG.has(role)) a.TAG = '';
      if (role === 'terminal') a.P1 = '';
      e.attrs = a;
    }
    if (e.type === 'insert' && e.block === 'EL_WIRENO') e.attrs = { ...(e.attrs || {}), WIRENO: '', LOCK: '' };
    ids.push(doc.add(e).id);
  }
  const mine = new Set(ids);
  const uidsOf = (list) => new Set(list.filter((x) => mine.has(x.id) && x.space.map === doc.entities).map((x) => x.uid));
  // tags: coils, devices, PLC (the drawing's scheme); terminals: next numbers on their strip
  let model = scan(doc);
  const tagged = autoTag(doc, model, { scheme, strip: termStrip, only: uidsOf(model.devices) });
  // contacts follow their coil when it came in the block
  const renamed = new Map();
  for (const { device, tag } of tagged.tagged) { const i = ids.indexOf(device.id); const was = oldTag.get(i); if (was && device.role === 'coil') renamed.set(was, tag); }
  model = scan(doc);
  for (const d of model.devices) {
    if (!mine.has(d.id) || d.role !== 'contact' || d.space.map !== doc.entities) continue;
    const was = oldTag.get(ids.indexOf(d.id));
    if (was && renamed.has(was)) doc.update(d.id, { ...d.e, attrs: { ...(d.e.attrs || {}), TAG: renamed.get(was) } });
  }
  // wire numbers: only the new wires; every number already in the drawing stays (and is not given out again)
  model = scan(doc);
  const nl = netlist(model);
  const num = numberWires(doc, model, nl, { format, per, layer, only: uidsOf(model.wires) });
  model = scan(doc);
  updateXrefs(doc, model);
  updateDots(doc, model, netlist(model));
  return { ids, tagged: tagged.tagged.length, terminals: tagged.terminals, numbered: num.added + num.changed, kept: num.kept };
}
