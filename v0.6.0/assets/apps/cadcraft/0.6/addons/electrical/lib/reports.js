/* SPDX-License-Identifier: Apache-2.0 */
/**
 * reports.js — lists made from the schematic (0.4 part 2: E.5 sheet list, E.6 terminal plans and cable lists, E.7 parts
 * list), each as {columns, rows} that become a table on new sheets (`addReportSheets`) or a CSV (`toCsv`). DOM-free.
 *
 *   sheetList(model)                    every sheet: number, title, plant, location, revision, date
 *   terminalPlan(model)                 every terminal by strip: number, wire number, what its top and bottom connect to
 *   cableList(model)                    every core of every cable marker (EL_CABLE across the wires it carries)
 *   partsList(model)                    one row per maker + part number, with the devices that use it and how many
 * Rows are plain strings, so a table and a CSV say the same; a CSV cell starting with = + - @ gets a leading ' (it is
 * text, never a formula, in a spreadsheet).
 */

import { t } from './text.js';
import { netlist, wirenoNets, segDist2 } from './wires.js';
import { devicesByTag } from './devices.js';
import { cmpNumber, placeOrder } from './model.js';
import { addSheet, FRAMES } from './project.js';
import { symbol } from './symbols.js';

const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const pinName = (p) => (p.device.tag || '?') + ':' + (p.device.role === 'terminal' ? String(p.device.attrs.P1 || '').trim() || p.tag : p.label || p.tag);

// ------------------------------------------------------------------------------------------------ E.5 sheet list

export function sheetList(model) {
  const columns = [
    { key: 'sheet', label: t('col.sheet') }, { key: 'title', label: t('col.title') }, { key: 'plant', label: t('col.plant') },
    { key: 'loc', label: t('col.loc') }, { key: 'rev', label: t('col.rev') }, { key: 'date', label: t('col.date') },
  ];
  const rows = model.sheets.map((s) => ({ sheet: s.number, title: s.title || s.space.name, plant: s.plant, loc: s.loc, rev: String(s.attrs.REV || ''), date: String(s.attrs.DATE || '') }));
  return { title: t('report.sheets'), columns, rows };
}

// ------------------------------------------------------------------------------------------------ E.6 terminals and cables

/** Pins a terminal pin reaches without going through the terminal itself. */
function sideTargets(sides, d, tag) {
  const net = sides.netOfPin.get(d.uid + '|' + tag);
  if (!net) return [];
  return net.pins.filter((p) => p.device !== d).sort((a, b) => placeOrder(a.device, b.device)).map(pinName);
}

export function terminalPlan(model, nl = netlist(model)) {
  const sides = netlist(model, { joinTerminals: false });
  const owners = wirenoNets(model, nl);
  const numberOf = (net) => [...new Set(model.wirenos.filter((w) => owners.get(w.uid) === net && w.value).map((w) => w.value))].join(', ');
  const columns = [
    { key: 'strip', label: t('col.strip') }, { key: 'no', label: t('col.terminal') }, { key: 'wire', label: t('col.wire') },
    { key: 'top', label: t('col.top') }, { key: 'bottom', label: t('col.bottom') }, { key: 'place', label: t('col.place') },
  ];
  const terms = model.devices.filter((d) => d.role === 'terminal');
  terms.sort((a, b) => natural(a.fullTag, b.fullTag) || natural(a.attrs.P1 || '', b.attrs.P1 || '') || placeOrder(a, b));
  const rows = terms.map((d) => {
    const top = d.pins[0], bottom = d.pins[1] || d.pins[0];
    const net = nl.netOfPin.get(d.uid + '|' + top.tag);
    return { strip: d.fullTag || t('report.untagged'), no: String(d.attrs.P1 || ''), wire: net ? numberOf(net) : '', top: sideTargets(sides, d, top.tag).join(', '), bottom: sideTargets(sides, d, bottom.tag).join(', '), place: d.place };
  });
  return { title: t('report.terminals'), columns, rows };
}

/** Does segment ab cross segment cd (touching counts)? */
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (p, q, r) => segDist2(r, p, q).d2 < 1e-12;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

/** The wires a cable marker's slash crosses, in order along the slash. → [wire]. */
export function cableCores(model, cable) {
  const out = [];
  for (const w of model.wires) {
    if (w.space.key !== cable.space.key) continue;
    for (let i = 0; i + 1 < w.pts.length; i++) {
      if (crosses(cable.a, cable.b, w.pts[i], w.pts[i + 1])) {
        // where along the slash
        const r = segDist2(w.pts[i], cable.a, cable.b);
        out.push({ w, u: r.u });
        break;
      }
    }
  }
  return out.sort((x, y) => x.u - y.u).map((x) => x.w);
}

export function cableList(model, nl = netlist(model)) {
  const sides = netlist(model, { joinTerminals: false });
  const owners = wirenoNets(model, nl);
  const numberOf = (net) => [...new Set(model.wirenos.filter((w) => owners.get(w.uid) === net && w.value).map((w) => w.value))].join(', ');
  const columns = [
    { key: 'cable', label: t('col.cable') }, { key: 'type', label: t('col.type') }, { key: 'core', label: t('col.core') },
    { key: 'wire', label: t('col.wire') }, { key: 'from', label: t('col.from') }, { key: 'to', label: t('col.to') },
    { key: 'length', label: t('col.length') }, { key: 'place', label: t('col.place') },
  ];
  const rows = [];
  const cables = [...model.cables].sort((a, b) => natural(a.tag, b.tag) || placeOrder(a, b));
  for (const c of cables) {
    const cores = cableCores(model, c);
    if (!cores.length) rows.push({ cable: c.tag || t('report.untagged'), type: String(c.attrs.TYPE || ''), core: '', wire: '', from: '', to: '', length: String(c.attrs.LENGTH || ''), place: c.place });
    cores.forEach((w, i) => {
      const net = nl.netOfWire.get(w.uid), side = sides.netOfWire.get(w.uid);
      const ends = (side?.pins || []).slice().sort((a, b) => placeOrder(a.device, b.device));
      rows.push({ cable: c.tag || t('report.untagged'), type: String(c.attrs.TYPE || ''), core: String(i + 1), wire: net ? numberOf(net) : '',
        from: ends[0] ? pinName(ends[0]) : '', to: ends.slice(1).map(pinName).join(', '), length: String(c.attrs.LENGTH || ''), place: c.place });
    });
  }
  return { title: t('report.cables'), columns, rows, cables: cables.map((c) => ({ cable: c, cores: cableCores(model, c) })) };
}

// ------------------------------------------------------------------------------------------------ E.7 parts list

export function partsList(model) {
  const columns = [
    { key: 'qty', label: t('col.qty') }, { key: 'tags', label: t('col.tags') }, { key: 'desc', label: t('col.desc') },
    { key: 'mfr', label: t('col.mfr') }, { key: 'part', label: t('col.part') }, { key: 'order', label: t('col.order') },
  ];
  const groups = new Map();
  const add = (key, tag, src) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tags: [], src }));
    g.tags.push(tag);
  };
  const val = (d, k) => String(d.attrs[k] || '').trim();
  for (const dev of devicesByTag(model).values()) {
    // the part that carries the data: a coil, else a device, else a contact (the first one that has a maker or part)
    const parts = [...dev.coils, ...dev.others, ...dev.contacts];
    const src = parts.find((d) => val(d, 'MFR') || val(d, 'PART')) || parts.find((d) => d.role !== 'contact') || null;
    if (!src) continue;   // contacts alone: their coil is missing (checks.js says so)
    if (src.role === 'terminal') continue;   // terminals: below, one per terminal
    const key = [val(src, 'MFR'), val(src, 'PART'), val(src, 'ORDER'), val(src, 'MFR') || val(src, 'PART') ? '' : src.sym].join('\u0001');
    add(key, dev.tag, src);
  }
  for (const d of model.devices.filter((x) => x.role === 'terminal')) {
    const key = ['T', val(d, 'MFR'), val(d, 'PART'), val(d, 'ORDER'), d.fullTag].join('\u0001');
    add(key, (d.tag || '?') + ':' + val(d, 'P1'), d);
  }
  const rows = [...groups.values()].map((g) => ({
    qty: String(g.tags.length), tags: g.tags.sort(natural).join(', '), desc: val(g.src, 'DESC') || t('sym.' + g.src.sym),
    mfr: val(g.src, 'MFR'), part: val(g.src, 'PART'), order: val(g.src, 'ORDER'),
  }));
  rows.sort((a, b) => natural(a.mfr, b.mfr) || natural(a.part, b.part) || natural(a.tags, b.tags));
  return { title: t('report.parts'), columns, rows };
}

// ------------------------------------------------------------------------------------------------ output

/** A CSV of a report (CRLF; the UI adds the BOM). */
export function toCsv({ columns, rows }) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.map((c) => cell(c.label)), ...rows.map((r) => columns.map((c) => cell(r[c.key])))].map((l) => l.join(',')).join('\r\n') + '\r\n';
}

const CHAR = 0.62;   // Helvetica average character width per text height (font.js measures exactly; this only sizes columns)

/** Column widths that fit `width` (mm), each at least its heading. */
export function columnWidths(columns, rows, width, h = 2.5) {
  const want = columns.map((c) => Math.max(String(c.label).length, ...rows.map((r) => String(r[c.key] ?? '').length), 2) * h * CHAR + 2 * h * 0.6);
  const sum = want.reduce((a, b) => a + b, 0);
  if (sum <= width) return want.map((w) => w * (width / sum));
  // too wide: shrink the widest columns first; cells then cut with an ellipsis (`fit`)
  const fair = width / columns.length;
  const small = want.filter((w) => w <= fair).reduce((a, b) => a + b, 0), nBig = want.filter((w) => w > fair).length;
  const rest = (width - small) / Math.max(1, nBig);
  return want.map((w) => (w <= fair ? w : rest));
}

const fit = (s, w, h) => { s = String(s ?? ''); const n = Math.max(1, Math.floor((w - h * 1.2) / (h * CHAR))); return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…'; };

/** Table entities with its top-left corner at (x, y). → {entities, height}. */
export function tableEntities({ columns, rows }, { x = 0, y = 0, width = 380, h = 2.5, layer = 'EL-REPORT', widths } = {}) {
  const ws = widths || columnWidths(columns, rows, width, h);
  const rh = h * 2.4, out = [];
  const L = (x1, y1, x2, y2) => ({ type: 'line', layer, color: null, x1, y1, x2, y2 });
  const T = (tx, ty, s, bold) => ({ type: 'text', layer, color: null, x: tx, y: ty, h: bold ? h * 1.05 : h, rot: 0, s, ha: 'left', va: 'middle' });
  const total = ws.reduce((a, b) => a + b, 0), n = rows.length + 1;
  for (let i = 0; i <= n; i++) out.push(L(x, y - i * rh, x + total, y - i * rh));
  let cx = x;
  for (let j = 0; j <= columns.length; j++) { out.push(L(cx, y, cx, y - n * rh)); cx += ws[j] || 0; }
  cx = x;
  columns.forEach((c, j) => {
    out.push(T(cx + h * 0.6, y - rh / 2, fit(c.label, ws[j], h), true));
    rows.forEach((r, i) => { const s = fit(r[c.key], ws[j], h); if (s) out.push(T(cx + h * 0.6, y - (i + 1.5) * rh, s)); });
    cx += ws[j];
  });
  return { entities: out, height: n * rh };
}

/**
 * Put a report on new sheets (inside a change): as many A3 sheets as its rows need, each with the table under a
 * heading, titled "<report> (n of m)". values = title block values for every sheet. → [layout].
 */
export function addReportSheets(doc, report, { size = 'A3', values = {}, h = 2.5 } = {}) {
  const f = FRAMES[size] || FRAMES.A3;
  const x = 25, top = f.h - 22, bottom = 10 + 30 + 5 + 4, width = f.w - 10 - 25 - 5;
  const rh = h * 2.4;
  const per = Math.max(1, Math.floor((top - 8 - bottom) / rh) - 1);
  const pages = Math.max(1, Math.ceil(report.rows.length / per));
  const widths = columnWidths(report.columns, report.rows, width, h);
  const out = [];
  for (let p = 0; p < pages; p++) {
    const title = pages > 1 ? t('report.page', { title: report.title, n: p + 1, of: pages }) : report.title;
    const layout = addSheet(doc, { size, name: uniqueName(doc, title), values: { ...values, TITLE: title } });
    doc.add({ type: 'text', layer: 'EL-REPORT', color: null, x, y: top, h: 5, rot: 0, s: title, ha: 'left', va: 'baseline' }, layout.entities);
    const tb = tableEntities({ columns: report.columns, rows: report.rows.slice(p * per, (p + 1) * per) }, { x, y: top - 8, width, h, widths });
    for (const e of tb.entities) doc.add(e, layout.entities);
    out.push(layout);
  }
  return out;
}

function uniqueName(doc, base) {
  const names = new Set(doc.layouts.map((l) => l.name));
  let n = base.slice(0, 200), k = 2;
  while (names.has(n)) n = base.slice(0, 200) + ' (' + k++ + ')';
  return n;
}

export { cmpNumber, symbol };
