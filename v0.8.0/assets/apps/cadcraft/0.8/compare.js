/* SPDX-License-Identifier: Apache-2.0 */
/**
 * compare.js — compare settings (0.5 WL.12): two drawings, or two styles in one drawing, side by side — dimension styles,
 * text styles, layers, sheets (page setup) and units — with what differs marked and a value copied across in one undo
 * step of the drawing it lands in. DOM-free (compare-ui.js is the dialog).
 *
 *   COMPARE_CATS                          'dimstyle' | 'textstyle' | 'layer' | 'sheet' | 'units'
 *   itemsOf(doc, cat) → [names]           dimension styles also offer '*CURRENT' (the settings new dimensions take)
 *   compareItems(cat, docA, itemA, docB, itemB) → [{ key, a, b, same }]   every property either side has, in a fixed order
 *   copyValue(doc, cat, item, key, value) → true when something changed (one undo step: "COMPARE")
 *   valueText(cat, key, v) → a short text for a value (numbers rounded, yes/no, colours, papers)
 */
import { DIM_DEFAULTS } from './dims.js';
import { DIM_EXTRA } from './dimstyle.js';

export const COMPARE_CATS = ['dimstyle', 'textstyle', 'layer', 'sheet', 'units'];
const LAYER_KEYS = ['color', 'linetype', 'lineweight', 'tr', 'on', 'frozen', 'locked', 'plot', 'newVpFrozen'];
const TEXT_KEYS = ['font', 'h', 'wf', 'obl'];
const UNIT_KEYS = ['units', 'lunits', 'luprec', 'ltscale', 'insbase'];
const SHEET_KEYS = ['paper', 'size', 'unit', 'orientation', 'origin'];
const DIM_KEYS = [...Object.keys(DIM_DEFAULTS), ...Object.keys(DIM_EXTRA)];

export function itemsOf(doc, cat) {
  switch (cat) {
    case 'dimstyle': return ['*CURRENT', ...doc.dimStyles.keys()];
    case 'textstyle': return doc.textStyles.size ? [...doc.textStyles.keys()] : [];
    case 'layer': return [...doc.layers.keys()].sort((a, b) => (a === '0' ? -1 : b === '0' ? 1 : a.localeCompare(b, undefined, { numeric: true })));
    case 'sheet': return doc.layouts.map((l) => l.name);
    case 'units': return ['*DRAWING'];
    default: return [];
  }
}

/** One item's properties as { key: value } (undefined = the item doesn't have it). */
function propsOf(doc, cat, item) {
  if (!doc) return null;
  switch (cat) {
    case 'dimstyle': {
      const st = item === '*CURRENT' ? doc.current.dim : doc.dimStyles.get(item);
      return st ? { ...DIM_DEFAULTS, ...DIM_EXTRA, ...st } : null;
    }
    case 'textstyle': { const s = doc.textStyles.get(item); return s ? { ...s } : null; }
    case 'layer': { const l = doc.layers.get(item); return l ? Object.fromEntries(LAYER_KEYS.map((k) => [k, k === 'newVpFrozen' || k === 'frozen' || k === 'locked' ? !!l[k] : l[k]])) : null; }
    case 'sheet': {
      const l = doc.layouts.find((x) => x.name === item);
      if (!l) return null;
      const p = l.paper || {};
      return { paper: p.key || '', size: [p.w, p.h], unit: p.unit, orientation: p.w >= p.h ? 'landscape' : 'portrait', origin: [p.x0 || 0, p.y0 || 0] };
    }
    case 'units': { const m = doc.meta || {}; return { units: m.units || '', lunits: m.lunits ?? 2, luprec: m.luprec ?? 4, ltscale: m.ltscale ?? 1, insbase: m.insbase ? [m.insbase.x ?? m.insbase[0] ?? 0, m.insbase.y ?? m.insbase[1] ?? 0] : [0, 0] }; }
    default: return null;
  }
}

const keysOf = (cat) => ({ dimstyle: DIM_KEYS, textstyle: TEXT_KEYS, layer: LAYER_KEYS, sheet: SHEET_KEYS, units: UNIT_KEYS }[cat] || []);
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));

export function compareItems(cat, docA, itemA, docB, itemB) {
  const A = propsOf(docA, cat, itemA), B = propsOf(docB, cat, itemB);
  return keysOf(cat).filter((k) => (A && A[k] !== undefined) || (B && B[k] !== undefined))
    .map((k) => ({ key: k, a: A ? A[k] : undefined, b: B ? B[k] : undefined, same: !!A && !!B && same(A[k], B[k]) }));
}

/** Copy one value onto an item of `doc` (the item is made when it isn't there: a layer, a style). → changed? */
export function copyValue(doc, cat, item, key, value) {
  const before = propsOf(doc, cat, item);
  if (before && same(before[key], value)) return false;
  let changed = false;
  doc.change('COMPARE', () => {
    switch (cat) {
      case 'dimstyle':
        if (item === '*CURRENT') { doc.current.dim = { ...doc.current.dim, [key]: value }; changed = true; return; }   // settings for new dimensions: not an edit of the drawing
        doc.setStyle('dimStyles', item, { ...(doc.dimStyles.get(item) || {}), [key]: value }); changed = true; return;
      case 'textstyle': doc.setStyle('textStyles', item, { font: '', h: 0, wf: 1, obl: 0, ...(doc.textStyles.get(item) || {}), [key]: value }); changed = true; return;
      case 'layer': {
        const st = doc.layerState();
        let l = st.list.find((x) => x.name === item);
        if (!l) { l = { name: item, color: 7, on: true, frozen: false, locked: false, plot: true, linetype: 'Continuous', lineweight: -3 }; st.list.push(l); }
        if (key === 'newVpFrozen') { if (value) l.newVpFrozen = true; else delete l.newVpFrozen; } else l[key] = value;
        doc.setLayerState(st); changed = true; return;
      }
      case 'sheet': {
        const at = doc.layouts.findIndex((x) => x.name === item);
        if (at < 0) return;
        const p = { ...doc.layouts[at].paper };
        if (key === 'paper') p.key = value;
        else if (key === 'size' && Array.isArray(value)) { p.w = value[0]; p.h = value[1]; }
        else if (key === 'unit') p.unit = value;
        else if (key === 'orientation') { if ((value === 'landscape') !== (p.w >= p.h)) [p.w, p.h] = [p.h, p.w]; }
        else if (key === 'origin' && Array.isArray(value)) { p.x0 = value[0]; p.y0 = value[1]; }
        doc.setLayouts(doc.layouts.map((l, i) => (i === at ? { ...l, paper: p } : l)));
        changed = true; return;
      }
      case 'units': doc.setMeta({ [key]: key === 'insbase' && Array.isArray(value) ? { x: value[0], y: value[1] } : value }); changed = true; return;
      default:
    }
  });
  if (cat === 'layer') doc.emitLayers?.();
  return changed;
}

export function valueText(cat, key, v) {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'number') return String(+v.toFixed(6));
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? +x.toFixed(4) : x)).join(cat === 'sheet' && key === 'size' ? ' × ' : ', ');
  return String(v);
}
