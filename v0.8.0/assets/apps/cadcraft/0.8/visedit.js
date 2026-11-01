/* SPDX-License-Identifier: Apache-2.0 */
/**
 * visedit.js — visibility states in the block editor (0.5 DB.9; docs/DWG-DYNAMIC-BLOCKS.md § DB.10). DOM-free.
 *
 * Only a block that already has a visibility parameter (dyn-blocks.js `block.dyn.vis`): its states can be added, renamed,
 * deleted and made current, and objects hidden or shown per state. Making a NEW visibility parameter is not possible (the
 * DB.10 verdict: it needs an evaluation graph we can't write).
 *
 * In the editor (BEDIT) every file object of the block is known by its file index `fi` (`dyn.all[fi]` = its parts); the
 * editor's space holds the current state's objects, the others wait in `store`. What is in the space is the truth for the
 * current state, so UNDO inside the editor stays right (state names and the list of states are not undone; Discard is).
 *
 *   openVis(doc, blk) → be.vis | null    { def, states [{name, show:[fi…]}], cur, fiOf Map(id → fi), store Map(fi → parts),
 *                                         ad Set(fi), n } — and the entities the editor space starts with: `entities`
 *   syncCurrent(be.vis, map)             the current state's show = the file objects in the space now
 *   switchState(doc, be, name)           one undo step: objects in and out of the space
 *   hideIds(doc, be, ids) / showFi(doc, be, fis) → number changed (one undo step)
 *   hiddenParts(be) → [{ fi, parts }]    what the current state hides (BVSHOW shows them faded to pick)
 *   newState(be, name, how 'hide'|'show'|'keep') · renameState(be, from, to) · deleteState(be, name) → error key | null
 *   closeVis(doc, be, entities) → { block (with dyn), renamed Map, deleted Set, current } | { plain: reason }
 */
const clone = (e) => { const c = { ...e }; delete c.id; return c; };
/** File objects no state shows or hides (dyn-blocks.js freeObjects: the parameter's own list, else attribute definitions no state lists). */
const freeOf = (d) => (Array.isArray(d.vis.free) ? new Set(d.vis.free) : new Set((d.ad || []).filter((i) => !d.vis.states.some((s) => s.show.includes(i)))));

export function openVis(doc, blk) {
  const d = blk && blk.dyn, vis = d && d.vis;
  if (!d || !d.def || !vis || !vis.states?.length || !Array.isArray(d.all)) return null;
  const now = currentAll(blk);
  if (!now) return null;
  const ad = new Set(d.ad || []);
  // `src` = the state's name in the file (renamed or new states; dyn-blocks.js writes the parameter with it, DB.9)
  const states = vis.states.map((s) => ({ name: s.name, show: [...s.show], ...(s.src !== undefined && s.src !== s.name ? { src: s.src } : {}) }));
  const free = freeOf(d);
  const same = (s) => d.all.every((_, i) => free.has(i) || s.show.includes(i) === !!d.shown[i]);
  const cur = (states.find(same) || states[0]).name;
  const ghost = new Set(d.all.map((p, i) => (!ad.has(i) && !p.length ? i : -1)).filter((i) => i >= 0));   // objects CadCraft can't show
  const v = { def: blk.name, states, cur, fiOf: new Map(), store: new Map(), ad, ghost, n: d.all.length, entities: [] };
  const show = new Set(states.find((s) => s.name === cur).show);
  now.forEach((parts, fi) => {
    if (ad.has(fi) || ghost.has(fi)) return;
    if (show.has(fi)) for (const p of parts) { const x = { color: null, ...clone(p), id: doc.nextId++ }; v.fiOf.set(x.id, fi); v.entities.push(x); }
    else v.store.set(fi, parts.map(clone));
  });
  return v;
}

/** dyn.all as it is now: the shown parts from block.entities, the hidden ones from dyn.all (as dyn-blocks.js dynEntities). */
function currentAll(b) {
  const d = b.dyn, have = b.entities || [];
  if (d.all.length !== (d.shown || []).length) return null;
  let k = 0;
  const out = d.all.map((parts, i) => {
    if (!d.shown[i]) return parts;
    const now = have.slice(k, k + parts.length); k += parts.length;
    return now.length === parts.length ? now : null;
  });
  return k === have.length && out.every(Boolean) ? out : null;
}

const inSpace = (v, map) => { const by = new Map(); for (const [id, e] of map) { const fi = v.fiOf.get(id); if (fi !== undefined) (by.get(fi) || by.set(fi, []).get(fi)).push(e); } return by; };

export function syncCurrent(v, map) {
  const by = inSpace(v, map);
  const st = v.states.find((s) => s.name === v.cur);
  if (!st) return;
  // objects CadCraft can't show and attribute definitions (not in the space) keep their place in the state
  st.show = [...new Set([...st.show.filter((fi) => v.ghost.has(fi) || v.ad.has(fi)), ...by.keys()])].sort((a, b) => a - b);
}

function moveOut(doc, v, map, fis) {
  const by = inSpace(v, map);
  let n = 0;
  for (const fi of fis) {
    const parts = by.get(fi);
    if (!parts) continue;
    v.store.set(fi, parts.map(clone));
    for (const e of parts) doc.remove(e.id, map);
    n++;
  }
  return n;
}
function moveIn(doc, v, map, fis) {
  const by = inSpace(v, map);
  let n = 0;
  for (const fi of fis) {
    if (by.has(fi) || !v.store.has(fi)) continue;
    for (const p of v.store.get(fi)) { const x = doc.add({ ...p }, map); v.fiOf.set(x.id, fi); }
    n++;
  }
  return n;
}

export function switchState(doc, be, name) {
  const v = be.vis, map = be.map;
  const to = v.states.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (!to) return 'no-state';
  syncCurrent(v, map);
  const want = new Set(to.show), have = new Set(inSpace(v, map).keys());
  doc.change('BVSTATE', () => {
    moveOut(doc, v, map, [...have].filter((fi) => !want.has(fi)));
    moveIn(doc, v, map, [...want].filter((fi) => !have.has(fi)));
  });
  v.cur = to.name;
  return null;
}

export function hideIds(doc, be, ids) {
  const v = be.vis;
  const fis = [...new Set(ids.map((id) => v.fiOf.get(id)).filter((fi) => fi !== undefined))];
  let n = 0;
  if (fis.length) doc.change('BVHIDE', () => { n = moveOut(doc, v, be.map, fis); });
  syncCurrent(v, be.map);
  return n;
}
export function showFi(doc, be, fis) {
  let n = 0;
  if (fis.length) doc.change('BVSHOW', () => { n = moveIn(doc, be.vis, be.map, fis); });
  syncCurrent(be.vis, be.map);
  return n;
}
export function hiddenParts(be) {
  const shown = new Set(inSpace(be.vis, be.map).keys());
  return [...be.vis.store].filter(([fi]) => !shown.has(fi)).map(([fi, parts]) => ({ fi, parts }));
}

const NAME_OK = /^[^<>/\\":;?*|,=`]{1,255}$/;
export function newState(be, name, how = 'keep') {
  const v = be.vis, nm = String(name || '').trim();
  if (!NAME_OK.test(nm)) return 'bad-name';
  if (v.states.some((s) => s.name.toLowerCase() === nm.toLowerCase())) return 'taken';
  syncCurrent(v, be.map);
  const cur = v.states.find((s) => s.name === v.cur);
  const every = [...Array(v.n).keys()];
  const show = how === 'show' ? every : how === 'hide' ? [] : [...cur.show];   // i18n-ignore (keywords)
  v.states.push({ name: nm, show, src: cur.src ?? cur.name });   // its parameters and grips: as the state it was made from
  return null;
}
export function renameState(be, from, to) {
  const v = be.vis, st = v.states.find((s) => s.name.toLowerCase() === String(from).toLowerCase());
  const nm = String(to || '').trim();
  if (!st) return 'no-state';
  if (!NAME_OK.test(nm)) return 'bad-name';
  if (v.states.some((s) => s !== st && s.name.toLowerCase() === nm.toLowerCase())) return 'taken';
  (v.renamed ||= new Map());
  const orig = [...v.renamed].find(([, now]) => now === st.name)?.[0] ?? st.name;
  v.renamed.set(orig, nm);
  if (v.cur === st.name) v.cur = nm;
  if (st.src === undefined) st.src = st.name;
  st.name = nm;
  if (st.src === nm) delete st.src;
  return null;
}
export function deleteState(be, name) {
  const v = be.vis, i = v.states.findIndex((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (i < 0) return 'no-state';
  if (v.states.length < 2) return 'last';
  if (v.states[i].name === v.cur) return 'current';
  (v.deleted ||= new Set()).add(v.states[i].name);
  v.states.splice(i, 1);
  return null;
}

/**
 * Rebuild the definition from the editor. Plain block (dyn dropped) when objects were added, erased or exploded: then the
 * file objects no longer line up with the states. Attribute definitions (`entities` already split off by the caller) keep
 * the states they were in (the editor does not move them between states); the definition shows those of its current state
 * (0.6.1 FIX-061-DYN-ATTRS).
 */
export function closeVis(doc, be, entities) {
  const v = be.vis, blk = doc.blocks.get(v.def);
  syncCurrent(v, be.map);
  const by = new Map();
  for (const e of entities) {
    const fi = v.fiOf.get(e.id);
    if (fi === undefined) return { plain: 'added' };
    (by.get(fi) || by.set(fi, []).get(fi)).push(e);
  }
  const d = blk.dyn, all = [];
  for (let fi = 0; fi < v.n; fi++) {
    if (v.ad.has(fi) || !d.all[fi].length) { all.push(d.all[fi]); continue; }
    const parts = by.get(fi) || v.store.get(fi);
    if (!parts || parts.length !== d.all[fi].length || parts.some((p, j) => p.type !== d.all[fi][j].type)) return { plain: 'changed' };
    all.push(parts.map(clone));
  }
  const cur = v.states.find((s) => s.name === v.cur);
  const showSet = new Set(cur.show);
  const free = freeOf(d);
  const shown = all.map((_, fi) => (free.has(fi) ? !!d.shown[fi] : showSet.has(fi)));
  const vis = { ...d.vis, states: v.states.map((s) => ({ name: s.name, show: [...s.show].sort((a, b) => a - b), ...(s.src !== undefined && s.src !== s.name ? { src: s.src } : {}) })) };
  const key = (states) => JSON.stringify(states.map((s) => [s.name, s.show]));
  const changedVis = key(vis.states) !== key(d.vis.states);
  const block = {
    name: blk.name, base: be.base,
    entities: all.filter((_, fi) => shown[fi]).flat(),
    dyn: { ...d, all, shown, vis, ...(changedVis || d.visEdited ? { visEdited: true } : {}) },
  };
  return { block, renamed: v.renamed || new Map(), deleted: v.deleted || new Set(), current: cur.name, first: v.states[0].name };
}
