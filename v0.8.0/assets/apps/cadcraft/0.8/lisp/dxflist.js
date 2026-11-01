/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: DXF type names, group codes and the language's own error words, not UI. */
/**
 * dxflist.js — CadCraft objects as AutoLISP's DXF lists, and back (0.4 part 2, Y.6; session cad-lisp). DOM-free.
 * The group codes are DXF's (the same ones dxf.js reads and writes); values follow entget's conventions: angles in
 * radians, points as (code x y z), entity names for -1 / -2 / 330.
 *
 * Values here are plain data, so they cross a worker boundary as they are (the LISP side turns them into lists):
 *   real → number · integer → { i: n } · string → string · point → [x, y, z] · entity name → { e: id }
 * A list is an array of [code, value] pairs.
 *
 *   toPairs(e, ctx)               → pairs          entget (ctx: { space: 'Model' | layout name, ename, handle, owner })
 *   fromPairs(pairs, old, ctx)    → entity | { error }   entmake (old null) / entmod (old = the object)
 *   matchFilter(pairs, filter)    → bool           ssget's filter list, incl. -4 "<AND" … and relational tests
 *   layerPairs / blockPairs / ltypePairs / …       tblnext / tblsearch records
 */
import { wcmatch } from './wild.js';

export const I = (n) => ({ i: n | 0 });
const P = (x, y, z = 0) => [+x || 0, +y || 0, +z || 0];
const isI = (v) => v && typeof v === 'object' && 'i' in v;
const val = (v) => (isI(v) ? v.i : v);
const TAU = Math.PI * 2;
const na = (a) => ((a % TAU) + TAU) % TAU;

/** The DXF type name of a CadCraft object. */
export function dxfType(e) {
  switch (e.type) {
    case 'line': return 'LINE';
    case 'circle': return 'CIRCLE';
    case 'arc': return 'ARC';
    case 'poly': return 'LWPOLYLINE';
    case 'ellipse': return 'ELLIPSE';
    case 'text': return e.ww || /\n/.test(e.s || '') ? 'MTEXT' : 'TEXT';
    case 'point': return 'POINT';
    case 'insert': return 'INSERT';
    case 'hatch': return 'HATCH';
    case 'dim': return 'DIMENSION';
    case 'viewport': return 'VIEWPORT';
    case 'mleader': return 'MULTILEADER';
    case 'face3d': return '3DFACE';
    default: return String(e.type || '').toUpperCase();
  }
}
const SUBCLASS = { LINE: 'AcDbLine', CIRCLE: 'AcDbCircle', ARC: 'AcDbCircle', LWPOLYLINE: 'AcDbPolyline', ELLIPSE: 'AcDbEllipse', TEXT: 'AcDbText',
  MTEXT: 'AcDbMText', POINT: 'AcDbPoint', INSERT: 'AcDbBlockReference', HATCH: 'AcDbHatch', DIMENSION: 'AcDbDimension', VIEWPORT: 'AcDbViewport', MULTILEADER: 'AcDbMLeader' };
export const objectName = (e) => (dxfType(e) === 'ARC' ? 'AcDbArc' : SUBCLASS[dxfType(e)] || 'AcDbEntity');

const HA = { left: 0, center: 1, right: 2 };
const VA = { baseline: 0, bottom: 1, middle: 2, top: 3 };
const ATTACH = (ha, va) => ({ top: 0, middle: 3, bottom: 6, baseline: 6 }[va || 'top'] ?? 0) + ({ left: 1, center: 2, right: 3 }[ha || 'left'] ?? 1);

export function toPairs(e, ctx = {}) {
  const type = dxfType(e);
  const out = [];
  if (ctx.ename !== undefined) out.push([-1, { e: ctx.ename }]);
  out.push([0, type]);
  if (ctx.owner !== undefined) out.push([330, { e: ctx.owner }]);
  if (ctx.handle) out.push([5, ctx.handle]);
  out.push([100, 'AcDbEntity']);
  if (ctx.space && ctx.space !== 'Model') out.push([67, I(1)]);
  if (ctx.space) out.push([410, ctx.space]);
  out.push([8, e.layer ?? '0']);
  if (e.lt) out.push([6, e.lt]);
  if (typeof e.color === 'number' && e.color !== 256) out.push([62, I(e.color)]);
  else if (typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color)) out.push([62, I(7)], [420, I(parseInt(e.color.slice(1), 16))]);
  if (Number.isFinite(e.lw)) out.push([370, I(e.lw < 0 ? e.lw : Math.round(e.lw * 100))]);
  if (e.lts && e.lts !== 1) out.push([48, e.lts]);
  if (SUBCLASS[type]) out.push([100, SUBCLASS[type]]);
  switch (e.type) {
    case 'line': out.push([10, P(e.x1, e.y1)], [11, P(e.x2, e.y2)], [210, [0, 0, 1]]); break;
    case 'circle': out.push([10, P(e.cx, e.cy)], [40, e.r], [210, [0, 0, 1]]); break;
    case 'arc': out.push([10, P(e.cx, e.cy)], [40, e.r], [100, 'AcDbArc'], [50, na(e.a0)], [51, na(e.a1)], [210, [0, 0, 1]]); break;
    case 'poly': {
      const pts = e.pts || [];
      out.push([90, I(pts.length)], [70, I(e.closed ? 1 : 0)], [43, Number.isFinite(e.w) ? e.w : 0], [38, 0]);
      for (const p of pts) out.push([10, [+p.x || 0, +p.y || 0]], [40, Number.isFinite(p.sw) ? p.sw : 0], [41, Number.isFinite(p.ew) ? p.ew : 0], [42, +p.b || 0], [91, I(0)]);
      out.push([210, [0, 0, 1]]);
      break;
    }
    case 'ellipse': out.push([10, P(e.cx, e.cy)], [11, P(e.mx, e.my)], [210, [0, 0, 1]], [40, e.ratio], [41, e.t0 ?? 0], [42, e.t1 ?? TAU]); break;
    case 'point': out.push([10, P(e.x, e.y)], [210, [0, 0, 1]], [50, 0]); break;
    case 'text':
      if (type === 'MTEXT') {
        out.push([10, P(e.x, e.y)], [40, e.h], [41, e.ww || 0], [71, I(ATTACH(e.ha, e.va))], [72, I(1)], [1, String(e.s ?? '').replace(/\n/g, '\\P')], [7, 'Standard'],
          [210, [0, 0, 1]], [11, [Math.cos(e.rot || 0), Math.sin(e.rot || 0), 0]], [50, na(e.rot || 0)], [73, I(1)], [44, e.ls || 1]);
      } else {
        const h = HA[e.ha] ?? 0, v = VA[e.va] ?? 0;
        out.push([10, P(e.x, e.y)], [40, e.h], [1, String(e.s ?? '')], [50, na(e.rot || 0)], [41, e.wf || 1], [51, e.obl || 0], [7, 'Standard'], [71, I(0)], [72, I(h)],
          [11, h || v ? P(e.x, e.y) : P(0, 0)], [210, [0, 0, 1]], [100, 'AcDbText'], [73, I(v)]);
      }
      break;
    case 'insert': {
      const hasAtt = e.attrs && Object.keys(e.attrs).length;
      if (hasAtt) out.push([66, I(1)]);
      out.push([2, e.block], [10, P(e.x, e.y)], [41, e.sx ?? 1], [42, e.sy ?? 1], [43, e.sz ?? (e.sx ?? 1)], [50, na(e.rot || 0)], [70, I(0)], [71, I(0)], [44, 0], [45, 0], [210, [0, 0, 1]]);
      break;
    }
    case 'hatch': {
      out.push([10, P(0, 0)], [210, [0, 0, 1]], [2, e.solid ? 'SOLID' : (e.pattern || 'ANSI31')], [70, I(e.solid ? 1 : 0)], [71, I(0)], [91, I((e.loops || []).length)]);
      for (const loop of e.loops || []) {
        const n = Math.floor(loop.length / 2);
        out.push([92, I(2)], [72, I(0)], [73, I(1)], [93, I(n)]);
        for (let k = 0; k < n; k++) out.push([10, [loop[2 * k], loop[2 * k + 1]]]);
        out.push([97, I(0)]);
      }
      out.push([75, I(1)], [76, I(1)]);
      if (!e.solid) out.push([52, e.pangle || 0], [41, e.pscale || 1]);
      break;
    }
    case 'dim': {
      const kind = { linear: 0, aligned: 1, angular: 5, diameter: 3, radius: 4 }[e.kind] ?? 0;
      if (e.block) out.push([2, e.block]);
      out.push([10, P(e.loc?.x, e.loc?.y)], [70, I(kind | 32)], [1, e.text ?? ''], [3, 'Standard']);
      if (e.p1) out.push([13, P(e.p1.x, e.p1.y)]);
      if (e.p2) out.push([14, P(e.p2.x, e.p2.y)]);
      if (e.c) out.push([15, P(e.c.x, e.c.y)]);
      if (kind <= 1) out.push([50, na(e.rot || 0)]);
      break;
    }
    case 'viewport': out.push([10, P(e.x, e.y)], [40, e.w], [41, e.h], [12, P(e.cx, e.cy)], [45, e.s ? e.h / e.s : e.h], [68, I(e.on === false ? 0 : 1)]); break;
    case 'mleader': {
      if (e.pts?.length) for (const p of e.pts) out.push([10, P(p.x, p.y)]);
      out.push([304, String(e.s ?? '')], [41, e.h || 2.5]);
      break;
    }
    default: break;
  }
  return out;
}

/** The value of a code in pairs (the first one). */
export function get(pairs, code, dflt = undefined) { for (const [c, v] of pairs) if (c === code) return val(v); return dflt; }
const getAll = (pairs, code) => pairs.filter(([c]) => c === code).map(([, v]) => val(v));
const num = (pairs, code, d = 0) => { const v = get(pairs, code); return typeof v === 'number' && Number.isFinite(v) ? v : d; };
const pt2 = (pairs, code, d = null) => { const v = get(pairs, code); return Array.isArray(v) && v.length >= 2 && v.every(Number.isFinite) ? { x: v[0], y: v[1] } : d; };

/**
 * Pairs → a CadCraft object. `old` (entmod) gives the fields not mentioned; without it (entmake) the type's required
 * codes must be there. Returns { entity } or { error } (an unsupported type, a missing point …).
 */
export function fromPairs(pairs, old = null, ctx = {}) {
  const type = String(get(pairs, 0, old ? dxfType(old) : '') || '').toUpperCase();
  if (!type) return { error: 'no entity type' };
  if (old && type !== dxfType(old) && !(type === 'TEXT' && old.type === 'text') && !(type === 'MTEXT' && old.type === 'text')) return { error: 'entity type changed' };
  const e = old ? { ...old } : {};
  const has = (code) => pairs.some(([c]) => c === code);
  // common
  if (has(8)) { const l = get(pairs, 8); if (typeof l !== 'string' || !l) return { error: 'bad layer' }; e.layer = l; }
  else if (!old) e.layer = ctx.layer ?? '0';
  if (has(420)) e.color = '#' + (get(pairs, 420) & 0xffffff).toString(16).padStart(6, '0');
  else if (has(62)) { const c = get(pairs, 62); e.color = c === 256 ? null : Math.abs(c) === 0 ? 0 : Math.min(255, Math.abs(c)); }
  else if (!old) e.color = ctx.color ?? null;
  if (has(6)) { const lt = get(pairs, 6); if (/^bylayer$/i.test(lt)) delete e.lt; else e.lt = /^continuous$/i.test(lt) ? 'Continuous' : /^byblock$/i.test(lt) ? 'ByBlock' : lt; }
  if (has(370)) { const lw = get(pairs, 370); if (lw === -1) delete e.lw; else e.lw = lw < 0 ? lw : lw / 100; }
  if (has(48)) { const s = get(pairs, 48); if (s > 0 && s !== 1) e.lts = s; else delete e.lts; }
  const need = (code) => { if (!old && !has(code)) throw new Error('missing group ' + code); };
  try {
    switch (type) {
      case 'LINE': {
        need(10); need(11);
        e.type = 'line';
        const a = pt2(pairs, 10, old && { x: old.x1, y: old.y1 }), b = pt2(pairs, 11, old && { x: old.x2, y: old.y2 });
        Object.assign(e, { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        break;
      }
      case 'CIRCLE': {
        need(10); need(40);
        e.type = 'circle';
        const c = pt2(pairs, 10, old && { x: old.cx, y: old.cy });
        Object.assign(e, { cx: c.x, cy: c.y, r: num(pairs, 40, old?.r ?? 1) });
        if (!(e.r > 0)) return { error: 'bad radius' };
        break;
      }
      case 'ARC': {
        need(10); need(40); need(50); need(51);
        e.type = 'arc';
        const c = pt2(pairs, 10, old && { x: old.cx, y: old.cy });
        Object.assign(e, { cx: c.x, cy: c.y, r: num(pairs, 40, old?.r ?? 1), a0: na(num(pairs, 50, old?.a0 ?? 0)), a1: na(num(pairs, 51, old?.a1 ?? 0)) });
        if (!(e.r > 0)) return { error: 'bad radius' };
        break;
      }
      case 'LWPOLYLINE': {
        e.type = 'poly';
        if (has(10)) {
          const pts = [];
          for (const [c, v0] of pairs) {
            const v = val(v0);
            if (c === 10 && Array.isArray(v)) pts.push({ x: +v[0], y: +v[1], b: 0 });
            else if (c === 42 && pts.length) pts[pts.length - 1].b = +v || 0;
            else if (c === 40 && pts.length && v) pts[pts.length - 1].sw = +v;
            else if (c === 41 && pts.length && v) pts[pts.length - 1].ew = +v;
          }
          if (pts.length < 2 || !pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return { error: 'bad vertices' };
          e.pts = pts;
        } else need(10);
        if (has(70)) e.closed = (get(pairs, 70) & 1) === 1;
        else if (!old) e.closed = false;
        if (has(43)) { const w = get(pairs, 43); if (w > 0) e.w = w; else delete e.w; }
        break;
      }
      case 'ELLIPSE': {
        need(10); need(11); need(40);
        e.type = 'ellipse';
        const c = pt2(pairs, 10, old && { x: old.cx, y: old.cy }), m = pt2(pairs, 11, old && { x: old.mx, y: old.my });
        Object.assign(e, { cx: c.x, cy: c.y, mx: m.x, my: m.y, ratio: num(pairs, 40, old?.ratio ?? 1), t0: num(pairs, 41, old?.t0 ?? 0), t1: num(pairs, 42, old?.t1 ?? TAU) });
        break;
      }
      case 'POINT': { need(10); e.type = 'point'; const p = pt2(pairs, 10, old && { x: old.x, y: old.y }); Object.assign(e, { x: p.x, y: p.y }); break; }
      case 'TEXT': {
        need(1); need(10);
        e.type = 'text';
        const h72 = has(72) ? get(pairs, 72) : old ? HA[old.ha] ?? 0 : 0, v73 = has(73) ? get(pairs, 73) : old ? VA[old.va] ?? 0 : 0;
        const aligned = h72 !== 0 || v73 !== 0;
        const p = aligned && has(11) ? pt2(pairs, 11) : pt2(pairs, 10, old && { x: old.x, y: old.y });
        Object.assign(e, { x: p.x, y: p.y, h: num(pairs, 40, old?.h ?? ctx.textHeight ?? 2.5), s: has(1) ? String(get(pairs, 1)) : old.s,
          rot: na(num(pairs, 50, old?.rot ?? 0)), wf: num(pairs, 41, old?.wf ?? 1) || 1,
          ha: ['left', 'center', 'right', 'left', 'center', 'left'][h72] || 'left', va: ['baseline', 'bottom', 'middle', 'top'][v73] || 'baseline' });
        if (h72 === 4) e.va = 'middle';
        if (has(51)) { const o = get(pairs, 51); if (o) e.obl = o; else delete e.obl; }
        if (!(e.h > 0)) return { error: 'bad text height' };
        break;
      }
      case 'MTEXT': {
        need(1); need(10);
        e.type = 'text';
        const p = pt2(pairs, 10, old && { x: old.x, y: old.y });
        let s = has(1) ? getAll(pairs, 3).join('') + get(pairs, 1) : old.s;
        s = String(s).replace(/\\P/g, '\n').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '');
        const att = has(71) ? get(pairs, 71) : old ? ATTACH(old.ha, old.va) : 1;
        Object.assign(e, { x: p.x, y: p.y, h: num(pairs, 40, old?.h ?? ctx.textHeight ?? 2.5), s, rot: na(has(11) ? Math.atan2(pt2(pairs, 11).y, pt2(pairs, 11).x) : num(pairs, 50, old?.rot ?? 0)),
          ha: ['left', 'center', 'right'][(att - 1) % 3] || 'left', va: ['top', 'middle', 'bottom'][Math.floor((att - 1) / 3)] || 'top' });
        const ww = num(pairs, 41, old?.ww ?? 0);
        if (ww > 0) e.ww = ww; else delete e.ww;
        if (!(e.h > 0)) return { error: 'bad text height' };
        break;
      }
      case 'INSERT': {
        need(2); need(10);
        e.type = 'insert';
        const p = pt2(pairs, 10, old && { x: old.x, y: old.y });
        const name = has(2) ? String(get(pairs, 2)) : old.block;
        if (ctx.blockExists && !ctx.blockExists(name)) return { error: 'no block ' + name };
        Object.assign(e, { block: name, x: p.x, y: p.y, sx: num(pairs, 41, old?.sx ?? 1) || 1, sy: num(pairs, 42, old?.sy ?? (has(41) ? num(pairs, 41, 1) : 1)) || 1, rot: na(num(pairs, 50, old?.rot ?? 0)) });
        break;
      }
      case 'HATCH': {
        if (old) { if (has(2) && !e.solid) e.pattern = String(get(pairs, 2)); if (has(52)) e.pangle = num(pairs, 52); if (has(41)) e.pscale = num(pairs, 41, 1); break; }
        // entmake: polyline-style boundary loops (92 with bit 2), vertices as 10 points
        const loops = [];
        let cur = null;
        for (const [c, v0] of pairs) { const v = val(v0); if (c === 93) { cur = []; loops.push(cur); } else if (c === 10 && cur && Array.isArray(v)) cur.push(v[0], v[1]); }
        if (!loops.length || loops.some((l) => l.length < 6)) return { error: 'hatch boundary not given' };
        const solid = String(get(pairs, 2, 'SOLID')).toUpperCase() === 'SOLID' || get(pairs, 70) === 1;
        Object.assign(e, { type: 'hatch', solid, loops, ...(solid ? {} : { pattern: String(get(pairs, 2)), pscale: num(pairs, 41, 1), pangle: num(pairs, 52, 0) }) });
        break;
      }
      case 'VIEWPORT': {
        if (!old) return { error: 'make viewports with MVIEW' };
        const c = pt2(pairs, 10), v = pt2(pairs, 12);
        if (c) { e.x = c.x; e.y = c.y; }
        if (v) { e.cx = v.x; e.cy = v.y; }
        if (has(40)) e.w = num(pairs, 40, e.w);
        if (has(41)) e.h = num(pairs, 41, e.h);
        if (has(45) && num(pairs, 45) > 0) e.s = e.h / num(pairs, 45);
        break;
      }
      case 'DIMENSION': {
        if (!old) return { error: 'make dimensions with the DIM commands' };
        if (has(1)) { e.text = String(get(pairs, 1)); delete e.block; }
        const map = { 13: 'p1', 14: 'p2', 15: 'c', 10: 'loc' };
        for (const [code, k] of Object.entries(map)) { const p = pt2(pairs, +code); if (p && e[k]) { e[k] = p; delete e.block; } }
        break;
      }
      default:
        if (old) break;   // other types: only the common groups change
        return { error: 'cannot make ' + type };
    }
  } catch (err) { return { error: err.message }; }
  return { entity: e };
}

// ---- ssget filters ----
const REL = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '/=': (a, b) => a !== b, '<>': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '*': () => true };
/** One test (code value) against the object's pairs; `rel` from a preceding (-4 . "<op>"). */
function testOne(pairs, code, want, rel) {
  let have = pairs.filter(([c]) => c === code).map(([, v]) => val(v));
  if (code === 62 && !have.length) have = [256];   // no colour group = by layer
  if (code === 8 && !have.length) have = ['0'];
  if (code === 6 && !have.length) have = ['BYLAYER'];
  if (code === 67 && !have.length) have = [0];
  const w = val(want);
  return have.some((h) => {
    if (typeof w === 'string' && typeof h === 'string') return rel ? REL[rel]?.(h.toUpperCase(), w.toUpperCase()) ?? false : wcmatch(h.toUpperCase(), w.toUpperCase());
    if (typeof w === 'number' && typeof h === 'number') return (REL[rel || '='] || REL['='])(h, w);
    if (Array.isArray(w) && Array.isArray(h)) {
      const ops = String(rel || '=').split(',').map((s) => s.trim());
      return w.every((x, k) => (REL[ops[Math.min(k, ops.length - 1)]] || REL['='])(h[k] ?? 0, x));
    }
    return false;
  });
}
/** Does an object (its pairs) pass an ssget filter list (array of [code, value])? */
export function matchFilter(pairs, filter) {
  let i = 0;
  const seq = (end) => {   // evaluate items until `end` → array of results
    const res = [];
    while (i < filter.length) {
      const [code, v] = filter[i];
      if (code === -4) {
        const op = String(val(v)).toUpperCase().trim();
        if (end && op === end) { i++; return res; }
        if (op.startsWith('<') && /^<(AND|OR|XOR|NOT)$/.test(op)) {
          i++;
          const kind = op.slice(1), inner = seq(kind + '>');
          res.push(kind === 'AND' ? inner.every(Boolean) : kind === 'OR' ? inner.some(Boolean) : kind === 'XOR' ? inner.filter(Boolean).length === 1 : !inner.every(Boolean));
          continue;
        }
        // relational: applies to the next item
        i++;
        if (i < filter.length) { const [c2, v2] = filter[i++]; res.push(testOne(pairs, c2, v2, op)); }
        continue;
      }
      i++;
      res.push(testOne(pairs, code, v, null));
    }
    return res;
  };
  return seq(null).every(Boolean);
}

// ---- table records (tblnext / tblsearch) ----
export function layerPairs(l, current) {
  return [[0, 'LAYER'], [2, l.name], [70, I((l.frozen ? 1 : 0) | (l.locked ? 4 : 0))], [62, I((l.on === false || l.name === undefined ? -1 : 1) * (typeof l.color === 'number' ? l.color : 7))],
    [6, l.linetype || 'Continuous'], [290, I(l.plot === false ? 0 : 1)], [370, I(Number.isFinite(l.lineweight) && l.lineweight >= 0 ? Math.round(l.lineweight * 100) : -3)],
    ...(current ? [] : [])];
}
export function blockPairs(b, firstEname) {
  const flags = (b.name.startsWith('*') ? 1 : 0) | (b.attdefs?.length ? 2 : 0) | (b.xref ? 4 : 0) | (b.xref?.of ? 16 : 0);
  return [[0, 'BLOCK'], [2, b.name], [70, I(flags)], [10, P(b.base?.x, b.base?.y)], ...(firstEname !== undefined ? [[-2, { e: firstEname }]] : []), ...(b.xref?.path ? [[1, b.xref.path]] : [])];
}
export const ltypePairs = (lt) => [[0, 'LTYPE'], [2, lt.name], [70, I(0)], [3, lt.description || ''], [72, I(65)], [73, I((lt.pattern || []).length)], [40, (lt.pattern || []).reduce((s, x) => s + Math.abs(x), 0)], ...(lt.pattern || []).map((x) => [49, x])];
export const viewPairs = (v) => [[0, 'VIEW'], [2, v.name], [70, I(v.layout ? 1 : 0)], [40, v.h], [10, [v.cx, v.cy]], [41, v.w], [11, [0, 0, 1]], [12, [0, 0, 0]]];
export const namePairs = (table, name) => [[0, table], [2, name], [70, I(0)]];
