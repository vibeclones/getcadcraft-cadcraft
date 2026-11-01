/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: worker start-up errors for developers and the language's own "Function cancelled". */
/**
 * client.js — the page's side of the LISP worker (0.4 part 2, Y.2; session cad-lisp).
 *
 *   session.runnerFactory = workerRunner      (lisp/ui.js does this when the browser has workers)
 *
 * A runner with the session's interface (load / eval / call / putFile / stop / reset) that evaluates in a module Worker
 * built from blob: copies of the lisp modules, each fetched by import.meta.resolve — so the build's version-busted URLs
 * and its saved offline copy apply, as for cc-dwg's worker (dwg/read-async.js). The worker's drawing calls are answered
 * here by the session's CadHost. stop() terminates the worker (a routine stuck in a loop can't block Esc); the next run
 * starts a new one and loads the session's applications into it again, quietly.
 */
import { catalog } from '../i18n.js';

export async function workerRunner(session) {
  let w = null, booting = null, seq = 0, quiet = false;
  const runs = new Map();
  const cad = session.cad;

  async function boot() {
    const urls = await blobModules('lisp/worker.js');
    const worker = new Worker(urls.get('lisp/worker.js'), { type: 'module' });
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('the LISP worker did not start')), 15000);
      worker.addEventListener('message', function ready(e) { if (e.data?.t === 'ready') { clearTimeout(timer); worker.removeEventListener('message', ready); ok(); } });
      worker.addEventListener('error', (e) => { clearTimeout(timer); fail(new Error(e.message || 'the LISP worker failed to load')); }, { once: true });
    });
    worker.addEventListener('message', (e) => onMessage(worker, e.data || {}));
    worker.postMessage({ t: 'init', catalog: catalog() });
    w = worker;
    // a new worker after a stop: the session's applications again, without their output
    quiet = true;
    try {
      for (const f of session.loaded.values()) await send(f.kind === 'dcl' ? { op: 'putFile', name: f.name, text: f.text } : { op: 'load', name: f.name, text: f.text });
    } finally { quiet = false; }
    return worker;
  }
  const ensure = () => (w ? Promise.resolve(w) : (booting ||= boot().finally(() => { booting = null; })));

  async function onMessage(worker, m) {
    if (worker !== w) return;
    if (m.t === 'out') { if (!quiet) session.out.write(m.s); return; }
    if (m.t === 'defun') { if (!quiet) session.defun(m.name); return; }
    if (m.t === 'done') { const r = runs.get(m.id); if (r) { runs.delete(m.id); r(m.res); } return; }
    if (m.t === 'call') {
      let value = null, error = null;
      try {
        const fn = cad[m.method];
        value = typeof fn === 'function' ? await fn.apply(cad, m.args || []) : null;
      } catch (err) { error = { message: String(err?.message || err), cancel: !!(err && (err.name === 'Cancel' || err.cancel || err.message === 'Cancel')) }; }
      if (worker === w) worker.postMessage(error ? { t: 'reply', id: m.id, error } : { t: 'reply', id: m.id, value: value === undefined ? null : value });
    }
  }

  async function send(job) {
    const worker = w || (await ensure());
    return new Promise((resolve) => {
      const id = ++seq;
      runs.set(id, resolve);
      worker.postMessage({ t: 'run', id, ...job });
    });
  }

  await ensure();
  return {
    worker: true,
    load: (name, text) => send({ op: 'load', name, text }),
    eval: (text) => send({ op: 'eval', text }),
    call: (name) => send({ op: 'call', name }),
    putFile: (name, text) => send({ op: 'putFile', name, text }),
    reset: () => {},
    stop: () => {
      if (!w) return;
      w.terminate();
      w = null;
      for (const [id, r] of runs) { runs.delete(id); r({ ok: false, cancel: true, error: 'Function cancelled' }); }
    },
  };
}

/** The worker and the modules it imports as blob: URLs (relative imports rewritten), keyed by path from the build root. */
async function blobModules(entry) {
  const urls = new Map(), texts = new Map();
  const base = new URL('../', import.meta.url);   // the build's root
  const visit = async (file, stack) => {
    if (urls.has(file)) return urls.get(file);
    if (stack.includes(file)) throw new Error('import cycle at ' + file);
    if (!texts.has(file)) {
      const res = await fetch(import.meta.resolve(new URL(file, base).href));
      if (!res.ok) throw new Error('could not load ' + file + ' (' + res.status + ')');
      texts.set(file, await res.text());
    }
    let src = texts.get(file);
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    // real imports use single quotes; comments write paths in double quotes, so they are not followed (the house rule)
    const specs = [...new Set([...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)'(\.{1,2}\/[\w./-]+\.js)'/g)].map((m) => m[1]))];
    for (const spec of specs) {
      const target = new URL(spec, new URL(dir, 'http://x/')).pathname.slice(1);
      const u = await visit(target, [...stack, file]);
      src = src.split("'" + spec + "'").join("'" + u + "'");
    }
    const u = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    urls.set(file, u);
    return u;
  };
  await visit(entry, []);
  return urls;
}
