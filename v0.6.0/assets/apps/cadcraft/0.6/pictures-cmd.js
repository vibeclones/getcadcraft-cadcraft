/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pictures-cmd.js — the picture commands (0.5 WL.14; pictures.js has the model). Registered through commands.js's
 * command registry when this module is imported (cadcraft.js imports it; Node tests too):
 *
 *   IMAGEATTACH (IAT)  pick a PNG or JPEG (host.pickPictures), then its lower-left corner, its width and its angle
 *   IMAGE (IM)         give CadCraft the files the drawing's pictures use (host.pickPictures, several at once; matched
 *                      by file name, as BimCraft does) — a DWG stores only where a picture was
 *   IMAGECLIP (ICL)    a picture's clip: R rectangle (two corners), P polygon (points, Enter ends), D delete the clip
 *
 * Each is one undo step. The files stay with the drawing while it is open (doc.pictures); they are not undoable.
 */
import { t } from './i18n.js';
import { commandRegistry } from './commands.js';
import { addPicture, freePictureName, pictureBlock, pictureFrame, picCorners, findPicture, picturesOf, pictureKey } from './pictures.js';
import { insertMatrix, mApply } from './geom.js';

const def = commandRegistry.add, opt = commandRegistry.option;
const isPicture = (doc, e) => e && e.type === 'insert' && !!pictureFrame(doc.blocks.get(e.block));
const invert = (m) => {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
};

async function pickFiles(c, multiple) {
  if (!c.host.pickPictures) { c.print(t('pic.nobrowser')); return []; }
  return (await c.host.pickPictures({ multiple })) || [];
}

def('IMAGEATTACH', ['IAT', 'IMAGEATT'], async (c) => {
  const [f] = await pickFiles(c, false);
  if (!f) return;
  const rec = addPicture(c.doc, f.name, f.bytes);
  if (rec.error) { c.print(rec.error); return; }
  const at = await c.point(t('pic.prompt.corner', { file: rec.name }));
  if (!at || at.option) return;
  const width = await c.distance(t('pic.prompt.width', { w: rec.w, h: rec.h }), { base: at, default: rec.w });
  const W = typeof width === 'number' && width > 0 ? width : rec.w;
  const ang = await c.angle(t('pic.prompt.angle'), { base: at, default: 0 });
  const a = typeof ang === 'number' ? ang : 0;
  const px = W / rec.w;
  const pic = { file: rec.name, x: 0, y: 0, ux: px, uy: 0, vx: 0, vy: px, w: rec.w, h: rec.h };
  const name = freePictureName(c.doc);
  c.doc.change('IMAGEATTACH', () => {
    c.doc.defineBlock(pictureBlock(name, pic));
    c.doc.add({ type: 'insert', layer: c.doc.current.layer, color: null, block: name, x: at.x, y: at.y, sx: 1, sy: 1, rot: a });
  });
  c.print(t('pic.attached', { file: rec.name, w: rec.w, h: rec.h }));
}, { help: () => t('pic.help.attach') });

def('IMAGE', ['IM'], async (c) => {
  const used = new Map();   // key → [file as the drawing names it]
  for (const b of c.doc.blocks.values()) { const fr = pictureFrame(b); if (fr) used.set(pictureKey(fr.pic.file), fr.pic.file); }
  if (!used.size) { c.print(t('pic.none')); return; }
  const missing = [...used.values()].filter((f) => !findPicture(c.doc, f));
  c.print(t('pic.list', { n: used.size, missing: missing.length }));
  for (const f of used.values()) c.print('  ' + t(findPicture(c.doc, f) ? 'pic.row.loaded' : 'pic.row.missing', { file: f }));
  if (!missing.length) return;
  const files = await pickFiles(c, true);
  let n = 0;
  for (const f of files) {
    const k = pictureKey(f.name), stem = k.replace(/\.[a-z0-9]+$/, '');
    // the exact name, else a file whose name contains the one the drawing names (eTransmit and other exports add a prefix)
    const target = missing.find((m) => pictureKey(m) === k) || missing.find((m) => { const s = pictureKey(m).replace(/\.[a-z0-9]+$/, ''); return s.length >= 3 && stem.includes(s); });
    if (!target) { c.print(t('pic.unused', { file: f.name })); continue; }
    const rec = addPicture(c.doc, f.name, f.bytes);
    if (rec.error) { c.print(rec.error); continue; }
    if (pictureKey(target) !== k) picturesOf(c.doc).set(pictureKey(target), rec);   // known by the drawing's name too
    n++;
  }
  if (n) { c.doc.pictureVersion = (c.doc.pictureVersion || 0) + 1; c.host.redraw?.(); }
  c.print(t('pic.added', { n }));
}, { noRepeat: true, help: () => t('pic.help.image') });

def('IMAGECLIP', ['ICL'], async (c) => {
  const p = await c.entity(t('pic.prompt.pick'));
  if (!p || p.option) return;
  const ref = c.doc.get(p.id ?? p);
  if (!isPicture(c.doc, ref)) { c.print(t('pic.notpicture')); return; }
  const blk = c.doc.blocks.get(ref.block), fr = pictureFrame(blk);
  const k = await c.keyword(t('pic.prompt.clip'), { options: [opt('R', t('opt.rectangular')), opt('P', t('opt.polygonal')), opt('D', t('opt.delete'))], default: 'R' });
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
  // the clip in the block's own coordinates (the reference may be moved, turned and scaled)
  const inv = invert(insertMatrix(ref, blk));
  const local = pts ? pts.map((q) => mApply(inv, q)) : null;
  // a picture block other references share gets a copy of its own first (a clip belongs to one picture, as in the file)
  let shared = 0;
  for (const m of [c.doc.model, ...c.doc.layouts.map((l) => l.entities)]) for (const e of m.values()) if (e.type === 'insert' && e.block === blk.name) shared++;
  for (const b of c.doc.blocks.values()) for (const e of b.entities) if (e.type === 'insert' && e.block === blk.name) shared++;
  const name = shared > 1 ? freePictureName(c.doc) : blk.name;
  const { clipped, ...plainPic } = fr.pic;   // eslint-disable-line no-unused-vars
  c.doc.change('IMAGECLIP', () => {
    const nb = pictureBlock(name, plainPic, local);
    // keep the name text as it was (its place and size)
    c.doc.defineBlock({ ...nb, entities: [nb.entities[0], ...blk.entities.filter((e) => e !== fr)] });
    if (name !== blk.name) c.doc.update(ref.id, { ...ref, block: name });
  });
  c.print(t(pts ? 'pic.clipped' : 'pic.unclipped'));
}, { help: () => t('pic.help.clip') });

export { picCorners };
