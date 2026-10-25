/* SPDX-License-Identifier: Apache-2.0 */
/**
 * scan.js — scanned drawings in CadCraft (0.7 LC.6; session `trace`). The model beside pictures.js; DOM-free (scan-ui.js has the
 * screen, scan-cmd.js the commands). The engine is cc-raster (raster/, a byte-identical copy of lib/raster).
 *
 * A scanned sheet is a picture (an "*I<n>" block, pictures.js) whose file is a PNG. Every clean-up step writes a NEW PNG
 * with the drawing and points the picture at it, so one command is one undo step (the block's definition is what undo
 * restores) and nothing is lost: `doc.scans` keeps, per working file, the ORIGINAL bytes as they came in (a TIFF, a JPEG, a
 * PDF's page) with the steps taken since. A saved DWG holds IMAGE + IMAGEDEF for the current picture and names its file; saving
 * also writes that PNG (the cleaned picture) beside the drawing: the records are marked `pasted`, which pastepic.js picturesToSave takes.
 *
 *   scansOf(doc)                         Map(pictureKey → { original: { name, format, page, pages, bytes }, steps: [string], dpi })
 *   scanGeom(doc, ref)                   → { ref, block, frame, pic, rec, toDraw(px, py), toPixel(x, y), pixel (drawing units a pixel) } | null
 *   await decodePicture(rec)             → { w, h, channels, data } (cached per record)
 *   await attachScanFile(doc, file, { page, dpi, decodeJpeg, pdf })  → { rec, img, original, pages } (the working PNG stored)
 *   await replacePicture(doc, ref, img, { tag, step, patch }) → the new record; ONE undo step (call inside no other change)
 *   freeName(doc, stem, tag)             a picture file name no stored file has
 *   arcThrough(p1, p2, p3)               → { cx, cy, r, a0, a1 } the counterclockwise arc through three points (y up), or null
 *   traceEntities(geom, result, { layer, color, leftLayer, leftovers }) → { entities, left } in drawing coordinates
 */
import { pictureKey, picturesOf, addPicture, pictureBlock, pictureFrame, freePictureName } from './pictures.js';
import { insertMatrix, mApply } from './geom.js';
import { readScan, sniffScan, scanPages, writePng, RasterError } from './raster/index.js';
import { t } from './i18n.js';

export function scansOf(doc) { if (!(doc.scans instanceof Map)) doc.scans = new Map(); return doc.scans; }

const decoded = new WeakMap();   // stored record → Promise<{ w, h, channels, data }>
export function decodePicture(rec, opts = {}) {
  let p = decoded.get(rec);
  if (!p) { p = readScan(rec.bytes, 0, opts); decoded.set(rec, p); p.catch(() => decoded.delete(rec)); }
  return p;
}

/** Everything the commands need to turn pixels into drawing coordinates for one picture reference. */
export function scanGeom(doc, ref) {
  if (!ref || ref.type !== 'insert') return null;
  const block = doc.blocks.get(ref.block), frame = pictureFrame(block);
  if (!frame || frame.ole) return null;
  const pic = frame.pic, m = insertMatrix(ref, block), W = (x, y) => mApply(m, { x, y });
  const bp = (px, py) => ({ x: pic.x + pic.ux * px + pic.vx * (pic.h - py), y: pic.y + pic.uy * px + pic.vy * (pic.h - py) });
  const det = pic.ux * pic.vy - pic.uy * pic.vx, dm = m[0] * m[3] - m[1] * m[2];
  const toDraw = (px, py) => { const b = bp(px, py); return W(b.x, b.y); };
  const inv = (x, y) => {   // drawing → block → pixel
    const dd = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(dd) < 1e-300) return { x: 0, y: 0 };
    const bx = (m[3] * (x - m[4]) - m[2] * (y - m[5])) / dd, by = (-m[1] * (x - m[4]) + m[0] * (y - m[5])) / dd;
    const dx = bx - pic.x, dy = by - pic.y;
    const a = (dx * pic.vy - dy * pic.vx) / det, b = (pic.ux * dy - pic.uy * dx) / det;   // along the width, up (pixels)
    return { x: a, y: pic.h - b };
  };
  const pixel = Math.hypot(m[0] * pic.ux + m[2] * pic.uy, m[1] * pic.ux + m[3] * pic.uy);
  return { ref, block, frame, pic, rec: findRecord(doc, pic.file), toDraw, toPixel: inv, pixel, mirrored: (det * dm) < 0 };
}

function findRecord(doc, file) {
  const m = picturesOf(doc), k = pictureKey(file);
  if (m.has(k)) return m.get(k);
  const stem = k.replace(/\.[a-z0-9]+$/, '');
  for (const [key, rec] of m) if (stem.length >= 3 && key.includes(stem)) return rec;
  return null;
}

function sameBytes(a, b) { if (a === b) return true; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

/** A picture file name no stored file has: "sheet-deskew.png", "sheet-deskew-2.png", … */
export function freeName(doc, stem, tag) {
  const base = String(stem).replace(/\.[a-z0-9]+$/i, '').replace(/-(deskew|clean|erase|crop|scan)(-\d+)?$/i, '');
  const m = picturesOf(doc);
  let n = 1, name = base + '-' + tag + '.png';
  while (m.has(pictureKey(name))) name = base + '-' + tag + '-' + (++n) + '.png';
  return name;
}

/**
 * A scan file → the working picture stored with the drawing. `file` = { name, bytes }; a PDF page comes in through `pdf`
 * ({ pages(rec) → n, render(rec, page, dpi) → { w, h, channels, data } }). → { rec, img, original, pages }.
 */
export async function attachScanFile(doc, file, { page = 0, dpi = 0, decodeJpeg = null, pdf = null } = {}) {
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
  const format = sniffScan(bytes) || (pdf && /%PDF-/.test(new TextDecoder('latin1').decode(bytes.subarray(0, 1024))) ? 'pdf' : null);
  if (!format) throw new RasterError('not_scan', file.name);
  let img, pages;
  if (format === 'pdf') {
    const rec = { name: file.name, bytes };
    pages = await pdf.pages(rec);
    if (page >= pages) throw new RasterError('page', String(page + 1));
    img = await pdf.render(rec, page, dpi || 300);
    img.dpi = { x: dpi || 300, y: dpi || 300 };
  } else {
    pages = scanPages(bytes);
    img = await readScan(bytes, page, { decodeJpeg });
  }
  // a PNG goes in as it is; everything else (a TIFF, a JPEG the page can show anyway, a PDF's page) becomes a PNG we wrote
  let wbytes, name = file.name.split(/[\\/]/).pop();
  if (format === 'png' && page === 0) wbytes = bytes;
  else { wbytes = await writePng(img, img.dpi ? { dpi: img.dpi } : {}); name = name.replace(/\.[a-z0-9]+$/i, '') + (pages > 1 ? '-p' + (page + 1) : '') + '.png'; }
  // a name no stored picture has (two sheets can both be called scan.png): one sheet must never replace another's file
  const stored0 = picturesOf(doc).get(pictureKey(name));
  if (stored0 && stored0.bytes !== wbytes && !sameBytes(stored0.bytes, wbytes)) {
    const stem = name.replace(/\.[a-z0-9]+$/i, '');
    let n = 2;
    while (picturesOf(doc).has(pictureKey(stem + '-' + n + '.png'))) n++;
    name = stem + '-' + n + '.png';
  }
  const stored = picturesOf(doc).get(pictureKey(name));
  const rec = stored && sameBytes(stored.bytes, wbytes) ? stored : addPicture(doc, name, wbytes);
  if (rec.error) throw new RasterError('picture', rec.error);
  rec.pasted = true;   // made here: saving the drawing writes this file beside it (pastepic.js picturesToSave), as a DWG names it but does not hold it
  decoded.set(rec, Promise.resolve({ w: img.w, h: img.h, channels: img.channels, data: img.data, bilevel: img.bilevel }));
  scansOf(doc).set(pictureKey(rec.name), { original: { name: file.name, format, page: page + 1, pages, bytes }, steps: [], dpi: img.dpi || null });
  return { rec, img, original: file.name, pages, format };
}

/**
 * Point a picture at new pixels: stores a PNG named from `tag`, defines the picture block again (a block other references
 * share is copied first, as IMAGECLIP does), and notes the step. One undo step. `patch` changes the picture's geometry (crop).
 */
export async function replacePicture(doc, ref, img, { tag, step, patch = {} }) {
  const g = scanGeom(doc, ref);
  if (!g) throw new RasterError('not_picture');
  const bytes = await writePng(img, g.rec && scansOf(doc).get(pictureKey(g.rec.name))?.dpi ? { dpi: scansOf(doc).get(pictureKey(g.rec.name)).dpi } : {});
  const name = freeName(doc, g.pic.file, tag);
  const rec = addPicture(doc, name, bytes);
  if (rec.error) throw new RasterError('picture', rec.error);
  rec.pasted = true;   // see attachScanFile
  decoded.set(rec, Promise.resolve({ w: img.w, h: img.h, channels: img.channels || 1, data: img.data }));
  const prev = scansOf(doc).get(pictureKey(g.rec?.name || g.pic.file));
  if (prev) scansOf(doc).set(pictureKey(name), { ...prev, steps: [...prev.steps, step] });
  let shared = 0;
  for (const mp of [doc.model, ...doc.layouts.map((l) => l.entities)]) for (const e of mp.values()) if (e.type === 'insert' && e.block === g.block.name) shared++;
  for (const b of doc.blocks.values()) for (const e of b.entities) if (e.type === 'insert' && e.block === g.block.name) shared++;
  const blockName = shared > 1 ? freePictureName(doc) : g.block.name;
  const { clipped, ...plain } = g.pic;   // eslint-disable-line no-unused-vars
  const pic = { ...plain, ...patch, file: name, w: img.w, h: img.h, scan: true };
  doc.change(step, () => {
    const nb = pictureBlock(blockName, pic, null);
    doc.defineBlock({ ...nb, entities: [nb.entities[0], ...g.block.entities.filter((e) => e !== g.frame)] });
    if (blockName !== g.block.name) doc.update(ref.id, { ...ref, block: blockName });
  });
  return rec;
}

/** The counterclockwise arc through three points (y up). */
export function arcThrough(p1, p2, p3) {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy), TAU = Math.PI * 2;
  const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);   // > 0: the three points run counterclockwise
  const ang = (p) => ((Math.atan2(p.y - uy, p.x - ux) % TAU) + TAU) % TAU;
  return cross > 0 ? { cx: ux, cy: uy, r, a0: ang(p1), a1: ang(p3) } : { cx: ux, cy: uy, r, a0: ang(p3), a1: ang(p1) };
}

/** A trace result (pixels) → drawing objects. Lines and arcs on `layer`; with `leftovers`, the boxes left as raster on `leftLayer`. */
export function traceEntities(g, result, { layer, leftLayer = null, leftovers = false } = {}) {
  const out = [], P = (x, y) => g.toDraw(x, y);
  for (const l of result.lines) { const a = P(l.x1, l.y1), b = P(l.x2, l.y2); out.push({ type: 'line', layer, color: null, x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
  for (const a of result.arcs) {
    const TAU = Math.PI * 2;
    const c = P(a.cx, a.cy), r = a.r * g.pixel;
    if (a.a1 - a.a0 >= TAU - 1e-6) { out.push({ type: 'circle', layer, color: null, cx: c.x, cy: c.y, r }); continue; }
    const m = (a.a0 + a.a1) / 2;
    const s = P(a.sx, a.sy), e = P(a.ex, a.ey), md = P(a.cx + a.r * Math.cos(m), a.cy + a.r * Math.sin(m));
    const arc = arcThrough(s, md, e);
    if (arc) out.push({ type: 'arc', layer, color: null, cx: arc.cx, cy: arc.cy, r: arc.r, a0: arc.a0, a1: arc.a1 });
  }
  const left = [];
  if (leftovers && leftLayer) {
    for (const b of [...result.left.text, ...result.left.hatch]) {
      const ps = [P(b.x0, b.y0), P(b.x1, b.y0), P(b.x1, b.y1), P(b.x0, b.y1)];
      left.push({ type: 'poly', layer: leftLayer, color: null, closed: true, pts: ps.map((p) => ({ x: p.x, y: p.y, b: 0 })) });
    }
  }
  return { entities: out, left };
}

/** Words for a library error. */
export const errorText = (e) => (e instanceof RasterError ? t('scan.err.' + e.key, { detail: e.detail }) : String(e?.message || e));
