/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pdfunder.js — the PDF commands (0.7 D7.24; pdfmodel.js has the model, pdfhost.js pdf.js, pdf-vector.js the page's content).
 * DOM-free. Registered through commands.js's command registry when this module is imported (cadcraft.js; Node tests too):
 *
 *   PDFATTACH (PDFATT)  a PDF page as an underlay: file, page, insertion point, scale, rotation
 *   PDFIMPORT (PDFIM)   a page's lines, arcs, polylines, fills and text as drawing objects on layers named after the PDF
 *   PDFCLIP · PDFADJUST (fade, contrast, monochrome, on/off) · PDFLAYERS (the PDF's own layers) · PDF (give CadCraft the file)
 * Each edit is one undo step.
 */
import { t } from './i18n.js';
import { commandRegistry } from './commands.js';
import { insertMatrix, mApply, FONT_EM } from './geom.js';
import { pdfInfo, pageVector } from './pdfhost.js';
import { pdfKey, pdfsOf, pdfFrame, freePdfName, pdfBlock, findPdf, addPdf, unitScale } from './pdfmodel.js';

const def = commandRegistry.add, opt = commandRegistry.option;
export { pdfKey, pdfsOf, pdfFrame, pdfBlock, findPdf, addPdf, unitScale };
const invert = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };
const isPdfRef = (doc, e) => e && e.type === 'insert' && !!pdfFrame(doc.blocks.get(e.block));

// ------------------------------------------------------------------------------------------------------ commands

async function pickPdf(c) {
  if (!c.host.pickPdfs) { c.print(t('pdf.nobrowser')); return null; }
  const [f] = (await c.host.pickPdfs({ multiple: false })) || [];
  if (!f) return null;
  const rec = addPdf(c.doc, f.name, f.bytes);
  if (rec.error) { c.print(rec.error); return null; }
  return rec;
}
async function askPage(c, rec) {
  let info;
  try { info = await pdfInfo(rec); } catch (err) { c.print(t('pdf.unreadable', { file: rec.name, why: String(err?.message || err).slice(0, 160) })); return null; }
  if (!info.pages) { c.print(t('pdf.nopages', { file: rec.name })); return null; }
  let page = 1;
  if (info.pages > 1) {
    const v = await c.number(t('pdf.prompt.page', { n: info.pages }), { default: 1 });
    page = Number.isFinite(v) ? Math.round(v) : 1;
    if (page < 1 || page > info.pages) { c.print(t('pdf.page.bad', { n: info.pages })); return null; }
  }
  const [w, h] = info.sizes[page - 1] || info.sizes[0];
  return { page, w, h, info };
}

def('PDFATTACH', ['PDFATT'], async (c) => {
  const rec = await pickPdf(c);
  if (!rec) return;
  const pg = await askPage(c, rec);
  if (!pg) return;
  const at = await c.point(t('pdf.prompt.insert', { file: rec.name }));
  if (!at || at.option) return;
  const def0 = unitScale(c.doc);
  const sv = await c.number(t('pdf.prompt.scale', { default: +def0.toPrecision(6) }), { default: +def0.toPrecision(6) });
  const s = typeof sv === 'number' && sv > 0 && sv !== +def0.toPrecision(6) ? sv : def0;   // Enter keeps the exact true-size scale
  const ang = await c.angle(t('pic.prompt.angle'), { base: at, default: 0 });
  const a = typeof ang === 'number' ? ang : 0;
  const name = freePdfName(c.doc);
  c.doc.change('PDFATTACH', () => {
    c.doc.defineBlock(pdfBlock(name, { file: rec.name, page: pg.page, w: pg.w, h: pg.h, fade: 0, contrast: 50, mono: false }));
    c.doc.add({ type: 'insert', layer: c.doc.current.layer, color: null, block: name, x: at.x, y: at.y, sx: s, sy: s, rot: a });
  });
  c.host.redraw?.();
  c.print(t('pdf.attached', { file: rec.name, page: pg.page, w: +(pg.w * s).toPrecision(5), h: +(pg.h * s).toPrecision(5) }));
}, { help: () => t('pdf.help.attach') });

/**
 * A DWG names a PDF but not its page size, so its frame starts as an A4 guess (`sizeGuess`). Once the file is given, every such
 * frame takes the page's true size (one undo step). → how many blocks were corrected
 */
export async function fixPdfSizes(doc, rec) {
  let info;
  try { info = await pdfInfo(rec); } catch { return 0; }
  const todo = [];
  for (const b of doc.blocks.values()) {
    const fr = pdfFrame(b);
    if (fr && fr.pdf.sizeGuess && findPdf(doc, fr.pdf.file) === rec && info.sizes[fr.pdf.page - 1]) todo.push([b, fr, info.sizes[fr.pdf.page - 1]]);
  }
  if (!todo.length) return 0;
  doc.change('PDF', () => {
    for (const [b, fr, sz] of todo) {
      const { sizeGuess, ...rest } = fr.pdf;   // eslint-disable-line no-unused-vars
      const nb = pdfBlock(b.name, { ...rest, w: sz[0], h: sz[1] }, fr.pdf.clipped ? fr.pts.map((q) => ({ x: q.x, y: q.y })) : null);
      doc.defineBlock({ ...nb, entities: [nb.entities[0], ...b.entities.filter((e) => e !== fr)] });
    }
  });
  return todo.length;
}

def('PDF', [], async (c) => {
  const used = new Map();
  for (const b of c.doc.blocks.values()) { const fr = pdfFrame(b); if (fr) used.set(pdfKey(fr.pdf.file), fr.pdf.file); }
  if (!used.size) { c.print(t('pdf.none')); return; }
  const missing = [...used.values()].filter((f) => !findPdf(c.doc, f));
  c.print(t('pdf.list', { n: used.size, missing: missing.length }));
  for (const f of used.values()) c.print('  ' + t(findPdf(c.doc, f) ? 'pdf.row.loaded' : 'pdf.row.missing', { file: f }));
  if (!missing.length || !c.host.pickPdfs) return;
  const files = (await c.host.pickPdfs({ multiple: true })) || [];
  let n = 0;
  for (const f of files) {
    const k = pdfKey(f.name), stem = k.replace(/\.[a-z0-9]+$/, '');
    const target = missing.find((m) => pdfKey(m) === k) || missing.find((m) => { const s = pdfKey(m).replace(/\.[a-z0-9]+$/, ''); return s.length >= 3 && stem.includes(s); });
    if (!target) { c.print(t('pdf.unused', { file: f.name })); continue; }
    const rec = addPdf(c.doc, f.name, f.bytes);
    if (rec.error) { c.print(rec.error); continue; }
    if (pdfKey(target) !== k) pdfsOf(c.doc).set(pdfKey(target), rec);
    n++;
  }
  for (const rec of new Set([...pdfsOf(c.doc).values()])) await fixPdfSizes(c.doc, rec);
  if (n) c.host.redraw?.();
  c.print(t('pdf.added', { n }));
}, { noRepeat: true, help: () => t('pdf.help.files') });

def('PDFCLIP', [], async (c) => {
  const p = await c.entity(t('pdf.prompt.pick'));
  if (!p || p.option) return;
  const ref = c.doc.get(p.id ?? p);
  if (!isPdfRef(c.doc, ref)) { c.print(t('pdf.notunderlay')); return; }
  const blk = c.doc.blocks.get(ref.block), fr = pdfFrame(blk);
  const k = await c.keyword(t('pdf.prompt.clip'), { options: [opt('R', t('opt.rectangular')), opt('P', t('opt.polygonal')), opt('D', t('opt.delete'))], default: 'R' });
  const o = k?.option ?? k;
  if (!o) return;
  let pts = null;
  if (o === 'R') {
    const a = await c.point(t('pic.prompt.corner1'));
    if (!a || a.option) return;
    const b = await c.point(t('pic.prompt.corner2'), { base: a });
    if (!b || b.option) return;
    pts = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
  } else if (o === 'P') {
    pts = [];
    for (;;) {
      const q = await c.point(t(pts.length < 3 ? 'pic.prompt.vertex' : 'pic.prompt.vertex_or_enter'), { base: pts[pts.length - 1], none: pts.length >= 3 });
      if (!q) break;
      if (q.option) return;
      pts.push({ x: q.x, y: q.y });
    }
    if (pts.length < 3) return;
  }
  const inv = invert(insertMatrix(ref, blk));
  const local = pts ? pts.map((q) => mApply(inv, q)) : null;
  let shared = 0;
  for (const m of [c.doc.model, ...c.doc.layouts.map((l) => l.entities)]) for (const e of m.values()) if (e.type === 'insert' && e.block === blk.name) shared++;
  const name = shared > 1 ? freePdfName(c.doc) : blk.name;
  const { clipped, ...plain } = fr.pdf;   // eslint-disable-line no-unused-vars
  c.doc.change('PDFCLIP', () => {
    const nb = pdfBlock(name, plain, local);
    c.doc.defineBlock({ ...nb, entities: [nb.entities[0], ...blk.entities.filter((e) => e !== fr)] });
    if (name !== blk.name) c.doc.update(ref.id, { ...ref, block: name });
  });
  c.host.redraw?.();
  c.print(t(pts ? 'pdf.clipped' : 'pdf.unclipped'));
}, { help: () => t('pdf.help.clip') });

/** Change the underlay settings of a reference's block (a copy of its own when others share it). */
function changePdf(c, ref, patch, label) {
  const blk = c.doc.blocks.get(ref.block), fr = pdfFrame(blk);
  let shared = 0;
  for (const m of [c.doc.model, ...c.doc.layouts.map((l) => l.entities)]) for (const e of m.values()) if (e.type === 'insert' && e.block === blk.name) shared++;
  const name = shared > 1 ? freePdfName(c.doc) : blk.name;
  c.doc.change(label, () => {
    const nf = { ...fr, pdf: { ...fr.pdf, ...patch } };
    c.doc.defineBlock({ name, base: { ...blk.base }, entities: blk.entities.map((e) => (e === fr ? nf : e)) });
    if (name !== blk.name) c.doc.update(ref.id, { ...ref, block: name });
  });
  c.host.redraw?.();
}

def('PDFADJUST', [], async (c) => {
  const p = await c.entity(t('pdf.prompt.pick'));
  if (!p || p.option) return;
  const ref = c.doc.get(p.id ?? p);
  if (!isPdfRef(c.doc, ref)) { c.print(t('pdf.notunderlay')); return; }
  const cur = pdfFrame(c.doc.blocks.get(ref.block)).pdf;
  const k = await c.keyword(t('pdf.prompt.adjust'), { options: [opt('F', t('pdf.opt.fade')), opt('C', t('pdf.opt.contrast')), opt('M', t('pdf.opt.mono')), opt('O', t('pdf.opt.onoff'))], default: 'F' });
  const o = k?.option ?? k;
  if (!o) return;
  if (o === 'F') {
    const v = await c.number(t('pdf.prompt.fade'), { default: cur.fade || 0 });
    if (!Number.isFinite(v)) return;
    changePdf(c, ref, { fade: Math.max(0, Math.min(80, Math.round(v))) }, 'PDFADJUST');
  } else if (o === 'C') {
    const v = await c.number(t('pdf.prompt.contrast'), { default: cur.contrast ?? 50 });
    if (!Number.isFinite(v)) return;
    changePdf(c, ref, { contrast: Math.max(0, Math.min(100, Math.round(v))) }, 'PDFADJUST');
  } else if (o === 'M') changePdf(c, ref, { mono: !cur.mono }, 'PDFADJUST');
  else if (o === 'O') changePdf(c, ref, { off: !cur.off }, 'PDFADJUST');
  c.print(t('pdf.adjusted'));
}, { help: () => t('pdf.help.adjust') });

def('PDFLAYERS', [], async (c) => {
  const p = await c.entity(t('pdf.prompt.pick'));
  if (!p || p.option) return;
  const ref = c.doc.get(p.id ?? p);
  if (!isPdfRef(c.doc, ref)) { c.print(t('pdf.notunderlay')); return; }
  const fr = pdfFrame(c.doc.blocks.get(ref.block)), rec = findPdf(c.doc, fr.pdf.file);
  if (!rec) { c.print(t('pdf.nofile', { file: fr.pdf.file })); return; }
  let info;
  try { info = await pdfInfo(rec); } catch (err) { c.print(t('pdf.unreadable', { file: rec.name, why: String(err?.message || err).slice(0, 160) })); return; }
  if (!info.layers.length) { c.print(t('pdf.nolayers')); return; }
  const set = fr.pdf.layers || {};
  const isOn = (l) => (l.id in set ? !!set[l.id] : l.on);
  info.layers.forEach((l, i) => c.print('  ' + (i + 1) + '. ' + l.name + (isOn(l) ? '' : '  (' + t('pdf.layer.off') + ')')));
  const v = await c.number(t('pdf.prompt.layer'), { default: 0 });
  if (!Number.isFinite(v) || v < 1 || v > info.layers.length) return;
  const l = info.layers[Math.round(v) - 1];
  const now = !isOn(l);
  changePdf(c, ref, { layers: { ...set, [l.id]: now } }, 'PDFLAYERS');
  c.print(t(now ? 'pdf.layer.shown' : 'pdf.layer.hidden', { name: l.name }));
}, { help: () => t('pdf.help.layers') });

// ------------------------------------------------------------------------------------------------------ PDFIMPORT

const sameP = (a, b, e = 1e-6) => Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e;
/** Is this one cubic an arc of a circle (within tolerance)? → { cx, cy, r, a0, a1 (CCW radians) } | null */
export function cubicArc(p0, c1, c2, p3, tol = 0.002) {
  const at = (t) => { const u = 1 - t; return [u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]]; };
  const m = at(0.5);
  const circ = circleThrough(p0, m, p3);
  if (!circ) return null;
  for (const t0 of [0.25, 0.75, 0.1, 0.9]) { const q = at(t0); if (Math.abs(Math.hypot(q[0] - circ.cx, q[1] - circ.cy) - circ.r) > tol * circ.r) return null; }
  // direction: the angle from p0 through m to p3 along the shorter way
  const a0 = Math.atan2(p0[1] - circ.cy, p0[0] - circ.cx), am = Math.atan2(m[1] - circ.cy, m[0] - circ.cx), a1 = Math.atan2(p3[1] - circ.cy, p3[0] - circ.cx);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = norm(am - a0) < norm(a1 - a0);
  return ccw ? { ...circ, a0: norm(a0), a1: norm(a1) } : { ...circ, a0: norm(a1), a1: norm(a0) };
}
function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  return Number.isFinite(r) && r > 1e-9 ? { cx, cy, r } : null;
}

/**
 * A page's vectors → drawing objects. `m` maps page points to the drawing ([a b c d e f]); layer names come from `names`
 * ({ lines, fills, text }); returns { entities: [...], counts: { lines, arcs, circles, polys, fills, texts }, tooMany }.
 * Straight runs become lines (two points) or polylines; a closed run of four quarter-circle cubics a circle; one circular
 * cubic an arc; other curves are flattened into the polyline (as a run of short segments); filled shapes a solid hatch.
 */
export function importPage(vec, m, names, { maxObjects = 200000 } = {}) {
  const P = (x, y) => mApply(m, { x, y });
  const flip = (m[0] * m[3] - m[1] * m[2]) < 0;
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1, rot0 = Math.atan2(m[1], m[0]);
  const entities = [], counts = { lines: 0, arcs: 0, circles: 0, polys: 0, fills: 0, texts: 0 };
  let tooMany = false;
  const add = (e) => { if (entities.length >= maxObjects) { tooMany = true; return false; } entities.push(e); return true; };
  const colorFor = (hex) => (!hex || hex === '#000000' || hex === '#ffffff' ? 0 : hex);   // black/white = the layer's own ink (7 = white/black)
  for (const sh of vec.shapes) {
    if (tooMany) break;
    const lw = Math.max(0, sh.lw * scale);
    for (const sub of sh.subs) {
      const ops = sub.ops;
      const isBox = ops.length >= 4 && ops.every((o) => o[0] !== 'C');
      // the outline as drawing points, curves flattened
      const pts = [];
      let cursor = null;
      for (const o of ops) {
        if (o[0] === 'M' || o[0] === 'L') { const q = P(o[1], o[2]); pts.push({ x: q.x, y: q.y, b: 0 }); cursor = [o[1], o[2]]; }
        else {
          const p0 = cursor;
          for (let s = 1; s <= 10; s++) {
            const t0 = s / 10, u = 1 - t0;
            const x = u * u * u * p0[0] + 3 * u * u * t0 * o[1] + 3 * u * t0 * t0 * o[3] + t0 * t0 * t0 * o[5];
            const y = u * u * u * p0[1] + 3 * u * u * t0 * o[2] + 3 * u * t0 * t0 * o[4] + t0 * t0 * t0 * o[6];
            const q = P(x, y); pts.push({ x: q.x, y: q.y, b: 0 });
          }
          cursor = [o[5], o[6]];
        }
      }
      if (pts.length < 2) continue;
      if (sh.fill && (sub.closed || sh.subs.length)) {
        if (pts.length >= 3 && add({ type: 'hatch', layer: names.fills, color: colorFor(sh.fill), loops: [pts.flatMap((q) => [q.x, q.y])], solid: true })) counts.fills++;
      }
      if (!sh.stroke) continue;
      const color = colorFor(sh.stroke);
      const base = { layer: names.lines, color, ...(lw > 0 ? { lw: Math.round(lw * 100) / 100 } : {}) };
      void isBox;
      // a circle (four circular quarter cubics, closed) / an arc (one circular cubic)
      const cubics = ops.filter((o) => o[0] === 'C').length;
      if (cubics === ops.length - 1 && cubics >= 1) {
        let cur = [ops[0][1], ops[0][2]], arcs = [], okAll = true;
        for (const o of ops.slice(1)) { const a = cubicArc(cur, [o[1], o[2]], [o[3], o[4]], [o[5], o[6]]); if (!a) { okAll = false; break; } arcs.push(a); cur = [o[5], o[6]]; }
        if (okAll) {
          const same = arcs.every((a) => Math.abs(a.r - arcs[0].r) < 1e-3 * arcs[0].r && Math.hypot(a.cx - arcs[0].cx, a.cy - arcs[0].cy) < 1e-3 * arcs[0].r);
          if (same) {
            const c0 = P(arcs[0].cx, arcs[0].cy), r = arcs[0].r * scale;
            const span = arcs.reduce((s, a) => s + (((a.a1 - a.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), 0);
            if (arcs.length >= 3 && sub.closed || Math.abs(span - 2 * Math.PI) < 1e-3) { if (add({ type: 'circle', ...base, cx: c0.x, cy: c0.y, r })) counts.circles++; continue; }
            if (arcs.length === 1) {
              const a = arcs[0];
              const a0 = flip ? Math.PI - a.a1 + rot0 : a.a0 + rot0, a1 = flip ? Math.PI - a.a0 + rot0 : a.a1 + rot0;
              const n2 = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
              if (add({ type: 'arc', ...base, cx: c0.x, cy: c0.y, r, a0: n2(a0), a1: n2(a1) })) counts.arcs++;
              continue;
            }
          }
        }
      }
      if (pts.length === 2 && !sub.closed) { if (add({ type: 'line', ...base, x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y })) counts.lines++; continue; }
      if (add({ type: 'poly', ...base, pts, closed: !!sub.closed })) counts.polys++;
    }
  }
  for (const tx of vec.texts) {
    if (tooMany) break;
    const q = P(tx.x, tx.y);
    if (add({ type: 'text', layer: names.text, color: 0, x: q.x, y: q.y, h: tx.h * scale / FONT_EM, rot: ((tx.rot + rot0 + (flip ? 0 : 0)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), s: tx.s, ha: 'left', va: 'baseline' })) counts.texts++;
  }
  return { entities, counts, tooMany };
}

def('PDFIMPORT', ['PDFIM'], async (c) => {
  const rec = await pickPdf(c);
  if (!rec) return;
  const pg = await askPage(c, rec);
  if (!pg) return;
  const at = await c.point(t('pdf.prompt.insert', { file: rec.name }));
  if (!at || at.option) return;
  const def0 = unitScale(c.doc);
  // scale: Enter = the page's true size; a number = drawing units per point; P = two points of the page and the real distance
  const k = await c.number(t('pdf.prompt.importscale', { default: +def0.toPrecision(6) }), { default: +def0.toPrecision(6), options: [opt('P', t('pdf.opt.twopoints'))] });
  let s = def0, twoPoints = false;
  if (k && k.option === 'P') twoPoints = true; else if (typeof k === 'number' && k > 0 && k !== +def0.toPrecision(6)) s = k;
  let vec;
  try { vec = await pageVector(rec, pg.page); } catch (err) { c.print(t('pdf.unreadable', { file: rec.name, why: String(err?.message || err).slice(0, 160) })); return; }
  if (!vec.shapes.length && !vec.texts.length) { c.print(t('pdf.import.empty', { image: vec.images })); return; }
  const wasEmpty = c.doc.count() === 0;
  const stem = rec.name.replace(/\.pdf$/i, '').slice(0, 60) || 'PDF';
  const names = { lines: stem, fills: stem + '-FILL', text: stem + '-TEXT' };
  // one undo step: the layers and every object
  let built = null;
  const place = (scale) => importPage(vec, [scale, 0, 0, scale, at.x, at.y], names);
  built = place(s);
  if (twoPoints) {
    // the page is drawn first at true size; the two points are picked on what was drawn, then everything is scaled about the insertion point
    c.doc.change('PDFIMPORT', () => addAll(c, built, names));
    c.host.redraw?.();
    const p1 = await c.point(t('pdf.prompt.known1'));
    if (!p1 || p1.option) return keepAll(c, built);
    const p2 = await c.point(t('pdf.prompt.known2'), { base: p1 });
    if (!p2 || p2.option) return keepAll(c, built);
    const real = await c.distance(t('pdf.prompt.known_real'), { base: p1 });
    const cur = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (typeof real === 'number' && real > 0 && cur > 0) {
      const f = real / cur;
      c.doc.change('PDFIMPORT', () => { for (const id of built.ids) { const e = c.doc.get(id); if (e) c.doc.update(id, scaleEntity(e, at, f)); } });
      s *= f;
    }
  } else {
    c.doc.change('PDFIMPORT', () => addAll(c, built, names));
  }
  c.host.redraw?.();
  if (wasEmpty) c.host.zoomExtents?.();   // an import into an empty drawing shows what it made
  const n = built.counts;
  c.print(t('pdf.imported', { file: rec.name, page: pg.page, lines: n.lines, polys: n.polys, arcs: n.arcs + n.circles, fills: n.fills, texts: n.texts }));
  if (built.tooMany) c.print(t('pdf.import.toomany'));
  if (vec.truncated) c.print(t('pdf.import.truncated'));
  if (vec.images) c.print(t('pdf.import.images', { n: vec.images }));
}, { help: () => t('pdf.help.import') });

function addAll(c, built, names) {
  const doc = c.doc;
  for (const nm of [names.lines, names.fills, names.text]) doc.layer(nm);
  built.ids = [];
  for (const e of built.entities) { const added = doc.add(e); built.ids.push(added?.id ?? added); }
}
function keepAll() { /* the import stays as drawn at true size */ }
function scaleEntity(e, about, f) {
  const sx = (x) => about.x + (x - about.x) * f, sy = (y) => about.y + (y - about.y) * f;
  switch (e.type) {
    case 'line': return { ...e, x1: sx(e.x1), y1: sy(e.y1), x2: sx(e.x2), y2: sy(e.y2) };
    case 'circle': case 'arc': return { ...e, cx: sx(e.cx), cy: sy(e.cy), r: e.r * f };
    case 'poly': return { ...e, pts: e.pts.map((p) => ({ ...p, x: sx(p.x), y: sy(p.y) })) };
    case 'hatch': return { ...e, loops: e.loops.map((l) => l.map((v, i) => (i % 2 ? sy(v) : sx(v)))) };
    case 'text': return { ...e, x: sx(e.x), y: sy(e.y), h: e.h * f };
    default: return e;
  }
}
