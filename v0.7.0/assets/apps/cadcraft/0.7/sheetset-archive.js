/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sheetset-archive.js — archive a sheet set as one zip (0.4 part 2, Z.7, as eTransmit / Archive do): the set file, every
 * drawing it uses, and what those drawings link to — linked drawings (xrefs, and theirs in turn) and pictures (IMAGE) —
 * found in the set's folder, with a transmittal note listing every file and what could not be found. DOM-free.
 *
 *   archiveSet(set, folder, { setFile, readModel }) → { bytes (the zip), files: [path], missing: [{ from, ref }], notes }
 *   linksOf(model) → { xrefs: [path as written], images: [path as written] }   (a cc-dwg / dxf-model.js drawing model)
 *   resolveRef(ref, fromFile, paths) → the folder path it means, or null: the path relative to the drawing that names it
 *     ("..\X-Refs\Site.dwg"), else the same file name anywhere in the folder (an absolute path from another computer)
 *   zip(entries [{ name, data }]) → Uint8Array — stored or deflated (CompressionStream), UTF-8 names, CRC-32
 *   unzip(bytes) → [{ name, data }] (stored and deflated; for tests)
 */

import { allSheets, cleanPath } from './sheetset.js';
import { t } from './i18n.js';

// ---------------------------------------------------------------------------- what a drawing links to

export function linksOf(model) {
  const xrefs = [], images = [];
  for (const b of model?.blocks || []) if (b && (b.flags & 4) && b.xrefPath) xrefs.push(String(b.xrefPath));
  for (const o of model?.objects || []) if (o && o.type === 'IMAGEDEF' && o.fileName) images.push(String(o.fileName));
  return { xrefs: [...new Set(xrefs)], images: [...new Set(images)] };
}

export function resolveRef(ref, fromFile, paths) {
  const raw = String(ref || '').replace(/\\/g, '/').trim();
  if (!raw) return null;
  const have = new Set(paths);
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')).split('/') : [];
  if (!/^([a-z]:)?\//i.test(raw) && !/^[a-z]+:\/\//i.test(raw)) {   // relative: from the drawing's own folder
    const parts = [...dir];
    let above = false;   // "..": past the set's folder
    for (const p of raw.split('/')) {
      if (p === '' || p === '.') continue;
      if (p !== '..') parts.push(p);
      else if (parts.length) parts.pop();
      else { above = true; break; }
    }
    if (!above && have.has(parts.join('/'))) return parts.join('/');
  }
  const name = raw.split('/').pop().toLowerCase();
  const same = paths.filter((p) => p.split('/').pop().toLowerCase() === name);
  if (!same.length) return null;
  // nearest to the drawing that names it: the longest shared folder prefix
  const score = (p) => { const a = p.split('/').slice(0, -1); let k = 0; while (k < a.length && k < dir.length && a[k] === dir[k]) k++; return k; };
  return same.sort((a, b) => score(b) - score(a) || a.length - b.length)[0];
}

// ---------------------------------------------------------------------------- the archive

export async function archiveSet(set, folder, { setFile = 'set.ccsheets', readModel, setText } = {}) {
  const paths = folder.list ? await folder.list() : [];
  const entries = new Map();   // path → bytes
  const missing = [], notes = [];
  const queue = [...new Set(allSheets(set).map((x) => x.sheet.file))].map((p) => ({ p, from: setFile, ref: p }));   // what to pack, and who named it
  if (set.template?.file) queue.push({ p: set.template.file, from: setFile, ref: set.template.file });
  const seen = new Set();
  while (queue.length) {
    const { p, from, ref: named } = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    let bytes;
    try { bytes = await folder.read(p); } catch { missing.push({ from, ref: named }); continue; }
    entries.set(p, bytes);
    if (!/\.(dwg|dxf)$/i.test(p) || !readModel) continue;
    let model;
    try { model = await readModel(bytes, p); } catch (err) { notes.push(t('sheetset.archive.unread', { file: p, why: String(err.message || err) })); continue; }
    const { xrefs, images } = linksOf(model);
    for (const ref of [...xrefs, ...images]) {
      const hit = resolveRef(ref, p, paths);
      if (!hit) { missing.push({ from: p, ref }); continue; }
      if (xrefs.includes(ref)) queue.push({ p: hit, from: p, ref });   // a linked drawing's own links come along too
      else if (!entries.has(hit)) { try { entries.set(hit, await folder.read(hit)); } catch { missing.push({ from: p, ref }); } }
    }
  }
  const text = setText ?? null;
  const list = [setFile, ...[...entries.keys()].sort()];
  const note = [
    t('sheetset.archive.head', { name: set.name, date: new Date().toISOString().slice(0, 10) }), '',
    t('sheetset.archive.files', { n: list.length }), ...list.map((f) => '  ' + f), '',
    ...(missing.length ? [t('sheetset.archive.missing', { n: missing.length }), ...missing.map((m) => '  ' + t('sheetset.archive.missing.row', { ref: m.ref, from: m.from }))] : [t('sheetset.archive.complete')]),
    '',
  ].join('\r\n');
  const zipEntries = [
    ...(text !== null ? [{ name: setFile, data: new TextEncoder().encode(text) }] : []),
    ...[...entries].map(([name, data]) => ({ name: cleanPath(name) || name, data })),
    { name: t('sheetset.archive.notefile'), data: new TextEncoder().encode(note) },
  ];
  return { bytes: await zip(zipEntries), files: list, missing, notes };
}

// ---------------------------------------------------------------------------- zip (PKWARE APPNOTE 6.3: local headers, central directory)

const CRC = (() => { const tb = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; } return tb; })();
export function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    return out.length < bytes.length ? out : null;
  } catch { return null; }
}

export async function zip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const crc = crc32(data);
    const packed = await deflateRaw(data);
    const body = packed || data, method = packed ? 8 : 0;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, body.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, body);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of all) { out.set(x, at); at += x.length; }
  return out;
}

export async function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
  let p = 0;
  while (p + 30 <= bytes.length && v.getUint32(p, true) === 0x04034b50) {
    const method = v.getUint16(p + 8, true), size = v.getUint32(p + 18, true), n = v.getUint16(p + 26, true), x = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + n));
    const body = bytes.subarray(p + 30 + n + x, p + 30 + n + x + size);
    const data = method === 8 ? new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : body.slice();
    out.push({ name, data, crc: v.getUint32(p + 14, true) });
    p += 30 + n + x + size;
  }
  return out;
}
