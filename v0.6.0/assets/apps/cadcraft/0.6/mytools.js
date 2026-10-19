/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mytools.js — buttons of your own (0.5 DR.9): the "My tools" groups on CadCraft's toolbar, kept in localStorage
 * `cadcraft.mytools`, exported and imported as JSON (and filled from a CUIx file by cuix.js). DOM-free.
 *
 *   { format: 'cadcraft-mytools', version: 1, groups: [{ name, tools: [{ id, label, macro, icon?, key? }] }] }
 *   icon = a data: URL of a PNG or an SVG (≤ 64 KB, checked by its bytes); macro = AutoCAD macro syntax (macro.js); key =
 *   a shortcut in shortcuts.js form (Ctrl+Shift+L), unique across every tool and never a reserved key.
 *
 *   cleanTools(v) → { data, errors[] }   untrusted data (a file, localStorage, a CUIx import) made safe; what is dropped is said
 *   emptyTools() · exportTools(data) → JSON text · mergeTools(data, groups) → data (imported groups added, names kept unique)
 *   checkIcon(dataUrl) → 'png' | 'svg' | null · iconFromBytes(bytes, name) → data URL | null · keyMap(data) → Map key → tool
 */
import { normKey, keyProblem } from './shortcuts.js';

export const MYTOOLS_KEY = 'cadcraft.mytools';
export const MYTOOLS_LIMITS = { groups: 50, tools: 500, label: 80, macro: 4000, name: 60, icon: 64 * 1024 };
export const emptyTools = () => ({ format: 'cadcraft-mytools', version: 1, groups: [] });

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

function bytesOfDataUrl(u) {
  const m = /^data:(image\/(?:png|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(u || '');
  if (!m) return null;
  try { const s = atob(m[2]); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return { type: m[1], b }; } catch { return null; }
}

/** 'png' / 'svg' when the data: URL holds a real PNG or SVG of at most 64 KB, else null. */
export function checkIcon(u) {
  if (typeof u !== 'string' || u.length > MYTOOLS_LIMITS.icon * 1.4 + 64) return null;
  const d = bytesOfDataUrl(u);
  if (!d || d.b.length > MYTOOLS_LIMITS.icon) return null;
  if (d.type === 'image/png') return d.b.length > 8 && d.b[0] === 0x89 && d.b[1] === 0x50 && d.b[2] === 0x4e && d.b[3] === 0x47 ? 'png' : null;
  const head = new TextDecoder().decode(d.b.subarray(0, 1024)).replace(/^﻿/, '').trim();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head) ? 'svg' : null;   // shown through <img>: scripts in it never run
}

/** A file picked for an icon → a data: URL, or null when it is not a PNG or an SVG of at most 64 KB. */
export function iconFromBytes(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > MYTOOLS_LIMITS.icon) return null;
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  const png = b[0] === 0x89 && b[1] === 0x50;
  const u = 'data:' + (png ? 'image/png' : 'image/svg+xml') + ';base64,' + btoa(s);
  void name;
  return checkIcon(u) ? u : null;
}

let seq = 0;
const newId = () => 't' + Date.now().toString(36) + (seq++).toString(36);

/** Untrusted → { data, errors: [{ key, fills }] }. */
export function cleanTools(v) {
  const errors = [];
  const data = emptyTools();
  if (!v || typeof v !== 'object' || v.format !== 'cadcraft-mytools' || !Array.isArray(v.groups)) { if (v) errors.push({ key: 'mytools.err.format' }); return { data, errors }; }
  const taken = new Map(), ids = new Set();
  let n = 0;
  for (const g of v.groups.slice(0, MYTOOLS_LIMITS.groups)) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.tools)) continue;
    const group = { name: clean(g.name, MYTOOLS_LIMITS.name) || 'My tools', tools: [] };   // i18n-ignore (a default group name kept as data)
    for (const t of g.tools) {
      if (++n > MYTOOLS_LIMITS.tools) { errors.push({ key: 'mytools.err.too_many' }); break; }
      if (!t || typeof t !== 'object') continue;
      const label = clean(t.label, MYTOOLS_LIMITS.label), macro = String(t.macro ?? '').slice(0, MYTOOLS_LIMITS.macro);
      if (!label || !macro.trim()) { errors.push({ key: 'mytools.err.tool', fills: { label: label || '?' } }); continue; }
      let id = typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(t.id) && !ids.has(t.id) ? t.id : newId();
      ids.add(id);
      const tool = { id, label, macro };
      if (t.icon !== undefined && t.icon !== null && t.icon !== '') { if (checkIcon(t.icon)) tool.icon = t.icon; else errors.push({ key: 'mytools.err.icon', fills: { label } }); }
      if (t.key) {
        const k = normKey(t.key), why = k ? keyProblem(k, taken) : 'format';
        if (why) errors.push({ key: 'mytools.err.key.' + why, fills: { label, key: String(t.key).slice(0, 40) } });
        else { tool.key = k; taken.set(k, id); }
      }
      group.tools.push(tool);
    }
    data.groups.push(group);
  }
  return { data, errors };
}

export const exportTools = (data) => JSON.stringify(cleanTools(data).data, null, 2) + '\n';

/** Imported groups added after the ones there (a name already used gets " (2)"); keys that would clash are dropped. */
export function mergeTools(data, groups) {
  const out = { ...emptyTools(), groups: [...(data?.groups || [])] };
  const names = new Set(out.groups.map((g) => g.name.toUpperCase()));
  for (const g of groups || []) {
    let name = clean(g.name, MYTOOLS_LIMITS.name) || 'My tools', k = 2;   // i18n-ignore (data)
    const base = name;
    while (names.has(name.toUpperCase())) name = base + ' (' + k++ + ')';
    names.add(name.toUpperCase());
    out.groups.push({ name, tools: g.tools });
  }
  // clean again: ids made unique, key clashes dropped with a note
  return cleanTools(out);
}

/** Every tool with a key: Map key → { tool, group }. */
export function keyMap(data) {
  const m = new Map();
  for (const g of data?.groups || []) for (const t of g.tools) if (t.key) m.set(t.key, { tool: t, group: g });
  return m;
}
