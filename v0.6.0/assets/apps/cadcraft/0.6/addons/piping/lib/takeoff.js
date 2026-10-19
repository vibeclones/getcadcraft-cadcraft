/* SPDX-License-Identifier: Apache-2.0 */
/**
 * takeoff.js — the pipe schedule as TakeoffCraft items (0.5 MQ.5), as hvac/lib/takeoff.js does for ducts.
 *
 *   pipeItems(runs)              pipe by material, class and size (linear: a mark along each stretch of the centerline, sloped
 *                                runs measured along their slope), fittings and valves by kind and size (count marks)
 *   pipeTakeoffPdf(doc, runs)    the plan as a PDF with that takeoff inside (TakeoffCraft opens it)
 *   pipePack(runs, name)         the same assemblies as a TakeoffCraft pack, no quantities, no rates
 * Steel pipe's assembly carries its weight (ASME B36.10M plain-end weight per length); rates are left to the estimator.
 */

import { t, fmtNum, takeoffPdf, takeoffPack, packKey } from './mep-core.js';
import { schedule, sizeOf } from './pipe.js';
import { steelWeightLbFt, steelWeightKgM } from './tables.js';

/** The references a pack names (standards' titles stay as published; our own line is in the person's language). */
export const sources = () => [
  { id: 'asme-b36-10m', title: 'ASME B36.10M, Welded and Seamless Wrought Steel Pipe', publisher: 'ASME' },   // i18n-ignore: a standard's title
  { id: 'astm-b88', title: 'ASTM B88, Seamless Copper Water Tube', publisher: 'ASTM International' },   // i18n-ignore: a standard's title
  { id: 'astm-d1785', title: 'ASTM D1785, Poly(Vinyl Chloride) (PVC) Plastic Pipe, Schedules 40, 80, and 120', publisher: 'ASTM International' },   // i18n-ignore: a standard's title
  { id: 'astm-f876', title: 'ASTM F876, Crosslinked Polyethylene (PEX) Tubing', publisher: 'ASTM International' },   // i18n-ignore: a standard's title
  { id: 'drawn-geometry', title: t('pack.source.drawn'), publisher: t('pack.source.by') },
];
const SOURCE_OF = { steel: 'asme-b36-10m', copper: 'astm-b88', pvc: 'astm-d1785', pex: 'astm-f876' };
/** CSI MasterFormat 2018 numbers by system: the piping, and its valves. */
export const CSI = {
  cw: ['22 11 16', '22 05 23'], hw: ['22 11 16', '22 05 23'], hwr: ['22 11 16', '22 05 23'], san: ['22 13 16', '22 05 23'], vent: ['22 13 16', '22 05 23'],
  storm: ['22 14 13', '22 05 23'], chw: ['23 21 13', '23 05 23'], hhw: ['23 21 13', '23 05 23'], gas: ['23 11 23', '23 05 23'], fire: ['21 11 00', '21 05 23'], other: [null, null],
};
const num = (v) => String(+v.toFixed(6));

/** Items from the runs. */
export function pipeItems(runs) {
  const S = schedule(runs), imp = S.u === 'in';
  const items = [];
  for (const r of S.pipes) {
    const p = sizeOf({ mat: r.mat, cls: r.cls }, r.size);
    const comps = r.mat === 'steel' ? [{ name: t('tk.weight'), unit: imp ? 'lb' : 'kg', formula: 'L*' + num(imp ? steelWeightLbFt(p.od, p.wall) : steelWeightKgM(p.od * 25.4, p.wall * 25.4)) }] : [];
    const csi = CSI[r.sys]?.[0];
    items.push({ name: r.name, type: 'linear', unit: imp ? 'LF' : 'm', ...(csi ? { csi } : {}), components: comps, mat: r.mat, qty: r.len,
      marks: r.marks.map((m) => (m.slope > 0 ? { pts: m.pts, slopes: m.pts.slice(1).map(() => ({ k: 'rake', p: m.slope * 12 })) } : m.pts)) });
  }
  for (const f of S.fittings) {
    const csi = CSI[f.sys]?.[f.kind === 'valve' ? 1 : 0];
    items.push({ name: f.name, type: 'count', unit: 'EA', ...(csi ? { csi } : {}), components: [], mat: f.mat, qty: f.n, marks: f.at.map((p) => [p]) });
  }
  return { S, items };
}

export async function pipeTakeoffPdf(doc, runs) {
  if (!runs.length) throw new Error(t('err.nopipes'));
  const { S, items } = pipeItems(runs);
  const name = (doc.meta?.name || 'Drawing1') + ' ' + t('tk.suffix');
  const longest = S.pipes.flatMap((r) => r.marks.map((m) => m.pts)).flatMap((pts) => pts.slice(1).map((q, i) => [pts[i], q]))
    .sort((a, b) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) - Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]))[0] || null;
  const r = await takeoffPdf(doc, {
    name, cal: longest,
    build: (toPt) => items.map((it) => ({ name: it.name, type: it.type, unit: it.unit, csi: it.csi, components: it.components,
      marks: it.marks.map((m) => (Array.isArray(m) ? m.map(toPt) : { pts: m.pts.map(toPt), slopes: m.slopes })) })),
  });
  return { ...r, S };
}

export function pipePack(runs, drawingName = 'Drawing1') {
  if (!runs.length) throw new Error(t('err.nopipes'));
  const { items } = pipeItems(runs);
  const used = new Set();
  const slug = String(drawingName).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'drawing';
  return takeoffPack({
    id: 'piping.' + slug, name: t('pack.name', { name: drawingName }).slice(0, 80), trade: t('pack.trade'), description: t('pack.description'),
    sources: sources(), csi: items.map((i) => i.csi).filter(Boolean),
    items: items.map((it) => ({
      key: packKey(it.name, used), name: it.name, type: it.type, unit: it.unit, waste: 0, ...(it.csi ? { csi: it.csi } : {}),
      sources: [SOURCE_OF[it.mat], 'drawn-geometry'].filter(Boolean), assume: [t(it.type === 'count' ? 'pack.assume.count' : 'pack.assume.pipe')],
      components: it.components.map((c) => ({ ...c, waste: 0 })),
      note: t('pack.note', { qty: fmtNum(it.qty, it.type === 'count' ? 0 : 1), unit: it.unit }),
    })),
  });
}
