/* SPDX-License-Identifier: Apache-2.0 */
/**
 * plot.js — plotting for the CadCraft drafting app: a sheet → a vector PDF (or a preview on a
 * canvas). No DOM needed for the PDF: bin/test-cadcraft.mjs runs it in Node.
 *
 *   layoutSheet(doc, layout)                      a layout at 1:1 — its viewports show the model
 *   modelSheet(doc, { area, paper, portrait, n }) the model on a paper size, at 1:n or fitted (n = null)
 *   displayList(doc, sheet, { mono })             what to draw, in millimetres on the sheet
 *   await toPdf(list, { pen, title })             → { bytes: Uint8Array, report }
 *   drawPreview(ctx, list, { pxPerMm, pen })      the same on a canvas
 *
 * A sheet is { w, h (mm), views: [{ clip: [{x,y}…] | null, m: entity → mm, entities }] }.
 * Lines are true vectors (arcs as Béziers), fills keep their holes (even-odd), text is
 * Helvetica (one of the 14 fonts every PDF reader has), so nothing is embedded. Helvetica's
 * Windows-1252 set covers Western European text; other characters print as "?" and the
 * report says how many. Layers set not to plot are left out; viewport frames follow their layer.
 */

import { walk } from './walk.js';
import { textLayout, textCorners, viewportCorners, viewportMatrix, mMul, mApply, FONT_EM, emptyBounds, growPt, validBounds, primBounds } from './geom.js';
import { UNIT_MM, makePaper, sOf, nOf, scaleLabel } from './sheets.js';
import { CP1252, SUBST, charAdvance } from './font.js';

export const PEN_WIDTHS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7];
const MARGIN = 5;   // mm round a model plot (most printers cannot print to the edge)

// ---------------------------------------------------------------------------
// Sheets

export function layoutSheet(doc, layout) {
  const p = layout.paper, k = UNIT_MM[p.unit];
  const toMm = [k, 0, 0, k, -p.x0 * k, -p.y0 * k];
  const views = [];
  for (const e of layout.entities.values()) {
    if (e.type !== 'viewport') continue;
    views.push({ clip: viewportCorners(e).map((q) => mApply(toMm, q)), m: mMul(toMm, viewportMatrix(e)), entities: doc.model.values() });
  }
  views.push({ clip: null, m: toMm, entities: layout.entities.values() });
  return { w: p.w * k, h: p.h * k, views, name: layout.name };
}

/**
 * The model on paper. `area` is a model window (bounds); `n` the scale 1:n in real units (the
 * model's units against millimetres), or null to fit the printable area. Centred on the sheet.
 */
export function modelSheet(doc, { area, paper = 'iso-a3', portrait = false, n = null }) {
  const pp = makePaper(paper, portrait), k = UNIT_MM[pp.unit];
  const W = pp.w * k, H = pp.h * k;
  const aw = Math.max(area.maxX - area.minX, 1e-9), ah = Math.max(area.maxY - area.minY, 1e-9);
  const sFit = Math.min((W - 2 * MARGIN) / aw, (H - 2 * MARGIN) / ah);
  const s = n ? sOf(doc, 'mm', n) : sFit;
  const cx = (area.minX + area.maxX) / 2, cy = (area.minY + area.maxY) / 2;
  const m = [s, 0, 0, s, W / 2 - cx * s, H / 2 - cy * s];
  const clip = [{ x: MARGIN, y: MARGIN }, { x: W - MARGIN, y: MARGIN }, { x: W - MARGIN, y: H - MARGIN }, { x: MARGIN, y: H - MARGIN }];
  return {
    w: W, h: H, views: [{ clip, m, entities: doc.model.values() }], name: doc.meta.name || 'Drawing1',
    scale: { s, n: nOf(doc, 'mm', s), label: n ? scaleLabel(doc, 'mm', s) : (nOf(doc, 'mm', s) >= 1 ? '1:' + fmt(nOf(doc, 'mm', s), 4) : fmt(1 / nOf(doc, 'mm', s), 4) + ':1') + ' (fitted)', fits: s <= sFit * (1 + 1e-9) },
  };
}

// ---------------------------------------------------------------------------
// Display list: per view, fills, then strokes grouped by colour, then points and text

export function displayList(doc, sheet, { mono = true } = {}) {
  const ink = (c) => (mono || c === 'ink' ? '#000000' : c);
  const views = sheet.views.map((v) => {
    const fills = [], strokes = new Map(), points = [], texts = [];
    // walk.js's 4th argument (track P): alpha = transparency, wipe = a fill in the paper's colour (white)
    const alphaOf = (o) => (o && Number.isFinite(o.alpha) ? Math.max(0, Math.min(1, o.alpha)) : 1);
    const strokeList = (color, lw, a) => { const k = color + '|' + (lw >= 0 ? lw : -3) + '|' + a; let l = strokes.get(k); if (!l) strokes.set(k, (l = [])); return l; };
    walk(doc, v.entities, {
      // grouped by colour, lineweight (0.4 C8: mm on paper, -3 = the plot's pen width) and alpha
      stroke(color, ps, lw = -3, o) { strokeList(ink(color), lw, alphaOf(o)).push(...ps); },
      fill(color, loops, solid, o) {
        const a = alphaOf(o);
        if (solid) fills.push({ color: o?.wipe ? '#ffffff' : ink(color), loops, alpha: o?.wipe ? 1 : a });
        else {   // a patterned hatch plots as a light tone of its colour, with its outline
          fills.push({ color: mix(ink(color), '#ffffff', 0.82), loops, alpha: a });
          const l2 = strokeList(ink(color), -3, a);
          for (const l of loops) for (let i = 0; i + 3 < l.length; i += 2) l2.push({ k: 'L', x1: l[i], y1: l[i + 1], x2: l[i + 2], y2: l[i + 3] });
        }
      },
      text(color, e, o) { texts.push({ color: ink(color), e, alpha: alphaOf(o) }); },
      point(color, x, y) { points.push({ color: ink(color), x, y }); },
    }, { m: v.m, plot: true });
    return { clip: v.clip, fills, strokes: [...strokes].map(([k, prims]) => { const [color, lw, a] = k.split('|'); return { color, lw: +lw, alpha: +a, prims }; }), points, texts };
  });
  return { w: sheet.w, h: sheet.h, name: sheet.name, views };
}

// ---------------------------------------------------------------------------
// PDF

/** PDF bytes for a display list: { bytes, report: { missing, texts, size } }. */
/** A stroke's width on paper (mm): its lineweight, 0 as the thinnest line (0.05 mm), the default as the plot's pen. */
const penFor = (lw, pen) => (lw >= 0 ? Math.max(lw, 0.05) : pen);

export async function toPdf(list, { pen = 0.25, title = list.name } = {}) {
  const page = await pageOf(list, pen);
  const bytes = assemble([page], title);
  return { bytes, report: { missing: page.missing, texts: page.texts, size: bytes.length, compressed: page.flate } };
}

/**
 * Several sheets in one PDF (0.4 C36, PUBLISH): one page each, at its own paper size, with a bookmark per page.
 * lists = displayList(...) results; names = the bookmarks. → { bytes, report: { pages, missing, texts, size } }
 */
export async function toPdfPages(lists, { pen = 0.25, title = 'Drawing', names = [] } = {}) {
  const pages = [];
  for (const l of lists) pages.push(await pageOf(l, pen));
  pages.forEach((p, i) => { p.name = names[i] || lists[i].name || 'Page ' + (i + 1); });
  const bytes = assemble(pages, title);
  return { bytes, report: { pages: pages.length, missing: pages.reduce((s, p) => s + p.missing, 0), texts: pages.reduce((s, p) => s + p.texts, 0), size: bytes.length } };
}

/** One page's content stream (compressed when the browser can) from a display list. */
async function pageOf(list, pen) {
  const out = new Ops();
  let missing = 0, nTexts = 0;
  out.raw((72 / 25.4).toFixed(9) + ' 0 0 ' + (72 / 25.4).toFixed(9) + ' 0 0 cm');   // everything after this is in mm
  for (const v of list.views) {
    out.raw('q');
    out.reset();
    if (v.clip) { out.poly(v.clip); out.raw('W n'); }
    out.raw('1 J 1 j ' + num(pen) + ' w');
    for (const f of v.fills) {
      out.alpha(f.alpha);
      out.fillColor(f.color);
      for (const l of f.loops) {
        if (l.length < 6) continue;
        out.raw(num(l[0]) + ' ' + num(l[1]) + ' m');
        for (let i = 2; i + 1 < l.length; i += 2) out.raw(num(l[i]) + ' ' + num(l[i + 1]) + ' l');
        out.raw('h');
      }
      out.raw('f*');
    }
    let width = pen;
    for (const s of v.strokes) {
      const w = penFor(s.lw, pen);
      if (w !== width) { out.raw(num(w) + ' w'); width = w; }
      out.alpha(s.alpha);
      out.strokeColor(s.color);
      out.path(s.prims);
      out.raw('S');
    }
    if (width !== pen) out.raw(num(pen) + ' w');
    out.alpha(1);
    for (const p of v.points) { out.strokeColor(p.color); out.raw(num(p.x) + ' ' + num(p.y) + ' m ' + num(p.x) + ' ' + num(p.y) + ' l S'); }
    for (const t of v.texts) { out.alpha(t.alpha); missing += out.text(t.e, t.color); nTexts++; }
    out.raw('Q');
  }
  const content = new TextEncoder().encode(out.lines.join('\n') + '\n');
  const packed = await deflate(content);
  return { w: list.w, h: list.h, content: packed || content, flate: !!packed, missing, texts: nTexts, alphas: out.alphas };
}

class Ops {
  constructor() { this.lines = []; this.alphas = []; this.reset(); }
  reset() { this.sc = null; this.fc = null; this.ga = 1; }
  raw(s) { this.lines.push(s); }
  /** Transparency (track P): an ExtGState /GA<n> per alpha used on the page (assemble() writes them). */
  alpha(a) {
    a = Number.isFinite(a) ? Math.max(0, Math.min(1, Math.round(a * 1000) / 1000)) : 1;
    if (a === this.ga) return;
    this.ga = a;
    let k = this.alphas.indexOf(a);
    if (k < 0) { k = this.alphas.length; this.alphas.push(a); }
    this.raw('/GA' + k + ' gs');
  }
  strokeColor(hex) { if (this.sc !== hex) { this.sc = hex; this.raw(rgb(hex) + ' RG'); } }
  fillColor(hex) { if (this.fc !== hex) { this.fc = hex; this.raw(rgb(hex) + ' rg'); } }
  poly(pts) { this.raw(num(pts[0].x) + ' ' + num(pts[0].y) + ' m'); for (const p of pts.slice(1)) this.raw(num(p.x) + ' ' + num(p.y) + ' l'); this.raw('h'); }
  path(ps) {
    let lx = Infinity, ly = Infinity;
    for (const q of ps) {
      if (q.k === 'L') {
        if (Math.abs(q.x1 - lx) > 1e-9 || Math.abs(q.y1 - ly) > 1e-9) this.raw(num(q.x1) + ' ' + num(q.y1) + ' m');
        this.raw(num(q.x2) + ' ' + num(q.y2) + ' l'); lx = q.x2; ly = q.y2;
      } else {
        const from = q.rev ? q.a1 : q.a0, to = q.rev ? q.a0 : q.a1;
        const sx = q.cx + q.r * Math.cos(from), sy = q.cy + q.r * Math.sin(from);
        if (Math.abs(sx - lx) > 1e-9 || Math.abs(sy - ly) > 1e-9) this.raw(num(sx) + ' ' + num(sy) + ' m');
        for (const c of arcBeziers(q.cx, q.cy, q.r, from, to)) this.raw(c.map(num).join(' ') + ' c');
        lx = q.cx + q.r * Math.cos(to); ly = q.cy + q.r * Math.sin(to);
      }
    }
  }
  /** One text entity (mm), Helvetica. Returns how many characters had to print as "?". */
  text(e, color) {
    const lay = textLayout(e), fs = e.h * FONT_EM, wf = e.wf || 1;
    const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
    let missing = 0;
    this.fillColor(color);
    lay.lines.forEach((line, i) => {
      if (!line) return;
      const enc = winAnsi(line);
      missing += enc.missing;
      const w = enc.width / 1000 * fs * wf;
      const lx = e.ha === 'center' ? -w / 2 : e.ha === 'right' ? -w : 0, ly = lay.baselines[i];
      const x = e.x + lx * c - ly * s, y = e.y + lx * s + ly * c;
      const k = e.obl ? fs * Math.tan(e.obl) : 0;   // oblique angle (P.7): x leans by tan(angle) per unit of height
      this.raw('BT /F1 1 Tf ' + [fs * wf * c, fs * wf * s, k * c - fs * s, k * s + fs * c, x, y].map(num).join(' ') + ' Tm (' + enc.str + ') Tj ET');   // i18n-ignore: PDF operators
    });
    return missing;
  }
}

/** Cubic Béziers for an arc from angle a to b (either direction), ≤ 90° each: [x1 y1 x2 y2 x3 y3]. */
export function arcBeziers(cx, cy, r, a, b) {
  const sweep = b - a, n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)), d = sweep / n, k = 4 / 3 * Math.tan(d / 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = a + d * i, t1 = t0 + d;
    const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    out.push([cx + r * (c0 - k * s0), cy + r * (s0 + k * c0), cx + r * (c1 + k * s1), cy + r * (s1 - k * c1), cx + r * c1, cy + r * s1]);
  }
  return out;
}

function num(v) {
  if (!Number.isFinite(v)) return '0';
  const s = (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
function rgb(hex) {
  const h = hex.length === 4 ? hex.slice(1).split('').map((x) => x + x).join('') : hex.slice(1, 7);
  return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(' ');
}
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return '#' + x.map((v, i) => Math.round(v * (1 - t) + y[i] * t).toString(16).padStart(2, '0')).join('');
}
const fmt = (n, d) => Number(n.toPrecision(d)).toString();

/** A string as an escaped PDF literal in WinAnsiEncoding, its width, and how many characters had no glyph. */
export function winAnsi(s) {
  let str = '', width = 0, missing = 0;
  for (let ch of s) {
    ch = SUBST[ch] || ch;
    let code = ch.codePointAt(0);
    if (CP1252[ch] !== undefined) code = CP1252[ch];
    else if (code > 0xff || (code >= 0x7f && code < 0xa0) || code < 0x20) { code = 0x3f; missing++; width += 556; }
    if (code === 0x28 || code === 0x29 || code === 0x5c) str += '\\' + String.fromCharCode(code);
    else if (code >= 0x20 && code < 0x7f) str += String.fromCharCode(code);
    else str += '\\' + code.toString(8).padStart(3, '0');
    if (code !== 0x3f || ch === '?') width += charAdvance(ch);
  }
  return { str, width, missing };
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate');   // zlib format, which is what /FlateDecode reads
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

/** pages [{ w, h (mm), content, flate, name? }] → a PDF 1.4 file; with more than one page, a bookmark per page. */
function assemble(pages, title) {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let size = 0;
  const push = (b) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); size += u.length; };
  const obj = (n, body) => { offsets[n] = size; push(n + ' 0 obj\n'); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };
  const pt = (mm) => num(mm * 72 / 25.4);
  const now = new Date(), pad = (x) => String(x).padStart(2, '0');
  const date = 'D:' + now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
  const pdfText = (s) => '(' + winAnsi(String(s || '')).str + ')';

  push('%PDF-1.4\n');
  push(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));   // a binary comment: "this file has 8-bit data"

  // 1 catalog, 2 pages, 3 font, 4 info, 5 outlines (more than one page), then per page: the page and its content
  const n = pages.length, outlines = n > 1, first = 6, pageNo = (i) => first + 2 * i, itemNo = (i) => first + 2 * n + i;
  obj(1, '<< /Type /Catalog /Pages 2 0 R' + (outlines ? ' /Outlines 5 0 R /PageMode /UseOutlines' : '') + ' >>');
  obj(2, '<< /Type /Pages /Kids [' + pages.map((_, i) => pageNo(i) + ' 0 R').join(' ') + '] /Count ' + n + ' >>');
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Title ' + pdfText(title) + ' /Producer (CadCraft) /Creator (CadCraft) /CreationDate (' + date + ') >>');
  obj(5, outlines ? '<< /Type /Outlines /First ' + itemNo(0) + ' 0 R /Last ' + itemNo(n - 1) + ' 0 R /Count ' + n + ' >>' : '<< >>');
  pages.forEach((p, i) => {
    const gs = (p.alphas || []).length ? ' /ExtGState << ' + p.alphas.map((a, k) => '/GA' + k + ' << /Type /ExtGState /CA ' + num(a) + ' /ca ' + num(a) + ' >>').join(' ') + ' >>' : '';
    obj(pageNo(i), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pt(p.w) + ' ' + pt(p.h) + '] /Resources << /Font << /F1 3 0 R >>' + gs + ' >> /Contents ' + (pageNo(i) + 1) + ' 0 R >>');
    obj(pageNo(i) + 1, ['<< /Length ' + p.content.length + (p.flate ? ' /Filter /FlateDecode' : '') + ' >>\nstream\n', p.content, '\nendstream']);
  });
  if (outlines) pages.forEach((p, i) => obj(itemNo(i), '<< /Title ' + pdfText(p.name) + ' /Parent 5 0 R' + (i ? ' /Prev ' + itemNo(i - 1) + ' 0 R' : '') + (i < n - 1 ? ' /Next ' + itemNo(i + 1) + ' 0 R' : '') + ' /Dest [' + pageNo(i) + ' 0 R /Fit] >>'));
  const total = outlines ? itemNo(n) : pageNo(n);
  const xref = size;
  push('xref\n0 ' + total + '\n0000000000 65535 f \n' + offsets.slice(1, total).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  push('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 4 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Canvas preview (the same display list; `font` is the drawing font stack)

export function drawPreview(ctx, list, { pxPerMm, pen = 0.25, font = 'Helvetica, Arial, sans-serif', ox = 0, oy = 0 }) {
  const T = [pxPerMm, 0, 0, -pxPerMm, ox, oy + list.h * pxPerMm];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox, oy, list.w * pxPerMm, list.h * pxPerMm);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const v of list.views) {
    ctx.save();
    ctx.setTransform(...T);
    if (v.clip) { ctx.beginPath(); v.clip.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.clip(); }
    ctx.lineWidth = Math.max(pen, 0.6 / pxPerMm);
    for (const f of v.fills) {
      ctx.globalAlpha = f.alpha ?? 1;
      ctx.fillStyle = f.color; ctx.beginPath();
      for (const l of f.loops) { ctx.moveTo(l[0], l[1]); for (let i = 2; i + 1 < l.length; i += 2) ctx.lineTo(l[i], l[i + 1]); ctx.closePath(); }
      ctx.fill('evenodd');
    }
    for (const s of v.strokes) {
      ctx.lineWidth = Math.max(penFor(s.lw, pen), 0.6 / pxPerMm);
      ctx.globalAlpha = s.alpha ?? 1;
      ctx.strokeStyle = s.color; ctx.beginPath();
      for (const q of s.prims) {
        if (q.k === 'L') { ctx.moveTo(q.x1, q.y1); ctx.lineTo(q.x2, q.y2); }
        else { const a = q.rev ? q.a1 : q.a0, b = q.rev ? q.a0 : q.a1; ctx.moveTo(q.cx + q.r * Math.cos(a), q.cy + q.r * Math.sin(a)); ctx.arc(q.cx, q.cy, q.r, a, b, !!q.rev); }
      }
      ctx.stroke();
    }
    for (const t of v.texts) {
      const e = t.e, lay = textLayout(e), fs = e.h * FONT_EM * pxPerMm;
      if (fs < 0.6) continue;
      const p = { x: T[0] * e.x + T[4], y: T[3] * e.y + T[5] };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(p.x, p.y); ctx.rotate(-(e.rot || 0)); if (e.wf && e.wf !== 1) ctx.scale(e.wf, 1);
      if (e.obl) ctx.transform(1, 0, -Math.tan(e.obl), 1, 0, 0);
      ctx.globalAlpha = t.alpha ?? 1;
      ctx.fillStyle = t.color; ctx.font = fs.toFixed(2) + 'px ' + font;
      ctx.textAlign = e.ha === 'center' ? 'center' : e.ha === 'right' ? 'right' : 'left'; ctx.textBaseline = 'alphabetic';
      lay.lines.forEach((line, i) => ctx.fillText(line, 0, -lay.baselines[i] * pxPerMm));
      ctx.setTransform(...T);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  ctx.restore();
}

/** The model area a plot covers when asked for its extents. */
export function extentsOf(doc) {
  const b = emptyBounds();
  const list = displayList(doc, { w: 0, h: 0, views: [{ clip: null, m: null, entities: doc.model.values() }] });
  for (const s of list.views[0].strokes) for (const q of s.prims) primBounds(q, b);
  for (const f of list.views[0].fills) for (const l of f.loops) for (let i = 0; i + 1 < l.length; i += 2) growPt(b, l[i], l[i + 1]);
  for (const t of list.views[0].texts) for (const p of textCorners(t.e)) growPt(b, p.x, p.y);
  for (const p of list.views[0].points) growPt(b, p.x, p.y);
  return validBounds(b) ? b : null;
}
