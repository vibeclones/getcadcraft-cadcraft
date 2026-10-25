/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mep-core.js — what the HVAC and Piping add-ons share (0.5 track MQ). DOM-free (tested in Node).
 * ONE FILE, TWO COPIES: hvac/lib/mep-core.js is the canonical file; piping/lib/mep-core.js is a byte-identical copy (an add-on
 * may not import from outside its own folder). Change this one, then `cp hvac/lib/mep-core.js piping/lib/` — the tests fail on
 * drift.
 *
 *   words      setT(fn) · t(key, vars) · lookupFrom(strings)
 *   units      systemOf(doc) 'imperial'|'metric' · sizeUnitOf(doc) 'in'|'mm' · perUnit(doc, 'in'|'mm') · ftPerUnit(doc)
 *   paths      segs(pts) · pathLength(pts) · pointAt(pts, s) · nearestOnPath(pts, p) · turnOf(t1, t2) · bendAt(V, tin, tout, R)
 *   drawing    line(a, b) · arcThrough(c, r, from, to, ccw) · textAlong(p, dir, s, h) · readableAngle(a)
 *   3D         profile(shape, w, h, N) · placeRing(prof, p, dir, z) · tube(rings) · signedVolume(polys)
 *   files      csv(rows) · sha256Hex(bytes) · attachToPdf(pdf, {name, data, mime, desc})
 *   takeoff    takeoffProject(spec) · takeoffPack(spec) · nextId(prefix)
 */

import { advance } from '../../../font.js';

// ------------------------------------------------------------------------------------------------ words
let impl = null;
/** Use this translate function from now on: (key, vars) → string (main.js hands in the loader's api.t). */
export function setT(fn) { impl = typeof fn === 'function' ? fn : null; }
/** A string in the person's language; `{name}` fills from vars. Without a translator: the key (a missing hookup shows). */
export function t(key, vars = {}) { return impl ? impl(key, vars) : key; }
/** A plain lookup over a catalogue object, with `{name}` fills and English plurals (Node tests). */
export function lookupFrom(strings) {
  return (key, vars = {}) => {
    let s = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
    if (s && typeof s === 'object') s = (vars.n !== undefined && s['=' + vars.n]) || (Number(vars.n) === 1 && s.one) || s.other || key;
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
  };
}

// ------------------------------------------------------------------------------------------------ units
/** Meters per drawing unit by `doc.meta.units` (as CadCraft's model3d.js: unitless = millimeters). */
export const UNIT_M = { '': 0.001, inches: 0.0254, feet: 0.3048, millimeters: 0.001, centimeters: 0.01, meters: 1, yards: 0.9144 };
export const mPerUnitOf = (doc) => UNIT_M[String(doc?.meta?.units || '')] ?? 0.001;
/** Imperial for drawings in inches or feet (or with an architectural/engineering length format and no units), else metric. */
export function systemOf(doc) {
  const u = String(doc?.meta?.units || '').toLowerCase();
  if (u === 'inches' || u === 'feet' || u === 'yards') return 'imperial';
  if (!u && [3, 4, 5].includes(doc?.meta?.lunits)) return 'imperial';
  return 'metric';
}
export const sizeUnitOf = (doc) => (systemOf(doc) === 'imperial' ? 'in' : 'mm');
/** Size units ('in' or 'mm') per drawing unit: a 24 in duct in a drawing in feet is 2 drawing units wide. */
export const perUnit = (doc, u) => mPerUnitOf(doc) / (u === 'in' ? 0.0254 : 0.001);
/** Feet per drawing unit (TakeoffCraft counts in feet). */
export const ftPerUnit = (doc) => mPerUnitOf(doc) / 0.3048;
export const M_PER_FT = 0.3048;

/** A number with at most `dp` decimals, no trailing zeros. */
export function fmtNum(v, dp = 2) {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(dp);
  return dp > 0 ? s.replace(/\.?0+$/, '') : s;
}

// ------------------------------------------------------------------------------------------------ paths (plan, drawing units)
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a) => Math.hypot(a.x, a.y);
export const P = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y });

/** The run's segments: [{ a, b, len, t (unit direction), n (left normal), s0 (distance from the run's start) }]. */
export function segs(pts) {
  const out = [];
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = P(pts[i]), b = P(pts[i + 1]), d = sub(b, a), l = len(d);
    const tt = l > 0 ? { x: d.x / l, y: d.y / l } : { x: 1, y: 0 };
    out.push({ a, b, len: l, t: tt, n: { x: -tt.y, y: tt.x }, s0: s });
    s += l;
  }
  return out;
}
export const pathLength = (pts) => segs(pts).reduce((s, g) => s + g.len, 0);

/** The point `s` along the run (clamped to it): { x, y, seg, at, t }. */
export function pointAt(pts, s) {
  const list = segs(pts);
  if (!list.length) return null;
  let i = 0;
  while (i < list.length - 1 && s > list[i].s0 + list[i].len) i++;
  const g = list[i], at = Math.max(0, Math.min(g.len, s - g.s0));
  return { x: g.a.x + g.t.x * at, y: g.a.y + g.t.y * at, seg: i, at, t: g.t };
}

/** The nearest point of the run to p: { seg, at (along that segment), s (along the run), dist, x, y }. */
export function nearestOnPath(pts, p) {
  let best = null;
  segs(pts).forEach((g, i) => {
    const at = g.len > 0 ? Math.max(0, Math.min(g.len, (p.x - g.a.x) * g.t.x + (p.y - g.a.y) * g.t.y)) : 0;
    const x = g.a.x + g.t.x * at, y = g.a.y + g.t.y * at, dist = Math.hypot(p.x - x, p.y - y);
    if (!best || dist < best.dist - 1e-12) best = { seg: i, at, s: g.s0 + at, dist, x, y };
  });
  return best;
}

/** The signed turn from direction t1 to t2, radians in (−π, π]: + = to the left (counter-clockwise). */
export function turnOf(t1, t2) { return Math.atan2(t1.x * t2.y - t1.y * t2.x, t1.x * t2.x + t1.y * t2.y); }

/**
 * A bend of centreline radius R at corner V (incoming direction tin, outgoing tout): { theta (unsigned turn), side (+1 left,
 * −1 right), T (tangent length R·tan(θ/2)), p1, p2 (where the bend starts and ends), c (its centre), a1, a2 (angles of p1
 * and p2 seen from c) }.
 */
export function bendAt(V, tin, tout, R) {
  const turn = turnOf(tin, tout), theta = Math.abs(turn), side = turn >= 0 ? 1 : -1;
  const T = R * Math.tan(theta / 2);
  const p1 = { x: V.x - tin.x * T, y: V.y - tin.y * T }, p2 = { x: V.x + tout.x * T, y: V.y + tout.y * T };
  const nin = { x: -tin.y * side, y: tin.x * side };   // toward the inside of the bend
  const c = { x: p1.x + nin.x * R, y: p1.y + nin.y * R };
  return { theta, side, T, p1, p2, c, a1: Math.atan2(p1.y - c.y, p1.x - c.x), a2: Math.atan2(p2.y - c.y, p2.x - c.x) };
}

// ------------------------------------------------------------------------------------------------ drawing helpers (CadCraft entities)
export const line = (a, b) => ({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
/** An arc of radius r about c between the angles `from` and `to`, turning counter-clockwise when ccw (CadCraft arcs run a0 → a1 CCW). */
export function arcThrough(c, r, from, to, ccw) { return ccw ? { type: 'arc', cx: c.x, cy: c.y, r, a0: from, a1: to } : { type: 'arc', cx: c.x, cy: c.y, r, a0: to, a1: from }; }
/** An angle turned so text along it reads left to right or bottom to top. */
export function readableAngle(a) {
  let r = Math.atan2(Math.sin(a), Math.cos(a));
  if (r > Math.PI / 2 + 1e-9 || r <= -Math.PI / 2 + 1e-9) r += Math.PI;
  return Math.atan2(Math.sin(r), Math.cos(r));
}
/** Centred text at p along direction dir (a unit vector). */
export const textAlong = (p, dir, s, h) => ({ type: 'text', x: p.x, y: p.y, h, rot: readableAngle(Math.atan2(dir.y, dir.x)), s: String(s), ha: 'center', va: 'middle' });
/** How wide text of height h runs: CadCraft's own Helvetica metrics (font.js; a cap height h is an em of h / 0.718). */
export const textWidth = (s, h) => (advance(String(s)) / 1000) * (h / 0.718);

/**
 * A table as CadCraft entities, its top-left corner at (0, 0): a title, then rows (the first is the header). Numbers (and
 * cells starting with a digit) sit right-aligned. h = the text height (drawing units).
 */
export function drawTable(title, rows, h) {
  const pad = h * 0.6, rowH = h * 2, out = [];
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, j) => Math.max(...rows.map((r) => textWidth(r[j] ?? '', h))) + 2 * pad);
  const W = widths.reduce((a, b) => a + b, 0);
  out.push({ type: 'text', x: 0, y: rowH * 0.3, h: h * 1.25, rot: 0, s: String(title), ha: 'left', va: 'bottom' });
  let y = 0;
  out.push(line({ x: 0, y: 0 }, { x: W, y: 0 }));
  rows.forEach((r, i) => {
    let x = 0;
    for (let j = 0; j < cols; j++) {
      const s = String(r[j] ?? '');
      const right = i > 0 && j > 0 && /^[-\d.]/.test(s);   // numbers right-aligned (never the item names)
      if (s) out.push({ type: 'text', x: right ? x + widths[j] - pad : x + pad, y: y - rowH / 2, h, rot: 0, s, ha: right ? 'right' : 'left', va: 'middle' });
      x += widths[j];
    }
    y -= rowH;
    out.push(line({ x: 0, y }, { x: W, y }));
  });
  let x = 0;
  for (let j = 0; j <= cols; j++) { out.push(line({ x, y: 0 }, { x, y })); x += widths[j] || 0; }
  return out;
}

// ------------------------------------------------------------------------------------------------ 3D (drawing units; the API turns them into meters)
/**
 * A cross-section in its own plane: [[u, v]…] counter-clockwise, u across (centred), v up from the bottom (v = 0 is the
 * bottom of the duct or pipe). shape 'rect' (w × h), 'round' (diameter w), 'oval' (flat oval w × h, flat top and bottom).
 * N = 4 gives a rectangle's four corners; a larger N keeps a rectangle's corners and spreads the other points by side length,
 * so rings of different shapes with the same N can be joined (transitions).
 */
export function profile(shape, w, h, N = 24) {
  if (shape === 'rect') {
    const c = [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]];
    if (N <= 4) return c;
    const sides = [w, h, w, h], extra = N - 4, tot = 2 * (w + h);
    const share = sides.map((s) => (s / tot) * extra), base = share.map(Math.floor);
    let left = extra - base.reduce((a, b) => a + b, 0);
    share.map((s, i) => [s - base[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { base[i]++; left--; } });
    const out = [];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], k = base[i] + 1;
      for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    }
    return out;
  }
  if (shape === 'oval' && w - h > 1e-9) {
    const r = h / 2, f = w - h, per = 2 * f + 2 * Math.PI * r, out = [];
    for (let j = 0; j < N; j++) {
      let s = (j / N) * per;
      if (s < f) { out.push([-f / 2 + s, 0]); continue; }
      s -= f;
      if (s < Math.PI * r) { const a = -Math.PI / 2 + s / r; out.push([f / 2 + r * Math.cos(a), r + r * Math.sin(a)]); continue; }
      s -= Math.PI * r;
      if (s < f) { out.push([f / 2 - s, h]); continue; }
      s -= f;
      const a = Math.PI / 2 + s / r;
      out.push([-f / 2 + r * Math.cos(a), r + r * Math.sin(a)]);
    }
    return out;
  }
  const d = shape === 'oval' ? h : w, r = d / 2, out = [];
  for (let j = 0; j < N; j++) { const a = -0.75 * Math.PI + (2 * Math.PI * j) / N; out.push([r * Math.cos(a), r + r * Math.sin(a)]); }
  return out;
}

/** A cross-section stood up at plan point p facing along dir (a unit vector; `scale` widens it across, for mitres): 3D points. */
export function placeRing(prof, p, dir, z, scale = 1, nrm = null) {
  const n = nrm || { x: -dir.y, y: dir.x };
  return prof.map(([u, v]) => [p.x + n.x * u * scale, p.y + n.y * u * scale, z + v]);
}

/** Signed volume of closed polygons (divergence theorem over fans): > 0 when the faces point outward. */
export function signedVolume(polys) {
  let v = 0;
  for (const p of polys) for (let i = 1; i + 1 < p.length; i++) {
    const a = p[0], b = p[i], c = p[i + 1];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

/** One closed solid through rings of equal length (a tube with its two ends capped), faces pointing outward. */
export function tube(rings) {
  const R = rings.filter((r, i) => i === 0 || r.some((q, j) => Math.hypot(q[0] - rings[i - 1][j][0], q[1] - rings[i - 1][j][1], q[2] - rings[i - 1][j][2]) > 1e-9));
  if (R.length < 2) return [];
  const n = R[0].length, polys = [];
  for (let k = 0; k + 1 < R.length; k++) {
    const A = R[k], B = R[k + 1];
    for (let j = 0; j < n; j++) { const i2 = (j + 1) % n; polys.push([A[j], A[i2], B[i2], B[j]]); }
  }
  polys.push(R[0].slice().reverse(), R[R.length - 1].slice());
  return signedVolume(polys) < 0 ? polys.map((p) => p.slice().reverse()) : polys;
}

// ------------------------------------------------------------------------------------------------ files
/** Rows → CSV text (RFC 4180 quoting, CRLF). */
export function csv(rows) {
  const q = (v) => { const s = v === null || v === undefined ? '' : typeof v === 'number' ? fmtNum(v, 4) : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

/** SHA-256 of bytes as hex (TakeoffCraft names a PDF by it). */
export async function sha256Hex(bytes) {
  let d;
  if (globalThis.crypto && globalThis.crypto.subtle) d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  else d = (await import('@noble/hashes/sha2.js')).sha256(bytes);   // a page served on the LAN has no crypto.subtle
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const latin = (s) => new TextEncoder().encode(s);
const pdfString = (s) => '(' + String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1') + ')';

/**
 * Attach a file to a PDF by an incremental update (ISO 32000-1 §7.5.6): the original bytes stay as they are, and after them
 * come the embedded file, its file specification, a name tree and a new catalog that points at it (§7.11.4, §7.7.2), with a
 * cross-reference section whose /Prev is the old one. Made for CadCraft's own PDFs (plot.js: a plain catalog without
 * /Names, a classic xref table); anything else is refused. → Uint8Array.
 */
export function attachToPdf(pdf, { name, data, mime = 'application/octet-stream', desc = '' }) {
  const text = new TextDecoder('latin1').decode(pdf);
  const tail = text.slice(Math.max(0, text.length - 2048));
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  const tr = text.lastIndexOf('trailer');
  if (!sx || tr < 0) throw new Error('not a PDF this can add to');   // i18n-ignore: CadCraft's own PDFs always have these
  const trailer = text.slice(tr, text.indexOf('>>', tr) + 2);
  const size = Number((/\/Size\s+(\d+)/.exec(trailer) || [])[1]);
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailer);
  const info = /\/Info\s+(\d+\s+\d+\s+R)/.exec(trailer);
  if (!size || !root) throw new Error('no catalog');   // i18n-ignore
  const objAt = text.lastIndexOf('\n' + root[1] + ' ' + root[2] + ' obj');
  const end = text.indexOf('endobj', objAt);
  const body = objAt >= 0 && end > 0 ? text.slice(text.indexOf('<<', objAt), end).trim() : '';
  if (!body.startsWith('<<') || !body.endsWith('>>') || /\/Names\b/.test(body)) throw new Error('catalog not understood');   // i18n-ignore
  const ef = size, fs = size + 1, tree = size + 2;
  const parts = [];
  let at = pdf.length;
  const offs = {};
  const push = (b) => { const u = typeof b === 'string' ? latin(b) : b; parts.push(u); at += u.length; };
  const obj = (n, gen, chunks) => { offs[n] = at; push(n + ' ' + gen + ' obj\n'); for (const c of chunks) push(c); push('\nendobj\n'); };
  push('\n');
  obj(ef, 0, ['<< /Type /EmbeddedFile /Subtype /' + mime.replace(/[^A-Za-z0-9.+-]/g, (c) => '#' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) + ' /Length ' + data.length + ' /Params << /Size ' + data.length + ' >> >>\nstream\n', data, '\nendstream']);
  obj(fs, 0, ['<< /Type /Filespec /F ' + pdfString(name) + ' /UF ' + pdfString(name) + ' /EF << /F ' + ef + ' 0 R >>' + (desc ? ' /Desc ' + pdfString(desc) : '') + ' >>']);
  obj(tree, 0, ['<< /Names [' + pdfString(name) + ' ' + fs + ' 0 R] >>']);
  obj(Number(root[1]), Number(root[2]), [body.slice(0, -2).trimEnd() + ' /Names << /EmbeddedFiles ' + tree + ' 0 R >> >>']);
  const xref = at;
  const row = (n) => String(offs[n]).padStart(10, '0') + ' ' + String(n === Number(root[1]) ? Number(root[2]) : 0).padStart(5, '0') + ' n \n';
  push('xref\n' + root[1] + ' 1\n' + row(Number(root[1])) + ef + ' 3\n' + row(ef) + row(fs) + row(tree));
  push('trailer\n<< /Size ' + (size + 3) + ' /Root ' + root[1] + ' ' + root[2] + ' R' + (info ? ' /Info ' + info[1] : '') + ' /Prev ' + sx[1] + ' >>\nstartxref\n' + xref + '\n%%EOF\n');
  const out = new Uint8Array(at);
  out.set(pdf, 0);
  let k = pdf.length;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

// ------------------------------------------------------------------------------------------------ TakeoffCraft (docs/ADDONS-SPEC.md §13; takeoffcraft/dev/model.js readProject)
export const TAKEOFF_PALETTE = ['#1F77B4', '#D62728', '#2CA02C', '#FF7F0E', '#9467BD', '#8C564B', '#E377C2', '#17BECF', '#BCBD22', '#5A5A5A'];
export const EMBED_NAME = 'takeoff.takeoffcraft.json';   // TakeoffCraft's embed.js: a PDF carrying its takeoff
export const EMBED_FORMAT = 'takeoffcraft-embedded';

/**
 * A TakeoffCraft project (format `takeoffcraft-project` 1) for one sheet: the PDF `file` {hash, name, size}, page 0, its scale
 * (feet per PDF unit, labelled; `cal` = a measured line to check it by), and items each with its marks.
 *   items: [{ name, type linear|count, unit LF|m|EA, csi?, components: [{name, unit, formula}], marks: [[[x, y]…] | {pts, slopes}…], xd? }]
 * Rates are left empty: a rate is the estimator's.
 */
export function takeoffProject({ name, file, ftPerUnit: fpu, label, cal = null, items }) {
  let seq = 0;
  const id = (p) => p + ++seq;
  const sheet = file.hash + ':0';
  const outItems = [], marks = [];
  items.forEach((it, k) => {
    const iid = id('i');
    outItems.push({
      id: iid, name: it.name, type: it.type, unit: it.unit, color: TAKEOFF_PALETTE[k % TAKEOFF_PALETTE.length], heightFt: 0, waste: 0, mat: 0, lab: 0,
      components: (it.components || []).map((c) => ({ id: id('c'), name: c.name, unit: c.unit, formula: c.formula, waste: 0, mat: 0, lab: 0 })),
      ...(it.csi ? { csi: it.csi } : {}), ...(it.xd ? { xd: it.xd } : {}),
    });
    for (const mk of it.marks || []) {
      // a mark: its points, or { pts, slopes } (a sloped run: [{k: 'rake', p: rise per 12}] per segment, measured along the slope)
      const pts = Array.isArray(mk) ? mk : mk.pts;
      const m = { id: id('m'), item: iid, sheet, kind: it.type, pts: pts.map((p) => [round6(p[0]), round6(p[1])]) };
      if (!Array.isArray(mk) && Array.isArray(mk.slopes) && mk.slopes.length === pts.length - 1) m.slopes = mk.slopes;
      marks.push(m);
    }
  });
  return {
    format: 'takeoffcraft-project', version: 1, name: String(name || 'Takeoff').slice(0, 200), seq,
    files: [{ hash: file.hash, name: file.name, size: file.size, pages: 1 }],
    sheets: { [sheet]: { scale: { method: 'calibrated', ftPerUnit: fpu, preset: null, label: String(label || '').slice(0, 80), cal } } },
    items: outItems, marks, areas: [],
  };
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The drawing for TakeoffCraft: model space plotted on one sheet (ARCH D or ISO A1) at the largest standard scale that fits,
 * the takeoff built against it, and the takeoff put inside the PDF — TakeoffCraft opens such a PDF with its takeoff (its
 * embed.js: `standsFor` = the hash of the PDF as plotted). build(toPt, mmPerUnit) → items (takeoffProject's), with marks
 * already in PDF units (points, y up). → { bytes, project, hash, scale, ftPerUnit }
 */
export async function takeoffPdf(doc, { name, build, cal = null }) {
  const [{ modelSheet, displayList, toPdf, extentsOf }, { scaleList, sOf }] = await Promise.all([import('../../../plot.js'), import('../../../sheets.js')]);
  const area = extentsOf(doc);
  if (!area) throw new Error(t('err.empty'));
  const paper = systemOf(doc) === 'imperial' ? 'arch-d' : 'iso-a1';
  const fit = modelSheet(doc, { area, paper, n: null });
  // the largest standard scale that fits: architectural/engineering ones for an imperial drawing, 1:n for a metric one
  const sFit = fit.views[0].m[0], imp = systemOf(doc) === 'imperial';
  const best = scaleList(doc).filter((x) => !imp || x.label.includes('"')).map((x) => ({ ...x, s: sOf(doc, 'mm', x.n) }))
    .filter((x) => x.s <= sFit * (1 + 1e-9)).sort((a, b) => b.s - a.s)[0] || { n: null, label: '' };
  const sheet = best.n ? modelSheet(doc, { area, paper, n: best.n }) : fit;
  const list = displayList(doc, sheet, { mono: true });
  const { bytes } = await toPdf(list, { title: name });
  const m = sheet.views[0].m, K = 72 / 25.4;
  const toPt = (p) => [(m[0] * p[0] + m[2] * p[1] + m[4]) * K, (m[1] * p[0] + m[3] * p[1] + m[5]) * K];
  const fpu = ftPerUnit(doc) / (m[0] * K);
  const hash = await sha256Hex(bytes);
  const items = build(toPt);
  const c = cal ? { a: toPt(cal[0]), b: toPt(cal[1]), ft: Math.hypot(cal[1][0] - cal[0][0], cal[1][1] - cal[0][1]) * ftPerUnit(doc), text: '' } : null;
  if (c) c.text = fmtNum(c.ft, 3) + ' ft';   // i18n-ignore: TakeoffCraft keeps it as a note on the calibration
  const project = takeoffProject({ name, file: { hash, name: name + '.pdf', size: bytes.length }, ftPerUnit: fpu, label: best.label, cal: c, items });
  const payload = new TextEncoder().encode(JSON.stringify({ format: EMBED_FORMAT, version: 1, standsFor: hash, takeoff: project }));
  const out = attachToPdf(bytes, { name: EMBED_NAME, data: payload, mime: 'application/json', desc: 'TakeoffCraft takeoff' });   // i18n-ignore: file metadata
  return { bytes: out, project, hash, scale: best.label, ftPerUnit: fpu, plain: bytes };
}

/** A TakeoffCraft trade pack (format `takeoffcraft-pack` 1, docs/ADDONS-SPEC.md §13) of the drawing's assemblies, without rates. */
export function takeoffPack({ id, name, trade, description, sources, csi, items }) {
  return {
    format: 'takeoffcraft-pack', version: 1, id, name: String(name).slice(0, 80), packVersion: '1.0.0', trade, description: String(description || '').slice(0, 600),
    author: 'CadCraft', license: 'CC0-1.0', status: 'starter', csi: [...new Set(csi)], sources, items,
  };
}

/** A pack item key from a name: a-z0-9 . _ - (TakeoffCraft's KEY_RE), unique within `used`. */
export function packKey(name, used) {
  let k = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'item';
  if (!/^[a-z0-9]/.test(k)) k = 'x' + k;
  let out = k;
  for (let i = 2; used.has(out); i++) out = k + '-' + i;
  used.add(out);
  return out;
}

/** A short random id for a run (its 3D solid and its links to other runs use it). */
export function newRunId() {
  const a = new Uint8Array(6);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a); else for (let i = 0; i < 6; i++) a[i] = Math.floor(Math.random() * 256);
  return [...a].map((b) => (b % 36).toString(36)).join('');
}
