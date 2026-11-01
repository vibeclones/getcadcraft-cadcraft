/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mytools-ui.js — the page side of My tools (0.5 DR.9): the "My tools" groups on the toolbar, Settings › CadCraft ›
 * My tools (add / edit / delete a button, export and import JSON, import a CUIx file), the edit dialog, a button's
 * shortcut key, and running a button's macro through the command line (macro.js steps). Data: mytools.js
 * (localStorage `cadcraft.mytools`); CUIx: cuix.js. Text through t(); file contents only through el() text nodes.
 *
 *   installMyTools({ root, engine, host, el, t, ask, print, status, lookup, toggle, getvar, download, focusCommandLine })
 *     → { run(macro), data(), set(data), importCuix(bytes), importJson(text), exportJson(), keyFor(event) }
 */
import { parseMacro } from './macro.js';
import { cleanTools, emptyTools, exportTools, mergeTools, keyMap, iconFromBytes, MYTOOLS_KEY } from './mytools.js';
import { keyOfEvent, keyProblem, normKey } from './shortcuts.js';
import { readCuix } from './cuix.js';

export function installMyTools({ root, engine, el, t, ask, print, status, lookup, toggle, getvar, download, focusCommandLine, takenElsewhere = () => new Map() }) {
  let data = load();
  const tools = root.querySelector('.cc-tools');
  const box = document.querySelector('[data-mytools-settings]');

  function load() {
    try { return cleanTools(JSON.parse(localStorage.getItem(MYTOOLS_KEY) || 'null')).data; } catch { return emptyTools(); }
  }
  function save(next) {
    data = next;
    try { if (data.groups.length) localStorage.setItem(MYTOOLS_KEY, JSON.stringify(data)); else localStorage.removeItem(MYTOOLS_KEY); } catch { /* storage full or off: kept for this visit */ }
    render();
  }
  const findTool = (id) => { for (const g of data.groups) { const tl = g.tools.find((x) => x.id === id); if (tl) return { group: g, tool: tl }; } return null; };

  // ---- running a macro: each step through the command line; a pause waits for the person's own answer ----
  let runToken = 0;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  async function untilAnswered(w) {
    for (let i = 0; i < 600000 / 30; i++) {   // (ten minutes at most)
      await new Promise((r) => setTimeout(r, 30));
      if (engine.waiting !== w || !engine.busy) return;
    }
  }
  async function run(macro, label = '') {
    const my = ++runToken;
    const p = parseMacro(macro, { getvar });
    for (const n of p.notes) print(t(n.key, n.fills || {}));
    if (!p.steps.length) return false;
    for (const c of p.commands) if (!lookup(c)) { print(t('mytools.run.missing', { cmd: c, label: label || macro.slice(0, 40) })); return false; }
    for (let round = 0; round < (p.repeat ? 1000 : 1); round++) {
      for (const s of p.steps) {
        if (my !== runToken) return false;   // another button started, or Esc
        if (s.kind === 'cancel') { if (engine.busy) { engine.escape(); await engine.done; } continue; }
        if (s.kind === 'toggle') { toggle(s.what); continue; }
        if (s.kind === 'pause') {
          await tick();
          if (!engine.busy || !engine.waiting) continue;
          await untilAnswered(engine.waiting);
          continue;
        }
        engine.text(s.kind === 'send' ? s.text : '');
        await tick();
      }
      if (!p.repeat) break;
      if (engine.busy) await engine.done;
      if (my !== runToken) break;   // Esc ends a repeating button
    }
    return true;
  }
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') runToken++; }, true);

  // shortcut keys: before the app's own keys, but never while a dialog is open (the key box in the edit dialog types them)
  window.addEventListener('keydown', (e) => {
    if (!data.groups.length || e.target?.closest?.('dialog') || document.querySelector('dialog[open]')) return;
    const k = keyOfEvent(e);
    const hit = k && keyMap(data).get(k);
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    status?.(t('mytools.run.key', { key: k, label: hit.tool.label }));
    run(hit.tool.macro, hit.tool.label);
  }, true);

  // ---- the toolbar: one group per My tools group, after the app's own ----
  function render() {
    for (const g of [...tools.querySelectorAll('[data-mytools-group]')]) g.remove();
    for (const g of data.groups) {
      const row = el('div', { className: 'cc-tool-row' }, ...g.tools.map((tl) => {
        const icon = tl.icon ? el('img', { src: tl.icon, alt: '', width: 18, height: 18, className: 'cc-mytool-icon' }) : el('i', { className: 'bi bi-star', 'aria-hidden': 'true' });
        const b = el('button', { type: 'button', className: 'cc-tool', title: tl.key ? t('mytools.button.title.key', { label: tl.label, key: tl.key }) : tl.label, dataset: { mytool: tl.id } }, icon, el('span', {}, tl.label));
        b.addEventListener('click', () => { focusCommandLine?.(); run(tl.macro, tl.label); });
        return b;
      }));
      tools.append(el('div', { className: 'cc-tool-group', role: 'group', 'aria-label': g.name, dataset: { mytoolsGroup: '', tbKey: 'my:' + g.name } },
        el('span', { className: 'cc-tool-label', 'aria-hidden': 'true' }, g.name), row));
    }
    renderSettings();
  }

  // ---- Settings › CadCraft › My tools ----
  const said = el('p', { className: 'shell-hint-text', role: 'status' });
  function renderSettings() {
    if (!box) return;
    const list = el('ul', { className: 'cc-mt-list' });
    for (const g of data.groups) {
      for (const tl of g.tools) {
        const edit = el('button', { type: 'button', className: 'btn-link-cc', dataset: { mtEdit: tl.id } }, t('mytools.edit'));
        const del = el('button', { type: 'button', className: 'btn-link-cc', dataset: { mtDelete: tl.id } }, t('mytools.delete'));
        edit.addEventListener('click', () => editTool(tl.id));
        del.addEventListener('click', () => { save({ ...data, groups: data.groups.map((x) => ({ ...x, tools: x.tools.filter((y) => y.id !== tl.id) })).filter((x) => x.tools.length) }); say(t('mytools.deleted', { label: tl.label })); });
        list.append(el('li', {}, el('span', { className: 'cc-mt-name' }, g.name + ' › ' + tl.label), tl.key ? el('kbd', {}, tl.key) : '', edit, del));
      }
    }
    if (!data.groups.length) list.append(el('li', { className: 'cc-mt-empty' }, t('mytools.none')));
    const add = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { mtAdd: '' } }, t('mytools.add'));
    const imp = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { mtImport: '' } }, t('mytools.import'));
    const cuix = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { mtCuix: '' } }, t('mytools.import_cuix'));
    const exp = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { mtExport: '' }, disabled: !data.groups.length }, t('mytools.export'));
    add.addEventListener('click', () => editTool(null));
    imp.addEventListener('click', () => pick('.json,application/json', async (f) => importJson(await f.text())));
    cuix.addEventListener('click', () => pick('.cuix', async (f) => importCuix(new Uint8Array(await f.arrayBuffer()))));
    exp.addEventListener('click', () => exportJson());
    box.replaceChildren(el('legend', {}, t('mytools.legend')), el('p', { className: 'shell-hint-text' }, t('mytools.hint')), list, el('div', { className: 'cc-mt-actions' }, add, imp, cuix, exp), said);
  }
  const say = (s) => { said.textContent = s; };
  function pick(accept, fn) {
    const inp = el('input', { type: 'file', accept, hidden: true });
    inp.addEventListener('change', () => { const f = inp.files[0]; inp.remove(); if (f) fn(f).catch((err) => say(t('mytools.import.failed', { why: err.message }))); });
    document.body.append(inp);
    inp.click();
  }

  function importJson(text) {
    let v;
    try { v = JSON.parse(text); } catch { say(t('mytools.err.format')); return null; }
    const r = cleanTools(v);
    const m = mergeTools(data, r.data.groups);
    save(m.data);
    const errs = [...r.errors, ...m.errors].map((e) => t(e.key, e.fills || {}));
    say(t('mytools.imported', { n: r.data.groups.reduce((s, g) => s + g.tools.length, 0) }) + (errs.length ? ' ' + errs.join(' ') : ''));
    return m;
  }
  function exportJson() { download?.('my-tools.json', exportTools(data), 'application/json'); }

  async function importCuix(bytes) {
    let r;
    try { r = await readCuix(bytes, { lookup, getvar }); } catch (err) { say(t('mytools.cuix.bad', { why: t('mytools.cuix.err.' + (['zip', 'too_big', 'xml', 'doctype', 'not_cuix'].includes(err.message) ? err.message : 'zip')) })); return null; }
    const groups = r.groups.map((g) => ({ ...g, name: g.shortcuts ? t('mytools.cuix.keys_group') : g.name }));
    if (r.aliases.length) groups.push({ name: t('mytools.cuix.aliases_group'), tools: r.aliases.map((a) => ({ label: a.alias + ' (' + a.command + ')', macro: '^C^C' + a.command })) });
    const m = mergeTools(data, groups);
    save(m.data);
    const n = groups.reduce((s, g) => s + g.tools.length, 0);
    const lines = [t('mytools.cuix.done', { groups: groups.length, n })];
    if (r.missing.length) lines.push(t('mytools.cuix.missing', { list: r.missing.join(', ') }));
    for (const e of [...r.notes, ...m.errors]) lines.push(t(e.key, e.fills || {}));
    say(lines.join(' '));
    for (const l of lines) print(l);
    return { ...r, merged: m };
  }

  // ---- the edit dialog: group, label, macro, key (press it), icon (PNG or SVG ≤ 64 KB) ----
  function editTool(id) {
    const cur = id ? findTool(id) : null;
    const st = { icon: cur?.tool.icon || null, key: cur?.tool.key || '' };
    const fld = (label, input, hint) => el('div', { className: 'cc-mt-field' }, el('label', { htmlFor: input.id }, label), input, hint ? el('span', { className: 'cc-note' }, hint) : '');
    const grp = el('input', { type: 'text', className: 'cc-input', id: 'cc-mt-group', value: cur?.group.name || data.groups[0]?.name || t('mytools.default_group'), maxLength: 60 });
    const lab = el('input', { type: 'text', className: 'cc-input', id: 'cc-mt-label', value: cur?.tool.label || '', maxLength: 80 });
    const mac = el('input', { type: 'text', className: 'cc-input', id: 'cc-mt-macro', value: cur?.tool.macro || '^C^C', spellcheck: false });
    const key = el('input', { type: 'text', className: 'cc-input', id: 'cc-mt-key', value: st.key, readOnly: true, placeholder: t('mytools.key.placeholder') });
    const prev = el('span', { className: 'cc-mt-preview' });
    const showIcon = () => prev.replaceChildren(st.icon ? el('img', { src: st.icon, alt: '', width: 24, height: 24 }) : el('span', { className: 'cc-note' }, t('mytools.icon.none')));
    showIcon();
    const iconBtn = el('button', { type: 'button', className: 'btn-line btn-sm-cc' }, t('mytools.icon.pick'));
    const iconOff = el('button', { type: 'button', className: 'btn-link-cc' }, t('mytools.icon.remove'));
    const err = el('p', { className: 'cc-dcl-err', role: 'alert' });
    key.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      if (e.key === 'Backspace' || e.key === 'Delete') { st.key = ''; key.value = ''; return; }
      const k = keyOfEvent(e);
      if (k) { st.key = k; key.value = k; }
    });
    iconBtn.addEventListener('click', () => pick('.png,.svg,image/png,image/svg+xml', async (f) => {
      const u = iconFromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
      if (!u) { err.textContent = t('mytools.err.icon', { label: f.name }); return; }
      st.icon = u; showIcon();
    }));
    iconOff.addEventListener('click', () => { st.icon = null; showIcon(); });
    const dlg = el('dialog', { className: 'cc-dialog cc-ask cc-mt-dlg', 'aria-labelledby': 'cc-mt-h' },
      el('div', { className: 'cc-plot-head' }, el('h2', { className: 'cc-h', id: 'cc-mt-h' }, t(cur ? 'mytools.dlg.edit' : 'mytools.dlg.add'))),
      el('div', { className: 'cc-al-body' },
        fld(t('mytools.f.group'), grp), fld(t('mytools.f.label'), lab), fld(t('mytools.f.macro'), mac, t('mytools.f.macro.hint')),
        fld(t('mytools.f.key'), key, t('mytools.f.key.hint')),
        el('div', { className: 'cc-mt-field' }, el('span', {}, t('mytools.f.icon')), el('div', { className: 'cc-row' }, prev, iconBtn, iconOff)), err),
      el('div', { className: 'cc-plot-foot' },
        el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { key: 'cancel' } }, t('mytools.cancel')),
        el('button', { type: 'button', className: 'btn-plot btn-sm-cc', dataset: { key: 'ok' } }, t('mytools.save'))));
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-key]');
      if (!b) return;
      if (b.dataset.key === 'cancel') { dlg.close(); return; }
      const label = lab.value.trim(), macro = mac.value.trim(), gname = grp.value.trim() || t('mytools.default_group');
      if (!label || !macro || macro === '^C^C') { err.textContent = t('mytools.err.fill'); return; }
      const taken = new Map([...takenElsewhere(), ...[...keyMap(data)].filter(([, v]) => v.tool.id !== id).map(([k, v]) => [k, v.tool.label])]);   // command shortcuts too (WL.18)
      if (st.key) { const why = keyProblem(st.key, taken); if (why) { err.textContent = t('mytools.err.key.' + why, { label, key: st.key, other: taken.get(normKey(st.key)) || '' }); return; } }
      const p = parseMacro(macro, { getvar });
      const miss = p.commands.filter((c) => !lookup(c));
      if (miss.length) { err.textContent = t('mytools.err.unknown', { list: miss.join(', ') }); return; }
      const tool = { id: id || undefined, label, macro, ...(st.icon ? { icon: st.icon } : {}), ...(st.key ? { key: st.key } : {}) };
      let groups = data.groups.map((g) => ({ ...g, tools: g.tools.filter((x) => x.id !== id) }));
      const at = groups.findIndex((g) => g.name.toUpperCase() === gname.toUpperCase());
      if (at >= 0) { const i = cur && cur.group.name.toUpperCase() === gname.toUpperCase() ? cur.group.tools.findIndex((x) => x.id === id) : -1; groups[at].tools.splice(i >= 0 ? i : groups[at].tools.length, 0, tool); }
      else groups.push({ name: gname, tools: [tool] });
      groups = groups.filter((g) => g.tools.length);
      const r = cleanTools({ ...data, groups });
      save(r.data);
      say(t('mytools.saved', { label }));
      dlg.close();
    });
    dlg.addEventListener('close', () => { dlg.remove(); focusCommandLine?.(); });
    (document.querySelector('dialog[open]') || root).append(dlg);
    dlg.showModal();
    lab.focus();
  }

  render();
  void ask;
  return { run, data: () => data, set: (v) => save(cleanTools(v).data), importCuix, importJson, exportJson, editTool };
}
