/* SPDX-License-Identifier: Apache-2.0 */
/**
 * proppanel.js — the parts of a Properties panel that do not know which app they are in (0.4 P.1, P.13; owner: session
 * cad-props). CadCraft's panel (props.js) is built from these; another app can take a byte-identical copy and feed it
 * its own descriptors (propdefs.js shape: { key, sec, kind, label, get, set, pt, gt0, min, max, choices, title }).
 * Imports nothing: words come through `opts.t`, values are read and written through `opts.read` / `opts.show`.
 *
 *   prefs(storeKey)                         → { closed: Set of section keys, kw: label column width (rem) | null, save() }
 *   section(key, label, prefs, body…)       → <details class="cc-psec" data-sec=key> that remembers open / closed
 *   divider(container, prefs, t)            → the drag handle between labels and values (role=separator; arrows, Home)
 *   field(def, value, opts)                 → [label, control] for one descriptor; opts:
 *       id        the control's id
 *       t         (key, vars) → text
 *       show      (def, v) → the text a number field shows (formatted)
 *       edit      (def, v) → the text it shows while it is being edited (full precision)
 *       read      (def, raw) → { ok, value } | { ok: false, error }
 *       set       (def, value) → void (the app changes every selected object, one undo step)
 *       note      (message) → void (a refused entry: the panel's live note)
 *       controls  { [kind]: (def, value, set, id) → element } for the app's own selects (layer, color, lt, lw, mat…)
 *       pick      (def) → void (the pick button beside a point; absent = no button)
 *   VARIES                                  the shared "these objects differ" value (same symbol as propdefs.js uses:
 *                                           pass it in opts.varies)
 *
 * Number fields: Enter or leaving the field applies; Esc puts the old value back; a bad entry is refused with the
 * reason (aria-invalid + the note), never applied as 0. While a field has focus it shows full precision.
 */

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') n.className = v;
    else if (k === 'htmlFor') n.htmlFor = v;   // a label's for= (setAttribute('htmlFor') named nothing)
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
export { el as pel };

/** Remembered panel settings in localStorage (private windows: memory only). */
export function prefs(storeKey) {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch { data = {}; }
  const p = {
    closed: new Set(Array.isArray(data.closed) ? data.closed.filter((k) => typeof k === 'string') : []),
    kw: Number.isFinite(data.kw) && data.kw >= 4 && data.kw <= 30 ? data.kw : null,
    extra: data.extra && typeof data.extra === 'object' ? data.extra : {},
    save() { try { localStorage.setItem(storeKey, JSON.stringify({ closed: [...p.closed], kw: p.kw, extra: p.extra })); } catch { /* fine */ } },
  };
  return p;
}

/** A foldable section that remembers whether it was open. */
export function section(key, label, pr, ...body) {
  const d = el('details', { className: 'cc-psec', dataset: { sec: key }, open: !pr.closed.has(key) },
    el('summary', { className: 'cc-psec-h' }, label), ...body);
  d.addEventListener('toggle', () => { if (d.open) pr.closed.delete(key); else pr.closed.add(key); pr.save(); });
  return d;
}

/** The label / value divider: drag it, or use the arrow keys; double-click or Home puts it back. */
export function divider(container, pr, t) {
  const apply = () => { if (pr.kw) container.style.setProperty('--cc-pk', pr.kw + 'rem'); else container.style.removeProperty('--cc-pk'); place(); };
  const h = el('div', { className: 'cc-pdiv', role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': t('props.divider'), title: t('props.divider.title') });
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const zoom = () => { const z = parseFloat(getComputedStyle(container).zoom); return z > 0 ? z : 1; };
  function place() {
    const grid = container.querySelector('.cc-props');
    const lab = grid?.firstElementChild;
    if (!lab) { h.hidden = true; return; }
    h.hidden = false;
    const cr = container.getBoundingClientRect(), lr = lab.getBoundingClientRect(), gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    h.style.left = ((lr.left - cr.left) + (pr.kw ? pr.kw * rem() * zoom() : lr.width) + gap / 2) / zoom() + 'px';
  }
  const setRem = (v) => { pr.kw = v === null ? null : Math.max(4, Math.min(30, v)); pr.save(); apply(); };
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const grid = container.querySelector('.cc-props');
    const left = grid ? grid.getBoundingClientRect().left : container.getBoundingClientRect().left;
    const move = (ev) => setRem((ev.clientX - left) / zoom() / rem());
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  });
  h.addEventListener('dblclick', () => setRem(null));
  h.addEventListener('keydown', (e) => {
    const cur = pr.kw ?? ((container.querySelector('.cc-props')?.firstElementChild?.getBoundingClientRect().width || 128) / zoom() / rem());
    if (e.key === 'ArrowLeft') { setRem(cur - 0.5); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowRight') { setRem(cur + 0.5); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Home') { setRem(null); e.preventDefault(); e.stopPropagation(); }
  });
  container.append(h);
  apply();
  return { place, apply, el: h };
}

const NUMERIC = new Set(['len', 'ang', 'num', 'int', 'area']);

/** One descriptor → [label, control]. */
export function field(def, value, o) {
  const { t, id } = o;
  const varies = value === o.varies;
  const title = def.title ? t(def.title) : undefined;
  const label = el('label', { htmlFor: id, title }, def.label);
  if (def.kind.startsWith('ro')) {
    const text = varies ? t('props.varies') : def.kind === 'ro' ? String(value ?? '') : o.show({ ...def, kind: def.kind.slice(3) }, value);
    return [el('span', { className: 'k', title }, def.label), el('span', { className: 'v', id, title: text }, text || '–')];
  }
  if (o.controls?.[def.kind]) return [label, o.controls[def.kind](def, value, (v) => o.set(def, v), id)];
  switch (def.kind) {
    case 'bool': {
      const b = el('input', { type: 'checkbox', id, checked: !varies && !!value });
      if (varies) b.indeterminate = true;
      b.addEventListener('change', () => o.set(def, b.checked));
      return [label, el('span', { className: 'cc-pbool' }, b)];
    }
    case 'choice': {
      const list = def.choices();
      const known = list.some(([k]) => String(k) === String(value));
      const s = el('select', { className: 'cc-select', id },
        varies ? el('option', { value: '\u0000varies', selected: true }, t('props.varies')) : null,
        !varies && !known && value !== undefined ? el('option', { value: String(value), selected: true }, String(value)) : null,
        ...list.map(([k, lab]) => el('option', { value: String(k), selected: !varies && String(k) === String(value) }, lab)));
      s.addEventListener('change', () => { if (s.value !== '\u0000varies') o.set(def, s.value); });
      return [label, s];
    }
    case 'text': case 'textarea': {
      const multi = def.kind === 'textarea';
      const shown = varies ? '' : String(value ?? '');
      const i = multi
        ? el('textarea', { className: 'cc-input', id, rows: Math.min(6, shown.split('\n').length + 1), placeholder: varies ? t('props.varies') : '' }, shown)
        : el('input', { type: 'text', className: 'cc-input', id, value: shown, maxLength: def.max || 2000, placeholder: varies ? t('props.varies') : '' });
      i.addEventListener('change', () => { if (varies && i.value === '') return; o.set(def, i.value); });
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { i.value = shown; i.blur(); e.stopPropagation(); }
        else if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); i.blur(); }
      });
      return multi ? [el('label', { htmlFor: id, className: 'span', title }, def.label), el('div', { className: 'span' }, i)] : [label, i];
    }
    default: break;
  }
  if (!NUMERIC.has(def.kind)) return [label, el('span', { className: 'v' }, String(value ?? ''))];
  // a number: formatted at rest, full precision while editing, typed values and expressions read by o.read
  const rest = varies ? '' : o.show(def, value);
  const i = el('input', { type: 'text', className: 'cc-input cc-pnum', id, value: rest, placeholder: varies ? t('props.varies') : '', title: title || (def.kind === 'ang' ? t('props.degrees') : t('props.expr.title')), autocomplete: 'off', spellcheck: false });
  let editing = false;
  const restore = () => { i.value = rest; i.removeAttribute('aria-invalid'); i.classList.remove('is-invalid'); };
  i.addEventListener('focus', () => { if (!varies && !editing) { editing = true; i.value = o.edit(def, value); i.select(); } });
  i.addEventListener('blur', () => { editing = false; if (i.getAttribute('aria-invalid') === 'true' || i.value === o.edit(def, value) || (varies && !i.value.trim())) restore(); });
  let sent = null;   // the text last applied: Enter applies, and the blur after it must not apply it again
  const commit = () => {
    const raw = i.value;
    if (raw === sent) return true;
    if (varies && !raw.trim()) return true;
    if (!varies && (raw === o.edit(def, value) || raw === rest)) return true;
    const r = o.read(def, raw);
    if (!r.ok) { i.setAttribute('aria-invalid', 'true'); i.classList.add('is-invalid'); o.note(r.error); return false; }
    i.removeAttribute('aria-invalid'); i.classList.remove('is-invalid');
    sent = raw;
    o.set(def, r.value);
    return true;
  };
  i.addEventListener('change', commit);
  i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (commit()) { editing = false; i.blur(); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); restore(); editing = false; i.blur(); }
  });
  return [label, i];
}

/** The sub-heading of a point (Start point, Center…) with its pick button. */
export function pointHead(label, o, def) {
  const kids = [label];
  if (o.pick) {
    const b = el('button', { type: 'button', className: 'cc-ppick', title: o.t('props.pick.title', { what: label }), 'aria-label': o.t('props.pick.title', { what: label }) },
      el('i', { className: 'bi bi-crosshair', 'aria-hidden': 'true' }));
    b.addEventListener('click', () => o.pick(def));
    kids.push(b);
  }
  return el('p', { className: 'cc-props-sub cc-ppt' }, ...kids);
}
