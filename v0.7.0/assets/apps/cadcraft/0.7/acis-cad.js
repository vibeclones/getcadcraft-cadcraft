/* SPDX-License-Identifier: Apache-2.0 */
/**
 * acis-cad.js — CadCraft and the 3D solids other programs put in a drawing (3DSOLID, REGION, BODY: ACIS data; 0.7
 * D7.25, docs/ACIS-READER.md). No DOM: bin/test-cadcraft.mjs and tools/acis/test-apps.mjs run it in Node.
 *
 * The model space's solids are kept on the Doc as they came — `doc.solids` [{ type, layer, color, acis: { format,
 * version, data } }] — never edited: the 3D tab draws them read-only (cc-acis, ./acis/, a byte-identical copy of
 * lib/acis by tools/acis/sync.mjs; loaded with the 3D tab), and saving as DWG writes each one back unchanged (cc-dwg
 * writes REGION / 3DSOLID / BODY). DXF R12 has no place for them: Save says so. Solids inside blocks are counted, not
 * shown yet.
 *
 *   keptFromDwg(entities, colorOf) → kept list     dwg-import.js: the model space's entities (cc-dwg's model)
 *   keptFromDxf(pairs) → { kept, inBlocks }         dxf.js: every [code, value] pair of the file
 *   cleanSolids(list) → kept list                   doc.load (a file's data: untrusted)
 *   solidMeshes(doc, cc) → { list: [{ body, layer, color }], solids, faces, drawn, notDrawn: Map }   cached per doc.solids
 *   solidsForDwg(doc, color) → cc-dwg entities      dwg-save.js (color: its CadCraft colour → cc-dwg colour)
 */

import { acisFromDxf, acisFromDxfDataStorage, bytesToB64 } from './acis/dxf.js';

export const SOLID_TYPES = new Set(['3DSOLID', 'REGION', 'BODY']);
const MAX_SOLIDS = 20000;
const MAX_DATA = 96 * 1024 * 1024;   // base64 of cc-acis' 64 MB

const okColor = (c) => c === null || c === undefined || (Number.isInteger(c) && c >= 0 && c <= 256) || (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));

/** cc-dwg's model-space entities → the solids to keep (with their data; empty ones are left out) */
export function keptFromDwg(entities, colorOf) {
  const out = [];
  for (const e of entities || []) {
    if (!SOLID_TYPES.has(e?.type) || !e.acis || !e.acis.data || out.length >= MAX_SOLIDS) continue;
    const c = colorOf(e);
    out.push({ type: e.type, layer: String(e.layer || '0'), color: okColor(c) ? c ?? null : null, acis: { format: e.acis.format === 'sab' ? 'sab' : 'sat', version: e.acis.version, data: String(e.acis.data) } });
  }
  return out;
}

/**
 * A DXF's solids: the ENTITIES section's top-level 3DSOLID / REGION / BODY (not paper space), their data from their own
 * group 1/3 lines (DXF ≤ 2010) or the ACDSDATA section (2013+, by handle). Solids in BLOCKS are only counted.
 */
export function keptFromDxf(pairs) {
  const kept = [];
  let inBlocks = 0, sec = '', cur = null, ds = null;
  const ents = [];
  for (let i = 0; i < pairs.length; i++) {
    const [c, v0] = pairs[i];
    const v = typeof v0 === 'string' ? v0.trim() : v0;
    if (c === 0 && v === 'SECTION') { sec = String(pairs[i + 1]?.[1] || '').trim(); i++; cur = null; continue; }
    if (c === 0 && v === 'ENDSEC') { sec = ''; cur = null; continue; }
    if (sec === 'ACDSDATA') { (ds ||= []).push(pairs[i]); continue; }
    if (sec === 'BLOCKS' && c === 0 && SOLID_TYPES.has(v)) inBlocks++;
    if (sec !== 'ENTITIES') continue;
    if (c === 0) { cur = SOLID_TYPES.has(v) ? { type: v, g: [] } : null; if (cur) ents.push(cur); continue; }
    if (cur) cur.g.push(pairs[i]);
  }
  let store = null;
  for (const e of ents) {
    if (kept.length >= MAX_SOLIDS) break;
    const val = (code) => { const p = e.g.find(([c]) => c === code); return p ? String(p[1]).trim() : undefined; };
    if (val(67) === '1') continue;   // paper space
    let acis = acisFromDxf(e.g);
    if (!acis) {
      const h = (val(5) || '').toUpperCase().replace(/^0+(?=.)/, '');
      store ||= acisFromDxfDataStorage(ds || []);
      const b = h && store.get(h);
      if (b) acis = { format: isSab(b) ? 'sab' : 'sat', data: isSab(b) ? bytesToB64(b) : latin1(b) };
    }
    if (!acis) continue;
    const aci = val(62), tc = val(420);
    const color = tc !== undefined && Number.isFinite(+tc) ? '#' + ((+tc) & 0xffffff).toString(16).padStart(6, '0') : aci === undefined ? null : +aci === 256 ? null : Math.abs(+aci) | 0;
    kept.push({ type: e.type, layer: val(8) || '0', color: okColor(color) ? color : null, acis });
  }
  return { kept, inBlocks };
}
const isSab = (b) => { const h = latin1(b.subarray(0, 15)); return h === 'ACIS BinaryFile' || h === 'ASM BinaryFile4'; };
function latin1(b) { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return s; }

/** a file's kept solids, checked (types, layer names, colours, data sizes) */
export function cleanSolids(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let total = 0;
  for (const s of list) {
    if (out.length >= MAX_SOLIDS) break;
    if (!s || !SOLID_TYPES.has(s.type) || !s.acis || typeof s.acis.data !== 'string' || !s.acis.data) continue;
    total += s.acis.data.length;
    if (s.acis.data.length > MAX_DATA || total > 4 * MAX_DATA) continue;
    out.push({ type: s.type, layer: String(s.layer ?? '0').slice(0, 255), color: okColor(s.color) ? s.color ?? null : null,
      acis: { format: s.acis.format === 'sab' ? 'sab' : 'sat', ...(Number.isFinite(s.acis.version) ? { version: s.acis.version } : {}), data: s.acis.data } });
  }
  return out;
}

/** every kept solid read once (cc = the ./acis/ module), kept with the doc until its solids change */
export function solidMeshes(doc, cc) {
  if (doc._solidMeshes && doc._solidMeshes.src === doc.solids) return doc._solidMeshes;
  const out = { src: doc.solids, list: [], solids: 0, faces: 0, drawn: 0, notDrawn: new Map() };
  for (const s of doc.solids || []) {
    const r = cc.readAcis(s.acis);
    cc.addNotDrawn(out.notDrawn, r.notDrawn);
    out.faces += r.faces; out.drawn += r.drawn;
    if (r.bodies.length) out.solids++;
    for (const body of r.bodies) out.list.push({ body, layer: s.layer, color: s.color });
  }
  doc._solidMeshes = out;
  return out;
}

/** the kept solids as cc-dwg model entities, written as they came */
export function solidsForDwg(doc, color) {
  return (doc.solids || []).map((s) => ({ type: s.type, layer: s.layer || '0', color: color(s.color), acis: { format: s.acis.format, ...(s.acis.version !== undefined ? { version: s.acis.version } : {}), data: s.acis.data } }));
}
