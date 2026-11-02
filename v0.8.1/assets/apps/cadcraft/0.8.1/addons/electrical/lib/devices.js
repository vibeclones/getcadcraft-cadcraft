/* SPDX-License-Identifier: Apache-2.0 */
/**
 * devices.js — device tags in the IEC 81346 style (0.4 part 2, E.3) and cross-references (E.4). DOM-free.
 *
 * Tags. A symbol's TAG attribute is the product part of its designation ("-K3"); FUNC ("=A1", the plant) and LOC
 * ("+S2", the location) are its own when set, else the sheet frame's PLANT and LOC — so the full designation is
 * "=A1+S2-K3" (model.js `fullTag`). Everything with one full designation is ONE device: a coil and its contacts, a
 * pushbutton's contact blocks, the three poles of a breaker drawn apart.
 * `autoTag` gives untagged symbols a tag from the sheet's path grid: the IEC 81346-2 class letter (symbols.js LETTERS)
 * + sheet + two-digit path ("-K204" = sheet 2, path 4; a second one on that path "-K204.2"), or simply the next number
 * per letter ("-K1, -K2", scheme `sequential`). Contacts are never tagged automatically: they take their coil's tag.
 * Terminals get a strip ("-X1" unless told) and the next free terminal number in it (attribute P1).
 *
 * Cross-references. A coil's attributes XREF1…XREF8 list its contacts ("NO 13-14 /2.5" = a make contact, pins 13-14,
 * sheet 2 path 5 — the contact mirror); each contact's XREF says where its coil is ("/1.4"). `updateXrefs` recomputes
 * them for the whole drawing, so they follow any edit on any sheet (main.js runs it after every change).
 */

import { LETTERS } from './symbols.js';
import { fullTag, placeOrder, cmpNumber } from './model.js';
import { t } from './text.js';

export const XREF_LINES = 8;

// ------------------------------------------------------------------------------------------------ tags

/** "-K204" → {letter: 'K', rest: '204'}; "=A1+S2-K3" → the product part only. */
export function splitTag(tag) {
  const s = String(tag || '').trim();
  const m = /-([A-Za-z]{1,3})([^-+=]*)$/.exec(s);
  return m ? { letter: m[1].toUpperCase(), rest: m[2] } : null;
}

const NEEDS_TAG = new Set(['coil', 'device', 'plc', 'terminal']);

/**
 * Tag untagged symbols (inside a change). opts: scheme 'path' | 'sequential', all (retag everything but contacts and
 * terminals that have a tag), strip (terminal strip for untagged terminals), only (a Set of device uids to tag). → {tagged: [{device, tag}], terminals: n}.
 */
export function autoTag(doc, model, { scheme = 'path', all = false, strip = '-X1', only = null } = {}) {
  const mine = (d) => !only || only.has(d.uid);   // only: tag just these (a symbol being placed); the rest still count as taken
  const taken = new Set(model.devices.filter((d) => d.tag && !(all && NEEDS_TAG.has(d.role) && d.role !== 'terminal')).map((d) => d.fullTag));
  const out = { tagged: [], terminals: 0 };
  const todo = model.devices.filter((d) => mine(d) && NEEDS_TAG.has(d.role) && d.role !== 'terminal' && (all || !d.tag) && LETTERS[d.sym] !== '').sort(placeOrder);
  const seq = new Map();
  for (const d of todo) {
    const letter = LETTERS[d.sym] || 'A';
    let tag;
    if (scheme === 'sequential') {
      let n = seq.get(letter) || 1;
      while (taken.has(fullTag(d.func, d.loc, '-' + letter + n))) n++;
      tag = '-' + letter + n;
      seq.set(letter, n + 1);
    } else {
      const base = '-' + letter + d.sheet.number + String(d.path || 0).padStart(2, '0');
      tag = base;
      for (let k = 2; taken.has(fullTag(d.func, d.loc, tag)); k++) tag = base + '.' + k;
    }
    taken.add(fullTag(d.func, d.loc, tag));
    doc.update(d.id, { ...d.e, attrs: { ...(d.e.attrs || {}), TAG: tag } }, d.space.map);
    out.tagged.push({ device: d, tag });
  }
  // terminals: strip + next number
  const terms = model.devices.filter((d) => d.role === 'terminal');
  const usedNo = new Map();
  for (const d of terms) if (d.tag && String(d.attrs.P1 || '').trim()) { const k = fullTag(d.func, d.loc, d.tag); if (!usedNo.has(k)) usedNo.set(k, new Set()); usedNo.get(k).add(String(d.attrs.P1).trim()); }
  for (const d of terms.filter((x) => mine(x) && (!x.tag || !String(x.attrs.P1 || '').trim())).sort(placeOrder)) {
    const tag = d.tag || strip;
    const k = fullTag(d.func, d.loc, tag);
    if (!usedNo.has(k)) usedNo.set(k, new Set());
    const used = usedNo.get(k);
    let no = String(d.attrs.P1 || '').trim();
    if (!no) { let n = 1; while (used.has(String(n))) n++; no = String(n); }
    used.add(no);
    doc.update(d.id, { ...d.e, attrs: { ...(d.e.attrs || {}), TAG: tag, P1: no } }, d.space.map);
    out.terminals++;
  }
  return out;
}

/** Devices grouped by full designation: Map fullTag → {tag, coils, contacts, others}. Untagged symbols are left out. */
export function devicesByTag(model) {
  const out = new Map();
  for (const d of model.devices) {
    if (!d.fullTag) continue;
    let g = out.get(d.fullTag);
    if (!g) out.set(d.fullTag, (g = { fullTag: d.fullTag, tag: d.tag, coils: [], contacts: [], others: [] }));
    (d.role === 'coil' ? g.coils : d.role === 'contact' ? g.contacts : g.others).push(d);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ cross-references

/** The pin pairs of a contact: "13-14"; a changeover "11-12-14"; a three-pole one gives three lines. */
export function contactLines(d) {
  const labels = d.pins.map((p) => p.label || p.tag);
  const kind = d.kind === 'nc' ? t('xref.nc') : d.kind === 'co' ? t('xref.co') : t('xref.no');
  if (d.kind === 'co' || labels.length <= 2) return [{ kind, pins: labels.join('-') }];
  const out = [];
  for (let i = 0; i + 1 < labels.length; i += 2) out.push({ kind, pins: labels[i] + '-' + labels[i + 1] });
  return out;
}

/** What every coil and contact should say. → Map device uid → {ATTR: value}. */
export function xrefValues(model) {
  const want = new Map();
  for (const g of devicesByTag(model).values()) {
    const coil = [...g.coils].sort(placeOrder)[0] || null;
    const contacts = [...g.contacts].sort(placeOrder);
    for (const c of contacts) want.set(c.uid, { XREF: coil ? '/' + coil.place : '' });
    for (const k of g.coils) {
      const lines = contacts.flatMap((c) => contactLines(c).map((l) => l.kind + ' ' + l.pins + ' /' + c.place));
      const vals = {};
      for (let i = 1; i <= XREF_LINES; i++) vals['XREF' + i] = '';
      if (lines.length > XREF_LINES) { lines.splice(XREF_LINES - 1, lines.length, t('xref.more', { n: lines.length - XREF_LINES + 1 })); }
      lines.forEach((s, i) => { vals['XREF' + (i + 1)] = s; });
      if (k !== coil) for (let i = 1; i <= XREF_LINES; i++) vals['XREF' + i] = i === 1 ? t('xref.dup', { place: coil.place }) : '';
      want.set(k.uid, vals);
    }
  }
  // contacts and coils with no tag: clear what they say
  for (const d of model.devices) {
    if (want.has(d.uid)) continue;
    if (d.role === 'contact') want.set(d.uid, { XREF: '' });
    if (d.role === 'coil') { const v = {}; for (let i = 1; i <= XREF_LINES; i++) v['XREF' + i] = ''; want.set(d.uid, v); }
  }
  return want;
}

/** Write the cross-references (inside a change). Only references whose text changed are touched. → changed count. */
export function updateXrefs(doc, model) {
  const want = xrefValues(model);
  let changed = 0;
  for (const d of model.devices) {
    const v = want.get(d.uid);
    if (!v) continue;
    const a = d.e.attrs || {};
    if (Object.entries(v).every(([k, x]) => String(a[k] ?? '') === x)) continue;
    doc.update(d.id, { ...d.e, attrs: { ...a, ...v } }, d.space.map);
    changed++;
  }
  return changed;
}

/** For lists and Properties: a contact's coil, a coil's contacts. */
export function relatedOf(model, d) {
  const g = d.fullTag ? devicesByTag(model).get(d.fullTag) : null;
  if (!g) return { coil: null, contacts: [] };
  return { coil: [...g.coils].sort(placeOrder)[0] || null, contacts: [...g.contacts].sort(placeOrder), others: g.others };
}

export { cmpNumber };
