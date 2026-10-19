/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: error messages are the language's own (routines compare them), not UI. */
/**
 * cadfns.js — the LISP functions that reach the drawing (0.4 part 2, Y.4–Y.6; session cad-lisp). DOM-free.
 * Each calls the host (host-cad.js, directly or through the worker bridge) with plain data and turns the answer into
 * LISP values. `installCadFns(L)` adds:
 *
 *   input     initget getpoint getcorner getdist getangle getorient getreal getint getstring getkword entsel nentsel nentselp
 *   sets      ssget sslength ssname ssadd ssdel ssmemb ssnamex sssetfirst ssgetfirst
 *   commands  command command-s vl-cmdf
 *   objects   entget entmod entmake entmakex entdel entlast entnext handent entupd   (DXF lists, dxflist.js)
 *   tables    tblnext tblsearch tblobjname     system variables  getvar setvar
 *   misc      textbox osnap alert getcname getfiled acad_colordlg redraw regen grdraw grvecs vports
 */
import { Sym, sym, T, Int, int, Cons, cons, Ename, PickSet, LispError, MSG_CANCEL, isNum, numVal, isInt, fromArray, toArray, truthy, show } from './types.js';
import { arity, str, intv, num, lst, bad } from './builtins.js';

// ---- plain data ↔ LISP ----
export function toLisp(v) {
  if (v === null || v === undefined || v === false) return null;
  if (v === true) return T;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return fromArray(v.map(toLisp));
  if (typeof v === 'object') {
    if ('i' in v) return int(v.i);
    if ('e' in v) return new Ename(v.e);
    if ('ids' in v) return new PickSet(v.ids.slice());
    if ('sym' in v) return sym(v.sym);
  }
  return null;
}
export function fromLisp(x) {
  if (x === null || x === undefined) return null;
  if (x === T) return true;
  if (x instanceof Int) return { i: x.v };
  if (typeof x === 'number' || typeof x === 'string') return x;
  if (x instanceof Sym) return { sym: x.name };
  if (x instanceof Ename) return { e: x.id };
  if (x instanceof PickSet) return { ids: x.ids.slice() };
  if (x instanceof Cons) {
    if (x.car instanceof Int && !(x.cdr instanceof Cons) && x.cdr !== null) return [x.car.v, fromLisp(x.cdr)];   // a dotted pair → [code, value]
    return toArray(x).map(fromLisp);
  }
  if (typeof x.plain === 'function') return x.plain();
  return null;
}
/** A DXF list from the host ([[code, value]…]) → ((code . value) (10 x y z) …). */
export function pairsToLisp(pairs) {
  if (!pairs) return null;
  return fromArray(pairs.map(([code, v]) => (Array.isArray(v) ? cons(int(code), fromArray(v.map((n) => +n))) : cons(int(code), toLisp(v)))));
}
/** A LISP DXF list → [[code, value]…]; a value that is a list of numbers is a point. */
export function lispToPairs(l) {
  const out = [];
  for (const item of toArray(lst(l))) {
    if (!(item instanceof Cons) || !(item.car instanceof Int)) throw bad('dxf list', item);
    const code = item.car.v, rest = item.cdr;
    if (rest instanceof Cons) {
      const a = toArray(rest);
      if (code === -3) { out.push([code, a.map(fromLisp)]); continue; }
      if (!a.every(isNum)) throw bad('dxf list', item);
      out.push([code, a.map(numVal)]);
    } else out.push([code, fromLisp(rest)]);
  }
  return out;
}
const ptOf = (x) => { const a = toArray(lst(x)); if (a.length < 2 || !a.every(isNum)) throw bad('2D/3D point', x); return a.map(numVal); };
const isPt = (x) => x instanceof Cons && toArray(x).length >= 2 && toArray(x).length <= 3 && toArray(x).every(isNum);
const ename = (x) => { if (x instanceof Ename) return x.id; throw bad('lentityp', x); };
const pickset = (x) => { if (x instanceof PickSet) return x; throw bad('lselsetp', x); };

/** Host errors (Cancel, a refused value) → LISP errors. */
async function call(L, method, ...args) {
  if (!L.host || typeof L.host[method] !== 'function') throw new LispError('no drawing: ' + method);
  try { return await L.host[method](...args); }
  catch (err) {
    if (err && (err.name === 'Cancel' || err.cancel || err.message === 'Cancel')) throw new LispError(MSG_CANCEL, { cancel: true });
    throw err instanceof LispError ? err : new LispError(String(err?.message || err));
  }
}

export function installCadFns(L) {
  const d = (name, fn) => L.def(name, fn);
  L.initget = null;
  const takeInit = () => { const g = L.initget; L.initget = null; return g || { flags: 0, kw: null }; };
  const answer = (r) => {
    if (!r || r.none) return null;
    if (r.kw !== undefined) return r.kw;
    if (r.text !== undefined) return r.text;
    return toLisp(r.value);
  };

  d('INITGET', (a) => {
    arity(a, 0, 2);
    let flags = 0, kw = null;
    for (const x of a) { if (x instanceof Int) flags = x.v; else if (typeof x === 'string') kw = x; else if (x !== null) throw bad('stringp', x); }
    L.initget = { flags, kw };
    return null;
  });
  // (getpoint [pt] [msg]) and friends: the optional base point and the prompt in either order
  const ptMsg = (a) => {
    let base = null, msg = null;
    for (const x of a) { if (typeof x === 'string') msg = x; else if (x !== null) base = ptOf(x); }
    return { base, msg };
  };
  const getter = (kind, takesPt) => async (a, L) => {
    arity(a, 0, takesPt ? 2 : 1);
    const { base, msg } = takesPt ? ptMsg(a) : { base: null, msg: a[0] == null ? null : str(a[0]) };
    const g = takeInit();
    return answer(await call(L, 'get', kind, { msg, base, kw: g.kw, flags: g.flags }));
  };
  d('GETPOINT', getter('point', true));
  d('GETCORNER', async (a, L) => { arity(a, 1, 2); const g = takeInit(); return answer(await call(L, 'get', 'corner', { base: ptOf(a[0]), msg: a[1] == null ? null : str(a[1]), kw: g.kw, flags: g.flags })); });
  d('GETDIST', getter('dist', true));
  d('GETANGLE', getter('angle', true));
  d('GETORIENT', getter('orient', true));
  d('GETREAL', getter('real', false));
  d('GETINT', getter('int', false));
  d('GETKWORD', getter('kword', false));
  d('GETSTRING', async (a, L) => {
    arity(a, 0, 2);
    let msg = null;
    for (const x of a) if (typeof x === 'string') msg = x;
    takeInit();
    return answer(await call(L, 'get', 'string', { msg }));
  });
  const sel = (nested) => async (a, L) => {
    arity(a, 0, 2);
    const g = takeInit();
    const r = await call(L, 'entsel', { msg: typeof a[0] === 'string' ? a[0] : null, kw: g.kw }, nested);
    if (!r || r.none) return null;
    if (r.kw !== undefined) return r.kw;
    const out = [new Ename(r.e), fromArray(r.p.map(Number))];
    if (nested && r.matrix) out.push(fromArray(r.matrix.map((row) => fromArray(row.map(Number)))), fromArray((r.parents || []).map((p) => new Ename(p.e))));
    return fromArray(out);
  };
  d('ENTSEL', sel(false));
  d('NENTSEL', sel(true));
  d('NENTSELP', sel(true));

  // ---- selection sets ----
  d('SSGET', async (a, L) => {
    let mode = null, pts = [], filter = null;
    const rest = a.slice();
    if (typeof rest[0] === 'string') mode = rest.shift();
    for (const x of rest) {
      if (x === null) continue;
      if (isPt(x)) pts.push(ptOf(x));
      else if (x instanceof Cons && x.car instanceof Cons && x.car.car instanceof Int) filter = lispToPairs(x);   // ((0 . "LINE") …)
      else if (x instanceof Cons && isPt(x.car)) pts.push(...toArray(x).map(ptOf));
      else if (x instanceof Cons && x.car instanceof Cons && x.car.car instanceof Int && x.car.cdr === null) filter = lispToPairs(x);
      else throw bad('ssget', x);
    }
    const r = await call(L, 'ssget', { mode, pts, filter });
    return r && r.ids.length ? new PickSet(r.ids) : null;
  });
  d('SSLENGTH', (a) => { arity(a, 1); return int(pickset(a[0]).ids.length); });
  d('SSNAME', (a) => { arity(a, 2); const s = pickset(a[0]), i = isInt(a[1]) ? a[1].v : Math.trunc(num(a[1])); return i >= 0 && i < s.ids.length ? new Ename(s.ids[i]) : null; });
  d('SSADD', (a) => {
    arity(a, 0, 2);
    if (!a.length || a[0] === null) return new PickSet([]);
    const id = ename(a[0]);
    if (a.length < 2 || a[1] === null) return new PickSet([id]);
    const s = pickset(a[1]);
    if (!s.ids.includes(id)) s.ids.push(id);
    return s;
  });
  d('SSDEL', (a) => { arity(a, 2); const id = ename(a[0]), s = pickset(a[1]); const k = s.ids.indexOf(id); if (k < 0) return null; s.ids.splice(k, 1); return s; });
  d('SSMEMB', (a) => { arity(a, 2); const id = ename(a[0]); return pickset(a[1]).ids.includes(id) ? a[0] : null; });
  d('SSNAMEX', (a) => { arity(a, 1, 2); const s = pickset(a[0]); return fromArray(s.ids.map((id) => fromArray([int(0), new Ename(id), int(0)]))); });
  d('SSSETFIRST', async (a, L) => { arity(a, 1, 2); const s = a[1] ? pickset(a[1]) : null; await call(L, 'sssetfirst', s ? s.ids : []); return fromArray([null, a[1] ?? null]); });
  d('SSGETFIRST', async (a, L) => { const r = await call(L, 'ssgetfirst'); return fromArray([null, r ? new PickSet(r.ids) : null]); });

  // ---- commands ----
  const flat = (a) => {
    const out = [];
    for (const x of a) {
      if (x instanceof Cons && !isPt(x) && !(x.car instanceof Ename)) out.push(...toArray(x).map(fromLisp));   // a list of answers
      else out.push(fromLisp(x));
    }
    return out;
  };
  d('COMMAND', async (a, L) => { await call(L, 'command', flat(a), { strict: false }); return null; });
  d('COMMAND-S', async (a, L) => { await call(L, 'command', flat(a), { strict: true }); return null; });
  d('VL-CMDF', async (a, L) => {
    if (typeof a[0] === 'string' && a[0] && !(await call(L, 'getcname', a[0]))) return null;
    await call(L, 'command', flat(a), { strict: false });
    return T;
  });

  // ---- system variables ----
  const vname = (x) => (x instanceof Sym ? x.name : str(x));
  d('GETVAR', async (a, L) => { arity(a, 1); return toLisp(await call(L, 'getvar', vname(a[0]))); });
  d('SETVAR', async (a, L) => {
    arity(a, 2);
    const name = vname(a[0]);
    const r = await call(L, 'setvar', name, fromLisp(a[1]));
    if (r && r.error) throw new LispError('variable setting rejected: ' + show(name.toUpperCase()) + ' ' + show(a[1]));
    return a[1];
  });

  // ---- objects ----
  d('ENTGET', async (a, L) => { arity(a, 1, 2); return pairsToLisp(await call(L, 'entget', ename(a[0]))); });
  d('ENTMOD', async (a, L) => { arity(a, 1); const r = await call(L, 'entmod', lispToPairs(a[0])); return r === true ? a[0] : null; });
  const make = (asName) => async (a, L) => {
    arity(a, 0, 1);
    if (!a.length || a[0] === null) return null;
    const r = await call(L, 'entmake', lispToPairs(a[0]));
    if (!r || r.error) return null;
    if (r.block !== undefined) return r.block;
    if (asName && r.e !== undefined) return new Ename(r.e);
    return a[0];
  };
  d('ENTMAKE', make(false));
  d('ENTMAKEX', make(true));
  d('ENTDEL', async (a, L) => { arity(a, 1); return (await call(L, 'entdel', ename(a[0]))) ? a[0] : null; });
  d('ENTLAST', async (a, L) => toLisp(await call(L, 'entlast')));
  d('ENTNEXT', async (a, L) => { arity(a, 0, 1); return toLisp(await call(L, 'entnext', a[0] ? ename(a[0]) : null)); });
  d('HANDENT', async (a, L) => { arity(a, 1); return toLisp(await call(L, 'handent', str(a[0]))); });
  d('ENTUPD', (a) => { arity(a, 1); ename(a[0]); return a[0]; });

  // ---- tables ----
  d('TBLNEXT', async (a, L) => { arity(a, 1, 2); return pairsToLisp(await call(L, 'tblnext', str(a[0]), truthy(a[1]))); });
  d('TBLSEARCH', async (a, L) => { arity(a, 2, 3); return pairsToLisp(await call(L, 'tblsearch', str(a[0]), str(a[1]), truthy(a[2]))); });
  d('TBLOBJNAME', async (a, L) => { arity(a, 2); return toLisp(await call(L, 'tblobjname', str(a[0]), str(a[1]))); });

  // ---- misc ----
  d('TEXTBOX', async (a, L) => { arity(a, 1); return toLisp(await call(L, 'textbox', lispToPairs(a[0]))); });
  d('OSNAP', async (a, L) => { arity(a, 2); return toLisp(await call(L, 'osnap', ptOf(a[0]), str(a[1]))); });
  d('ALERT', async (a, L) => { arity(a, 1); await call(L, 'alert', str(a[0])); return null; });
  d('GETCNAME', async (a, L) => { arity(a, 1); return toLisp(await call(L, 'getcname', str(a[0]))); });
  d('GETFILED', async (a, L) => {
    arity(a, 4);
    if (typeof L.host?.getfiled !== 'function') return null;
    return toLisp(await call(L, 'getfiled', { title: str(a[0]), name: str(a[1]), ext: str(a[2]), flags: intv(a[3]) }));
  });
  d('ACAD_COLORDLG', async (a, L) => { arity(a, 1, 2); if (typeof L.host?.colorDialog !== 'function') return a[0]; return toLisp(await call(L, 'colorDialog', intv(a[0]))); });
  d('ACAD_TRUECOLORDLG', async (a) => a[0] ?? null);
  for (const n of ['REDRAW', 'REGEN', 'GRDRAW', 'GRVECS', 'GRTEXT', 'GRCLEAR', 'MENUCMD', 'MENUGROUP', 'HELP', 'SETFUNHELP', 'STARTAPP', 'SETVIEW']) d(n, async (a, L) => { if (n === 'REDRAW') await call(L, 'redraw'); return null; });
  d('LAYOUTLIST', async (a, L) => fromArray(await call(L, 'layoutNames')));
  const appids = new Set(['ACAD', 'CADCRAFT']);
  d('REGAPP', (a) => { arity(a, 1); const n = str(a[0]).toUpperCase(); if (!/^[A-Z0-9_$-]{1,255}$/.test(n) || appids.has(n)) return null; appids.add(n); return a[0]; });
  d('VPORTS', () => fromArray([fromArray([int(1), fromArray([0, 0]), fromArray([1, 1])])]));
}

export { truthy };
