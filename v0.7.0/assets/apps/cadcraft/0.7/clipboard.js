/* SPDX-License-Identifier: Apache-2.0 */
/**
 * clipboard.js — CadCraft's own clipboard (COPYCLIP, CUTCLIP, COPYBASE, PASTECLIP, PASTEORIG).
 * No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 *   const clip = makeClip(doc, ids, { base })   the objects (no ids), the blocks they need (nested ones too) and
 *                                               their layers' settings → a plain object, or null (nothing to copy)
 *   const board = new Clipboard(storage)        memory + `storage` (localStorage, or anything with getItem/setItem;
 *                                               null = memory only) under the key "cadcraft.clipboard"
 *   board.put(clip) → { shared }                shared false: too big for the browser's storage, this tab only
 *   board.get() → { clip } | { error } | {}     the newest of this tab's and the shared one; what comes back from
 *                                               storage is untrusted (another tab, or anyone with the console) and
 *                                               goes through readClip() like a file
 *   readClip(value) → { clip } | { error }      validate: format, sizes, entity types and fields, finite numbers,
 *                                               block names and references (no loops), layers, colours
 *   basePoint(clip, 'lower-left' | 'center')    the point the copy hangs from: the COPYBASE point when one was picked,
 *                                               else the lower-left corner (AutoCAD's PASTECLIP) or the center of its
 *                                               extents
 *   pastePreview(clip)                          what to draw while it follows the cursor (blocks drawn from the
 *                                               copy's own definitions, as lines and arcs)
 *   doc.change('PASTECLIP', () => pasteClip(doc, clip, dx, dy))
 *     → { ids, renamed: Map, layers: [added], note }
 *     Blocks: one this drawing already has under the same name keeps this drawing's definition (as AutoCAD does);
 *     anonymous ones (*D…, *U…) always get a free name. Layers the copy uses are added with the settings they had.
 *     Moving a copied dimension drops its imported geometry (CadCraft draws it again), as MOVE does.
 */

import { txEntity, mTranslate, entityBounds, validBounds, emptyBounds, growPt, prims, normAngle, TAU } from './geom.js';
import { planCopy, applyCopy } from './blockcopy.js';
import { t } from './i18n.js';
import { clipConstraints, readClipConstraints, pasteConstraints } from './gcons.js';

export const CLIP_KEY = 'cadcraft.clipboard';
export const CLIP_FORMAT = 'cadcraft-clipboard';
export const CLIP_VERSION = 1;

/** Limits for what comes back from storage. */
export const CLIP_LIMITS = Object.freeze({
  chars: 20e6,          // JSON text
  entities: 200000,     // top level + inside blocks
  blocks: 20000,
  layers: 10000,
  nodes: 4e6,           // every value, counted while validating
  coord: 1e12,          // |number|
  text: 65536,          // one string
  depth: 6,             // nesting inside an entity
});

const TYPES = new Set(['line', 'circle', 'arc', 'poly', 'ellipse', 'text', 'point', 'insert', 'hatch', 'dim', 'mleader', 'xline', 'ray', 'spline']);
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const BAD_KEYS = new Set(['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const NAME_RE = /^[^<>/\\":;?*|=`\u0000-\u001f]{1,255}$/;   // a block name, after an anonymous block's leading "*"

/** Blocks the entities use directly (inserts and dimensions drawn from a block). */
function refsOf(list) {
  const out = new Set();
  for (const e of list || []) if ((e.type === 'insert' || e.type === 'dim') && typeof e.block === 'string' && e.block) out.add(e.block);
  return out;
}
/** A plain copy without the id and the readers' private fields (`_attribs`). */
function plain(e) {
  const c = JSON.parse(JSON.stringify(e));
  delete c.id;
  delete c.field;   // a view label's link names a viewport by id (WL.11): a copy is plain text
  for (const k of Object.keys(c)) if (k.startsWith('_')) delete c[k];
  return c;
}
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/**
 * The clipboard contents for these objects. Viewports stay on their sheet (counted in `skipped`).
 * `base` = a picked base point (COPYBASE); without one, PASTECLIP uses the copy's extents.
 */
export function makeClip(doc, ids, { base = null } = {}) {
  const ents = [], entIds = [];
  let skipped = 0;
  for (const id of ids) {
    const e = doc.get(id);
    if (!e) continue;
    if (e.type === 'viewport') { skipped++; continue; }
    ents.push(plain(e)); entIds.push(id);
  }
  if (!ents.length) return null;
  // every block reachable from them, nested ones first
  const blocks = [], seen = new Set();
  const visit = (name, depth) => {
    if (seen.has(name) || depth > 32) return;
    seen.add(name);
    const b = doc.blocks.get(name);
    if (!b) return;
    for (const r of refsOf(b.entities)) visit(r, depth + 1);
    const out = { name: b.name, base: { x: b.base?.x || 0, y: b.base?.y || 0 }, entities: b.entities.map(plain) };
    if (b.attdefs?.length) out.attdefs = b.attdefs.map((d) => JSON.parse(JSON.stringify(d)));
    blocks.push(out);
  };
  for (const r of refsOf(ents)) visit(r, 0);
  // drop references to blocks the drawing does not have (a reader may leave one): they draw nothing anyway
  const have = new Set(blocks.map((b) => b.name));
  const keep = (e) => !((e.type === 'insert') && !have.has(e.block));
  const clean = (e) => { if (e.type === 'dim' && e.block && !have.has(e.block)) { const c = { ...e }; delete c.block; return c; } return e; };
  const top = ents.filter(keep).map(clean);
  for (const b of blocks) b.entities = b.entities.filter(keep).map(clean);
  if (!top.length) return null;
  const used = new Set(['0']);
  for (const e of top) used.add(e.layer || '0');
  for (const b of blocks) { for (const e of b.entities) used.add(e.layer || '0'); for (const d of b.attdefs || []) used.add(d.layer || '0'); }
  const layers = [...used].map((n) => doc.layers.get(n)).filter(Boolean).map((l) => ({ name: l.name, color: l.color, on: l.on, frozen: l.frozen, locked: l.locked, plot: l.plot }));
  const clip = {
    format: CLIP_FORMAT, version: CLIP_VERSION, id: randomId(), time: Date.now(),
    units: doc.meta?.units || '', space: doc.inModel ? 'model' : 'paper', from: doc.meta?.name || '',
    entities: top, blocks, layers,
  };
  if (base) clip.base = { x: base.x, y: base.y };
  if (skipped) clip.skipped = skipped;
  // constraints whose objects are all in the copy (gcons.js; refs by index into `entities`)
  const topIds = entIds.filter((_, i) => keep(ents[i]));
  const cons = clipConstraints(doc, new Map(topIds.map((id, i) => [id, i])));
  if (cons.length) clip.constraints = cons;
  return clip;
}

// ---------------------------------------------------------------------------
// Validation (what comes back from storage is untrusted)

class Bad extends Error {}
const fail = (m) => { throw new Bad(m); };

function checker() {
  let nodes = 0;
  const num = (v, what) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > CLIP_LIMITS.coord) fail(t('clip.bad.number', { what }));
    return v;
  };
  const pt = (v, what) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(t('clip.bad.point', { what }));
    return { x: num(v.x, what), y: num(v.y, what) };
  };
  /** Any other field: numbers, strings, booleans, null, and small nested objects/arrays of those. */
  const value = (v, depth, what) => {
    if (++nodes > CLIP_LIMITS.nodes) fail(t('clip.clipboard_holds_too_much'));
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return num(v, what);
    if (typeof v === 'string') { if (v.length > CLIP_LIMITS.text) fail(t('clip.bad.long', { what })); return v; }
    if (depth > CLIP_LIMITS.depth) fail(t('clip.bad.deep', { what }));
    if (Array.isArray(v)) return v.map((x) => value(x, depth + 1, what));
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) fail(t('clip.bad.plain', { what }));
      const out = {};
      for (const k of Object.keys(v)) {
        if (!KEY_RE.test(k) || BAD_KEYS.has(k)) fail(t('clip.bad.field', { what, field: String(k).slice(0, 40) }));
        out[k] = value(v[k], depth + 1, what + '.' + k);
      }
      return out;
    }
    fail(t('clip.bad.value', { what }));
  };
  const color = (c) => {
    if (c === null || c === undefined) return null;
    if (Number.isInteger(c) && c >= 0 && c <= 256) return c;
    if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return c;
    fail(t('clip.colour_not_one_cadcraft'));
  };
  const layerName = (n) => {
    if (n === undefined || n === null || n === '') return '0';
    if (typeof n !== 'string' || n.length > 255 || /[\u0000-\u001f]/.test(n)) fail(t('clip.layer_name_not_usable'));
    return n;
  };
  /** Attribute values / places keyed by tag (any text a drawing uses, e.g. "SYM."), never "__proto__". */
  const tagged = (v, what) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) fail(t('clip.bad.attrs', { what }));
    const out = {};
    for (const k of Object.keys(v)) {
      if (!k || k.length > 255 || k === '__proto__' || /[\u0000-\u001f]/.test(k)) fail(t('clip.bad.tag', { what }));
      Object.defineProperty(out, k, { value: value(v[k], 2, what), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  /** One entity → a clean copy (fields re-read one by one), or an error. */
  const entity = (e, blockNames, where) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail(t('clip.bad.object', { where }));
    if (!TYPES.has(e.type)) fail(t('clip.bad.type', { where, type: String(e.type).slice(0, 20) }));
    const what = t('clip.where.in', { type: e.type, where });
    const out = {};
    for (const k of Object.keys(e)) {
      if (k === 'id' || k === 'type' || k === 'layer' || k === 'color') continue;
      if (!KEY_RE.test(k) || BAD_KEYS.has(k)) fail(t('clip.bad.field.entity', { what, field: String(k).slice(0, 40) }));
      out[k] = k === 'attrs' || k === 'attloc' ? tagged(e[k], what + ' ' + k) : value(e[k], 1, what + ' ' + k);
    }
    out.type = e.type;
    out.layer = layerName(e.layer);
    out.color = color(e.color);
    const need = (...keys) => { for (const k of keys) num(out[k], what + ' ' + k); };
    switch (e.type) {
      case 'line': need('x1', 'y1', 'x2', 'y2'); break;
      case 'circle': need('cx', 'cy', 'r'); if (!(out.r > 0)) fail(t('clip.circle_has_no_radius')); break;
      case 'arc': need('cx', 'cy', 'r', 'a0', 'a1'); if (!(out.r > 0)) fail(t('clip.arc_has_no_radius')); break;
      case 'point': need('x', 'y'); break;
      case 'xline': case 'ray': {   // construction lines (0.5 DR.6): a point and a direction, made a unit one here
        need('x', 'y', 'dx', 'dy');
        const L = Math.hypot(out.dx, out.dy);
        if (!(L > 1e-12)) fail(t('clip.bad.direction', { what }));
        out.dx /= L; out.dy /= L;
        break;
      }
      case 'ellipse': need('cx', 'cy', 'mx', 'my', 'ratio', 't0', 't1'); break;
      case 'text':
        need('x', 'y', 'h');
        if (typeof out.s !== 'string') fail(t('clip.text_has_no_text'));
        if (out.rot !== undefined) num(out.rot, what + ' rot');
        break;
      case 'poly':
        if (!Array.isArray(out.pts) || out.pts.length < 2) fail(t('clip.polyline_has_fewer_than'));
        out.pts = out.pts.map((p) => ({ ...pt(p, what + ' point'), b: p.b === undefined || p.b === null ? 0 : num(p.b, what + ' bulge') }));
        out.closed = !!out.closed;
        break;
      case 'mleader':
        if (!Array.isArray(out.pts) || out.pts.length < 2) fail(t('clip.mld.pts'));
        out.pts = out.pts.map((p) => pt(p, what + ' point'));
        out.dir = out.dir === -1 ? -1 : 1;
        if (out.s !== undefined && typeof out.s !== 'string') fail(t('clip.mld.text'));
        break;
      case 'hatch':
        if (!Array.isArray(out.loops) || !out.loops.length) fail(t('clip.hatch_has_no_boundary'));
        for (const l of out.loops) { if (!Array.isArray(l) || l.length < 6 || l.length % 2) fail(t('clip.hatch_boundary_not_list')); for (const v of l) num(v, what + ' boundary'); }
        break;
      case 'insert':
        need('x', 'y');
        for (const k of ['sx', 'sy', 'rot']) if (out[k] !== undefined) num(out[k], what + ' ' + k);
        if (typeof out.block !== 'string' || !blockNames.has(out.block)) fail(t('clip.block_reference_names_block'));
        if (out.attrs !== undefined) {
          if (!out.attrs || typeof out.attrs !== 'object' || Array.isArray(out.attrs)) fail(t('clip.block_attributes_not_list'));
          for (const v of Object.values(out.attrs)) if (typeof v !== 'string') fail(t('clip.block_attribute_value_not'));
        }
        break;
      case 'dim':
        if (out.block !== undefined && (typeof out.block !== 'string' || !blockNames.has(out.block))) fail(t('clip.dimension_names_block_clipboard'));
        for (const k of ['p1', 'p2', 'c', 'loc']) if (out[k] !== undefined) out[k] = pt(out[k], what + ' ' + k);
        if (!out.block && !['linear', 'aligned', 'angular', 'radius', 'diameter'].includes(out.kind)) fail(t('clip.dimension_has_no_kind'));
        if (out.kind && !(out.p1 && out.loc)) fail(t('clip.dimension_missing_points'));
        break;
      default: break;
    }
    return out;
  };
  return { num, pt, value, color, layerName, entity };
}

/** Validate clipboard contents (a JSON string or an object). → { clip } | { error } */
export function readClip(input) {
  try {
    let v = input;
    if (typeof v === 'string') {
      if (v.length > CLIP_LIMITS.chars) fail(t('clip.clipboard_holds_too_much'));
      try { v = JSON.parse(v); } catch { fail(t('clip.clipboard_not_readable')); }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(t('clip.clipboard_not_readable'));
    if (v.format !== CLIP_FORMAT) fail(t('clip.clipboard_does_not_hold'));
    if (v.version !== CLIP_VERSION) fail(t('clip.clipboard_was_written_another'));
    const C = checker();
    if (!Array.isArray(v.entities) || !v.entities.length) fail(t('clip.clipboard_holds_no_objects'));
    const blocksIn = v.blocks === undefined ? [] : v.blocks;
    const layersIn = v.layers === undefined ? [] : v.layers;
    if (!Array.isArray(blocksIn) || blocksIn.length > CLIP_LIMITS.blocks) fail(t('clip.clipboard_s_blocks_not'));
    if (!Array.isArray(layersIn) || layersIn.length > CLIP_LIMITS.layers) fail(t('clip.clipboard_s_layers_not'));
    let count = v.entities.length;
    for (const b of blocksIn) count += Array.isArray(b?.entities) ? b.entities.length : 0;
    if (count > CLIP_LIMITS.entities) fail(t('clip.clipboard_holds_too_many'));
    // block names first, so references can be checked
    const names = new Set();
    for (const b of blocksIn) {
      if (!b || typeof b !== 'object' || typeof b.name !== 'string' || !NAME_RE.test(b.name.startsWith('*') ? b.name.slice(1) : b.name)) fail(t('clip.block_name_clipboard_not'));
      if (names.has(b.name)) fail(t('clip.bad.twoblocks', { name: b.name }));
      if (!Array.isArray(b.entities)) fail(t('clip.bad.block.empty', { name: b.name }));
      names.add(b.name);
    }
    const blocks = blocksIn.map((b) => {
      const out = { name: b.name, base: b.base === undefined ? { x: 0, y: 0 } : C.pt(b.base, t('clip.where.block.base', { name: b.name })), entities: b.entities.map((e) => C.entity(e, names, t('clip.where.block', { name: b.name }))) };
      if (b.attdefs !== undefined) {
        if (!Array.isArray(b.attdefs) || b.attdefs.length > 1000) fail(t('clip.bad.block.attrs', { name: b.name }));
        out.attdefs = b.attdefs.map((d) => {
          const c = C.value(d, 1, t('clip.where.attr', { name: b.name }));
          if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.tag !== 'string' || !c.tag || c.tag.length > 255) fail(t('clip.bad.attr.tag', { name: b.name }));
          for (const k of ['x', 'y', 'h']) C.num(c[k], t('clip.where.attr', { name: b.name }));
          c.layer = C.layerName(c.layer);
          c.color = C.color(c.color);
          return c;
        });
      }
      return out;
    });
    // no block may contain itself, however deep
    const byName = new Map(blocks.map((b) => [b.name, b]));
    const state = new Map();
    const loop = (name) => {
      if (state.get(name) === 2) return false;
      if (state.get(name) === 1) return true;
      state.set(name, 1);
      for (const r of refsOf(byName.get(name)?.entities)) if (loop(r)) return true;
      state.set(name, 2);
      return false;
    };
    for (const b of blocks) if (loop(b.name)) fail(t('clip.block_clipboard_contains_itself'));
    const entities = v.entities.map((e) => C.entity(e, names, t('clip.the_clipboard')));
    const layers = [];
    const seenL = new Set();
    for (const l of layersIn) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) fail(t('clip.layer_clipboard_not_readable'));
      const name = C.layerName(l.name);
      if (seenL.has(name)) continue;
      seenL.add(name);
      layers.push({ name, color: C.color(l.color) ?? 7, on: l.on !== false, frozen: l.frozen === true, locked: l.locked === true, plot: l.plot !== false });
    }
    const clip = {
      format: CLIP_FORMAT, version: CLIP_VERSION,
      id: typeof v.id === 'string' ? v.id.slice(0, 64) : '', time: Number.isFinite(v.time) ? v.time : 0,
      units: typeof v.units === 'string' ? v.units.slice(0, 40) : '', space: v.space === 'paper' ? 'paper' : 'model',
      from: typeof v.from === 'string' ? v.from.slice(0, 255) : '',
      entities, blocks, layers,
    };
    if (v.base !== undefined) clip.base = C.pt(v.base, t('clip.base_point'));
    if (Number.isInteger(v.skipped) && v.skipped > 0) clip.skipped = v.skipped;
    if (v.constraints !== undefined) {
      let cons;
      try { cons = readClipConstraints(v.constraints, entities.length); } catch { fail(t('clip.constraints_clipboard_not_readable')); }
      if (cons.length) clip.constraints = cons;
    }
    return { clip };
  } catch (err) {
    if (err instanceof Bad) return { error: err.message };
    return { error: t('clip.clipboard_not_readable') };
  }
}

// ---------------------------------------------------------------------------
// The clipboard: this tab's copy + the browser's storage (so another tab can paste)

export class Clipboard {
  constructor(storage = null) { this.storage = storage; this.mem = null; }
  /** Keep a copy. → { shared }: false when the browser would not store it (too big, private window). */
  put(clip) {
    this.mem = clip;
    if (!this.storage) return { shared: false };
    try { this.storage.setItem(CLIP_KEY, JSON.stringify(clip)); return { shared: true }; }
    catch { try { this.storage.removeItem?.(CLIP_KEY); } catch { /* nothing to do */ } return { shared: false }; }
  }
  /** The newest copy: this tab's, or one another tab put in storage since. → { clip } | { error } | {} */
  get() {
    let raw = null;
    if (this.storage) { try { raw = this.storage.getItem(CLIP_KEY); } catch { raw = null; } }
    if (raw) {
      // always read through readClip, even when it looks like this tab's own: anyone can change storage
      const r = readClip(raw);
      if (r.clip && (!this.mem || r.clip.id === this.mem.id || r.clip.time >= this.mem.time)) return r;
      if (r.error && !this.mem) return r;
      if (r.error) return { clip: this.mem, warning: r.error };
    }
    return this.mem ? { clip: this.mem } : {};
  }
}

// ---------------------------------------------------------------------------
// Pasting

/** Extents of the copy (inserts measured with the copy's own block definitions). */
export function clipExtents(clip) {
  const blocks = new Map(clip.blocks.map((b) => [b.name, b]));
  const b = emptyBounds();
  for (const e of clip.entities) {
    const eb = entityBounds(e, blocks);
    if (validBounds(eb)) { growPt(b, eb.minX, eb.minY); growPt(b, eb.maxX, eb.maxY); }
    else if (Number.isFinite(e.x) && Number.isFinite(e.y)) growPt(b, e.x, e.y);
  }
  return validBounds(b) ? b : null;
}

/** The point the copy hangs from while it follows the cursor. */
export function basePoint(clip, mode = 'lower-left') {
  if (clip.base) return { x: clip.base.x, y: clip.base.y };
  const b = clipExtents(clip);
  if (!b) return { x: 0, y: 0 };
  return mode === 'center' ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: b.minX, y: b.minY };
}

/**
 * What to draw while pasting, at the copy's own place (translate it to the cursor). Block references and
 * block-drawn dimensions become the lines and arcs of the copy's own definitions, so the preview is right even
 * before the blocks exist here. Capped: past `max` pieces the rest shows as its extents.
 */
export function pastePreview(clip, max = 20000) {
  const blocks = new Map(clip.blocks.map((b) => [b.name, b]));
  const out = [];
  let n = 0;
  for (const e of clip.entities) {
    if (n > max) break;
    if (e.type === 'insert' || (e.type === 'dim' && e.block)) {
      for (const p of prims(e, blocks)) {
        if (++n > max) break;
        if (p.k === 'L') out.push({ type: 'line', x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 });
        else if (p.full || p.a1 - p.a0 >= TAU - 1e-9) out.push({ type: 'circle', cx: p.cx, cy: p.cy, r: p.r });
        else out.push({ type: 'arc', cx: p.cx, cy: p.cy, r: p.r, a0: normAngle(p.a0), a1: normAngle(p.a1) });
      }
    } else { out.push(e); n++; }
  }
  if (n > max) {
    const b = clipExtents(clip);
    if (b) out.push({ type: 'poly', closed: true, pts: [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }] });
  }
  return out;
}

/** Add the copy to doc's open space, moved by dx, dy (inside doc.change). */
export function pasteClip(doc, clip, dx = 0, dy = 0) {
  const src = { entities: clip.entities, blocks: clip.blocks, layers: clip.layers, meta: { units: clip.units } };
  const plan = planCopy(doc, src, { refs: true });
  const r = applyCopy(doc, src, plan, 'keep');
  // layers the top-level objects use (applyCopy adds the ones inside blocks)
  const srcLayers = new Map(clip.layers.map((l) => [l.name, l]));
  const added = [...r.layers];
  for (const e of clip.entities) {
    const name = e.layer || '0';
    if (!doc.layers.has(name)) { doc.addLayer(srcLayers.get(name) || { name }); added.push(name); }
  }
  const m = mTranslate(dx, dy);
  const moved = Math.abs(dx) > 0 || Math.abs(dy) > 0;
  const ids = [];
  for (const e0 of clip.entities) {
    const e = e0.block && r.renamed.has(e0.block) ? { ...e0, block: r.renamed.get(e0.block) } : { ...e0 };
    const t = moved ? txEntity(e, m) : JSON.parse(JSON.stringify(e));
    delete t.id;
    ids.push(doc.add(t).id);
  }
  const a = clip.units, b = doc.meta?.units || '';
  const note = a && b && a !== b ? t('clip.units_differ', { from: a, to: b }) : '';
  // constraints among the copied objects come along (model space; dimensional ones get new names)
  const constraints = clip.constraints?.length ? pasteConstraints(doc, clip.constraints, ids, moved ? dx : 0, moved ? dy : 0) : 0;
  return { ids, renamed: r.renamed, layers: added, note, constraints };
}
