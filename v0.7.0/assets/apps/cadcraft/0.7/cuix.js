/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cuix.js — read a CUIx customization file (a ZIP of XML parts and button pictures) into My tools groups (0.5 DR.9).
 * DOM-free and async (inflating uses DecompressionStream, in browsers and Node). Read only; the file is untrusted:
 * sizes, counts and nesting are capped, no DOCTYPE or entity definitions are taken, pictures must be real PNG or BMP.
 * Written from the format as people publish it (a ZIP whose *.cui parts hold CustSection › MenuGroup › MacroGroup ›
 * MenuMacro › Macro { Name, Command, SmallImage/LargeImage Name } and MenuRoot › ToolbarRoot › Toolbar › ToolbarButton
 * › MenuItem › MacroRef MenuMacroID), never from a file out of a product install.
 * Spec gap: shortcut keys and ribbon panels are not described in those sources; they are read leniently — any
 * MenuAccelerator (under AcceleratorRoot) with a MacroRef and a key string (an AcceleratorShortcutKey / Key / Shortcut
 * child or attribute, like "CTRL+SHIFT+L"), and any RibbonPanelSource with buttons carrying a MenuMacroID attribute.
 *
 *   readCuix(bytes, { lookup, getvar }) → { groups: [{ name, tools: [{ label, macro, icon?, key? }] }], aliases: [{ alias, command }],
 *                                           missing: [command names CadCraft lacks], notes: [{ key, fills }] }
 *   unzip(bytes) → Map name → Uint8Array          parseXml(text) → { name, attrs, children, text }      bmpToPng(bytes) → PNG bytes
 */
import { parseMacro } from './macro.js';
import { normKey } from './shortcuts.js';

const LIMITS = { bytes: 32 << 20, entries: 2000, entryBytes: 16 << 20, xmlChars: 8 << 20, depth: 64, nodes: 200000, tools: 2000, groups: 200, icon: 64 << 10 };
export const CUIX_LIMITS = LIMITS;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const out = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

/** The entries of a ZIP (stored or deflated), by name. Throws Error('zip') on anything else. */
export async function unzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > LIMITS.bytes) throw new Error('too_big');
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('zip');
  const n = u16(b, e + 10), cd = u32(b, e + 16);
  if (n > LIMITS.entries) throw new Error('too_big');
  const out = new Map();
  let p = cd, total = 0;
  for (let k = 0; k < n; k++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('zip');
    const method = u16(b, p + 10), csize = u32(b, p + 20), usize = u32(b, p + 24), nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), lo = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    if (usize > LIMITS.entryBytes || (total += usize) > LIMITS.bytes) throw new Error('too_big');
    if (lo + 30 > b.length || u32(b, lo) !== 0x04034b50) throw new Error('zip');
    const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    const data = b.subarray(start, start + csize);
    if (data.length !== csize) throw new Error('zip');
    let bytesOut;
    if (method === 0) bytesOut = data.slice();
    else if (method === 8) bytesOut = await inflateRaw(data);
    else continue;   // other methods: left out
    if (bytesOut.length > LIMITS.entryBytes) throw new Error('too_big');
    out.set(name.replace(/\\/g, '/'), bytesOut);
  }
  return out;
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});

/** A small XML reader: elements, attributes, text, CDATA; comments and <?…?> skipped; a DOCTYPE refused. */
export function parseXml(text) {
  const s = String(text);
  if (s.length > LIMITS.xmlChars) throw new Error('too_big');
  if (/<!DOCTYPE/i.test(s)) throw new Error('doctype');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0, nodes = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += unesc(s.slice(i)); break; }
    if (lt > i) top.text += unesc(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); top.text += s.slice(lt + 9, e < 0 ? s.length : e); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); i = e < 0 ? s.length : e + 2; continue; }
    const gt = s.indexOf('>', lt);
    if (gt < 0) throw new Error('xml');
    let tag = s.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      if (stack.length < 2 || stack[stack.length - 1].name !== name) throw new Error('xml');
      stack.pop();
      continue;
    }
    const selfClose = tag.endsWith('/');
    if (selfClose) tag = tag.slice(0, -1);
    const m = tag.match(/^([A-Za-z_][\w.:-]*)/);
    if (!m) throw new Error('xml');
    const el = { name: m[1], attrs: {}, children: [], text: '' };
    const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = re.exec(tag.slice(m[1].length)))) el.attrs[a[1]] = unesc(a[3] ?? a[4] ?? '');
    if (++nodes > LIMITS.nodes) throw new Error('too_big');
    top.children.push(el);
    if (!selfClose) { stack.push(el); if (stack.length > LIMITS.depth) throw new Error('too_big'); }
  }
  if (stack.length !== 1) throw new Error('xml');
  return root;
}

const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const textOf = (el) => (el ? el.text.trim() : '');
function* walk(el) { yield el; for (const c of el.children) yield* walk(c); }

/** A PNG (bytes) from an uncompressed 1/4/8/24/32-bit BMP, or null. */
export async function bmpToPng(b) {
  if (!(b instanceof Uint8Array) || b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const off = u32(b, 10), hs = u32(b, 14), w = u32(b, 18) | 0, h0 = u32(b, 22) | 0, bpp = u16(b, 28), comp = u32(b, 30);
  const h = Math.abs(h0), bottomUp = h0 > 0;
  if (w <= 0 || h <= 0 || w > 256 || h > 256 || ![1, 4, 8, 24, 32].includes(bpp) || (comp !== 0 && comp !== 3)) return null;
  const ncol = bpp <= 8 ? (u32(b, 46) || (1 << bpp)) : 0, pal = 14 + hs;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  if (off + stride * h > b.length) return null;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = off + (bottomUp ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      let r, g, bl, al = 255;
      if (bpp >= 24) { const q = row + x * (bpp / 8); bl = b[q]; g = b[q + 1]; r = b[q + 2]; if (bpp === 32) al = b[q + 3] || 255; }
      else {
        const bit = x * bpp, byte = b[row + (bit >> 3)], idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        if (idx >= ncol) return null;
        const q = pal + idx * 4; bl = b[q]; g = b[q + 1]; r = b[q + 2];
      }
      const o = (y * w + x) * 4; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = al;
    }
  }
  return pngOf(rgba, w, h);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (d) => { let c = 0xffffffff; for (const x of d) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function pngOf(rgba, w, h) {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

const isPng = (d) => d && d.length > 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47;
function b64(d) { let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000)); return btoa(s); }

/** CUIx bytes → My tools groups, aliases, the commands CadCraft lacks, and notes. */
export async function readCuix(bytes, { lookup = () => true, getvar = () => '' } = {}) {
  const notes = [];
  const files = await unzip(bytes);
  const cuis = [...files.keys()].filter((n) => /\.cui$/i.test(n) || /\.xml$/i.test(n) && !/\[Content_Types\]|\.rels$/i.test(n));
  const trees = [];
  for (const n of cuis) {
    try { trees.push(parseXml(new TextDecoder().decode(files.get(n)))); } catch (err) { notes.push({ key: 'mytools.note.part', fills: { part: n.slice(0, 80) } }); }
  }
  if (!trees.some((t) => [...walk(t)].some((e) => e.name === 'CustSection' || e.name === 'MenuGroup'))) throw new Error('not_cuix');
  // pictures by file name (any folder, any case)
  const pics = new Map();
  for (const [n, d] of files) if (/\.(png|bmp)$/i.test(n)) pics.set(n.split('/').pop().toLowerCase(), d);
  const iconFor = async (name) => {
    if (!name) return null;
    const d = pics.get(String(name).toLowerCase()) || pics.get(String(name).toLowerCase() + '.png') || pics.get(String(name).toLowerCase() + '.bmp');
    if (!d) return null;
    const png = isPng(d) ? d : await bmpToPng(d);
    if (!png || png.length > LIMITS.icon) return null;
    return 'data:image/png;base64,' + b64(png);
  };
  // macros by UID
  const macros = new Map();
  for (const t of trees) for (const e of walk(t)) {
    if (e.name !== 'MenuMacro') continue;
    const m = kid(e, 'Macro');
    if (!m || !e.attrs.UID) continue;
    macros.set(e.attrs.UID, { name: textOf(kid(m, 'Name')) || e.attrs.UID, command: textOf(kid(m, 'Command')), small: kid(m, 'SmallImage')?.attrs.Name || null, large: kid(m, 'LargeImage')?.attrs.Name || null });
  }
  const missing = new Set();
  const groups = [];
  let toolCount = 0;
  const toolOf = async (label, id) => {
    const m = macros.get(id);
    if (!m) { notes.push({ key: 'mytools.note.no_macro', fills: { id: String(id).slice(0, 60) } }); return null; }
    if (++toolCount > LIMITS.tools) return null;
    const p = parseMacro(m.command, { getvar });
    for (const c of p.commands) if (!lookup(c)) missing.add(c);
    for (const n of p.notes) notes.push(n);
    const icon = await iconFor(m.small) || await iconFor(m.large);
    return { label: String(label || m.name).slice(0, 80), macro: m.command.slice(0, 4000), ...(icon ? { icon } : {}) };
  };
  for (const t of trees) for (const e of walk(t)) {
    if (groups.length >= LIMITS.groups) break;
    if (e.name === 'Toolbar') {
      const tools = [];
      for (const bt of kids(e, 'ToolbarButton')) {
        if (bt.attrs.IsSeparator === 'true') continue;
        const ref = kid(kid(bt, 'MenuItem'), 'MacroRef');
        const tool = ref ? await toolOf(textOf(kid(bt, 'Name')), ref.attrs.MenuMacroID) : null;
        if (tool) tools.push(tool);
      }
      if (tools.length) groups.push({ name: (textOf(kid(e, 'Name')) || textOf(kid(e, 'Alias')) || 'Toolbar').slice(0, 60), tools });
    } else if (e.name === 'RibbonPanelSource') {
      const tools = [];
      for (const bt of walk(e)) {
        const id = bt.attrs.MenuMacroID || kid(bt, 'MacroRef')?.attrs.MenuMacroID;
        if (!id || bt === e) continue;
        const tool = await toolOf(bt.attrs.Text || textOf(kid(bt, 'Name')), id);
        if (tool) tools.push(tool);
      }
      if (tools.length) groups.push({ name: (e.attrs.Text || textOf(kid(e, 'Name')) || e.attrs.UID || 'Panel').slice(0, 60), tools });
    }
  }
  // shortcut keys: a group of their own, each tool carrying its key
  const keyed = [];
  for (const t of trees) for (const e of walk(t)) {
    if (e.name !== 'MenuAccelerator') continue;
    const ref = kid(kid(e, 'MenuItem'), 'MacroRef') || [...walk(e)].find((x) => x.name === 'MacroRef');
    const keyText = textOf(kid(e, 'AcceleratorShortcutKey')) || textOf(kid(e, 'Key')) || textOf(kid(e, 'Shortcut')) || e.attrs.Key || e.attrs.Shortcut || '';
    const key = normKey(keyText.replace(/\s+/g, ''));
    if (!ref || !key) { notes.push({ key: 'mytools.note.key', fills: { key: keyText.slice(0, 40) || '?' } }); continue; }
    const tool = await toolOf(textOf(kid(e, 'Name')), ref.attrs.MenuMacroID);
    if (tool) keyed.push({ ...tool, key });
  }
  if (keyed.length) groups.push({ name: 'Shortcut keys', tools: keyed, shortcuts: true });   // i18n-ignore (renamed by the page through t())
  // command aliases, when the package carries a PGP file (ALIAS, *COMMAND)
  const aliases = [];
  for (const [n, d] of files) {
    if (!/\.pgp$/i.test(n)) continue;
    for (const line of new TextDecoder().decode(d).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]{1,31})\s*,\s*\*\s*([A-Za-z0-9_.-]{1,64})\s*$/);
      if (m) { aliases.push({ alias: m[1].toUpperCase(), command: m[2].toUpperCase() }); if (!lookup(m[2])) missing.add(m[2].toUpperCase()); }
    }
  }
  return { groups, aliases, missing: [...missing].sort(), notes };
}
