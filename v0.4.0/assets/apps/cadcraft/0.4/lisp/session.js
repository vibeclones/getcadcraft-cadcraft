/* SPDX-License-Identifier: Apache-2.0 */
/**
 * session.js — one LISP session per CadCraft window (0.4 part 2, Y.1–Y.4; session cad-lisp). DOM-free.
 *
 * Holds the loaded applications, the commands their (defun c:…) made, and the runner that evaluates LISP: a worker
 * (client.js, in the browser — Esc can stop a routine that loops) or, in Node and where workers are not available,
 * the interpreter on this thread (runtime.js). Either way the drawing side is host-cad.js's CadHost, and everything
 * runs inside an Engine command, so a routine is one undo step and its prompts are the command line's.
 *
 *   const s = sessionFor(engine, { lookup, onCommands })      one per Engine
 *   await s.load(name, text, c)      load a file's text (APPLOAD); its new commands are reported to onCommands
 *   await s.evalText('(+ 1 2)', c)   the command line's "(…" and "!symbol"
 *   await s.call('DELBLOCKS', c)     run a (defun c:…) command
 *   s.unload(name) · s.loaded · s.commandsOf(name) · s.stop()
 */
import { CadHost } from './host-cad.js';
import { show } from './types.js';
import { t } from '../i18n.js';

const SESSIONS = new WeakMap();

/** The session of this Engine (made on first use). */
export function sessionFor(engine, opts = {}) {
  let s = SESSIONS.get(engine);
  if (!s) { s = new LispSession(engine, opts); SESSIONS.set(engine, s); }
  return s;
}

/** The command line's text buffer: princ writes pieces, lines go to the history when they end (or before a prompt). */
export class OutBuffer {
  constructor(print) { this.print = print; this.buf = ''; }
  write(s) {
    this.buf += String(s);
    const parts = this.buf.split('\n');
    this.buf = parts.pop();
    for (const line of parts) if (line.length) this.print(line.replace(/\r$/, ''));
  }
  flush() { if (this.buf.length) { this.print(this.buf); this.buf = ''; } }
}

export class LispSession {
  constructor(engine, { lookup = null, onCommands = null, isLispCommand = null, runner = null } = {}) {
    this.engine = engine;
    this.loaded = new Map();      // name → { name, text, kind, commands: [] }
    this.defined = new Map();     // command name → file name that defined it
    this.onCommands = onCommands; // (added names, removed names) → register / unregister with the Engine
    this.out = new OutBuffer((s) => engine.host.print(s));
    this.cad = new CadHost({ doc: engine.doc, engine, lookup, isLispCommand: isLispCommand || ((n) => this.defined.has(n)) });
    this.cad.beforeInput = () => this.out.flush();
    this.runner = runner;         // set by start(): { load, eval, call, putFile, stop, reset }
    this.runnerFactory = null;    // (session) → Promise<runner>: the page sets a worker runner (client.js)
    this.busy = false;
    this.loading = null;          // the file whose forms are being evaluated (its defuns belong to it)
  }

  /** The runner: a worker client when one was handed in (client.js), else the interpreter here. */
  async start() {
    if (this.runner) return this.runner;
    if (this.runnerFactory) {   // the page: a worker (client.js); if it can't start, the interpreter here
      try { this.runner = await this.runnerFactory(this); return this.runner; }
      catch (err) { console.warn('LISP: running on the page instead of in a worker:', err?.message || err); this.runnerFactory = null; }
    }
    const { createLisp } = await import('./runtime.js');
    const L = createLisp({ host: this.cad, out: (s) => this.out.write(s), yieldEvery: typeof window !== 'undefined' ? 20000 : 0 });
    L.onDefun = (name) => this.defun(name);
    this.interp = L;
    // results as the worker sends them: { ok, error, cancel, text (the value printed), silent ((princ) returned nothing) }
    const plain = (res) => ({ ok: res.ok, error: res.error, cancel: res.cancel, text: res.ok ? show(res.value) : undefined, silent: res.ok && res.value === '' });
    this.runner = {
      load: async (name, text) => { L.putFile(name, text); return plain(await L.loadText(text, name)); },
      eval: async (text) => plain(await L.evalText(text)),
      call: async (name) => plain(await L.callCommand(name)),
      putFile: (name, text) => L.putFile(name, text),
      stop: () => { L.stopped = true; },
      reset: () => { L.stopped = false; },
    };
    return this.runner;
  }

  defun(name) {
    const n = name.toUpperCase();
    const owner = this.loading || t('lisp.owner.cmdline');
    const before = this.defined.get(n);
    this.defined.set(n, owner);
    if (before !== owner) this.onCommands?.([n], []);
    const f = this.loaded.get(owner);
    if (f && !f.commands.includes(n)) f.commands.push(n);
  }

  async run(job) {
    const r = await this.start();
    this.busy = true;
    r.reset?.();
    this.cad.engine = this.engine;
    try { return await job(r); }
    finally { this.busy = false; this.out.flush(); }
  }

  /** Load a file's text (kind: 'lsp' | 'dcl'); a .dcl only goes into the session's files for load_dialog. */
  async load(name, text, kind = 'lsp') {
    const old = this.loaded.get(name);
    const entry = { name, text, kind, commands: old ? old.commands : [] };
    this.loaded.set(name, entry);
    if (kind === 'dcl') { await this.start(); this.runner.putFile(name, text); return { ok: true, commands: [] }; }
    const before = new Set(entry.commands);
    const res = await this.run(async (r) => { this.loading = name; try { return await r.load(name, text); } finally { this.loading = null; } });
    const added = entry.commands.filter((c) => !before.has(c));
    return { ...res, commands: entry.commands.slice(), added };
  }

  /** Forget a loaded file and the commands it made. */
  unload(name) {
    const f = this.loaded.get(name);
    if (!f) return [];
    this.loaded.delete(name);
    const gone = f.commands.filter((c) => this.defined.get(c) === name);
    for (const c of gone) this.defined.delete(c);
    if (gone.length) this.onCommands?.([], gone);
    return gone;
  }

  commandsOf(name) { return this.loaded.get(name)?.commands.slice() || []; }

  async evalText(text) {
    const res = await this.run((r) => r.eval(text));
    if (res.ok) this.out.write('\n' + res.text + '\n');
    return res;
  }

  async call(name) {
    const res = await this.run((r) => r.call(name));
    // a command's value is echoed, as typing it does; (princ) at the end returns nothing to echo
    if (res.ok && !res.silent) this.out.write('\n' + res.text + '\n');
    // a command the routine started and left running: the person finishes it
    if (this.cad.nested) await this.cad.nested.promise;
    return res;
  }

  stop() { if (this.runner) this.runner.stop(); this.out.write('\n' + t('lisp.stopped') + '\n'); }
}
