/* SPDX-License-Identifier: Apache-2.0 */
/**
 * keys-ui.js — keyboard shortcuts for any command (0.5 WL.18): the SHORTCUTS editor (View › More, beside the aliases
 * file) and the keys themselves. Kept per app in localStorage `cadcraft.shortcuts` (shortcuts.js cleanShortcuts); a key
 * CadCraft, the app or the browser use, or that a My tools button has, is refused with the reason.
 *
 *   installShortcuts({ root, engine, el, t, print, status, lookup, takenByTools, focusCommandLine }) → { open(), run(text), keys(), set(map) }
 */
import { cleanShortcuts, shortcutsData, SHORTCUTS_KEY, keyOfEvent, keyProblem, normKey } from './shortcuts.js';

export function installShortcuts({ root, engine, el, t, print, status, lookup, takenByTools = () => new Map(), focusCommandLine }) {
  let own = load();
  // Once CadCraft's build has menu styles (manifest "input", 0.5 track IP), the shell's input engine carries these keys into
  // the person's own style once (the registry's CARRY: 'cadcraft.shortcuts', app-input.js carryInto) and runs them; from
  // then on they are read from and written to that style (window.ccInput macros / setMacros), and this file's key
  // listener stands down. The old store is left as it was for older builds.
  const shell = () => (window.ccInput && window.ccInput.app === 'cadcraft' && typeof window.ccInput.macros === 'function' ? window.ccInput : null);
  const current = () => (shell() ? new Map([...shell().macros()].map(([k, v]) => [normKey(k.replace(/^(.*\+)?Arrow(Left|Right|Up|Down)$/, '$1$2')) || k, v])) : own);
  function load() {
    try { return cleanShortcuts(JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || 'null'), { known: lookup, taken: takenByTools() }).keys; } catch { return new Map(); }
  }
  function save(next) {
    if (shell()) { shell().setMacros(next); return; }
    own = next;
    try { if (own.size) localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcutsData(own))); else localStorage.removeItem(SHORTCUTS_KEY); } catch { /* kept for this visit */ }
  }
  async function run(text) {
    if (engine.busy) { engine.escape(); await engine.done; }
    const [cmd, ...rest] = text.split(/\s+/);
    engine.text(cmd);
    for (const r of rest) { await new Promise((ok) => setTimeout(ok, 0)); if (!engine.waiting) break; engine.text(r); }
  }
  window.addEventListener('keydown', (e) => {
    if (shell()) return;   // the shell's input engine runs them (its text keys)
    const keys = own;
    if (!keys.size || e.target?.closest?.('dialog') || document.querySelector('dialog[open]')) return;
    const k = keyOfEvent(e);
    const text = k && keys.get(k);
    if (!text) return;
    e.preventDefault(); e.stopPropagation();
    status?.(t('keys.run', { key: k, text }));
    run(text);
  }, true);

  function open() {
    return new Promise((done) => {
      let keys = current();
      const list = el('ul', { className: 'cc-al-list' });
      const said = el('p', { className: 'cc-al-msg cc-note', role: 'status' });
      const keyIn = el('input', { type: 'text', className: 'cc-input', id: 'cc-keys-key', readOnly: true, placeholder: t('keys.press') });
      const cmdIn = el('input', { type: 'text', className: 'cc-input', id: 'cc-keys-cmd', placeholder: t('keys.command.placeholder'), spellcheck: false, autocapitalize: 'off' });
      let picked = '';
      keyIn.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') return;
        e.preventDefault();
        if (e.key === 'Backspace' || e.key === 'Delete') { picked = ''; keyIn.value = ''; return; }
        const k = keyOfEvent(e);
        if (k) { picked = k; keyIn.value = k; }
      });
      const render = () => {
        list.replaceChildren(...[...keys].sort((a, b) => a[0].localeCompare(b[0])).map(([k, text]) => {
          const del = el('button', { type: 'button', className: 'btn-link-cc', dataset: { keysDelete: k } }, t('keys.remove'));
          del.addEventListener('click', () => { const n = new Map(keys); n.delete(k); save(n); keys = current(); said.textContent = t('keys.removed', { key: k }); render(); });
          return el('li', {}, el('kbd', {}, k), el('span', { className: 'cc-al-name' }, text), del);
        }));
        if (!keys.size) list.append(el('li', { className: 'cc-al-empty' }, t('keys.none')));
      };
      const add = el('button', { type: 'button', className: 'btn-plot btn-sm-cc', dataset: { keysAdd: '' } }, t('keys.add'));
      add.addEventListener('click', () => {
        const text = cmdIn.value.trim().replace(/\s+/g, ' ');
        if (!picked) { said.textContent = t('keys.err.format', { key: '' }); return; }
        const taken = new Map([...takenByTools(), ...[...keys].filter(([k]) => k !== picked).map(([k, v]) => [k, v])]);
        const why = keyProblem(picked, taken);
        if (why) { said.textContent = t('keys.err.' + why, { key: picked, other: taken.get(normKey(picked)) || '' }); return; }
        if (!text || !lookup(text.split(' ')[0])) { said.textContent = t('keys.err.command', { key: picked, cmd: text.split(' ')[0] || '?' }); return; }
        const n = new Map(keys); n.set(picked, text); save(n); keys = current();
        said.textContent = t('keys.added', { key: picked, text });
        picked = ''; keyIn.value = ''; cmdIn.value = '';
        render();
      });
      const dlg = el('dialog', { className: 'cc-dialog cc-aliases cc-keys', 'aria-labelledby': 'cc-keys-h' },
        el('div', { className: 'cc-plot-head' }, el('h2', { className: 'cc-h', id: 'cc-keys-h' }, t('keys.title')),
          el('button', { type: 'button', className: 'cc-x', 'aria-label': t('keys.close'), dataset: { keysClose: '' } }, el('i', { className: 'bi bi-x-lg', 'aria-hidden': 'true' }))),
        el('div', { className: 'cc-al-body' },
          el('p', { className: 'cc-note' }, t('keys.text')),
          list,
          el('div', { className: 'cc-al-actions' },
            el('label', { htmlFor: 'cc-keys-key' }, t('keys.key')), keyIn,
            el('label', { htmlFor: 'cc-keys-cmd' }, t('keys.command')), cmdIn, add),
          said));
      dlg.querySelector('[data-keys-close]').addEventListener('click', () => dlg.close());
      dlg.addEventListener('close', () => { dlg.remove(); focusCommandLine?.(); done(); });
      render();
      root.append(dlg);
      dlg.showModal();
      keyIn.focus();
    });
  }
  void print;
  return { open, run, keys: () => current(), set: (m) => save(cleanShortcuts(shortcutsData(m), { known: lookup, taken: takenByTools() }).keys) };
}
