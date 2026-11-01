/* SPDX-License-Identifier: Apache-2.0 */
/**
 * text.js — the Apparel add-on's words. Every string a person reads comes from the add-on's own language file
 * (lang/<locale>.json) through `t()`. main.js hands in the loader's `api.t`; the Node tests hand in a lookup over
 * lang/en.json. Until one is set, `t()` returns the key, so a missing hookup shows up as raw keys, never as English
 * hard-coded here.
 */

let impl = null;

/** Use this translate function from now on: (key, vars) → string. */
export function setT(fn) { impl = typeof fn === 'function' ? fn : null; }

/** A translated string; `{name}` fills from vars. */
export function t(key, vars = {}) {
  if (impl) return impl(key, vars);
  return key;
}

/** A plain lookup over a catalogue object, with `{name}` fills (for Node and for tests). */
export function lookupFrom(strings) {
  return (key, vars = {}) => {
    let s = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
    if (s && typeof s === 'object') s = (vars.n !== undefined && s['=' + vars.n]) || (Number(vars.n) === 1 && s.one) || s.other || key;   // plurals (English rules)
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
  };
}
