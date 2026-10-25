/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ole.js — OLE objects in drawings (0.7 D7.23). No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 * A drawing keeps an embedded object (a picture from a paint program, a spreadsheet, a document …) as an OLE2FRAME: the
 * object's own OLE2 data, which is a compound file (MS-CFB). The file also usually holds a cached picture of how the object
 * looked, which is what can be shown without the program that made it. This module reads the compound file and finds that
 * picture; CadCraft never runs, edits or inserts OLE objects.
 *
 *   readCfb(bytes)                   → Map(path → Uint8Array) of the streams, or null (not a compound file; cut off)
 *   findCfb(bytes)                   → the compound file inside a blob (it may follow a small header of the drawing program's)
 *   olePreview(bytes)                → { mime, bytes, w, h, how } | null: the object's own picture. Looked for, in order: a
 *                                      PNG / JPEG / GIF / BMP file inside any stream (what a packaged picture is), and the
 *                                      presentation streams "\x02OlePres000…" when they hold a device-independent bitmap
 *                                      (clipboard format 8) — it is wrapped as a BMP file. A metafile (WMF / EMF) is not drawn.
 *   oleTitle(bytes)                  → the object's type name from its "\x01CompObj" stream ("Bitmap Image"), or ''
 *
 * Sizes are checked before anything is read (a drawing is untrusted input): at most 64 MB of data, 4096 directory entries,
 * a chain longer than the file is a loop.
 */
import { jpegInfo } from './pictures.js';

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff;
const MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 4096, MAX_PICTURE = 64e6;

/** Where the compound file starts in a blob, or -1. */
export function findCfb(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const lim = Math.min(b.length - 8, 4096);
  for (let i = 0; i <= lim; i++) {
    let k = 0;
    while (k < 8 && b[i + k] === MAGIC[k]) k++;
    if (k === 8) return i;
  }
  return -1;
}

export function readCfb(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 512 || b.length > MAX_BYTES) return null;
  const at = findCfb(b);
  if (at < 0) return null;
  if (at) b = b.subarray(at);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const major = dv.getUint16(26, true), sectorShift = dv.getUint16(30, true), miniShift = dv.getUint16(32, true);
  if (![3, 4].includes(major) || sectorShift !== (major === 3 ? 9 : 12) || miniShift !== 6) return null;
  const S = 1 << sectorShift, M = 1 << miniShift;
  const nFat = dv.getUint32(44, true), dirStart = dv.getUint32(48, true), cutoff = dv.getUint32(56, true);
  const miniStart = dv.getUint32(60, true), nMiniFat = dv.getUint32(64, true), difStart = dv.getUint32(68, true), nDif = dv.getUint32(72, true);
  const nSectors = Math.floor((b.length - S) / S) + 1;
  const sectorAt = (n) => (n + 1) * S;
  const readSector = (n) => (n >= 0 && n < nSectors && sectorAt(n) + S <= b.length ? b.subarray(sectorAt(n), sectorAt(n) + S) : null);
  // the FAT: sector numbers from the header's 109 slots, then the DIFAT chain
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) { const n = dv.getUint32(76 + 4 * i, true); if (n !== FREESECT) fatSectors.push(n); }
  let d = difStart, guard = 0;
  while (d !== ENDOFCHAIN && d !== FREESECT && fatSectors.length < nFat && guard++ <= nDif) {
    const s = readSector(d);
    if (!s) return null;
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < S / 4 - 1 && fatSectors.length < nFat; i++) { const n = sv.getUint32(4 * i, true); if (n !== FREESECT) fatSectors.push(n); }
    d = sv.getUint32(S - 4, true);
  }
  const fat = [];
  for (const n of fatSectors) {
    const s = readSector(n);
    if (!s) return null;
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < S / 4; i++) fat.push(sv.getUint32(4 * i, true));
  }
  const chain = (start, table, limit) => {
    const out = [];
    let n = start;
    while (n !== ENDOFCHAIN && n !== FREESECT) {
      if (n >= table.length || out.length > limit) return null;   // outside the table, or a loop
      out.push(n);
      n = table[n];
    }
    return out;
  };
  const bigStream = (start, size) => {
    const ch = chain(start, fat, nSectors);
    if (!ch) return null;
    const out = new Uint8Array(ch.length * S);
    for (let i = 0; i < ch.length; i++) { const s = readSector(ch[i]); if (!s) return null; out.set(s, i * S); }
    return out.subarray(0, Math.min(size, out.length));
  };
  const dirBytes = bigStream(dirStart, nSectors * S);
  if (!dirBytes) return null;
  const entries = [];
  const dd = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  for (let o = 0; o + 128 <= dirBytes.length && entries.length < MAX_ENTRIES; o += 128) {
    const nlen = dd.getUint16(o + 64, true);
    let name = '';
    for (let i = 0; i + 2 <= Math.max(0, nlen - 2); i += 2) name += String.fromCharCode(dd.getUint16(o + i, true));
    entries.push({ name, type: dirBytes[o + 66], left: dd.getUint32(o + 68, true), right: dd.getUint32(o + 72, true), child: dd.getUint32(o + 76, true),
      start: dd.getUint32(o + 116, true), size: major === 3 ? dd.getUint32(o + 120, true) : Number(dd.getBigUint64(o + 120, true)) });
  }
  if (!entries.length || entries[0].type !== 5) return null;
  // the mini stream (small streams) lives in the root entry's stream
  let mini = null, miniFat = null;
  const loadMini = () => {
    if (mini) return true;
    const root = bigStream(entries[0].start, entries[0].size);
    const mf = nMiniFat ? bigStream(miniStart, nMiniFat * S) : new Uint8Array(0);
    if (!root || !mf) return false;
    mini = root;
    miniFat = [];
    const mv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mv.getUint32(i, true));
    return true;
  };
  const streamOf = (e) => {
    if (e.size > MAX_BYTES) return null;
    if (e.size >= cutoff) return bigStream(e.start, e.size);
    if (!loadMini()) return null;
    const ch = chain(e.start, miniFat, Math.ceil(mini.length / M));
    if (!ch) return null;
    const out = new Uint8Array(ch.length * M);
    for (let i = 0; i < ch.length; i++) { if ((ch[i] + 1) * M > mini.length) return null; out.set(mini.subarray(ch[i] * M, (ch[i] + 1) * M), i * M); }
    return out.subarray(0, e.size);
  };
  // walk the red-black tree of each storage (any order is fine: names are joined with "/")
  const streams = new Map();
  const seen = new Set();
  const walk = (id, prefix) => {
    if (id === FREESECT || id >= entries.length || seen.has(id)) return;
    seen.add(id);
    const e = entries[id];
    walk(e.left, prefix); walk(e.right, prefix);
    const path = prefix + e.name;
    if (e.type === 2) { const s = streamOf(e); if (s) streams.set(path, s); } else if (e.type === 1) walk(e.child, path + '/');
  };
  walk(entries[0].child, '');
  return streams;
}

const sig = (b, o, ...v) => v.every((x, i) => b[o + i] === x);
/** The first picture file (PNG, JPEG, GIF, BMP) found inside a stream's bytes, or null. */
function pictureIn(b) {
  const lim = Math.min(b.length - 24, 4096);
  for (let o = 0; o <= lim; o++) {
    if (sig(b, o, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
      const dv = new DataView(b.buffer, b.byteOffset + o, b.length - o);
      const w = dv.getUint32(16), h = dv.getUint32(20);
      return w > 0 && h > 0 && w * h <= MAX_PICTURE ? { mime: 'image/png', bytes: b.subarray(o), w, h } : null;
    }
    if (sig(b, o, 0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', bytes: b.subarray(o), w: 0, h: 0 };
    if (sig(b, o, 0x47, 0x49, 0x46, 0x38) && (b[o + 4] === 0x37 || b[o + 4] === 0x39) && b[o + 5] === 0x61) {
      const dv = new DataView(b.buffer, b.byteOffset + o, b.length - o);
      return { mime: 'image/gif', bytes: b.subarray(o), w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    }
    if (sig(b, o, 0x42, 0x4d) && o + 26 <= b.length) {
      const dv = new DataView(b.buffer, b.byteOffset + o, b.length - o);
      const size = dv.getUint32(2, true), off = dv.getUint32(10, true), hdr = dv.getUint32(14, true);
      if (hdr >= 12 && hdr <= 124 && off >= 14 + hdr && size > off && o + size <= b.length) {
        const w = hdr === 12 ? dv.getUint16(18, true) : dv.getInt32(18, true), h = hdr === 12 ? dv.getUint16(20, true) : Math.abs(dv.getInt32(22, true));
        if (w > 0 && h > 0) return { mime: 'image/bmp', bytes: b.subarray(o, o + size), w, h };
      }
    }
  }
  return null;
}

/** A device-independent bitmap (a BITMAPINFOHEADER and its pixels, no file header) → a BMP file, with its size. */
export function dibToBmp(dib) {
  if (dib.length < 40) return null;
  const dv = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const hdr = dv.getUint32(0, true);
  if (hdr < 40 || hdr > 124) return null;
  const w = dv.getInt32(4, true), h = Math.abs(dv.getInt32(8, true)), bits = dv.getUint16(14, true), comp = dv.getUint32(16, true);
  if (!(w > 0 && h > 0) || w * h > MAX_PICTURE || ![1, 4, 8, 16, 24, 32].includes(bits)) return null;
  let colors = dv.getUint32(32, true);
  if (!colors && bits <= 8) colors = 1 << bits;
  const masks = comp === 3 ? 12 : 0;   // BI_BITFIELDS: three masks follow the header
  const off = 14 + hdr + masks + colors * 4;
  if (off > 14 + dib.length) return null;
  const out = new Uint8Array(14 + dib.length);
  const ov = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  ov.setUint32(2, out.length, true); ov.setUint32(10, off, true);
  out.set(dib, 14);
  return { mime: 'image/bmp', bytes: out, w, h };
}

/** From a presentation stream ("\x02OlePres000"): the bitmap, when the object cached one (clipboard format 8). */
function presentationBitmap(s) {
  if (s.length < 40) return null;
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  let p = 0;
  const marker = dv.getUint32(p, true); p += 4;
  let fmt;
  if (marker === 0xffffffff) { fmt = dv.getUint32(p, true); p += 4; } else return null;   // a named format: not a bitmap
  if (fmt !== 8) return null;                                                              // 3 / 14: metafiles, not drawn
  const dev = dv.getUint32(p, true); p += 4;
  if (dev > 4) p += dev - 4;                                                                // a target device description
  p += 4 * 4 + 4 * 2;                                                                       // aspect, lindex, advf, reserved; width, height
  if (p + 4 > s.length) return null;
  const size = dv.getUint32(p, true); p += 4;
  if (!(size > 0) || p + size > s.length) return null;
  return dibToBmp(s.subarray(p, p + size));
}

export function olePreview(bytes) {
  const streams = readCfb(bytes);
  if (!streams) return null;
  const names = [...streams.keys()];
  for (const n of names.filter((x) => /OlePres\d*$/i.test(x)).sort()) {
    const bmp = presentationBitmap(streams.get(n));
    if (bmp) return { ...bmp, how: n };
  }
  for (const n of names.sort((a, b) => (/OlePres/i.test(a) ? 1 : 0) - (/OlePres/i.test(b) ? 1 : 0))) {
    if (/OlePres/i.test(n)) continue;
    const pic = pictureIn(streams.get(n));
    if (pic) return { ...pic, how: n };
  }
  return null;
}

export function oleTitle(bytes) {
  const streams = readCfb(bytes);
  const s = streams && [...streams].find(([n]) => /CompObj$/i.test(n))?.[1];
  if (!s || s.length < 32) return '';
  // CompObj: 28 bytes of header, then length-prefixed strings (user type first); ANSI text
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const len = dv.getUint32(28, true);
  if (len < 1 || len > 256 || 32 + len > s.length) return '';
  return new TextDecoder('windows-1252').decode(s.subarray(32, 32 + len)).replace(/\0.*$/s, '').trim();
}

// ---------------------------------------------------------------------------------------------- the object in the drawing

const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 3) {
    const n = (u8[i] << 16) | ((u8[i + 1] ?? 0) << 8) | (u8[i + 2] ?? 0);
    s += b64chars[n >> 18 & 63] + b64chars[n >> 12 & 63] + (i + 1 < u8.length ? b64chars[n >> 6 & 63] : '=') + (i + 2 < u8.length ? b64chars[n & 63] : '=');
  }
  return s;
}
export function fromB64(s) {
  const clean = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? b64chars.indexOf(clean[i + k]) : 0));
    const v = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    if (o < out.length) out[o++] = v >> 16 & 255;
    if (o < out.length) out[o++] = v >> 8 & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}

/** The OLE frame of a block: the closed poly carrying `ole`, or null. */
export const oleFrame = (block) => block?.entities?.find((e) => e.type === 'poly' && e.ole) || null;

/**
 * An OLE object as the drawing holds it: an unnamed block `name` (frame + label) and a reference to it. The frame carries the
 * object's data (`ole`, base64) and, when the object cached a picture, where that picture goes (`pic`, like a picture block:
 * it is drawn the same way and the label shows only until it is). `p1` / `p2` are the frame's corners as a DXF gives them
 * (upper left, lower right). → { block, insert, picture (the preview as doc.pictures wants it) | null }
 */
export function oleParts(o, name) {
  const x0 = Math.min(o.p1.x, o.p2.x), x1 = Math.max(o.p1.x, o.p2.x), y0 = Math.min(o.p1.y, o.p2.y), y1 = Math.max(o.p1.y, o.p2.y);
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
  const data = o.data instanceof Uint8Array ? o.data : new Uint8Array(o.data || []);
  const title = oleTitle(data) || String(o.title || '').trim() || 'OLE';
  const prev = olePreview(data);
  const key = prev ? 'ole-' + name.replace(/[^A-Za-z0-9]/g, '').toLowerCase() + '.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' }[prev.mime] || 'bin') : null;   // lower case: pictures are looked up by pictures.js pictureKey
  let pw = prev?.w || 0, ph = prev?.h || 0;
  if (prev && prev.mime === 'image/jpeg') { const j = jpegInfo(prev.bytes); pw = j?.w || 0; ph = j?.h || 0; }
  const usable = prev && pw > 0 && ph > 0;
  const th = Math.max(1e-9, Math.min(h / 6, w / Math.max(6, title.length + 6)));
  const frame = { type: 'poly', layer: '0', color: 0, closed: true, pts: [{ x: x0, y: y0, b: 0 }, { x: x1, y: y0, b: 0 }, { x: x1, y: y1, b: 0 }, { x: x0, y: y1, b: 0 }],
    ole: { data: toB64(data), title, kind: o.kind | 0, tile: o.tile | 0, ...(o.name ? { name: String(o.name) } : {}) },
    ...(usable ? { pic: { file: key, x: x0, y: y0, ux: w / pw, uy: 0, vx: 0, vy: h / ph, w: pw, h: ph } } : {}) };
  const label = { type: 'text', layer: '0', color: 0, x: x0 + th * 0.4, y: y0 + th * 0.5, h: th, rot: 0, s: usable ? title : title + ' (OLE)', ha: 'left', va: 'baseline', ...(usable ? { picName: true } : {}) };
  return {
    block: { name, base: { x: 0, y: 0 }, entities: [frame, label] },
    insert: { type: 'insert', block: name, x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
    picture: usable ? { key, name: key, bytes: prev.bytes, mime: prev.mime, w: pw, h: ph } : null,
  };
}

/** What a DXF's OLE2FRAME needs from a reference to an OLE block: corners (upper left, lower right) in world coordinates, the data. */
export function oleForDxf(ref, block, mApply, insertMatrix) {
  const fr = oleFrame(block);
  if (!fr) return null;
  const m = insertMatrix(ref, block);
  const ps = fr.pts.map((p) => mApply(m, p));
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  return { p1: { x: Math.min(...xs), y: Math.max(...ys) }, p2: { x: Math.max(...xs), y: Math.min(...ys) }, data: fromB64(fr.ole.data), title: fr.ole.title || '', kind: fr.ole.kind || 2, tile: fr.ole.tile || 0 };
}
