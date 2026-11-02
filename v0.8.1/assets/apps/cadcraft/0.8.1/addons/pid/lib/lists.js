/* SPDX-License-Identifier: Apache-2.0 */
/**
 * lists.js — the lists made from a P&ID (0.7 LC.5): line list, equipment list, instrument index, valve list. Each is
 * { name, columns: [text], rows: [[text]] } of plain strings, so a table on a sheet, a CSV and a spreadsheet say the same.
 * DOM-free (tested in Node). The words come from the language file through t().
 *
 *   lineList(model)          one row per line number: size, service, spec, insulation, from, to, branches
 *   equipmentList(model)     one row per piece of equipment: tag, type, description, service, design figures, connected lines
 *   instrumentIndex(model)   one row per instrument: tag, function read out in words, loop, where it sits, connected to
 *   valveList(model)         one row per valve and tagged in-line item: tag, type, actuator, line, description
 *   allLists(model)          [lineList, equipmentList, instrumentIndex, valveList]
 *   toCsv(list) · toSheets(lists) (for xlsx.js)
 */

import { t, csv } from './core.js';
import { linkedTo, trace } from './model.js';
import { splitTag } from './symbols.js';
import { functionOf } from './tags.js';

const byTag = (a, b) => String(a.tag || '￿').localeCompare(String(b.tag || '￿'), 'en', { numeric: true, sensitivity: 'base' });
const dash = (s) => (s === undefined || s === null || s === '' ? '' : String(s));

/** The process-line numbers touching a symbol's connections (and, one hop through signal lines, what a signal reaches). */
function linesAt(model, s) {
  const out = new Set();
  for (const c of s.conns) for (const j of linkedTo(model, s.uid, c.n)) {
    const o = model.byUid.get(j.uid);
    if (o && j.kind === 'line' && o.style === 'process') out.add(o.ln || '—');
  }
  return [...out];
}
/** Through the signal lines on an instrument: the tags and process lines at their other ends. */
function signalTargets(model, s) {
  const out = new Set();
  for (const c of s.conns) for (const j of linkedTo(model, s.uid, c.n)) {
    const o = model.byUid.get(j.uid);
    if (!o || j.kind !== 'line' || o.style === 'process') continue;
    const other = j.at === 'end0' ? 'end1' : 'end0';
    for (const k of linkedTo(model, o.uid, other)) {
      const p = model.byUid.get(k.uid);
      if (!p || p.uid === s.uid) continue;
      if (k.kind === 'sym') out.add(p.tag || '#' + p.sym);
      else if (p.style === 'process') out.add(p.ln || '—');
    }
  }
  return [...out];
}

export function lineList(model) {
  const columns = ['line', 'size', 'svc', 'spec', 'insul', 'from', 'to', 'branches'].map((k) => t('list.line.' + k));
  const groups = new Map();
  for (const l of model.lines) {
    if (l.style !== 'process') continue;
    const key = l.ln || '\u0000' + l.uid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const rows = [];
  for (const [key, ls] of groups) {
    const first = ls[0].data;
    // the ends of this number: those whose way does not lead through another piece of the same number (the pieces between
    // valves and in-line items are one line)
    const outer = [];
    for (const l of ls) l.ends.forEach((_, i) => { const r = trace(model, l, i); if (!r.same) outer.push(r); });
    const words = (r) => [...r.terminals, ...(r.open && !r.terminals.length && !r.branches.length ? [t('list.open')] : [])].join('; ');
    const ends = outer;
    const branches = new Set(ends.flatMap((r) => r.branches));
    for (const l of ls) for (const k of [l.uid + '#mid']) for (const j of model.links.get(k) || []) { const o = model.byUid.get(j.uid); if (o && o.style === 'process' && o.ln !== l.ln) branches.add(o.ln || '—'); }
    rows.push([key[0] === '\u0000' ? t('list.unnumbered') : key, dash(first.size), dash(first.svc), dash(first.spec), dash(first.insul),
      ends[0] ? words(ends[0]) : '', ends[1] ? words(ends[ends.length - 1]) : '', [...branches].join('; ')]);
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true, sensitivity: 'base' }));
  return { name: t('list.line'), columns, rows };
}

export function equipmentList(model) {
  const columns = ['tag', 'type', 'desc', 'svc', 'dp', 'dt', 'cap', 'mat', 'nozzles', 'lines', 'notes'].map((k) => t('list.equip.' + k));
  const rows = model.symbols.filter((s) => s.group === 'equip').sort(byTag).map((s) => {
    const used = s.conns.filter((c) => linkedTo(model, s.uid, c.n).length).length;
    return [dash(s.tag), t('sym.' + s.sym), dash(s.desc), dash(s.attrs.svc), dash(s.attrs.dp), dash(s.attrs.dt), dash(s.attrs.cap), dash(s.attrs.mat),
      s.conns.length ? used + '/' + s.conns.length : '', linesAt(model, s).join('; '), dash(s.attrs.notes)];
  });
  return { name: t('list.equip'), columns, rows };
}

/** "Flow: indicate, control" — a tag's letters in words. */
export function functionText(fn) {
  const f = functionOf(fn);
  if (!f) return '';
  const what = f.modifiers.map((m) => t('isa.later.' + m.toLowerCase()));
  return t('isa.first.' + f.variable.toLowerCase()) + (what.length ? ': ' + what.join(', ') : '');
}

export function instrumentIndex(model) {
  const columns = ['tag', 'function', 'loop', 'where', 'svc', 'desc', 'to'].map((k) => t('list.inst.' + k));
  const rows = model.symbols.filter((s) => s.group === 'inst').sort(byTag).map((s) => {
    const { fn, num } = splitTag(s.tag);
    return [dash(s.tag), functionText(fn), num, t('sym.' + s.sym), dash(s.attrs.svc), dash(s.desc), [...signalTargets(model, s), ...linesAt(model, s)].join('; ')];
  });
  return { name: t('list.inst'), columns, rows };
}

export function valveList(model) {
  const columns = ['tag', 'type', 'act', 'line', 'svc', 'desc', 'notes'].map((k) => t('list.valve.' + k));
  const items = model.symbols.filter((s) => s.group === 'valve' || (s.group === 'line' && s.tag));
  const rows = items.sort(byTag).map((s) => [dash(s.tag), t('sym.' + s.sym), s.group === 'valve' && s.act !== 'none' ? t('act.' + s.act) : '', linesAt(model, s).join('; '), dash(s.attrs.svc), dash(s.desc), dash(s.attrs.notes)]);
  return { name: t('list.valve'), columns, rows };
}

export const allLists = (model) => [lineList(model), equipmentList(model), instrumentIndex(model), valveList(model)];

export const toCsv = (list) => csv([list.columns, ...list.rows]);
/** All lists as one CSV: each under its name, a blank row between. */
export const toCsvAll = (lists) => csv(lists.flatMap((l, i) => [...(i ? [[]] : []), [l.name], l.columns, ...l.rows]));
/** Sheets for xlsx.js writeXlsx: a bold header row, frozen; every cell text. */
export function toSheets(lists) {
  return lists.map((l) => ({
    name: l.name,
    cols: l.columns.map((c, j) => Math.min(48, Math.max(8, String(c).length + 2, ...l.rows.map((r) => String(r[j] ?? '').length + 2)))),
    rows: [l.columns.map((c) => ({ v: c, s: 'head' })), ...l.rows.map((r) => r.map((v) => (v === '' ? null : String(v))))],
    freeze: 1,
  }));
}
