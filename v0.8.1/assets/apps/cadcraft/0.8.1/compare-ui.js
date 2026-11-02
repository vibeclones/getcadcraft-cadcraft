/* SPDX-License-Identifier: Apache-2.0 */
/**
 * compare-ui.js — the Compare settings dialog (0.5 WL.12; COMPARESETTINGS): pick what to compare (dimension styles, text
 * styles, layers, sheets, units), the item on the left (this drawing) and on the right (this drawing or another open one),
 * see every property side by side with the differences marked, and copy a value across (→ or ←: one undo step in the
 * drawing it lands in). Text through t(); names from files only through el() text nodes.
 *
 *   openCompare({ root, el, t, has, doc, docs: () => [{ id, name, doc }], print, onChange }) → Promise (closed)
 */
import { COMPARE_CATS, itemsOf, compareItems, copyValue, valueText } from './compare.js';

export function openCompare({ root, el, t, has, doc, docs, print, onChange }) {
  return new Promise((done) => {
    const open = docs();
    const st = { cat: 'dimstyle', rightDoc: open.find((d) => d.doc !== doc)?.id ?? open.find((d) => d.doc === doc)?.id, a: null, b: null, onlyDiff: false };
    const docById = (id) => open.find((d) => d.id === id)?.doc || doc;
    const label = (key) => {
      const k = st.cat === 'dimstyle' ? 'props.dim.' + key : 'cmp.k.' + st.cat + '.' + key.toLowerCase();
      return has(k) ? t(k) : key;
    };
    const itemLabel = (n) => (n === '*CURRENT' ? t('cmp.current_dim') : n === '*DRAWING' ? t('cmp.drawing_units') : n);
    const sel = (id, opts, value, aria) => el('select', { className: 'cc-select', id, 'aria-label': aria }, ...opts.map(([v, l]) => el('option', { value: v, selected: v === value }, l)));
    const body = el('div', { className: 'cc-cmp-body' });
    const table = el('table', { className: 'cc-cmp-table' });
    const note = el('p', { className: 'cc-note', role: 'status' });
    function pickDefaults() {
      const A = itemsOf(doc, st.cat), B = itemsOf(docById(st.rightDoc), st.cat);
      if (!A.includes(st.a)) st.a = A[0] ?? null;
      if (!B.includes(st.b)) st.b = docById(st.rightDoc) === doc ? (B.find((x) => x !== st.a) ?? B[0] ?? null) : (B.includes(st.a) ? st.a : B[0] ?? null);
    }
    function render() {
      pickDefaults();
      const right = docById(st.rightDoc);
      const catSel = sel('cc-cmp-cat', COMPARE_CATS.map((c) => [c, t('cmp.cat.' + c)]), st.cat, t('cmp.what'));
      const aSel = sel('cc-cmp-a', itemsOf(doc, st.cat).map((n) => [n, itemLabel(n)]), st.a, t('cmp.left'));
      const dSel = sel('cc-cmp-doc', open.map((d) => [String(d.id), d.doc === doc ? t('cmp.this_drawing', { name: d.name }) : d.name]), String(st.rightDoc), t('cmp.right_drawing'));
      const bSel = sel('cc-cmp-b', itemsOf(right, st.cat).map((n) => [n, itemLabel(n)]), st.b, t('cmp.right'));
      const only = el('input', { type: 'checkbox', id: 'cc-cmp-only', checked: st.onlyDiff });
      catSel.addEventListener('change', () => { st.cat = catSel.value; st.a = st.b = null; render(); });
      aSel.addEventListener('change', () => { st.a = aSel.value; render(); });
      dSel.addEventListener('change', () => { st.rightDoc = +dSel.value; st.b = null; render(); });
      bSel.addEventListener('change', () => { st.b = bSel.value; render(); });
      only.addEventListener('change', () => { st.onlyDiff = only.checked; render(); });
      const rows = st.a !== null || st.b !== null ? compareItems(st.cat, doc, st.a, right, st.b) : [];
      const diff = rows.filter((r) => !r.same).length;
      const copy = (r, toRight) => {
        const target = toRight ? right : doc, item = toRight ? st.b : st.a, v = toRight ? r.a : r.b;
        if (item === null || v === undefined) return;
        if (copyValue(target, st.cat, item, r.key, v)) { onChange?.(target); print?.(t('cmp.copied', { what: label(r.key), item: itemLabel(item) })); }
        render();
      };
      table.replaceChildren(
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('cmp.property')), el('th', { scope: 'col' }, itemLabel(st.a ?? '')), el('th', { scope: 'col' }, ''), el('th', { scope: 'col' }, itemLabel(st.b ?? '')))),
        el('tbody', {}, ...rows.filter((r) => !st.onlyDiff || !r.same).map((r) => {
          const toR = el('button', { type: 'button', className: 'cc-x', title: t('cmp.copy_right'), 'aria-label': t('cmp.copy_right_aria', { what: label(r.key) }), disabled: r.same || r.a === undefined || st.b === null, dataset: { cmpRight: r.key } }, '→');
          const toL = el('button', { type: 'button', className: 'cc-x', title: t('cmp.copy_left'), 'aria-label': t('cmp.copy_left_aria', { what: label(r.key) }), disabled: r.same || r.b === undefined || st.a === null, dataset: { cmpLeft: r.key } }, '←');
          toR.addEventListener('click', () => copy(r, true));
          toL.addEventListener('click', () => copy(r, false));
          return el('tr', { className: r.same ? '' : 'is-diff', dataset: { cmpKey: r.key } }, el('th', { scope: 'row' }, label(r.key)), el('td', {}, valueText(st.cat, r.key, r.a)), el('td', { className: 'cc-cmp-acts' }, toR, toL), el('td', {}, valueText(st.cat, r.key, r.b)));
        })));
      note.textContent = !rows.length ? t('cmp.nothing') : diff ? t('cmp.differ', { n: diff, of: rows.length }) : t('cmp.same', { n: rows.length });
      body.replaceChildren(
        el('div', { className: 'cc-cmp-pick' },
          el('label', { htmlFor: 'cc-cmp-cat' }, t('cmp.what')), catSel,
          el('label', { htmlFor: 'cc-cmp-a' }, t('cmp.left')), aSel,
          el('label', { htmlFor: 'cc-cmp-doc' }, t('cmp.right_drawing')), dSel,
          el('label', { htmlFor: 'cc-cmp-b' }, t('cmp.right')), bSel),
        el('label', { className: 'cc-cmp-only', htmlFor: 'cc-cmp-only' }, only, ' ', t('cmp.only_diff')),
        note, el('div', { className: 'cc-cmp-scroll' }, table));
    }
    const dlg = el('dialog', { className: 'cc-dialog cc-cmp', 'aria-labelledby': 'cc-cmp-h' },
      el('div', { className: 'cc-plot-head' }, el('h2', { className: 'cc-h', id: 'cc-cmp-h' }, t('cmp.title')),
        el('button', { type: 'button', className: 'cc-x', 'aria-label': t('cmp.close'), dataset: { cmpClose: '' } }, el('i', { className: 'bi bi-x-lg', 'aria-hidden': 'true' }))),
      body);
    dlg.querySelector('[data-cmp-close]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { dlg.remove(); done(); });
    render();
    root.append(dlg);
    dlg.showModal();
  });
}
