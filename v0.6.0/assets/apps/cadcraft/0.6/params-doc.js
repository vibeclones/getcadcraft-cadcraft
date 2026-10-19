/* SPDX-License-Identifier: Apache-2.0 */
/**
 * params-doc.js — CadCraft's adapter for the parametric engine (params.js) and every parameter / constraint edit
 * as one undo step (DOM-free; bin/test-cadcraft-constraints.mjs runs it).
 *
 * Targets: each dimensional constraint, key "c:<constraint id>" (label "d1 (Horizontal)", kind length|angle,
 * min 0, radius/diameter above 0, an angle between lines at most 180°, an arc's sweep below 360°). Its link's
 * expression is its own name, and the parameter of that name holds the expression — so "d1" in the Parameters
 * panel, "d1" in any other expression and the label on the drawing are one thing.
 *
 * Every edit works on a draft (copies of doc.constraints and doc.params), resolves it forward (applyParams), solves
 * the touched geometry (gcons.solveConstraints, the first thing a dimension measures from held when it can be) and
 * only then writes it all in one doc.change(): a solve that fails changes nothing and says why.
 *
 *   addConstraint(doc, type, refs, { loc, expr, name, pinFirst }) → { ok, c, error }
 *   setDimInput(doc, cid, text)          "40", "width / 2", "d2=width/2" (renames it) → { ok, error }
 *   driveConstraint(doc, cid, value, { prefer })   typed number on a constraint: driven → solves its parameter
 *   setParameter(doc, name, expr, { note, rename }) · driveParameter(doc, name, value, { prefer })
 *   removeParameter(doc, name, { inline }) · removeConstraints(doc, ids, label) → { ok, removed }
 *   describe(doc) → { rows: [{ name, expr, value, error, kind: 'dim'|'user', constraint?, driving, usedBy }], status }
 *   parseDimInput(text) → { name?, expr } · solveAll(doc, label) (re-resolve everything; e.g. after opening)
 * Ambiguity (several driving parameters behind a value) comes back as { ok: false, choices: [names] }.
 */

import { applyParams, driveBack, driveVar, setVar, removeVar, cloneParams, varByName, usesOf, evaluateVars, nameProblem } from './params.js';
import { parse, literal, formatNumber, NAME_RE } from './expr.js';
import {
  DIMENSIONAL, TYPES, isDim, targetKey, makeConstraint, solveConstraints, describeConstraint, dropDimParams, nextId,
  statusText, status, labelOf, fmtValue,
} from './gcons.js';
import { analyze, components, fieldsOf, refKind } from './gsolve.js';

import { t } from './i18n.js';
/** The adapter over a draft { doc, constraints }. */
export const docAdapter = {
  targets(draft) {
    const m = new Map();
    for (const c of draft.constraints) {
      if (!isDim(c)) continue;
      const T = DIMENSIONAL[c.type];
      const arc = c.type === 'angle' && draft.doc.model.get(c.refs[0].e)?.type === 'arc' && c.refs.length === 1;
      m.set(targetKey(c), {
        label: c.name + ' (' + T.label.toLowerCase() + ')', kind: T.kind,
        get: () => c.value, set: (v) => { c.value = v; },
        min: c.type === 'radius' || c.type === 'diameter' ? 1e-9 : c.type === 'angle' ? 1e-9 : 0,
        ...(c.type === 'angle' ? { max: arc ? 360 - 1e-9 : 180 } : {}),
      });
    }
    return m;
  },
  afterApply(draft, changed) { draft.changed = changed; return {}; },
};

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Fields held while a dimension changes: the first point it measures from (AutoCAD moves the second). */
function softPins(doc, cs) {
  const pins = new Set();
  for (const c of cs) {
    const r = c.refs[0];
    const e = doc.model.get(r.e);
    if (!e) continue;
    const add = (...fs) => fs.forEach((f) => pins.add(r.e + '|' + f));
    switch (refKind(e, r.k)) {
      case 'P':
        if (e.type === 'line') { if (r.k === 'p1') add('x1', 'y1'); else if (r.k === 'p2') add('x2', 'y2'); }
        else if (e.type === 'poly') { const i = +r.k.slice(1); add(i + 'x', i + 'y'); }
        else if (e.type === 'point') add('x', 'y');
        else if ((e.type === 'circle' || e.type === 'arc') && r.k === 'c') add('cx', 'cy');
        break;
      case 'R': if (e.type !== 'poly') add('cx', 'cy'); break;
      case 'L': if (e.type === 'line') add('x1', 'y1'); break;
      default: break;
    }
  }
  return pins;
}

/**
 * Resolve a draft and write it as one undo step. opts: { touch: Set(entity ids) to re-solve even with no value
 * change, added: [cid] (refused if redundant), pinned: Set held first (else the changed dimensions' first points) }.
 */
export function commit(doc, label, constraints, params, { touch = null, added = [], pinned = null } = {}) {
  const draft = { doc, constraints: constraints.map((c) => ({ ...c })), changed: [] };
  const ap = applyParams(draft, params, docAdapter);
  const paramErrors = ap.errors.filter((e) => !/^c:/.test(e.where) || draft.constraints.some((c) => targetKey(c) === e.where));
  if (paramErrors.length) return fail(errorText(draft, paramErrors), { errors: paramErrors });
  const changedCs = draft.constraints.filter((c) => draft.changed.includes(targetKey(c)));
  const only = new Set(touch || []);
  for (const c of changedCs) for (const r of c.refs) only.add(r.e);
  let updates = new Map();
  if (only.size) {
    const pins = pinned || softPins(doc, changedCs);
    const r = solveConstraints(doc, draft.constraints, { pinned: pins.size ? pins : null, only });
    if (!r.ok) {
      const names = [...new Set(r.conflicts)].map((id) => draft.constraints.find((c) => c.id === id)).filter(Boolean).slice(0, 3).map((c) => describeConstraint(doc, c));
      return fail(t('params.conflicts', { names: names.join('; ') }), { conflicts: r.conflicts });
    }
    updates = r.updates;
    if (added.length) {
      const get = (id) => updates.get(id) || doc.model.get(id);
      for (const g of components(draft.constraints)) {
        if (!g.some((c) => added.includes(c.id))) continue;
        const a = analyze(g, get);
        const bad = added.filter((id) => a.redundant.includes(id));
        if (bad.length) {
          const c = draft.constraints.find((k) => k.id === bad[0]);
          return fail(t('params.redundant', { what: describeConstraint(doc, c) }) + (isDim(c) ? ' ' + t('params.use_plain_dimension_dimlinear') : ''), { redundant: bad });
        }
      }
    }
  }
  doc.solving = true;
  try {
    doc.change(label, () => {
      doc.setParametric({ constraints: draft.constraints, params });
      for (const [id, e] of updates) doc.update(id, e, doc.model);
    });
  } finally { doc.solving = false; }
  return { ok: true, updates, values: ap.values };
}
function errorText(draft, errors) {
  return errors.slice(0, 3).map((e) => {
    const c = draft.constraints.find((k) => targetKey(k) === e.where);
    return (c ? c.name : e.where) + ': ' + e.message;
  }).join(' ');
}

/** "d2=width/2" → { name: 'd2', expr: 'width/2' }; "40" → { expr: '40' }. */
export function parseDimInput(text) {
  const s = String(text ?? '').trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.*)$/.exec(s);
  if (m) return { name: m[1], expr: m[2].trim() };
  return { expr: s };
}

export function addConstraint(doc, type, refs, { loc = null, expr = null, name = null, pinFirst = true, pinEntity = null } = {}) {
  const made = makeConstraint(doc, type, refs, { loc, name });
  if (made.error) return fail(made.error);
  const c = made.c;
  const params = cloneParams(doc.params);
  if (isDim(c)) {
    if (name) { const bad = nameProblem(name, params); if (bad) return fail(bad); }
    const e = expr === null || expr === '' ? formatNumber(round6(c.value)) : String(expr);
    const r = parse(e, params.vars.map((v) => v.name));
    if (!r.ok) return fail(r.error);
    params.vars.push({ name: c.name, expr: e });
    params.links.push({ target: targetKey(c), expr: c.name });
  }
  const cs = [...doc.constraints, c];
  // as in AutoCAD, the first object stays and the second one moves to meet the constraint (when it can)
  const pinId = pinEntity ?? refs[0].e;
  const first = doc.model.get(pinId);
  const pinned = new Set();
  if (pinFirst && !isDim(c) && refs.length > 1 && first && refs.some((r) => r.e !== pinId)) for (const f of fieldsOf(first)) pinned.add(pinId + '|' + f);
  // a symmetry line stays where it is too
  const axis = type === 'symmetric' ? doc.model.get(refs[2].e) : null;
  if (pinFirst && axis && refs[2].e !== refs[0].e && refs[2].e !== refs[1].e) for (const f of fieldsOf(axis)) pinned.add(refs[2].e + '|' + f);
  const touch = new Set(refs.map((r) => r.e));
  const res = commit(doc, TYPES[type].label.toUpperCase(), cs, params, { touch, added: [c.id], pinned: pinned.size ? pinned : null });
  return res.ok ? { ...res, c: doc.constraints.find((k) => k.id === c.id) } : res;
}

/** The text typed for a dimensional constraint: a number, an expression, or "name=expression". */
export function setDimInput(doc, cid, text) {
  const c = doc.constraints.find((k) => k.id === cid);
  if (!c || !isDim(c)) return fail(t('params.constraint_gone'));
  const { name, expr } = parseDimInput(text);
  if (!expr) return fail(t('params.type_value_expression_like'));
  const params = cloneParams(doc.params);
  const cs = doc.constraints.map((k) => ({ ...k }));
  const me = cs.find((k) => k.id === cid);
  if (name && name !== c.name) {
    const r = setVar(params, name, varByName(params, c.name)?.expr ?? formatNumber(c.value), { rename: c.name });
    if (!r.ok) return fail(r.error);
    me.name = name;
  }
  const lit = literal(expr);
  const cur = varByName(params, me.name);
  if (lit !== null && cur && literal(cur.expr) === null) {
    // a number typed over an expression: solve the parameter behind it (two-way)
    return driveConstraintIn(doc, cs, params, cid, lit, {});
  }
  const r = setVar(params, me.name, expr);
  if (!r.ok) return fail(r.error);
  return commit(doc, 'CONSTRAINT VALUE', cs, params);
}

/** A number typed into a dimensional constraint. Unlinked/literal → set; driven → its driving parameter is solved. */
export function driveConstraint(doc, cid, value, opts = {}) {
  return driveConstraintIn(doc, doc.constraints.map((k) => ({ ...k })), cloneParams(doc.params), cid, value, opts);
}
function driveConstraintIn(doc, cs, params, cid, value, { prefer = null } = {}) {
  const c = cs.find((k) => k.id === cid);
  if (!c || !isDim(c)) return fail(t('params.constraint_gone'));
  const draft = { doc, constraints: cs };
  const r = driveBack(params, docAdapter, draft, targetKey(c), value, { prefer });
  if (!r.ok) return fail(r.error, { choices: r.choices || [] });
  if (r.direct) { const v = varByName(params, c.name); if (v) v.expr = formatNumber(value); }
  const res = commit(doc, 'CONSTRAINT VALUE', cs, params);
  if (res.ok && r.var && r.var !== c.name) res.message = t('params.is_now', { name: r.var, value: formatNumber(r.to) });
  return res;
}

export function setParameter(doc, name, expr, { note, rename } = {}) {
  const params = cloneParams(doc.params);
  const cs = doc.constraints.map((k) => ({ ...k }));
  const r = setVar(params, name, String(expr ?? '').trim(), { note, rename });
  if (!r.ok) return fail(r.error);
  if (rename !== undefined && rename !== name) for (const c of cs) if (isDim(c) && c.name === rename) c.name = name;
  return commit(doc, rename !== undefined && rename !== name ? 'RENAME PARAMETER' : 'PARAMETER', cs, params);
}

export function driveParameter(doc, name, value, { prefer = null } = {}) {
  const params = cloneParams(doc.params);
  const r = driveVar(params, name, value, { prefer });
  if (!r.ok) return fail(r.error, { choices: r.choices || [] });
  const res = commit(doc, 'PARAMETER', doc.constraints, params);
  if (res.ok && r.var && r.var !== name) res.message = t('params.is_now', { name: r.var, value: formatNumber(r.to) });
  return res;
}

export function removeParameter(doc, name, { inline = false } = {}) {
  const c = doc.constraints.find((k) => isDim(k) && k.name === name);
  if (c) return fail(t('params.is_dimensional', { name }));
  const params = cloneParams(doc.params);
  const r = removeVar(params, name, { inline });
  if (!r.ok) return fail(r.error, { uses: r.uses });
  return commit(doc, 'DELETE PARAMETER', doc.constraints, params);
}

/** Remove constraints (dimensional ones take their parameter along; its value goes into whatever used it). */
export function removeConstraints(doc, ids, label = 'DELCONSTRAINT') {
  const gone = doc.constraints.filter((c) => ids.includes(c.id));
  if (!gone.length) return { ok: true, removed: 0 };
  const params = dropDimParams(doc.params, gone);
  doc.solving = true;
  try { doc.change(label, () => doc.setParametric({ constraints: doc.constraints.filter((c) => !ids.includes(c.id)), params })); } finally { doc.solving = false; }
  return { ok: true, removed: gone.length };
}

/** Re-resolve every parameter and solve every group (say, after opening a file whose constraints are not met). */
export function solveAll(doc, label = 'SOLVE') {
  const touch = new Set(doc.constraints.flatMap((c) => c.refs.map((r) => r.e)));
  return commit(doc, label, doc.constraints, cloneParams(doc.params), { touch });
}

/** Rows for the Parameters panel and the -PARAMETERS list. */
export function describe(doc) {
  const p = doc.params;
  const ev = evaluateVars(p);
  const rows = p.vars.map((v) => {
    const c = doc.constraints.find((k) => isDim(k) && k.name === v.name) || null;
    const u = usesOf(p, v.name);
    return {
      name: v.name, expr: v.expr, note: v.note || '', value: ev.values.get(v.name) ?? null, error: ev.errors.get(v.name) || null,
      kind: c ? 'dim' : 'user', constraint: c, type: c ? DIMENSIONAL[c.type].label : t('params.user_parameter'),
      driving: literal(v.expr) !== null, usedBy: [...u.vars, ...u.links.filter((t) => !c || t !== targetKey(c)).map((t) => t)],
      label: c ? labelOf(c, p) : null, shown: c ? fmtValue(c, c.value) : null,
    };
  });
  return { rows, status: statusText(doc), analysis: status(doc) };
}

export { NAME_RE, nextId };
