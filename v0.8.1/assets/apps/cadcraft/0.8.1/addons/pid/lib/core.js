/* SPDX-License-Identifier: Apache-2.0 */
/**
 * core.js — what the P&ID add-on needs from the common ground: words, units, numbers, paths, CSV and a table drawn as
 * entities. DOM-free (tested in Node). A small own copy of what Piping's mep-core.js has (an add-on may not import another
 * add-on); the unit rules are the same, so a P&ID and a piping plan in one drawing agree on what a "300 mm" symbol is.
 *
 *   words    setT(fn) · t(key, vars) · lookupFrom(strings)
 *   units    sizeUnitOf(doc) 'in'|'mm' · perUnit(doc, 'in'|'mm')
 *   numbers  fmtNum(v, dp)
 *   paths    pathLength(pts) · nearestOnPath(pts, p) → {x, y, s, dist, seg} · pointAtLongest(pts)
 *   files    csv(rows) — RFC 4180, CRLF, a cell starting with = + - @ gets a leading ' (it is text in a spreadsheet)
 *   drawing  drawTable(title, rows, h)
 */

import { advance } from '../../../font.js';

let impl = null;
export function setT(fn) { impl = typeof fn === 'function' ? fn : null; }
export function t(key, vars = {}) { return impl ? impl(key, vars) : key; }
export function lookupFrom(strings) {
  return (key, vars = {}) => {
    let s = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
    if (s && typeof s === 'object') s = (vars.n !== undefined && s['=' + vars.n]) || (Number(vars.n) === 1 && s.one) || s.other || key;
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
  };
}

const UNIT_M = { '': 0.001, inches: 0.0254, feet: 0.3048, millimeters: 0.001, centimeters: 0.01, meters: 1, yards: 0.9144 };
const mPerUnitOf = (doc) => UNIT_M[String(doc?.meta?.units || '')] ?? 0.001;
function systemOf(doc) {
  const u = String(doc?.meta?.units || '').toLowerCase();
  if (u === 'inches' || u === 'feet' || u === 'yards') return 'imperial';
  if (!u && [3, 4, 5].includes(doc?.meta?.lunits)) return 'imperial';
  return 'metric';
}
export const sizeUnitOf = (doc) => (systemOf(doc) === 'imperial' ? 'in' : 'mm');
export const perUnit = (doc, u) => mPerUnitOf(doc) / (u === 'in' ? 0.0254 : 0.001);

export function fmtNum(v, dp = 2) {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(dp);
  return dp > 0 ? s.replace(/\.?0+$/, '') : s;
}

export function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}
/** The point of a path nearest to p ({x, y}): { x, y, s (distance along), dist, seg } | null. */
export function nearestOnPath(pts, p) {
  let best = null, run = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    const u = L2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L2)) : 0;
    const x = ax + u * dx, y = ay + u * dy, dist = Math.hypot(p.x - x, p.y - y);
    if (!best || dist < best.dist) best = { x, y, s: run + u * L, dist, seg: i - 1 };
    run += L;
  }
  return best;
}
/** The middle of the longest segment and its direction: { x, y, ang, len } | null (where a line's number is written). */
export function pointAtLongest(pts) {
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = Math.hypot(bx - ax, by - ay);
    if (len > 0 && (!best || len > best.len)) best = { x: (ax + bx) / 2, y: (ay + by) / 2, ang: Math.atan2(by - ay, bx - ax), len };
  }
  return best;
}
/** An angle turned to read left to right (never upside down). */
export function readable(a) {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r > Math.PI / 2 + 1e-9 || r < -Math.PI / 2 + 1e-9 ? r + Math.PI : r;
}

export function csv(rows) {
  const q = (v) => {
    let s = v === null || v === undefined ? '' : typeof v === 'number' ? fmtNum(v, 4) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !(typeof v === 'number')) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

export const textWidth = (s, h) => (advance(String(s)) / 1000) * (h / 0.718);
const line = (a, b) => ({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });

/** A table as entities, its top-left corner at (0, 0): a title, then rows (the first is the header). h = text height. */
export function drawTable(title, rows, h) {
  const pad = h * 0.6, rowH = h * 2, out = [];
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, j) => Math.max(...rows.map((r) => textWidth(r[j] ?? '', h))) + 2 * pad);
  const W = widths.reduce((a, b) => a + b, 0);
  out.push({ type: 'text', x: 0, y: rowH * 0.3, h: h * 1.25, rot: 0, s: String(title), ha: 'left', va: 'bottom' });
  let y = 0;
  out.push(line({ x: 0, y: 0 }, { x: W, y: 0 }));
  rows.forEach((r) => {
    let x = 0;
    for (let j = 0; j < cols; j++) {
      const s = String(r[j] ?? '');
      if (s) out.push({ type: 'text', x: x + pad, y: y - rowH / 2, h, rot: 0, s, ha: 'left', va: 'middle' });
      x += widths[j];
    }
    y -= rowH;
    out.push(line({ x: 0, y }, { x: W, y }));
  });
  let x = 0;
  for (let j = 0; j <= cols; j++) { out.push(line({ x, y: 0 }, { x, y })); x += widths[j] || 0; }
  return out;
}
