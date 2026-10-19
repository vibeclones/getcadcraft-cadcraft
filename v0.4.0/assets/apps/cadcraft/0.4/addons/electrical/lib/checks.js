/* SPDX-License-Identifier: Apache-2.0 */
/**
 * checks.js — the Electrical checks (0.4 part 2, E.10). DOM-free. `runChecks(doc, model)` → [{code, level, message,
 * place, items: [uid…], at: {space, x, y}}], each one something a person can find (ELCHECK zooms to it):
 *   dup-tag        two coils (or two motors, lamps, PLC points …) with one full designation; two terminals with one number
 *   dup-addr       two PLC points with one address
 *   no-tag         a symbol that needs a tag has none
 *   open-end       a wire end connected to nothing
 *   through        a wire runs through a symbol's connection (the symbol is shorted)
 *   no-coil        a contact whose tag has no coil
 *   no-contact     a coil none of whose contacts is drawn (a warning, not an error)
 *   mirror-full    more contacts than the coil's mirror shows
 *   overload       a circuit drawing more current than its breaker allows (above 80 % = a warning)
 *   no-circuit     an installation device on no circuit
 *   no-breaker     a circuit with loads and no breaker rating
 *   cable-cores    a cable marker crossing more wires than its CORES
 *   wireno-orphan  a wire number on no wire
 */

import { t } from './text.js';
import { netlist, wirenoNets } from './wires.js';
import { devicesByTag, XREF_LINES, contactLines } from './devices.js';
import { installation, currentOf } from './install.js';
import { cableCores } from './reports.js';
import { placeOrder } from './model.js';
import { pathAt } from './project.js';

export const LEVELS = ['error', 'warning'];
export const OVERLOAD_WARN = 0.8;

const UNIQUE_ROLES = new Set(['coil']);
const UNIQUE_SYMS = new Set(['motor.3ph', 'motor.dc', 'lamp', 'horn', 'transformer', 'plc.input', 'plc.output']);

export function runChecks(doc, model, { nl = netlist(model), overloadWarn = OVERLOAD_WARN } = {}) {
  const out = [];
  const add = (code, level, vars, items, at) => out.push({ code, level, message: t('check.' + code, vars), items: items.map((i) => i.uid), place: vars.place || '', at: at ? { space: at.space || items[0]?.space, x: at.x, y: at.y } : items[0] ? { space: items[0].space, x: items[0].at?.x ?? 0, y: items[0].at?.y ?? 0 } : null });
  // tags
  const groups = devicesByTag(model);
  for (const g of groups.values()) {
    if (g.coils.length > 1) { const s = [...g.coils].sort(placeOrder); add('dup-tag', 'error', { tag: g.fullTag, place: s.map((d) => d.place).join(', ') }, s); }
    const bySym = new Map();
    for (const d of g.others) if (UNIQUE_SYMS.has(d.sym)) { if (!bySym.has(d.sym)) bySym.set(d.sym, []); bySym.get(d.sym).push(d); }
    for (const list of bySym.values()) if (list.length > 1) add('dup-tag', 'error', { tag: g.fullTag, place: list.map((d) => d.place).join(', ') }, list);
    if (g.contacts.length && !g.coils.length && !g.others.length) add('no-coil', 'error', { tag: g.fullTag, place: g.contacts.map((d) => d.place).join(', ') }, g.contacts);
    if (g.coils.length && !g.contacts.length) add('no-contact', 'warning', { tag: g.fullTag, place: g.coils[0].place }, g.coils);
    const lines = g.contacts.reduce((n, c) => n + contactLines(c).length, 0);
    if (g.coils.length && lines > XREF_LINES) add('mirror-full', 'warning', { tag: g.fullTag, n: lines, max: XREF_LINES, place: g.coils[0].place }, g.coils);
  }
  // terminals with one number in one strip
  const termNo = new Map();
  for (const d of model.devices.filter((x) => x.role === 'terminal' && x.fullTag)) {
    const k = d.fullTag + ':' + String(d.attrs.P1 || '').trim();
    if (!String(d.attrs.P1 || '').trim()) continue;
    if (!termNo.has(k)) termNo.set(k, []);
    termNo.get(k).push(d);
  }
  for (const [k, list] of termNo) if (list.length > 1) add('dup-tag', 'error', { tag: k, place: list.map((d) => d.place).join(', ') }, list);
  // PLC addresses
  const addr = new Map();
  for (const d of model.devices.filter((x) => x.role === 'plc')) { const a = String(d.attrs.ADDR || '').trim().toUpperCase(); if (!a) continue; if (!addr.has(a)) addr.set(a, []); addr.get(a).push(d); }
  for (const [a, list] of addr) if (list.length > 1) add('dup-addr', 'error', { addr: a, place: list.map((d) => d.place).join(', ') }, list);
  for (const d of model.devices) if (!d.tag && ['coil', 'device', 'plc', 'terminal', 'contact'].includes(d.role)) add('no-tag', d.role === 'contact' ? 'error' : 'warning', { what: t('sym.' + d.sym), place: d.place }, [d]);
  // wires
  for (const x of nl.dangling) add('open-end', 'warning', { place: placeOf(x.wire, x), wire: '' }, [x.wire], x);
  for (const x of nl.throughPins) add('through', 'error', { tag: x.device.tag || t('sym.' + x.device.sym), pin: x.tag, place: x.device.place }, [x.device, x.wire]);
  const owners = wirenoNets(model, nl);
  for (const wn of model.wirenos) if (!owners.get(wn.uid)) add('wireno-orphan', 'warning', { value: wn.value, place: wn.place }, [wn]);
  // cables
  for (const c of model.cables) {
    const want = parseInt(c.attrs.CORES, 10);
    const n = cableCores(model, c).length;
    if (Number.isFinite(want) && n > want) add('cable-cores', 'error', { tag: c.tag, n, cores: want, place: c.place }, [c]);
  }
  // installation
  const inst = installation(doc, model);
  for (const l of inst.loads) if (!l.circuit && !l.library) add('no-circuit', 'warning', { what: l.label, place: l.place || '' }, [l]);
  for (const c of inst.circuits.values()) {
    if (!c.loads.length) continue;
    const amps = currentOf(c);
    if (!c.breaker) { add('no-breaker', 'warning', { circuit: c.name, place: '' }, c.def ? [c.def] : c.loads.slice(0, 1)); continue; }
    if (amps > c.breaker) add('overload', 'error', { circuit: c.name, amps: amps.toFixed(1), breaker: c.breaker, place: '' }, c.def ? [c.def] : c.loads.slice(0, 1));
    else if (amps > c.breaker * overloadWarn) add('near-overload', 'warning', { circuit: c.name, amps: amps.toFixed(1), breaker: c.breaker, pct: Math.round(overloadWarn * 100), place: '' }, c.def ? [c.def] : c.loads.slice(0, 1));
  }
  out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  return out;
}

function placeOf(w, p) {
  const g = w.sheet.grid;
  if (!g) return w.sheet.number;
  return w.place.split('.')[0] + '.' + (pathAtSafe(g, p) || '');
}
const pathAtSafe = (g, p) => { try { return pathAt(g, p); } catch { return 0; } };
