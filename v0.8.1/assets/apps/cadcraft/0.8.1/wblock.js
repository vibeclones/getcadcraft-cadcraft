/* SPDX-License-Identifier: Apache-2.0 */
/**
 * wblock.js — WBLOCK: a block, some objects or the whole drawing as a drawing of its own (0.7 D7.13).
 * No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 *   const r = wblockDoc(doc, { ids: Set | block: 'Name' | whole: true, base: {x, y} })
 *     → { doc: Doc, count, blocks, layers } | { error: 'none' | 'noblock' | 'empty' }
 *
 * The new drawing holds only what the objects use: their layers, the blocks they insert (nested ones too), the
 * linetypes, text styles and dimension styles they name. The base point becomes the new drawing's origin (a block
 * written out uses its own base). Units and the drawing's name carry over. The caller writes it with saveDwg /
 * writeDxf, so the file is a normal drawing in any version.
 */
import { Doc } from './doc.js';
import { makeClip } from './clipboard.js';
import { txEntity, mTranslate } from './geom.js';

/** Names a set of entities refer to, by field, into `into` (a Set). */
function names(list, into) {
  for (const e of list) {
    if (typeof e.style === 'string' && e.style) into.text.add(e.style);
    if (typeof e.dimstyle === 'string' && e.dimstyle) into.dim.add(e.dimstyle);
    if (typeof e.lt === 'string' && e.lt) into.lt.add(e.lt);
  }
}

export function wblockDoc(doc, { ids = null, block = null, whole = false, base = { x: 0, y: 0 } } = {}) {
  let list, b = base;
  if (block) {
    const def = doc.blocks.get(block);
    if (!def) return { error: 'noblock' };
    // the block's objects, as a temporary drawing's model, so makeClip finds their blocks and layers
    const tmp = new Doc();
    for (const [n, l] of doc.layers) tmp.addLayer(l);
    for (const [n, d] of doc.blocks) if (n !== block) tmp.blocks.set(n, d);
    tmp.load({ entities: def.entities.map((e) => ({ ...e })), layers: [...doc.layers.values()], blocks: [...doc.blocks.values()].filter((x) => x.name !== block), meta: { units: doc.meta.units } });
    for (const d of def.attdefs || []) {   // attribute definitions come back as the attribute-definition texts they were made from
      tmp.model.set(tmp.nextId, { id: tmp.nextId++, type: 'text', layer: d.layer ?? '0', color: d.color ?? null, x: d.x, y: d.y, h: d.h > 0 ? d.h : 2.5, rot: d.rot || 0, ha: d.ha || 'left', va: d.va || 'baseline', wf: d.wf || 1, s: d.tag,
        attdef: { tag: d.tag, prompt: d.prompt ?? '', def: d.def ?? '', invisible: !!d.invisible, constant: !!d.constant, preset: !!d.preset } });
    }
    const r = wblockDoc(tmp, { whole: true, base: def.base || { x: 0, y: 0 } });
    if (r.doc) { r.doc.meta.name = block; r.doc.meta.units = doc.meta.units || ''; copyStyles(doc, r.doc); }
    return r;
  }
  if (whole) ids = new Set(doc.model.keys());
  const src = doc.inModel || whole ? doc : doc;
  const prev = doc.space;
  if (whole) doc.space = doc.model;
  let clip;
  try { clip = makeClip(src, ids || new Set(), {}); } finally { doc.space = prev; }
  if (!clip) return { error: ids?.size ? 'empty' : 'none' };
  const m = mTranslate(-b.x, -b.y);
  const tx = (e) => (b.x || b.y ? txEntity(e, m) : e);
  const out = new Doc();
  const used = { text: new Set(), dim: new Set(), lt: new Set() };
  const entities = clip.entities.map((e) => tx(e));
  names(entities, used);
  for (const bl of clip.blocks) names(bl.entities, used);
  for (const l of clip.layers) if (doc.layers.get(l.name)?.linetype) used.lt.add(doc.layers.get(l.name).linetype);
  out.load({
    entities, layers: clip.layers.map((l) => ({ ...doc.layers.get(l.name), ...l })), blocks: clip.blocks,
    meta: { name: doc.meta.name || 'Drawing1', units: doc.meta.units || '' },
    linetypes: [...doc.linetypes.values()].filter((l) => used.lt.has(l.name)),
    textStyles: [...doc.textStyles].filter(([n]) => used.text.has(n)),
    dimStyles: [...doc.dimStyles].filter(([n]) => used.dim.has(n)),
  });
  out.current.dim = { ...doc.current.dim };
  return { doc: out, count: entities.length, blocks: clip.blocks.length, layers: clip.layers.length };
}

function copyStyles(from, to) {
  const used = { text: new Set(), dim: new Set(), lt: new Set() };
  names([...to.model.values()], used);
  for (const b of to.blocks.values()) names(b.entities, used);
  for (const l of to.layers.values()) used.lt.add(l.linetype);
  to.linetypes = new Map([...from.linetypes].filter(([n]) => used.lt.has(n)));
  to.textStyles = new Map([...from.textStyles].filter(([n]) => used.text.has(n)));
  to.dimStyles = new Map([...from.dimStyles].filter(([n]) => used.dim.has(n)));
}
