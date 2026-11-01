/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: LISP data, printed forms and error texts are the language's own (routines compare them), not UI. */
/**
 * types.js — the values of CadCraft's LISP (0.4 part 2, track Y; session cad-lisp). DOM-free, import-free.
 *
 * Written clean room from the public AutoLISP reference: no one's interpreter source was read.
 *
 *   nil          JS null (the empty list and false)        T            the symbol T
 *   integer      Int {v} (32-bit, boxed so 2 and 2.0 differ)  real      a JS number
 *   string       a JS string                               symbol       Sym {name} (upper case, interned)
 *   list         Cons {car, cdr}                           entity name  Ename {id} (id: number, or 'b:<block>:<i>')
 *   selection    PickSet {ids[]}                           function     Lambda (defun / lambda) · Builtin
 *   file         LFile                                     VLA object   VlaObject (vla.js) · variant / safearray
 */

export class LispError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'LispError'; Object.assign(this, extra); }
}
/** (exit) / (quit) and a cancelled prompt: *error* hears these messages as AutoLISP's own. */
export const MSG_CANCEL = 'Function cancelled';
export const MSG_QUIT = 'quit / exit abort';

export class Sym {
  constructor(name) { this.name = name; }
  toString() { return this.name; }
}
const SYMS = new Map();
/** The symbol with this name (case-insensitive, as AutoLISP). */
export function sym(name) {
  const u = String(name).toUpperCase();
  let s = SYMS.get(u);
  if (!s) { s = new Sym(u); SYMS.set(u, s); }
  return s;
}
export const T = sym('T');
export const QUOTE = sym('QUOTE');

export class Int {
  constructor(v) { this.v = v | 0; }
  valueOf() { return this.v; }
}
const SMALL = [];
for (let i = -256; i <= 1024; i++) SMALL[i + 256] = new Int(i);
/** An integer (wrapped to 32 bits, as AutoLISP's). */
export function int(v) {
  const n = v | 0;
  return n >= -256 && n <= 1024 ? SMALL[n + 256] : new Int(n);
}

export class Cons {
  constructor(car, cdr) { this.car = car; this.cdr = cdr; }
}
export const cons = (a, b) => new Cons(a, b);

export class Ename {
  constructor(id) { this.id = id; }
}
export class PickSet {
  constructor(ids = []) { this.ids = ids; this.n = ++PickSet.count; }
}
PickSet.count = 0;

/** A function made by defun or lambda: params, locals (after "/"), body (array of forms). */
export class Lambda {
  constructor(name, params, locals, body) { this.name = name; this.params = params; this.locals = locals; this.body = body; }
}
/** A built-in function: fn(args, interp) → value or Promise. `special` = gets its arguments unevaluated. */
export class Builtin {
  constructor(name, fn, special = false) { this.name = name; this.fn = fn; this.special = special; }
}
/** An open file (open / read-line / write-line / close), backed by the interpreter's in-memory files. */
export class LFile {
  constructor(path, mode) { this.path = path; this.mode = mode; this.pos = 0; this.open = true; this.buf = ''; }
}

// ---- numbers ----
export const isNum = (x) => typeof x === 'number' || x instanceof Int;
export const numVal = (x) => (x instanceof Int ? x.v : x);
export const isInt = (x) => x instanceof Int;

// ---- lists ----
export function list(...xs) { let r = null; for (let i = xs.length - 1; i >= 0; i--) r = new Cons(xs[i], r); return r; }
export function fromArray(xs, tail = null) { let r = tail; for (let i = xs.length - 1; i >= 0; i--) r = new Cons(xs[i], r); return r; }
/** A proper list → array (a dotted tail is dropped; use isProper first when it matters). */
export function toArray(l) { const out = []; while (l instanceof Cons) { out.push(l.car); l = l.cdr; } return out; }
export function isProper(l) { while (l instanceof Cons) l = l.cdr; return l === null; }
export const isList = (x) => x === null || x instanceof Cons;
export const truthy = (x) => x !== null && x !== undefined && x !== false;
export const bool = (b) => (b ? T : null);

// ---- printing (prin1 / princ forms) ----
/** A real as AutoLISP prints it: six significant digits, always with a decimal point ("3.0", "1.12346", "1.0e+007"). */
export function realText(x) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? '-1.#IND' : x > 0 ? '1.#INF' : '-1.#INF';
  if (x === 0) return '0.0';
  // C's %g with 6 significant digits, then a decimal point always: 3.0, 1.12346, 1.23457e+006, 1.0e-005
  const [m0, e0] = x.toExponential(5).split('e');
  const ex = +e0;
  if (ex < -4 || ex >= 6) {
    const m = m0.replace(/0+$/, '').replace(/\.$/, '.0');
    return m + 'e' + (ex < 0 ? '-' : '+') + String(Math.abs(ex)).padStart(3, '0');
  }
  let s = x.toFixed(Math.max(0, 5 - ex));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0');
  else s += '.0';
  return s;
}
const ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x1b': '\\e' };
/** Any value as text; `readable` = prin1 (strings quoted), else princ. */
export function show(x, readable = true, depth = 0) {
  if (depth > 200) return '...';
  if (x === null || x === undefined) return 'nil';
  if (x === true) return 'T';
  if (typeof x === 'number') return realText(x);
  if (x instanceof Int) return String(x.v);
  if (typeof x === 'string') return readable ? '"' + x.replace(/[\\"\n\r\t\x1b]/g, (c) => ESC[c]) + '"' : x;
  if (x instanceof Sym) return x.name;
  if (x instanceof Cons) {
    if (x.car === QUOTE && x.cdr instanceof Cons && x.cdr.cdr === null) return "'" + show(x.cdr.car, readable, depth + 1);
    const parts = [];
    let l = x, n = 0;
    while (l instanceof Cons) { parts.push(show(l.car, readable, depth + 1)); l = l.cdr; if (++n > 100000) { parts.push('...'); l = null; break; } }
    return '(' + parts.join(' ') + (l !== null ? ' . ' + show(l, readable, depth + 1) : '') + ')';
  }
  if (x instanceof Ename) return '<Entity name: ' + (typeof x.id === 'number' ? (0x7ff700000000 + x.id * 16).toString(16) : x.id) + '>';
  if (x instanceof PickSet) return '<Selection set: ' + x.n + '>';
  if (x instanceof Lambda) return '#<USUBR @' + (x.name ? x.name : 'lambda') + '>';
  if (x instanceof Builtin) return '#<SUBR @' + x.name + '>';
  if (x instanceof LFile) return '#<file "' + x.path + '">';
  if (typeof x.show === 'function') return x.show();
  return String(x);
}

/** AutoLISP's (type x) symbol name. */
export function typeName(x) {
  if (x === null || x === undefined) return null;
  if (x instanceof Int) return 'INT';
  if (typeof x === 'number') return 'REAL';
  if (typeof x === 'string') return 'STR';
  if (x instanceof Sym) return 'SYM';
  if (x instanceof Cons) return 'LIST';
  if (x instanceof Ename) return 'ENAME';
  if (x instanceof PickSet) return 'PICKSET';
  if (x instanceof Lambda) return 'USUBR';
  if (x instanceof Builtin) return x.special ? 'SUBR' : 'SUBR';
  if (x instanceof LFile) return 'FILE';
  if (typeof x.lispType === 'string') return x.lispType;
  return 'SYM';
}
