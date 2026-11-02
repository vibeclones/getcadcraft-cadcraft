/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dimstyles.js — named dimension styles: make, change, set current, delete, apply, compare (0.7 D7.14; DIMSTYLE). No DOM:
 * bin/test-cadcraft.mjs runs it in Node.
 *
 * A dimension carries its whole style (`st`, dimstyle.js) and, when it uses a named one, the name (`dimstyle`). The drawing's
 * named styles are `doc.dimStyles` (name → st; saved as the file's DIMSTYLE table). Settings for NEW dimensions are
 * `doc.current.dim`, and `doc.current.dimstyle` is the name they came from (session state, like the other "current" values).
 *
 * "Standard" is the file's default style and lives in `doc.current.dim` while it is current. The moment another style becomes
 * current, Standard's settings are parked in `doc.dimStyles` under that name (savedStandard), so nothing is lost and
 * dwg-save.js / dxf.js write it from there.
 *
 *   currentName(doc)               the current style's name
 *   styleOf(doc, name)             a copy of that style's settings, or null
 *   listStyles(doc)                [{ name, current, uses }] Standard first, then by name
 *   setCurrent(doc, name)          new dimensions use it  → { ok } | { error }
 *   saveStyle(doc, name, st)       make or replace a style (one undo step)
 *   modifyStyle(doc, name, patch)  change settings of a style; the dimensions that use it follow, key by key, and drop the
 *                                  other program's drawing (`block`) so CadCraft draws them again
 *   renameStyle / deleteStyle      a style in use or the current one cannot be deleted; Standard cannot be renamed or deleted
 *   applyStyle(doc, ids, name)     the named style's settings onto those dimensions
 *   differences(a, b)              the setting keys whose values differ
 */
import { DIM_DEFAULTS } from './dims.js';
import { DIM_EXTRA } from './dimstyle.js';

export const STANDARD = 'Standard';
const NAME_RE = /^[^<>/\\":;?*|=`\u0000-\u001f]{1,255}$/;
export const isStandard = (n) => /^standard$/i.test(String(n ?? STANDARD));

export const currentName = (doc) => doc.current.dimstyle || STANDARD;
/** Standard's settings, wherever they are right now. */
export function standardSt(doc) {
  const parked = doc.dimStyles.get(STANDARD);
  return parked || (isStandard(currentName(doc)) ? doc.current.dim : { ...DIM_DEFAULTS });
}
/** The stored name for a typed one (any case), or null. */
export function findName(doc, name) {
  const low = String(name ?? '').trim().toLowerCase();
  if (low === STANDARD.toLowerCase()) return STANDARD;
  for (const n of doc.dimStyles.keys()) if (n.toLowerCase() === low) return n;
  return null;
}
export function styleOf(doc, name) {
  const n = findName(doc, name);
  if (!n) return null;
  if (n === STANDARD) return { ...standardSt(doc) };
  const st = doc.dimStyles.get(n);
  return st ? { ...DIM_DEFAULTS, ...st } : null;
}

const usesOf = (doc, name) => {
  let n = 0;
  for (const e of doc.everyEntity()) if (e.type === 'dim' && (isStandard(name) ? !e.dimstyle || isStandard(e.dimstyle) : e.dimstyle === name)) n++;
  return n;
};
export function listStyles(doc) {
  const names = [STANDARD, ...[...doc.dimStyles.keys()].filter((n) => !isStandard(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
  return names.map((name) => ({ name, current: name === currentName(doc), uses: usesOf(doc, name) }));
}

/** Park Standard's settings in the style table the first time another style is about to become current. */
function parkStandard(doc) {
  if (!isStandard(currentName(doc)) || doc.dimStyles.has(STANDARD)) return;
  doc.setStyle('dimStyles', STANDARD, { ...doc.current.dim });
}

export function setCurrent(doc, name) {
  const n = findName(doc, name);
  if (!n) return { error: 'missing' };
  const st = styleOf(doc, n);
  if (!st) return { error: 'missing' };
  if (n !== currentName(doc)) {
    doc.change('DIMSTYLE', () => parkStandard(doc));
    doc.current.dim = { ...st };
    doc.current.dimstyle = n === STANDARD ? null : n;
  }
  return { ok: true, name: n };
}

export function problem(doc, name, except = null) {
  const n = String(name ?? '').trim();
  if (!NAME_RE.test(n)) return 'name';
  const have = findName(doc, n);
  if (have && have !== except) return 'dup';
  return null;
}

/** Make a style from settings (a copy of `from`'s when given). */
export function saveStyle(doc, name, st, { makeCurrent = false } = {}) {
  const e = problem(doc, name);
  if (e) return { error: e };
  const n = String(name).trim();
  doc.change('DIMSTYLE', () => { parkStandard(doc); doc.setStyle('dimStyles', n, { ...DIM_DEFAULTS, ...st }); });
  if (makeCurrent) setCurrent(doc, n);
  return { ok: true, name: n };
}
export function newFrom(doc, name, fromName) {
  const base = styleOf(doc, fromName || currentName(doc));
  if (!base) return { error: 'missing' };
  return saveStyle(doc, name, base);
}

const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b);
export function differences(a, b) {
  const A = { ...DIM_DEFAULTS, ...DIM_EXTRA, ...a }, B = { ...DIM_DEFAULTS, ...DIM_EXTRA, ...b };
  return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => !same(A[k], B[k])).sort();
}

/** The dimensions that use a style (by name). */
function usersOf(doc, name) {
  const out = [];
  for (const e of doc.everyEntity()) if (e.type === 'dim' && (isStandard(name) ? !e.dimstyle || isStandard(e.dimstyle) : e.dimstyle === name)) out.push(e);
  return out;
}
/** Dimensions are updated in whichever space they live: update() works on the open one, so go through the Maps. */
function updateDim(doc, e, next) {
  for (const map of [doc.model, ...doc.layouts.map((l) => l.entities)]) {
    if (map.has(e.id)) { doc.update(e.id, next, map); return; }
  }
}

/**
 * Change a style's settings (`patch` = the keys to set; undefined removes a key). The dimensions that use the style take the
 * changed keys; a setting someone changed on one dimension alone (an override) stays when the style did not change it.
 */
export function modifyStyle(doc, name, patch) {
  const n = findName(doc, name);
  if (!n) return { error: 'missing' };
  const before = styleOf(doc, n);
  const after = { ...before };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete after[k]; else after[k] = v; }
  const keys = differences(before, after);
  if (!keys.length) return { ok: true, changed: 0, dims: 0 };
  let dims = 0;
  doc.change('DIMSTYLE', () => {
    if (n === STANDARD && isStandard(currentName(doc))) { /* Standard is current: its settings are doc.current.dim */ } else doc.setStyle('dimStyles', n, after);
    for (const e of usersOf(doc, n)) {
      const st = { ...(e.st || {}) };
      for (const k of keys) { if (after[k] === undefined) delete st[k]; else st[k] = after[k]; }
      const next = { ...e, st }; delete next.block;
      updateDim(doc, e, next);
      dims++;
    }
  });
  if (n === currentName(doc) || (n === STANDARD && isStandard(currentName(doc)))) doc.current.dim = { ...after };
  return { ok: true, changed: keys.length, dims, keys };
}

export function renameStyle(doc, oldName, newName) {
  const n = findName(doc, oldName);
  if (!n) return { error: 'missing' };
  if (n === STANDARD) return { error: 'standard' };
  const e = problem(doc, newName, n);
  if (e) return { error: e };
  const to = String(newName).trim(), st = doc.dimStyles.get(n);
  doc.change('DIMSTYLE', () => {
    doc.setStyle('dimStyles', n, null);
    doc.setStyle('dimStyles', to, st);
    for (const d of usersOf(doc, n)) updateDim(doc, d, { ...d, dimstyle: to });
  });
  if (currentName(doc) === n) doc.current.dimstyle = to;
  return { ok: true, name: to };
}

export function deleteStyle(doc, name) {
  const n = findName(doc, name);
  if (!n) return { error: 'missing' };
  if (n === STANDARD) return { error: 'standard' };
  if (n === currentName(doc)) return { error: 'current' };
  if (usesOf(doc, n)) return { error: 'inuse', uses: usesOf(doc, n) };
  doc.change('DIMSTYLE', () => doc.setStyle('dimStyles', n, null));
  return { ok: true, name: n };
}

/** The style's settings onto these dimensions (one undo step); locked layers stay. */
export function applyStyle(doc, ids, name) {
  const n = findName(doc, name);
  const st = n && styleOf(doc, n);
  if (!st) return { error: 'missing' };
  let done = 0;
  doc.change('DIMSTYLE', () => {
    for (const id of ids) {
      const e = doc.get(id);
      if (!e || e.type !== 'dim' || !e.kind || !doc.editable(e)) continue;
      const next = { ...e, st: { ...st } };
      if (n === STANDARD) delete next.dimstyle; else next.dimstyle = n;
      delete next.block;
      updateDim(doc, e, next);
      done++;
    }
  });
  return { ok: true, n: done };
}
