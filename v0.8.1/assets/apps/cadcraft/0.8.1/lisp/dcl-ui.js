/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dcl-ui.js — a routine's dialog (DCL, dcl.js) as an in-page dialog (0.4 part 2, Y.10; session cad-lisp).
 *
 *   const d = dclDialogs({ root, el, focusCommandLine });   then the session's CadHost gets d.open / d.op / d.run
 *
 * Tiles: dialog, row / column (boxed, radio), button, edit_box, list_box, popup_list, toggle, radio_button, text,
 * text_part, paragraph, concatenation, slider, image / image_button (a blank frame), spacer, errtile. Every text in it
 * is the routine's and goes in as text, never HTML. Events go back to the routine one at a time (run()):
 * a button press, Enter in an edit box or leaving it (and typing, after a pause), a list pick (double-click = reason 4),
 * a toggle or radio change, a slider move. Enter on the dialog presses the default button; Esc presses cancel.
 * Values as DCL has them: an edit box its text, a list box "0 2" (indices), a popup list "1", a toggle "1"/"0",
 * a radio row/column the key of the chosen button.
 */

export function dclDialogs({ root, el, focusCommandLine = () => {} }) {
  let cur = null;   // { dlg, tiles: Map key → { node, tree, get, set, list, mode }, queue, waiter, done }
  let closedWith = null;   // the status done_dialog closed the last dialog with (start_dialog's next run() returns it)

  function build(tree, tiles, group = null) {
    const a = tree.attrs || {};
    const label = a.label != null ? String(a.label) : '';
    const kids = () => (tree.children || []).map((c) => build(c, tiles, tree.type.includes('radio') ? (a.key || '__radio' + tiles.size) : group));
    const key = a.key != null ? String(a.key) : null;
    const width = Number(a.width) > 0 ? Math.min(+a.width, 120) + 'ch' : null;
    const send = (value, reason = 1, extra = {}) => { if (key) push({ key, value, reason, ...extra }); };
    const reg = (t) => { if (key) tiles.set(key, t); return t.node; };
    switch (tree.type) {
      case 'row': case 'column': case 'boxed_row': case 'boxed_column': case 'radio_row': case 'radio_column': case 'boxed_radio_row': case 'boxed_radio_column': case 'concatenation': case 'paragraph': {
        const boxed = tree.type.startsWith('boxed');
        const dir = /row|concatenation/.test(tree.type) ? 'row' : 'column';
        const node = boxed ? el('fieldset', { className: 'cc-dcl-box is-' + dir }, label ? el('legend', {}, label) : null, ...kids()) : el('div', { className: 'cc-dcl-' + dir }, ...kids());
        if (tree.type.includes('radio') && key) {
          tiles.set(key, {
            node,
            get: () => node.querySelector('input[type=radio]:checked')?.dataset.key || '',
            set: (v) => { const r = node.querySelector('input[type=radio][data-key="' + CSS.escape(String(v)) + '"]'); if (r) r.checked = true; },
          });
        }
        return node;
      }
      case 'button': {
        const b = el('button', { type: 'button', className: (a.is_default ? 'btn-plot' : 'btn-line') + ' btn-sm-cc', dataset: { dclDefault: a.is_default ? '1' : '', dclCancel: a.is_cancel ? '1' : '' } }, label || key || '');
        if (width) b.style.minWidth = width;
        b.addEventListener('click', () => send('', 1));
        return reg({ node: b, get: () => '', set: (v) => { b.textContent = String(v); } });
      }
      case 'edit_box': {
        const input = el('input', { type: 'text', className: 'cc-input', maxLength: Number(a.edit_limit) > 0 ? +a.edit_limit : 512 });
        if (width) input.style.width = width;
        if (a.value != null) input.value = String(a.value);
        let timer = null;
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => send(input.value, 2), 300); });
        input.addEventListener('change', () => { clearTimeout(timer); send(input.value, 2); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); send(input.value, 1); } });
        const node = el('label', { className: 'cc-dcl-field' }, label ? el('span', {}, label) : null, input);
        return reg({ node, get: () => input.value, set: (v) => { input.value = String(v); } });
      }
      case 'list_box': case 'popup_list': {
        const multi = tree.type === 'list_box' && (a.multiple_select === true || a.multiple_select === 'true');
        const sel = el('select', { className: 'cc-select', multiple: multi });
        if (tree.type === 'list_box') sel.size = Math.max(3, Math.min(30, Number(a.height) > 0 ? Math.round(+a.height) : 8));
        if (width) sel.style.width = width;
        const value = () => (multi ? [...sel.options].filter((o) => o.selected).map((o) => o.index).join(' ') : sel.selectedIndex >= 0 ? String(sel.selectedIndex) : '');
        sel.addEventListener('change', () => send(value(), 1));
        if (tree.type === 'list_box') sel.addEventListener('dblclick', () => { send(value(), 4); if (a.allow_accept === true || a.allow_accept === 'true') push({ key: 'accept', value: '', reason: 1 }); });
        const node = el('label', { className: 'cc-dcl-field is-list' }, label ? el('span', {}, label) : null, sel);
        return reg({
          node, get: value,
          set: (v) => { const want = new Set(String(v).trim().split(/\s+/).filter(Boolean).map(Number)); for (const o of sel.options) o.selected = want.has(o.index); },
          list: (op, index, items) => {
            if (op === 3) sel.replaceChildren();
            if (op === 1) { const o = sel.options[index]; if (o && items.length) o.textContent = items[0]; return; }
            for (const s of items) sel.append(el('option', {}, String(s)));
          },
        });
      }
      case 'toggle': {
        const cb = el('input', { type: 'checkbox' });
        if (a.value != null) cb.checked = String(a.value) === '1';
        cb.addEventListener('change', () => send(cb.checked ? '1' : '0', 1));
        const node = el('label', { className: 'cc-dcl-check' }, cb, el('span', {}, label));
        return reg({ node, get: () => (cb.checked ? '1' : '0'), set: (v) => { cb.checked = String(v) === '1'; } });
      }
      case 'radio_button': {
        const r = el('input', { type: 'radio', name: 'dcl-' + (group || 'g'), dataset: { key: key || '' } });
        if (a.value != null) r.checked = String(a.value) === '1';
        r.addEventListener('change', () => { if (!r.checked) return; send('1', 1); if (group && tiles.has(group)) push({ key: group, value: key || '', reason: 1 }); });
        const node = el('label', { className: 'cc-dcl-check' }, r, el('span', {}, label));
        return reg({ node, get: () => (r.checked ? '1' : '0'), set: (v) => { r.checked = String(v) === '1'; } });
      }
      case 'slider': {
        const lo = Number.isFinite(+a.min_value) ? +a.min_value : 0, hi = Number.isFinite(+a.max_value) ? +a.max_value : 10000;
        const s = el('input', { type: 'range', min: String(Math.min(lo, hi)), max: String(Math.max(lo, hi)), step: String(Number(a.small_increment) > 0 ? +a.small_increment : 1) });
        if (a.value != null) s.value = String(a.value);
        s.addEventListener('input', () => send(s.value, 3));
        s.addEventListener('change', () => send(s.value, 1));
        return reg({ node: el('label', { className: 'cc-dcl-field' }, label ? el('span', {}, label) : null, s), get: () => s.value, set: (v) => { s.value = String(v); } });
      }
      case 'image': case 'image_button': {
        const box = el(tree.type === 'image_button' ? 'button' : 'div', { type: tree.type === 'image_button' ? 'button' : undefined, className: 'cc-dcl-image' });
        box.style.width = (Number(a.width) > 0 ? Math.min(+a.width, 60) : 10) + 'ch';
        box.style.height = (Number(a.height) > 0 ? Math.min(+a.height, 30) : 4) * 1.4 + 'em';
        if (tree.type === 'image_button') box.addEventListener('click', () => send('', 1));
        return reg({ node: box, get: () => '', set: () => {} });
      }
      case 'errtile': {
        const p = el('p', { className: 'cc-dcl-err', role: 'alert' });
        return reg({ node: p, get: () => p.textContent, set: (v) => { p.textContent = String(v); } });
      }
      case 'spacer': return el('div', { className: 'cc-dcl-spacer' });
      default: {   // text, text_part and anything unknown: a line of text
        const p = el('p', { className: 'cc-dcl-text' }, label);
        return reg({ node: p, get: () => p.textContent, set: (v) => { p.textContent = String(v); } });
      }
    }
  }

  function push(ev) {
    if (!cur || cur.done !== null) return;
    if (cur.waiter) { const w = cur.waiter; cur.waiter = null; w({ event: ev }); }
    else cur.queue.push(ev);
  }
  function finish(status) {
    if (!cur) return;
    const c = cur;
    c.done = status;
    closedWith = status;
    if (c.dlg.open) c.dlg.close();
    c.dlg.remove();
    cur = null;
    focusCommandLine();
    if (c.waiter) c.waiter({ done: status });
  }

  return {
    /** dialogOpen(tree): build it (not shown until start_dialog's first run()). */
    open(tree) {
      if (cur) finish(0);
      closedWith = null;
      const tiles = new Map();
      const body = el('div', { className: 'cc-dcl-body' }, ...(tree.children || []).map((c) => build(c, tiles)));
      const dlg = el('dialog', { className: 'cc-dialog cc-dcl', 'aria-label': String(tree.attrs?.label || '') },
        el('div', { className: 'cc-plot-head' }, el('h2', { className: 'cc-h' }, String(tree.attrs?.label || ''))), body);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); const b = dlg.querySelector('[data-dcl-cancel="1"]'); if (b) b.click(); else push({ key: 'cancel', value: '', reason: 1 }); });
      dlg.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT' && e.target.multiple) return;
        if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;   // the edit box sends its own Enter
        const b = dlg.querySelector('[data-dcl-default="1"]');
        if (b) { e.preventDefault(); b.click(); }
      });
      // keys stay in the dialog (the command line must not see them)
      dlg.addEventListener('keydown', (e) => e.stopPropagation());
      root.append(dlg);
      cur = { dlg, tiles, queue: [], waiter: null, done: null, shown: false };
      return { ok: true };
    },
    op(op, key, ...a) {
      if (!cur) return null;
      if (op === 'done') { finish(Number(key) || 0); return true; }
      const tile = cur.tiles.get(String(key));
      switch (op) {
        case 'set': if (tile?.set) tile.set(a[0]); return true;
        case 'get': return tile?.get ? tile.get() : '';
        case 'attr': return '';
        case 'mode': {
          const n = tile?.node;
          if (!n) return true;
          const ctl = n.matches('input,select,button') ? n : n.querySelector('input,select,button');
          if (a[0] === 0 || a[0] === 1) { if (ctl) ctl.disabled = a[0] === 1; }
          else if (a[0] === 2) ctl?.focus();
          else if (a[0] === 3 && ctl?.select) ctl.select();
          return true;
        }
        case 'list': if (tile?.list) tile.list(a[0], a[1], a[2] || []); return true;
        default: return null;
      }
    },
    /** The next event, or { done } once the dialog is closed (shows the dialog on the first call). */
    run() {
      if (!cur) { const d = closedWith ?? 0; closedWith = null; return { done: d }; }
      if (!cur.shown) { cur.shown = true; cur.dlg.showModal(); (cur.dlg.querySelector('input,select') || cur.dlg.querySelector('[data-dcl-default="1"]'))?.focus(); }
      if (cur.queue.length) return { event: cur.queue.shift() };
      return new Promise((resolve) => { cur.waiter = resolve; });
    },
    close: () => finish(0),
    get open_() { return !!cur; },
  };
}
