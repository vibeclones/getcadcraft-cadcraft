/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dwg-autosave.js — autosave and crash recovery in CadCraft (0.4 item 1.2, on the shell's app-autosave.js). DOM-free:
 * the shell's "Recover your work?" dialog is the only page part, and bin/test-cadcraft.mjs runs this in Node.
 *
 *   const as = wireAutosave({ autosave, doc, tabs, view, open })
 *     autosave = new Autosave({ app: 'cadcraft' }) (app-autosave.js); doc, tabs (doctabs.js), view (paneState) as in
 *     cadcraft.js; open(file, meta) reopens a recovered copy (throws when it cannot).
 *   as.offer()       at start: the shell's dialog for copies a stopped page left behind
 *   as.sweep()       called on a timer (and by tests): drawings saved or undone back since → their copy goes; closed
 *                    tabs → their copy goes
 *   as.recover(rec)  what the dialog's Recover does with one copy (load()ed, with its data)
 *   as.handles       Map(tab id → the autosave doc)
 *
 * Each drawing tab is one document. Its copy is the drawing as a DWG 2018 file (dwg-save.js: what CadCraft keeps of a
 * drawing, its sheets, constraints, 3D model and split screen), written a moment after edits stop; meta keeps its name,
 * the file it came from and its save format, so a recovered drawing saves like the original and is marked unsaved.
 */

import { saveDwg } from './dwg-save.js';

export function wireAutosave({ autosave, doc, tabs, view = null, open }) {
  const handles = new Map();   // tab id → AutosaveDoc
  const pending = new Set();   // tab ids with a copy written since their last save

  const handle = (id) => {
    let h = handles.get(id);
    if (!h) {
      h = autosave.doc({ id: 'tab' + id, name: tabs.docOf(id).meta.name || 'Drawing1', snapshot: () => snapshot(id) });
      handles.set(id, h);
    }
    return h;
  };

  async function snapshot(id) {
    const d = tabs.docOf(id);
    if (!d || !d.dirty) return null;
    if (id === tabs.active && view?.paneState) d.vports = view.paneState();
    const { bytes } = saveDwg(d, { version: '2018' });
    const m = d.meta;
    return { data: bytes, meta: { name: m.name || 'Drawing1', source: m.source || '', saveFormat: m.saveFormat || '', dwgVersion: m.dwgVersion || '', format: m.format || '' } };
  }

  // every edit of the open drawing (doc.change, undo, redo) marks its tab; saving (markSaved) or a switch does not
  doc.on((kind) => {
    if (kind === 'load' || !doc.dirty) return;
    const id = tabs.active, h = handle(id);
    h.rename(doc.meta.name || 'Drawing1');
    h.changed();
    pending.add(id);
  });

  function sweep() {
    const open = new Set(tabs.list.map((r) => r.id));
    for (const [id, h] of handles) {
      if (!open.has(id)) { h.close(); handles.delete(id); pending.delete(id); continue; }
      if (pending.has(id) && !tabs.docOf(id).dirty) { h.clean(); pending.delete(id); }   // saved, or undone back to the file
    }
  }
  const timer = typeof setInterval === 'function' ? setInterval(sweep, 1500) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  function offer() { return autosave.offer({ onRecover: recover }); }
  async function recover(rec) {
    const data = rec.data;
    if (!data || !(data.byteLength > 0)) throw new Error('This copy is empty.');   // i18n-ignore: the shell's dialog shows it for a damaged copy
    const meta = rec.meta || {};
    const name = String(meta.name || rec.name || 'Drawing1').slice(0, 255);
    const file = typeof File === 'function' ? new File([data], name + '.dwg') : { name: name + '.dwg', size: data.byteLength, arrayBuffer: async () => data };
    await open(file, { name, source: String(meta.source || ''), ...(meta.saveFormat ? { saveFormat: meta.saveFormat } : {}), ...(meta.dwgVersion ? { dwgVersion: meta.dwgVersion } : {}), ...(meta.format ? { format: meta.format } : {}) });
  }

  return { handles, sweep, offer, recover, stop: () => timer && clearInterval(timer) };
}
