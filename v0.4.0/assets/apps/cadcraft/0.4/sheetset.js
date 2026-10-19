/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sheetset.js — sheet sets (0.4 part 2, track Z): one set brings together sheets (layouts) from many drawing files, numbered
 * and titled, in subsets, published as one PDF. DOM-free: bin/test-cadcraft.mjs drives it in Node; sheetset-panel.js is
 * the page side.
 *
 * The file: `<name>.ccsheets`, JSON, UTF-8. Paths are relative to the folder the set file is in, with "/" between folders
 * (a "\" from Windows is read as "/"); an absolute path or a drive letter is refused, so a set moves with its folder.
 *
 *   {
 *     "format": "cadcraft-sheetset", "version": 1,
 *     "name": "Riverside Clinic",
 *     "properties": { "PROJECTNAME": "Riverside Clinic", "PROJECTNUMBER": "2026-014", "CLIENT": "…" },   (your own fields)
 *     "layoutNames": "number-title",            how layout tabs follow the sheet: "number-title" | "number" | "title" | "keep"
 *     "template": { "file": "templates/A1.dwg", "layout": "A1" },               new sheets copy this layout (optional)
 *     "sheets": [ sheet… ],                     sheets not in a subset, first
 *     "subsets": [ { "id", "name", "sheets": [ sheet… ], "subsets": [ … ] } ]
 *   }
 *   sheet = { "id", "file": "plans/Level 1.dwg", "layout": "A-101 Floor plan", "number": "A-101", "title": "Floor plan",
 *             "description": "", "properties": { … } }
 *
 * Reading (readSheetSet) treats the file as untrusted: unknown keys are dropped, strings checked (no control characters,
 * names ≤ 255, descriptions ≤ 2000), at most 2000 sheets, 200 subsets, 8 levels, 100 properties; ids made unique.
 *
 *   newSheetSet(name) · readSheetSet(text) → { set, notes } (throws SheetSetError, a translated message) · writeSheetSet(set)
 *   allSheets(set) → [{ sheet, path: [subset…], index }] in set order · findSheet(set, id) · findSubset(set, id)
 *   sheetLabel(sheet) → "A-101 — Floor plan" · layoutNameFor(set, sheet) → the tab name the set gives that sheet
 *   Edits return a new set (the panel keeps them for undo): addSheet(set, sheet, { subset, at }) · removeSheet(set, id) ·
 *   moveSheet(set, id, { subset, at }) · updateSheet(set, id, patch) · addSubset(set, name, { parent }) ·
 *   renameSubset(set, id, name) · removeSubset(set, id) (its sheets move up) · renumber(set, ids, { prefix, start, step,
 *   digits }) · setProperties(set, props)
 *   Fields (Z.3): FIELD_NAMES · fieldValues(set, sheet) → { SHEETNUMBER, SHEETTITLE, … } · fillTitleBlocks(doc, layout,
 *   values) → how many attributes changed (one undo step) · fieldTag(tag) → the field a title-block attribute tag means
 *   Sheet list (Z.6): sheetListEntities(set) · placeSheetList(doc, layout, set) · refreshSheetList(doc, set) — the table
 *   lives in block CC_SHEETLIST, so Update drawings redefines it wherever it is placed
 */

import { t } from './i18n.js';

export const FORMAT = 'cadcraft-sheetset';
export const VERSION = 1;
export const EXT = '.ccsheets';
export const LAYOUT_NAMES = ['number-title', 'number', 'title', 'keep'];
const LIMITS = { sheets: 2000, subsets: 200, depth: 8, props: 100, name: 255, text: 2000, path: 1024 };

export class SheetSetError extends Error {}
const fail = (key, vars) => { throw new SheetSetError(t(key, vars)); };

// ---------------------------------------------------------------------------- strings and paths

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function str(v, max = LIMITS.name, multi = false) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  let s = String(v).replace(CTRL, '');
  if (!multi) s = s.replace(/[\r\n\t]+/g, ' ');
  return s.trim().slice(0, max);
}
/** A path inside the set's folder: "/" separators, no absolute path, no drive letter; '' when it is not one. */
export function cleanPath(p) {
  let s = str(p, LIMITS.path).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return '';
  s = s.split('/').filter((x) => x !== '.' && x !== '').join('/');
  return s;
}
/** "plans/Level 1.dwg" relative to "sets/" … the folder parts of a set-relative path. */
export const pathParts = (p) => cleanPath(p).split('/').filter(Boolean);
const PROP_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
function props(o, notes, where) {
  const out = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  let n = 0;
  for (const [k0, v] of Object.entries(o)) {
    const k = String(k0).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!PROP_KEY.test(k)) continue;
    if (++n > LIMITS.props) { notes.push(t('sheetset.read.props', { where })); break; }
    out[k] = str(v, LIMITS.text);
  }
  return out;
}

// ---------------------------------------------------------------------------- the set

export function newSheetSet(name = t('sheetset.h')) {
  return { format: FORMAT, version: VERSION, name: str(name) || t('sheetset.h'), properties: {}, layoutNames: 'number-title', template: null, sheets: [], subsets: [] };
}

/** The .ccsheets text → { set, notes }. Throws SheetSetError when it is not a sheet set CadCraft can read. */
export function readSheetSet(text) {
  let o;
  try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch { fail('sheetset.read.json'); }
  if (!o || typeof o !== 'object' || o.format !== FORMAT) fail('sheetset.read.format');
  if (!(Number.isInteger(o.version) && o.version >= 1)) fail('sheetset.read.format');
  if (o.version > VERSION) fail('sheetset.read.newer', { v: o.version });
  const notes = [];
  const ids = new Set();
  const uid = (want, pre) => { let id = typeof want === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(want) ? want : ''; if (!id || ids.has(id)) { let k = ids.size + 1; do id = pre + k++; while (ids.has(id)); } ids.add(id); return id; };
  let nSheets = 0, nSubsets = 0, dropped = 0;
  const sheet = (s) => {
    if (!s || typeof s !== 'object') { dropped++; return null; }
    const file = cleanPath(s.file), layout = str(s.layout);
    if (!file || !layout) { dropped++; return null; }
    if (++nSheets > LIMITS.sheets) { dropped++; return null; }
    return { id: uid(s.id, 's'), file, layout, number: str(s.number), title: str(s.title), description: str(s.description, LIMITS.text, true), properties: props(s.properties, notes, layout) };
  };
  const sheets = (list) => (Array.isArray(list) ? list : []).map(sheet).filter(Boolean);
  const subsets = (list, depth) => {
    if (!Array.isArray(list)) return [];
    if (depth > LIMITS.depth) { if (list.length) notes.push(t('sheetset.read.deep')); return []; }
    const out = [];
    for (const g of list) {
      if (!g || typeof g !== 'object') continue;
      if (++nSubsets > LIMITS.subsets) { notes.push(t('sheetset.read.subsets')); break; }
      out.push({ id: uid(g.id, 'g'), name: str(g.name) || t('sheetset.subset.unnamed'), sheets: sheets(g.sheets), subsets: subsets(g.subsets, depth + 1) });
    }
    return out;
  };
  const set = {
    format: FORMAT, version: VERSION, name: str(o.name) || t('sheetset.h'), properties: props(o.properties, notes, 'set'),
    layoutNames: LAYOUT_NAMES.includes(o.layoutNames) ? o.layoutNames : 'number-title',
    template: o.template && cleanPath(o.template.file) && str(o.template.layout) ? { file: cleanPath(o.template.file), layout: str(o.template.layout) } : null,
    sheets: sheets(o.sheets), subsets: subsets(o.subsets, 1),
  };
  if (dropped) notes.push(t('sheetset.read.dropped', { n: dropped }));
  return { set, notes };
}

/** The set as .ccsheets text (stable key order, two-space indent, a newline at the end). */
export function writeSheetSet(set) {
  const sheet = (s) => ({ id: s.id, file: s.file, layout: s.layout, number: s.number || '', title: s.title || '', ...(s.description ? { description: s.description } : {}), ...(s.properties && Object.keys(s.properties).length ? { properties: s.properties } : {}) });
  const sub = (g) => ({ id: g.id, name: g.name, sheets: g.sheets.map(sheet), ...(g.subsets.length ? { subsets: g.subsets.map(sub) } : {}) });
  return JSON.stringify({
    format: FORMAT, version: VERSION, name: set.name, properties: set.properties || {}, layoutNames: set.layoutNames || 'number-title',
    ...(set.template ? { template: set.template } : {}), sheets: set.sheets.map(sheet), subsets: set.subsets.map(sub),
  }, null, 2) + '\n';
}

// ---------------------------------------------------------------------------- reading the tree

/** Every sheet in set order (top-level sheets first, then each subset depth-first): [{ sheet, path, index }]. */
export function allSheets(set) {
  const out = [];
  const walk = (sheets, subsets, path) => {
    for (const s of sheets) out.push({ sheet: s, path, index: out.length });
    for (const g of subsets) walk(g.sheets, g.subsets, [...path, g]);
  };
  walk(set.sheets, set.subsets, []);
  return out;
}
export const findSheet = (set, id) => allSheets(set).find((x) => x.sheet.id === id)?.sheet || null;
export function findSubset(set, id) {
  let hit = null;
  const walk = (list) => { for (const g of list) { if (g.id === id) hit = g; else walk(g.subsets); } };
  walk(set.subsets);
  return hit;
}
export function sheetLabel(s) {
  const n = (s.number || '').trim(), ti = (s.title || '').trim();
  return n && ti ? n + ' — ' + ti : n || ti || s.layout;
}
/** The layout (tab) name the set gives a sheet (Z.5): "A-101 Floor plan", "A-101", "Floor plan", or its own. */
export function layoutNameFor(set, s) {
  const n = (s.number || '').trim(), ti = (s.title || '').trim();
  switch (set.layoutNames) {
    case 'number': return n || s.layout;
    case 'title': return ti || s.layout;
    case 'keep': return s.layout;
    default: return (n && ti ? n + ' ' + ti : n || ti || s.layout).slice(0, 255);
  }
}

// ---------------------------------------------------------------------------- edits (each returns a new set)

const clone = (set) => JSON.parse(JSON.stringify(set));
function freshId(set, pre) {
  const used = new Set([...allSheets(set).map((x) => x.sheet.id)]);
  const walk = (l) => { for (const g of l) { used.add(g.id); walk(g.subsets); } };
  walk(set.subsets);
  let k = used.size + 1, id;
  do id = pre + k++; while (used.has(id));
  return id;
}
/** The list a sheet lives in (the set's own or a subset's), and its index there. */
function locate(set, id) {
  if (set.sheets.some((s) => s.id === id)) return { list: set.sheets, i: set.sheets.findIndex((s) => s.id === id) };
  let hit = null;
  const walk = (l) => { for (const g of l) { const i = g.sheets.findIndex((s) => s.id === id); if (i >= 0) hit = { list: g.sheets, i, subset: g }; else walk(g.subsets); } };
  walk(set.subsets);
  return hit;
}
const target = (set, subset) => (subset ? findSubset(set, subset)?.sheets : set.sheets);

export function addSheet(set, sheet, { subset = null, at = Infinity } = {}) {
  const n = clone(set);
  const list = target(n, subset) || n.sheets;
  const s = { id: freshId(n, 's'), file: cleanPath(sheet.file), layout: str(sheet.layout), number: str(sheet.number), title: str(sheet.title), description: str(sheet.description, LIMITS.text, true), properties: { ...(sheet.properties || {}) } };
  if (!s.file || !s.layout) fail('sheetset.err.sheet');
  list.splice(Math.max(0, Math.min(list.length, at)), 0, s);
  return { set: n, id: s.id };
}
export function removeSheet(set, id) {
  const n = clone(set), at = locate(n, id);
  if (at) at.list.splice(at.i, 1);
  return n;
}
export function moveSheet(set, id, { subset = null, at = Infinity } = {}) {
  const n = clone(set), from = locate(n, id);
  if (!from) return n;
  const [s] = from.list.splice(from.i, 1);
  const list = target(n, subset) || n.sheets;
  list.splice(Math.max(0, Math.min(list.length, at)), 0, s);
  return n;
}
export function updateSheet(set, id, patch) {
  const n = clone(set), at = locate(n, id);
  if (!at) return n;
  const s = at.list[at.i];
  for (const k of ['number', 'title', 'layout']) if (patch[k] !== undefined) s[k] = str(patch[k]);
  if (patch.file !== undefined) s.file = cleanPath(patch.file) || s.file;
  if (patch.description !== undefined) s.description = str(patch.description, LIMITS.text, true);
  if (patch.properties !== undefined) s.properties = props(patch.properties, [], s.layout);
  return n;
}
export function addSubset(set, name, { parent = null } = {}) {
  const n = clone(set);
  const g = { id: freshId(n, 'g'), name: str(name) || t('sheetset.subset.unnamed'), sheets: [], subsets: [] };
  (parent ? findSubset(n, parent)?.subsets || n.subsets : n.subsets).push(g);
  return { set: n, id: g.id };
}
export function renameSubset(set, id, name) {
  const n = clone(set), g = findSubset(n, id);
  if (g && str(name)) g.name = str(name);
  return n;
}
/** Remove a subset; its sheets and subsets move up to where it was. */
export function removeSubset(set, id) {
  const n = clone(set);
  const walk = (owner) => {   // owner: the set or a subset (both have sheets and subsets)
    const i = owner.subsets.findIndex((g) => g.id === id);
    if (i < 0) return owner.subsets.some(walk);
    const g = owner.subsets[i];
    owner.subsets.splice(i, 1, ...g.subsets);
    owner.sheets.push(...g.sheets);
    return true;
  };
  walk(n);
  return n;
}
/**
 * Number sheets in set order (Z.5): `ids` (default every sheet) get prefix + a running number (start, step), zero-padded
 * to `digits`. "A-1" + start 101 → A-101, A-102 …
 */
export function renumber(set, ids = null, { prefix = '', start = 1, step = 1, digits = 0 } = {}) {
  const n = clone(set);
  const want = ids ? new Set(ids) : null;
  let k = Number.isFinite(+start) ? +start : 1;
  for (const { sheet } of allSheets(n)) {
    if (want && !want.has(sheet.id)) continue;
    sheet.number = str(prefix + String(k).padStart(Math.max(0, digits | 0), '0'));
    k += Number.isFinite(+step) && +step ? +step : 1;
  }
  return n;
}
export function setProperties(set, p) { const n = clone(set); n.properties = props(p, [], 'set'); return n; }

// ---------------------------------------------------------------------------- fields (Z.3)

/** The fields a title block can show. Attribute tags with these names (or a common alias) are filled from the set. */
export const FIELD_NAMES = ['SHEETNUMBER', 'SHEETTITLE', 'SHEETDESC', 'SHEETSETNAME', 'SHEETCOUNT', 'SHEETINDEX', 'PROJECTNAME', 'PROJECTNUMBER'];
const ALIASES = {
  SHEETNUMBER: ['SHEET_NO', 'SHEETNO', 'SHEET_NUMBER', 'DWG_NO', 'DWGNO', 'DRAWING_NO', 'SHEET'],
  SHEETTITLE: ['SHEET_TITLE', 'DWG_TITLE', 'DRAWING_TITLE', 'TITLE'],
  SHEETDESC: ['SHEET_DESC', 'DESCRIPTION'],
  SHEETSETNAME: ['SHEET_SET', 'SET_NAME', 'SETNAME'],
  PROJECTNAME: ['PROJECT', 'PROJECT_NAME', 'PROJ_NAME', 'JOB_NAME'],
  PROJECTNUMBER: ['PROJECT_NO', 'PROJECTNO', 'PROJECT_NUMBER', 'JOB_NO', 'JOBNO'],
  SHEETCOUNT: ['SHEETS', 'SHEET_COUNT', 'TOTAL_SHEETS'],
  SHEETINDEX: ['SHEET_OF', 'SHEET_INDEX'],
};
const ALIAS_OF = new Map(Object.entries(ALIASES).flatMap(([f, list]) => [[f, f], ...list.map((a) => [a, f])]));
/** The field an attribute tag stands for ('SHEET_NO' → 'SHEETNUMBER'); a set or sheet property name stands for itself. */
export const fieldTag = (tag) => { const k = String(tag || '').toUpperCase().replace(/[\s-]+/g, '_'); return ALIAS_OF.get(k) || k; };

/** Every field's value for one sheet: the built-in ones, then the set's properties, then the sheet's own (they win). */
export function fieldValues(set, s) {
  const list = allSheets(set);
  const i = list.findIndex((x) => x.sheet.id === s.id);
  return {
    SHEETSETNAME: set.name || '', PROJECTNAME: set.properties?.PROJECTNAME ?? set.name ?? '', PROJECTNUMBER: set.properties?.PROJECTNUMBER ?? '',
    ...(set.properties || {}),
    SHEETNUMBER: s.number || '', SHEETTITLE: s.title || '', SHEETDESC: s.description || '',
    SHEETCOUNT: String(list.length), SHEETINDEX: i >= 0 ? t('sheetset.field.index', { i: i + 1, n: list.length }) : '',
    ...(s.properties || {}),
  };
}

/**
 * Fill a sheet's title blocks: every block reference on the layout `layoutName` whose attributes have a field's tag (or
 * an alias) gets the field's value. One undo step; returns how many attribute values changed.
 */
export function fillTitleBlocks(doc, layoutName, values) {
  const lay = doc.layouts.find((l) => l.name === layoutName);
  if (!lay) return 0;
  const todo = [];
  for (const e of lay.entities.values()) {
    if (e.type !== 'insert') continue;
    const blk = doc.blocks.get(e.block);
    if (!blk?.attdefs?.length) continue;
    const attrs = { ...(e.attrs || {}) };
    let n = 0;
    for (const d of blk.attdefs) {
      if (d.constant) continue;
      const f = fieldTag(d.tag);
      if (!(f in values)) continue;
      const v = String(values[f] ?? '');
      if ((attrs[d.tag] ?? d.def ?? '') !== v) { attrs[d.tag] = v; n++; }
    }
    if (n) todo.push({ e, attrs, n });
  }
  if (!todo.length) return 0;
  doc.change(t('sheetset.undo.fields'), () => { for (const { e, attrs } of todo) doc.update(e.id, { ...e, attrs }, lay.entities); });
  return todo.reduce((s, x) => s + x.n, 0);
}

// ---------------------------------------------------------------------------- the sheet list table (Z.6)

/** The block a sheet list lives in: placed once on a cover sheet, redefined whenever the set changes (refreshSheetList). */
export const SHEET_LIST_BLOCK = 'CC_SHEETLIST';

/**
 * The table's objects, in block coordinates (top-left corner at 0,0; rows go down): a heading row, then each subset's name
 * as a row of its own and its sheets (number, title), in set order. Sizes in the sheet's paper units (mm unless `inch`).
 */
export function sheetListEntities(set, { inch = false, height = null } = {}) {
  const k = inch ? 1 / 25.4 : 1;
  const h = height > 0 ? height : 3.5 * k, rowH = h * 2, w1 = 30 * k, w2 = 110 * k, W = w1 + w2, pad = h * 0.6;
  const rows = [{ kind: 'head', a: t('sheetset.list.number'), b: t('sheetset.list.title') }];
  const walk = (sheets, subsets, depth) => {
    for (const s of sheets) rows.push({ kind: 'sheet', a: s.number || '', b: s.title || s.layout });
    for (const g of subsets) { rows.push({ kind: 'subset', a: '', b: g.name, depth }); walk(g.sheets, g.subsets, depth + 1); }
  };
  walk(set.sheets, set.subsets, 0);
  const out = [];
  const L = (x1, y1, x2, y2) => out.push({ type: 'line', layer: '0', color: 0, x1, y1, x2, y2 });
  const T = (x, y, s, hh = h) => out.push({ type: 'text', layer: '0', color: 0, x, y, h: hh, rot: 0, s, ha: 'left', va: 'baseline' });
  T(0, rowH * 0.6, set.name || '', h * 1.4);   // the set's name over the table
  rows.forEach((r, i) => {
    const y = -i * rowH, base = y - rowH + pad;
    L(0, y, W, y);
    if (r.kind === 'subset') T(pad + (r.depth || 0) * h, base, r.b, h * 1.1);
    else { if (r.a) T(pad, base, r.a); T(w1 + pad, base, r.b); }
  });
  const bottom = -rows.length * rowH;
  L(0, bottom, W, bottom);
  L(0, 0, 0, bottom); L(W, 0, W, bottom);
  // the column line, through every row but a subset's
  rows.forEach((r, i) => { if (r.kind !== 'subset') L(w1, -i * rowH, w1, -(i + 1) * rowH); });
  return out;
}

/** Place the sheet list on a sheet (top-left of its paper, inside a margin) when it is not there yet, or redefine it. One undo step. */
export function placeSheetList(doc, layoutName, set, { at = null } = {}) {
  const lay = doc.layouts.find((l) => l.name === layoutName);
  if (!lay) return false;
  const inch = lay.paper.unit === 'in', m = inch ? 0.75 : 20;
  const has = [...lay.entities.values()].some((e) => e.type === 'insert' && e.block === SHEET_LIST_BLOCK);
  doc.change(t('sheetset.undo.list'), () => {
    doc.defineBlock({ name: SHEET_LIST_BLOCK, base: { x: 0, y: 0 }, entities: sheetListEntities(set, { inch }) });
    if (!has) {
      const p = at || { x: lay.paper.x0 + m, y: lay.paper.y0 + lay.paper.h - m * 2 };
      doc.add({ type: 'insert', layer: '0', color: null, block: SHEET_LIST_BLOCK, x: p.x, y: p.y, sx: 1, sy: 1, rot: 0 }, lay.entities);
    }
  });
  return true;
}

/** A drawing that holds the sheet list: its block redefined from the set (Update drawings). → true when it changed. */
export function refreshSheetList(doc, set) {
  const b = doc.blocks.get(SHEET_LIST_BLOCK);
  if (!b) return false;
  const uses = doc.layouts.find((l) => [...l.entities.values()].some((e) => e.type === 'insert' && e.block === SHEET_LIST_BLOCK));
  const ents = sheetListEntities(set, { inch: uses?.paper.unit === 'in' });
  const sig = (list) => list.filter((e) => e.type === 'text').map((e) => e.s).join('\n') + '|' + list.filter((e) => e.type === 'line').length;   // what it says, row by row
  const same = sig(ents) === sig(b.entities);
  if (same) return false;
  doc.change(t('sheetset.undo.list'), () => doc.defineBlock({ name: SHEET_LIST_BLOCK, base: { x: 0, y: 0 }, entities: ents }));
  return true;
}
