/* SPDX-License-Identifier: Apache-2.0 */
/**
 * attrs.js — block attributes (the values a block reference carries, such as an item number).
 * No DOM: bin/test-cadcraft.mjs runs it in Node. The drawing model is in geom.js `attrTexts`:
 *   block.attdefs [{ tag, prompt, def, x, y, h, rot, ha, va, wf, invisible, constant, preset, layer, color }]
 *                 positions in the block's own coordinates (like its entities)
 *   insert.attrs  { TAG: value }                       tags upper case (normTag)
 *   insert.attloc { TAG: { x, y, h, rot, ha, va, wf, invisible, layer, color } }   only for an attribute
 *                 placed off its definition (moved in another program) or a tag the block does not define
 *
 * Readers (dxf.js, dwg-import.js) hang each reference's attributes on it as `_attribs` (world text with
 * `tag`) and call resolveAttribs() once every block is known; it turns them into attrs/attloc.
 */

import { insertMatrix, mInverse, txEntity, normAngle, normTag, attrTexts, attdefHidden } from './geom.js';

export { normTag };

/** An attribute definition from a text-shaped entity (block coordinates). */
export function attdef(t, { tag, prompt = '', def = '', invisible = false, constant = false, preset = false } = {}) {
  const d = {
    tag: normTag(tag), prompt: String(prompt ?? ''), def: oneLine(def),
    x: +t.x || 0, y: +t.y || 0, h: t.h > 0 ? +t.h : 2.5, rot: t.rot || 0, ha: t.ha || 'left', va: t.va || 'baseline', wf: t.wf || 1,
    layer: t.layer ?? '0', color: t.color ?? null,
  };
  if (invisible) d.invisible = true;
  if (constant) d.constant = true;
  if (preset) d.preset = true;
  return d;
}

/** Attribute values are one line of text. */
export const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

/** The values a new reference starts with: each variable definition's default. */
export function defaultAttrs(blk) {
  const out = {};
  for (const d of blk?.attdefs || []) if (!d.constant) out[d.tag] = d.def || '';
  return out;
}

/** Every attribute of a reference, in definition order, for the Properties panel and LIST. */
export function attrRows(e, blk) {
  const rows = [];
  const vals = e.attrs || {};
  const has = (t) => Object.prototype.hasOwnProperty.call(vals, t);
  const seen = new Set();
  (blk?.attdefs || []).forEach((d, j) => {
    seen.add(d.tag);
    if (!d.constant && !has(d.tag)) return;
    rows.push({ tag: d.tag, value: d.constant ? d.def : String(vals[d.tag] ?? ''), prompt: d.prompt, invisible: !!(e.attloc?.[d.tag]?.invisible ?? d.invisible), constant: !!d.constant, preset: !!d.preset,
      ...(attdefHidden(blk, j) ? { hidden: true } : {}) });   // its visibility state hides it (the value is kept)
  });
  for (const tag of Object.keys(vals)) if (!seen.has(tag)) rows.push({ tag, value: String(vals[tag] ?? ''), prompt: '', invisible: !!e.attloc?.[tag]?.invisible, constant: false, preset: false, undefinedTag: true });
  return rows;
}

/**
 * Turn the `_attribs` readers left on references into attrs (+ attloc where an attribute is not
 * where its definition puts it). `lists` are arrays of entities; `blocks` a Map name → block.
 */
export function resolveAttribs(lists, blocks) {
  for (const list of lists) {
    for (const e of list) {
      if (e.type !== 'insert' || !e._attribs) continue;
      const raw = e._attribs;
      delete e._attribs;
      if (!raw.length) continue;
      const blk = blocks.get(e.block);
      const inv = blk ? mInverse(insertMatrix(e, blk)) : null;
      const attrs = {}, attloc = {};
      for (const a of raw) {
        const tag = normTag(a.tag);
        if (!tag || Object.prototype.hasOwnProperty.call(attrs, tag)) continue;
        attrs[tag] = oneLine(a.s);
        const local = inv ? txEntity({ ...a, type: 'text' }, inv) : null;
        const d = blk?.attdefs?.find((x) => x.tag === tag);
        if (local && d && sameSpot(local, d, !!a.invisible)) continue;
        if (local) attloc[tag] = { x: local.x, y: local.y, h: local.h, rot: local.rot || 0, ha: a.ha || 'left', va: a.va || 'baseline', wf: a.wf || 1, layer: a.layer ?? '0', color: a.color ?? null, ...(a.invisible ? { invisible: true } : {}) };
      }
      e.attrs = attrs;
      if (Object.keys(attloc).length) e.attloc = attloc;
    }
  }
}

function sameSpot(t, d, invisible) {
  const tol = 1e-6 * Math.max(1, Math.abs(d.h || 1), Math.abs(d.x), Math.abs(d.y));
  const da = Math.abs(normAngle((t.rot || 0) - (d.rot || 0)));
  return Math.abs(t.x - d.x) <= tol && Math.abs(t.y - d.y) <= tol && Math.abs(t.h - d.h) <= tol * 10 && Math.min(da, 2 * Math.PI - da) < 1e-6 &&
    (t.ha || 'left') === (d.ha || 'left') && (t.va || 'baseline') === (d.va || 'baseline') && invisible === !!d.invisible && (t.layer ?? '0') === (d.layer ?? '0') && (t.color ?? null) === (d.color ?? null);
}

/**
 * Attribute texts in WORLD coordinates (for writing ATTRIBs): text entities with `tag`, `invisible` and `hidden` (hidden by
 * the dynamic block's visibility state: geom.attdefHidden). Constant attributes are left out (their definition says them).
 */
export function worldAttribs(e, blk) {
  const m = insertMatrix(e, blk);
  const constant = new Set((blk.attdefs || []).filter((d) => d.constant).map((d) => d.tag));
  return attrTexts({ ...e, attrs: nonConstant(e, blk) }, blk, true).filter((t) => !constant.has(t.tag))
    .map((t) => ({ ...txEntity(t, m), tag: t.tag, invisible: !!t.invisible, ...(t.hidden ? { hidden: true } : {}) }));
}
function nonConstant(e, blk) {
  const out = { ...(e.attrs || {}) };
  for (const d of blk?.attdefs || []) if (d.constant) delete out[d.tag];
  return out;
}

/** The next free item number for a tag (numbers already used + 1; "1" when none). */
export function nextNumber(doc, tag = 'CC-ITEM') {
  let max = 0;
  const look = (e) => { const v = e.attrs?.[tag]; if (v !== undefined && /^\d+$/.test(String(v).trim())) max = Math.max(max, parseInt(v, 10)); };
  for (const e of doc.everyEntity()) if (e.type === 'insert') look(e);
  return String(max + 1);
}
