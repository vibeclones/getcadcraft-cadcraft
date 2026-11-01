/* SPDX-License-Identifier: Apache-2.0 */
/**
 * blockcopy.js — bring block definitions from another drawing into this one (INSERT, option File).
 * No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 *   const src = readDxf(text) | importDwg(model)              the other drawing, as doc.load() takes it
 *   const plan = planCopy(doc, src, { block: 'Name' })        one of its blocks …
 *   const plan = planCopy(doc, src, { whole: 'File name' })   … or its whole model space as one block
 *   const plan = planCopy(doc, src, { refs: true })           … or just the blocks its entities use (PASTECLIP)
 *     → { root, needed: [names, nested first], clashes: [names already in this drawing], scale, note }
 *   doc.change('INSERT', () => applyCopy(doc, src, plan, 'keep' | 'rename'))
 *     → { name (the block to place), copied, renamed: Map old → new, layers }
 *
 * Nested blocks come along (inserts and dimensions that use them). Anonymous blocks (*D…, *U…)
 * never ask: they always get a name of their own here. A clash keeps this drawing's definition
 * ('keep') or brings the incoming one in under a new name ('rename': "Name (2)"). Layers the copied
 * objects use are added when this drawing lacks them. `scale` is the insertion scale that turns the
 * other drawing's units into this one's (1 when either has no units).
 */
import { t } from './i18n.js';

const MM_PER = { millimeters: 1, centimeters: 10, meters: 1000, kilometers: 1e6, inches: 25.4, feet: 304.8, yards: 914.4, miles: 1609344, mils: 0.0254, microinches: 0.0000254 };

/** mm per drawing unit (null when the units are not set or unknown). */
export const mmPerUnit = (units) => MM_PER[units] ?? null;

/** A block name made from a file name: no extension, no characters block names refuse. */
export function blockNameFromFile(file) {
  const base = String(file || 'Drawing').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const n = base.replace(/[<>/\\":;?*|=`]/g, '_').replace(/^\*+/, '').trim().slice(0, 255);
  return n || 'Drawing';
}

/** Blocks the entities use directly (inserts and dimensions drawn from a block). */
function refsOf(entities) {
  const out = new Set();
  for (const e of entities || []) if ((e.type === 'insert' || e.type === 'dim') && e.block) out.add(e.block);
  return out;
}

export function planCopy(doc, src, { block = null, whole = null, refs = false } = {}) {
  const srcBlocks = new Map((src.blocks || []).map((b) => [b.name, b]));
  let rootRefs, root;
  if (refs) {
    root = null;
    rootRefs = refsOf(src.entities);
  } else if (whole) {
    root = blockNameFromFile(whole);
    rootRefs = refsOf(src.entities);
  } else {
    if (!srcBlocks.has(block)) throw new Error(t('blockcopy.noblock', { name: block }));
    root = block;
    rootRefs = new Set([block]);
  }
  // every block reachable from the root, nested ones first
  const needed = [], seen = new Set();
  const visit = (name, depth) => {
    if (seen.has(name) || depth > 32) return;
    seen.add(name);
    const b = srcBlocks.get(name);
    if (!b) return;
    for (const r of refsOf(b.entities)) visit(r, depth + 1);
    needed.push(name);
  };
  for (const r of rootRefs) visit(r, 0);
  const named = (n) => !n.startsWith('*');
  const clashes = needed.filter((n) => named(n) && doc.blocks.has(n));
  if (whole && doc.blocks.has(root)) clashes.push(root);
  const a = mmPerUnit(src.meta?.units), b = mmPerUnit(doc.meta?.units);
  const scale = a && b ? a / b : 1;
  const note = a && b && a !== b ? t('blockcopy.units', { from: src.meta.units, to: doc.meta.units, scale: Number(scale.toPrecision(6)) }) : '';
  return { root, whole: !!whole, needed, clashes, scale, note, base: whole ? (src.meta?.insbase || { x: 0, y: 0 }) : null };
}

/** Copy the planned definitions into doc (inside doc.change). */
export function applyCopy(doc, src, plan, onClash = 'rename') {
  const srcBlocks = new Map((src.blocks || []).map((b) => [b.name, b]));
  const renamed = new Map();
  const keep = new Set();
  const free = (name) => {
    if (!doc.blocks.has(name) && ![...renamed.values()].includes(name)) return name;
    if (name.startsWith('*')) {
      const p = (name.match(/^\*[A-Za-z]*/) || ['*U'])[0];
      let k = 1; while (doc.blocks.has(p + k) || [...renamed.values()].includes(p + k)) k++;
      return p + k;
    }
    let k = 2; while (doc.blocks.has(name + ' (' + k + ')') || [...renamed.values()].includes(name + ' (' + k + ')')) k++;
    return name + ' (' + k + ')';
  };
  for (const n of plan.needed) {
    if (doc.blocks.has(n) && !n.startsWith('*') && onClash === 'keep') { keep.add(n); continue; }
    const to = free(n);
    if (to !== n) renamed.set(n, to);
  }
  const rename = (e) => (e.block && renamed.has(e.block) ? { ...e, block: renamed.get(e.block) } : e);
  const layers = new Set();
  const useLayers = (list) => { for (const e of list) if (e.layer) layers.add(e.layer); };
  let copied = 0;
  for (const n of plan.needed) {
    if (keep.has(n)) continue;
    const b = srcBlocks.get(n);
    const ents = b.entities.map(rename);
    useLayers(ents); for (const d of b.attdefs || []) layers.add(d.layer || '0');
    doc.defineBlock({ name: renamed.get(n) || n, base: b.base, entities: ents, attdefs: b.attdefs });
    copied++;
  }
  let name = plan.root;
  if (plan.whole) {
    if (doc.blocks.has(name) && onClash === 'keep') { /* use this drawing's block of that name */ }
    else {
      name = free(name);
      const ents = (src.entities || []).filter((e) => e.type !== 'viewport').map(rename);
      useLayers(ents);
      doc.defineBlock({ name, base: plan.base || { x: 0, y: 0 }, entities: ents });
      copied++;
    }
  } else if (name !== null) name = renamed.get(name) || name;
  // layers the copied objects use, with the other drawing's settings
  const srcLayers = new Map((src.layers || []).map((l) => [l.name, l]));
  const added = [];
  for (const l of layers) if (!doc.layers.has(l)) { doc.addLayer(srcLayers.get(l) || { name: l }); added.push(l); }
  return { name, copied, renamed, layers: added };
}
