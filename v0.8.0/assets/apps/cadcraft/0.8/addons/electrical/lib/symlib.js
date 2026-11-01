/* SPDX-License-Identifier: Apache-2.0 */
/**
 * symlib.js — other symbol libraries (0.5 WL.36): the blocks of a DWG/DXF drawing turned into Electrical symbols, each one
 * acting as one of Electrical's own types (a coil, a make contact, a fuse …) so tags, wires, cross-references and the lists
 * treat it like ours. DOM-free; tested in Node (test/t-symlib.mjs).
 *
 *   candidates(doc)                 the blocks worth importing from a drawing loaded into a Doc: named (not *U…, not a
 *                                   layout), with something drawn, not already one of ours → [{ name, blk }]
 *   suggest(name, tags)             the symbol type a block's name says it is (keyword rules), or null
 *   findPins(blk, scale)            connection points: attributes named like terminals (TERM01, X2TERM02, PIN1, CONN3, T1…),
 *                                   else line ends on the block's outline → [{x, y}] (block units × scale)
 *   ATTR_MAP                        their attribute names → ours (TAG, DESC, MFR, PART, ORDER, FUNC, LOC)
 *   convert(blk, key, opts)         → { block (an EL_LIB_… definition with the EL attribute: sym = the type, lib = their
 *                                   name, std = 'lib'), pins, mapped: {theirs → ours}, kept: [their other attributes] }
 *   unitScale(units)                a drawing's units (doc.meta.units: 'inches', 'feet', …) → millimetres per unit (unknown 1)
 *   readLibrary(raw)                the saved library (localStorage) read back as untrusted → [{ key, name, block }]
 * The geometry is theirs: it is copied, scaled to millimetres, and never redrawn (ELSTANDARD leaves it alone).
 */

import { symbol, writeMeta, readMeta, META_TAG, PIN_TEXT_H, TAG_TEXT_H, boundsOf } from './symbols.js';

export const LIMITS = { blocks: 500, entities: 4000, pins: 16 };
const clone = (v) => JSON.parse(JSON.stringify(v));
const fin = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;

/** Name keywords → symbol type (first match wins; tested on the upper-cased name with _ - . and spaces as separators). */
const RULES = [
  [/\b(ON ?DELAY|TDE|TON)\b/, 'coil.on-delay'], [/\b(OFF ?DELAY|TDD|TOF)\b/, 'coil.off-delay'],
  [/\b(COIL|RELAY|CONTACTOR|CR|K\d*)\b/, 'coil'],
  [/\b(PB|PUSH ?BUTTON|BUTTON)\b.*\b(NC|N C|BREAK)\b|\b(NC|BREAK)\b.*\b(PB|PUSH ?BUTTON|BUTTON)\b/, 'pushbutton.nc'],
  [/\b(PB|PUSH ?BUTTON|BUTTON)\b/, 'pushbutton.no'],
  [/\b(LIMIT|LS)\b/, 'switch.limit'], [/\b(SELECTOR|SS)\b/, 'switch.selector'], [/\b(SWITCH|SW)\b/, 'switch.manual'],
  [/\b(CHANGE ?OVER|CO|SPDT)\b/, 'contact.co'], [/\b(NC|N C|BREAK)\b/, 'contact.nc'], [/\b(NO|N O|MAKE|CONTACT)\b/, 'contact.no'],
  [/\b(MOTOR|MTR)\b.*\b(DC)\b|\b(DC)\b.*\b(MOTOR|MTR)\b/, 'motor.dc'], [/\b(MOTOR|MTR|M3|M)\b/, 'motor.3ph'],
  [/\b(OVERLOAD|OL|THERMAL)\b/, 'overload'], [/\b(MPCB|MOTOR ?PROTECT)/, 'breaker.motor'],
  [/\b(CB|MCB|BREAKER|QF)\b.*\b(3P|3 ?POLE)\b|\b(3P|3 ?POLE)\b.*\b(CB|MCB|BREAKER|QF)\b/, 'breaker.3p'], [/\b(CB|MCB|BREAKER|QF)\b/, 'breaker'],
  [/\b(DISCONNECT|ISOLATOR|DS)\b/, 'disconnector'], [/\bFUSE\b|\bFU\b/, 'fuse'],
  [/\b(LAMP|LIGHT|PILOT|LT|PL|INDICATOR)\b/, 'lamp'], [/\b(HORN|BUZZER|BELL|SIREN)\b/, 'horn'],
  [/\b(TRANSFORMER|XFMR|TRANSF|TR)\b/, 'transformer'],
  [/\b(PLC)\b.*\b(IN|INPUT|DI)\b|\b(DI|INPUT)\b/, 'plc.input'], [/\b(PLC)\b.*\b(OUT|OUTPUT|DO)\b|\b(DO|OUTPUT)\b/, 'plc.output'],
  [/\b(TERMINAL|TERM|TB|TS)\b/, 'terminal'], [/\b(GROUND|EARTH|GND|PE)\b/, 'earth'],
];

export function suggest(name) {
  const n = ' ' + String(name || '').toUpperCase().replace(/[_\-.\s/]+/g, ' ').replace(/(\d)/g, ' $1').trim() + ' ';
  for (const [re, key] of RULES) if (re.test(n) && symbol(key)) return key;
  return null;
}

/** Their attribute names → ours. Anything else is kept as it is (invisible), so their data travels with the symbol. */
export const ATTR_MAP = [
  [/^(TAG\d*|DEVICE|DEVICE_?TAG|ITEM|NAME|REF|REFDES|DESIGNATOR)$/, 'TAG'],
  [/^(DESC\d*|DESCRIPTION|FUNCTION|TEXT|LABEL)$/, 'DESC'],
  [/^(MFG|MFR|MAKER|MANUFACTURER|BRAND|VENDOR)$/, 'MFR'],
  [/^(CAT|CATALOG|CATALOGUE|PART|PART_?NO|PARTNUMBER|PN|MODEL|TYPE)$/, 'PART'],
  [/^(ORDER|ORDER_?NO|ORDERCODE|SKU)$/, 'ORDER'],
  [/^(INST|INSTALLATION|PLANT|FUNC)$/, 'FUNC'], [/^(LOC|LOCATION|PLACE)$/, 'LOC'],
];
const ourName = (tag) => { for (const [re, to] of ATTR_MAP) if (re.test(tag)) return to; return null; };
const PIN_ATTR = /^((X\d)?TERM\d+|PIN\d+|CONN\d+|CP\d+|T\d+|WIRE\d+)$/;

export function unitScale(units) {
  return { inches: 25.4, feet: 304.8, millimeters: 1, centimeters: 10, meters: 1000 }[String(units || '').toLowerCase()] || 1;
}

const blockEntities = (blk) => [...(blk.entities instanceof Map ? blk.entities.values() : blk.entities || [])];

export function candidates(doc) {
  const out = [];
  for (const [name, blk] of doc.blocks) {
    if (!name || name.startsWith('*') || /^(A\$|_|EL_)/i.test(name) || readMeta(blk)) continue;
    const ents = blockEntities(blk);
    if (!ents.some((e) => ['line', 'poly', 'circle', 'arc', 'ellipse', 'hatch'].includes(e.type))) continue;
    if (ents.length > LIMITS.entities) continue;
    out.push({ name, blk });
    if (out.length >= LIMITS.blocks) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** Points where wires connect, in the block's own coordinates relative to its base, times scale. */
export function findPins(blk, scale = 1) {
  const base = blk.base || { x: 0, y: 0 };
  const rel = (x, y) => ({ x: (x - base.x) * scale, y: (y - base.y) * scale });
  const byAttr = (blk.attdefs || []).filter((a) => PIN_ATTR.test(String(a.tag).toUpperCase()) && fin(a.x) && fin(a.y))
    .sort((a, b) => String(a.tag).localeCompare(String(b.tag), 'en', { numeric: true })).map((a) => rel(a.x, a.y));
  if (byAttr.length) return byAttr.slice(0, LIMITS.pins);
  // line ends lying on the drawing's outline: where a symbol's leads stop
  const ents = blockEntities(blk);
  const bb = boundsOf(ents.filter((e) => e.type !== 'text'), []);   // the drawing's outline, not its labels
  const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
  const tol = Math.max(w, h) * 1e-3 + 1e-9;
  const ends = [];
  for (const e of ents) {
    const pts = e.type === 'line' ? [[e.x1, e.y1], [e.x2, e.y2]] : e.type === 'poly' && !e.closed && e.pts?.length ? [[e.pts[0].x, e.pts[0].y], [e.pts.at(-1).x, e.pts.at(-1).y]] : [];
    for (const [x, y] of pts) {
      const onTB = h > tol && (Math.abs(y - bb.y0) < tol || Math.abs(y - bb.y1) < tol);
      const onLR = w > tol && (Math.abs(x - bb.x0) < tol || Math.abs(x - bb.x1) < tol);
      // a lead: the end of a line that leaves the outline straight (vertical leads on top/bottom, horizontal on the sides)
      if ((onTB && e.type === 'line' && Math.abs(e.x1 - e.x2) < tol) || (onLR && e.type === 'line' && Math.abs(e.y1 - e.y2) < tol)) {
        if (!ends.some((p) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol)) ends.push({ x, y });
      }
    }
  }
  ends.sort((a, b) => b.y - a.y || a.x - b.x);   // top first, then left to right (current flows top to bottom)
  return ends.slice(0, LIMITS.pins).map((p) => rel(p.x, p.y));
}

const safeName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
export const libBlockName = (name) => ('EL_LIB_' + safeName(name)).slice(0, 31);

function scaled(e, s, base) {
  const o = clone(e);
  delete o.id;
  const X = (x) => (x - base.x) * s, Y = (y) => (y - base.y) * s;
  switch (o.type) {
    case 'line': Object.assign(o, { x1: X(o.x1), y1: Y(o.y1), x2: X(o.x2), y2: Y(o.y2) }); break;
    case 'poly': o.pts = o.pts.map((p) => ({ ...p, x: X(p.x), y: Y(p.y) })); break;
    case 'circle': case 'arc': Object.assign(o, { cx: X(o.cx), cy: Y(o.cy), r: o.r * s }); break;
    case 'ellipse': Object.assign(o, { cx: X(o.cx), cy: Y(o.cy), mx: o.mx * s, my: o.my * s }); break;
    case 'hatch': o.loops = o.loops.map((l) => l.map((v, i) => (i % 2 ? Y(v) : X(v)))); break;
    case 'text': case 'point': case 'insert': Object.assign(o, { x: X(o.x), y: Y(o.y) }); if (o.h) o.h *= s; if (o.type === 'insert') { o.sx = (o.sx ?? 1) * s; o.sy = (o.sy ?? 1) * s; } break;
    default: return null;
  }
  return o;
}

/**
 * One of their blocks as an Electrical symbol of type `key`. opts: scale (their units → mm), name (the library name).
 * Inserts inside their block are dropped (a symbol is one drawing); their text stays.
 */
export function convert(blk, key, { scale = 1, name = blk.name } = {}) {
  const s = symbol(key);
  if (!s) throw new Error('unknown symbol type ' + key);   // i18n-ignore (a programming error)
  const base = blk.base || { x: 0, y: 0 };
  const entities = blockEntities(blk).filter((e) => e.type !== 'insert').map((e) => scaled(e, scale, base)).filter(Boolean)
    .map((e) => ({ ...e, layer: '0', color: e.color ?? null }));
  const found = findPins(blk, scale);
  const pinTags = found.length === s.pins.length ? s.pins.map(([tag]) => tag) : found.map((_, i) => 'P' + (i + 1));
  const pins = found.map((p, i) => ({ tag: pinTags[i], x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
  const bb = boundsOf(entities, pins.map((p) => [p.tag, p.x, p.y]));
  const left = Math.min(bb.x0, -1.5) - 1.5;
  const ad = (tag, x, y, h, extra = {}) => ({ tag, prompt: tag, def: '', x, y, h, rot: 0, ha: 'left', va: 'baseline', wf: 1, layer: '0', color: null, ...extra });
  const attdefs = [ad('TAG', left, 0.6, TAG_TEXT_H, { ha: 'right' }), ad('DESC', left, -2.6, PIN_TEXT_H, { ha: 'right' })];
  for (const k of ['FUNC', 'LOC', 'MFR', 'PART', 'ORDER']) attdefs.push(ad(k, left, -5, PIN_TEXT_H, { ha: 'right', invisible: true }));
  pins.forEach((p, i) => attdefs.push(ad(p.tag, p.x + 0.8, p.y > 0 ? p.y - 1.6 : p.y + 0.4, PIN_TEXT_H, { def: (found.length === s.pins.length ? s.pins[i][3] : '') || '' })));
  if (s.role === 'contact') attdefs.push(ad('XREF', Math.max(bb.x1, 1.5) + 1, -0.9, PIN_TEXT_H));
  if (s.role === 'coil') for (let i = 1; i <= 8; i++) attdefs.push(ad('XREF' + i, 1.5, -8 - (i - 1) * 2.3, PIN_TEXT_H));
  if (s.role === 'plc') attdefs.push(ad('ADDR', 0, -5, PIN_TEXT_H, { ha: 'center' }));
  // their attributes: mapped onto ours (their default value kept), the rest carried along, invisible
  const mapped = {}, kept = [];
  for (const a of blk.attdefs || []) {
    const tag = String(a.tag || '').toUpperCase();
    if (!/^[A-Z0-9_$-]{1,64}$/.test(tag) || tag === META_TAG || PIN_ATTR.test(tag) || a.constant) continue;
    const to = ourName(tag);
    const ours = to && attdefs.find((d) => d.tag === to);
    if (ours && !Object.values(mapped).includes(to)) { mapped[tag] = to; if (a.def) ours.def = String(a.def).slice(0, 255); continue; }
    if (attdefs.some((d) => d.tag === tag)) continue;
    kept.push(tag);
    attdefs.push(ad(tag, left, -5, PIN_TEXT_H, { ha: 'right', invisible: true, def: String(a.def ?? '').slice(0, 255) }));
  }
  attdefs.push({ ...ad(META_TAG, 0, 0, 1, { invisible: true, constant: true }), def: writeMeta({ sym: key, std: 'lib', role: s.role, kind: s.kind, poles: s.poles, lib: String(name).slice(0, 60), pins }) });
  return { block: { name: libBlockName(name), base: { x: 0, y: 0 }, entities, attdefs }, pins, mapped, kept };
}

/** The library saved in this browser, read back as untrusted data. */
export function readLibrary(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw.slice(0, LIMITS.blocks)) {
    const b = x && x.block;
    if (!x || typeof x.name !== 'string' || !symbol(x.key) || !b || typeof b.name !== 'string' || !/^EL_LIB_[A-Z0-9_]{1,24}$/.test(b.name)) continue;
    if (!Array.isArray(b.entities) || b.entities.length > LIMITS.entities || !Array.isArray(b.attdefs) || b.attdefs.length > 300) continue;
    const meta = readMeta({ attdefs: b.attdefs });
    if (!meta || meta.sym !== x.key || meta.std !== 'lib') continue;
    out.push({ key: x.key, name: x.name.slice(0, 60), block: clone(b) });
  }
  return out;
}
