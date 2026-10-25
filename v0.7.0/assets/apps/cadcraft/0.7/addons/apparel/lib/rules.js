/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — the strings here are the RUL file format's own keywords, never shown as UI text. */
/**
 * rules.js — the grade rule library (track AP, AP.5): named grade rules kept by the person (not in a drawing), applied to
 * points of any piece, and moved in and out as JSON or a RUL file. No DOM.
 *
 * An entry: { name, u: 'mm' | 'in', sizes: ['XS', …], base: 'M', rule: [dx, dy, …] } — a rule as grade.js keeps it (one
 * pair per size, measured from the base). Applied to a piece with another size range, sizes are matched by name and the
 * moves measured again from the piece's base; sizes the entry does not have stay where the base is.
 *
 *   FORMAT · MAX · cleanEntry(raw) · cleanLibrary(raw) → entries · addEntry(lib, entry) (same name = replaced) → lib
 *   ruleFor(entry, sizes, u) → a rule for a piece's size range and units · entryFrom(name, data, rule) → entry
 *   toJson(lib) · fromJson(text) → { entries, error } · fromRul(text, name) → entries · toRul(lib, opts) → text | null
 */

import { parseRul } from './aama.js';

export const FORMAT = 'cadcraft-grade-rules';
export const MAX = 500;
const MAXS = 60;
const fin = (v) => Number.isFinite(v) && Math.abs(v) <= 1e6;
const clean = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');

export function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clean(raw.name, 80);
  const sizes = Array.isArray(raw.sizes) ? [...new Set(raw.sizes.slice(0, MAXS).map((s) => clean(s, 12)).filter(Boolean))] : [];
  if (!name || !sizes.length || !Array.isArray(raw.rule) || raw.rule.length !== sizes.length * 2 || !raw.rule.every((v) => fin(+v))) return null;
  const base = sizes.includes(raw.base) ? raw.base : sizes[0];
  const rule = raw.rule.map(Number);
  const b = sizes.indexOf(base);
  rule[2 * b] = 0; rule[2 * b + 1] = 0;
  return { name, u: raw.u === 'in' ? 'in' : 'mm', sizes, base, rule };
}

export function cleanLibrary(raw) {
  const out = [];
  for (const e of Array.isArray(raw) ? raw.slice(0, MAX) : []) { const c = cleanEntry(e); if (c) addEntry(out, c); }
  return out;
}

/** Add (or replace by name, case-insensitive). → the same list. */
export function addEntry(lib, entry) {
  const i = lib.findIndex((x) => x.name.toLowerCase() === entry.name.toLowerCase());
  if (i >= 0) lib[i] = entry; else if (lib.length < MAX) lib.push(entry);
  return lib;
}

export const entryFrom = (name, data, rule) => cleanEntry({ name, u: data.u, sizes: data.sizes.list, base: data.sizes.base, rule });

/** The entry as a rule for a piece's size range (names matched, measured from the piece's base) in the piece's units. */
export function ruleFor(entry, sizes, u) {
  const k = entry.u === u ? 1 : entry.u === 'in' ? 25.4 : 1 / 25.4;
  const at = (s) => { const i = entry.sizes.indexOf(s); return i >= 0 ? [entry.rule[2 * i], entry.rule[2 * i + 1]] : null; };
  const b = at(sizes.base) || [0, 0];
  return sizes.list.flatMap((s) => { const m = at(s) || b; return [+((m[0] - b[0]) * k).toFixed(6), +((m[1] - b[1]) * k).toFixed(6)]; });
}

export function toJson(lib) {
  return JSON.stringify({ format: FORMAT, version: 1, rules: lib }, null, 1);
}

export function fromJson(text) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return { entries: [], error: 'json' }; }
  if (!j || j.format !== FORMAT || !Array.isArray(j.rules)) return { entries: [], error: 'format' };
  if (j.version > 1) return { entries: [], error: 'newer' };
  return { entries: cleanLibrary(j.rules), error: null };
}

/** A RUL file's rules as entries ("<table> 7", or "<name> 7"). */
export function fromRul(text, name = '') {
  const r = parseRul(text);
  if (!r) return [];
  const base = r.sizes.includes(r.sample) ? r.sample : r.sizes[0];
  const bi = r.sizes.indexOf(base);
  const label = clean(name || r.name || 'RUL', 60);
  const out = [];
  for (const [n, pairs] of r.rules) {
    if (pairs.length < r.sizes.length) continue;
    const rule = r.sizes.flatMap((_, i) => [pairs[i][0] - pairs[bi][0], pairs[i][1] - pairs[bi][1]]);
    const e = cleanEntry({ name: label + ' ' + n, u: r.units.startsWith('ENG') ? 'in' : 'mm', sizes: r.sizes, base, rule });
    if (e) out.push(e);
  }
  return out;
}

/**
 * The library as a RUL file: the entries that share the first entry's size range and units (a RUL has one range), numbered
 * in order. → { text, written, left } | null (empty).
 */
export function toRul(lib, { name = 'Grade rules', author = 'CadCraft' } = {}) {
  if (!lib.length) return null;
  const first = lib[0];
  const same = lib.filter((e) => e.sizes.join(' ') === first.sizes.join(' ') && e.base === first.base && e.u === first.u);
  const L = ['ASTM/D13 Proposal 1 Version: D 6673-04', 'AUTHOR: ' + author, 'PRODUCT: CadCraft Apparel', 'UNITS: ' + (first.u === 'in' ? 'ENGLISH' : 'METRIC'),
    'GRADE RULE TABLE: ' + name, 'NUMBER OF SIZES: ' + first.sizes.length, 'SIZE LIST: ' + first.sizes.join(' '), 'SAMPLE SIZE: ' + first.base];
  same.forEach((e, i) => {
    L.push('RULE: DELTA ' + (i + 1));
    const pairs = e.sizes.map((_, k) => [e.rule[2 * k], e.rule[2 * k + 1]]);
    for (let k = 0; k < pairs.length; k += 4) L.push(pairs.slice(k, k + 4).map(([x, y]) => x.toFixed(2).padStart(9) + y.toFixed(2).padStart(9)).join(''));
  });
  L.push('END');
  return { text: L.join('\r\n') + '\r\n', written: same.map((e) => e.name), left: lib.length - same.length };
}
