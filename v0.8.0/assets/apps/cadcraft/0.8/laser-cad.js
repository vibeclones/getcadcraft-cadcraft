/* SPDX-License-Identifier: Apache-2.0 */
/**
 * laser-cad.js — CadCraft's Laser panel (0.7 SU.772; session `laser-cad` mounting make-07's lib/laser panel, a copy in
 * laser/ written by tools/laser/sync.mjs). Command LASER (View › More › Laser…). A panel over the drawing, as Align and
 * distribute: the drawing stays live, and the preview follows every edit. The settings are kept in the drawing (`doc.meta.laser`,
 * each change one undo step).
 *
 *   drawingInput(doc, { only, gray, onPicture }) → { shapes, pictures, layers, skipped, mmPer }   DOM-free (gray is the caller's):
 *     the model's objects on layers that show (blocks expanded; an object on layer 0 inside a block takes the reference's layer),
 *     in millimetres (the drawing's units; a unitless drawing counts as mm, mmPer = null then):
 *       line, arc, circle, polyline (arcs kept as bulges), ellipse, spline → paths (open, or closed when they end where they start)
 *       hatch → its closed boundary loops · picture (pictures.js) → { layer, x, y, w, h, pw, ph, gray } when it lies square
 *     skipped = { kind: count } of what is not sent: text, dimension, leader, point, xline, picture-turned, picture-missing,
 *     picture-loading; only = a Set of ids (the selection) or null; gray(rec) → { pw, ph, gray } | null (not loaded yet)
 *   installLaser({ stage, doc, host, el, t, print, ask, focusCommandLine }) → { open(), close(), node, panel }
 *     sets nothing on host itself: cadcraft.js keeps it as host.laserUi (loaded on first use by host.laserPanel)
 */
import { laserPanel } from './laser/laser-panel.js';
import { flatten } from './laser/laser-geom.js';
import { prims, insertMatrix, mMul, mApply, TAU } from './geom.js';
import { pictureFrame, findPicture, pictureBitmap } from './pictures.js';
import { mmPerDrawingUnit } from './units.js';

const EPS = 1e-6;
const SKIP = { text: 'text', mtext: 'text', attdef: 'text', dim: 'dimension', mleader: 'leader', leader: 'leader', point: 'point', xline: 'xline', ray: 'xline' };
const near = (a, b) => Math.abs(a.x - b.x) <= EPS * Math.max(1, Math.abs(a.x)) && Math.abs(a.y - b.y) <= EPS * Math.max(1, Math.abs(a.y));
const primStart = (p) => (p.k === 'L' ? { x: p.x1, y: p.y1 } : { x: p.cx + p.r * Math.cos(p.a0), y: p.cy + p.r * Math.sin(p.a0) });
const primEnd = (p) => (p.k === 'L' ? { x: p.x2, y: p.y2 } : { x: p.cx + p.r * Math.cos(p.a1), y: p.cy + p.r * Math.sin(p.a1) });

/** Primitives (geom.js L / A, in order) → paths [{ pts: [{x, y, b?}], closed }]: joined while each starts where the last ended. */
export function chainPrims(list) {
  const out = [];
  let cur = null;
  const finish = () => {
    if (!cur) return;
    const pts = cur.pts;
    if (pts.length > 2 && near(pts[0], pts[pts.length - 1])) { pts.pop(); cur.closed = true; }
    if (pts.length >= 2) out.push(cur);
    cur = null;
  };
  for (const p of list) {
    if (p.box) continue;   // text boxes, arrowheads: for picking only
    if (p.k === 'A' && (p.full || p.a1 - p.a0 >= TAU - 1e-9)) {   // a whole circle: two half arcs, closed
      finish();
      out.push({ pts: [{ x: p.cx + p.r, y: p.cy, b: 1 }, { x: p.cx - p.r, y: p.cy, b: 1 }], closed: true });
      continue;
    }
    const s = primStart(p), e = primEnd(p);
    if (!cur || !near(cur.pts[cur.pts.length - 1], s)) { finish(); cur = { pts: [{ x: s.x, y: s.y }], closed: false }; }
    const last = cur.pts[cur.pts.length - 1];
    if (p.k === 'A') last.b = Math.tan((p.a1 - p.a0) / 4);
    cur.pts.push({ x: e.x, y: e.y });
  }
  finish();
  return out;
}

/** A path through the matrix m; arcs stay arcs while m keeps shapes (a mirror turns their bulges round), else they are flattened. */
function txPath(path, m, tol) {
  const [a, b, c, d] = m, det = a * d - b * c;
  const similar = Math.abs(a * a + b * b - (c * c + d * d)) <= 1e-9 * (a * a + b * b + c * c + d * d) && Math.abs(a * c + b * d) <= 1e-9 * (a * a + b * b + c * c + d * d);
  if (similar || !path.pts.some((p) => p.b)) return { closed: path.closed, pts: path.pts.map((p) => { const q = mApply(m, p); return p.b && similar ? { x: q.x, y: q.y, b: det < 0 ? -p.b : p.b } : { x: q.x, y: q.y }; }) };
  const s = Math.sqrt(Math.abs(det)) || 1;
  return { closed: path.closed, pts: flatten(path.pts, path.closed, tol / s).map((p) => mApply(m, p)) };
}

function entityPaths(e) {
  if (e.type === 'hatch') {
    return (e.loops || []).map((l) => {
      const pts = [];
      for (let i = 0; i + 1 < l.length; i += 2) pts.push({ x: l[i], y: l[i + 1] });
      if (pts.length > 2 && near(pts[0], pts[pts.length - 1])) pts.pop();
      return { pts, closed: true };
    }).filter((p) => p.pts.length >= 3);
  }
  const list = prims(e);
  const paths = chainPrims(list);
  if (e.type === 'poly' && e.closed && paths.length === 1) paths[0].closed = true;
  return paths;
}

export function drawingInput(doc, { only = null, gray = null, tol = 0.01 } = {}) {
  const per = mmPerDrawingUnit(doc.meta?.lunits, doc.meta?.units);
  const k = per || 1;
  const byLayer = new Map();   // layer → { open: [], closed: [] }
  const pictures = [];
  const skipped = {};
  const skip = (kind) => { skipped[kind] = (skipped[kind] || 0) + 1; };
  const shows = (name) => { const l = doc.layers.get(name); return !l || (l.on && !l.frozen); };
  const bucket = (layer) => { let b = byLayer.get(layer); if (!b) byLayer.set(layer, (b = { open: [], closed: [] })); return b; };
  const lin = (m, x, y) => ({ x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y });

  function picture(fr, blk, m, layer) {
    if (fr.ole) { skip('picture-missing'); return; }
    const p = fr.pic, at = mApply(m, { x: p.x, y: p.y }), u = lin(m, p.ux, p.uy), v = lin(m, p.vx, p.vy);
    const square = u.x > 0 && v.y > 0 && Math.abs(u.y) <= 1e-6 * u.x && Math.abs(v.x) <= 1e-6 * v.y;
    if (!square) { skip('picture-turned'); return; }
    const rec = findPicture(doc, p.file);
    if (!rec) { skip('picture-missing'); return; }
    const g = gray ? gray(rec, p) : null;
    if (!g) { skip('picture-loading'); return; }
    pictures.push({ layer, x: at.x, y: at.y, w: u.x * p.w, h: v.y * p.h, pw: g.pw, ph: g.ph, gray: g.gray });
  }

  function walkList(ents, m, parent, depth) {
    for (const e of ents) {
      if (!e || e.invisible) continue;
      const layer = parent && (!e.layer || e.layer === '0') ? parent : (e.layer || '0');
      if (!shows(layer)) continue;
      if (e.type === 'insert') {
        const blk = doc.blocks.get(e.block);
        if (!blk || depth > 16) continue;
        const mm = mMul(m, insertMatrix(e, blk));
        const fr = pictureFrame(blk);
        if (fr && blk.entities.every((x) => x === fr || x.picName)) { picture(fr, blk, mm, layer); continue; }
        walkList(blk.entities, mm, layer, depth + 1);
        continue;
      }
      if (SKIP[e.type]) { skip(SKIP[e.type]); continue; }
      if (e.picName) continue;
      for (const p of entityPaths(e)) {
        const q = txPath(p, m, tol);
        bucket(layer)[q.closed ? 'closed' : 'open'].push(q.pts);
      }
    }
  }
  const top = [...doc.model.values()].filter((e) => (!only || only.has(e.id)) && (doc.visible ? doc.visible(e) : true));
  walkList(top, [k, 0, 0, k, 0, 0], null, 0);

  const order = [...doc.layers.keys()];
  const rank = (n) => { const i = order.indexOf(n); return i < 0 ? order.length : i; };
  const names = [...new Set([...byLayer.keys(), ...pictures.map((p) => p.layer)])].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
  const shapes = [];
  for (const n of names) {
    const b = byLayer.get(n);
    if (!b) continue;
    if (b.closed.length) shapes.push({ layer: n, loops: b.closed, closed: true });
    if (b.open.length) shapes.push({ layer: n, loops: b.open, closed: false });
  }
  return { shapes, pictures, layers: names, skipped, mmPer: per };
}

const MAX_PX = 2048;   // a picture is read at most this many pixels on its long side (the laser's lines are coarser)
const grays = new WeakMap();
/** A loaded picture → { pw, ph, gray } (0 black … 255 white, row 0 on top; transparent counts as white, its fade lightens it). */
function grayOf(rec, pic, onReady) {
  const key = (pic?.fade || 0);
  const got = grays.get(rec);
  if (got && got.fade === key) return got;
  const bm = pictureBitmap(rec, onReady);
  if (!bm || typeof document === 'undefined') return null;
  const s = Math.min(1, MAX_PX / Math.max(bm.width, bm.height));
  const pw = Math.max(1, Math.round(bm.width * s)), ph = Math.max(1, Math.round(bm.height * s));
  const cv = document.createElement('canvas');
  cv.width = pw; cv.height = ph;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pw, ph);
  ctx.drawImage(bm, 0, 0, pw, ph);
  const d = ctx.getImageData(0, 0, pw, ph).data, g = new Uint8Array(pw * ph), f = Math.max(0, Math.min(100, key)) / 100;
  for (let i = 0; i < g.length; i++) { const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; g[i] = Math.round(y + (255 - y) * f); }
  const out = { pw, ph, gray: g, fade: key };
  grays.set(rec, out);
  return out;
}

export function installLaser({ stage, doc, host, el, t, print, ask, focusCommandLine }) {
  let node = null, body = null, timer = 0, bump = 0, only = false, cache = null;
  const selKey = () => (only && host.selection?.size ? [...host.selection].sort().join(',') : '');
  const version = () => doc.version + ':' + (doc.pictureVersion || 0) + ':' + bump + ':' + selKey();
  const onPicture = () => { bump++; schedule(); };
  function input() {
    const v = version();
    if (!cache || cache.v !== v) cache = { v, input: drawingInput(doc, { only: only && host.selection?.size ? host.selection : null, gray: (rec, pic) => grayOf(rec, pic, onPicture) }) };
    return cache.input;
  }
  const fileName = () => String(doc.meta?.name || 'drawing').split(/[\\/]/).pop().replace(/\.(dwg|dxf)$/i, '') || 'drawing';   // i18n-ignore (a file name)
  const panel = laserPanel({
    el, t,
    cls: { block: 'cc-laser-block', note: 'cc-note', head: 'cc-laser-head', table: 'cc-laser-table', btn: 'btn-line btn-sm-cc', primary: 'btn-plot btn-sm-cc', link: 'btn-link-cc', select: 'cc-select', input: 'cc-input', error: 'cc-note' },
    job: () => doc.meta.laser || {},
    setJob: (label, next) => { doc.change(label, () => doc.setMeta({ laser: next })); },
    layers: () => input().layers,
    input: () => input(),
    version,
    download: (name, data, type) => host.saveBlob(name, data, type),
    print: (text) => print(text),
    fileName,
    confirm: async (text) => (await ask({ title: t('cclaser.title'), text, buttons: [['ok', t('cclaser.go'), 'btn-plot'], ['cancel', t('cclaser.cancel'), 'btn-line']] })) === 'ok',
    serial: typeof navigator !== 'undefined' ? navigator.serial : undefined,
    rerender: () => schedule(),
  });

  function render() {
    if (!node || node.hidden) return;
    const inp = input();
    const notes = [];
    notes.push(el('p', { className: 'cc-note', dataset: { laserUnits: '' } }, inp.mmPer ? t('cclaser.units', { mm: String(Math.round(inp.mmPer * 1e6) / 1e6) }) : t('cclaser.units-none')));
    for (const [kind, n] of Object.entries(inp.skipped)) notes.push(el('p', { className: 'cc-note', dataset: { laserSkipped: kind } }, t('cclaser.skipped.' + kind, { n })));
    const onlyBox = el('label', { className: 'lp-check' },
      el('input', { type: 'checkbox', checked: only, dataset: { laserOnly: '' }, onchange: (e) => { only = e.target.checked; schedule(); } }),
      el('span', {}, host.selection?.size ? t('cclaser.only', { n: host.selection.size }) : t('cclaser.only-none')));
    const focusKey = document.activeElement && body.contains(document.activeElement) ? document.activeElement.getAttribute('data-lp') : null;
    body.replaceChildren(onlyBox, ...notes, ...panel.panel());
    if (focusKey) body.querySelector(`[data-lp="${focusKey}"]`)?.focus();
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(render, 60); }
  doc.on((kind) => { if (kind === 'load') { cache = null; panel.refresh(); } if (node && !node.hidden) schedule(); });

  function build() {
    const close = el('button', { type: 'button', className: 'cc-align-close', 'aria-label': t('cclaser.close'), title: t('cclaser.close'), onclick: () => api.close() },
      el('i', { className: 'bi bi-x-lg', 'aria-hidden': 'true' }));
    body = el('div', { className: 'cc-laser-body' });
    node = el('section', { className: 'cc-laserpanel', role: 'region', 'aria-label': t('cclaser.title'), dataset: { laserPanel: '' } },
      el('div', { className: 'cc-align-head' }, el('h2', { className: 'cc-h' }, t('cclaser.title')), close), body);
    // keys typed here stay here (the drawing's keys would take them)
    node.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') api.close(); });
    stage.append(node);
  }
  const api = {
    open() { if (!node) build(); node.hidden = false; render(); node.querySelector('select, button')?.focus(); },
    close() { if (node) node.hidden = true; focusCommandLine?.(); },
    get node() { return node; },
    panel,
  };
  return api;
}
