/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: protocol errors for developers. */
/**
 * worker.js — CadCraft's LISP in a Worker (0.4 part 2, Y.2; session cad-lisp). Started by client.js from blob: copies of
 * the lisp modules (a worker does not see the page's import map). The interpreter runs here; every drawing call is a
 * message to the page, which answers with host-cad.js. Stop = the page terminates this worker.
 *
 * Page → worker:  { t: 'init', catalog } · { t: 'run', id, op: 'load' | 'eval' | 'call' | 'putFile', name, text } ·
 *                 { t: 'reply', id, value | error: { message, cancel } }
 * Worker → page:  { t: 'ready' } · { t: 'out', s } · { t: 'defun', name } · { t: 'call', id, method, args } ·
 *                 { t: 'done', id, res: { ok, error, cancel, text, silent } }
 */
import { createLisp } from './runtime.js';
import { show } from './types.js';
import { init } from '../i18n.js';

let L = null;
let seq = 0;
const waiting = new Map();

/** The drawing side: every method is a message to the page and its answer. */
const host = new Proxy({}, {
  get: (_, method) => (typeof method !== 'string' || method === 'then' ? undefined : (...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    self.postMessage({ t: 'call', id, method, args });
  })),
});

const plain = (res) => ({ ok: res.ok, error: res.error, cancel: res.cancel, text: res.ok ? show(res.value) : undefined, silent: res.ok && res.value === '' });

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.t === 'init') {
    if (m.catalog) init(m.catalog);
    L = createLisp({ host, out: (s) => self.postMessage({ t: 'out', s: String(s) }) });
    L.onDefun = (name) => self.postMessage({ t: 'defun', name });
    return;
  }
  if (m.t === 'reply') {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) { const err = new Error(m.error.message); if (m.error.cancel) { err.cancel = true; err.name = 'Cancel'; } w.reject(err); }
    else w.resolve(m.value);
    return;
  }
  if (m.t === 'run') {
    let res;
    try {
      if (m.op === 'putFile') { L.putFile(m.name, m.text); res = { ok: true }; }
      else if (m.op === 'load') { L.putFile(m.name, m.text); res = plain(await L.loadText(m.text, m.name)); }
      else if (m.op === 'eval') res = plain(await L.evalText(m.text));
      else if (m.op === 'call') res = plain(await L.callCommand(m.name));
      else res = { ok: false, error: 'unknown op' };
    } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    self.postMessage({ t: 'done', id: m.id, res });
  }
};
self.postMessage({ t: 'ready' });
