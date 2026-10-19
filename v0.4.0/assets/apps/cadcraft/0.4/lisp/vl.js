/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: error messages are the language's own (routines compare them), not UI. */
/**
 * vl.js — the vl- functions that need no drawing (0.4 part 2, Y.11; session cad-lisp). DOM-free.
 *
 *   lists     vl-sort vl-sort-i vl-remove vl-remove-if vl-remove-if-not vl-member-if vl-member-if-not vl-some vl-every
 *             vl-position vl-list* vl-list-length vl-consp
 *   strings   vl-string-search vl-string-subst vl-string-trim vl-string-left-trim vl-string-right-trim vl-string-translate
 *             vl-string-position vl-string-mismatch vl-string-elt vl-string->list vl-list->string vl-princ-to-string
 *             vl-prin1-to-string
 *   symbols   vl-symbolp vl-symbol-name vl-symbol-value vl-bb-set vl-bb-ref vl-doc-set vl-doc-ref vl-propagate
 *   errors    vl-catch-all-apply vl-catch-all-error-p vl-catch-all-error-message vl-exit-with-value vl-exit-with-error
 *   files     vl-directory-files vl-file-copy · registry: vl-registry-read / -write (no registry here: nil)
 */
import { Sym, T, int, Cons, LispError, fromArray, toArray, isProper, truthy, bool, show } from './types.js';
import { arity, str, intv, lst, symv, equal } from './builtins.js';

/** What vl-catch-all-apply returns when the call failed. */
export class CatchError {
  constructor(message) { this.message = message; this.lispType = 'VL-CATCH-ALL-APPLY-ERROR'; }
  show() { return '#<%catch-all-apply-error%>'; }
}

export function installVl(L) {
  const d = (name, fn) => L.def(name, fn);
  const test = async (f, x) => truthy(await L.apply(f, [x]));

  // ---- lists ----
  /** A stable merge sort with an async comparison (the routine's own function). */
  async function sortBy(items, f) {
    const a = items.map((v, i) => ({ v, i }));
    const merge = async (lo, hi) => {
      if (hi - lo < 2) return a.slice(lo, hi);
      const mid = (lo + hi) >> 1;
      const left = await merge(lo, mid), right = await merge(mid, hi), out = [];
      let i = 0, j = 0;
      while (i < left.length && j < right.length) {
        if (truthy(await L.apply(f, [right[j].v, left[i].v]))) out.push(right[j++]); else out.push(left[i++]);
      }
      return out.concat(left.slice(i), right.slice(j));
    };
    return merge(0, a.length);
  }
  d('VL-SORT', async (a, L) => { arity(a, 2); return fromArray((await sortBy(toArray(lst(a[0])), L.fnOf(a[1]))).map((x) => x.v)); });
  d('VL-SORT-I', async (a, L) => { arity(a, 2); return fromArray((await sortBy(toArray(lst(a[0])), L.fnOf(a[1]))).map((x) => int(x.i))); });
  d('VL-REMOVE', (a) => { arity(a, 2); return fromArray(toArray(lst(a[1])).filter((x) => !equal(x, a[0]))); });
  d('VL-REMOVE-IF', async (a, L) => { arity(a, 2); const f = L.fnOf(a[0]), out = []; for (const x of toArray(lst(a[1]))) if (!(await test(f, x))) out.push(x); return fromArray(out); });
  d('VL-REMOVE-IF-NOT', async (a, L) => { arity(a, 2); const f = L.fnOf(a[0]), out = []; for (const x of toArray(lst(a[1]))) if (await test(f, x)) out.push(x); return fromArray(out); });
  d('VL-MEMBER-IF', async (a, L) => { arity(a, 2); const f = L.fnOf(a[0]); for (let x = lst(a[1]); x instanceof Cons; x = x.cdr) if (await test(f, x.car)) return x; return null; });
  d('VL-MEMBER-IF-NOT', async (a, L) => { arity(a, 2); const f = L.fnOf(a[0]); for (let x = lst(a[1]); x instanceof Cons; x = x.cdr) if (!(await test(f, x.car))) return x; return null; });
  const lists = (a) => a.slice(1).map((x) => toArray(lst(x)));
  d('VL-SOME', async (a, L) => {
    arity(a, 2, Infinity);
    const f = L.fnOf(a[0]), ls = lists(a), n = Math.min(...ls.map((x) => x.length));
    for (let i = 0; i < n; i++) { const r = await L.apply(f, ls.map((x) => x[i])); if (truthy(r)) return r; }
    return null;
  });
  d('VL-EVERY', async (a, L) => {
    arity(a, 2, Infinity);
    const f = L.fnOf(a[0]), ls = lists(a), n = Math.min(...ls.map((x) => x.length));
    for (let i = 0; i < n; i++) if (!truthy(await L.apply(f, ls.map((x) => x[i])))) return null;
    return T;
  });
  d('VL-POSITION', (a) => { arity(a, 2); let i = 0; for (let x = lst(a[1]); x instanceof Cons; x = x.cdr, i++) if (equal(x.car, a[0])) return int(i); return null; });
  d('VL-LIST*', (a) => { arity(a, 1, Infinity); return fromArray(a.slice(0, -1), a[a.length - 1]); });
  d('VL-LIST-LENGTH', (a) => { arity(a, 1); lst(a[0]); return isProper(a[0]) ? int(toArray(a[0]).length) : null; });
  d('VL-CONSP', (a) => { arity(a, 1); return bool(a[0] instanceof Cons); });

  // ---- strings ----
  d('VL-STRING-SEARCH', (a) => { arity(a, 2, 3); const i = str(a[1]).indexOf(str(a[0]), a.length > 2 ? intv(a[2]) : 0); return i < 0 ? null : int(i); });
  d('VL-STRING-SUBST', (a) => {
    arity(a, 3, 4);
    const nw = str(a[0]), pat = str(a[1]), s = str(a[2]), from = a.length > 3 ? intv(a[3]) : 0;
    const i = s.indexOf(pat, from);
    return i < 0 ? s : s.slice(0, i) + nw + s.slice(i + pat.length);
  });
  const trimSet = (set, s, left, right) => {
    let i = 0, j = s.length;
    if (left) while (i < j && set.includes(s[i])) i++;
    if (right) while (j > i && set.includes(s[j - 1])) j--;
    return s.slice(i, j);
  };
  d('VL-STRING-TRIM', (a) => { arity(a, 2); return trimSet(str(a[0]), str(a[1]), true, true); });
  d('VL-STRING-LEFT-TRIM', (a) => { arity(a, 2); return trimSet(str(a[0]), str(a[1]), true, false); });
  d('VL-STRING-RIGHT-TRIM', (a) => { arity(a, 2); return trimSet(str(a[0]), str(a[1]), false, true); });
  d('VL-STRING-TRANSLATE', (a) => {
    arity(a, 3);
    const src = str(a[0]), dst = str(a[1]);
    return [...str(a[2])].map((c) => { const k = src.indexOf(c); return k < 0 ? c : k < dst.length ? dst[k] : dst[dst.length - 1] ?? c; }).join('');
  });
  d('VL-STRING-POSITION', (a) => {
    arity(a, 2, 4);
    const ch = String.fromCharCode(intv(a[0])), s = str(a[1]), start = a.length > 2 && a[2] !== null ? intv(a[2]) : null, back = truthy(a[3]);
    const i = back ? s.lastIndexOf(ch, start ?? s.length) : s.indexOf(ch, start ?? 0);
    return i < 0 ? null : int(i);
  });
  d('VL-STRING-MISMATCH', (a) => {
    arity(a, 2, 5);
    const s1 = str(a[0]), s2 = str(a[1]), p1 = a[2] ? intv(a[2]) : 0, p2 = a[3] ? intv(a[3]) : 0, ic = truthy(a[4]);
    let n = 0;
    while (p1 + n < s1.length && p2 + n < s2.length && (ic ? s1[p1 + n].toUpperCase() === s2[p2 + n].toUpperCase() : s1[p1 + n] === s2[p2 + n])) n++;
    return int(n);
  });
  d('VL-STRING-ELT', (a) => { arity(a, 2); const s = str(a[0]), i = intv(a[1]); if (i < 0 || i >= s.length) throw new LispError('bad argument value: ' + show(a[1])); return int(s.charCodeAt(i)); });
  d('VL-STRING->LIST', (a) => { arity(a, 1); return fromArray([...str(a[0])].map((c) => int(c.charCodeAt(0)))); });
  d('VL-LIST->STRING', (a) => { arity(a, 1); return toArray(lst(a[0])).map((c) => String.fromCharCode(intv(c))).join(''); });
  d('VL-PRINC-TO-STRING', (a) => { arity(a, 1); return show(a[0], false); });
  d('VL-PRIN1-TO-STRING', (a) => { arity(a, 1); return show(a[0], true); });

  // ---- symbols ----
  d('VL-SYMBOLP', (a) => { arity(a, 1); return bool(a[0] instanceof Sym); });
  d('VL-SYMBOL-NAME', (a) => { arity(a, 1); return symv(a[0]).name; });
  d('VL-SYMBOL-VALUE', (a, L) => { arity(a, 1); return L.get(symv(a[0])); });
  const bb = new Map();
  d('VL-BB-SET', (a) => { arity(a, 2); bb.set(symv(a[0]), a[1]); return a[1]; });
  d('VL-BB-REF', (a) => { arity(a, 1); return bb.get(symv(a[0])) ?? null; });
  d('VL-DOC-SET', (a, L) => { arity(a, 2); return L.set(symv(a[0]), a[1]) ?? null; });
  d('VL-DOC-REF', (a, L) => { arity(a, 1); return L.get(symv(a[0])); });

  // ---- errors ----
  d('VL-CATCH-ALL-APPLY', async (a, L) => {
    arity(a, 2);
    L.catching++;
    try { return await L.apply(L.fnOf(a[0]), toArray(lst(a[1]))); }
    catch (err) {
      const e = L.lispError(err);
      if (e.cancel) throw e;   // Esc still stops the routine
      return new CatchError(e.message);
    } finally { L.catching--; }
  });
  d('VL-CATCH-ALL-ERROR-P', (a) => { arity(a, 1); return bool(a[0] instanceof CatchError); });
  d('VL-CATCH-ALL-ERROR-MESSAGE', (a) => { arity(a, 1); if (!(a[0] instanceof CatchError)) throw new LispError('bad argument type: catch-all-apply-error: ' + show(a[0])); return a[0].message; });
  d('VL-EXIT-WITH-VALUE', (a) => { arity(a, 1); throw new LispError('quit / exit abort', { value: a[0] }); });
  d('VL-EXIT-WITH-ERROR', (a) => { arity(a, 1); throw new LispError(str(a[0])); });

  // ---- files and registry ----
  d('VL-DIRECTORY-FILES', (a, L) => {
    const pat = a[1] ? str(a[1]) : '*.*';
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return fromArray([...L.files.values()].map((f) => f.name.replace(/\\/g, '/').split('/').pop()).filter((n) => re.test(n)));
  });
  d('VL-FILE-COPY', (a, L) => { arity(a, 2, 3); const f = L.findFile(str(a[0])); if (!f) return null; const dst = str(a[1]); const old = truthy(a[2]) ? L.findFile(dst)?.text ?? '' : ''; L.putFile(dst, old + f.text); return int(f.text.length); });
  d('VL-MKDIR', () => T);
  d('VL-REGISTRY-READ', () => null);
  d('VL-REGISTRY-WRITE', () => null);
  d('VL-REGISTRY-DESCENDENTS', () => null);
  d('VL-GET-RESOURCE', () => null);
}

