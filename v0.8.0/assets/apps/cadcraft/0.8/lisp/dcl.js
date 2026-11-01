/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: DCL keywords and the language's own error words; a dialog's own text comes from the routine. */
/**
 * dcl.js — dialog files (DCL) for LISP routines (0.4 part 2, Y.10; session cad-lisp). DOM-free.
 * Parses .dcl text into tile trees and adds the dialog functions; the page shows a tree as an in-page dialog
 * (dcl-ui.js) and the Node tests answer with a script. Clean room, from the public DCL reference.
 *
 *   parseDcl(text) → Map name → { type, attrs, children }      resolveTile(defs, name) → the tree with references expanded
 *   load_dialog unload_dialog new_dialog start_dialog done_dialog term_dialog action_tile set_tile get_tile get_attr
 *   mode_tile start_list add_list end_list client_data_tile dimx_tile dimy_tile start_image fill_image vector_image
 *   slide_image end_image
 *
 * The host (plain data, so it works across the worker boundary):
 *   dialogOpen(tree) → { ok } · dialogOp(op, …) for set / get / attr / mode / list / done / client
 *   dialogRun() → { event: { key, value, reason } } (a tile was used) | { done: status } (the dialog closed)
 * An event runs the tile's action_tile text with $key $value $reason $data bound. "accept" and "cancel" without an
 * action close the dialog with 1 and 0, as DCL's ok_cancel does.
 */
import { sym, int, LispError, fromArray } from './types.js';
import { readAll } from './reader.js';
import { arity, str, intv } from './builtins.js';

// ---- parser ----
function tokens(text) {
  const out = [];
  const s = String(text);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"') {
      let v = '';
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) { const e = s[i + 1]; v += e === 'n' ? '\n' : e === 't' ? '\t' : e; i += 2; } else v += s[i++];
      }
      i++;
      out.push({ t: 'str', v });
      continue;
    }
    if (':{};=,'.includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === '@') { let j = i + 1; while (j < s.length && /\w/.test(s[j])) j++; out.push({ t: 'at', v: s.slice(i + 1, j) }); i = j; continue; }
    let j = i;
    while (j < s.length && /[\w.+-]/.test(s[j])) j++;
    if (j === i) throw new LispError('DCL: unexpected "' + c + '"');
    const w = s.slice(i, j);
    out.push(/^[-+]?(\d+\.?\d*|\.\d+)$/.test(w) ? { t: 'num', v: +w } : { t: 'id', v: w });
    i = j;
  }
  return out;
}

export function parseDcl(text) {
  const tk = tokens(text);
  let i = 0;
  const peek = (k = 0) => tk[i + k];
  const take = (t) => { const x = tk[i]; if (!x || (t && x.t !== t)) throw new LispError('DCL: expected ' + t + ' near ' + (x ? (x.v ?? x.t) : 'the end')); i++; return x; };
  const value = () => {
    const x = take();
    if (x.t === 'str' || x.t === 'num') return x.v;
    if (x.t === 'id') return x.v.toLowerCase() === 'true' ? true : x.v.toLowerCase() === 'false' ? false : x.v;
    throw new LispError('DCL: bad value');
  };
  const body = () => {
    const attrs = {}, children = [];
    take('{');
    while (peek() && peek().t !== '}') {
      const x = peek();
      if (x.t === ';') { i++; continue; }
      if (x.t === ':') {   // : type { … }
        i++;
        const type = take('id').v;
        const kid = peek()?.t === '{' ? body() : { attrs: {}, children: [] };
        children.push({ type, ...kid });
        continue;
      }
      if (x.t === 'id' && peek(1)?.t === '=') { i += 2; attrs[x.v.toLowerCase()] = value(); if (peek()?.t === ';') i++; continue; }
      if (x.t === 'id' && peek(1)?.t === ':') {   // name : type { … } inside a body (a named child)
        i += 2;
        const type = take('id').v;
        const kid = peek()?.t === '{' ? body() : { attrs: {}, children: [] };
        children.push({ type, name: x.v, ...kid });
        continue;
      }
      if (x.t === 'id') { i++; children.push({ ref: x.v }); if (peek()?.t === ';') i++; continue; }
      throw new LispError('DCL: unexpected ' + (x.v ?? x.t));
    }
    take('}');
    return { attrs, children };
  };
  const defs = new Map();
  while (i < tk.length) {
    const x = peek();
    if (x.t === 'at') { i++; if (peek()?.t === 'str') i++; if (peek()?.t === ';') i++; continue; }
    if (x.t === ';') { i++; continue; }
    const name = take('id').v;
    take(':');
    const type = take('id').v;
    const b = peek()?.t === '{' ? body() : { attrs: {}, children: [] };
    defs.set(name, { type, ...b });
  }
  return defs;
}

const BUTTON = (key, label, extra = {}) => ({ type: 'button', attrs: { key, label, ...extra }, children: [] });
export const PREDEFINED = {
  ok_only: () => ({ type: 'row', attrs: { alignment: 'centered' }, children: [BUTTON('accept', 'OK', { is_default: true, is_cancel: true })] }),
  ok_cancel: () => ({ type: 'row', attrs: { alignment: 'centered' }, children: [BUTTON('accept', 'OK', { is_default: true }), BUTTON('cancel', 'Cancel', { is_cancel: true })] }),
  ok_cancel_help: () => ({ type: 'row', attrs: { alignment: 'centered' }, children: [BUTTON('accept', 'OK', { is_default: true }), BUTTON('cancel', 'Cancel', { is_cancel: true }), BUTTON('help', 'Help...')] }),
  ok_cancel_help_info: () => ({ type: 'row', attrs: { alignment: 'centered' }, children: [BUTTON('accept', 'OK', { is_default: true }), BUTTON('cancel', 'Cancel', { is_cancel: true }), BUTTON('help', 'Help...'), BUTTON('info', 'Info...')] }),
  ok_cancel_help_errtile: () => ({ type: 'column', attrs: {}, children: [PREDEFINED.ok_cancel_help(), { type: 'errtile', attrs: { key: 'error' }, children: [] }] }),
  ok_button: () => BUTTON('accept', 'OK', { is_default: true }),
  cancel_button: () => BUTTON('cancel', 'Cancel', { is_cancel: true }),
  help_button: () => BUTTON('help', 'Help...'),
  info_button: () => BUTTON('info', 'Info...'),
  errtile: () => ({ type: 'errtile', attrs: { key: 'error' }, children: [] }),
  spacer: () => ({ type: 'spacer', attrs: {}, children: [] }),
  spacer_0: () => ({ type: 'spacer', attrs: {}, children: [] }),
  spacer_1: () => ({ type: 'spacer', attrs: {}, children: [] }),
};
const BASE_TYPES = new Set(['dialog', 'row', 'column', 'boxed_row', 'boxed_column', 'radio_row', 'radio_column', 'boxed_radio_row', 'boxed_radio_column',
  'button', 'edit_box', 'list_box', 'popup_list', 'toggle', 'radio_button', 'text', 'text_part', 'paragraph', 'concatenation', 'slider', 'image',
  'image_button', 'spacer', 'errtile']);

/** The tile named `name` in `defs` with every reference and derived type expanded into base tiles. */
export function resolveTile(defs, name) {
  const expand = (node, depth) => {
    if (depth > 30) throw new LispError('DCL: tiles nested too deep');
    if (node.ref) {
      const r = node.ref;
      if (defs.has(r)) return expand({ ...defs.get(r) }, depth + 1);
      if (PREDEFINED[r]) return PREDEFINED[r]();
      throw new LispError('DCL: unknown tile ' + r);
    }
    let type = node.type, attrs = { ...node.attrs }, children = node.children || [];
    let guard = 0;
    while (!BASE_TYPES.has(type) && guard++ < 30) {
      if (PREDEFINED[type]) { const p = PREDEFINED[type](); type = p.type; attrs = { ...p.attrs, ...attrs }; children = [...p.children, ...children]; continue; }
      const proto = defs.get(type);
      if (!proto) { type = 'text'; break; }
      type = proto.type; attrs = { ...proto.attrs, ...attrs }; children = [...(proto.children || []), ...children];
    }
    return { type, attrs, children: children.map((c) => expand(c, depth + 1)) };
  };
  const def = defs.get(name);
  if (!def) return null;
  return expand({ ...def }, 0);
}

// ---- LISP functions ----
export function installDcl(L) {
  const d = (name, fn) => L.def(name, fn);
  const S = (L.dclState = { files: new Map(), next: 1, cur: null, list: null });
  const host = async (m, ...a) => {
    if (!L.host || typeof L.host[m] !== 'function') throw new LispError('no dialogs here');
    const r = await L.host[m](...a);
    if (r && typeof r === 'object' && r.error) throw new LispError(r.error);
    return r;
  };
  const cur = () => { if (!S.cur) throw new LispError('no dialog open'); return S.cur; };

  d('LOAD_DIALOG', (a, L) => {
    arity(a, 1);
    const name = str(a[0]);
    const f = L.findFile(name) || L.findFile(name + '.dcl');
    if (!f) return int(-1);
    try { const defs = parseDcl(f.text); const id = S.next++; S.files.set(id, { name: f.name, defs }); return int(id); }
    catch (err) { L.out('; error: ' + err.message); return int(-1); }
  });
  d('UNLOAD_DIALOG', (a) => { arity(a, 1); S.files.delete(intv(a[0])); return null; });
  d('NEW_DIALOG', async (a) => {
    arity(a, 2, 4);
    const file = S.files.get(intv(a[1]));
    if (!file) return null;
    const tree = resolveTile(file.defs, str(a[0]));
    if (!tree || tree.type !== 'dialog') return null;
    await host('dialogOpen', tree);
    S.cur = { actions: new Map(), dflt: typeof a[2] === 'string' ? a[2] : null, data: new Map(), status: null };
    return sym('T');
  });
  d('ACTION_TILE', (a) => { arity(a, 2); cur().actions.set(str(a[0]), str(a[1])); return sym('T'); });
  d('CLIENT_DATA_TILE', (a) => { arity(a, 2); cur().data.set(str(a[0]), str(a[1])); return null; });
  d('SET_TILE', async (a) => { arity(a, 2); cur(); await host('dialogOp', 'set', str(a[0]), str(a[1])); return a[1]; });
  d('GET_TILE', async (a) => { arity(a, 1); cur(); const r = await host('dialogOp', 'get', str(a[0])); return typeof r === 'string' ? r : null; });
  d('GET_ATTR', async (a) => { arity(a, 2); cur(); const r = await host('dialogOp', 'attr', str(a[0]), str(a[1])); return typeof r === 'string' ? r : null; });
  d('MODE_TILE', async (a) => { arity(a, 2); cur(); await host('dialogOp', 'mode', str(a[0]), intv(a[1])); return null; });
  d('START_LIST', (a) => { arity(a, 1, 3); cur(); S.list = { key: str(a[0]), op: a.length > 1 && a[1] !== null ? intv(a[1]) : 3, index: a.length > 2 && a[2] !== null ? intv(a[2]) : 0, items: [] }; return a[0]; });
  d('ADD_LIST', (a) => { arity(a, 1); if (!S.list) return null; const s = str(a[0]); S.list.items.push(s); return s; });
  d('END_LIST', async () => { const l = S.list; S.list = null; if (!l) return null; await host('dialogOp', 'list', l.key, l.op, l.index, l.items); return null; });
  d('DIMX_TILE', () => int(200));
  d('DIMY_TILE', () => int(100));
  for (const n of ['START_IMAGE', 'FILL_IMAGE', 'VECTOR_IMAGE', 'SLIDE_IMAGE', 'END_IMAGE']) d(n, (a) => a[a.length - 1] ?? null);
  d('DONE_DIALOG', async (a) => {
    arity(a, 0, 1);
    const c = cur();
    const status = a.length && a[0] !== null ? intv(a[0]) : c.lastKey === 'cancel' ? 0 : 1;
    c.status = status;
    await host('dialogOp', 'done', status);
    return fromArray([0, 0]);
  });
  d('TERM_DIALOG', async () => { if (S.cur) { await host('dialogOp', 'done', 0); S.cur = null; } return null; });
  d('START_DIALOG', async (a, L) => {
    arity(a, 0);
    const c = cur();
    const vars = ['$KEY', '$VALUE', '$REASON', '$DATA', '$X', '$Y'].map(sym);
    try {
      for (;;) {
        const r = await host('dialogRun');
        if (!r || r.done !== undefined) return int(r?.done ?? c.status ?? 0);
        const ev = r.event;
        if (!ev) continue;
        c.lastKey = ev.key;
        const action = c.actions.get(ev.key) ?? c.dflt;
        if (action === null || action === undefined) {
          if (ev.key === 'accept') { c.status = 1; await host('dialogOp', 'done', 1); }
          else if (ev.key === 'cancel') { c.status = 0; await host('dialogOp', 'done', 0); }
          continue;
        }
        const saved = vars.map((s) => L.globals.get(s));
        L.set(vars[0], ev.key); L.set(vars[1], String(ev.value ?? '')); L.set(vars[2], int(ev.reason ?? 1)); L.set(vars[3], c.data.get(ev.key) ?? null);
        L.set(vars[4], int(ev.x ?? 0)); L.set(vars[5], int(ev.y ?? 0));
        try { for (const form of readAll(action)) await L.eval(form); }
        finally { vars.forEach((s, k) => L.restore(s, saved[k])); }
      }
    } finally { S.cur = null; }
  });
}

