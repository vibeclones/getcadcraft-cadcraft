/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: error messages and printed forms are the language's own (routines compare them), not UI. */
/**
 * builtins.js — the built-in functions that need no drawing (0.4 part 2, Y.2 + Y.3; session cad-lisp). DOM-free.
 * `installBuiltins(L)` puts them into an Interp: math, comparison, lists, strings, conversions, wildcards, geometry,
 * output, files (in memory: the interpreter's own files), load, eval / read / apply / mapcar, exit.
 * The drawing functions are in cadfns.js, dialogs in dcl.js, vl- / vla- / vlax- in vla.js.
 *
 * Checked against the public AutoLISP reference, function by function (argument types, nil cases, integer vs real).
 */
import { Sym, sym, T, Int, int, Cons, cons, Lambda, Builtin, Ename, PickSet, LFile, LispError, MSG_QUIT,
  isNum, numVal, isInt, list, fromArray, toArray, isProper, truthy, bool, show, realText, typeName } from './types.js';
import { readOne, readAll } from './reader.js';
import { installSpecials, Interp } from './interp.js';
import { formatLength, parseLength } from '../units.js';

// ---- argument checks (AutoLISP's messages) ----
export const bad = (what, x) => new LispError('bad argument type: ' + what + ': ' + show(x));
export function num(x) { if (typeof x === 'number') return x; if (x instanceof Int) return x.v; throw bad('numberp', x); }
export function intv(x) { if (x instanceof Int) return x.v; throw bad('fixnump', x); }
export function str(x) { if (typeof x === 'string') return x; throw bad('stringp', x); }
export function lst(x) { if (x === null || x instanceof Cons) return x; throw bad('listp', x); }
export function symv(x) { if (x instanceof Sym) return x; throw bad('symbolp', x); }
export function arity(a, min, max = min) {
  if (a.length < min) throw new LispError('too few arguments');
  if (max !== Infinity && a.length > max) throw new LispError('too many arguments');
}
/** A point argument: a list of 2 or 3 numbers → [x, y, z?]. */
export function pt(x) {
  const a = toArray(lst(x));
  if (a.length < 2 || !a.every(isNum)) throw bad('2D/3D point', x);
  return a.slice(0, 3).map(numVal);
}
export const ptList = (p) => fromArray(p.map(Number));
const real = (x) => (isInt(x) ? x.v : x);

// ---- equality ----
export function equal(a, b, fuzz = 0) {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return Math.abs(numVal(a) - numVal(b)) <= fuzz;
  if (a instanceof Cons && b instanceof Cons) {
    while (a instanceof Cons && b instanceof Cons) { if (!equal(a.car, b.car, fuzz)) return false; a = a.cdr; b = b.cdr; }
    return equal(a, b, fuzz);
  }
  if (a instanceof Ename && b instanceof Ename) return a.id === b.id;
  if (a instanceof PickSet && b instanceof PickSet) return a === b;
  if (a && b && typeof a.same === 'function') return a.same(b);
  return false;
}
export function eq(a, b) {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return isInt(a) === isInt(b) && numVal(a) === numVal(b);
  if (a instanceof Ename && b instanceof Ename) return a.id === b.id;
  if (a && b && typeof a.same === 'function') return a.same(b);
  return false;
}

// ---- wildcards (wcmatch): wild.js ----
export { wcRegex, wcmatch } from './wild.js';
import { wcmatch } from './wild.js';

// ---- number formatting ----
/** rtos: mode 1 scientific, 2 decimal, 3 engineering, 4 architectural, 5 fractional; DIMZIN 8 drops trailing zeros. */
export function rtos(v, mode, prec, dimzin = 0) {
  if (mode === 2) {
    let s = (Math.abs(v) < 0.5 * Math.pow(10, -prec) ? 0 : v).toFixed(prec);
    if (dimzin & 8 && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (dimzin & 4 && /^-?0\./.test(s)) s = s.replace(/^(-?)0\./, '$1.');
    return s;
  }
  return formatLength(v, { lunits: mode, prec });
}
/** angtos: 0 degrees, 1 deg/min/sec, 2 grads, 3 radians, 4 surveyor's units. */
export function angtos(a, mode, prec) {
  const TAU = Math.PI * 2;
  a = ((a % TAU) + TAU) % TAU;
  const fx = (v) => v.toFixed(prec);
  if (mode === 0) return fx(a * 180 / Math.PI);
  if (mode === 2) return fx(a * 200 / Math.PI) + 'g';
  if (mode === 3) return fx(a) + 'r';
  const dms = (deg) => {
    let d = Math.floor(deg + 1e-12), m = (deg - d) * 60;
    if (prec <= 0) return Math.round(deg) + 'd';
    let mi = Math.floor(m + 1e-9), s = (m - mi) * 60;
    if (prec <= 2) { mi = Math.round(m); if (mi === 60) { d++; mi = 0; } return d + 'd' + mi + "'"; }
    const sd = Math.max(0, prec - 4);
    let ss = Number(s.toFixed(sd));
    if (ss >= 60) { ss = 0; mi++; } if (mi >= 60) { mi = 0; d++; }
    return d + 'd' + mi + "'" + ss.toFixed(sd) + '"';
  };
  if (mode === 1) return dms(a * 180 / Math.PI);
  // surveyor: N/S <angle> E/W from north/south
  const deg = a * 180 / Math.PI;
  if (Math.abs(deg - 90) < 1e-9) return 'E';
  if (Math.abs(deg - 270) < 1e-9) return 'W';
  if (Math.abs(deg) < 1e-9 || Math.abs(deg - 360) < 1e-9) return 'N';
  if (Math.abs(deg - 180) < 1e-9) return 'S';
  const ns = deg < 180 ? 'N' : 'S';
  const off = deg < 180 ? Math.abs(90 - deg) : Math.abs(270 - deg);
  const ew = deg > 90 && deg < 270 ? 'W' : 'E';
  return ns + dms(off).replace(/^/, '') + ew;
}
/** angtof: text in a mode → radians, or null. */
export function angtof(s, mode = 0) {
  const t = String(s).trim();
  let m;
  if (mode === 3 || /r$/i.test(t)) { const v = parseFloat(t); return Number.isFinite(v) ? v : null; }
  if (mode === 2 || /g$/i.test(t)) { const v = parseFloat(t); return Number.isFinite(v) ? v * Math.PI / 200 : null; }
  if ((m = t.match(/^([NS])\s*(.*?)\s*([EW])$/i))) {
    const off = angtof(m[2], 1);
    if (off === null) return null;
    const base = m[1].toUpperCase() === 'N' ? 90 : 270, sgn = (m[1].toUpperCase() === 'N') === (m[3].toUpperCase() === 'E') ? -1 : 1;
    return ((base * Math.PI / 180) + sgn * off + 2 * Math.PI) % (2 * Math.PI);
  }
  if ((m = t.match(/^(-?\d+(?:\.\d*)?)d(?:(\d+(?:\.\d*)?)')?(?:(\d+(?:\.\d*)?)")?$/i))) return (+m[1] + (+(m[2] || 0)) / 60 + (+(m[3] || 0)) / 3600) * Math.PI / 180;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return parseFloat(t) * Math.PI / 180;
  return null;
}

// ---- unit conversion (cvunit) ----
const UNIT = {
  inch: ['len', 0.0254], inches: ['len', 0.0254], in: ['len', 0.0254], '"': ['len', 0.0254], foot: ['len', 0.3048], feet: ['len', 0.3048], ft: ['len', 0.3048], "'": ['len', 0.3048],
  yard: ['len', 0.9144], yards: ['len', 0.9144], yd: ['len', 0.9144], mile: ['len', 1609.344], miles: ['len', 1609.344], mi: ['len', 1609.344],
  millimeter: ['len', 0.001], millimeters: ['len', 0.001], mm: ['len', 0.001], centimeter: ['len', 0.01], centimeters: ['len', 0.01], cm: ['len', 0.01],
  meter: ['len', 1], meters: ['len', 1], m: ['len', 1], kilometer: ['len', 1000], kilometers: ['len', 1000], km: ['len', 1000],
  degree: ['ang', Math.PI / 180], degrees: ['ang', Math.PI / 180], radian: ['ang', 1], radians: ['ang', 1], grad: ['ang', Math.PI / 200], grads: ['ang', Math.PI / 200],
  kilogram: ['mass', 1], kg: ['mass', 1], gram: ['mass', 0.001], g: ['mass', 0.001], pound: ['mass', 0.45359237], lb: ['mass', 0.45359237],
  'sq inch': ['area', 0.00064516], 'sq foot': ['area', 0.09290304], 'sq meter': ['area', 1], 'sq mm': ['area', 1e-6], acre: ['area', 4046.8564224], hectare: ['area', 10000],
};

// ---- the in-memory file system ----
let tempN = 0;

export function installBuiltins(L) {
  installSpecials(L);
  const d = (name, fn) => L.def(name, fn);
  L.set(sym('PI'), Math.PI);
  L.set(sym('PAUSE'), '\\');

  // ---- arithmetic ----
  const allInt = (a) => a.every(isInt);
  d('+', (a) => { a.forEach(num); return allInt(a) ? int(a.reduce((s, x) => s + x.v, 0)) : a.reduce((s, x) => s + numVal(x), 0); });
  d('-', (a) => {
    a.forEach(num);
    if (!a.length) return int(0);
    if (a.length === 1) return isInt(a[0]) ? int(-a[0].v) : -a[0];
    const r = a.slice(1).reduce((s, x) => s - numVal(x), numVal(a[0]));
    return allInt(a) ? int(r) : r;
  });
  d('*', (a) => { a.forEach(num); if (!a.length) return int(0); return allInt(a) ? int(a.reduce((s, x) => Math.imul(s, x.v), 1)) : a.reduce((s, x) => s * numVal(x), 1); });
  d('/', (a) => {
    a.forEach(num);
    if (!a.length) return int(0);
    let ints = isInt(a[0]), r = numVal(a[0]);
    for (const x of a.slice(1)) {
      const v = numVal(x);
      if (v === 0) throw new LispError('divide by zero');
      ints = ints && isInt(x);
      r = ints ? Math.trunc(r / v) : r / v;
    }
    return ints ? int(r) : r;
  });
  d('~', (a) => { arity(a, 1); return int(~intv(a[0])); });
  d('1+', (a) => { arity(a, 1); num(a[0]); return isInt(a[0]) ? int(a[0].v + 1) : a[0] + 1; });
  d('1-', (a) => { arity(a, 1); num(a[0]); return isInt(a[0]) ? int(a[0].v - 1) : a[0] - 1; });
  d('ABS', (a) => { arity(a, 1); num(a[0]); return isInt(a[0]) ? int(Math.abs(a[0].v)) : Math.abs(a[0]); });
  d('FIX', (a) => { arity(a, 1); return int(Math.trunc(num(a[0]))); });
  d('FLOAT', (a) => { arity(a, 1); return num(a[0]); });
  d('REM', (a) => {
    a.forEach(num);
    if (!a.length) return int(0);
    let r = numVal(a[0]);
    for (const x of a.slice(1)) { const v = numVal(x); if (v === 0) throw new LispError('divide by zero'); r = r % v; }
    return allInt(a) ? int(r) : r;
  });
  const gcd2 = (x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) [x, y] = [y, x % y]; return x; };
  d('GCD', (a) => { arity(a, 1, Infinity); return int(a.map(intv).reduce(gcd2)); });
  d('LCM', (a) => { arity(a, 1, Infinity); return int(a.map(intv).reduce((x, y) => (x && y ? Math.abs(x * y) / gcd2(x, y) : 0))); });
  d('MIN', (a) => { arity(a, 1, Infinity); a.forEach(num); const v = Math.min(...a.map(numVal)); return allInt(a) ? int(v) : v; });
  d('MAX', (a) => { arity(a, 1, Infinity); a.forEach(num); const v = Math.max(...a.map(numVal)); return allInt(a) ? int(v) : v; });
  d('SQRT', (a) => { arity(a, 1); const v = num(a[0]); if (v < 0) throw new LispError('function undefined for argument: ' + show(a[0])); return Math.sqrt(v); });
  d('EXP', (a) => { arity(a, 1); return Math.exp(num(a[0])); });
  d('LOG', (a) => { arity(a, 1); const v = num(a[0]); if (v <= 0) throw new LispError('function undefined for argument: ' + show(a[0])); return Math.log(v); });
  d('EXPT', (a) => { arity(a, 2); const b = num(a[0]), e = num(a[1]); return isInt(a[0]) && isInt(a[1]) && e >= 0 ? int(Math.pow(b, e)) : Math.pow(b, e); });
  d('SIN', (a) => { arity(a, 1); return Math.sin(num(a[0])); });
  d('COS', (a) => { arity(a, 1); return Math.cos(num(a[0])); });
  d('ATAN', (a) => { arity(a, 1, 2); return a.length === 2 ? Math.atan2(num(a[0]), num(a[1])) : Math.atan(num(a[0])); });
  d('MINUSP', (a) => { arity(a, 1); return bool(num(a[0]) < 0); });
  d('ZEROP', (a) => { arity(a, 1); return bool(num(a[0]) === 0); });
  d('NUMBERP', (a) => { arity(a, 1); return bool(isNum(a[0])); });
  d('BOOLE', (a) => {
    arity(a, 2, Infinity);
    const op = intv(a[0]);
    let r = intv(a[1]);
    for (const x of a.slice(2)) {
      const b = intv(x);
      let out = 0;
      for (let bit = 0; bit < 32; bit++) {
        const p = (r >>> bit) & 1, q = (b >>> bit) & 1;
        const k = p && q ? 1 : p ? 2 : q ? 4 : 8;
        if (op & k) out |= 1 << bit;
      }
      r = out;
    }
    return int(r);
  });
  d('LOGAND', (a) => int(a.map(intv).reduce((x, y) => x & y, -1) & (a.length ? -1 : 0)));
  d('LOGIOR', (a) => int(a.map(intv).reduce((x, y) => x | y, 0)));
  d('LSH', (a) => { arity(a, 0, 2); const v = a.length ? intv(a[0]) : 0, n = a.length > 1 ? intv(a[1]) : 0; return int(n >= 0 ? v << n : v >>> -n); });

  // ---- comparison ----
  const cmpv = (x) => (typeof x === 'string' ? x : num(x));
  const chain = (test) => (a) => {
    arity(a, 1, Infinity);
    const v = a.map(cmpv);
    for (let i = 1; i < v.length; i++) if (!test(v[i - 1], v[i])) return null;
    return T;
  };
  // = and /= compare numbers and strings by value, anything else by identity (routines write (= "Exit" sel) with a list)
  const same = (x, y) => (isNum(x) && isNum(y) ? numVal(x) === numVal(y) : typeof x === 'string' && typeof y === 'string' ? x === y : eq(x, y));
  d('=', (a) => { arity(a, 1, Infinity); for (let i = 1; i < a.length; i++) if (!same(a[i - 1], a[i])) return null; return T; });
  d('/=', (a) => { arity(a, 1, Infinity); for (let i = 1; i < a.length; i++) if (same(a[i - 1], a[i])) return null; return T; });
  d('<', chain((x, y) => x < y));
  d('>', chain((x, y) => x > y));
  d('<=', chain((x, y) => x <= y));
  d('>=', chain((x, y) => x >= y));
  d('EQ', (a) => { arity(a, 2); return bool(eq(a[0], a[1])); });
  d('EQUAL', (a) => { arity(a, 2, 3); return bool(equal(a[0], a[1], a.length > 2 ? num(a[2]) : 0)); });
  d('NOT', (a) => { arity(a, 1); return bool(!truthy(a[0])); });
  d('NULL', (a) => { arity(a, 1); return bool(!truthy(a[0])); });
  d('ATOM', (a) => { arity(a, 1); return bool(!(a[0] instanceof Cons)); });
  d('LISTP', (a) => { arity(a, 1); return bool(a[0] === null || a[0] instanceof Cons); });
  d('BOUNDP', (a) => { arity(a, 1); return bool(L.globals.has(symv(a[0]))); });
  d('TYPE', (a) => { arity(a, 1); const n = typeName(a[0]); return n ? sym(n) : null; });

  // ---- lists ----
  const car = (x) => { if (x === null) return null; if (x instanceof Cons) return x.car; throw bad('consp', x); };
  const cdr = (x) => { if (x === null) return null; if (x instanceof Cons) return x.cdr; throw bad('consp', x); };
  for (const path of ['A', 'D', 'AA', 'AD', 'DA', 'DD', 'AAA', 'AAD', 'ADA', 'ADD', 'DAA', 'DAD', 'DDA', 'DDD',
    'AAAA', 'AAAD', 'AADA', 'AADD', 'ADAA', 'ADAD', 'ADDA', 'ADDD', 'DAAA', 'DAAD', 'DADA', 'DADD', 'DDAA', 'DDAD', 'DDDA', 'DDDD']) {
    const ops = path.split('').reverse();
    d('C' + path + 'R', (a) => { arity(a, 1); let x = a[0]; for (const o of ops) x = o === 'A' ? car(x) : cdr(x); return x; });
  }
  d('CONS', (a) => { arity(a, 2); return cons(a[0], a[1]); });
  d('LIST', (a) => fromArray(a));
  d('APPEND', (a) => {
    if (!a.length) return null;
    const items = [];
    for (const x of a) items.push(...toArray(lst(x)));
    return fromArray(items);
  });
  d('REVERSE', (a) => { arity(a, 1); return fromArray(toArray(lst(a[0])).reverse()); });
  d('LENGTH', (a) => { arity(a, 1); lst(a[0]); if (!isProper(a[0])) throw bad('listp', a[0]); return int(toArray(a[0]).length); });
  d('NTH', (a) => { arity(a, 2); let n = intv(a[0]); let x = lst(a[1]); if (n < 0) return null; while (n-- > 0 && x instanceof Cons) x = x.cdr; return x instanceof Cons ? x.car : null; });
  d('LAST', (a) => { arity(a, 1); let x = lst(a[0]); if (x === null) return null; while (x.cdr instanceof Cons) x = x.cdr; return x.car; });
  d('MEMBER', (a) => { arity(a, 2); for (let x = lst(a[1]); x instanceof Cons; x = x.cdr) if (equal(a[0], x.car)) return x; return null; });
  d('ASSOC', (a) => { arity(a, 2); for (let x = lst(a[1]); x instanceof Cons; x = x.cdr) if (x.car instanceof Cons && equal(a[0], x.car.car)) return x.car; return null; });
  d('SUBST', (a) => { arity(a, 3); return fromArray(toArray(lst(a[2])).map((x) => (equal(x, a[1]) ? a[0] : x))); });
  d('ACAD_STRLSORT', (a) => { arity(a, 1); const v = toArray(lst(a[0])); v.forEach(str); return fromArray(v.slice().sort((x, y) => (x.toUpperCase() < y.toUpperCase() ? -1 : x.toUpperCase() > y.toUpperCase() ? 1 : 0))); });

  // ---- functions ----
  d('APPLY', async (a, L) => { arity(a, 2); return L.apply(L.fnOf(a[0]), toArray(lst(a[1]))); });
  d('MAPCAR', async (a, L) => {
    arity(a, 2, Infinity);
    const f = L.fnOf(a[0]);
    const ls = a.slice(1).map((x) => toArray(lst(x)));
    const n = Math.min(...ls.map((x) => x.length));
    const out = [];
    for (let i = 0; i < n; i++) out.push(await L.apply(f, ls.map((x) => x[i])));
    return fromArray(out);
  });
  d('EVAL', async (a, L) => { arity(a, 1); return L.eval(a[0]); });
  d('SET', (a, L) => { arity(a, 2); return L.set(symv(a[0]), a[1]) ?? null; });
  d('READ', (a) => { arity(a, 0, 1); if (!a.length) return null; const s = str(a[0]); return s.trim() ? readOne(s).form : null; });
  d('ATOMS-FAMILY', (a, L) => {
    arity(a, 1, 2);
    const names = [...L.globals.keys()].map((s) => s.name);
    if (a.length > 1) return fromArray(toArray(lst(a[1])).map((s) => (names.includes(String(s).toUpperCase()) ? (intv(a[0]) ? String(s).toUpperCase() : sym(s)) : null)));
    return fromArray(intv(a[0]) ? names : names.map(sym));
  });
  d('EXIT', () => { throw new LispError(MSG_QUIT); });
  d('QUIT', () => { throw new LispError(MSG_QUIT); });
  for (const n of ['GC', 'TRACE', 'UNTRACE', 'VL-LOAD-COM', 'VL-LOAD-ALL', 'VL-LOAD-REACTORS', 'VL-ACAD-DEFUN', 'VL-ACAD-UNDEFUN', 'VL-PROPAGATE', 'VL-ARX-IMPORT', 'VL-DOC-EXPORT', 'VL-DOC-IMPORT', 'ACAD-PUSH-DBMOD', 'ACAD-POP-DBMOD']) d(n, () => null);
  d('VER', () => 'CadCraft LISP 0.4 (en)');

  // ---- strings ----
  d('STRCAT', (a) => a.map(str).join(''));
  d('STRLEN', (a) => int(a.map(str).reduce((s, x) => s + x.length, 0)));
  d('SUBSTR', (a) => {
    arity(a, 2, 3);
    const s = str(a[0]), start = intv(a[1]);
    if (start < 1) throw new LispError('bad argument value: positive ' + show(a[1]));
    const n = a.length > 2 ? intv(a[2]) : Infinity;
    if (n < 0) throw new LispError('bad argument value: non-negative ' + show(a[2]));
    return s.substr(start - 1, n === Infinity ? undefined : n);
  });
  d('STRCASE', (a) => { arity(a, 1, 2); const s = str(a[0]); return a.length > 1 && truthy(a[1]) ? s.toLowerCase() : s.toUpperCase(); });
  d('ASCII', (a) => { arity(a, 1); const s = str(a[0]); return int(s.length ? s.charCodeAt(0) : 0); });
  d('CHR', (a) => { arity(a, 1); const n = intv(a[0]); return n ? String.fromCharCode(n & 0xffff) : ''; });
  d('ITOA', (a) => { arity(a, 1); return String(intv(a[0])); });
  d('ATOI', (a) => { arity(a, 1); const m = str(a[0]).trim().match(/^[-+]?\d+/); return int(m ? parseInt(m[0], 10) : 0); });
  d('ATOF', (a) => { arity(a, 1); const m = str(a[0]).trim().match(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i); return m ? parseFloat(m[0]) : 0; });
  d('WCMATCH', (a) => { arity(a, 2); return bool(wcmatch(str(a[0]), str(a[1]))); });
  const sysv = async (L, name, dflt) => { try { const v = await L.host?.getvar?.(name); return v === null || v === undefined ? dflt : v; } catch { return dflt; } };
  d('RTOS', async (a, L) => {
    arity(a, 1, 3);
    const v = num(a[0]);
    const mode = a.length > 1 && a[1] !== null ? intv(a[1]) : numVal(await sysv(L, 'LUNITS', int(2)));
    const prec = a.length > 2 && a[2] !== null ? intv(a[2]) : numVal(await sysv(L, 'LUPREC', int(4)));
    if (mode < 1 || mode > 5) throw new LispError('bad argument value: ' + show(a[1]));
    return rtos(v, mode, Math.max(0, Math.min(8, prec)), numVal(await sysv(L, 'DIMZIN', int(0))));
  });
  d('ANGTOS', async (a, L) => {
    arity(a, 1, 3);
    const v = num(a[0]);
    const mode = a.length > 1 && a[1] !== null ? intv(a[1]) : numVal(await sysv(L, 'AUNITS', int(0)));
    const prec = a.length > 2 && a[2] !== null ? intv(a[2]) : numVal(await sysv(L, 'AUPREC', int(0)));
    return angtos(v, mode, Math.max(0, Math.min(8, prec)));
  });
  d('DISTOF', async (a, L) => {
    arity(a, 1, 2);
    const mode = a.length > 1 && a[1] !== null ? intv(a[1]) : numVal(await sysv(L, 'LUNITS', int(2)));
    const s = str(a[0]).trim();
    if (mode === 1 || /e/i.test(s)) { const v = Number(s); return Number.isFinite(v) ? v : null; }
    return parseLength(s, mode === 2 || mode === 5 ? 4 : mode) ?? null;
  });
  d('ANGTOF', (a) => { arity(a, 1, 2); return angtof(str(a[0]), a.length > 1 && a[1] !== null ? intv(a[1]) : 0); });
  d('CVUNIT', (a) => {
    arity(a, 3);
    const from = UNIT[str(a[1]).trim().toLowerCase()], to = UNIT[str(a[2]).trim().toLowerCase()];
    if (!from || !to || from[0] !== to[0]) return null;
    const conv = (v) => v * from[1] / to[1];
    if (isNum(a[0])) return conv(numVal(a[0]));
    if (a[0] instanceof Cons) return fromArray(toArray(a[0]).map((x) => conv(num(x))));
    throw bad('numberp', a[0]);
  });

  // ---- output ----
  const toFile = (f, text) => { if (!(f instanceof LFile) || !f.open || f.mode === 'r') throw bad('filep', f); f.buf += text; };
  d('PRINC', (a, L) => { arity(a, 0, 2); if (!a.length) return ''; const s = show(a[0], false); if (a[1]) toFile(a[1], s); else L.out(s, true); return a[0]; });
  d('PRIN1', (a, L) => { arity(a, 0, 2); if (!a.length) return ''; const s = show(a[0], true); if (a[1]) toFile(a[1], s); else L.out(s, true); return a[0]; });
  d('PRINT', (a, L) => { arity(a, 0, 2); if (!a.length) return ''; const s = '\n' + show(a[0], true) + ' '; if (a[1]) toFile(a[1], s); else L.out(s, true); return a[0]; });
  d('TERPRI', (a, L) => { L.out('\n', true); return null; });
  d('PROMPT', (a, L) => { arity(a, 1); L.out(str(a[0]), true); return null; });

  // ---- geometry ----
  d('POLAR', (a) => { arity(a, 3); const p = pt(a[0]), ang = num(a[1]), dd = num(a[2]); const q = [p[0] + dd * Math.cos(ang), p[1] + dd * Math.sin(ang)]; if (p.length > 2) q.push(p[2]); return ptList(q); });
  d('DISTANCE', (a) => { arity(a, 2); const p = pt(a[0]), q = pt(a[1]); const dz = p.length > 2 && q.length > 2 ? p[2] - q[2] : 0; return Math.hypot(p[0] - q[0], p[1] - q[1], dz); });
  d('ANGLE', (a) => { arity(a, 2); const p = pt(a[0]), q = pt(a[1]); const v = Math.atan2(q[1] - p[1], q[0] - p[0]); return v < 0 ? v + Math.PI * 2 : v; });
  d('INTERS', (a) => {
    arity(a, 4, 5);
    const [p1, p2, p3, p4] = a.slice(0, 4).map(pt);
    const onseg = a.length < 5 || truthy(a[4]);
    const dx1 = p2[0] - p1[0], dy1 = p2[1] - p1[1], dx2 = p4[0] - p3[0], dy2 = p4[1] - p3[1];
    const den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-12 * (Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) || 1)) return null;
    const u = ((p3[0] - p1[0]) * dy2 - (p3[1] - p1[1]) * dx2) / den, v = ((p3[0] - p1[0]) * dy1 - (p3[1] - p1[1]) * dx1) / den;
    if (onseg && (u < -1e-10 || u > 1 + 1e-10 || v < -1e-10 || v > 1 + 1e-10)) return null;
    const q = [p1[0] + u * dx1, p1[1] + u * dy1];
    if (p1.length > 2 && p2.length > 2) q.push(p1[2] + u * (p2[2] - p1[2]));
    return ptList(q);
  });
  // CadCraft draws in the world coordinate system only, so every system TRANS knows is the same one
  d('TRANS', (a) => { arity(a, 3, 4); pt(a[0]); return a[0]; });

  // ---- environment ----
  const env = new Map();
  d('GETENV', (a) => { arity(a, 1); return env.get(str(a[0]).toUpperCase()) ?? null; });
  d('SETENV', (a) => { arity(a, 2); env.set(str(a[0]).toUpperCase(), str(a[1])); return a[1]; });

  // ---- files (in memory) ----
  d('FINDFILE', (a, L) => { arity(a, 1); const f = L.findFile(str(a[0])); return f ? f.name : null; });
  d('OPEN', (a, L) => {
    arity(a, 2, 3);
    const path = str(a[0]), mode = str(a[1]).toLowerCase()[0];
    if (!['r', 'w', 'a'].includes(mode)) throw new LispError('bad argument value: ' + show(a[1]));
    const f = L.findFile(path);
    if (mode === 'r' && !f) return null;
    const h = new LFile(f ? f.name : path, mode);
    if (mode === 'r') h.buf = f.text;
    else if (mode === 'a' && f) h.buf = f.text;
    return h;
  });
  d('CLOSE', (a, L) => { arity(a, 1); const f = a[0]; if (!(f instanceof LFile)) throw bad('filep', f); if (f.open && f.mode !== 'r') L.putFile(f.path, f.buf); f.open = false; return null; });
  d('READ-LINE', (a) => {
    arity(a, 0, 1);
    const f = a[0];
    if (!(f instanceof LFile) || f.mode !== 'r' || !f.open) return null;
    if (f.pos >= f.buf.length) return null;
    let nl = f.buf.indexOf('\n', f.pos);
    if (nl < 0) nl = f.buf.length;
    const line = f.buf.slice(f.pos, nl).replace(/\r$/, '');
    f.pos = nl + 1;
    return line;
  });
  d('READ-CHAR', (a) => { arity(a, 0, 1); const f = a[0]; if (!(f instanceof LFile) || f.mode !== 'r' || f.pos >= f.buf.length) return null; return int(f.buf.charCodeAt(f.pos++)); });
  d('WRITE-LINE', (a, L) => { arity(a, 1, 2); const s = str(a[0]); if (a[1]) toFile(a[1], s + '\n'); else L.out(s, true); return s; });
  d('WRITE-CHAR', (a, L) => { arity(a, 1, 2); const s = String.fromCharCode(intv(a[0])); if (a[1]) toFile(a[1], s); else L.out(s, true); return a[0]; });
  d('VL-FILENAME-MKTEMP', (a) => {
    const pat = a[0] ? str(a[0]) : '$VL~~', dir = a[1] ? str(a[1]).replace(/[\\/]$/, '') + '/' : 'temp/', ext = a[2] ? str(a[2]) : '';
    return dir + pat.replace(/\.[^.]*$/, '') + String(++tempN).padStart(3, '0') + (ext || (/\.[^.]*$/.exec(pat)?.[0] ?? ''));
  });
  d('VL-FILE-DELETE', (a, L) => { arity(a, 1); return bool(L.files.delete(Interp.norm(str(a[0])))); });
  d('VL-FILE-RENAME', (a, L) => { arity(a, 2); const f = L.findFile(str(a[0])); if (!f || L.findFile(str(a[1]))) return null; L.files.delete(Interp.norm(f.name)); L.putFile(str(a[1]), f.text); return T; });
  d('VL-FILE-SIZE', (a, L) => { arity(a, 1); const f = L.findFile(str(a[0])); return f ? int(f.text.length) : null; });
  d('VL-FILE-DIRECTORY-P', () => null);
  d('VL-FILENAME-BASE', (a) => { arity(a, 1); return str(a[0]).replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, ''); });
  d('VL-FILENAME-EXTENSION', (a) => { arity(a, 1); const m = str(a[0]).replace(/\\/g, '/').split('/').pop().match(/\.[^.]*$/); return m ? m[0] : null; });
  d('VL-FILENAME-DIRECTORY', (a) => { arity(a, 1); const s = str(a[0]); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i < 0 ? '' : s.slice(0, i); });
  d('LOAD', async (a, L) => {
    arity(a, 1, 2);
    const name = str(a[0]);
    const f = L.findFile(name) || L.findFile(name + '.lsp');
    if (!f) { if (a.length > 1) return a[1]; throw new LispError('LOAD failed: ' + show(name)); }
    let r = null;
    for (const form of readAll(f.text)) r = await L.eval(form);
    return r;
  });
}

