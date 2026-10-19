/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: error messages and printed forms are the language's own, not UI. */
/**
 * vla.js — the drawing as objects: vla- / vlax- functions (0.4 part 2, Y.11; session cad-lisp). DOM-free.
 * The objects live on the drawing side (vla-host.js); here a VlaObject is a handle { kind, key } and every property or
 * method is one host call: host.vla(op, handle, …) with op get / put / call / items / has / can.
 *
 *   vla-get-<Property> obj · vla-put-<Property> obj value · vla-<Method> obj args…   made on first use (Interp.autoFn)
 *   vlax-get-property / vlax-put-property / vlax-invoke-method / vlax-get / vlax-put / vlax-invoke
 *   vlax-property-available-p · vlax-method-applicable-p · vlax-for (special form) · vlax-get-acad-object
 *   vlax-ename->vla-object · vlax-vla-object->ename · vlax-erased-p · vlax-release-object · vlax-object-released-p
 *   variants and safe arrays: vlax-make-variant vlax-variant-value vlax-variant-type vlax-variant-change-type
 *   vlax-make-safearray vlax-safearray-fill vlax-safearray->list vlax-safearray-get-element vlax-safearray-put-element
 *   vlax-safearray-get-dim vlax-safearray-get-l-bound vlax-safearray-get-u-bound vlax-safearray-type vlax-3d-point
 *   :vlax-true :vlax-false :vlax-null, vlax-vb* type numbers, ac* constants (acAllViewports, acByLayer …)
 */
import { Sym, sym, T, Int, int, Cons, Ename, Builtin, LispError, MSG_CANCEL, isNum, numVal, isInt, fromArray, toArray, truthy, bool, show } from './types.js';
import { arity, str, intv, lst, symv } from './builtins.js';

const IFACE = { App: 'IAcadApplication', Doc: 'IAcadDocument', Blocks: 'IAcadBlocks', Layers: 'IAcadLayers', Layouts: 'IAcadLayouts', Linetypes: 'IAcadLineTypes',
  TextStyles: 'IAcadTextStyles', DimStyles: 'IAcadDimStyles', Views: 'IAcadViews', Documents: 'IAcadDocuments', Block: 'IAcadBlock', Layer: 'IAcadLayer',
  Layout: 'IAcadLayout', Linetype: 'IAcadLineType', TextStyle: 'IAcadTextStyle', DimStyle: 'IAcadDimStyle', View: 'IAcadView', Ent: 'IAcadEntity', Att: 'IAcadAttributeReference' };

export class VlaObject {
  constructor(h) { this.h = h; this.lispType = 'VLA-OBJECT'; }
  show() { let n = 0; for (const c of String(this.h.kind) + String(this.h.key ?? '') + String(this.h.tag ?? '')) n = (n * 31 + c.charCodeAt(0)) >>> 0; return '#<VLA-OBJECT ' + (IFACE[this.h.kind] || 'IAcadObject') + ' ' + n.toString(16).padStart(16, '0') + '>'; }
  same(o) { return o instanceof VlaObject && o.h.kind === this.h.kind && String(o.h.key) === String(this.h.key) && o.h.tag === this.h.tag; }
  plain() { return { vla: this.h }; }
}
export const VT = { EMPTY: 0, NULL: 1, INTEGER: 2, LONG: 3, SINGLE: 4, DOUBLE: 5, CURRENCY: 6, DATE: 7, STRING: 8, OBJECT: 9, ERROR: 10, BOOLEAN: 11, VARIANT: 12, ARRAY: 8192 };
export class Variant {
  constructor(type, value) { this.type = type; this.value = value; this.lispType = 'VARIANT'; }
  show() { return '#<variant ' + this.type + ' ' + (this.value instanceof SafeArray ? '...' : show(this.value)) + '>'; }
}
export class SafeArray {
  constructor(type, bounds, data) { this.type = type; this.bounds = bounds; this.data = data; this.lispType = 'SAFEARRAY'; }
  show() { return '#<safearray...>'; }
  get size() { return this.bounds.reduce((n, [l, u]) => n * (u - l + 1), 1); }
}
const TRUE = sym(':VLAX-TRUE'), FALSE = sym(':VLAX-FALSE'), VNULL = sym(':VLAX-NULL');

/** A host value → LISP the way vla-get-* returns it (`raw` = vlax-get: lists and -1/0 instead of variants and :vlax-true). */
export function fromHost(v, raw = false) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'object') {
    if ('i' in v) return int(v.i);
    if ('vla' in v) return new VlaObject(v.vla);
    if ('bool' in v) return raw ? int(v.bool ? -1 : 0) : v.bool ? TRUE : FALSE;
    if ('e' in v) return new Ename(v.e);
    if ('arr' in v) {
      const vals = v.arr.map((x) => (typeof x === 'object' && x && 'vla' in x ? new VlaObject(x.vla) : typeof x === 'object' && x && 'i' in x ? int(x.i) : x));
      if (raw) return fromArray(vals);
      const sa = new SafeArray(v.vt ?? VT.DOUBLE, [[0, vals.length - 1]], vals);
      return new Variant(VT.ARRAY | (v.vt ?? VT.DOUBLE), sa);
    }
  }
  return null;
}
/** LISP → a host value for vla-put-* and method arguments. */
export function toHost(x) {
  if (x === null || x === undefined || x === FALSE) return x === FALSE ? { bool: false } : null;
  if (x === TRUE || x === T) return { bool: true };
  if (x instanceof Int) return { i: x.v };
  if (typeof x === 'number' || typeof x === 'string') return x;
  if (x instanceof VlaObject) return { vla: x.h };
  if (x instanceof Variant) return toHost(x.value);
  if (x instanceof SafeArray) return { arr: x.data.map(toHost) };
  if (x instanceof Ename) return { e: x.id };
  if (x instanceof Cons) return { arr: toArray(x).map(toHost) };
  if (x instanceof Sym) return { sym: x.name };
  return null;
}
const obj = (x) => { if (x instanceof VlaObject) return x; throw new LispError('bad argument type: VLA-OBJECT ' + show(x)); };
const propName = (x) => (x instanceof Sym ? x.name : str(x));

async function vla(L, ...args) {
  if (!L.host || typeof L.host.vla !== 'function') throw new LispError('no drawing: vla');
  let r;
  try { r = await L.host.vla(...args); }
  catch (err) {
    if (err && (err.name === 'Cancel' || err.cancel)) throw new LispError(MSG_CANCEL, { cancel: true });
    throw new LispError(String(err?.message || err));
  }
  if (r && typeof r === 'object' && 'error' in r) throw new LispError(r.error);
  return r;
}

export function installVla(L) {
  const d = (name, fn) => L.def(name, fn);
  for (const s of [TRUE, FALSE, VNULL]) L.set(s, s);
  const consts = {
    'VLAX-VBEMPTY': 0, 'VLAX-VBNULL': 1, 'VLAX-VBINTEGER': 2, 'VLAX-VBLONG': 3, 'VLAX-VBSINGLE': 4, 'VLAX-VBDOUBLE': 5, 'VLAX-VBCURRENCY': 6, 'VLAX-VBDATE': 7,
    'VLAX-VBSTRING': 8, 'VLAX-VBOBJECT': 9, 'VLAX-VBERROR': 10, 'VLAX-VBBOOLEAN': 11, 'VLAX-VBVARIANT': 12, 'VLAX-VBARRAY': 8192,
    ACACTIVEVIEWPORT: 0, ACALLVIEWPORTS: 1, ACBYBLOCK: 0, ACBYLAYER: 256, ACRED: 1, ACYELLOW: 2, ACGREEN: 3, ACCYAN: 4, ACBLUE: 5, ACMAGENTA: 6, ACWHITE: 7,
    ACMODELSPACE: 1, ACPAPERSPACE: 0, ACEXTENTS: 1, ACDISPLAY: 0, ACLNWTBYLAYER: -1, ACLNWTBYBLOCK: -2, ACLNWTBYLWDEFAULT: -3,
    ACALIGNMENTLEFT: 0, ACALIGNMENTCENTER: 1, ACALIGNMENTRIGHT: 2, ACALIGNMENTMIDDLE: 4,
  };
  for (const [k, v] of Object.entries(consts)) L.set(sym(k), int(v));

  // ---- properties and methods made on first use ----
  L.autoFn = (name) => {
    let m;
    if ((m = name.match(/^VLA-GET-(.+)$/))) { const p = m[1]; return new Builtin(name, async (a, L) => { arity(a, 1); return fromHost(await vla(L, 'get', obj(a[0]).h, p)); }); }
    if ((m = name.match(/^VLA-PUT-(.+)$/))) { const p = m[1]; return new Builtin(name, async (a, L) => { arity(a, 2); await vla(L, 'put', obj(a[0]).h, p, toHost(a[1])); return null; }); }
    if ((m = name.match(/^VLA-(.+)$/))) { const meth = m[1]; return new Builtin(name, async (a, L) => method(L, obj(a[0]), meth, a.slice(1), false)); }
    return null;
  };
  async function method(L, o, meth, args, raw) {
    const M = String(meth).toUpperCase();
    if (M === 'GETBOUNDINGBOX') {
      const r = await vla(L, 'call', o.h, M, []);
      const [mn, mx] = args;
      // the two output arguments are quoted symbols that receive safe arrays of three doubles
      const out = (p) => (raw ? fromArray(p) : new SafeArray(VT.DOUBLE, [[0, 2]], p.slice()));
      if (mn instanceof Sym) L.set(mn, out(r.min));
      if (mx instanceof Sym) L.set(mx, out(r.max));
      return null;
    }
    return fromHost(await vla(L, 'call', o.h, M, args.map(toHost)), raw);
  }

  d('VLAX-GET-ACAD-OBJECT', () => new VlaObject({ kind: 'App' }));
  d('VLAX-GET-PROPERTY', async (a, L) => { arity(a, 2); return fromHost(await vla(L, 'get', obj(a[0]).h, propName(a[1]).toUpperCase())); });
  d('VLAX-PUT-PROPERTY', async (a, L) => { arity(a, 3); await vla(L, 'put', obj(a[0]).h, propName(a[1]).toUpperCase(), toHost(a[2])); return null; });
  d('VLAX-GET', async (a, L) => { arity(a, 2); return fromHost(await vla(L, 'get', obj(a[0]).h, propName(a[1]).toUpperCase()), true); });
  d('VLAX-PUT', async (a, L) => { arity(a, 3); await vla(L, 'put', obj(a[0]).h, propName(a[1]).toUpperCase(), toHost(a[2])); return null; });
  d('VLAX-INVOKE-METHOD', async (a, L) => { arity(a, 2, Infinity); return method(L, obj(a[0]), propName(a[1]), a.slice(2), false); });
  d('VLAX-INVOKE', async (a, L) => { arity(a, 2, Infinity); return method(L, obj(a[0]), propName(a[1]), a.slice(2), true); });
  d('VLAX-PROPERTY-AVAILABLE-P', async (a, L) => { arity(a, 2, 3); return bool(await vla(L, 'has', obj(a[0]).h, propName(a[1]).toUpperCase(), truthy(a[2]))); });
  d('VLAX-METHOD-APPLICABLE-P', async (a, L) => { arity(a, 2); return bool(await vla(L, 'can', obj(a[0]).h, propName(a[1]).toUpperCase())); });
  d('VLAX-ENAME->VLA-OBJECT', async (a, L) => { arity(a, 1); if (!(a[0] instanceof Ename)) throw new LispError('bad argument type: lentityp ' + show(a[0])); return fromHost(await vla(L, 'fromEname', a[0].id)); });
  d('VLAX-VLA-OBJECT->ENAME', async (a, L) => { arity(a, 1); const r = await vla(L, 'toEname', obj(a[0]).h); return r === null || r === undefined ? null : new Ename(r); });
  d('VLAX-ERASED-P', async (a, L) => { arity(a, 1); return bool(await vla(L, 'erased', obj(a[0]).h)); });
  d('VLAX-RELEASE-OBJECT', () => null);
  d('VLAX-OBJECT-RELEASED-P', () => null);
  d('VLAX-WRITE-ENABLED-P', () => T);
  d('VLAX-READ-ENABLED-P', () => T);
  d('VLAX-TYPEINFO-AVAILABLE-P', () => T);

  L.def('VLAX-FOR', async (l, L) => {
    const forms = toArray(l);
    const [v, collForm, ...body] = forms;
    symv(v);
    const coll = obj(await L.eval(collForm));
    const items = await vla(L, 'items', coll.h);
    const old = L.globals.get(v);
    let r = null;
    try {
      for (const h of items) { L.set(v, new VlaObject(h)); for (const f of body) r = await L.eval(f); }
    } finally { L.restore(v, old); }
    return r;
  }, true);

  // ---- variants and safe arrays ----
  const typeOf = (x) => (x === null ? VT.EMPTY : x instanceof Int ? VT.LONG : typeof x === 'number' ? VT.DOUBLE : typeof x === 'string' ? VT.STRING : x === TRUE || x === FALSE ? VT.BOOLEAN
    : x instanceof VlaObject ? VT.OBJECT : x instanceof SafeArray ? VT.ARRAY | x.type : VT.VARIANT);
  d('VLAX-MAKE-VARIANT', (a) => { arity(a, 0, 2); const v = a.length ? a[0] : null; return new Variant(a.length > 1 && a[1] !== null ? intv(a[1]) : typeOf(v), v); });
  d('VLAX-VARIANT-VALUE', (a) => { arity(a, 1); if (!(a[0] instanceof Variant)) throw new LispError('bad argument type: variantp ' + show(a[0])); return a[0].value; });
  d('VLAX-VARIANT-TYPE', (a) => { arity(a, 1); return a[0] instanceof Variant ? int(a[0].type) : int(VT.EMPTY); });
  d('VLAX-VARIANT-CHANGE-TYPE', (a) => {
    arity(a, 2);
    if (!(a[0] instanceof Variant)) throw new LispError('bad argument type: variantp ' + show(a[0]));
    const to = intv(a[1]), v = a[0].value;
    if (to === VT.STRING) return new Variant(to, isNum(v) ? (isInt(v) ? String(v.v) : String(v)) : show(v, false));
    if (to === VT.DOUBLE || to === VT.SINGLE) { const n = isNum(v) ? numVal(v) : typeof v === 'string' ? parseFloat(v) : NaN; return Number.isFinite(n) ? new Variant(to, n) : null; }
    if (to === VT.INTEGER || to === VT.LONG) { const n = isNum(v) ? numVal(v) : typeof v === 'string' ? parseFloat(v) : NaN; return Number.isFinite(n) ? new Variant(to, int(Math.round(n))) : null; }
    if (to === VT.BOOLEAN) return new Variant(to, truthy(v) && v !== FALSE && !(isNum(v) && numVal(v) === 0) ? TRUE : FALSE);
    return new Variant(to, v);
  });
  const sa = (x) => { if (x instanceof Variant && x.value instanceof SafeArray) return x.value; if (x instanceof SafeArray) return x; throw new LispError('bad argument type: safearrayp ' + show(x)); };
  d('VLAX-MAKE-SAFEARRAY', (a) => {
    arity(a, 2, Infinity);
    const type = intv(a[0]);
    const bounds = a.slice(1).map((b) => { if (!(b instanceof Cons)) throw new LispError('bad argument type: consp ' + show(b)); return [intv(b.car), intv(b.cdr)]; });
    const blank = type === VT.STRING ? '' : type === VT.DOUBLE || type === VT.SINGLE ? 0 : type === VT.OBJECT ? null : int(0);
    const s = new SafeArray(type, bounds, []);
    s.data = new Array(s.size).fill(blank);
    return s;
  });
  d('VLAX-SAFEARRAY-FILL', (a) => {
    arity(a, 2);
    const s = sa(a[0]), vals = toArray(lst(a[1]));
    const flat = s.bounds.length > 1 ? vals.flatMap((r) => toArray(r)) : vals;
    if (flat.length > s.size) throw new LispError('too many elements');
    flat.forEach((v, i) => { s.data[i] = s.type === VT.DOUBLE && isInt(v) ? v.v : v; });
    return s;
  });
  d('VLAX-SAFEARRAY->LIST', (a) => {
    arity(a, 1);
    const s = sa(a[0]);
    if (s.bounds.length < 2) return fromArray(s.data);
    const cols = s.bounds[1][1] - s.bounds[1][0] + 1, rows = [];
    for (let i = 0; i < s.data.length; i += cols) rows.push(fromArray(s.data.slice(i, i + cols)));
    return fromArray(rows);
  });
  const idx = (s, ks) => {
    let k = 0;
    s.bounds.forEach(([l, u], dim) => { const i = intv(ks[dim]); if (i < l || i > u) throw new LispError('bad argument value: index ' + i); k = k * (u - l + 1) + (i - l); });
    return k;
  };
  d('VLAX-SAFEARRAY-GET-ELEMENT', (a) => { arity(a, 2, Infinity); const s = sa(a[0]); return s.data[idx(s, a.slice(1))] ?? null; });
  d('VLAX-SAFEARRAY-PUT-ELEMENT', (a) => { arity(a, 3, Infinity); const s = sa(a[0]); s.data[idx(s, a.slice(1, -1))] = a[a.length - 1]; return a[a.length - 1]; });
  d('VLAX-SAFEARRAY-GET-DIM', (a) => { arity(a, 1); return int(sa(a[0]).bounds.length); });
  d('VLAX-SAFEARRAY-GET-L-BOUND', (a) => { arity(a, 2); const b = sa(a[0]).bounds[intv(a[1]) - 1]; if (!b) throw new LispError('bad argument value: dimension'); return int(b[0]); });
  d('VLAX-SAFEARRAY-GET-U-BOUND', (a) => { arity(a, 2); const b = sa(a[0]).bounds[intv(a[1]) - 1]; if (!b) throw new LispError('bad argument value: dimension'); return int(b[1]); });
  d('VLAX-SAFEARRAY-TYPE', (a) => { arity(a, 1); return int(sa(a[0]).type); });
  d('VLAX-3D-POINT', (a) => {
    arity(a, 1, 3);
    const p = a.length === 1 ? toArray(lst(a[0])).map(numVal) : a.map(numVal);
    while (p.length < 3) p.push(0);
    return new Variant(VT.ARRAY | VT.DOUBLE, new SafeArray(VT.DOUBLE, [[0, 2]], p.slice(0, 3)));
  });
}
