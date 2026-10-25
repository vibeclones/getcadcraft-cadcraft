/* SPDX-License-Identifier: Apache-2.0 */
/**
 * main.js — the P&ID add-on for CadCraft (0.7 LC.5, session plant-design): process and instrumentation diagrams on CadCraft's
 * add-on API 1.0 (docs/ADDONS-SPEC.md §5.4). A symbol library drawn by CadCraft (lib/symbols.js), tagged equipment and
 * instruments, line numbers on process lines and signal lines of five styles (lib/lines.js), the lists a P&ID is read for
 * (lib/lists.js: line list, equipment list, instrument index, valve list; CSV and XLSX) and checks (lib/checks.js).
 *
 * A symbol is an add-on object of kind `pidsym` (local frame: its reference's position and angle place it), a line `pidline`
 * ('world' frame), a list on the sheet `pidtable`. Without the add-on all three are plain block references that show, plot and
 * save, their data passing through. Connections are never stored: model.js works them out from where things touch, so moving
 * a pump with the ordinary MOVE keeps the diagram true.
 *
 * Commands: PIDSYMBOL · PIDLINE · PIDTAG · PIDLN · PIDLIST · PIDCHECK.  Exports (EXPORT): the lists as one XLSX workbook, or as CSV.
 * It does not draw the symbols of Piping's PIDSYM (those stay as they are); a P&ID drawn here counts and checks only its own.
 * A drafting aid, not an engineering approval.
 */

import { setT, t, sizeUnitOf, perUnit, drawTable, nearestOnPath } from './lib/core.js';
import { SYMBOLS, GROUPS, ACTUATORS, idsOf, isInline, cleanSymbol, drawSymbol, extent, placeEnts, splitTag, isValve } from './lib/symbols.js';
import { STYLES, ARROWS, DEFAULT_FORMAT, cleanLine, lineNumber, nextSeq, drawLine, transformLine, LAYER_OF } from './lib/lines.js';
import { scan } from './lib/model.js';
import { runChecks } from './lib/checks.js';
import { allLists, toCsvAll, toSheets } from './lib/lists.js';
import { nextTag, nextLoop } from './lib/tags.js';
import { writeXlsx } from './lib/xlsx.js';

export const DEFAULTS = { toolbar: false, sym: { in: 4, mm: 100 }, textH: { in: 0.6, mm: 15 }, lineFormat: DEFAULT_FORMAT, symbol: 'gate', act: 'none', svc: '', size: '', spec: '', arrow: 'end', fn: 'PI' };
export const LAYERS = {
  'PID-EQUIP': { color: 5, lineweight: 0.35 }, 'PID-VALVE': { color: 3, lineweight: 0.25 }, 'PID-INST': { color: 4, lineweight: 0.25 },
  'PID-LINE-PROC': { color: 7, lineweight: 0.5 }, 'PID-LINE-SIGNAL': { color: 6, lineweight: 0.18 }, 'PID-CONN': { color: 2, lineweight: 0.25 }, 'PID-LIST': { color: 7, lineweight: 0.18 },
};
const LAYER_FOR = { valve: 'PID-VALVE', equip: 'PID-EQUIP', inst: 'PID-INST', line: 'PID-VALVE', conn: 'PID-CONN' };
const LISTS = ['line', 'equip', 'inst', 'valve'];

export function activate(api) {
  setT(api.t);
  const stored = api.storage.get('settings') || {};
  const settings = { ...structuredClone(DEFAULTS), ...stored, sym: { ...DEFAULTS.sym, ...stored.sym }, textH: { ...DEFAULTS.textH, ...stored.textH } };
  const save = () => api.storage.set('settings', settings);
  const opt = (k, l) => api.commands.option(k, l);
  const yes = (r) => (r?.option ?? r);
  const cmd = (name, aliases, fn, extra = {}) => api.commands.add(name, aliases.filter((a) => !api.commands.has(a)), fn, { ...extra, help: extra.help || (() => t('cmd.' + name.toLowerCase() + '.help')) });
  const choose = async (c, prompt, list, labelOf, cur) => {
    const r = yes(await c.keyword(prompt, { options: list.map((x, i) => opt(String(i + 1), labelOf(x))), default: String(Math.max(0, list.indexOf(cur)) + 1) }));
    return list[Number(r) - 1] ?? cur;
  };

  // ---------------------------------------------------------------------------------------------- objects
  api.objects.define('pidsym', {
    version: 1, name: t('obj.symbol'),
    draw: (data) => { const d = cleanSymbol(data); return d ? drawSymbol(d) : []; },
    read: (data) => cleanSymbol(data),
  });
  api.objects.define('pidline', {
    version: 1, name: t('obj.line'), frame: 'world',
    draw: (data) => { const d = cleanLine(data); return d ? drawLine(d, settings.lineFormat) : []; },
    grips: (data) => data.pts.map((p, i) => ({ x: p[0], y: p[1], key: 'p' + i })),
    gripMove: (data, key, to) => {
      const i = Number(String(key).slice(1));
      if (!Number.isInteger(i) || !data.pts[i]) return null;
      const next = structuredClone(data);
      next.pts[i] = [to.x, to.y];
      return cleanLine(next);
    },
    transform: (data, m) => transformLine(data, m),
    read: (data) => cleanLine(data),
  });
  api.objects.define('pidtable', {
    version: 1, name: t('obj.table'),
    draw: (data) => drawTable(String(data?.title || ''), Array.isArray(data?.rows) ? data.rows.slice(0, 500).map((r) => (Array.isArray(r) ? r.slice(0, 12).map((x) => String(x ?? '').slice(0, 120)) : [])) : [], Number(data?.h) > 0 ? Number(data.h) : 1),
  });

  const kindOf = (e) => api.objects.kindOf(e);
  const symData = (e) => { const d = api.objects.dataOf(e); return d ? cleanSymbol(d) : null; };
  const lineData = (e) => { const d = api.objects.dataOf(e); return d ? cleanLine(d) : null; };
  /** Everything the P&ID is made of in the drawing's model space → model.js. */
  function readModel(doc) {
    const items = [];
    for (const [id, e] of doc.model) {
      const k = kindOf(e);
      if (k === 'pidsym') { const data = symData(e); if (data) items.push({ uid: String(id), e, kind: k, data }); }
      else if (k === 'pidline') { const data = lineData(e); if (data) items.push({ uid: String(id), e, kind: k, data }); }
    }
    return scan(items, { format: settings.lineFormat });
  }
  const sizes = (doc) => { const u = sizeUnitOf(doc), kU = perUnit(doc, u); return { u, sym: (Number(settings.sym[u]) || DEFAULTS.sym[u]) / kU, text: (Number(settings.textH[u]) || DEFAULTS.textH[u]) / kU }; };
  function ensureLayers(doc) { for (const [name, l] of Object.entries(LAYERS)) if (!doc.layers.has(name)) doc.addLayer({ name, ...l }); }

  // ---------------------------------------------------------------------------------------------- finding things under a click
  /** The connection point, line end or line within reach of p: { x, y, kind, ... } | null. Snaps a new line's start. */
  function snapTo(model, p, tol) {
    let best = null;
    const take = (cand, d) => { if (d <= tol && (!best || d < best.d)) best = { ...cand, d }; };
    for (const s of model.symbols) for (const c of s.conns) take({ x: c.x, y: c.y, kind: 'conn', sym: s, conn: c }, Math.hypot(p.x - c.x, p.y - c.y));
    for (const l of model.lines) {
      l.ends.forEach((e, i) => take({ x: e.x, y: e.y, kind: 'end', line: l, end: i }, Math.hypot(p.x - e.x, p.y - e.y)));
      const n = nearestOnPath(l.pts, p);
      if (n) take({ x: n.x, y: n.y, kind: 'on', line: l, seg: n.seg }, n.dist + tol * 0.1);   // a click on a line stays on it unless a nozzle or an end is closer
    }
    return best;
  }
  function symbolAt(model, p) {
    let best = null;
    for (const s of model.symbols) {
      const ex = extent(s.data), r = Math.max(ex.w, ex.h) / 2;
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d <= r * 1.1 && (!best || d < best.d)) best = { s, d };
    }
    return best?.s || null;
  }
  const lineAt = (model, p, tol) => { let best = null; for (const l of model.lines) { const n = nearestOnPath(l.pts, p); if (n && n.dist <= tol && (!best || n.dist < best.d)) best = { l, d: n.dist, n }; } return best; };

  // ---------------------------------------------------------------------------------------------- PIDSYMBOL
  async function askTag(c, model, sym, cur) {
    const def = SYMBOLS[sym];
    const tags = model.symbols.map((s) => s.tag);
    if (def.group === 'inst') {
      const loops = model.symbols.filter((s) => s.group === 'inst').map((s) => s.tag);   // a loop number is counted among instruments only
      const s = String((await c.string(t('ask.tag.inst'), { default: settings.fn })) ?? '').trim();
      if (!s) return '';
      const { fn, num } = splitTag(s);
      if (num) return (fn + '-' + num).slice(0, 24);
      if (/^[A-Za-z]{1,6}$/.test(s)) { settings.fn = s.toUpperCase(); save(); return settings.fn + '-' + nextLoop(loops); }
      return s.slice(0, 24);
    }
    if (def.tagged !== 'required') return '';   // hand valves and in-line items are tagged later (PIDTAG), or never
    const prop = def.prefix ? nextTag(tags, def.prefix) : '';
    const s = String((await c.string(t('ask.tag'), { default: cur ?? prop })) ?? '').trim();
    return s.slice(0, 24);
  }

  /** Put an inline symbol on a process line: the line is cut either side of it, so the symbol's ends meet the line's. */
  function splitLineAround(doc, hit, at, half) {
    const L = hit.l, d = L.data;
    const [ax, ay] = d.pts[hit.seg], [bx, by] = d.pts[hit.seg + 1];
    const len = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / len, uy = (by - ay) / len;
    const su = Math.hypot(at.x - ax, at.y - ay);
    if (su < half || len - su < half) return false;   // too near a corner: the symbol goes on, the line is left whole
    const before = d.pts.slice(0, hit.seg + 1).concat([[at.x - ux * half, at.y - uy * half]]);
    const after = [[at.x + ux * half, at.y + uy * half]].concat(d.pts.slice(hit.seg + 1));
    const plen = (pts) => pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    const aKeeps = plen(before) >= plen(after);   // the longer piece keeps writing the number
    const A = { ...structuredClone(d), pts: before, arrow: d.arrow === 'start' || d.arrow === 'both' ? 'start' : 'none', lbl: d.lbl && aKeeps };
    const B = { ...structuredClone(d), pts: after, arrow: d.arrow === 'end' || d.arrow === 'both' ? 'end' : 'none', lbl: d.lbl && !aKeeps };
    const eid = Number(L.uid);
    doc.update(eid, api.objects.update(doc.get(eid), cleanLine(A)));
    doc.add(api.objects.create('pidline', cleanLine(B), { layer: LAYER_OF[d.style] }));
    return true;
  }

  cmd('PIDSYMBOL', ['PIDS'], async (c) => {
    const doc = c.doc, S = sizes(doc);
    let sym = SYMBOLS[settings.symbol] ? settings.symbol : 'gate', act = ACTUATORS.includes(settings.act) ? settings.act : 'none', ang = 0, n = 0;
    for (;;) {
      const model = readModel(doc);
      const cur = cleanSymbol({ sym, act, l: S.sym, tag: '' });
      c.preview((cursor) => (cursor ? placeEnts(drawSymbol(cur), cursor, ang) : []));
      const options = [opt('S', t('opt.symbol')), opt('A', t('opt.angle'))];
      if (isValve(sym)) options.push(opt('T', t('opt.actuator')));
      const r = await c.point(t('ask.symbol.place', { sym: t('sym.' + sym) }), { none: true, options });
      c.preview(null);
      if (!r) break;
      if (r.option === 'S') {
        const g = await choose(c, t('ask.group'), GROUPS, (x) => t('group.' + x), SYMBOLS[sym].group);
        const ids = idsOf(g);
        sym = await choose(c, t('ask.symbol'), ids, (k) => t('sym.' + k), ids.includes(sym) ? sym : ids[0]);
        settings.symbol = sym; save();
        continue;
      }
      if (r.option === 'A') { const a = await c.angle(t('ask.angle'), { default: ang }); if (Number.isFinite(Number(a))) ang = Number(a); continue; }
      if (r.option === 'T') { act = await choose(c, t('ask.actuator'), ACTUATORS, (k) => t('act.' + k), act); settings.act = act; save(); continue; }
      if (r.option) continue;
      const tag = await askTag(c, model, sym);
      const data = cleanSymbol({ sym, act, l: S.sym, tag });
      let at = { x: r.x, y: r.y }, rot = ang, hit = null;
      const tol = S.sym * 0.4;
      if (isInline(sym)) {
        hit = lineAt(model, r, tol);
        if (hit && hit.l.style === 'process') {
          const [ax, ay] = hit.l.pts[hit.n.seg], [bx, by] = hit.l.pts[hit.n.seg + 1];
          rot = Math.atan2(by - ay, bx - ax);
          at = { x: hit.n.x, y: hit.n.y };
        } else hit = null;
      } else {
        const sn = snapTo(model, r, tol);
        if (sn && sn.kind !== 'on' && data && SYMBOLS[sym].conn.length) {   // its nearest connection lands on the line end or connection it was clicked at
          const off = (cn) => ({ x: (cn.x * Math.cos(rot) - cn.y * Math.sin(rot)) * data.l, y: (cn.x * Math.sin(rot) + cn.y * Math.cos(rot)) * data.l });
          const mine = SYMBOLS[sym].conn.reduce((b, cn) => (Math.hypot(r.x + off(cn).x - sn.x, r.y + off(cn).y - sn.y) < Math.hypot(r.x + off(b).x - sn.x, r.y + off(b).y - sn.y) ? cn : b));
          at = { x: sn.x - off(mine).x, y: sn.y - off(mine).y };
        }
      }
      ensureLayers(doc);
      let made;
      doc.change('PIDSYMBOL', () => {
        if (hit) splitLineAround(doc, { l: hit.l, seg: hit.n.seg }, at, (SYMBOLS[sym].w * data.l) / 2);
        made = doc.add({ ...api.objects.create('pidsym', data, { layer: LAYER_FOR[SYMBOLS[sym].group] }), x: at.x, y: at.y, rot });
      });
      n++;
      api.select([made.id]);
    }
    if (n) c.print(t('done.symbols', { n }));
  });

  // ---------------------------------------------------------------------------------------------- PIDLINE
  cmd('PIDLINE', ['PIDL'], async (c) => {
    const doc = c.doc, S = sizes(doc);
    let style = 'process', arrow = ARROWS.includes(settings.arrow) ? settings.arrow : 'end';
    let f = { svc: settings.svc, size: settings.size, spec: settings.spec, seq: '', insul: '' }, matched = false;
    const pts = [];
    c.preview((cursor) => { if (!pts.length || !cursor) return []; const d = cleanLine({ pts: [...pts, [cursor.x, cursor.y]], style, ...f, arrow, k: S.sym, th: S.text }); return d ? drawLine(d, settings.lineFormat) : []; });
    const model = readModel(doc);
    const tol = S.sym * 0.3;
    for (;;) {
      const first = !pts.length;
      const options = [];
      if (first) options.push(opt('Y', t('opt.style')), opt('V', t('opt.service')), opt('Z', t('opt.size')), opt('P', t('opt.spec')), opt('M', t('opt.match')), opt('A', t('opt.arrow')));
      else options.push(opt('U', t('opt.undo')));
      const last = pts[pts.length - 1];
      const r = await c.point(t(first ? 'ask.line.first' : 'ask.line.next', { style: t('style.' + style) }), { none: true, options, ...(last ? { base: { x: last[0], y: last[1] } } : {}) });
      if (!r) break;
      if (r.option === 'Y') { style = await choose(c, t('ask.style'), STYLES, (s) => t('style.' + s), style); continue; }
      if (r.option === 'V') { f.svc = String((await c.string(t('ask.service'), { default: f.svc })) ?? '').trim().slice(0, 12); settings.svc = f.svc; save(); matched = false; continue; }
      if (r.option === 'Z') { f.size = String((await c.string(t('ask.size'), { default: f.size })) ?? '').trim().slice(0, 12); settings.size = f.size; save(); continue; }
      if (r.option === 'P') { f.spec = String((await c.string(t('ask.spec'), { default: f.spec })) ?? '').trim().slice(0, 12); settings.spec = f.spec; save(); continue; }
      if (r.option === 'A') { arrow = await choose(c, t('ask.arrow'), ARROWS, (a) => t('arrow.' + a), arrow); settings.arrow = arrow; save(); continue; }
      if (r.option === 'M') {
        const q = await c.point(t('ask.match'), { none: true });
        if (!q || q.option) continue;
        const hit = lineAt(readModel(doc), q, tol * 2);
        if (!hit) { c.print(t('err.notline')); continue; }
        const d = hit.l.data;
        f = { svc: d.svc, size: d.size, spec: d.spec, seq: d.seq, insul: d.insul }; style = d.style; matched = true;
        c.print(t('done.match', { ln: hit.l.ln || '—' }));
        continue;
      }
      if (r.option === 'U') { pts.pop(); continue; }
      if (r.option) continue;
      let p = { x: r.x, y: r.y };
      const sn = snapTo(model, p, tol);
      if (sn) {
        p = { x: sn.x, y: sn.y };
        // a process line that starts on another process line's end carries on with its number
        if (first && style === 'process' && sn.line && sn.line.style === 'process' && !matched) {
          const d = sn.line.data;
          f = { svc: d.svc, size: d.size, spec: d.spec, seq: d.seq, insul: d.insul }; matched = true;
          c.print(t('done.continue', { ln: sn.line.ln || '—' }));
        }
      }
      if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 1e-9) continue;
      if (pts.length >= 100) { c.print(t('warn.maxpts')); break; }
      pts.push([p.x, p.y]);
    }
    c.preview(null);
    if (pts.length < 2) return;
    if (style === 'process' && f.svc && !f.seq) f.seq = nextSeq(model.lines.map((l) => l.data), f.svc);
    const data = cleanLine({ pts, style, ...f, arrow, k: S.sym, th: S.text });
    if (!data) { c.print(t('err.line')); return; }
    ensureLayers(doc);
    let made;
    doc.change('PIDLINE', () => { made = doc.add(api.objects.create('pidline', data, { layer: LAYER_OF[style] })); });
    api.select([made.id]);
    const ln = lineNumber(data, settings.lineFormat);
    c.print(t('done.line', { style: t('style.' + style), n: data.pts.length - 1 }) + (ln ? ' ' + t('done.line.ln', { ln }) : ''));
  });

  // ---------------------------------------------------------------------------------------------- PIDTAG
  cmd('PIDTAG', ['PIDT'], async (c) => {
    const doc = c.doc;
    for (;;) {
      const r = await c.point(t('ask.pidtag'), { none: true, options: [opt('A', t('opt.autotag'))] });
      if (!r || (r.option && r.option !== 'A')) break;
      const model = readModel(doc);
      if (r.option === 'A') {
        const todo = model.symbols.filter((s) => !s.tag && s.def.tagged === 'required' && s.def.prefix);
        const skipped = model.symbols.filter((s) => !s.tag && s.def.tagged === 'required' && !s.def.prefix).length;
        const tags = model.symbols.map((s) => s.tag);
        // numbered along the drawing from left to right so P-101, P-102 read in order
        todo.sort((a, b) => a.x - b.x || b.y - a.y);
        doc.change('PIDTAG', () => {
          for (const s of todo) {
            const tag = nextTag(tags, s.def.prefix);
            tags.push(tag);
            const eid = Number(s.uid);
            doc.update(eid, api.objects.update(doc.get(eid), cleanSymbol({ ...s.data, tag })));
          }
        });
        c.print(t('done.autotag', { n: todo.length }) + (skipped ? ' ' + t('done.autotag.skipped', { n: skipped }) : ''));
        continue;
      }
      const s = symbolAt(model, r);
      if (!s) { c.print(t('err.notsymbol')); continue; }
      const tag = String((await c.string(t('ask.tag.edit', { cur: s.tag || '—' }), { default: s.tag })) ?? '').trim().slice(0, 24);
      const desc = String((await c.string(t('ask.desc'), { default: s.desc })) ?? '').trim().slice(0, 60);
      const eid = Number(s.uid);
      doc.change('PIDTAG', () => { doc.update(eid, api.objects.update(doc.get(eid), cleanSymbol({ ...s.data, tag, desc }))); });
    }
  });

  // ---------------------------------------------------------------------------------------------- PIDLN
  cmd('PIDLN', ['PIDN'], async (c) => {
    const doc = c.doc;
    let f = { svc: settings.svc, size: settings.size, spec: settings.spec };
    let fresh = false, n = 0;
    for (;;) {
      const r = await c.point(t('ask.pidln', { svc: f.svc || '—', size: f.size || '—', spec: f.spec || '—', next: fresh ? t('yes') : t('no') }), { none: true, options: [opt('V', t('opt.service')), opt('Z', t('opt.size')), opt('P', t('opt.spec')), opt('N', t('opt.newnumber'))] });
      if (!r) break;
      if (r.option === 'V') { f.svc = String((await c.string(t('ask.service'), { default: f.svc })) ?? '').trim().slice(0, 12); continue; }
      if (r.option === 'Z') { f.size = String((await c.string(t('ask.size'), { default: f.size })) ?? '').trim().slice(0, 12); continue; }
      if (r.option === 'P') { f.spec = String((await c.string(t('ask.spec'), { default: f.spec })) ?? '').trim().slice(0, 12); continue; }
      if (r.option === 'N') { fresh = !fresh; continue; }
      if (r.option) continue;
      const model = readModel(doc);
      const hit = lineAt(model, r, sizes(doc).sym * 0.4);
      if (!hit) { c.print(t('err.notline')); continue; }
      const d = hit.l.data;
      const seq = fresh || !d.seq ? nextSeq(model.lines.map((l) => l.data), f.svc) : d.seq;
      const eid = Number(hit.l.uid);
      doc.change('PIDLN', () => { doc.update(eid, api.objects.update(doc.get(eid), cleanLine({ ...d, ...f, seq, lnOverride: '' }))); });
      n++;
    }
    if (n) c.print(t('done.pidln', { n }));
  });

  // ---------------------------------------------------------------------------------------------- PIDLIST (a list on the sheet, kept up to date)
  const listOf = (kind, model) => allLists(model)[LISTS.indexOf(kind)];
  const isTable = (e) => kindOf(e) === 'pidtable';
  function refreshTables(doc) {
    const tables = [...doc.model].filter(([, e]) => isTable(e));
    if (!tables.length) return;
    const model = readModel(doc), lists = allLists(model);
    for (const [id, e] of tables) {
      const d = api.objects.dataOf(e);
      if (!d || d.auto === false || !LISTS.includes(d.list)) continue;
      const list = lists[LISTS.indexOf(d.list)];
      const rows = [list.columns, ...list.rows];
      if (JSON.stringify(rows) === JSON.stringify(d.rows) && d.title === list.name) continue;
      doc.update(id, api.objects.update(e, { ...d, title: list.name, rows }));
    }
  }
  let syncing = false;
  api.drawing.afterChange((doc, ops) => {
    if (syncing) return;
    const relevant = ops.some((op) => op.map && op.map === doc.model && ((op.after && kindOf(op.after)?.startsWith('pid') && kindOf(op.after) !== 'pidtable') || (op.before && kindOf(op.before)?.startsWith('pid') && kindOf(op.before) !== 'pidtable')));
    if (!relevant) return;
    syncing = true;
    try { refreshTables(doc); } finally { syncing = false; }
  });
  cmd('PIDLIST', ['PIDLS'], async (c) => {
    const model = readModel(c.doc);
    if (!model.symbols.length && !model.lines.length) { c.print(t('err.empty')); return; }
    const kind = await choose(c, t('ask.list'), LISTS, (k) => t('list.' + k), 'line');
    const list = listOf(kind, model);
    c.print(t('done.list.count', { name: list.name, n: list.rows.length }));
    const at = await c.point(t('ask.table'), { none: true });
    if (!at || at.option) return;
    ensureLayers(c.doc);
    const h = sizes(c.doc).text;
    let made;
    c.doc.change('PIDLIST', () => { made = c.doc.add({ ...api.objects.create('pidtable', { list: kind, title: list.name, rows: [list.columns, ...list.rows], h, auto: true }, { layer: 'PID-LIST' }), x: at.x, y: at.y }); });
    api.select([made.id]);
    c.print(t('done.table'));
  }, { noRepeat: true });

  // ---------------------------------------------------------------------------------------------- PIDCHECK
  cmd('PIDCHECK', ['PIDC'], async (c) => {
    const found = runChecks(readModel(c.doc));
    if (!found.length) { c.print(t('done.check.clean')); return; }
    const errors = found.filter((f) => f.level === 'error').length;
    c.print(t('done.check', { errors, warnings: found.length - errors }));
    found.forEach((f, i) => c.print((i + 1) + '. ' + t('level.' + f.level) + ': ' + t('check.' + f.code, { ...f.vars, what: f.vars.what ? t('sym.' + f.vars.what) : '' })));
    for (;;) {
      const n = await c.number(t('ask.check.zoom', { n: found.length }), { none: true });
      if (n === null || n === undefined || n?.option) return;
      const f = found[Math.round(n) - 1];
      if (!f) continue;
      const r = sizes(c.doc).sym * 2;
      c.host.zoomWindow?.({ x: f.at.x - r, y: f.at.y - r }, { x: f.at.x + r, y: f.at.y + r });
      api.select(f.items.map(Number).filter((id) => c.doc.get(id)));
    }
  }, { noRepeat: true, keepSelection: true });

  // ---------------------------------------------------------------------------------------------- files
  const needModel = (doc) => { const m = readModel(doc); if (!m.symbols.length && !m.lines.length) throw new Error(t('err.empty')); return m; };
  api.files.exporter({ id: 'pid-xlsx', label: t('export.xlsx'), extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', write: async (doc) => writeXlsx(toSheets(allLists(needModel(doc))), { title: doc.meta?.name || 'P&ID' }) });
  api.files.exporter({ id: 'pid-csv', label: t('export.csv'), extension: 'csv', mime: 'text/csv', write: (doc) => '﻿' + toCsvAll(allLists(needModel(doc))) });

  // ---------------------------------------------------------------------------------------------- toolbar, panel, settings
  const ACTIONS = [['PIDSYMBOL', 'ui.symbol', 'bi-diagram-3'], ['PIDLINE', 'ui.line', 'bi-bezier2'], ['PIDTAG', 'ui.tag', 'bi-tag'], ['PIDLN', 'ui.ln', 'bi-hash'], ['PIDLIST', 'ui.list', 'bi-table'], ['PIDCHECK', 'ui.check', 'bi-check2-square']];
  let bar = null;
  function showToolbar(on) {
    if (bar) { for (const x of bar) x?.remove?.(); bar = null; }
    if (!on) return;
    bar = [api.toolbar.group({ id: 'pid', label: t('ui.group'), tools: ACTIONS.map(([command, lab, icon]) => ({ id: command.toLowerCase(), label: t(lab), icon, title: t('cmd.' + command.toLowerCase() + '.help'), command })) })];
  }
  showToolbar(settings.toolbar);
  api.onDeactivate(() => showToolbar(false));

  const panelBody = api.ui.panelSection({ id: 'pid', title: t('ui.group'), render: (el) => renderPanel(el) });
  if (panelBody && api.doc?.on) {
    let pending = false;
    const off = api.doc.on(() => { if (pending) return; pending = true; setTimeout(() => { pending = false; renderPanel(panelBody); }, 400); });
    api.onDeactivate(off);
  }
  function renderPanel(el) {
    const d = el.ownerDocument;
    const mk = (tag, cls, text) => { const n = d.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    let facts = '';
    try {
      if (api.doc) {
        const m = readModel(api.doc);
        if (m.symbols.length || m.lines.length) {
          const f = runChecks(m), errors = f.filter((x) => x.level === 'error').length;
          facts = t('panel.facts', { s: m.symbols.length, l: m.lines.length, e: errors, w: f.length - errors });
        }
      }
    } catch { facts = ''; }
    const acts = mk('div', 'pid-actions');
    acts.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.25rem;margin:0.5rem 0 0.75rem';
    for (const [command, lab] of ACTIONS) {
      const b = mk('button', 'btn-line btn-sm-cc', t(lab));
      b.type = 'button';
      b.style.cssText = 'font-size:0.8125rem;padding:0.125rem 0.5rem;line-height:1.4';
      b.title = t('cmd.' + command.toLowerCase() + '.help');
      b.setAttribute('data-pid-cmd', command);
      b.addEventListener('click', () => { api.commands.run(command).catch(() => {}); });
      acts.append(b);
    }
    el.replaceChildren(mk('p', 'pid-facts', facts), acts);
  }

  api.ui.settingsSection({ id: 'pid', title: t('ui.group'), render: (fs) => renderSettings(fs), reset: () => { Object.assign(settings, structuredClone(DEFAULTS)); save(); showToolbar(settings.toolbar); } });
  function renderSettings(fs) {
    const d = fs.ownerDocument, u = api.doc ? sizeUnitOf(api.doc) : 'in';
    const row = (lab, input) => { const l = d.createElement('label'); l.className = 'shell-row'; const s = d.createElement('span'); s.textContent = lab; l.append(s, input); fs.append(l); };
    const num = (key) => {
      const i = d.createElement('input'); i.type = 'number'; i.step = 'any'; i.min = '0'; i.value = String(settings[key][u]); i.setAttribute('data-pid-setting', key);
      i.addEventListener('change', () => { const v = Number(i.value); if (v > 0) { settings[key][u] = v; save(); } });
      return i;
    };
    const tb = d.createElement('select'); tb.className = 'select-cc'; tb.setAttribute('data-pid-setting', 'toolbar');
    for (const [v, l] of [['false', t('off')], ['true', t('on')]]) { const o = d.createElement('option'); o.value = v; o.textContent = l; tb.append(o); }
    tb.value = String(settings.toolbar);
    tb.addEventListener('change', () => { settings.toolbar = tb.value === 'true'; save(); showToolbar(settings.toolbar); });
    const fmt = d.createElement('input'); fmt.type = 'text'; fmt.value = settings.lineFormat; fmt.maxLength = 60; fmt.setAttribute('data-pid-setting', 'lineFormat');
    fmt.addEventListener('change', () => { settings.lineFormat = /\{\w+\}/.test(fmt.value) ? fmt.value : DEFAULT_FORMAT; fmt.value = settings.lineFormat; save(); api.objects.refresh('pidline'); });
    row(t('set.toolbar'), tb);
    row(t('set.sym', { unit: t('unit.' + u) }), num('sym'));
    row(t('set.text-h', { unit: t('unit.' + u) }), num('textH'));
    row(t('set.format'), fmt);
  }

  // ---------------------------------------------------------------------------------------------- Properties
  api.props.section({ key: 'pid', label: t('props.section'), types: ['insert'], defs: (ents) => propDefs(ents) });
  function propDefs(ents) {
    if (!ents.length) return [];
    const syms = ents.every((e) => kindOf(e) === 'pidsym'), lns = ents.every((e) => kindOf(e) === 'pidline');
    if (!syms && !lns) return [];
    const field = (key, kind, lab, get, put, extra = {}) => ({
      key, kind, label: t(lab),
      get: (e) => { const d = syms ? symData(e) : lineData(e); return d ? get(d) : ''; },
      set: (e, v) => { const d = syms ? symData(e) : lineData(e); if (!d) return e; const n = (syms ? cleanSymbol : cleanLine)(put(structuredClone(d), v) || d); return n ? api.objects.update(e, n) : e; },
      ...extra,
    });
    const text = (key, lab, k, max = 60) => field(key, 'text', lab, (d) => d[k] || '', (d, v) => { d[k] = String(v ?? '').slice(0, max); return d; });
    if (syms) {
      const attr = (k) => field('a-' + k, 'text', 'prop.' + k, (d) => d.attrs[k] || '', (d, v) => { d.attrs = { ...d.attrs, [k]: String(v ?? '').slice(0, 60) }; return d; });
      const out = [text('tag', 'prop.tag', 'tag', 24), text('desc', 'prop.desc', 'desc')];
      if (ents.every((e) => isValve(symData(e)?.sym))) out.push(field('act', 'choice', 'prop.act', (d) => d.act, (d, v) => { d.act = ACTUATORS.includes(v) ? v : d.act; return d; }, { choices: () => ACTUATORS.map((k) => [k, t('act.' + k)]) }));
      out.push(attr('svc'), attr('dp'), attr('dt'), attr('cap'), attr('mat'), attr('notes'));
      return out;
    }
    return [
      field('style', 'choice', 'prop.style', (d) => d.style, (d, v) => { d.style = STYLES.includes(v) ? v : d.style; return d; }, { choices: () => STYLES.map((k) => [k, t('style.' + k)]) }),
      text('size', 'prop.size', 'size', 12), text('svc', 'prop.svc', 'svc', 12), text('seq', 'prop.seq', 'seq', 12), text('spec', 'prop.spec', 'spec', 12), text('insul', 'prop.insul', 'insul'),
      text('lnOverride', 'prop.ln-override', 'lnOverride'),
      field('lbl', 'choice', 'prop.lbl', (d) => (d.lbl ? 'yes' : 'no'), (d, v) => { d.lbl = v === 'yes'; return d; }, { choices: () => [['yes', t('yes')], ['no', t('no')]] }),
      field('arrow', 'choice', 'prop.arrow', (d) => d.arrow, (d, v) => { d.arrow = ARROWS.includes(v) ? v : d.arrow; return d; }, { choices: () => ARROWS.map((k) => [k, t('arrow.' + k)]) }),
      ...(ents.length === 1 ? [{ key: 'ln', kind: 'ro', label: t('prop.ln'), get: (e) => { const d = lineData(e); return d ? lineNumber(d, settings.lineFormat) : ''; } }] : []),
    ];
  }

  api.log('P&ID ready');   // i18n-ignore (developer log)
}

