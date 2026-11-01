/* SPDX-License-Identifier: Apache-2.0 */
/**
 * linetypes.js — linetypes and lineweights (0.4 C8; owner: cad-files). DOM-free: walk.js (screen and plot), the file
 * readers and writers, and bin/test-cadcraft.mjs use it.
 *
 * Data (doc.js): a layer has `linetype` (name; 'Continuous' by default) and `lineweight` (mm; -3 = default); an object
 * may have `lt` (a linetype name, 'ByBlock'; absent = by layer), `lw` (mm, -2 = by block, -3 = default; absent = by
 * layer) and `lts` (its own linetype scale, default 1). `doc.linetypes` holds the patterns a file brought (name →
 * { name, description, pattern }); `doc.meta.ltscale` is the drawing's LTSCALE (default 1).
 *
 *   STANDARD                  the usual linetypes (inch definitions; ×25.4 in a metric drawing, as the ISO file has them)
 *   linetypeNames(doc)        every linetype the drawing can use: Continuous, the file's, the standard ones
 *   patternOf(doc, name)      → dash pattern in drawing units ([+dash, −gap, 0 dot, …]) | null (continuous / unknown)
 *   LINEWEIGHTS               the standard lineweights in mm (as AutoCAD lists them); DEFAULT_LW 0.25
 *   resolveLt(doc, e, byBlock, parentLayer) / resolveLw(…)   the object's own, its block's, or its layer's
 *   dashPrims(prims, pattern, scale)  → the dashes of geom.js primitives (L, A), or the primitives as they are when the
 *                             pattern is too fine to show (more than MAX_DASHES pieces)
 *   ltLabel(name) · lwLabel(mm)   names for menus and the history
 */
import { t } from './i18n.js';
import { hatchIsMetric } from './hatch.js';

const X = (k, p) => p.map((v) => v * k);
const base = {
  DASHED: [0.5, -0.25], HIDDEN: [0.25, -0.125], CENTER: [1.25, -0.25, 0.25, -0.25], PHANTOM: [1.25, -0.25, 0.25, -0.25, 0.25, -0.25],
  DOT: [0, -0.25], DASHDOT: [0.5, -0.25, 0, -0.25], BORDER: [0.5, -0.25, 0.5, -0.25, 0, -0.25], DIVIDE: [0.5, -0.25, 0, -0.25, 0, -0.25],
};
/** name → pattern in inches (the standard definitions; "2" = half size, "X2" = double size). */
export const STANDARD = Object.freeze(Object.fromEntries(Object.entries(base).flatMap(([n, p]) => [[n, p], [n + '2', X(0.5, p)], [n + 'X2', X(2, p)]])));
export const LINEWEIGHTS = Object.freeze([0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58, 2, 2.11]);
export const DEFAULT_LW = 0.25;
const MAX_DASHES = 20000;

const isCont = (n) => !n || /^continuous$/i.test(n);
const isByLayer = (n) => n === undefined || n === null || /^bylayer$/i.test(n);
const isByBlock = (n) => typeof n === 'string' && /^byblock$/i.test(n);

export function linetypeNames(doc) {
  const out = ['Continuous'];
  for (const n of doc?.linetypes?.keys?.() || []) if (!out.some((x) => x.toUpperCase() === n.toUpperCase())) out.push(n);
  for (const n of Object.keys(STANDARD)) if (!out.some((x) => x.toUpperCase() === n)) out.push(n);
  return out;
}

/** The dash pattern of a linetype in drawing units, or null when it draws continuous. */
export function patternOf(doc, name) {
  if (isCont(name) || isByLayer(name) || isByBlock(name)) return null;
  const own = doc?.linetypes?.get?.(name) || [...(doc?.linetypes?.values?.() || [])].find((l) => l.name.toUpperCase() === String(name).toUpperCase());
  if (own) return usable(own.pattern) ? own.pattern : null;
  const std = STANDARD[String(name).toUpperCase()];
  if (!std) return null;
  return hatchIsMetric({}, doc) ? X(25.4, std) : std;
}
const usable = (p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite) && p.reduce((s, v) => s + Math.abs(v), 0) > 1e-12 && p.some((v) => v < 0);

/** The linetype an object draws with: its own, its block's (ByBlock), or its layer's. */
export function resolveLt(doc, e, byBlock = null, parentLayer = null) {
  let n = e.lt;
  if (isByBlock(n)) n = byBlock ?? 'Continuous';
  if (isByLayer(n)) { const ln = e.layer === '0' && parentLayer ? parentLayer : e.layer; n = doc.layers.get(ln)?.linetype || 'Continuous'; }
  return n;
}
/** The lineweight an object draws with (mm; -3 = the default): its own, its block's, or its layer's. */
export function resolveLw(doc, e, byBlock = null, parentLayer = null) {
  let w = e.lw;
  if (w === -2) w = byBlock ?? -3;
  if (w === undefined || w === null || w === -1) { const ln = e.layer === '0' && parentLayer ? parentLayer : e.layer; w = doc.layers.get(ln)?.lineweight ?? -3; }
  return Number.isFinite(w) ? w : -3;
}

/** Dashes of geom.js primitives: L {x1,y1,x2,y2} and A {cx,cy,r,a0,a1,rev?}; the pattern restarts on every primitive run. */
export function dashPrims(prims, pattern, scale = 1) {
  if (!pattern || !(scale > 0)) return prims;
  const p = pattern.map((v) => v * scale);
  const period = p.reduce((s, v) => s + Math.abs(v), 0);
  if (!(period > 1e-12)) return prims;
  let total = 0;
  for (const q of prims) total += q.k === 'L' ? Math.hypot(q.x2 - q.x1, q.y2 - q.y1) : q.r * Math.abs(sweep(q));
  if (total / period * p.length > MAX_DASHES) return prims;   // too fine to see: drawn continuous
  const dot = period * 0.01;
  const out = [];
  let i = 0, left = Math.abs(p[0]);   // the pattern runs on along a polyline's pieces
  for (const q of prims) {
    const len = q.k === 'L' ? Math.hypot(q.x2 - q.x1, q.y2 - q.y1) : q.r * Math.abs(sweep(q));
    let s = 0;
    while (s < len - 1e-12) {
      const v = p[i], step = Math.min(left, len - s);
      if (v > 0) out.push(piece(q, s / len, (s + step) / len));
      else if (v === 0 && left === Math.abs(v)) out.push(piece(q, s / len, Math.min(len, s + dot) / len));
      s += step; left -= step;
      if (left <= 1e-12) { i = (i + 1) % p.length; left = Math.abs(p[i]); if (left === 0) { if (p[i] === 0 && s < len - 1e-12) out.push(piece(q, s / len, Math.min(len, s + dot) / len)); i = (i + 1) % p.length; left = Math.abs(p[i]); } }
    }
  }
  return out;
}
const sweep = (q) => { let d = q.a1 - q.a0; while (d <= 0) d += 2 * Math.PI; return d; };
/** The part [f0, f1] (fractions of its length) of one primitive. */
function piece(q, f0, f1) {
  if (q.k === 'L') return { k: 'L', x1: q.x1 + (q.x2 - q.x1) * f0, y1: q.y1 + (q.y2 - q.y1) * f0, x2: q.x1 + (q.x2 - q.x1) * f1, y2: q.y1 + (q.y2 - q.y1) * f1 };
  const sw = sweep(q);
  if (q.rev) { const b0 = q.a1 - sw * f1, b1 = q.a1 - sw * f0; return { ...q, a0: b0, a1: b1 }; }
  return { ...q, a0: q.a0 + sw * f0, a1: q.a0 + sw * f1 };
}

export const ltLabel = (n) => (isByLayer(n) ? t('lt.bylayer') : isByBlock(n) ? t('lt.byblock') : isCont(n) ? t('lt.continuous') : String(n));
export const lwLabel = (w) => (w === undefined || w === null || w === -1 ? t('lt.bylayer') : w === -2 ? t('lt.byblock') : w === -3 ? t('lw.default') : t('lw.mm', { mm: w.toFixed(2) }));
