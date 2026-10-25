/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dimstyle-ui.js — the Dimension Style Manager (0.7 D7.14; command DIMSTYLE). The styles and their sums are dimstyles.js's
 * (DOM-free); this file builds the dialog: the drawing's styles with their uses, Set current, New…, Modify…, Rename…, Delete,
 * Compare…, and Apply to the selected dimensions. Modify… shows the same fields as the Properties panel's dimension sections
 * (props.js `dimStyleForm`), edited on a working copy: OK changes the style and the dimensions that use it in one undo step.
 *
 *   installDimStyles({ root, doc, host, el, t, print, props, focusCommandLine })
 *     sets host.dimStyleManager() → Promise<void> (resolves when the manager is closed)
 */
import { listStyles, currentName, styleOf, setCurrent, newFrom, renameStyle, deleteStyle, applyStyle, modifyStyle, differences, findName, STANDARD } from './dimstyles.js';

export function installDimStyles({ root, doc, host, el, t, print, props, focusCommandLine }) {
  const why = (r) => t('dimstyle.err.' + r.error, { uses: r.uses });
  const keyLabel = (k) => { const s = t('props.dim.' + k); return s === 'props.dim.' + k ? k : s; };

  host.dimStyleManager = () => new Promise((done) => {
    let sel = currentName(doc);
    const list = el('ul', { className: 'cc-ds-list', role: 'listbox', 'aria-label': t('dimstyle.list'), dataset: { dsList: '' } });
    const note = el('p', { className: 'cc-note', role: 'status', 'aria-live': 'polite', dataset: { dsNote: '' } });
    const say = (s) => { note.textContent = s; print(s); };
    const detail = el('div', { className: 'cc-ds-detail', dataset: { dsDetail: '' } });
    const btn = (key, label, fn, title = '') => el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { dsAct: key }, title, onclick: () => fn() }, label);
    const sub = el('div', { className: 'cc-ds-sub', hidden: true });   // New / Rename / Compare take their input here

    function render() {
      const rows = listStyles(doc);
      if (!rows.some((r) => r.name === sel)) sel = currentName(doc);
      list.replaceChildren(...rows.map((r) => {
        const li = el('li', { role: 'option', 'aria-selected': String(r.name === sel), tabIndex: 0, className: 'cc-ds-row' + (r.name === sel ? ' is-sel' : ''), dataset: { dsName: r.name } },
          el('span', { className: 'cc-ds-name' }, r.name),
          r.current ? el('span', { className: 'cc-al-tag' }, t('dimstyle.current')) : null,
          el('span', { className: 'cc-note' }, t('dimstyle.uses', { n: r.uses })));
        li.addEventListener('click', () => { sel = r.name; render(); });
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = r.name; render(); } e.stopPropagation(); });
        return li;
      }));
      const st = styleOf(doc, sel) || {};
      detail.textContent = t('dimstyle.summary', { name: sel, txt: st.txt, asz: st.asz, dec: st.dec, scale: st.scale });
    }
    const after = (r, ok) => { if (r.error) say(why(r)); else if (ok) say(ok); render(); };

    function ask(label, value, go, extra = null) {
      const input = el('input', { type: 'text', className: 'cc-input', maxLength: 255, value, 'aria-label': label, dataset: { dsInput: '' } });
      const ok = el('button', { type: 'button', className: 'btn-plot btn-sm-cc', dataset: { dsOk: '' } }, t('dimstyle.ok'));
      const cancel = el('button', { type: 'button', className: 'btn-line btn-sm-cc' }, t('dimstyle.cancel'));
      const close = () => { sub.hidden = true; sub.replaceChildren(); };
      const run = () => { const v = input.value.trim(); if (!v) return; close(); go(v, extra?.value); };
      ok.addEventListener('click', run); cancel.addEventListener('click', close);
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); run(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } });
      sub.replaceChildren(el('label', {}, label), input, ...(extra ? [extra.label, extra.el] : []), ok, cancel);
      sub.hidden = false;
      input.focus(); input.select();
    }
    const styleSelect = (id, value) => el('select', { className: 'cc-select', id, dataset: { dsStart: '' } }, ...listStyles(doc).map((r) => el('option', { value: r.name, selected: r.name === value }, r.name)));

    const act = {
      current: () => { const r = setCurrent(doc, sel); after(r, t('dimstyle.now_current', { name: sel })); },
      new: () => {
        const start = styleSelect('cc-ds-start', sel);
        ask(t('dimstyle.new.name'), '', (name) => { const r = newFrom(doc, name, start.value); after(r, t('dimstyle.made', { name })); if (!r.error) sel = name; render(); }, { label: el('label', { htmlFor: 'cc-ds-start' }, t('dimstyle.new.start')), el: start, get value() { return start.value; } });
      },
      modify: () => modify(sel),
      rename: () => {
        if (sel === STANDARD) { say(why({ error: 'standard' })); return; }
        ask(t('dimstyle.rename.name'), sel, (name) => { const r = renameStyle(doc, sel, name); after(r, t('dimstyle.renamed', { name })); if (!r.error) sel = name; render(); });
      },
      delete: () => { const r = deleteStyle(doc, sel); after(r, t('dimstyle.deleted', { name: sel })); },
      compare: () => {
        const other = styleSelect('cc-ds-other', listStyles(doc).find((r) => r.name !== sel)?.name || sel);
        const out = el('ul', { className: 'cc-ds-diff', dataset: { dsDiff: '' } });
        const show = () => {
          const a = styleOf(doc, sel), b = styleOf(doc, other.value), keys = differences(a, b);
          out.replaceChildren(...(keys.length ? keys.map((k) => el('li', {}, t('dimstyle.diff', { key: keyLabel(k), a: String(a[k] ?? ''), b: String(b[k] ?? '') }))) : [el('li', {}, t('dimstyle.same'))]));
        };
        other.addEventListener('change', show);
        sub.replaceChildren(el('label', { htmlFor: 'cc-ds-other' }, t('dimstyle.compare.with', { name: sel })), other, out, btn('cmp-close', t('dimstyle.close'), () => { sub.hidden = true; sub.replaceChildren(); }));
        sub.hidden = false; show();
      },
      apply: () => {
        const ids = [...host.selection];
        if (!ids.length) { say(t('dimstyle.apply.none')); return; }
        const r = applyStyle(doc, ids, sel);
        after(r, t('dimstyle.applied', { n: r.n, name: sel }));
      },
    };

    /** Modify: the Properties panel's dimension fields on a working copy of the style. */
    function modify(name) {
      const base = styleOf(doc, name);
      if (!base || !props?.dimStyleForm) { say(t('dimstyle.err.missing')); return; }
      let working = { ...base };
      const form = props.dimStyleForm(working, (st) => { working = st; });
      const head = el('div', { className: 'cc-plot-head' }, el('h2', { className: 'cc-h', id: 'cc-dsm-title' }, t('dimstyle.modify.title', { name })));
      const foot = el('div', { className: 'cc-plot-foot' },
        el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { key: 'cancel' } }, t('dimstyle.cancel')),
        el('button', { type: 'button', className: 'btn-plot btn-sm-cc', dataset: { key: 'ok' } }, t('dimstyle.ok')));
      const m = el('dialog', { className: 'cc-dialog cc-ask cc-dsmod', 'aria-labelledby': 'cc-dsm-title', dataset: { dsModify: '' } }, head, el('div', { className: 'cc-ds-form' }, form.el), foot);
      m.addEventListener('keydown', (e) => e.stopPropagation());
      m.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-key]');
        if (!b) return;
        if (b.dataset.key === 'ok') {
          const patch = {};
          for (const k of differences(base, working)) patch[k] = working[k];
          const r = modifyStyle(doc, name, patch);
          after(r, r.changed ? t('dimstyle.modified', { name, n: r.dims }) : t('dimstyle.unchanged', { name }));
        }
        m.close();
      });
      m.addEventListener('close', () => { form.dispose?.(); m.remove(); dlg.querySelector('[data-ds-act="modify"]')?.focus(); });
      root.append(m);
      m.showModal();
    }

    const actions = el('div', { className: 'cc-ds-actions' },
      btn('current', t('dimstyle.act.current'), act.current), btn('new', t('dimstyle.act.new'), act.new), btn('modify', t('dimstyle.act.modify'), act.modify),
      btn('rename', t('dimstyle.act.rename'), act.rename), btn('delete', t('dimstyle.act.delete'), act.delete), btn('compare', t('dimstyle.act.compare'), act.compare),
      btn('apply', t('dimstyle.act.apply'), act.apply, t('dimstyle.act.apply.title')));
    const dlg = el('dialog', { className: 'cc-dialog cc-ask cc-dsdlg', 'aria-labelledby': 'cc-ds-title', dataset: { dimstyle: '' } },
      el('div', { className: 'cc-plot-head' }, el('h2', { className: 'cc-h', id: 'cc-ds-title' }, t('dimstyle.title'))),
      el('div', { className: 'cc-ds-body' }, list, detail, actions, sub, note),
      el('div', { className: 'cc-plot-foot' }, el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { dsClose: '' }, onclick: () => dlg.close() }, t('dimstyle.close'))));
    dlg.addEventListener('keydown', (e) => e.stopPropagation());
    dlg.addEventListener('close', () => { dlg.remove(); focusCommandLine(); done(); });
    render();
    root.append(dlg);
    dlg.showModal();
  });
}
