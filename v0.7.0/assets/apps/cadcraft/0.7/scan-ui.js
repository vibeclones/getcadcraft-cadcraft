/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — canvas and file-type names; the words are in scan-cmd.js and the language file. */
/**
 * scan-ui.js — scanned drawings on screen (0.7 LC.6; session `trace`): the file chooser SCANATTACH uses, a PDF page drawn as a
 * picture (pdf.js through pdfhost.js, eval and scripting off), the browser's own JPEG decoder for the files raster/ does not read
 * (progressive), and snapping to the lines of a scanned sheet (RASTERSNAP): while the pointer is over a sheet, the tile under it
 * is traced (raster/snap.js, cached) and its ends, middles, corners and crossings join the object snaps, drawn with the glyphs
 * CadCraft already uses.
 *
 *   installScanUi({ root, view, doc, host }) → { pick, forget }     sets host.pickScans, host.scanPdf, host.decodeJpeg,
 *                                                                   host.setScanSnap / getScanSnap, wraps view.snapUnder
 */
import { findPicture, pictureKey } from './pictures.js';
import { decodePicture, scansOf } from './scan.js';
import { RasterSnap, greyToBitmap, toGrey, threshold, MAX_BYTES } from './raster/index.js';
import { pdfInfo, renderRegion } from './pdfhost.js';

const KEY = 'cadcraft.scansnap';
const MAX_PDF_PIXELS = 64e6;

export function installScanUi({ root, view, doc, host }) {
  // ---- files
  function pick(multiple = false) {
    return new Promise((done) => {
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.png,.jpg,.jpeg,.tif,.tiff,.pdf,image/png,image/jpeg,image/tiff,application/pdf', multiple, className: 'visually-hidden', tabIndex: -1 });
      inp.setAttribute('aria-hidden', 'true');
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; inp.remove(); done(v); };
      inp.addEventListener('cancel', () => finish([]));
      inp.addEventListener('change', async () => {
        const out = [];
        for (const f of inp.files) { if (f.size > MAX_BYTES) { host.print?.(f.name + ': ' + f.size + ' bytes is more than CadCraft reads'); continue; } out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); }
        finish(out);
      });
      root.append(inp);
      inp.click();
    });
  }
  host.pickScans = ({ multiple = false } = {}) => pick(multiple);

  // ---- the browser's JPEG decoder (progressive files)
  host.decodeJpeg = async (bytes) => {
    const bm = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bm.width, bm.height) : Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, bm.width, bm.height); ctx.drawImage(bm, 0, 0);
    return fromRgba(ctx.getImageData(0, 0, bm.width, bm.height));
  };

  // ---- a PDF page as a picture
  host.scanPdf = {
    pages: async (rec) => (await pdfInfo(rec)).pages,
    render: async (rec, page, dpi) => {
      const info = await pdfInfo(rec), [w, h] = info.sizes[page];
      const scale = Math.min(dpi / 72, Math.sqrt(MAX_PDF_PIXELS / (w * h)));
      const canvas = await renderRegion(rec, page + 1, { scale, x0: 0, y0: 0, w, h });
      const out = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(canvas.width, canvas.height) : Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
      const ctx = out.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height); ctx.drawImage(canvas, 0, 0);
      const img = fromRgba(ctx.getImageData(0, 0, out.width, out.height));
      img.dpi = { x: scale * 72, y: scale * 72 };
      return img;
    },
  };

  // ---- snapping to raster lines
  let on = true;
  try { on = localStorage.getItem(KEY) !== '0'; } catch { /* storage blocked */ }
  host.getScanSnap = () => on;
  host.setScanSnap = (v) => { on = !!v; try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* storage blocked */ } };
  const snaps = new WeakMap();   // stored record → { state: 'loading' | 'no' | 'ready', snap }
  function prepare(rec) {
    let s = snaps.get(rec);
    if (s) return s;
    s = { state: 'loading', snap: null };
    snaps.set(rec, s);
    decodePicture(rec, { decodeJpeg: host.decodeJpeg }).then((img) => {
      // a sheet that came in through SCANATTACH is thresholded as it is; any other picture only if it already is black and white
      // (a photo or a logo is not a drawing to snap to)
      const scan = scansOf(doc).has(pictureKey(rec.name));
      if (img.channels === 1 && isBilevel(img)) { s.snap = new RasterSnap(greyToBitmap(toGrey(img), 128)); s.state = 'ready'; }
      else if (scan) { s.snap = new RasterSnap(threshold(toGrey(img), { mode: 'auto' })); s.state = 'ready'; }
      else s.state = 'no';
    }, () => { s.state = 'no'; });
    return s;
  }
  const prev = view.snapUnder;
  view.snapUnder = (pt, r, kinds) => {
    const out = prev ? [...(prev(pt, r, kinds) || [])] : [];
    if (!on || !kinds || !(kinds.has('end') || kinds.has('mid') || kinds.has('int') || kinds.has('cen'))) return out;
    const list = view.ensureCache().pictures;
    if (!list || !list.length) return out;
    const want = { end: kinds.has('end'), mid: kinds.has('mid'), int: kinds.has('int'), cen: kinds.has('cen') };
    for (const p of list) {
      const q = p.place, det = q.ux * q.vy - q.uy * q.vx;
      if (Math.abs(det) < 1e-300) continue;
      const dx = pt.x - q.x, dy = pt.y - q.y, a = (dx * q.vy - dy * q.vx) / det, b = (q.ux * dy - q.uy * dx) / det;
      const size = Math.hypot(q.ux, q.uy), rpx = r / size;
      if (a < -rpx || b < -rpx || a > q.w + rpx || b > q.h + rpx || rpx < 1.5) continue;
      const rec = findPicture(doc, p.file);
      if (!rec) continue;
      const s = prepare(rec);
      if (s.state !== 'ready') continue;
      const hit = s.snap.near(a, q.h - b, Math.min(rpx, 40), want);
      if (hit) out.push({ kind: hit.kind, x: q.x + q.ux * hit.x + q.vx * (q.h - hit.y), y: q.y + q.uy * hit.x + q.vy * (q.h - hit.y) });
    }
    return out;
  };
  return { pick, forget: () => {} };
}

function fromRgba(id) {
  const { width: w, height: h, data } = id;
  let grey = true;
  for (let i = 0; i < data.length; i += 4) if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) { grey = false; break; }
  const ch = grey ? 1 : 3, out = new Uint8Array(w * h * ch);
  for (let i = 0, o = 0; i < w * h; i++) { if (grey) out[o++] = data[i * 4]; else { out[o++] = data[i * 4]; out[o++] = data[i * 4 + 1]; out[o++] = data[i * 4 + 2]; } }
  return { w, h, channels: ch, data: out };
}
function isBilevel(img) {
  const d = img.data, step = Math.max(1, Math.floor(d.length / 8192));
  for (let i = 0; i < d.length; i += step) if (d[i] > 8 && d[i] < 247) return false;
  return true;
}
