/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: error messages are the language's own wording (routines compare them), not UI; UI text goes through t(). */
/**
 * interp.js — CadCraft's LISP evaluator (0.4 part 2, Y.2; session cad-lisp). DOM-free; runs in a worker (worker.js) or,
 * in Node tests and where workers are unavailable, on the page. Clean room, from the public AutoLISP reference.
 *
 *   const L = new Interp({ host, out });     host: the drawing side (host-cad.js, or the worker's bridge to it)
 *   await L.loadText(text, 'name.lsp')       read + evaluate every form; returns the last value
 *   await L.evalText('(+ 1 2)')              the command line's "(…" and "!var"
 *   await L.callCommand('C:DELBLOCKS')       a (defun c:…) command, with *error* handling
 *   L.onDefun = (name) => …                  told when (defun c:NAME …) defines a command
 *
 * Semantics, as AutoLISP: one namespace (a symbol's value may be a function); DYNAMIC scope — a function's arguments
 * and its locals after "/" are bound while it runs and restored when it returns (or fails); nil is the empty list and
 * false; integers and reals differ ((/ 7 2) is 3). Errors reach the innermost *error* function that is bound when they
 * happen (so a local *error* works), unless vl-catch-all-apply is catching; with none, "; error: <message>" is printed.
 * The messages are AutoLISP's own wording ("bad argument type: numberp: nil"), because routines test them.
 */
import { Sym, sym, T, Cons, Lambda, Builtin, LispError, MSG_CANCEL, MSG_QUIT, toArray, show, truthy } from './types.js';
import { readAll } from './reader.js';
import { t } from '../i18n.js';

const SLASH = sym('/');
const LAMBDA = sym('LAMBDA');
const ERROR = sym('*ERROR*');

export class Interp {
  constructor({ host = null, out = () => {}, yieldEvery = 0 } = {}) {
    this.host = host;
    this.out = out;                  // (text) → printed on the command line (princ, prompt, error lines)
    this.globals = new Map();        // Sym → value
    this.files = new Map();          // in-memory files: normalised path → { name, text } (loaded applications, temp files)
    this.steps = 0;
    this.stopped = false;
    this.catching = 0;               // vl-catch-all-apply depth: errors are not handed to *error* while > 0
    this.inError = false;
    this.yieldEvery = yieldEvery;    // on the page: give the event loop a turn every n steps (Esc must get through)
    this.onDefun = null;
    this.missingSaid = new Set();
    this.set(T, T);
  }

  // ---- symbols ----
  get(s) { const v = this.globals.get(s); return v === undefined ? null : v; }
  set(s, v) { if (v === null || v === undefined) this.globals.delete(s); else this.globals.set(s, v); return v; }
  /** Define a built-in: fn(args, interp); special → fn(cdrOfForm, interp) gets the forms unevaluated. */
  def(name, fn, special = false) { this.globals.set(sym(name), new Builtin(name.toUpperCase(), fn, special)); }

  // ---- evaluation ----
  async eval(x) {
    if (x instanceof Sym) return this.get(x);
    if (!(x instanceof Cons)) return x;
    if ((++this.steps & 4095) === 0) await this.tick();
    const head = x.car;
    let f;
    if (head instanceof Sym) {
      f = this.globals.get(head);
      if (f === undefined) f = this.auto(head);
    } else if (head instanceof Cons) f = await this.eval(head);
    else throw new LispError('bad function: ' + show(head));
    if (f instanceof Builtin && f.special) return f.fn(x.cdr, this);
    const args = [];
    for (let l = x.cdr; l instanceof Cons; l = l.cdr) {
      const a = l.car;
      args.push(a instanceof Sym ? this.get(a) : a instanceof Cons ? await this.eval(a) : a);
    }
    return this.apply(f, args, head);
  }

  async tick() {
    if (this.stopped) throw new LispError(MSG_CANCEL, { cancel: true });
    if (this.yieldEvery && this.steps % this.yieldEvery < 4096) await new Promise((r) => setTimeout(r, 0));
  }

  /** A function made on first use (vla.js: every vla-get-<property>, vla-put-<property> and vla-<method>), else the error. */
  auto(s) {
    const f = this.autoFn?.(s.name);
    if (!f) throw this.noFunction(s);
    this.globals.set(s, f);
    return f;
  }

  noFunction(s) {
    const err = new LispError('no function definition: ' + s.name);
    if (!this.missingSaid.has(s.name)) {
      this.missingSaid.add(s.name);
      err.note = this.knownMissing?.(s.name) ? t('lisp.missing.known', { name: s.name }) : null;
    }
    return err;
  }

  /** A function value from what a routine passes: a function, a symbol naming one, or a quoted (lambda …) list. */
  fnOf(f) {
    if (f instanceof Sym) {
      const v = this.globals.get(f);
      return this.fnOf(v === undefined ? this.auto(f) : v);
    }
    if (f instanceof Cons) {
      if (f.car === LAMBDA) return this.makeLambda(null, f.cdr);
      return this.makeLambda(null, f);   // defun-q style: ((args / locals) body…)
    }
    if (f instanceof Lambda || f instanceof Builtin) return f;
    throw new LispError('bad function: ' + show(f));
  }

  makeLambda(name, rest) {
    if (!(rest instanceof Cons)) throw new LispError('bad argument list');
    const params = [], locals = [];
    let inLocals = false;
    for (const p of toArray(rest.car)) {
      if (p === SLASH) { inLocals = true; continue; }
      if (!(p instanceof Sym)) throw new LispError('bad argument list: ' + show(rest.car));
      (inLocals ? locals : params).push(p);
    }
    return new Lambda(name, params, locals, toArray(rest.cdr));
  }

  async apply(f, args, head = null) {
    if (!(f instanceof Lambda) && !(f instanceof Builtin)) {
      if (!(f instanceof Sym || f instanceof Cons)) throw new LispError('bad function: ' + show(head ?? f));
      f = this.fnOf(f);
    }
    if (f instanceof Builtin) {
      if (f.special) throw new LispError('bad function: ' + f.name);
      return f.fn(args, this);
    }
    if (args.length < f.params.length) throw new LispError('too few arguments');
    if (args.length > f.params.length) throw new LispError('too many arguments');
    const bound = f.params.length + f.locals.length;
    const saved = new Array(bound);
    let k = 0;
    for (const s of f.params) saved[k++] = this.globals.get(s);
    for (const s of f.locals) saved[k++] = this.globals.get(s);
    for (let i = 0; i < f.params.length; i++) this.set(f.params[i], args[i]);
    for (const s of f.locals) this.globals.delete(s);
    try {
      let r = null;
      for (const form of f.body) r = form instanceof Cons ? await this.eval(form) : form instanceof Sym ? this.get(form) : form;
      return r;
    } catch (err) {
      const e = this.lispError(err);
      if (!e.handled && !this.catching) await this.handleError(e);
      throw e;
    } finally {
      k = 0;
      for (const s of f.params) this.restore(s, saved[k++]);
      for (const s of f.locals) this.restore(s, saved[k++]);
    }
  }
  restore(s, v) { if (v === undefined) this.globals.delete(s); else this.globals.set(s, v); }

  /** Any thrown thing → a LispError (a host's cancel → "Function cancelled"). */
  lispError(err) {
    if (err instanceof LispError) return err;
    if (err && (err.name === 'Cancel' || err.cancel)) return new LispError(MSG_CANCEL, { cancel: true });
    const e = new LispError(String(err?.message || err));
    e.cause = err;
    return e;
  }

  /** Hand an error to *error* (or print it). Called once per error, where it happened. */
  async handleError(e) {
    e.handled = true;
    if (e.note) this.out(e.note);
    const h = this.globals.get(ERROR);
    if (this.inError || !(h instanceof Lambda || h instanceof Builtin || h instanceof Cons)) {
      this.out('; error: ' + e.message);
      return;
    }
    this.inError = true;
    try { await this.apply(h, [e.message]); }
    catch (e2) { const x = this.lispError(e2); if (x.message !== e.message) this.out('; error: ' + x.message); }
    finally { this.inError = false; }
  }

  /** Evaluate forms at the top level (load, the command line): an error goes to *error* if no function took it. */
  async top(forms) {
    let r = null;
    try {
      for (const f of forms) r = await this.eval(f);
      return { ok: true, value: r };
    } catch (err) {
      const e = this.lispError(err);
      if (!e.handled) await this.handleError(e);
      return { ok: false, error: e.message, cancel: !!e.cancel || e.message === MSG_QUIT };
    }
  }

  /** Read and evaluate a file's text. Reader errors are reported, nothing of the file runs. */
  async loadText(text, name = 'untitled.lsp') {
    let forms;
    try { forms = readAll(text); } catch (err) {
      const e = this.lispError(err);
      this.out('; error: ' + e.message + ' (' + name + ')');
      return { ok: false, error: e.message };
    }
    return this.top(forms);
  }

  async evalText(text) {
    let forms;
    try { forms = readAll(text); } catch (err) { const e = this.lispError(err); this.out('; error: ' + e.message); return { ok: false, error: e.message }; }
    return this.top(forms);
  }

  /** Run a (defun c:NAME …) command: the function called with no arguments, as typing its name does. */
  async callCommand(name) {
    const s = sym(name.toUpperCase().startsWith('C:') ? name : 'C:' + name);
    const f = this.globals.get(s);
    if (!(f instanceof Lambda || f instanceof Builtin || f instanceof Cons)) return { ok: false, error: 'no function definition: ' + s.name };
    return this.top([new Cons(s, null)]);
  }

  /** Names of the commands defined so far (C:NAME → NAME). */
  commands() {
    const out = [];
    for (const [s, v] of this.globals) if (s.name.startsWith('C:') && s.name.length > 2 && (v instanceof Lambda || v instanceof Cons)) out.push(s.name.slice(2));
    return out;
  }

  // ---- in-memory files (load, findfile, open, load_dialog) ----
  static norm(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }
  putFile(name, text) { this.files.set(Interp.norm(name), { name, text: String(text) }); }
  /** A file by path or by its name alone (any folder), case-insensitive. */
  findFile(name) {
    const n = Interp.norm(name);
    if (this.files.has(n)) return this.files.get(n);
    const base = n.split('/').pop();
    for (const [k, f] of this.files) if (k.split('/').pop() === base) return f;
    return null;
  }
}

/** Special forms (arguments unevaluated): quote function setq defun defun-q lambda if cond while repeat foreach progn
 * and or. Installed by builtins.js with the rest. */
export function installSpecials(L) {
  const sp = (name, fn) => L.def(name, fn, true);
  const forms = (l) => toArray(l);
  const run = async (body, L) => { let r = null; for (const f of body) r = await L.eval(f); return r; };
  sp('QUOTE', async (l) => (l instanceof Cons ? l.car : null));
  sp('FUNCTION', async (l, L) => { const x = l instanceof Cons ? l.car : null; return x instanceof Cons && x.car === LAMBDA ? L.makeLambda(null, x.cdr) : x instanceof Sym ? L.get(x) ?? x : x; });
  sp('SETQ', async (l, L) => {
    let r = null;
    while (l instanceof Cons) {
      const s = l.car;
      if (!(s instanceof Sym)) throw new LispError('bad argument type: symbolp: ' + show(s));
      if (!(l.cdr instanceof Cons)) throw new LispError('too few arguments');
      r = await L.eval(l.cdr.car);
      L.set(s, r);
      l = l.cdr.cdr;
    }
    return r;
  });
  const defun = async (l, L) => {
    const name = l instanceof Cons ? l.car : null;
    if (!(name instanceof Sym)) throw new LispError('bad argument type: symbolp: ' + show(name));
    L.set(name, L.makeLambda(name.name, l.cdr));
    if (name.name.startsWith('C:') && name.name.length > 2) L.onDefun?.(name.name.slice(2));
    return name;
  };
  sp('DEFUN', defun);
  sp('DEFUN-Q', defun);
  sp('LAMBDA', async (l, L) => L.makeLambda(null, l));
  sp('IF', async (l, L) => {
    const [test, then, ...rest] = forms(l);
    if (test === undefined || then === undefined) throw new LispError('too few arguments');
    if (rest.length > 1) throw new LispError('too many arguments');
    return truthy(await L.eval(test)) ? L.eval(then) : rest.length ? L.eval(rest[0]) : null;
  });
  sp('COND', async (l, L) => {
    for (const clause of forms(l)) {
      if (!(clause instanceof Cons)) throw new LispError('bad argument type: consp: ' + show(clause));
      const v = await L.eval(clause.car);
      if (truthy(v)) return clause.cdr === null ? v : run(forms(clause.cdr), L);
    }
    return null;
  });
  sp('WHILE', async (l, L) => {
    const [test, ...body] = forms(l);
    let r = null;
    while (truthy(await L.eval(test))) { r = await run(body, L); if ((++L.steps & 4095) === 0) await L.tick(); }
    return r;
  });
  sp('REPEAT', async (l, L) => {
    const [n, ...body] = forms(l);
    const c = await L.eval(n);
    if (!(c && typeof c === 'object' && 'v' in c)) throw new LispError('bad argument type: fixnump: ' + show(c));
    let r = null;
    for (let i = 0; i < c.v; i++) { r = await run(body, L); if ((++L.steps & 4095) === 0) await L.tick(); }
    return r;
  });
  sp('FOREACH', async (l, L) => {
    const [v, lst, ...body] = forms(l);
    if (!(v instanceof Sym)) throw new LispError('bad argument type: symbolp: ' + show(v));
    const items = await L.eval(lst);
    if (items !== null && !(items instanceof Cons)) throw new LispError('bad argument type: listp: ' + show(items));
    const old = L.globals.get(v);
    let r = null;
    try {
      for (let x = items; x instanceof Cons; x = x.cdr) { L.set(v, x.car); r = await run(body, L); }
    } finally { L.restore(v, old); }
    return r;
  });
  sp('PROGN', async (l, L) => run(forms(l), L));
  sp('AND', async (l, L) => { for (const f of forms(l)) if (!truthy(await L.eval(f))) return null; return T; });
  sp('OR', async (l, L) => { for (const f of forms(l)) if (truthy(await L.eval(f))) return T; return null; });
}
