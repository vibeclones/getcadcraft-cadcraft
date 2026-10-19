/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dwg-import.js — a drawing model (cc-dwg's readDwg(), ./dwg/read.js; docs/DWG-LIB-SPEC.md) → what doc.load()
 * takes: { entities, layers, blocks, layouts, dimStyle, meta, report }. No DOM: bin/test-cadcraft.mjs
 * runs it in Node.
 *
 * Model space comes in as editable entities; blocks stay blocks (inserts reference them).
 * Dimensions become CadCraft dimensions (shown from their own blocks until edited) where their
 * defining points can be read, else block references as before. Splines become polylines.
 * Layouts (paper space) come in with their viewports. Unknown types are counted, never guessed.
 * Saving goes out as DXF (dxf.js) — writing DWG is not built yet.
 */

import { TAU, normAngle, dist } from './geom.js';
import { mtextPlain } from './dxf.js';
import { attdef, resolveAttribs } from './attrs.js';
import { DIM_DEFAULTS } from './dims.js';
import { matchPaper } from './sheets.js';
import { tagFromXdata, parametricText, isParamBlock } from './gcons.js';
import { face3dFromDwg, read3dFromDwg } from './model3d.js';
import { t } from './i18n.js';
import { vportsFrom } from './dwg-vports.js';
import { trFrom, propsFromXdata, stFromVars, stFromCodes, ccDimFrom, dstyleMap } from './dwg-props.js';

export const VERSIONS = {
  AC1009: 'R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004',
  AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018',
};
const UNITS = { 1: 'inches', 2: 'feet', 3: 'miles', 4: 'millimeters', 5: 'centimeters', 6: 'meters', 7: 'kilometers', 8: 'microinches', 9: 'mils', 10: 'yards' };

/** What C6 converts (multileaders, pictures, wipeouts): dxf.js takes just these from a DXF's drawing model (extrasFrom). */
const EXTRA = new WeakSet();
const extra = (e) => { if (e) EXTRA.add(e); return e; };
export const EXTRA_TYPES = ['MULTILEADER', 'IMAGE', 'WIPEOUT'];

/**
 * Only the multileaders, pictures and wipeouts of a drawing model (dxf-model.js reads a DXF into the same model), as
 * dxf.js merges them into its own reading: { model: [entities], blocks: Map(name → [entities]), layouts: Map(name →
 * [entities]), anon: [the *L / *I blocks they use], notes }.
 */
export function extrasFrom(db) {
  const r = importDwg(db);
  const pick = (list) => (list || []).filter((e) => EXTRA.has(e));
  const anonNames = new Set();
  const out = { model: pick(r.entities), blocks: new Map(), layouts: new Map(), anon: [], notes: r.report.notes.filter((n) => /multileader|wipeout|picture/i.test(n)) };
  for (const b of r.blocks) { const x = pick(b.entities); if (x.length) out.blocks.set(b.name, x); }
  for (const l of r.layouts) { const x = pick(l.entities); if (x.length) out.layouts.set(l.name, x); }
  for (const e of [...out.model, ...[...out.blocks.values()].flat(), ...[...out.layouts.values()].flat()]) if (e.type === 'insert') anonNames.add(e.block);
  out.anon = r.blocks.filter((b) => anonNames.has(b.name));
  return out;
}

export function importDwg(db, { versionTag = '' } = {}) {
  const report = { read: 0, skipped: {}, paperSpace: 0, notes: [], splines: 0 };
  const skip = (t) => { report.skipped[t] = (report.skipped[t] || 0) + 1; };

  // linetypes (0.4 C8): the table's patterns (simple dashes; shapes and text in a pattern are left out), names by handle
  const ltByHandle = new Map((db.tables?.linetypes || []).map((l) => [String(l.handle || '').toUpperCase(), l.name]));
  const linetypes = (db.tables?.linetypes || []).filter((l) => l.name && !/^(byblock|bylayer|continuous)$/i.test(l.name) && (l.elements || []).length)
    .map((l) => ({ name: l.name, description: l.description || '', pattern: (l.elements || []).map((x) => +x.length || 0) }));
  const ltName = (v) => (v === undefined || v === null || v === '' ? null : ltByHandle.get(String(v).toUpperCase()) || String(v));
  const lwMm = (v) => (v === -2 || v === -3 ? v : Number.isFinite(v) && v >= 0 ? v / 100 : undefined);   // 1/100 mm → mm; -1 by layer = absent
  const layers = (db.tables?.layers || []).map((l) => {
    const c = l.color || {};
    const color = c.rgb !== undefined ? hex(c.rgb) : (Math.abs(c.index ?? 7) || 7);
    const lw = lwMm(l.lineweight);
    return { name: l.name, color, on: !l.off, frozen: !!l.frozen, locked: !!l.locked, plot: l.plot !== false && String(l.name).toUpperCase() !== 'DEFPOINTS',
      linetype: ltName(l.linetype) || 'Continuous', lineweight: lw === undefined || lw === -2 ? -3 : lw };
  });

  // dimension styles: the header's settings, then each named style
  const H = db.header || {};
  const styleFrom = (src, base) => {
    const st = stFromVars(src, { ...base });   // every variable CadCraft has a key for (dwg-props.js)
    if (!(st.scale > 0)) st.scale = 1;
    for (const k of ['dec', 'adec', 'tad', 'zin']) st[k] = Math.max(0, Math.min(8, Math.round(st[k] || 0)));
    lunitOk(st);
    return st;
  };
  const dimStyle = styleFrom(H, DIM_DEFAULTS);
  const dimStyles = new Map((db.tables?.dimstyles || []).map((d) => [String(d.name).toUpperCase(), styleFrom(d.vars || {}, dimStyle)]));
  for (const d of db.tables?.dimstyles || []) { const st = dimStyles.get(String(d.name).toUpperCase()); const tx = d.vars?.DIMTXSTY_NAME; if (st && tx && !/^standard$/i.test(tx)) st.txsty = String(tx); }
  // the drawing's named dimension and text styles (Properties lists them; doc.dimStyles / doc.textStyles)
  const namedDimStyles = (db.tables?.dimstyles || []).filter((d) => d.name && !/^standard$/i.test(d.name) && !(d.flags & 16)).map((d) => [String(d.name), dimStyles.get(String(d.name).toUpperCase())]);
  const textStyles = (db.tables?.styles || []).filter((s) => s.name && !s.shapeFile && !(s.flags & 1) && !(s.flags & 16) && !/^standard$/i.test(s.name))
    .map((s) => [String(s.name), { font: String(s.font || ''), h: Number.isFinite(s.height) ? s.height : 0, wf: s.widthFactor > 0 ? s.widthFactor : 1, obl: Number.isFinite(s.oblique) ? s.oblique : 0 }]);

  // model space and every sheet are blocks too (*Model_Space, *Paper_Space…), in file order
  const blockList = db.blocks || [];
  const model = blockList.find((b) => /^\*model_space$/i.test(b.name));
  const blocks = [];
  let anonN = 0;   // *L (multileaders drawn as parts) and *I (picture frames) blocks made here
  const taken = new Set(blockList.map((b) => String(b.name).toUpperCase()));
  const freeName = (pre) => { let n; do n = pre + (++anonN); while (taken.has(n.toUpperCase())); taken.add(n.toUpperCase()); return n; };
  const imageDefs = new Map((db.objects || []).filter((o) => o.type === 'IMAGEDEF').map((o) => [o.handle, o]));
  let parametric = null;   // CadCraft's constraints (gcons.js): block CADCRAFT_PARAMETRIC
  for (const b of blockList) {
    if (/^\*(model|paper)_space/i.test(b.name)) continue;
    if (isParamBlock(b.name)) { parametric = parametricText((b.entities || []).map(convert).filter(Boolean)); continue; }
    const ents = [], attdefs = [];
    for (const e of b.entities || []) {
      if (e.type === 'ATTDEF') { const d = attdefOf(e); if (d) attdefs.push(d); continue; }
      const c = convert(e); if (c) ents.push(...[].concat(c));
    }
    // a linked drawing (external reference: block flag 4 — the path field alone is not one, dynamic blocks' copies fill it
    // too) is kept as a link CadCraft has not loaded (xref.js)
    const link = b.flags & 4 ? { xref: { path: String(b.xrefPath || b.name), loaded: false } } : {};
    if (link.xref) report.xrefs = (report.xrefs || 0) + 1;
    blocks.push({ name: b.name, base: { x: b.base?.x || 0, y: b.base?.y || 0 }, entities: link.xref ? [] : ents, ...(attdefs.length && !link.xref ? { attdefs } : {}), ...link });
  }

  const entities = [];
  for (const e of model?.entities || []) {
    const c = convert(e);
    if (c) { entities.push(...[].concat(c)); report.read++; }
  }
  const layoutObjs = (db.layouts || []).filter((l) => !/^model$/i.test(l.name || '') && l.block);
  const paperOf = new Map(layoutObjs.map((l) => [l.block, []]));
  for (const b of blockList) {
    const list = paperOf.get(b.record);
    if (!list || b === model) continue;
    for (const e of b.entities || []) { const c = convert(e); if (c) list.push(...[].concat(c)); report.paperSpace++; }
  }
  // attribute values: positions relative to their block (attrs.js)
  resolveAttribs([entities, ...blocks.map((b) => b.entities), ...[...paperOf.values()]], new Map(blocks.map((b) => [b.name, b])));
  if (report.splines) report.notes.push(t('dwg.read.splines', { n: report.splines }));
  if (report.xrefs) report.notes.push(t('dwg.read.xrefs', { n: report.xrefs }));
  if (report.mleaderBlocks) report.notes.push(t('dwg.read.mleaderblocks', { n: report.mleaderBlocks }));
  if (report.wipeouts) report.notes.push(t('dwg.read.wipeouts', { n: report.wipeouts }));
  if (report.images) report.notes.push(t('dwg.read.images', { n: report.images }));
  if (report.dimBlocks) report.notes.push(t('dwg.read.dimblocks', { n: report.dimBlocks }));

  // layouts, in tab order; the first viewport of each is the sheet itself
  const inches = H.MEASUREMENT === 0 || (H.MEASUREMENT === undefined && [1, 2, 3, 8, 9, 10].includes(H.INSUNITS));
  const layouts = layoutObjs.slice().sort((a, b) => (a.tabOrder ?? 0) - (b.tabOrder ?? 0)).map((l) => {
    let list = paperOf.get(l.block) || [];
    if (list.some((e) => e._attribs)) resolveAttribs([list], new Map(blocks.map((b) => [b.name, b])));
    const firstVp = list.find((e) => e.type === 'viewport');
    list = list.filter((e) => e !== firstVp);
    const mn = l.limits?.min || { x: 0, y: 0 }, mx = l.limits?.max || { x: 0, y: 0 };
    let paper = { unit: inches ? 'in' : 'mm', x0: mn.x, y0: mn.y, w: mx.x - mn.x, h: mx.y - mn.y };
    const own = firstVp?.cc;
    if (own && own.w > 0 && own.h > 0) paper = { unit: own.unit, x0: own.x0, y0: own.y0, w: own.w, h: own.h };
    else if (!(paper.w > 0 && paper.h > 0)) paper = firstVp ? { ...paper, x0: firstVp.x - firstVp.w / 2, y0: firstVp.y - firstVp.h / 2, w: firstVp.w, h: firstVp.h } : { ...paper, x0: 0, y0: 0, w: inches ? 11 : 297, h: inches ? 8.5 : 210 };
    const std = matchPaper(paper.w, paper.h, paper.unit);
    if (own?.key && std?.key === own.key) paper.key = own.key;
    else if (std) paper.key = std.key;
    return { name: l.name || 'Layout', paper, entities: list };
  });
  if (layouts.length) report.layouts = layouts.length;

  return read3dFromDwg(db, {   // + CadCraft's 3D model from block CADCRAFT_3D (model3d.js)
    entities, layers, blocks, layouts, dimStyle, ...(parametric ? { parametric } : {}),
    linetypes,
    meta: { version: versionTag, release: VERSIONS[versionTag] || '', units: UNITS[H.INSUNITS] || '', ...(H.INSBASE && Number.isFinite(H.INSBASE.x) ? { insbase: { x: H.INSBASE.x, y: H.INSBASE.y || 0 } } : {}),
      ...(H.LTSCALE > 0 && H.LTSCALE !== 1 ? { ltscale: H.LTSCALE } : {}),
      ...lengthFormat(H) },
    views: namedViews(db.tables?.views, layouts),
    vports: splitScreen(db.tables?.vports),
    textStyles, dimStyles: namedDimStyles,
    report,
  });

  /** A DWG dimension's defining points (DXF 10 defPoint, 11 textMid, 13/14 xline1/2, 15 center) → a CadCraft dimension, or null. */
  function dimension(e) {
    const t = e.dimType ?? 0;
    const P = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null);
    const st = { ...(dimStyles.get(String(e.style || '').toUpperCase()) || dimStyle) };
    // per-dimension overrides (ACAD "DSTYLE" xdata: group code, value, …; every variable, dwg-props.js), then what only
    // CadCraft keeps (CADCRAFT "CCDIMST:…": arrowhead names, text style, true colours)
    const ds = dstyleMap(xdataOf(e.xdata, 'ACAD'));
    if (ds.size) stFromCodes((c) => ds.get(c), st);
    ccDimFrom(xdataOf(e.xdata, 'CADCRAFT').map(([, v]) => String(v)), st);
    if (!(st.scale > 0)) st.scale = 1;
    lunitOk(st);
    const meas = typeof e.measurement === 'number' && e.measurement > 0 ? e.measurement : null;
    const close = (v) => meas === null || Math.abs(v - meas) <= 1e-6 * Math.max(1, meas);
    const text = mtextPlain(String(e.text || '')).replace(/^<>$/, '');
    const tp = P(e.textMid);
    const textAt = tp && (tp.x || tp.y) ? tp : null;
    let d = null;
    if (t === 0 || t === 1) {
      const p1 = P(e.xline1), p2 = P(e.xline2), q2 = P(e.defPoint);
      if (!p1 || !p2 || !q2 || dist(p1, p2) < 1e-12) return null;
      if (t === 1) d = close(dist(p1, p2)) ? { kind: 'aligned', p1, p2, loc: q2 } : null;
      else {
        // the dimension line's angle: square to the line from p2 to its point on the line, or as recorded
        const cands = [];
        if (dist(p2, q2) > 1e-9) cands.push(normAngle(Math.atan2(q2.y - p2.y, q2.x - p2.x) + Math.PI / 2));
        cands.push(normAngle(e.angle || 0), 0, Math.PI / 2);
        const rot = cands.find((r) => close(Math.abs((p2.x - p1.x) * Math.cos(r) + (p2.y - p1.y) * Math.sin(r))));
        d = rot === undefined ? null : { kind: 'linear', p1, p2, loc: q2, rot };
      }
    } else if (t === 4 || t === 3) {
      const a = P(e.defPoint), p1 = P(e.center);
      if (!a || !p1) return null;
      const c = t === 4 ? a : { x: (a.x + p1.x) / 2, y: (a.y + p1.y) / 2 };
      const r = dist(c, p1);
      if (r < 1e-12 || !close(t === 4 ? r : 2 * r)) return null;
      d = { kind: t === 4 ? 'radius' : 'diameter', c, p1, loc: textAt || p1 };
    } else if (t === 5) {
      const c = P(e.center), p1 = P(e.xline1), p2 = P(e.xline2), loc = P(e.defPoint);
      if (c && p1 && p2 && loc && dist(c, p1) > 1e-12 && dist(c, p2) > 1e-12 && dist(c, loc) > 1e-12) d = { kind: 'angular', c, p1, p2, loc };
    }
    if (!d) return null;
    const out = { ...d, text, st };
    if (e.style && !/^standard$/i.test(e.style)) out.dimstyle = String(e.style);
    if (Number.isFinite(e.textRotation) && Math.abs(e.textRotation) > 1e-12) out.trot = normAngle(e.textRotation);
    return out;
  }

  /**
   * 0.4 C6. A MULTILEADER with one leader line and text → CadCraft's own editable multileader (leader.js shape: pts[0] the
   * arrowhead's tip, the last point where the landing starts); any other (block content, several leaders, a spline) →
   * what it draws (lines, filled arrowheads, the landing, the text, the block with its attribute values) in an unnamed
   * block, so it still moves as one.
   */
  function multileader(e, base) {
    const cx = e.context || {};
    const roots = cx.roots || [];
    const P = (p) => ({ x: p.x, y: p.y });
    const label = cx.hasText && cx.text?.label ? mtextPlain(String(cx.text.label)) : '';
    const asz = cx.arrowSize ?? e.arrowSize ?? 0, h = cx.textHeight > 0 ? cx.textHeight : asz || 2.5;
    const r0 = roots[0], l0 = r0?.lines?.[0];
    if (roots.length === 1 && r0.lines?.length === 1 && !cx.hasBlock && label && e.leaderType !== 2 && r0.connection && l0.points?.length) {
      const pts = [...l0.points, r0.connection].map(P);
      const dir = (r0.direction?.x ?? 1) < 0 ? -1 : 1;
      const dogleg = e.doglegEnabled !== false ? r0.landingDistance ?? r0.doglegLength ?? e.landingDistance ?? 0 : 0;   // readDwg / dxf-model.js names
      const ww = cx.text.width > 0 ? cx.text.width : 0, ls = cx.text.lineSpacing > 0 && cx.text.lineSpacing !== 1 ? cx.text.lineSpacing : 0;
      report.mleaders = (report.mleaders || 0) + 1;
      return { type: 'mleader', ...base, pts, dir, s: label, h, ...(ww ? { ww } : {}), ...(ls ? { ls } : {}), st: { asz, dogleg, ...(Number.isFinite(cx.landingGap) ? { gap: cx.landingGap } : {}) } };
    }
    const parts = [];
    for (const r of roots) {
      for (const l of r.lines || []) {
        const pts = [...(l.points || []), ...(r.connection ? [r.connection] : [])].map(P);
        if (pts.length < 2) continue;
        if (e.leaderType !== 0) parts.push({ type: 'poly', layer: '0', color: 0, closed: false, pts: pts.map((p) => ({ ...p, b: 0 })) });
        const a = pts[0], b = pts[1], d = dist(a, b);
        if (asz > 0 && d > 0) {   // a closed filled arrowhead at the first point
          const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d, bx = a.x + ux * asz, by = a.y + uy * asz, hw = asz / 6;
          parts.push({ type: 'hatch', layer: '0', color: 0, solid: true, loops: [[a.x, a.y, bx - uy * hw, by + ux * hw, bx + uy * hw, by - ux * hw, a.x, a.y]] });
        }
      }
      const dl = r.landingDistance ?? r.doglegLength ?? e.landingDistance;
      if (r.connection && e.doglegEnabled && r.direction && dl) parts.push({ type: 'line', layer: '0', color: 0, x1: r.connection.x, y1: r.connection.y, x2: r.connection.x + r.direction.x * dl, y2: r.connection.y + r.direction.y * dl });
    }
    if (label && cx.text?.location) {
      const t = cx.text, ap = Math.max(0, (t.alignment || 1) - 1);
      const rot = t.direction && (t.direction.x || t.direction.y) ? Math.atan2(t.direction.y, t.direction.x) : 0;
      parts.push({ type: 'text', layer: '0', color: 0, x: t.location.x, y: t.location.y, h, rot: normAngle(rot), s: label, ha: ['left', 'center', 'right'][ap % 3], va: 'top', ...(t.width > 0 ? { ww: t.width } : {}) });
    }
    const bc = cx.hasBlock && cx.block;
    const bh = bc && (bc.blockHandle ?? bc.handle);
    const src = bc && (blockList.find((b) => b.record === bh) || blockList.find((b) => b.name === bc.name));
    if (bc && src) {
      const tags = new Map((src.entities || []).filter((x) => x.type === 'ATTDEF').map((x) => [x.handle, x.tag]));
      const attrs = {};
      for (const a of e.blockLabels || []) if (tags.has(a.attdefHandle)) attrs[tags.get(a.attdefHandle)] = mtextPlain(String(a.text ?? ''));
      const t = bc.matrix;
      const sx = bc.scale?.x || 1, sy = bc.scale?.y || 1;
      const at = t && t.length === 16 ? { x: t[3], y: t[7] } : P(bc.location);
      const rot = t && t.length === 16 ? Math.atan2(t[4], t[0]) : bc.rotation || 0;
      // the block is placed by its base point at the matrix's origin (the matrix already holds the base offset: none here)
      parts.push({ type: 'insert', layer: '0', color: 0, block: src.name, x: at.x, y: at.y, sx, sy, rot: normAngle(rot), ...(Object.keys(attrs).length ? { attrs } : {}) });
    }
    if (!parts.length) { skip('MULTILEADER'); return null; }   // nothing it could draw
    const name = freeName('*L');
    blocks.push({ name, base: { x: 0, y: 0 }, entities: parts });
    report.mleaderBlocks = (report.mleaderBlocks || 0) + 1;
    return { type: 'insert', ...base, block: name, x: 0, y: 0, sx: 1, sy: 1, rot: 0 };
  }

  /**
   * 0.4 C6. An IMAGE → its frame (the clip boundary when clipped) with the picture's file name inside, as one unnamed
   * block (CadCraft does not show pictures); a WIPEOUT → its frame. Pixel → world as the DXF reference has it: the
   * insertion point is the lower-left corner, u one pixel along the width, v one pixel up; boundary y runs down.
   */
  function picture(e, base) {
    const u = e.u, v = e.v, p = e.insert, w = e.size?.x, h = e.size?.y;
    if (!u || !v || !p || !(w > 0) || !(h > 0)) { skip(e.type); return null; }
    const W = (q) => ({ x: p.x + (q.x + 0.5) * u.x + (h - 0.5 - q.y) * v.x, y: p.y + (q.x + 0.5) * u.y + (h - 0.5 - q.y) * v.y, b: 0 });
    let clip = e.clipping && Array.isArray(e.clip) && e.clip.length >= 2 ? e.clip : [{ x: -0.5, y: -0.5 }, { x: w - 0.5, y: h - 0.5 }];
    if (clip.length === 2) { const [a, b] = clip; clip = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }]; }
    const frame = { type: 'poly', closed: true, pts: clip.map(W) };
    if (e.type === 'WIPEOUT') { report.wipeouts = (report.wipeouts || 0) + 1; return { ...frame, ...base }; }
    const def = imageDefs.get(e.def);
    const file = String(def?.fileName || '').split(/[\\/]/).pop() || 'image';
    const ll = W({ x: -0.5, y: h - 0.5 }), lr = W({ x: w - 0.5, y: h - 0.5 });
    const rot = Math.atan2(lr.y - ll.y, lr.x - ll.x), side = Math.hypot(v.x, v.y) * h;
    const th = Math.max(1e-9, Math.min(side / 8, Math.hypot(lr.x - ll.x, lr.y - ll.y) / Math.max(4, file.length)));
    const name = freeName('*I');
    blocks.push({ name, base: { x: 0, y: 0 }, entities: [{ ...frame, layer: '0', color: 0 },
      { type: 'text', layer: '0', color: 0, x: ll.x + (Math.cos(rot) - Math.sin(rot)) * th * 0.5, y: ll.y + (Math.sin(rot) + Math.cos(rot)) * th * 0.5, h: th, rot: normAngle(rot), s: file, ha: 'left', va: 'baseline' }] });
    report.images = (report.images || 0) + 1;
    return { type: 'insert', ...base, block: name, x: 0, y: 0, sx: 1, sy: 1, rot: 0 };
  }

  /** An object's own linetype, lineweight and linetype scale (absent = by layer, as CadCraft keeps them). */
  function styleOf(e) {
    const o = {};
    const n = ltName(e.linetype);
    if (n && !/^bylayer$/i.test(n)) o.lt = /^byblock$/i.test(n) ? 'ByBlock' : /^continuous$/i.test(n) ? 'Continuous' : n;
    const w = lwMm(e.lineweight);
    if (w !== undefined) o.lw = w;
    if (Number.isFinite(e.ltscale) && e.ltscale > 0 && Math.abs(e.ltscale - 1) > 1e-12) o.lts = e.ltscale;
    return o;
  }

  /** One model entity → CadCraft's, with CadCraft's own xdata keys (CCREF) kept. */
  function convert(e) { return withProps(tagFromXdata(convertBase(e), e.xdata), e); }
  /** The Properties panel's fields a file keeps (P.3–P.7; dwg-props.js): transparency, thickness, Z, and what xdata holds. */
  function withProps(c, e) {
    if (!c || (Array.isArray(c) && !c.length)) return c;
    const one = Array.isArray(c) ? c[0] : c;
    if (!one || one.type === 'face3d') return c;
    const add = {};
    const tr = trFrom(e.transparency);
    if (tr !== undefined) add.tr = tr;
    if (Number.isFinite(e.thickness) && e.thickness && ['line', 'circle', 'arc', 'poly', 'point', 'text'].includes(one.type)) add.th = e.thickness;
    Object.assign(add, propsFromXdata(e.xdata));
    if (one.type !== 'hatch') { delete add.bg; delete add.ox; delete add.oy; delete add.assoc; }
    const z = zOf(e, one.type);
    if (z) add.z = z;
    for (const x of [].concat(c)) Object.assign(x, add);
    if (one.type === 'line') { const z1 = e.start?.z, z2 = e.end?.z; for (const x of [].concat(c)) { delete x.z; if (z1) x.z1 = z1; if (z2) x.z2 = z2; } }
    if (one.type === 'hatch' && (add.ox || add.oy) && one.patlines) for (const l of one.patlines) { l.x -= add.ox || 0; l.y -= add.oy || 0; }   // hatch.js adds the origin back
    return c;
  }
  function zOf(e, type) {
    const fin = (v) => (Number.isFinite(v) ? v : 0);
    switch (e.type) {
      case 'CIRCLE': case 'ARC': case 'ELLIPSE': return fin(e.center?.z);
      case 'POINT': return fin(e.position?.z);
      case 'TEXT': case 'ATTRIB': return fin(e.insert?.z) || fin(e.elevation);
      case 'MTEXT': return fin(e.insert?.z);
      case 'INSERT': return type === 'insert' ? fin(e.insert?.z) : 0;
      case 'LWPOLYLINE': case 'POLYLINE_2D': return fin(e.elevation);
      case 'HATCH': return fin(e.elevation);
      case 'MULTILEADER': return type === 'mleader' ? fin(e.context?.roots?.[0]?.connection?.z) : 0;
      default: return 0;
    }
  }
  function convertBase(e) {
    if (e.invisible) return null;
    const base = { layer: e.layer || '0', color: color(e), ...styleOf(e) };
    const f = e.extrusion && e.extrusion.z < -0.5;   // OCS x runs the other way
    const X = (x) => (f ? -x : x);
    const type = /^DIMENSION_/.test(e.type) ? 'DIMENSION' : e.type;
    switch (type) {
      case 'LINE': return { type: 'line', ...base, x1: e.start.x, y1: e.start.y, x2: e.end.x, y2: e.end.y };
      case 'POINT': return { type: 'point', ...base, x: e.position?.x ?? 0, y: e.position?.y ?? 0 };
      case 'CIRCLE': return { type: 'circle', ...base, cx: X(e.center.x), cy: e.center.y, r: e.radius };
      case 'ARC': {
        let a0 = e.startAngle, a1 = e.endAngle;
        if (f) [a0, a1] = [Math.PI - a1, Math.PI - a0];
        return { type: 'arc', ...base, cx: X(e.center.x), cy: e.center.y, r: e.radius, a0: normAngle(a0), a1: normAngle(a1) };
      }
      case 'LWPOLYLINE': case 'POLYLINE_2D': {
        const vs = (e.vertices || []).filter((v) => !(v.flags & 16));   // 16 = a spline frame's control point
        if (vs.length < 2) return null;
        // widths (P.7): one for the whole polyline, or each segment's start / end
        const cw = e.constantWidth > 0 ? e.constantWidth : 0;
        const each = !cw && vs.some((v) => v.startWidth > 0 || v.endWidth > 0);
        const wd = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
        return { type: 'poly', ...base, closed: !!e.closed, ...(cw ? { w: cw } : {}),
          pts: vs.map((v) => ({ x: X(v.x), y: v.y, b: (f ? -1 : 1) * (v.bulge || 0), ...(each ? { sw: wd(v.startWidth), ew: wd(v.endWidth) } : {}) })) };
      }
      case 'POLYLINE_3D': {
        const vs = (e.vertices || []).filter((v) => !(v.flags & 16));
        return vs.length >= 2 ? { type: 'poly', ...base, closed: !!e.closed, pts: vs.map((v) => ({ x: v.x, y: v.y, b: 0 })) } : null;
      }
      case 'ELLIPSE': return { type: 'ellipse', ...base, cx: e.center.x, cy: e.center.y, mx: e.majorAxis.x, my: e.majorAxis.y, ratio: e.ratio || 1, t0: e.startParam ?? 0, t1: e.endParam ?? TAU };
      case 'SPLINE': {
        const pts = splinePoints(e);
        if (pts.length < 2) { skip('SPLINE'); return null; }
        report.splines++;
        return { type: 'poly', ...base, closed: false, pts: pts.map((p) => ({ x: p.x, y: p.y, b: 0 })) };
      }
      case 'TEXT': case 'ATTRIB': {
        const t = textOf(e, base, X);
        if (e.type === 'ATTRIB') return t && e.tag ? { ...t, tag: e.tag, ...(e.flags & 1 ? { invisible: true } : {}) } : null;
        return t && t.s.trim() ? t : null;
      }
      case 'MTEXT': {
        const s = mtextPlain(String(e.value || ''));
        if (!s || !e.height) return null;
        const rot = e.xAxis && (e.xAxis.x || e.xAxis.y) ? Math.atan2(e.xAxis.y, e.xAxis.x) : 0;
        const ap = (e.attach || 1) - 1;
        const ww = e.width > 0 ? e.width : 0, ls = e.lineSpacing > 0 && e.lineSpacing !== 1 ? e.lineSpacing : 0;
        const q = /^\\Q(-?[\d.]+);/.exec(String(e.value || ''));   // an oblique angle as the text's first format code (how CadCraft writes it)
        const obl = q && Number.isFinite(+q[1]) && +q[1] ? +q[1] * Math.PI / 180 : 0;
        return { type: 'text', ...base, x: e.insert.x, y: e.insert.y, h: e.height, rot: normAngle(rot), s, ha: ['left', 'center', 'right'][ap % 3], va: ['top', 'middle', 'bottom'][Math.floor(ap / 3)], ...(ww ? { ww } : {}), ...(ls ? { ls } : {}),
          ...styleName(e.style), ...(obl ? { obl } : {}) };
      }
      case 'SOLID': case 'TRACE': {
        const p = e.points || [];   // DXF order: the outline runs 1, 2, 4, 3
        const c = [p[0], p[1], p[3] || p[2], p[2]].filter(Boolean).map((q) => [X(q.x), q.y]);
        return { type: 'hatch', ...base, solid: true, loops: [[...c.flat(), ...c[0]]] };
      }
      case 'HATCH': {
        const loops = hatchLoops(e);
        if (!loops.length) { skip(t('dwg-import.hatch_boundary_not_read')); return null; }
        const h = { type: 'hatch', ...base, solid: !!e.solid, pattern: e.pattern || '', loops };
        if (e.style === 1) h.island = 'outer'; else if (e.style === 2) h.island = 'ignore';   // island detection (P.7)
        if (e.associative) h.assoc = true;
        if (!e.solid) {
          if (e.scale > 0) h.pscale = e.scale;
          if (e.angle) h.pangle = normAngle(e.angle);
          // the file's own pattern lines (drawing units, already scaled and turned): hatch.js draws them as they are
          const pl = (e.patternLines || []).filter((l) => [l.angle, l.base?.x, l.base?.y, l.offset?.x, l.offset?.y].every(Number.isFinite));
          if (pl.length && pl.length <= 64) h.patlines = pl.map((l) => {
            const ca = Math.cos(l.angle), sa = Math.sin(l.angle);
            return { angle: l.angle * 180 / Math.PI, x: l.base.x, y: l.base.y, dx: l.offset.x * ca + l.offset.y * sa, dy: -l.offset.x * sa + l.offset.y * ca, dashes: (l.dashes || []).filter(Number.isFinite).slice(0, 32) };
          });
        }
        return h;
      }
      case 'INSERT': case 'MINSERT': {
        if (!e.block) return null;
        let x = e.insert.x, rot = e.rotation || 0, sx = e.scale?.x || 1;
        if (f) { x = -x; rot = Math.PI - rot; sx = -sx; }
        const ins = { type: 'insert', ...base, block: e.block, x, y: e.insert.y, sx, sy: e.scale?.y || 1, rot: normAngle(rot), ...(e.scale?.z && e.scale.z !== 1 ? { sz: e.scale.z } : {}) };
        const out = [];
        const cols = Math.max(1, e.cols || 1), rows = Math.max(1, e.rows || 1);
        const c = Math.cos(ins.rot), s = Math.sin(ins.rot);
        for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
          const dx = k * (e.colSpacing || 0), dy = r * (e.rowSpacing || 0);
          out.push({ ...ins, x: ins.x + dx * c - dy * s, y: ins.y + dx * s + dy * c });
        }
        // attribute values go on the (first) reference; resolveAttribs places them on its block
        out[0]._attribs = [];
        for (const a of e.attribs || []) { if (a.invisible) continue; const t = convert({ ...a, type: 'ATTRIB' }); if (t) out[0]._attribs.push(t); }
        return out;
      }
      case '3DFACE': return face3dFromDwg(e, base);   // the 3D tab's faces (model3d.js), never a 2D object
      case 'MULTILEADER': return extra(multileader(e, base));
      case 'IMAGE': case 'WIPEOUT': return extra(picture(e, base));
      case 'MLINE': {
        const vs = (e.vertices || []).map((v) => v.point).filter((v) => v && Number.isFinite(v.x));
        return vs.length >= 2 ? { type: 'poly', ...base, closed: !!e.closed, pts: vs.map((v) => ({ x: v.x, y: v.y, b: 0 })) } : null;
      }
      case 'DIMENSION': {
        // parametric (dynamic) constraints look like dimensions but are editing aids: never plotted
        if (/^\*LayerNameForDynamicConstraint$/i.test(e.layer || '')) { skip(t('dwg-import.dimension_parametric_constraint')); return null; }
        const d = dimension(e);
        if (d) return { type: 'dim', ...base, ...d, ...(e.block ? { block: e.block } : {}) };
        if (!e.block) { skip(t('dwg-import.dimension_no_block_draw')); return null; }
        report.dimBlocks = (report.dimBlocks || 0) + 1;
        return { type: 'insert', ...base, block: e.block, x: 0, y: 0, sx: 1, sy: 1, rot: 0, dim: true };
      }
      case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': {   // no CadCraft kind for these: drawn from their block
        if (!e.block) { skip(e.type + ' (no block to draw it from)'); return null; }   // i18n-ignore: a report key (entity type), listed as is
        report.dimBlocks = (report.dimBlocks || 0) + 1;
        return { type: 'insert', ...base, block: e.block, x: 0, y: 0, sx: 1, sy: 1, rot: 0, dim: true };
      }
      case 'ACAD_TABLE': {
        if (!e.block) { skip(t('dwg-import.acad_table_no_block')); return null; }
        return { type: 'insert', ...base, block: e.block, x: 0, y: 0, sx: 1, sy: 1, rot: 0 };
      }
      case 'VIEWPORT': {
        const c = e.center, t = e.viewTarget || { x: 0, y: 0 }, dc = e.viewCenter || c;
        if (!c || !(e.width > 0) || !(e.height > 0)) return null;
        const s = e.viewHeight > 0 ? e.height / e.viewHeight : 1;
        if (e.twist) report.twisted = (report.twisted || 0) + 1;
        const vp = { type: 'viewport', ...base, x: c.x, y: c.y, w: e.width, h: e.height, cx: dc.x + (t.x || 0), cy: dc.y + (t.y || 0), s };
        const stt = Number(e.status) >>> 0;   // status flags (P.7): 16384 display locked, 131072 off
        if (stt & 16384) vp.locked = true;
        if (stt & 131072) vp.on = false;
        // CadCraft's own record of the sheet on its first viewport (dwg-save.js; as in its DXF): name, unit, size key, paper
        const cc = xdataOf(e.xdata, 'CADCRAFT').map(([, v]) => v);
        if (cc[0] === 'LAYOUT' && [4, 5, 6, 7].every((i) => Number.isFinite(+cc[i]))) vp.cc = { unit: cc[2] === 'in' ? 'in' : 'mm', key: String(cc[3] || ''), x0: +cc[4], y0: +cc[5], w: +cc[6], h: +cc[7] };
        return vp;
      }
      case 'ATTDEF': case 'XLINE': case 'RAY': return null;   // ATTDEFs are read with their block (attdefOf)
      default: skip(e.type === 'UNKNOWN' ? e.dxfName || 'UNKNOWN' : e.type); return null;
    }
  }
}

/** TEXT, ATTRIB or ATTDEF → a text entity (value may be empty), or null without a height. */
function textOf(e, base, X = (x) => x) {
  if (!e.height || !e.insert) return null;
  const s = plain(e.value);
  const h = e.hAlign || 0, v = e.vAlign || 0;
  const aligned = h !== 0 || v !== 0;
  // DXF 11 (align) is the anchor of every justification but left/baseline, aligned (3) and fit (5)
  const ap = aligned && h !== 3 && h !== 5 && e.align && (e.align.x || e.align.y) ? e.align : null;
  const p = ap || e.insert;
  return {
    type: 'text', ...base, x: X(p.x), y: p.y, h: e.height, rot: normAngle(e.rotation || 0), wf: e.widthFactor || 1, s,
    ha: h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left',
    va: h === 4 || v === 2 ? 'middle' : v === 3 ? 'top' : v === 1 ? 'bottom' : 'baseline',
    ...styleName(e.style), ...(Number.isFinite(e.oblique) && Math.abs(e.oblique) > 1e-12 ? { obl: e.oblique } : {}),
  };
}

/** A text style name other than Standard → { style } (P.7). */
function styleName(n) { return typeof n === 'string' && n && !/^standard$/i.test(n) ? { style: n } : {}; }

/** A block's ATTDEF → an attribute definition (flags 1 invisible, 2 constant, 8 preset). */
function attdefOf(e) {
  if (!e.tag) return null;
  const f = e.extrusion && e.extrusion.z < -0.5;
  const t = textOf(e, { layer: e.layer || '0', color: color(e) }, (x) => (f ? -x : x));
  if (!t) return null;
  const fl = e.flags || 0;
  return attdef(t, { tag: e.tag, prompt: plain(e.prompt || ''), def: t.s, invisible: !!(fl & 1), constant: !!(fl & 2), preset: !!(fl & 8) });
}


/** The drawing's length format ($LUNITS, $LUPREC → doc.meta.lunits / luprec, units.js codes); decimal is left out. */
function lengthFormat(H) {
  const lu = Math.round(+H.LUNITS), pr = Math.round(+H.LUPREC);
  const out = {};
  if (lu >= 1 && lu <= 5 && lu !== 2) out.lunits = lu;
  if (out.lunits && pr >= 0 && pr <= 8) out.luprec = pr;
  return out;
}
/** The VPORT table's *Active records (a split screen) → doc.vports (panes.js shape) or null; the current one comes first. */
export function splitScreen(list) {
  const recs = (list || []).filter((v) => v && /^\*active$/i.test(v.name || '')).map((v) => {
    const sheet = xdataOf(v.xdata, 'CADCRAFT').map(([, s]) => String(s)).find((s) => s.startsWith('PANESHEET:'));
    return { x0: v.lowerLeft?.x, y0: v.lowerLeft?.y, x1: v.upperRight?.x, y1: v.upperRight?.y, cx: v.viewCenter?.x ?? v.center?.x, cy: v.viewCenter?.y ?? v.center?.y,
      h: v.viewHeight, ...(sheet ? { sheet: sheet.slice(10) } : {}) };
  });
  return vportsFrom(recs);
}

/** The VIEW table → doc.views; a paper-space view goes on the first sheet (DWG does not say which). */
function namedViews(list, layouts) {
  const out = [];
  for (const v of list || []) {
    if (!v || !v.name || !(v.width > 0) || !(v.height > 0) || !Number.isFinite(v.center?.x) || !Number.isFinite(v.center?.y)) continue;
    const t = v.target || {}, onPaper = !!v.paperSpace;
    if (onPaper && !layouts.length) continue;
    out.push({ name: String(v.name), cx: v.center.x + (t.x || 0), cy: v.center.y + (t.y || 0), w: v.width, h: v.height, ...(onPaper ? { layout: layouts[0].name } : {}) });
  }
  return out;
}

/** DIMLUNIT: 1–5 as units.js (6, Windows desktop, → 2 decimal); anything else dropped. */
function lunitOk(st) {
  if (st.lunit === undefined) return;
  const v = Math.round(+st.lunit);
  if (v >= 1 && v <= 5) st.lunit = v; else if (v === 6) st.lunit = 2; else delete st.lunit;
}

function color(e) {
  const c = e.color || {};
  if (c.rgb !== undefined) return hex(c.rgb);
  const i = c.index;
  if (i === 0) return 0;
  if (i >= 1 && i <= 255) return i;
  return null;   // ByLayer (256), none
}
/** The model's xdata of one application ({ APPNAME: [[code, value]…] }; names compared without case) → [[code, value]…]. */
function xdataOf(xdata, app) {
  if (!xdata || typeof xdata !== 'object') return [];
  const k = Object.keys(xdata).find((n) => n.toUpperCase() === app);
  return k && Array.isArray(xdata[k]) ? xdata[k] : [];
}
const hex = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

function plain(s) {
  return String(s || '').replace(/%%[cC]/g, '⌀').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '').replace(/%%%/g, '%')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function splinePoints(e) {
  if (e.fit && e.fit.length > 1) return e.fit;
  const cp = e.control || [], k = e.knots || [], p = e.degree || 3;
  if (cp.length < 2) return [];
  if (k.length !== cp.length + p + 1) return cp;
  const w = e.weights && e.weights.length === cp.length ? e.weights : null;
  const lo = k[p], hi = k[k.length - p - 1], n = Math.min(400, Math.max(16, cp.length * 8)), out = [];
  for (let s = 0; s <= n; s++) {
    const u = s === n ? hi - 1e-9 * (hi - lo) : lo + (hi - lo) * (s / n);
    let span = p;
    while (span < cp.length - 1 && u >= k[span + 1]) span++;
    const d = [];
    for (let j = 0; j <= p; j++) { const q = cp[span - p + j], wt = w ? w[span - p + j] : 1; d.push([q.x * wt, q.y * wt, wt]); }
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = span - p + j, den = k[i + p - r + 1] - k[i], a = den === 0 ? 0 : (u - k[i]) / den;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
    }
    out.push({ x: d[p][0] / d[p][2], y: d[p][1] / d[p][2] });
  }
  return out;
}

function hatchLoops(e) {
  const rings = [];
  for (const path of e.loops || []) {
    const pts = [];
    if (path.polyline) {
      const vs = path.polyline.vertices || [], n = vs.length;
      for (let i = 0; i < n; i++) {
        const a = vs[i], b = vs[(i + 1) % n];
        pts.push(a.x, a.y);
        if (Math.abs(a.bulge || 0) > 1e-9) arcBetween(pts, a, b, a.bulge);
      }
      if (n) pts.push(vs[0].x, vs[0].y);
    } else {
      for (const ed of path.edges || []) {
        if (ed.type === 'line') pts.push(ed.start.x, ed.start.y, ed.end.x, ed.end.y);
        else if (ed.type === 'arc') {
          let s = ed.startAngle, t = ed.endAngle;
          if (ed.ccw === false) { s = -s; t = -t; }   // a clockwise edge keeps its angles measured clockwise
          let sweep = ed.ccw === false ? s - t : t - s;
          while (sweep <= 0) sweep += TAU;
          const dir = ed.ccw === false ? -1 : 1, n = Math.max(4, Math.ceil(32 * sweep / TAU));
          for (let q = 0; q <= n; q++) { const a = s + dir * sweep * q / n; pts.push(ed.center.x + ed.radius * Math.cos(a), ed.center.y + ed.radius * Math.sin(a)); }
        } else if (ed.type === 'ellipse') {
          const len = Math.hypot(ed.majorAxis.x, ed.majorAxis.y) || 1, ratio = ed.ratio || 1, rot = Math.atan2(ed.majorAxis.y, ed.majorAxis.x);
          let sweep = ed.endAngle - ed.startAngle; while (sweep <= 0) sweep += TAU;
          const n = Math.max(8, Math.ceil(48 * sweep / TAU));
          for (let q = 0; q <= n; q++) {
            const t = ed.startAngle + sweep * q / n, x = len * Math.cos(t), y = len * ratio * Math.sin(t);
            pts.push(ed.center.x + x * Math.cos(rot) - y * Math.sin(rot), ed.center.y + x * Math.sin(rot) + y * Math.cos(rot));
          }
        } else if (ed.type === 'spline') {
          for (const p of splinePoints({ fit: ed.fit, control: ed.control, knots: ed.knots, degree: ed.degree, weights: ed.weights })) pts.push(p.x, p.y);
        }
      }
    }
    if (pts.length >= 6) rings.push(pts);
  }
  return rings;
}

function arcBetween(pts, p, q, b) {
  const theta = 4 * Math.atan(b), c = Math.hypot(q.x - p.x, q.y - p.y);
  if (!c) return;
  const r = c / (2 * Math.sin(theta / 2)), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, h = r * Math.cos(theta / 2);
  const ux = -(q.y - p.y) / c, uy = (q.x - p.x) / c, cx = mx + ux * h, cy = my + uy * h;
  const a0 = Math.atan2(p.y - cy, p.x - cx), n = Math.max(2, Math.ceil(16 * Math.abs(theta) / Math.PI));
  for (let k = 1; k < n; k++) { const t = a0 + theta * k / n; pts.push(cx + Math.abs(r) * Math.cos(t), cy + Math.abs(r) * Math.sin(t)); }
}
