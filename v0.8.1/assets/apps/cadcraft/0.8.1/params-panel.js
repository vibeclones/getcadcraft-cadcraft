/* SPDX-License-Identifier: Apache-2.0 */
/**
 * params-panel.js — the Parameters panel and the constraints' part of the CadCraft UI (DOM; built with el(), text
 * nodes only). cadcraft.js calls createParamsPanel() once and forwards three events to it.
 *
 *   const pp = createParamsPanel({ root, doc, view, engine, host, print, status, ask, focusCommandLine })
 *   pp.click(world) → true when a constraint glyph or label was clicked (it is selected; Delete removes it)
 *   pp.dblclick(world) → true when a dimensional constraint's label was double-clicked (its value dialog opened)
 *   pp.deleteKey() → true when a selected constraint was removed
 *   pp.toggle(show?) — show / hide the panel (PARAMETERS)
 *
 * Panel ([data-params-sec] in ui.inc, right side): one table of every parameter — dimensional constraints (d1,
 * rad1 …) and user parameters — with name, expression and value. Typing in Expression links it (a number or
 * "width / 2"); typing a number in Value of a driven row solves the parameter behind it (two-way); several
 * candidates → a dialog asks which one changes. Each edit is one undo step (params-doc.js). Errors show on their
 * row. "Add" makes a user parameter; Delete on a dimensional row removes the constraint.
 * Sets host.parameters, host.redraw, host.download, host.constraintView and doc.onNote (messages to the command
 * history), and view.extraOverlay (gview.js draws bars and dimensional constraints).
 */

import { el } from './ui-util.js';
import { drawParametric, hitAt } from './gview.js';
import { describe, setParameter, setDimInput, driveParameter, driveConstraint, removeParameter, removeConstraints } from './params-doc.js';
import { describeConstraint, isDim, statusText } from './gcons.js';
import { literal } from './expr.js';

import { t } from './i18n.js';
export function createParamsPanel({ root, doc, view, engine, host, print, status, ask, focusCommandLine = () => {} }) {
  const sec = root.querySelector('[data-params-sec]');
  const body = sec?.querySelector('[data-params]');
  const state = host.constraintView || { bars: 'all', hidden: new Set(), dims: true };
  state.selected = null; state.hits = [];
  host.constraintView = state;
  view.extraOverlay = (ctx, v) => drawParametric(ctx, v, doc, host.constraintView);
  host.redraw = () => view.invalidate();
  host.parameters = () => toggle(true);
  host.download = (name, data, mime) => {
    const a = el('a', { href: URL.createObjectURL(new Blob([data], { type: mime || 'application/octet-stream' })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  doc.onNote = (m) => { print('  ' + m); status(m); };

  let message = '';
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  doc.on((kind) => {
    if (state.selected && !doc.constraints.some((c) => c.id === state.selected)) state.selected = null;
    if (kind === 'load') { state.selected = null; state.hidden.clear(); }
    schedule();
  });

  function toggle(show = sec?.hidden) {
    if (!sec) { print(t('params.panel.parameters_panel_not_page')); return; }
    sec.hidden = !show;
    if (show) { render(); sec.scrollIntoView({ block: 'nearest' }); sec.querySelector('input')?.focus({ preventScroll: true }); }
  }
  root.querySelector('[data-params-close]')?.addEventListener('click', () => { toggle(false); focusCommandLine(); });

  /** Run an edit; a choice between driving parameters asks first. */
  async function run(fn, done) {
    let r = fn(null);
    if (!r.ok && r.choices?.length > 1) {
      const pick = await ask({ title: t('params.panel.which_parameter_changes'), text: r.error, buttons: [['cancel', 'Cancel', 'btn-line'], ...r.choices.slice(0, 6).map((n, i) => ['p' + i, n, i ? 'btn-line' : 'btn-plot'])] });
      const i = /^p(\d)$/.exec(pick)?.[1];
      if (i === undefined) { message = t('params.panel.nothing_changed'); render(); return r; }
      r = fn(r.choices[+i]);
    }
    message = r.ok ? (r.message || done || '') : r.error;
    if (r.ok && done) print('  ' + done + (r.message ? ' ' + r.message : ''));
    else if (!r.ok) print('  ' + r.error);
    render();
    view.invalidate();
    return r;
  }

  function render() {
    if (!sec || sec.hidden || !body) return;
    const d = describe(doc);
    const rows = d.rows.map((r) => {
      const id = 'cc-par-' + r.name;
      const name = el('input', { type: 'text', className: 'cc-input cc-par-name', value: r.name, 'aria-label': t('params.panel.name_of', { name: r.name }), spellcheck: false, autocomplete: 'off' });
      name.addEventListener('change', () => {
        const to = name.value.trim();
        if (!to || to === r.name) { name.value = r.name; return; }
        run(() => setParameter(doc, to, r.expr, { rename: r.name }), t('params.is_now', { name: r.name, value: to }));
      });
      const expr = el('input', { type: 'text', className: 'cc-input cc-par-expr', id, value: r.expr, 'aria-label': t('params.panel.expr_of', { name: r.name }), spellcheck: false, autocomplete: 'off', title: r.error || '' });
      expr.addEventListener('change', () => {
        const v = expr.value.trim();
        if (!v || v === r.expr) { expr.value = r.expr; return; }
        run(() => (r.constraint ? setDimInput(doc, r.constraint.id, v) : setParameter(doc, r.name, v)), r.name + ' = ' + v + '.');
      });
      // driven rows: a number typed here solves whatever drives it (two-way)
      const shown = r.value === null ? '' : String(Math.round(r.value * 1e6) / 1e6);
      const value = r.driving ? el('span', { className: 'cc-par-val' }, shown + (r.constraint?.type === 'angle' ? '°' : ''))
        : el('input', { type: 'text', className: 'cc-input cc-par-val', value: shown, inputMode: 'decimal', 'aria-label': t('params.panel.value_of', { name: r.name }), title: t('params.panel.driven_by', { expr: r.expr }) });
      if (!r.driving) value.addEventListener('change', () => {
        const n = literal(value.value);
        if (n === null) { message = t('params.panel.type_number'); value.value = shown; render(); return; }
        run((prefer) => (r.constraint ? driveConstraint(doc, r.constraint.id, n, { prefer }) : driveParameter(doc, r.name, n, { prefer })), t('params.panel.set_to', { name: r.name, value: n }));
      });
      const del = el('button', { type: 'button', className: 'cc-x cc-par-del', title: r.constraint ? t('params.panel.delete_constraint') : t('params.panel.delete_parameter'), 'aria-label': 'Delete ' + r.name }, el('i', { className: 'bi bi-x-lg', 'aria-hidden': 'true' }));
      del.addEventListener('click', async () => {
        if (r.constraint) { run(() => removeConstraints(doc, [r.constraint.id], 'DELCONSTRAINT'), r.name + ' deleted.'); return; }
        let res = removeParameter(doc, r.name);
        if (!res.ok && res.uses) {
          const k = await ask({ title: t('params.panel.delete_title', { name: r.name }), text: res.error + ' ' + t('params.panel.inline_hint'), buttons: [['cancel', t('opt.cancel'), 'btn-line'], ['inline', t('params.panel.write_value_delete'), 'btn-plot']] });
          if (k !== 'inline') return;
          res = removeParameter(doc, r.name, { inline: true });
        }
        message = res.ok ? r.name + ' deleted.' : res.error;
        render(); view.invalidate();
      });
      const tr = el('tr', { className: (r.error ? 'is-error ' : '') + (r.constraint && r.constraint.id === state.selected ? 'is-selected' : ''), dataset: { name: r.name } },
        el('td', {}, name),
        el('td', {}, expr, r.error ? el('span', { className: 'cc-par-err' }, r.error) : null),
        el('td', {}, value),
        el('td', { className: 'cc-par-kind', title: r.constraint ? describeConstraint(doc, r.constraint) : (r.note || t('params.panel.user_parameter')) }, r.kind === 'dim' ? r.type : 'User'),
        el('td', {}, del));
      if (r.constraint) tr.addEventListener('focusin', () => { state.selected = r.constraint.id; view.invalidate(); });
      return tr;
    });
    const nName = el('input', { type: 'text', className: 'cc-input', placeholder: t('params.panel.name'), 'aria-label': t('params.panel.new_parameter_name'), spellcheck: false, autocomplete: 'off', dataset: { parNew: 'name' } });
    const nExpr = el('input', { type: 'text', className: 'cc-input', placeholder: t('params.panel.value_expression'), 'aria-label': t('params.panel.new_parameter_value_expression'), spellcheck: false, autocomplete: 'off', dataset: { parNew: 'expr' } });
    const form = el('form', { className: 'cc-par-new' }, nName, nExpr, el('button', { type: 'submit', className: 'btn-plot btn-sm-cc' }, t('params.panel.add')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = nName.value.trim(), x = nExpr.value.trim() || '0';
      if (!n) { nName.focus(); return; }
      run(() => setParameter(doc, n, x), n + ' = ' + x + '.').then((r) => { if (r.ok) setTimeout(() => body.querySelector('[data-par-new="name"]')?.focus(), 0); });
    });
    body.replaceChildren(
      el('p', { className: 'cc-note', dataset: { paramStatus: '' } }, d.status),
      d.rows.length ? el('table', { className: 'cc-par-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('params.panel.name')), el('th', { scope: 'col' }, t('params.panel.expression')), el('th', { scope: 'col' }, t('params.panel.value')), el('th', { scope: 'col' }, t('params.panel.type')), el('th', { scope: 'col' }, el('span', { className: 'visually-hidden' }, 'Delete')))),
        el('tbody', {}, ...rows))
        : el('p', { className: 'cc-note' }, t('params.panel.empty')),
      form,
      el('p', { className: 'cc-note cc-par-msg', role: 'status', 'aria-live': 'polite' }, message),
    );
  }

  function screen(world) { return view.toScreen(world.x, world.y); }

  function click(world) {
    if (!doc.inModel) return false;
    const s = screen(world);
    const h = hitAt(state, s.x, s.y);
    if (!h) { if (state.selected) { state.selected = null; view.invalidate(); schedule(); } return false; }
    const c = doc.constraints.find((k) => k.id === h.cid);
    if (!c) return false;
    state.selected = c.id;
    print(t(isDim(c) ? 'params.panel.picked.dim' : 'params.panel.picked', { what: describeConstraint(doc, c) }));
    view.invalidate(); schedule();
    return true;
  }

  function dblclick(world) {
    if (!doc.inModel) return false;
    const s = screen(world);
    const h = hitAt(state, s.x, s.y);
    const c = h && h.kind === 'dim' ? doc.constraints.find((k) => k.id === h.cid) : null;
    if (!c) return false;
    editDialog(c);
    return true;
  }

  function editDialog(c) {
    const v = doc.params.vars.find((x) => x.name === c.name);
    const input = el('input', { type: 'text', className: 'cc-input', id: 'cc-dc-input', value: c.name + '=' + (v ? v.expr : c.value), spellcheck: false, autocomplete: 'off' });
    const err = el('p', { className: 'cc-note cc-par-err', role: 'alert' });
    const dlg = el('dialog', { className: 'cc-dialog cc-ask', 'aria-labelledby': 'cc-dc-h', dataset: { dcEdit: '' } },
      el('div', { className: 'cc-plot-head' }, el('h2', { className: 'cc-h', id: 'cc-dc-h' }, t('params.panel.dc_title', { name: c.name }))),
      el('div', { className: 'cc-ask-text' },
        el('label', { htmlFor: 'cc-dc-input' }, t('params.panel.value_expression_number_driven')), input, err,
        el('p', { className: 'cc-note' }, describeConstraint(doc, c) + '.')),
      el('div', { className: 'cc-plot-foot' }, el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { key: 'cancel' } }, 'Cancel'), el('button', { type: 'button', className: 'btn-plot btn-sm-cc', dataset: { key: 'ok' } }, 'Apply')));
    const apply = async () => {
      const text = input.value.trim();
      const n = literal(text.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)\s*/, ''));
      const sameName = !/^[A-Za-z_]\w*\s*=/.test(text) || text.startsWith(c.name + '=') || text.startsWith(c.name + ' =');
      let r;
      if (n !== null && sameName && v && literal(v.expr) === null) {
        dlg.close();
        r = await run((prefer) => driveConstraint(doc, c.id, n, { prefer }), t('params.panel.set_to', { name: c.name, value: n }));
        return;
      }
      r = setDimInput(doc, c.id, text);
      if (!r.ok) { err.textContent = r.error; input.focus(); return; }
      print('  ' + c.name + ': ' + text + (r.message ? ' ' + r.message : ''));
      dlg.close();
      view.invalidate();
    };
    dlg.addEventListener('click', (e) => { const b = e.target.closest('button[data-key]'); if (!b) return; if (b.dataset.key === 'ok') apply(); else dlg.close(); });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    dlg.addEventListener('close', () => { dlg.remove(); focusCommandLine(); schedule(); });
    root.append(dlg);
    dlg.showModal();
    input.select();
  }

  function deleteKey() {
    if (!state.selected) return false;
    const c = doc.constraints.find((k) => k.id === state.selected);
    state.selected = null;
    if (!c) return false;
    removeConstraints(doc, [c.id], 'DELCONSTRAINT');
    print('Removed ' + describeConstraint(doc, c) + '.');
    view.invalidate();
    return true;
  }

  return { click, dblclick, deleteKey, toggle, render, edit: editDialog, statusText: () => statusText(doc) };
}
