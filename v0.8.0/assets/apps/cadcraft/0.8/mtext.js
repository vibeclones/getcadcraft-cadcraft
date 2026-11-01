/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mtext.js — multi-line text with its inline format codes kept (0.7 D7.17). No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 * A text object read from a file used to lose its codes (fonts, colours, stacked fractions …) and be written back plain.
 * Now an object that has real formatting also keeps `mt`, the MTEXT string as the file had it, while `s` stays the plain
 * text (every consumer: find, snap, extents, R12 DXF). `mt` is trusted only while it still says what `s` says
 * (`richOf`): any code that changes `s` without going through `editPlain` simply drops the formatting, as before.
 *
 *   hasFormatting(raw)        any code or stack besides a leading \\Q (the oblique angle CadCraft writes as a field) and \\P
 *   plainOf(raw)              the plain text, exactly (no trim): "\\P" → newline, "\\S1/2;" → "1/2", "\\~" → a space
 *   parse(raw)                { segs: [{ text, st, stack? } | { para: true }], plain }, st = the style the segment is in
 *   richOf(e)                 the parse of e.mt when it still matches e.s, else null (cached per object)
 *   editPlain(raw, old, next) the new MTEXT string after the plain text changed old → next: codes stay, the change lands in
 *                             the run it touches (typed text takes the style of the character before it)
 *
 * A style: { color: null | { aci } | { rgb: '#rrggbb' }, b, i, u, o, k (booleans), h: null | { rel } | { abs }, w, obl, tr, font }.
 * The \\c true colour is read as the integer 0xBBGGRR (red in the low byte): not yet checked against a file from AutoCAD.
 */
import { unescapeText } from './dxf-decode.js';

const CODE_RE = /^\\[fFcCHhQqTtWwAapN][^;]*;/;
const SIMPLE = new Set(['L', 'l', 'O', 'o', 'K', 'k', 'X']);

/** Raw MTEXT string → tokens [{ kind: 'text' | 'para' | 'esc' | 'code' | 'stack' | 'open' | 'close', src, plain }]. */
export function tokenize(raw) {
  const s = String(raw ?? '');
  const out = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { out.push({ kind: 'text', src: buf, plain: unescapeText(buf).replace(/\^I|\t/g, ' ') }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '{') { flush(); out.push({ kind: 'open', src: '{', plain: '' }); i++; continue; }
    if (c === '}') { flush(); out.push({ kind: 'close', src: '}', plain: '' }); i++; continue; }
    if (c !== '\\' || i + 1 >= s.length) { buf += c; i++; continue; }
    const n = s[i + 1], rest = s.slice(i);
    if (n === 'P') { flush(); out.push({ kind: 'para', src: '\\P', plain: '\n' }); i += 2; continue; }
    if (n === '\\' || n === '{' || n === '}') { flush(); out.push({ kind: 'esc', src: '\\' + n, plain: n }); i += 2; continue; }
    if (n === '~') { flush(); out.push({ kind: 'esc', src: '\\~', plain: ' ' }); i += 2; continue; }
    if (n === 'U' && /^\\U\+[0-9A-Fa-f]{4}/.test(rest)) { flush(); const src = rest.slice(0, 7); out.push({ kind: 'esc', src, plain: unescapeText(src) }); i += 7; continue; }
    if (n === 'M' && /^\\M\+[0-9A-Fa-f]{5}/.test(rest)) { flush(); const src = rest.slice(0, 8); out.push({ kind: 'esc', src, plain: unescapeText(src) }); i += 8; continue; }
    if (n === 'S') {
      const end = rest.indexOf(';');
      const m = end > 0 ? /^\\S([^;^/#]*)([\^/#])([^;]*);/.exec(rest) : null;
      if (m) { flush(); out.push({ kind: 'stack', src: m[0], plain: m[1] + '/' + m[3], num: m[1], den: m[3], sep: m[2] }); i += m[0].length; continue; }
    }
    const cm = CODE_RE.exec(rest);
    if (cm) { flush(); out.push({ kind: 'code', src: cm[0], plain: '' }); i += cm[0].length; continue; }
    if (SIMPLE.has(n)) { flush(); out.push({ kind: 'code', src: '\\' + n, plain: '' }); i += 2; continue; }
    buf += c; i++;   // an unknown backslash stays a character
  }
  flush();
  return out;
}

const plainJoin = (toks) => toks.map((t) => t.plain).join('');
export const plainOf = (raw) => plainJoin(tokenize(raw));

/** A leading \\Q<angle>; is the oblique field, not formatting. */
const LEAD_Q = /^\\Q[-\d.]+;/;
export function hasFormatting(raw) {
  const toks = tokenize(String(raw ?? '').replace(LEAD_Q, ''));
  return toks.some((t) => t.kind === 'code' || t.kind === 'stack');
}

const BASE = Object.freeze({ color: null, b: false, i: false, u: false, o: false, k: false, h: null, w: null, obl: null, tr: null, font: null });
function applyCode(st, src) {
  const k = src[1], v = src.slice(2, -1);
  const next = { ...st };
  switch (k) {
    case 'C': { const n = parseInt(v, 10); next.color = n > 0 && n < 256 ? { aci: n } : null; break; }
    case 'c': {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 0xffffff) { const r = n & 255, g = (n >> 8) & 255, b = (n >> 16) & 255; next.color = { rgb: '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('') }; }
      break;
    }
    case 'F': case 'f': {
      const parts = v.split('|');
      next.font = parts[0] || null;
      for (const p of parts.slice(1)) { if (p === 'b1') next.b = true; else if (p === 'b0') next.b = false; else if (p === 'i1') next.i = true; else if (p === 'i0') next.i = false; }
      break;
    }
    case 'H': case 'h': { const x = /x$/i.test(v), n = parseFloat(v); next.h = Number.isFinite(n) && n > 0 ? (x ? { rel: n } : { abs: n }) : null; break; }
    case 'W': case 'w': { const n = parseFloat(v); next.w = Number.isFinite(n) && n > 0 ? n : null; break; }
    case 'Q': case 'q': { const n = parseFloat(v); next.obl = Number.isFinite(n) ? n : null; break; }
    case 'T': case 't': { const n = parseFloat(v); next.tr = Number.isFinite(n) && n > 0 ? n : null; break; }
    default: break;
  }
  return next;
}
const FLAG = { L: ['u', true], l: ['u', false], O: ['o', true], o: ['o', false], K: ['k', true], k: ['k', false] };

/** Parse into styled segments. A style object is shared by consecutive segments in the same state. */
export function parse(raw) {
  const toks = tokenize(raw);
  const segs = [];
  let st = BASE;
  const stack = [];
  for (const t of toks) {
    if (t.kind === 'open') { stack.push(st); continue; }
    if (t.kind === 'close') { if (stack.length) st = stack.pop(); continue; }
    if (t.kind === 'code') {
      if (t.src.length === 2) { const f = FLAG[t.src[1]]; if (f) st = { ...st, [f[0]]: f[1] }; } else st = applyCode(st, t.src);
      continue;
    }
    if (t.kind === 'para') { segs.push({ para: true, text: '\n', st }); continue; }
    if (!t.plain) continue;
    const last = segs[segs.length - 1];
    if (t.kind === 'stack') segs.push({ text: t.plain, st, stack: { num: t.num, den: t.den, sep: t.sep } });
    else if (last && !last.para && !last.stack && last.st === st) last.text += t.plain;
    else segs.push({ text: t.plain, st });
  }
  return { segs, plain: segs.map((g) => g.text).join('') };
}

const cache = new WeakMap();
/** The parse of e.mt while it still matches e.s, else null. */
export function richOf(e) {
  if (!e || typeof e.mt !== 'string' || !e.mt) return null;
  if (cache.has(e)) return cache.get(e);
  let r = null;
  try { const p = parse(e.mt); if (p.plain === String(e.s)) r = p; } catch { r = null; }
  cache.set(e, r);
  return r;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
/** Where two strings differ, as hunks { a0, a1, b0, b1 }: a.slice(a0, a1) became b.slice(b0, b1). */
export function hunks(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let q = 0;
  while (q < max - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const la = a.length - p - q, lb = b.length - p - q;
  if (la === 0 && lb === 0) return [];
  if (!la || !lb || la * lb > 4e6) return [{ a0: p, a1: p + la, b0: p, b1: p + lb }];
  const w = lb + 1, t = new Uint32Array((la + 1) * w);   // LCS lengths of the middle parts
  for (let i = la - 1; i >= 0; i--) for (let j = lb - 1; j >= 0; j--) t[i * w + j] = a[p + i] === b[p + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const out = [];
  let i = 0, j = 0, open = null;
  const close = () => { if (open) { open.a1 = p + i; open.b1 = p + j; out.push(open); open = null; } };
  while (i < la || j < lb) {
    if (i < la && j < lb && a[p + i] === b[p + j]) { close(); i++; j++; continue; }
    if (!open) open = { a0: p + i, b0: p + j };
    if (j < lb && (i >= la || t[i * w + j + 1] >= t[(i + 1) * w + j])) j++; else i++;
  }
  close();
  return out;
}

/**
 * The MTEXT string after the plain text changed from `oldPlain` to `newPlain` (what an editor box returns). Format codes and
 * groups stay where they are; each place that changed is edited on its own, the removed characters leave their runs (a
 * stacked fraction that is touched becomes plain text), the new characters are put in the run of the character before.
 * null when `raw` is not what `oldPlain` says it is.
 */
export function editPlain(raw, oldPlain, newPlain) {
  let toks = tokenize(raw);
  if (plainJoin(toks) !== oldPlain) return null;
  if (oldPlain === newPlain) return raw;
  for (const h of hunks(oldPlain, newPlain).reverse()) toks = applyHunk(toks, h.a0, h.a1, newPlain.slice(h.b0, h.b1));
  return toks.map((t) => t.src).join('');
}

function applyHunk(toks, del0, del1, ins) {
  const out = [];
  let at = 0, inserted = !ins;
  const emitIns = () => { if (inserted) return; inserted = true; out.push({ kind: 'text', src: escapeNew(ins), plain: ins }); };
  for (const t of toks) {
    const a = at, b = at + t.plain.length;
    at = b;
    if (!t.plain.length) { out.push(t); continue; }   // codes and groups never go
    if (!inserted && del0 === del1 && del0 === 0 && a === 0) { emitIns(); out.push(t); continue; }   // typed at the very start: the first run's style
    const overlaps = a < del1 && b > del0;
    if (!overlaps) { out.push(t); if (b === del0 && del0 === del1 && !inserted) emitIns(); continue; }   // typed after a character: that character's run
    if (a >= del0 && b <= del1) { emitIns(); continue; }   // the whole token goes; what replaces it takes its place (after the codes before it)
    const keepL = t.plain.slice(0, Math.max(0, del0 - a)), keepR = t.plain.slice(Math.max(0, del1 - a));
    if (t.kind === 'para') continue;
    let text = keepL;
    if (!inserted && del0 >= a) { text += ins; inserted = true; }
    text += keepR;
    if (text) out.push({ kind: 'text', src: escapeNew(text), plain: text });
  }
  if (!inserted) emitIns();
  return out;
}
function escapeNew(text) {
  return text.split('\n').map(esc).join('\\P');
}

/** The style `st` as the h multiplier of the entity's height h (abs sizes are in drawing units). */
export const heightFactor = (st, h) => (st?.h ? (st.h.rel ?? (h > 0 ? st.h.abs / h : 1)) : 1);

/**
 * The text object `next` (a copy of `old` with a new `s`) with its formatting kept: `mt` follows the plain text through
 * editPlain, or goes when it cannot (the formatting is dropped, as it was before 0.7). Objects without `mt` pass through.
 */
export function withPlain(old, next) {
  if (!next || typeof old?.mt !== 'string') return next;
  if (next.s === old.s) return next.mt === old.mt ? next : { ...next, mt: old.mt };
  const mt = richOf(old) ? editPlain(old.mt, old.s, String(next.s)) : null;
  const out = { ...next };
  if (mt) out.mt = mt; else delete out.mt;
  return out;
}
