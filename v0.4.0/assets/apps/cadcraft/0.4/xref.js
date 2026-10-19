/* SPDX-License-Identifier: Apache-2.0 */
/**
 * xref.js — linked drawings (external references; 0.4 C35; owner: cad-files). DOM-free: layertools.js installs XREF and
 * XATTACH, the file readers keep links they cannot load, and bin/test-cadcraft.mjs drives it.
 *
 * A linked drawing is a block whose definition carries `xref`: the root `{ path (the file), loaded }` holds the other
 * drawing's model space; its own blocks come along as parts `{ of: root }`. Their names and their layers get the link's
 * name in front, as AutoCAD names them: "Plan|Walls", "Plan|Door". Nothing in a link is edited here (read-only): change
 * the other drawing and reload. A link a file names but CadCraft could not load (an opened DWG/DXF) is a root with no
 * objects and `loaded: false`; saving keeps it as a link. A loaded link is bound when the drawing is saved (a DWG writes
 * "Plan$0$Walls", as AutoCAD's Bind) — the save says so.
 *
 * All of these run inside one doc.change (the commands make each one undo step):
 *   attachXref(doc, src, fileName, { name })  src = the other drawing as doc.load() takes it (readDxf / importDwg) →
 *                                             { name, scale, note, layers, blocks }; `name` reloads into that link
 *   detachXref(doc, name, { keepRefs })       the link, its parts, its references (unless keepRefs) and its unused layers
 *   bindXref(doc, name)                       a link becomes ordinary blocks and layers ("Plan$0$Walls")
 *   xrefs(doc)                                → [{ name, path, loaded, refs, objects }]
 */
import { blockNameFromFile, mmPerUnit } from './blockcopy.js';
import { t } from './i18n.js';

export const isXrefRoot = (b) => !!(b && b.xref && b.xref.of === undefined);
const partsOf = (doc, name) => [...doc.blocks.values()].filter((b) => b.xref?.of === name);

export function xrefs(doc) {
  const out = [];
  for (const b of doc.blocks.values()) {
    if (!isXrefRoot(b)) continue;
    let refs = 0;
    for (const e of doc.everyEntity()) if (e.type === 'insert' && e.block === b.name) refs++;
    out.push({ name: b.name, path: b.xref.path || '', loaded: b.xref.loaded !== false && b.entities.length > 0, refs, objects: b.entities.length });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Bring the other drawing in as the link `name` (new: a free name from the file). Inside doc.change. */
export function attachXref(doc, src, fileName, { name = null } = {}) {
  let root = name;
  if (!root) {
    const base = blockNameFromFile(fileName) || 'Xref';
    root = base;
    for (let k = 2; doc.blocks.has(root) || [...doc.layers.keys()].some((l) => l.startsWith(root + '|')); k++) root = base + ' (' + k + ')';
  } else detachXref(doc, root, { keepRefs: true, keepRoot: true });
  const p = root + '|';
  const lay = (n) => (!n || n === '0' ? '0' : p + n);
  const bmap = new Map((src.blocks || []).map((b) => [b.name, p + b.name]));
  const mapE = (e) => {
    const c = { ...e, layer: lay(e.layer) };
    delete c.id;
    if (c.block && bmap.has(c.block)) c.block = bmap.get(c.block);
    return c;
  };
  // layers: the other drawing's, under the link's name (its layer 0 is this drawing's 0)
  const s = doc.layerState();
  let layers = 0;
  for (const l of src.layers || []) {
    if (!l.name || l.name === '0' || s.list.some((x) => x.name === p + l.name)) continue;
    s.list.push({ name: p + l.name, color: l.color ?? 7, on: l.on !== false, frozen: !!l.frozen, locked: !!l.locked, plot: l.plot !== false, linetype: l.linetype || 'Continuous', lineweight: Number.isFinite(l.lineweight) ? l.lineweight : -3 });
    layers++;
  }
  doc.setLayerState(s);
  let blocks = 0;
  for (const b of src.blocks || []) {
    doc.defineBlock({ name: bmap.get(b.name), base: b.base || { x: 0, y: 0 }, entities: (b.entities || []).map(mapE), ...(b.attdefs?.length ? { attdefs: b.attdefs.map((d) => ({ ...d, layer: lay(d.layer) })) } : {}), xref: { of: root } });
    blocks++;
  }
  doc.defineBlock({ name: root, base: src.meta?.insbase || { x: 0, y: 0 }, entities: (src.entities || []).map(mapE), xref: { path: fileName, loaded: true } });
  const a = mmPerUnit(src.meta?.units), b = mmPerUnit(doc.meta?.units);
  const scale = a && b ? a / b : 1;
  const note = a && b && a !== b ? t('xref.units', { a: src.meta.units, b: doc.meta.units, scale: Number(scale.toPrecision(6)) }) : '';
  return { name: root, scale, note, layers, blocks };
}

/** Take a link out. keepRoot: its definition stays (emptied) for a reload; keepRefs: its references stay. Inside doc.change. */
export function detachXref(doc, name, { keepRefs = false, keepRoot = false } = {}) {
  const root = doc.blocks.get(name);
  if (!isXrefRoot(root)) return false;
  const parts = partsOf(doc, name).map((b) => b.name);
  if (!keepRefs) for (const map of [doc.model, ...doc.layouts.map((l) => l.entities)]) for (const e of [...map.values()]) if (e.type === 'insert' && e.block === name) doc.remove(e.id, map);
  for (const n of parts) doc.removeBlock(n);
  if (keepRoot) doc.defineBlock({ ...root, entities: [], xref: { path: root.xref.path, loaded: false } });
  else doc.removeBlock(name);
  // its layers, when nothing else uses them
  const p = name + '|', used = new Set();
  for (const e of doc.everyEntity()) used.add(e.layer);
  for (const b of doc.blocks.values()) for (const e of b.entities) used.add(e.layer);
  const s = doc.layerState();
  s.list = s.list.filter((l) => !l.name.startsWith(p) || used.has(l.name));
  if (!s.list.some((l) => l.name === s.current)) s.current = '0';
  doc.setLayerState(s);
  return true;
}

/** A link becomes ordinary blocks and layers, named as AutoCAD binds them ("Plan$0$Walls"). Inside doc.change. */
export function bindXref(doc, name) {
  const root = doc.blocks.get(name);
  if (!isXrefRoot(root)) return false;
  const p = name + '|', q = name + '$0$';
  const bn = (n) => (n && n.startsWith(p) ? q + n.slice(p.length) : n);
  const fix = (e) => ({ ...e, layer: bn(e.layer), ...(e.block ? { block: bn(e.block) } : {}) });
  const parts = partsOf(doc, name);
  for (const b of parts) { doc.removeBlock(b.name); const { xref, ...plain } = b; void xref; doc.defineBlock({ ...plain, name: bn(b.name), entities: b.entities.map(fix), ...(b.attdefs ? { attdefs: b.attdefs.map((d) => ({ ...d, layer: bn(d.layer) })) } : {}) }); }
  { const { xref, ...plain } = root; void xref; doc.defineBlock({ ...plain, entities: root.entities.map(fix) }); }
  const s = doc.layerState();
  for (const l of s.list) if (l.name.startsWith(p)) l.name = bn(l.name);
  s.current = bn(s.current);
  doc.setLayerState(s);
  return true;
}
