/* SPDX-License-Identifier: Apache-2.0 */
/**
 * panel.js — the panel schedule (0.4 part 2, E.9): a board's circuits with breaker, phase, load, current and cable
 * length, the load on each phase and how unbalanced they are; and a phase balancer. DOM-free.
 *
 * Phases: a circuit's PHASE is L1, L2 or L3 (single phase), "L1L2"-style (two phases, load split over both) or 3P /
 * L1L2L3 (three phase, load split over all three). Unbalance = (heaviest − lightest) / mean phase load.
 */

import { t } from './text.js';
import { currentOf } from './install.js';

export const PHASES = ['L1', 'L2', 'L3'];
const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/** Which phases a PHASE value loads: ['L1'], ['L1','L2'], ['L1','L2','L3']; unknown → ['L1']. */
export function phasesOf(v) {
  const s = String(v || '').toUpperCase().replace(/\s+/g, '');
  if (/^(3P|3|L1L2L3|RST|ABC)$/.test(s)) return PHASES.slice();
  const got = PHASES.filter((p) => s.includes(p));
  return got.length ? got : ['L1'];
}

/** Watts on each phase from a set of circuits. → {L1, L2, L3, unbalance (0…), total}. */
export function phaseLoads(circuits) {
  const out = { L1: 0, L2: 0, L3: 0 };
  for (const c of circuits) { const ps = phasesOf(c.phase); for (const p of ps) out[p] += c.watts / ps.length; }
  const vals = PHASES.map((p) => out[p]), total = vals.reduce((a, b) => a + b, 0), mean = total / 3;
  return { ...out, total, unbalance: mean > 0 ? (Math.max(...vals) - Math.min(...vals)) / mean : 0 };
}

/** The circuits of a board (null = circuits on no board). */
export function boardCircuits(inst, board) {
  return [...inst.circuits.values()].filter((c) => (board ? c.board === board : !c.board)).sort((a, b) => natural(a.name, b.name));
}

/**
 * Schedule rows for a board. lengths = cableLengths() result. → {title, columns, rows, phases, board}
 */
export function panelSchedule(inst, board, lengths = new Map()) {
  const list = boardCircuits(inst, board);
  const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '');
  const columns = [
    { key: 'circuit', label: t('col.circuit') }, { key: 'desc', label: t('col.desc') }, { key: 'breaker', label: t('col.breaker') },
    { key: 'phase', label: t('col.phase') }, { key: 'load', label: t('col.load') }, { key: 'current', label: t('col.current') },
    { key: 'cable', label: t('col.cable.type') }, { key: 'length', label: t('col.length') }, { key: 'devices', label: t('col.devices') },
  ];
  const rows = list.map((c) => {
    const len = lengths.get(c.name);
    return { circuit: c.name, desc: c.desc, breaker: c.breaker ? fmt(c.breaker) + ' A' + (c.curve ? ' ' + c.curve : '') : '', phase: c.phase,
      load: fmt(c.watts) + ' W', current: fmt(currentOf(c), 1) + ' A', cable: c.cable, length: len && len.routed ? fmt(len.metres, 1) + ' m' : '', devices: String(c.loads.length) };
  });
  const ph = phaseLoads(list);
  rows.push({ circuit: t('panel.total'), desc: '', breaker: '', phase: '', load: fmt(ph.total) + ' W', current: '', cable: '', length: '', devices: String(list.reduce((a, c) => a + c.loads.length, 0)) });
  for (const p of PHASES) rows.push({ circuit: p, desc: '', breaker: '', phase: '', load: fmt(ph[p]) + ' W', current: '', cable: '', length: '', devices: '' });
  rows.push({ circuit: t('panel.unbalance'), desc: '', breaker: '', phase: '', load: fmt(ph.unbalance * 100, 0) + ' %', current: '', cable: '', length: '', devices: '' });
  return { title: t('report.panel', { board: board?.tag || t('panel.noboard') }), columns, rows, phases: ph, board };
}

/**
 * Spread a board's single-phase circuits over L1–L3, heaviest first onto the lightest phase (two- and three-phase
 * circuits stay where they are and count). keep = circuit names not to move. → Map circuit name → new phase.
 */
export function balancePhases(circuits, { keep = new Set() } = {}) {
  const load = { L1: 0, L2: 0, L3: 0 };
  const movable = [];
  for (const c of circuits) {
    const ps = phasesOf(c.phase);
    if (ps.length > 1 || keep.has(c.name) || !c.def) { for (const p of ps) load[p] += c.watts / ps.length; continue; }
    movable.push(c);
  }
  movable.sort((a, b) => b.watts - a.watts || natural(a.name, b.name));
  const out = new Map();
  for (const c of movable) {
    const p = PHASES.reduce((best, x) => (load[x] < load[best] - 1e-9 ? x : best), 'L1');
    load[p] += c.watts;
    out.set(c.name, p);
  }
  return out;
}

/** Write new phases onto the circuits' EL_CIRCUIT labels (inside a change). → changed count. */
export function applyPhases(doc, inst, phases) {
  let n = 0;
  for (const [name, p] of phases) {
    const c = inst.circuits.get(name);
    if (!c?.def || String(c.def.e.attrs?.PHASE || '').toUpperCase() === p) continue;
    doc.update(c.def.id, { ...c.def.e, attrs: { ...c.def.e.attrs, PHASE: p } }, c.def.space.map);
    n++;
  }
  return n;
}
