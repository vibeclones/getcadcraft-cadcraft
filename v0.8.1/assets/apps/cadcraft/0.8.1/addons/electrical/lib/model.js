/* SPDX-License-Identifier: Apache-2.0 */
/**
 * model.js — read a CadCraft drawing as an electrical project. DOM-free; never edits.
 *
 *   scan(doc, opts) → {
 *     sheets:  [{ uid, space, frame (insert) | null, grid, number, title, plant, loc, attrs }]
 *     devices: [{ uid, id, space, e, blk, meta, sym, role, kind, sheet, path, place, pins: [{tag, label, x, y}],
 *                 tag, func, loc, fullTag }]
 *     wires:   [{ uid, id, space, e, pts: [{x,y}], sheet, layer }]      lines and polylines on a wire layer
 *     wirenos: [{ uid, id, space, e, value, locked, at: {x,y}, sheet }]
 *     dots:    [{ uid, id, space, e, at }]   cables: [{ uid, id, space, e, tag, a, b, sheet, attrs }]
 *     spaces:  [{ key, name, map, layout }]
 *   }
 * `uid` = "<space key>:<entity id>" (ids are per drawing; the space says which Map to edit).
 * A wire layer is any layer whose name starts with "EL-WIRE" (case does not matter): EL-WIRE, EL-WIRE-24VDC, …
 * Sheets: every frame insert is a sheet; a space with objects outside any frame gets one sheet of its own, numbered
 * after the framed ones (a layout's name as its title).
 */

import { readMeta, pinsOf } from './symbols.js';
import { frameGrid, pathAt, inBox, placeLabel, spacesOf } from './project.js';

export const WIRE_LAYER_RE = /^EL-WIRE/i;
export const isWireLayer = (name) => WIRE_LAYER_RE.test(String(name || ''));

/** The world points of a line or polyline (bulges are read as straight: connections only need the ends). */
export function wirePoints(e) {
  if (e.type === 'line') return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
  if (e.type === 'poly' && Array.isArray(e.pts) && e.pts.length >= 2) {
    const pts = e.pts.map((p) => ({ x: p.x, y: p.y }));
    if (e.closed) pts.push({ ...pts[0] });
    return pts;
  }
  return null;
}

/** Full IEC 81346 designation: "=A1+S2-K3" (parts that are empty are left out). */
export function fullTag(func, loc, tag) {
  const f = String(func || '').trim(), l = String(loc || '').trim(), g = String(tag || '').trim();
  if (!g) return '';
  const pre = (s, c) => (!s ? '' : s.startsWith(c) ? s : c + s);
  return pre(f, '=') + pre(l, '+') + pre(g, '-');
}

export function scan(doc) {
  const spaces = spacesOf(doc);
  const blocks = doc?.blocks instanceof Map ? doc.blocks : new Map();
  const out = { spaces, sheets: [], devices: [], wires: [], wirenos: [], dots: [], cables: [], installs: [], circuits: [], routes: [] };
  // frames first: they decide sheets
  const framed = new Map();   // space key → [sheet]
  for (const sp of spaces) {
    const list = [];
    for (const e of sp.map.values()) {
      if (e.type !== 'insert') continue;
      const blk = blocks.get(e.block), meta = readMeta(blk);
      if (meta?.role !== 'frame') continue;
      const grid = frameGrid(e, blk, meta);
      if (!grid) continue;
      const a = e.attrs || {};
      list.push({ uid: sp.key + ':' + e.id, space: sp, frame: e, grid, number: String(a.SHEET || '').trim(), title: String(a.TITLE || ''), plant: String(a.PLANT || ''), loc: String(a.LOC || ''), attrs: a });
    }
    framed.set(sp.key, list);
    out.sheets.push(...list);
  }
  // number frames that have no SHEET in the order they appear
  let hi = 0;
  for (const s of out.sheets) { const k = parseInt(s.number, 10); if (k > hi) hi = k; }
  for (const s of out.sheets) if (!s.number) s.number = String(++hi);
  const loose = new Map();
  const sheetFor = (sp, p) => {
    for (const s of framed.get(sp.key)) if (inBox(s.grid.box, p)) return s;
    let s = loose.get(sp.key);
    if (!s) {
      s = { uid: sp.key + ':*', space: sp, frame: null, grid: null, number: String(++hi), title: sp.layout ? sp.name : '', plant: '', loc: '', attrs: {} };
      loose.set(sp.key, s);
      out.sheets.push(s);
    }
    return s;
  };
  const where = (sheet, p) => {
    const path = sheet.grid ? pathAt(sheet.grid, p) : 0;
    return { sheet, path, place: placeLabel(sheet.number, path) };
  };
  for (const sp of spaces) {
    for (const e of sp.map.values()) {
      const uid = sp.key + ':' + e.id;
      if (e.type === 'insert') {
        const blk = blocks.get(e.block), meta = readMeta(blk);
        if (!meta || meta.role === 'frame') continue;
        const at = { x: e.x, y: e.y };
        const w = where(sheetFor(sp, at), at);
        const a = e.attrs || {};
        if (meta.role === 'wireno') { out.wirenos.push({ uid, id: e.id, space: sp, e, value: String(a.WIRENO ?? ''), locked: /^(1|y|yes|true)$/i.test(String(a.LOCK || '')), at, ...w }); continue; }
        if (meta.role === 'dot') { out.dots.push({ uid, id: e.id, space: sp, e, at, ...w }); continue; }
        if (meta.role === 'cable') {
          const fence = cableFence(sp.map, at);
          const pts = fence || pinsOf(e, blk, { pins: [{ tag: 'A', x: -2, y: -2 }, { tag: 'B', x: 2, y: 2 }] });
          out.cables.push({ uid, id: e.id, space: sp, e, tag: String(a.TAG || ''), a: pts[0], b: pts[1], fence: fence ? fence.line : null, attrs: a, ...w });
          continue;
        }
        if (meta.role === 'install' || meta.role === 'board' || meta.role === 'circuit') {
          (meta.role === 'circuit' ? out.circuits : out.installs).push({ uid, id: e.id, space: sp, e, blk, meta, sym: meta.sym, role: meta.role, attrs: a, at, ...w });
          continue;
        }
        const sheet = w.sheet;
        const func = String(a.FUNC || '').trim() || sheet.plant, loc = String(a.LOC || '').trim() || sheet.loc;
        const tag = String(a.TAG || '').trim();
        out.devices.push({ uid, id: e.id, space: sp, e, blk, meta, sym: meta.sym || '', role: meta.role, kind: meta.kind || '', at, ...w,
          pins: pinsOf(e, blk, meta), tag, func, loc, fullTag: fullTag(func, loc, tag), attrs: a });
        continue;
      }
      if ((e.type === 'line' || e.type === 'poly') && isWireLayer(e.layer)) {
        const pts = wirePoints(e);
        if (!pts) continue;
        out.wires.push({ uid, id: e.id, space: sp, e, pts, layer: e.layer, at: pts[0], ...where(sheetFor(sp, pts[0]), pts[0]) });
        continue;
      }
      if (e.type === 'poly' && /^EL-ROUTE/i.test(String(e.layer || '')) && Array.isArray(e.pts) && e.pts.length >= 2) out.routes.push({ uid, id: e.id, space: sp, e, pts: wirePoints(e), layer: e.layer });
      else if (e.type === 'line' && /^EL-ROUTE/i.test(String(e.layer || ''))) out.routes.push({ uid, id: e.id, space: sp, e, pts: wirePoints(e), layer: e.layer });
    }
  }
  // sheets in number order (numbers that are whole numbers first, by value)
  out.sheets.sort((a, b) => cmpNumber(a.number, b.number));
  return out;
}

/** The cable line (layer EL-CABLE) that ends at a cable tag's base point. → [a, b] (+ .line) or null. */
export function cableFence(map, at, tol = 0.5) {
  for (const e of map.values()) {
    if (e.type !== 'line' || !/^EL-CABLE/i.test(String(e.layer || ''))) continue;
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    if (Math.hypot(b.x - at.x, b.y - at.y) <= tol || Math.hypot(a.x - at.x, a.y - at.y) <= tol) { const r = [a, b]; r.line = e; return r; }
  }
  return null;
}

/** Compare sheet numbers "2" < "10" < "10a" < "B". */
export function cmpNumber(a, b) {
  const na = parseFloat(a), nb = parseFloat(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

/** Sort key for a place: sheet order, then path, then top to bottom, left to right. */
export function placeOrder(a, b) {
  return cmpNumber(a.sheet.number, b.sheet.number) || (a.path - b.path) || ((b.at?.y ?? b.y ?? 0) - (a.at?.y ?? a.y ?? 0)) || ((a.at?.x ?? a.x ?? 0) - (b.at?.x ?? b.x ?? 0));
}

/** The Map an item lives in. */
export const mapOf = (item) => item.space.map;
