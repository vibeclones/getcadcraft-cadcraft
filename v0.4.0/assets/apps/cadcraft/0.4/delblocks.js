/* SPDX-License-Identifier: Apache-2.0 */
/**
 * delblocks.js — DELBLOCKS, delete blocks without a routine (0.4 part 2, Y.13; session cad-lisp).
 *
 *   deletable(doc)              → block names the command offers (no anonymous blocks, linked drawings or sheets)
 *   deleteBlocks(doc, names)    → { deleted: [{ name, refs }], failed: [{ name, reason }] }   (inside the caller's change)
 *   delblocksCommand(c)          the command: pick a reference, or N for a list with a filter (host.chooseBlocks), repeat
 *
 * Every reference goes — in the model, on every sheet and nested inside other blocks' definitions, at any depth —
 * and then the definitions. Objects on locked layers go too (as the routine people know does, by unlocking for the
 * moment). The whole command is one undo step. DOM-free: the chooser dialog is the host's.
 */
import { t } from './i18n.js';

/** Block names DELBLOCKS offers, sorted. */
export function deletable(doc) {
  return [...doc.blocks.values()]
    .filter((b) => !b.name.startsWith('*') && !b.xref && !/^\*(model|paper)_space/i.test(b.name))
    .map((b) => b.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Delete these blocks (case-insensitive names): references everywhere, then the definitions. Call inside doc.change. */
export function deleteBlocks(doc, names) {
  const want = new Map();
  const failed = [];
  for (const n of names) {
    const b = [...doc.blocks.values()].find((x) => x.name.toUpperCase() === String(n).toUpperCase());
    if (!b) { failed.push({ name: String(n), reason: t('delblocks.notfound') }); continue; }
    if (b.xref) { failed.push({ name: b.name, reason: t('delblocks.xref') }); continue; }
    if (b.name.startsWith('*')) { failed.push({ name: b.name, reason: t('delblocks.anonymous') }); continue; }
    want.set(b.name, 0);
  }
  if (!want.size) return { deleted: [], failed };
  const hit = (e) => e.type === 'insert' && want.has(e.block);
  // references in the model and on every sheet
  for (const map of [doc.model, ...doc.layouts.map((l) => l.entities)]) {
    for (const e of [...map.values()]) if (hit(e)) { want.set(e.block, want.get(e.block) + 1); doc.remove(e.id, map); }
  }
  // references nested in other blocks (the definitions being deleted lose theirs with them)
  for (const b of [...doc.blocks.values()]) {
    if (want.has(b.name)) continue;
    if (!b.entities.some(hit)) continue;
    for (const e of b.entities) if (hit(e)) want.set(e.block, want.get(e.block) + 1);
    doc.defineBlock({ ...b, entities: b.entities.filter((e) => !hit(e)) });
  }
  const deleted = [];
  for (const [name, refs] of want) {
    // what is left using it: a dimension drawn from it, or a reference inside another deleted block
    if (doc.blockUses(name) && [...doc.everyEntity()].some((e) => e.block === name)) { failed.push({ name, reason: t('delblocks.inuse') }); continue; }
    doc.removeBlock(name);
    deleted.push({ name, refs });
  }
  return { deleted, failed };
}

/** The command. c: the Engine's command API. */
export async function delblocksCommand(c) {
  const doc = c.doc;
  for (;;) {
    const names = deletable(doc);
    if (!names.length) { c.print(t('delblocks.none')); return; }
    const r = await c.entity(t('delblocks.prompt'), { none: true, empty: true, options: [{ key: 'N', label: t('delblocks.opt.name') }, { key: 'X', label: t('delblocks.opt.exit') }] });
    if (!r || r.option === 'X') return;
    let chosen = null;
    if (r.option === 'N') {
      if (c.host.chooseBlocks) chosen = await c.host.chooseBlocks({ title: t('delblocks.dialog.title'), names });
      else {
        const s = await c.string(t('delblocks.typenames'), { raw: true });
        const pats = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
        const { wcmatch } = await import('./lisp/wild.js');
        chosen = names.filter((n) => pats.some((p) => wcmatch(n.toUpperCase(), p.toUpperCase())));
      }
      if (!chosen || !chosen.length) continue;
    } else if (r.empty) { c.print(t('delblocks.missed')); continue; }
    else {
      const e = doc.get(r.id);
      if (!e || e.type !== 'insert') { c.print(t('delblocks.notblock')); continue; }
      if (!names.includes(e.block)) { c.print(t('delblocks.cannot', { name: e.block })); continue; }
      chosen = [e.block];
    }
    let res = null;
    doc.change('DELBLOCKS', () => { res = deleteBlocks(doc, chosen); });
    for (const d of res.deleted) c.print(t('delblocks.deleted', { name: d.name, n: d.refs }));
    for (const f of res.failed) c.print(t('delblocks.failed', { name: f.name, reason: f.reason }));
  }
}
