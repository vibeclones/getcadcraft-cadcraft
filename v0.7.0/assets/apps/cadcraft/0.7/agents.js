/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — tool names, descriptions and results are read by the assistant program, not shown to the person; what the person reads (the history line) goes through t(). */
/**
 * agents.js — CadCraft for AI assistants and scripts (0.4 part 2 track X, session agents; docs/AGENTS-SPEC.md). The apps
 * contain no AI: this gives the person's own assistant tools, and Settings › Assistants (host.js) decides which.
 *
 * DOM-free, shared by the page and the headless core (tools/cli/headless/cad.mjs imports this file from the build, so the
 * CLI, the MCP server and the live window answer the same way):
 *   describeDrawing(doc, {report, format}) · listObjects(doc, filters) · objectInFull(doc, id) · checkDrawing(doc, rules)
 *   runInput(engine, doc, host, input, {select, label, prefix, timeout}) → {printed, added, changed, removed, waiting, undo, error}
 *   scriptLines(text) · RULES_SCHEMA · OBJECT_TYPES · INPUT_SCHEMA
 *   readDrawingBytes(bytes, name) → {drawing, format} (a .dwg / .dxf for doc.load; 0.7 MCP-PATHS, also the headless core's)
 *   runLisp(engine, doc, host, text, {label, name, prefix, capture}) → as runInput (+ the LISP job; APPLOAD by path)
 *   insertBlock(engine, doc, host, {block, at, scale, rotation, layer, attributes}, {prefix, capture}) → as runInput + id:
 *   a block reference with its attribute values in one undo step, as INSERT places it (0.7 MCP-HEADLESS)
 *   plotPdf(doc, o) · plotSvg(doc, o) → {bytes, sheet, …}: a sheet or the model as PDF, or as SVG drawn by plot.js's own
 *   drawPreview into svgContext() (0.7 MCP-HEADLESS: the same picture as the plot preview, no second drawing code)
 * The page (cadcraft.js) calls installAgents({...}) once: CadCraft's live tools (§5.2) on host.control. In Studio the tools
 * also take file paths inside the folders the person allowed (host.control.files; 0.7 MCP-PATHS).
 */
import { describe as describeEntity } from './commands.js';
import { prims, primLength, entityArea, entityBounds } from './geom.js';
import { extentsOf, layoutSheet, modelSheet, displayList, toPdf, drawPreview } from './plot.js';
import { findTable, styleNameFor } from './plotstyle.js';
import { scaleLabel, scaleList, paperByKey, PAPERS } from './sheets.js';
import { unitsOf, LUNITS } from './units.js';
import { getHost, toolResult } from "./host.js";
import { t } from './i18n.js';

export const OBJECT_TYPES = ['line', 'circle', 'arc', 'poly', 'ellipse', 'text', 'point', 'insert', 'hatch', 'dim', 'viewport', 'mleader', 'spline', 'face3d', 'image', 'wipeout'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : v);
const rnd6 = (v) => num(Math.round(v * 1e6) / 1e6);

/** A script's lines: one per prompt answer; a blank line is Enter, but the newline that ends the file is not a line. */
export function scriptLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------- reading

const DWG_TAGS = { AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018', AC1009: 'R12', AC1006: 'R10' };
export const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

/** A DWG / DXF file's bytes → {drawing (doc.load input), format}. The readers load on first use. */
export async function readDrawingBytes(bytes, name) {
  const ext = extOf(name);
  if (ext === 'dxf') {
    const { readDxf } = await import('./dxf.js');
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(bytes);
    if (/^AutoCAD Binary DXF/.test(text)) throw new Error('Binary DXF is not read; save it as ASCII DXF.');
    const drawing = readDxf(text);
    const v = drawing.meta?.version;
    return { drawing, format: 'DXF' + (DWG_TAGS[v] ? ' ' + DWG_TAGS[v] : '') + (v ? ' (' + v + ')' : '') };
  }
  if (ext === 'dwg') {
    const [{ readDwg }, { importDwg }] = await Promise.all([import('./dwg/read.js'), import('./dwg-import.js')]);
    const tag = new TextDecoder().decode(bytes.subarray(0, 6));
    let model = null, failed = null;
    try { model = readDwg(bytes); } catch (err) { model = null; failed = err; }
    if (!model || !model.blocks?.length) {
      // 0.6.1 FIX-061-DWG2013: the reader's reason (its error, else its first notes), as the app says it
      const why = failed ? String(failed.message || failed) : model?.report?.error || (model?.report?.notes || []).slice(0, 3).join(' ');
      const v = tag.replace(/[^\x20-\x7e]/g, '') || 'unknown';
      throw new Error(why ? 'This drawing could not be read (' + v + '): ' + why : 'This drawing could not be read. It may be damaged, or saved in a version the reader does not handle yet (' + v + ').');
    }
    return { drawing: importDwg(model, { versionTag: tag }), format: 'DWG' + (DWG_TAGS[tag] ? ' ' + DWG_TAGS[tag] : '') + ' (' + tag + ')' };
  }
  throw new Error('CadCraft opens DWG and DXF drawings; "' + name + '" is neither.');
}

export function describeDrawing(doc, { report = null, format = null } = {}) {
  const counts = {}, perLayer = new Map(), uses = new Map(), nested = new Map();
  for (const e of doc.model.values()) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    perLayer.set(e.layer, (perLayer.get(e.layer) || 0) + 1);
    if (e.type === 'insert') uses.set(e.block, (uses.get(e.block) || 0) + 1);
  }
  // references on the sheets count as uses too, and those inside other blocks as nested uses (0.7: PURGE keeps both)
  for (const l of doc.layouts || []) for (const e of l.entities.values()) if (e.type === 'insert') uses.set(e.block, (uses.get(e.block) || 0) + 1);
  for (const bk of doc.blocks.values()) for (const e of bk.entities || []) if (e.type === 'insert') nested.set(e.block, (nested.get(e.block) || 0) + 1);
  let b = null;
  try { b = extentsOf(doc); } catch { b = null; }
  const u = unitsOf(doc.meta);
  const styles = doc.textStyles ? [...(doc.textStyles.values ? doc.textStyles.values() : Object.values(doc.textStyles))].map((s) => (s && s.name) || s).slice(0, 200) : [];
  return {
    name: doc.meta.name, source: doc.meta.source || null, format: doc.meta.format || format || null,
    units: { insunits: doc.meta.units || 'unitless', lengthFormat: LUNITS[u.lunits], precision: u.prec },
    extents: b ? { minX: num(b.minX), minY: num(b.minY), maxX: num(b.maxX), maxY: num(b.maxY) } : null,
    objects: doc.model.size, byType: counts,
    layers: [...doc.layers.values()].map((l) => ({ name: l.name, color: l.color, on: l.on !== false, frozen: !!l.frozen, locked: !!l.locked, plot: l.plot !== false, linetype: l.linetype || null, lineweight: l.lineweight ?? null, objects: perLayer.get(l.name) || 0 })),
    blocks: [...doc.blocks.values()].filter((bk) => !bk.name.startsWith('*')).map((bk) => ({ name: bk.name, objects: bk.entities?.length || 0, uses: uses.get(bk.name) || 0, ...(nested.get(bk.name) ? { nested: nested.get(bk.name) } : {}), attributes: (bk.attdefs || []).map((a) => a.tag) })),
    layouts: (doc.layouts || []).map((l) => ({ name: l.name, paper: l.paper ? { w: rnd6(l.paper.w), h: rnd6(l.paper.h), unit: l.paper.unit } : null, objects: l.entities.size,
      viewports: [...l.entities.values()].filter((e) => e.type === 'viewport').map((v) => ({ id: v.id, w: num(v.w), h: num(v.h), scale: v.s ? scaleLabel(doc, l.paper?.unit || 'mm', v.s) : null })) })),
    textStyles: styles,
    views: (doc.views || []).map((v) => v.name),
    unsaved: doc.version !== doc.savedVersion,
    notes: ((report && report.notes) || []).slice(0, 50),
  };
}

/** One object as plain JSON (+ length / area where it has one, and a one-line description in the drawing's units). */
export function plainObject(doc, e, { full = false } = {}) {
  const o = {};
  for (const [k, v] of Object.entries(e)) {
    if (k.startsWith('_') || typeof v === 'function') continue;
    if (!full && Array.isArray(v) && v.length > 200) { o[k] = v.slice(0, 200); o[k + 'Total'] = v.length; continue; }
    o[k] = typeof v === 'number' ? num(v) : v;
  }
  try { const ps = prims(e, null); if (['line', 'arc', 'poly', 'circle', 'ellipse'].includes(e.type) && ps?.length) o.length = num(ps.reduce((s, q) => s + primLength(q), 0)); } catch { /* none */ }
  try { if (['circle', 'poly', 'ellipse', 'hatch'].includes(e.type)) { const a = entityArea(e); if (a && Number.isFinite(a.area) && a.kind !== 'open') o.area = num(a.area); } } catch { /* none */ }
  try { o.description = describeEntity(e, unitsOf(doc.meta)); } catch { o.description = ''; }
  return o;
}

function spaceOf(doc, name) {
  if (!name || name === 'model') return doc.model;
  const l = (doc.layouts || []).find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!l) throw new Error('There is no sheet "' + name + '". Sheets: ' + ((doc.layouts || []).map((x) => x.name).join(', ') || 'none') + '.');
  return l.entities;
}

export function listObjects(doc, { type, layer, block, within, space, text, ids, offset = 0, limit = 100, countOnly = false } = {}) {
  const lay = layer ? String(layer).toLowerCase() : null, txt = text ? String(text).toLowerCase() : null;
  const only = Array.isArray(ids) ? new Set(ids) : null;
  const hits = [];
  for (const e of spaceOf(doc, space).values()) {
    if (only && !only.has(e.id)) continue;
    if (type && e.type !== type) continue;
    if (lay && String(e.layer).toLowerCase() !== lay) continue;
    if (block && !(e.type === 'insert' && e.block === block)) continue;
    if (txt && !(String(e.s || '').toLowerCase().includes(txt) || (e.attrs && Object.values(e.attrs).some((v) => String(v).toLowerCase().includes(txt))))) continue;
    if (within) { const b = entityBounds(e, doc.blocks); if (!b || b.minX < within.minX || b.minY < within.minY || b.maxX > within.maxX || b.maxY > within.maxY) continue; }
    hits.push(e);
  }
  if (countOnly) {   // 0.7 MCP-COUNT: the total (and by type and layer) without the objects
    const byType = {}, byLayer = {};
    for (const e of hits) { byType[e.type] = (byType[e.type] || 0) + 1; byLayer[e.layer] = (byLayer[e.layer] || 0) + 1; }
    return { total: hits.length, byType, byLayer };
  }
  return { total: hits.length, offset, objects: hits.slice(offset, offset + limit).map((e) => plainObject(doc, e)) };
}

export function objectInFull(doc, id) {
  for (const map of [doc.model, ...(doc.layouts || []).map((l) => l.entities)]) {
    const e = map.get(+id);
    if (!e) continue;
    const o = plainObject(doc, e, { full: true });
    if (e.type === 'insert') { const bk = doc.blocks.get(e.block); if (bk) o.blockDefinition = { name: bk.name, objects: bk.entities?.length || 0, attributes: (bk.attdefs || []).map((a) => ({ tag: a.tag, prompt: a.prompt, invisible: !!a.invisible, constant: !!a.constant })) }; }
    return o;
  }
  return null;
}

// ---------------------------------------------------------------- standards check (AGENTS-SPEC §5.3)

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const RULES_SCHEMA = { type: 'object', properties: {
  layers: obj({ allowed: { type: 'array', items: { type: 'string' }, maxItems: 500 }, required: { type: 'array', items: { type: 'string' }, maxItems: 500 }, noObjectsOn: { type: 'array', items: { type: 'string' }, maxItems: 50 } }),
  objects: obj({ colorByLayer: { type: 'boolean' }, linetypeByLayer: { type: 'boolean' }, lineweightByLayer: { type: 'boolean' }, textHeights: { type: 'array', items: { type: 'number' }, maxItems: 50 }, textStyles: { type: 'array', items: { type: 'string' }, maxItems: 50 } }),
  blocks: obj({ noUnused: { type: 'boolean' } }),
  units: obj({ lunits: { type: 'integer', minimum: 1, maximum: 5 }, insunits: { type: 'string', maxLength: 40 } }),
}, additionalProperties: false };

export function checkDrawing(doc, rules = {}) {
  const findings = [];
  const add = (rule, severity, message, ids = []) => findings.push({ rule, severity, message, ids: ids.slice(0, 200), count: ids.length });
  const matcher = (list) => (list || []).map((p) => { const m = /^\/(.*)\/([i]*)$/.exec(String(p)); return m ? (n) => new RegExp(m[1], m[2]).test(n) : (n) => n.toLowerCase() === String(p).toLowerCase(); });
  const all = [...doc.model.values(), ...(doc.layouts || []).flatMap((l) => [...l.entities.values()])];
  const L = rules.layers || {};
  if (L.allowed) {
    const ok = matcher(L.allowed.concat(['0']));
    for (const l of doc.layers.values()) if (!ok.some((f) => f(l.name))) add('layers.allowed', 'error', 'Layer "' + l.name + '" is not in the allowed list.', all.filter((e) => e.layer === l.name).map((e) => e.id));
  }
  for (const r of L.required || []) if (![...doc.layers.keys()].some((n) => n.toLowerCase() === String(r).toLowerCase())) add('layers.required', 'error', 'Layer "' + r + '" is missing.');
  for (const r of L.noObjectsOn || []) {
    const ids = all.filter((e) => String(e.layer).toLowerCase() === String(r).toLowerCase()).map((e) => e.id);
    if (ids.length) add('layers.noObjectsOn', 'error', ids.length + ' object' + (ids.length === 1 ? ' is' : 's are') + ' on layer "' + r + '".', ids);
  }
  const O = rules.objects || {};
  if (O.colorByLayer) { const ids = all.filter((e) => e.color !== null && e.color !== undefined && e.type !== 'viewport').map((e) => e.id); if (ids.length) add('objects.colorByLayer', 'error', ids.length + ' object(s) have their own colour instead of ByLayer.', ids); }
  if (O.linetypeByLayer) { const ids = all.filter((e) => e.lt && !/^bylayer$/i.test(e.lt)).map((e) => e.id); if (ids.length) add('objects.linetypeByLayer', 'error', ids.length + ' object(s) have their own linetype.', ids); }
  if (O.lineweightByLayer) { const ids = all.filter((e) => e.lw !== undefined && e.lw !== null && e.lw !== -1).map((e) => e.id); if (ids.length) add('objects.lineweightByLayer', 'error', ids.length + ' object(s) have their own lineweight.', ids); }
  if (O.textHeights) {
    const okH = O.textHeights.map(Number);
    const ids = all.filter((e) => (e.type === 'text' || e.type === 'mleader') && Number.isFinite(e.h) && !okH.some((h) => Math.abs(h - e.h) <= 1e-6 * Math.max(1, h))).map((e) => e.id);
    if (ids.length) add('objects.textHeights', 'error', ids.length + ' text(s) use a height not in ' + okH.join(', ') + '.', ids);
  }
  if (O.textStyles) {
    const okS = matcher(O.textStyles);
    const ids = all.filter((e) => e.type === 'text' && e.style && !okS.some((f) => f(e.style))).map((e) => e.id);
    if (ids.length) add('objects.textStyles', 'error', ids.length + ' text(s) use a style not in the list.', ids);
  }
  if (rules.blocks?.noUnused) {
    const used = new Set();
    const walk = (ents) => { for (const e of ents) if (typeof e.block === 'string') used.add(e.block); };   // references, and the blocks dimensions draw from
    walk(all);
    for (const bk of doc.blocks.values()) walk(bk.entities || []);
    for (const bk of doc.blocks.values()) if (!/^[*_]/.test(bk.name) && !used.has(bk.name)) add('blocks.noUnused', 'warning', 'Block "' + bk.name + '" is defined but not used.');
  }
  if (rules.units) {
    const u = unitsOf(doc.meta);
    if (rules.units.lunits !== undefined && +rules.units.lunits !== u.lunits) add('units.lunits', 'error', 'The length format is ' + LUNITS[u.lunits] + ', not ' + (LUNITS[+rules.units.lunits] || rules.units.lunits) + '.');
    if (rules.units.insunits !== undefined && String(rules.units.insunits).toLowerCase() !== String(doc.meta.units || 'unitless').toLowerCase()) add('units.insunits', 'error', 'The drawing units are ' + (doc.meta.units || 'unitless') + ', not ' + rules.units.insunits + '.');
  }
  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

// ---------------------------------------------------------------- the command line

const pt2 = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
export const INPUT_SCHEMA = { anyOf: [{ type: 'string', maxLength: 100000 }, { type: 'array', minItems: 1, maxItems: 5000, items: { anyOf: [
  { type: 'string', maxLength: 10000 },
  obj({ pick: pt2, shift: { type: 'boolean' } }, ['pick']),
  obj({ window: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, crossing: { type: 'boolean' } }, ['window']),
  obj({ entity: { type: 'integer', minimum: 1 }, at: pt2, shift: { type: 'boolean' } }, ['entity']),
  obj({ escape: { type: 'boolean', const: true } }, ['escape']),
] } }] };

const tick = typeof setImmediate === 'function' ? () => new Promise((r) => setImmediate(r))
  : typeof MessageChannel === 'function' ? () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); })
    : () => new Promise((r) => setTimeout(r, 0));

/** Let the Engine run until it waits for input or finishes. → false on timeout. */
export async function settle(engine, timeout = 60000) {
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < timeout) {
    await tick();
    if (!engine.busy || engine.waiting) { if (++stable >= 3) return true; } else stable = 0;
  }
  return false;
}

function snapshot(doc) {
  const snap = new Map();
  for (const [id, e] of doc.model) snap.set(id, e);
  for (const l of doc.layouts || []) for (const [id, e] of l.entities) snap.set(id, e);
  return snap;
}

function anchor(doc, e) {
  const p = prims(e, doc.blocks);
  if (p && p.length) { const q = p[0]; return q.k === 'L' ? { x: (q.x1 + q.x2) / 2, y: (q.y1 + q.y2) / 2 } : { x: q.cx + q.r * Math.cos((q.a0 + q.a1) / 2), y: q.cy + q.r * Math.sin((q.a0 + q.a1) / 2) }; }
  const b = entityBounds(e, doc.blocks);
  return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
}

/** One input item → null, or an error message. */
function feed(engine, doc, host, raw) {
  if (typeof raw === 'string') { const p = engine.text(raw); if (p && typeof p.catch === 'function') p.catch(() => {}); return null; }
  if (!raw || typeof raw !== 'object') return 'Each input is a string, or an object {pick}, {window}, {entity} or {escape}.';
  const pt = (v) => (Array.isArray(v) && v.length >= 2 && v.every((n) => Number.isFinite(+n)) ? { x: +v[0], y: +v[1] } : null);
  const shift = host.shift;
  host.shift = !!raw.shift;
  try {
    if (raw.escape) { engine.escape(); return null; }
    if (raw.pick !== undefined) {
      const p = pt(raw.pick);
      if (!p) return 'pick needs [x, y].';
      if (!engine.waiting) return 'Nothing is asking for a point or an object (pick ' + p.x + ',' + p.y + ').';
      host.cursor = p;
      if (!engine.click(p) && engine.waiting?.kind === 'select') host.print('Nothing found at ' + p.x + ',' + p.y + '.');
      return null;
    }
    if (raw.window !== undefined) {
      const w = raw.window;
      if (!Array.isArray(w) || w.length !== 4 || !w.every((n) => Number.isFinite(+n))) return 'window needs [x1, y1, x2, y2].';
      if (engine.waiting?.kind !== 'select') return 'A window is only taken where objects are being selected.';
      engine.window({ minX: Math.min(w[0], w[2]), minY: Math.min(w[1], w[3]), maxX: Math.max(w[0], w[2]), maxY: Math.max(w[1], w[3]) }, !!raw.crossing);
      return null;
    }
    if (raw.entity !== undefined) {
      const e = doc.get(+raw.entity);
      if (!e) return 'There is no object ' + raw.entity + '.';
      const w = engine.waiting;
      if (!w || (w.kind !== 'entity' && w.kind !== 'select')) return 'Nothing is asking for an object.';
      if (w.kind === 'select') { w.set.add(e.id); host.setSelection(w.set); host.print('1 found'); }
      else engine.resolve({ id: e.id, point: pt(raw.at) || anchor(doc, e), shift: !!raw.shift });
      return null;
    }
  } finally { host.shift = shift; }
  return 'Unknown input ' + JSON.stringify(raw).slice(0, 80) + '.';
}

/**
 * One typed line → the answers it makes, as CadCraft's command line reads typing: a space ends an answer like Enter
 * (two spaces = an empty answer), except where a text is asked (the rest of the line is the text) or for "(…" / "!…"
 * (LISP: the rest of the line). `expects()` tells what the command waits for at the moment the next answer goes in.
 */
export function nextTyped(rest, expecting) {
  if (expecting === 'string' || /^[(!]/.test(rest)) return [rest, null];
  const i = rest.indexOf(' ');
  return i < 0 ? [rest, null] : [rest.slice(0, i), rest.slice(i + 1)];
}

/**
 * Type at the command line. `input` as a list: each item (a string, or {pick}/{window}/{entity}/{escape}) answers the next
 * prompt. As one string: typed text — each line, and each space in it, ends an answer (nextTyped; 0.7 MCP-ANSWERS). A
 * command still waiting after the last input is ended with Esc, unless keepOpen (it then waits for the next call with
 * resume: true). All of it = ONE undo step, labelled prefix + the commands run (or label).
 * `capture(fn)` collects what the commands print (the host decides how: headless keeps it, the page also shows it).
 */
export async function runInput(engine, doc, host, input, { select = null, label = null, prefix = '', timeout = 60000, capture, keepOpen = false, resume = false } = {}) {
  const typed = !Array.isArray(input);
  const lines = typed ? scriptLines(input) : input;
  const printed = [], cmds = [];
  const stopCapture = capture ? capture((s) => { for (const l of String(s ?? '').split('\n')) if (printed.length < 2000) printed.push(l); }) : () => {};
  const onCmd = host.onCommand;
  host.onCommand = (name) => { if (name) cmds.push(name); if (onCmd) onCmd.call(host, name); };
  try {
    const held = resume && engine.busy ? engine.running : null;
    if (engine.busy && !held) { engine.escape(); await settle(engine); }
    if (select) host.setSelection(new Set(select.filter((id) => doc.get(id))));
    const before = snapshot(doc);
    const mark = doc.mark();
    let error = null, waiting = null;
    const one = async (raw) => {
      const r = feed(engine, doc, host, raw);
      if (r) { error = r; return false; }
      if (!(await settle(engine, timeout))) { error = 'The command did not finish within ' + Math.round(timeout / 1000) + ' s.'; return false; }
      return true;
    };
    outer: for (const raw of lines) {
      if (!typed || typeof raw !== 'string') { if (!(await one(raw))) break; continue; }
      let rest = raw;
      do {
        const [piece, more] = nextTyped(rest, engine.busy ? engine.expects : null);
        if (!(await one(piece))) break outer;
        rest = more;
      } while (rest !== null);
    }
    if (engine.busy) {
      waiting = { command: engine.running, kind: engine.expects, prompt: engine.waiting ? engine.promptText() : '' };
      if (keepOpen && !error) waiting.open = true;
      else {
        engine.escape(); await settle(engine);
        if (engine.busy) { engine.escape(); await settle(engine); }
      }
    }
    const what = label || [...new Set(cmds)].filter((n) => !/^_/.test(n)).join(', ').slice(0, 60) || held || 'command';
    doc.squash(mark, prefix + what);
    const after = snapshot(doc);
    const added = [], changed = [], removed = [];
    for (const [id, e] of after) { if (!before.has(id)) added.push(id); else if (before.get(id) !== e) changed.push(id); }
    for (const id of before.keys()) if (!after.has(id)) removed.push(id);
    const errLine = printed.find((l) => /^Error: /.test(l));
    return { printed, commands: cmds, added, changed, removed, waiting, undo: doc.undoStack.length > mark ? doc.undoStack[doc.undoStack.length - 1].label : null, error: error || (errLine ? errLine.replace(/^Error: /, '') : null) };
  } finally { host.onCommand = onCmd; stopCapture(); }
}

/**
 * LISP text (a .lsp file's contents) loaded and run as ONE undo step, as APPLOAD's Load does (lisp/install.js's hidden
 * _LISPLOAD). → as runInput, with `error` the load's own complaint when there is one.
 */
const warmed = new WeakSet();
export async function runLisp(engine, doc, host, text, { label = 'SCRIPT', name = 'script.lsp', prefix = '', capture, timeout = 60000 } = {}) {
  const { installLisp } = await import('./lisp/install.js');
  const ctx = installLisp.ctx;
  if (!ctx || !ctx.lookup('_LISPLOAD')) throw new Error('This CadCraft build has no LISP.');
  const printed = [], cmds = [];
  const stopCapture = capture ? capture((s) => { for (const l of String(s ?? '').split('\n')) if (printed.length < 2000) printed.push(l); }) : () => {};
  const onCmd = host.onCommand;
  host.onCommand = (n) => { if (n) cmds.push(n); if (onCmd) onCmd.call(host, n); };
  try {
    if (engine.busy) { engine.escape(); await settle(engine); }
    const before = snapshot(doc);
    const mark = doc.mark();
    // start the LISP runner first: a worker that starts during a load replays the session's files, this one included, so
    // its commands would run twice (lisp/session.js load(); asked of cad-bugs)
    if (typeof window !== 'undefined' && typeof Worker === 'function' && !warmed.has(engine)) {
      warmed.add(engine);
      const n = printed.length;
      await ctx.runHidden(engine, '_LISPEVAL', label, { kind: 'eval', text: '(princ)' });
      printed.length = n;
    }
    let done = false;
    const p = ctx.runHidden(engine, '_LISPLOAD', label, { kind: 'load', files: [{ name, text: String(text), kind: 'lsp' }] }).finally(() => { done = true; });
    // the page runs LISP in a worker: wait for the load itself; a routine that sits on one prompt for 1.5 s wants input
    const t0 = Date.now();
    let last = null, since = Date.now();
    while (!done && Date.now() - t0 < timeout) {
      await new Promise((r) => setTimeout(r, 25));
      const key = engine.waiting ? engine.expects + '|' + engine.promptText() : null;
      if (key !== last) { last = key; since = Date.now(); } else if (key && Date.now() - since > 1500) break;
    }
    let waiting = null;
    if (!done && engine.busy) { waiting = { command: engine.running, kind: engine.expects, prompt: engine.waiting ? engine.promptText() : '' }; engine.escape(); await settle(engine); }
    await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 100))]);
    doc.squash(mark, prefix + label);
    const after = snapshot(doc);
    const added = [], changed = [], removed = [];
    for (const [id, e] of after) { if (!before.has(id)) added.push(id); else if (before.get(id) !== e) changed.push(id); }
    for (const id of before.keys()) if (!after.has(id)) removed.push(id);
    const failed = printed.find((l) => /could not be loaded|error/i.test(l) && /\.lsp/.test(l));
    return { printed, commands: cmds, added, changed, removed, waiting, undo: doc.undoStack.length > mark ? doc.undoStack[doc.undoStack.length - 1].label : null, error: failed || null };
  } finally { host.onCommand = onCmd; stopCapture(); }
}

/**
 * Place a block with its attribute values in one step: INSERT answered for you (scale, rotation, point, each attribute it
 * asks), then the layer and any preset attribute set on the new reference, all ONE undo step "<prefix>INSERT <block>".
 */
export async function insertBlock(engine, doc, host, { block, at, scale = 1, rotation = 0, layer = null, attributes = {} } = {}, { prefix = '', capture, timeout } = {}) {
  const names = [...doc.blocks.keys()].filter((n) => !n.startsWith('*'));
  const name = names.find((n) => n === block) || names.find((n) => n.toLowerCase() === String(block).toLowerCase());
  if (!name) throw new Error('There is no block "' + block + '". Blocks: ' + (names.slice(0, 50).join(', ') || 'none') + (names.length > 50 ? ', …' : '') + '.');
  const defs = doc.blocks.get(name).attdefs || [];
  const given = {};
  for (const [k, v] of Object.entries(attributes || {})) {
    const d = defs.find((x) => x.tag.toUpperCase() === String(k).toUpperCase());
    if (!d) throw new Error('Block "' + name + '" has no attribute ' + k + '. Its attributes: ' + (defs.map((x) => x.tag).join(', ') || 'none') + '.');
    if (d.constant) throw new Error('Attribute ' + d.tag + ' of "' + name + '" is constant: its value is part of the block.');
    given[d.tag] = String(v).replace(/[\r\n]+/g, ' ');
  }
  const asked = defs.filter((d) => !d.constant && !d.preset);
  const input = ['INSERT', name, 'S', String(+scale || 1), 'R', String(+rotation || 0), num(at[0]) + ',' + num(at[1]), ...asked.map((d) => (d.tag in given ? given[d.tag] : ''))];
  const mark = doc.mark();
  const r = await runInput(engine, doc, host, input, { label: 'INSERT ' + name, prefix, capture, timeout });
  const id = r.added.find((x) => doc.get(x)?.type === 'insert' && doc.get(x).block === name);
  if (!id) return { ...r, id: null, error: r.error || 'The block was not placed.' };
  const e = doc.get(id);
  const presets = defs.filter((d) => d.preset && d.tag in given);
  if (layer || presets.length) {
    doc.change('INSERT', () => {
      if (layer) doc.layer(layer);
      doc.update(id, { ...e, ...(layer ? { layer } : {}), ...(presets.length ? { attrs: { ...(e.attrs || {}), ...Object.fromEntries(presets.map((d) => [d.tag, given[d.tag]])) } } : {}) });
    });
    doc.squash(mark, prefix + 'INSERT ' + name);
  }
  return { ...r, id, attributes: { ...(doc.get(id).attrs || {}) }, undo: doc.undoStack.length > mark ? doc.undoStack[doc.undoStack.length - 1].label : null };
}

/** Undo up to `steps` steps; only those labelled with `prefix` unless any. */
export function undoSteps(doc, steps = 1, { any = false, prefix = 'Assistant: ' } = {}) {
  const undone = [];
  for (let i = 0; i < steps; i++) {
    const top = doc.undoStack[doc.undoStack.length - 1];
    if (!top) break;
    if (!any && prefix && !String(top.label).startsWith(prefix)) break;
    undone.push(doc.undo());
  }
  return undone;
}

/** "1:100" / "1/4\" = 1'-0\"" / "fit" → n (sheets.js counting) or null for fit. */
export function parseScale(doc, s) {
  if (s === undefined || s === null || s === '' || /^fit/i.test(String(s))) return null;
  const str = String(s).trim();
  const r = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(str);
  if (r && +r[1] > 0 && +r[2] > 0) return +r[2] / +r[1];
  const norm = (x) => x.replace(/\s+/g, '').replace(/[’′]/g, "'").replace(/[”″]/g, '"').toLowerCase();
  const hit = scaleList(doc).find((o) => norm(o.label) === norm(str));
  if (hit) return hit.n;
  throw new Error('Unknown scale "' + str + '". Use 1:n, an architectural scale such as 1/4" = 1\'-0", or fit.');
}

/**
 * displayList options for a plot (0.6 DC.14): the plot style table the sheet (or, with no sheet, the model) names, when the
 * drawing has it, as the Plot dialog starts with; else monochrome or the drawing's colours by `mono`.
 */
export function plotStyleOptions(doc, layout = null, mono = true) {
  const own = findTable(doc, styleNameFor(doc, layout));
  return own ? { style: own } : { mono: mono !== false };
}

/** The sheet a plot prints and its display list (plot.js), as the Plot dialog makes them. */
export function plotList(doc, { layout = null, area = 'extents', paper = 'iso-a3', portrait = false, scale = null, mono = true } = {}) {
  let sheet, lay = null;
  if (layout) {
    lay = (doc.layouts || []).find((l) => l.name.toLowerCase() === String(layout).toLowerCase());
    if (!lay) throw new Error('There is no sheet "' + layout + '". Sheets: ' + ((doc.layouts || []).map((l) => l.name).join(', ') || 'none') + '.');
    sheet = layoutSheet(doc, lay);
  } else {
    if (!paperByKey(paper)) throw new Error('Papers: ' + PAPERS.map((p) => p.key).join(', ') + '.');
    const win = area && typeof area === 'object' ? area : null;
    const box = win ? { minX: Math.min(win.minX, win.maxX), minY: Math.min(win.minY, win.maxY), maxX: Math.max(win.minX, win.maxX), maxY: Math.max(win.minY, win.maxY) } : extentsOf(doc);
    if (!box) throw new Error('There is nothing to plot.');
    sheet = modelSheet(doc, { area: box, paper, portrait: !!portrait, n: parseScale(doc, scale) });
  }
  const list = displayList(doc, sheet, plotStyleOptions(doc, lay, mono));
  return { list, sheet: { w: num(list.w), h: num(list.h), scale: sheet.scale?.label || null, fits: sheet.scale ? sheet.scale.fits !== false : true } };
}

/** A PDF of a sheet or of the model: {bytes, sheet: {w, h, scale, fits}, missing}. */
export async function plotPdf(doc, o = {}) {
  const { list, sheet } = plotList(doc, o);
  const { bytes, report } = await toPdf(list, { pen: +o.pen || 0.25, title: (doc.meta.name || 'Drawing1') + (o.layout ? ' – ' + o.layout : '') });
  return { bytes, sheet, missing: report?.missing || 0 };
}

/** An SVG of a sheet or of the model, sized in mm: {bytes, sheet}. Pictures are left out (as in the plot preview). */
export async function plotSvg(doc, o = {}) {
  const { list, sheet } = plotList(doc, o);
  const K = 10;   // drawing units per mm in the file (text under 0.06 mm high is left out, as the preview does)
  const g = svgContext();
  drawPreview(g, list, { pxPerMm: K, pen: +o.pen || 0.25, font: 'Helvetica, Arial, sans-serif' });
  const text = g.svg(list.w * K, list.h * K, { width: num(list.w) + 'mm', height: num(list.h) + 'mm', title: (doc.meta.name || 'Drawing1') + (o.layout ? ' – ' + o.layout : '') });
  return { bytes: new TextEncoder().encode(text), sheet };
}

/**
 * A stand-in for the part of the canvas 2D API plot.js's drawPreview uses, writing SVG: paths (arcs flattened to 2°),
 * even-odd fills, clips, alpha and text with its own transform. → .svg(width, height, {width, height, title}) = the file.
 */
export function svgContext() {
  const out = [], esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const f = (v) => String(Math.round(v * 1000) / 1000);
  let st = { m: [1, 0, 0, 1, 0, 0], fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif', textAlign: 'left', groups: 0 };
  const stack = [];
  let path = [], clips = 0;
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const P = (x, y) => { const m = st.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; };
  const scaleOf = () => Math.sqrt(Math.abs(st.m[0] * st.m[3] - st.m[1] * st.m[2]));
  const d = () => path.map((p) => p.map((v, i) => (i ? f(v) : v)).join(' ')).join('');
  const alpha = () => (st.globalAlpha < 1 ? ' opacity="' + f(st.globalAlpha) + '"' : '');
  return {
    get fillStyle() { return st.fillStyle; }, set fillStyle(v) { st.fillStyle = String(v); },
    get strokeStyle() { return st.strokeStyle; }, set strokeStyle(v) { st.strokeStyle = String(v); },
    get lineWidth() { return st.lineWidth; }, set lineWidth(v) { st.lineWidth = +v; },
    get globalAlpha() { return st.globalAlpha; }, set globalAlpha(v) { st.globalAlpha = +v; },
    get font() { return st.font; }, set font(v) { st.font = String(v); },
    get textAlign() { return st.textAlign; }, set textAlign(v) { st.textAlign = String(v); },
    lineCap: 'round', lineJoin: 'round', textBaseline: 'alphabetic',
    save() { stack.push(st); st = { ...st, m: st.m.slice(), groups: 0 }; },
    restore() { for (let i = 0; i < st.groups; i++) out.push('</g>'); if (stack.length) st = stack.pop(); },
    setTransform(a, b, c, dd, e, ff) { st.m = [a, b, c, dd, e, ff]; },
    transform(a, b, c, dd, e, ff) { st.m = mul(st.m, [a, b, c, dd, e, ff]); },
    translate(x, y) { st.m = mul(st.m, [1, 0, 0, 1, x, y]); },
    rotate(r) { const c = Math.cos(r), sn = Math.sin(r); st.m = mul(st.m, [c, sn, -sn, c, 0, 0]); },
    scale(x, y) { st.m = mul(st.m, [x, 0, 0, y, 0, 0]); },
    beginPath() { path = []; },
    moveTo(x, y) { path.push(['M', ...P(x, y)]); },
    lineTo(x, y) { path.push(['L', ...P(x, y)]); },
    closePath() { path.push(['Z']); },
    arc(cx, cy, r, a0, a1, ccw = false) {
      let sweep = a1 - a0;
      if (ccw) { while (sweep > 0) sweep -= 2 * Math.PI; } else { while (sweep < 0) sweep += 2 * Math.PI; }
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 90)));
      for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; path.push([i || path.length ? 'L' : 'M', ...P(cx + r * Math.cos(a), cy + r * Math.sin(a))]); }
    },
    fillRect(x, y, w, h) { const q = [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)]; out.push('<path d="M' + q.map((p) => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z" fill="' + esc(st.fillStyle) + '"' + alpha() + '/>'); },
    fill(rule) { if (path.length) out.push('<path d="' + d() + '" fill="' + esc(st.fillStyle) + '"' + (rule === 'evenodd' ? ' fill-rule="evenodd"' : '') + alpha() + '/>'); },
    stroke() { if (path.length) out.push('<path d="' + d() + '" fill="none" stroke="' + esc(st.strokeStyle) + '" stroke-width="' + f(st.lineWidth * scaleOf()) + '" stroke-linecap="round" stroke-linejoin="round"' + alpha() + '/>'); },
    clip() { const id = 'c' + ++clips; out.push('<clipPath id="' + id + '"><path d="' + d() + '"/></clipPath><g clip-path="url(#' + id + ')">'); st.groups++; },
    fillText(text, x, y) {
      const m = /([\d.]+)px\s+(.*)$/.exec(st.font) || [0, '10', 'sans-serif'];
      const anchor = st.textAlign === 'center' ? 'middle' : st.textAlign === 'right' ? 'end' : 'start';
      out.push('<text transform="matrix(' + st.m.map(f).join(' ') + ')" x="' + f(x) + '" y="' + f(y) + '" font-size="' + f(+m[1]) + '" font-family="' + esc(m[2]) + '" text-anchor="' + anchor + '" fill="' + esc(st.fillStyle) + '"' + alpha() + ' xml:space="preserve">' + esc(text) + '</text>');
    },
    svg(w, h, { width, height, title = '' } = {}) {
      return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="' + esc(width || w) + '" height="' + esc(height || h) + '" viewBox="0 0 ' + f(w) + ' ' + f(h) + '">'
        + (title ? '<title>' + esc(title) + '</title>' : '') + '\n' + out.join('\n') + '\n</svg>\n';
    },
  };
}

// ---------------------------------------------------------------- the live tools (AGENTS-SPEC §5.2)

const PAPER_KEYS = PAPERS.map((p) => p.key);
export const BLOCK_INSERT_SCHEMA = obj({ block: { type: 'string', minLength: 1, maxLength: 255 }, at: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'The insertion point [x, y] in drawing units.' },
  scale: { type: 'number', minimum: 1e-9, maximum: 1e6, default: 1 }, rotation: { type: 'number', minimum: -360, maximum: 360, default: 0, description: 'Degrees.' },
  layer: { type: 'string', minLength: 1, maxLength: 255, description: 'Put the reference on this layer (made if missing); default the current layer.' },
  attributes: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'Attribute values by tag, e.g. {"TAG": "D-101"}; tags not given keep their defaults.' } }, ['block', 'at']);
const box = obj({ minX: { type: 'number' }, minY: { type: 'number' }, maxX: { type: 'number' }, maxY: { type: 'number' } }, ['minX', 'minY', 'maxX', 'maxY']);

/**
 * Register CadCraft's live tools on the page's host.control. `app` = {doc, engine, host (cadcraft.js's host object), view,
 * print, canvases: [base, overlay], saveFile(format), download(name, bytes, mime), report: () => lastReport}.
 */
/** The drawing's 3D model (the 3D tab: solids made with EXTRUDE, BOX …) as OpenUSD bytes, as `USDOUT` writes it (0.7 AS.6).
 *  Async: the writer is loaded only when asked for. Refuses a drawing with nothing in 3D. */
export async function drawingUsd(doc, { format = 'usda', name } = {}) {
  const { cadUsd } = await import('./usd-cadcraft.js');
  const r = cadUsd(doc.model3d, { format, name: name || doc.meta?.name || 'Drawing1' });
  if (!r.report?.objects) throw new Error('This drawing has nothing in 3D (draw solids on the 3D tab, or EXTRUDE, BOX, PRESSPULL).');
  return { bytes: typeof r.data === 'string' ? new TextEncoder().encode(r.data) : r.data, report: r.report };
}

export function installAgents(app) {
  const { doc, engine, host: cad, view } = app;
  const H = getHost({ app: 'cadcraft' });
  const C = H.control;
  const PREFIX = 'Assistant: ';
  let running = false, held = null;   // held: the command a keepOpen call left waiting (0.7 MCP-ANSWERS)
  const capture = (fn) => { const p = cad.print; cad.print = (s) => { fn(s); p.call(cad, s); }; return () => { cad.print = p; }; };
  const echo = (input) => {
    const text = (Array.isArray(input) ? input : scriptLines(input)).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' · ').slice(0, 300);
    app.print(t('agents.echo', { input: text }));
  };
  const run = async (input, o) => {
    running = true;
    // the in-page dialogs step aside: commands then ask on the command line, so the input list answers them (INSERT F's
    // whole drawing or block, its name clashes; 0.7 MCP-PATHS / MCP-ANSWERS)
    const dialogs = { chooseBlock: cad.chooseBlock, choose: cad.choose };
    cad.chooseBlock = undefined; cad.choose = undefined;
    try { echo(input); return await runInput(engine, doc, cad, input, { ...o, prefix: PREFIX, capture }); } finally { Object.assign(cad, dialogs); running = false; view?.invalidate?.(true); }
  };
  const trim = (r) => ({ ...r, added: r.added.slice(0, 2000), changed: r.changed.slice(0, 2000), removed: r.removed.slice(0, 2000), counts: { added: r.added.length, changed: r.changed.length, removed: r.removed.length } });

  // ---- files by path (0.7 MCP-PATHS): Studio only, inside the folders of Settings › Assistants › Folders (host.js)
  const F = C.files;
  const PATH = { type: 'string', minLength: 1, maxLength: 4096, description: 'A file inside the folders the person allowed in Settings › Assistants › Folders (files_list shows them; a relative path is inside the first folder). Studio only.' };
  const OVERWRITE = { type: 'boolean', default: false, description: 'Replace a file that already exists (one this window opened or wrote is replaced anyway).' };
  const needFiles = () => { if (!F.available) throw new Error('File paths work only in CadCraft Studio (the desktop app). In a browser, use the tools without a path.'); };
  const needGroup = (g, what) => { if (!C.groups.includes(g)) throw new Error(what + ' needs the ' + g + ' permission. The person can allow it in CadCraft: Settings › Assistants.'); };
  const fileGroup = (p) => (/\.(dwg|dxf)$/i.test(p) ? 'save' : 'export');
  /** While fn runs, the file dialogs CadCraft's commands open (INSERT F, XATTACH, ASBUILT, pictures) take the next of the
   *  given files instead (OPEN's dialog does through host.js itself). */
  const withPickers = async (fn) => {
    const keep = { pickDrawing: cad.pickDrawing, pickText: cad.pickText, pickPictures: cad.pickPictures };
    const next = async () => { const [f] = F.takeOpen(false) || []; if (!f) cad.print('No more files were given in openFiles.'); return f ? { name: f.name, bytes: await F.read(f.path) } : null; };
    cad.pickDrawing = async () => { const f = await next(); if (!f) return null; const { drawing } = await readDrawingBytes(f.bytes, f.name); return { drawing, fileName: f.name }; };
    cad.pickText = async () => { const f = await next(); return f ? { name: f.name, text: new TextDecoder().decode(f.bytes) } : null; };
    cad.pickPictures = async ({ multiple = false } = {}) => { const out = []; for (let f = await next(); f; f = multiple ? await next() : null) out.push(f); return out; };
    try { return await fn(); } finally { Object.assign(cad, keep); }
  };

  C.configure({
    title: 'CadCraft',
    busy: () => (engine.busy && !running && !(held && engine.running === held) ? engine.running : null),
    undo: async (label, fn) => { const mark = doc.mark(); try { return await fn(); } finally { doc.squash(mark, label); } },
    document: () => doc.meta.source || (doc.meta.name ? doc.meta.name + '.dwg' : null),   // Studio's window id: cadcraft:<file> (MCP-WINDOW-IDS)
    info: () => ({ drawing: doc.meta.name, unsaved: doc.version !== doc.savedVersion, space: doc.layout ? doc.layout.name : 'model', objects: doc.count(), busy: engine.busy ? engine.running : null }),
  });

  const T = (d) => C.tool(d);
  T({ name: 'app_info', group: 'read', title: 'About this window', description: 'CadCraft\'s window: the drawing open, whether it has unsaved changes, the space shown (model or a sheet), whether a command is running, and the permissions the person allowed.',
    run: async () => ({ app: 'cadcraft', title: 'CadCraft', allowed: C.groups, drawing: doc.meta.name, source: doc.meta.source || null, unsaved: doc.version !== doc.savedVersion, space: doc.layout ? doc.layout.name : 'model', objects: doc.count(), busy: engine.busy ? engine.running : null }) });
  if (F.available) T({ name: 'drawing_open', group: 'read', title: 'Open a drawing', description: 'Open a DWG or DXF file from the folders the person allowed (Settings › Assistants › Folders; files_list shows them) in this window, as File › Open does (a new tab unless the drawing shown is new and untouched). Returns a short description of it.',
    inputSchema: obj({ path: PATH }, ['path']),
    run: async (a) => {
      if (engine.busy && !running) throw new Error('CadCraft is in the middle of ' + engine.running + '; try again when it is done.');
      if (!/^(dwg|dxf)$/.test(extOf(a.path))) throw new Error('CadCraft opens .dwg and .dxf drawings here.');
      const printed = [];
      const stop = capture((x) => printed.push(String(x)));
      let full;
      try { full = await F.open(a.path); await settle(engine); } finally { stop(); }
      const name = full.replace(/^.*[\\/]/, '');
      if (doc.meta.source !== name) throw new Error(name + ' did not open' + (printed.length ? ': ' + printed.slice(-3).join(' ') : '.'));
      view?.invalidate?.(true);
      const dsc = describeDrawing(doc, { report: app.report ? app.report() : null });
      return { path: full, name: dsc.name, format: dsc.format, objects: dsc.objects, layers: dsc.layers.length, sheets: dsc.layouts.map((l) => l.name), units: dsc.units, notes: dsc.notes.slice(0, 10) };
    } });
  T({ name: 'drawing_describe', group: 'read', title: 'Describe the drawing', description: 'Units and length format, extents, the layer table (state and object counts), blocks and their uses, objects by type, sheets with their viewports, views.',
    run: async () => describeDrawing(doc, { report: app.report ? app.report() : null }) });
  T({ name: 'objects_list', group: 'read', title: 'List objects', description: 'Objects of the drawing, filtered and paged: id, type, layer, colour, geometry (drawing units), length/area where it has one, and a one-line description.',
    inputSchema: obj({ type: { type: 'string', enum: OBJECT_TYPES }, layer: { type: 'string', maxLength: 255 }, block: { type: 'string', maxLength: 255 }, text: { type: 'string', maxLength: 200 }, within: box, space: { type: 'string', maxLength: 255 }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }, countOnly: { type: 'boolean', default: false, description: 'Only the total, by type and by layer (no objects).' } }),
    run: async (a) => listObjects(doc, a) });
  T({ name: 'object_get', group: 'read', title: 'Get one object', description: 'One object in full (every field; a reference with its block definition).',
    inputSchema: obj({ id: { type: 'integer', minimum: 1 } }, ['id']),
    run: async (a) => { const o = objectInFull(doc, a.id); if (!o) throw new Error('There is no object ' + a.id + '.'); return o; } });
  T({ name: 'drawing_check', group: 'read', title: 'Check against standards', description: 'Check the drawing against layer and drafting rules (layers.allowed / required / noObjectsOn, objects.colorByLayer / linetypeByLayer / lineweightByLayer / textHeights / textStyles, blocks.noUnused, units).',
    inputSchema: obj({ rules: RULES_SCHEMA }, ['rules']), run: async (a) => checkDrawing(doc, a.rules) });
  T({ name: 'selection_get', group: 'read', title: 'Get the selection', description: 'The objects the person has selected now (ids and one-line descriptions, up to 1000).',
    run: async () => { const ids = [...cad.selection].filter((id) => doc.get(id)); return { count: ids.length, objects: ids.slice(0, 1000).map((id) => ({ id, type: doc.get(id).type, layer: doc.get(id).layer, description: plainObject(doc, doc.get(id)).description })) }; } });
  T({ name: 'view_describe', group: 'read', title: 'Describe the view', description: 'What is on screen: the space or sheet, the visible area in drawing units, the zoom, split-screen panes, and which layers are visible.',
    run: async () => {
      const r = view && view.viewRect ? view.viewRect() : null;
      return { space: doc.layout ? doc.layout.name : 'model', visible: r ? { minX: num(r.minX), minY: num(r.minY), maxX: num(r.maxX), maxY: num(r.maxY) } : null, zoom: view ? num(view.zoom) : null,
        panes: view && view.paneState ? (view.paneState() || null) : null, layersShown: [...doc.layers.values()].filter((l) => l.on !== false && !l.frozen).map((l) => l.name) };
    } });
  T({ name: 'view_screenshot', group: 'read', title: 'Picture of the view', description: 'A PNG of the drawing as it is on screen (up to 1600 px on the long side).',
    inputSchema: obj({ maxSize: { type: 'integer', minimum: 200, maximum: 1600, default: 1200 } }),
    run: async (a) => {
      const cs = (app.canvases || []).filter(Boolean);
      if (!cs.length || typeof document === 'undefined') throw new Error('No view to take a picture of.');
      const w0 = cs[0].width, h0 = cs[0].height, k = Math.min(1, a.maxSize / Math.max(w0, h0));
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w0 * k)); out.height = Math.max(1, Math.round(h0 * k));
      const g = out.getContext('2d');
      g.fillStyle = getComputedStyle(cs[0]).backgroundColor || '#fff';
      g.fillRect(0, 0, out.width, out.height);
      for (const c of cs) g.drawImage(c, 0, 0, out.width, out.height);
      const data = out.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      return toolResult([{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: 'The ' + (doc.layout ? 'sheet ' + doc.layout.name : 'model') + ' as shown, ' + out.width + ' × ' + out.height + ' px.' }], { width: out.width, height: out.height, space: doc.layout ? doc.layout.name : 'model' });
    } });
  T({ name: 'command_run', group: 'edit', title: 'Run a CadCraft command', description: 'Type at CadCraft\'s command line: one string, or a list where each item answers the next prompt ("" = Enter); items may also be {pick: [x, y]}, {window: [x1, y1, x2, y2], crossing}, {entity: id} or {escape: true}. Example: ["LINE", "0,0", "@100,0", ""]. One string is read as typed at the command line: each line and each space ends an answer, as Space does there (two spaces = an empty answer; a text prompt takes the rest of the line), e.g. "LINE 0,0 @100,0 @0,50 " (the last space ends LINE). A list gives one answer per item instead. A command still waiting at the end is ended with Esc unless keepOpen. The whole call is one undo step labelled "Assistant: …"; the person sees it in the command history.',
    inputSchema: obj({ input: INPUT_SCHEMA, select: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100000 }, keepOpen: { type: 'boolean', default: false, description: 'Leave a command that still waits after the last answer open (the result says what it waits for); the next command_run with continue: true answers it. Each call is still one undo step.' }, continue: { type: 'boolean', default: false, description: 'Answer the command a keepOpen call left waiting, instead of starting at the command prompt.' },
      openFiles: { type: 'array', items: PATH, minItems: 1, maxItems: 20, description: 'Studio: files that answer the file dialogs the commands open, in order (OPEN, INSERT F, XATTACH, ASBUILT, pictures). Needs read.' },
      saveTo: { ...PATH, description: 'Studio: where a file the commands write goes instead of a save dialog or a download (COUNT\'s CSV, PUBLISH, SAVEAS, DXFOUT); a second file goes beside it under its own name. Needs save for .dwg/.dxf, export for anything else.' },
      overwrite: OVERWRITE }, ['input']),
    run: async (a) => {
      if (a.continue && !(held && engine.busy && engine.running === held)) { held = null; throw new Error('No command is waiting for the assistant: leave one open with keepOpen: true first.'); }
      const go = async () => { const r = await run(a.input, { select: a.select, keepOpen: a.keepOpen, resume: a.continue }); held = r.waiting && r.waiting.open ? r.waiting.command : null; return r; };
      if (!a.openFiles && !a.saveTo) return trim(await go());
      needFiles();
      if (a.openFiles) needGroup('read', 'Opening files');
      if (a.saveTo) needGroup(fileGroup(a.saveTo), 'Writing ' + a.saveTo.replace(/^.*[\\/]/, ''));
      let job = go;
      let written = null, used = null, refused = [];
      if (a.saveTo) { const inner = job; job = async () => { const r = await F.into(a.saveTo, inner, { overwrite: a.overwrite }); written = r.written; refused = r.errors; return r.result; }; }
      if (a.openFiles) { const inner = job; job = async () => { const r = await F.from(a.openFiles, () => withPickers(inner)); used = r.used; return r.result; }; }
      const r = trim(await job());
      return { ...r, ...(written ? { filesWritten: written } : {}), ...(used ? { filesOpened: used } : {}), ...(refused.length ? { filesRefused: refused } : {}) };
    } });
  T({ name: 'script_run', group: 'edit', title: 'Run a script', description: 'Run a script on the drawing as one undo step: language "scr" (command-line lines, as a .scr file) or "lisp" (AutoLISP-style, CadCraft\'s own interpreter, as APPLOAD loads it). Give the script text, or (Studio) a path to a .scr / .lsp file inside the allowed folders.',
    inputSchema: obj({ script: { type: 'string', minLength: 1, maxLength: 1000000 }, path: PATH, language: { type: 'string', enum: ['scr', 'lisp'] } }),
    run: async (a) => {
      if (!a.script === !a.path) throw new Error('Give the script text or a path, one of them.');
      let text = a.script, name = 'script.lsp';
      if (a.path) { needFiles(); needGroup('read', 'Reading ' + a.path.replace(/^.*[\\/]/, '')); const full = F.resolve(a.path); name = full.replace(/^.*[\\/]/, ''); text = new TextDecoder().decode(await F.read(full)); }
      const lang = a.language || (/\.(lsp|vlx?|fas)$/i.test(name) && a.path ? 'lisp' : 'scr');
      if (lang === 'scr') return trim(await run(text, { label: 'SCRIPT' }));   // a .scr reads as typed: a space is Enter
      running = true;
      try { echo('(load "' + name + '")'); return trim(await runLisp(engine, doc, cad, text, { name, prefix: PREFIX, capture })); } finally { running = false; view?.invalidate?.(true); }
    } });
  T({ name: 'block_insert', group: 'edit', title: 'Insert a block', description: 'Place a block of the drawing at a point with its attribute values in one call (as INSERT does, its questions answered), optionally on a layer; one undo step. A block from another drawing: command_run with ["INSERT", "F", …] and openFiles (Studio).',
    inputSchema: BLOCK_INSERT_SCHEMA,
    run: async (a) => {
      running = true;
      const dialogs = { chooseBlock: cad.chooseBlock, choose: cad.choose };
      cad.chooseBlock = undefined; cad.choose = undefined;
      try { echo('INSERT ' + a.block); return trim(await insertBlock(engine, doc, cad, a, { prefix: PREFIX, capture })); } finally { Object.assign(cad, dialogs); running = false; view?.invalidate?.(true); }
    } });
  T({ name: 'selection_set', group: 'edit', title: 'Set the selection', description: 'Select objects by id (replace, add or remove); the next command acts on them (noun-verb). Unknown ids are refused.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 100000 }, mode: { type: 'string', enum: ['replace', 'add', 'remove'], default: 'replace' } }, ['ids']),
    run: async (a) => {
      const bad = a.ids.filter((id) => !doc.get(id));
      if (bad.length) throw new Error('No objects ' + bad.slice(0, 10).join(', ') + (bad.length > 10 ? ', …' : '') + ' in the space shown.');
      const s = a.mode === 'replace' ? new Set() : new Set(cad.selection);
      for (const id of a.ids) { if (a.mode === 'remove') s.delete(id); else s.add(id); }
      cad.setSelection(s);
      return { count: s.size };
    } });
  T({ name: 'undo', group: 'edit', title: 'Undo', description: 'Undo the assistant\'s last steps (only steps labelled "Assistant:" unless any is true).',
    inputSchema: obj({ steps: { type: 'integer', minimum: 1, maximum: 100, default: 1 }, any: { type: 'boolean', default: false } }),
    run: async (a) => { const u = undoSteps(doc, a.steps, { any: a.any, prefix: PREFIX }); view?.invalidate?.(true); return { undone: u }; } });
  T({ name: 'drawing_save', group: 'save', title: 'Save the drawing', description: 'CadCraft\'s own Save, in the drawing\'s format (or the one given): on the desktop it is written to its file; in a browser it is downloaded as a copy. With a path (Studio) it is Save as: written there, and later saves go there too. DWG versions 2000, 2004, 2007, 2010, 2013, 2018.',
    inputSchema: obj({ format: { type: 'string', enum: ['dwg', 'dxf2000', 'dxf'] }, path: PATH, version: { type: 'string', enum: ['2000', '2004', '2007', '2010', '2013', '2018'] }, overwrite: OVERWRITE }),
    run: async (a) => {
      if (engine.busy) throw new Error('A command is running; try again when it is done.');
      let format = a.format;
      if (a.path) {
        needFiles();
        const ext = extOf(a.path);
        if (ext !== 'dwg' && ext !== 'dxf') throw new Error('Drawings are written as .dwg or .dxf.');
        format = format || (ext === 'dwg' ? 'dwg' : 'dxf2000');
        if ((format === 'dwg') !== (ext === 'dwg')) throw new Error('Format ' + format + ' is written to a .' + (format === 'dwg' ? 'dwg' : 'dxf') + ' file.');
      }
      if (a.version) { if (format && format !== 'dwg') throw new Error('A version is for DWG only.'); doc.meta.dwgVersion = a.version; }   // as SAVEAS's choice: kept for this drawing
      const printed = [];
      const stop = capture((s) => printed.push(String(s)));
      let written = null;
      try {
        if (a.path) {
          const r = await F.into(a.path, () => app.saveFile(format), { overwrite: a.overwrite });
          if (!r.written.length) throw new Error(r.errors[0] || 'Nothing was written to ' + a.path + '.');
          written = r.written;
        } else await app.saveFile(format);
      } finally { stop(); }
      return { saved: doc.version === doc.savedVersion, ...(written ? { path: written[0] } : {}), printed };
    } });
  T({ name: 'drawing_plot', group: 'export', title: 'Plot to PDF', description: 'A vector PDF of a sheet (layout) or of the model (extents or a window, on a paper at a scale or fitted), downloaded (desktop: saved where the person chooses). Papers ' + PAPER_KEYS.join(', ') + '; scales "1:50", "1/4\\" = 1\'-0\\"" or "fit".',
    inputSchema: obj({ layout: { type: 'string', maxLength: 255 }, window: box, paper: { type: 'string', enum: PAPER_KEYS, default: 'iso-a3' }, portrait: { type: 'boolean', default: false }, scale: { type: 'string', maxLength: 40, default: 'fit' }, mono: { type: 'boolean', default: true }, pen: { type: 'number', minimum: 0.05, maximum: 2, default: 0.25 }, name: { type: 'string', maxLength: 120 },
      path: { ...PATH, description: 'Studio: write the plot here (a .pdf, or an .svg, inside the allowed folders) instead of asking where.' }, overwrite: OVERWRITE }),
    run: async (a) => {
      if (a.path) { needFiles(); if (!/^(pdf|svg)$/.test(extOf(a.path))) throw new Error('The plot is written to a .pdf or .svg file.'); }
      const r = await (a.path && extOf(a.path) === 'svg' ? plotSvg : plotPdf)(doc, { layout: a.layout || null, area: a.window || 'extents', paper: a.paper, portrait: a.portrait, scale: a.scale, mono: a.mono, pen: a.pen });
      if (a.path) {
        const full = await F.write(a.path, r.bytes, { overwrite: a.overwrite });
        app.print(t('agents.plotted', { name: full }));
        return { path: full, bytes: r.bytes.length, sheetMm: { w: r.sheet.w, h: r.sheet.h }, scale: r.sheet.scale, fitsOnPaper: r.sheet.fits, unprintableCharacters: r.missing };
      }
      const name = (a.name || ((doc.meta.name || 'Drawing1') + (a.layout ? '-' + a.layout : ''))).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.pdf$/i, '') + '.pdf';
      app.download(name, r.bytes, 'application/pdf');
      app.print(t('agents.plotted', { name }));
      return { name, bytes: r.bytes.length, sheetMm: { w: r.sheet.w, h: r.sheet.h }, scale: r.sheet.scale, fitsOnPaper: r.sheet.fits, unprintableCharacters: r.missing };
    } });
  T({ name: 'usd_export', group: 'export', title: 'Export USD', description: 'The 3D model of the drawing (solids on the 3D tab) as OpenUSD, .usda (default), .usdc or .usdz, as USDOUT writes it. With a path (Studio) it is written there, else it downloads.',
    inputSchema: obj({ format: { type: 'string', enum: ['usda', 'usdc', 'usdz'] }, path: { ...PATH, description: 'Studio: a .usda, .usdc or .usdz file inside the allowed folders.' }, overwrite: OVERWRITE }),
    run: async (a) => {
      if (a.path) needFiles();
      const fmt = a.format || (a.path && /^usd[acz]$/.test(extOf(a.path)) ? extOf(a.path) : 'usda');
      if (a.path && extOf(a.path) !== fmt) throw new Error('A .' + fmt + ' file ends in .' + fmt + '.');
      const name = (doc.meta.name || 'Drawing1').replace(/[\\/:*?"<>|]+/g, '_');
      const r = await drawingUsd(doc, { format: fmt, name });
      if (a.path) return { format: fmt, bytes: r.bytes.length, report: r.report, path: await F.write(a.path, r.bytes, { overwrite: a.overwrite }) };
      app.download(name + '.' + fmt, r.bytes, fmt === 'usda' ? 'model/vnd.usda' : fmt === 'usdz' ? 'model/vnd.usdz+zip' : 'application/octet-stream');
      return { format: fmt, bytes: r.bytes.length, report: r.report, downloaded: name + '.' + fmt };
    } });
  return C;
}
