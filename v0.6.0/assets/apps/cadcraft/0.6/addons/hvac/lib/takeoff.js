/* SPDX-License-Identifier: Apache-2.0 */
/**
 * takeoff.js — the duct schedule as TakeoffCraft items (0.5 MQ.5). DOM-free except that the PDF is plotted with CadCraft's
 * own plot.js (no DOM either).
 *
 *   ductItems(runs)               the schedule's rows as TakeoffCraft items (assemblies; marks in drawing coordinates)
 *   ductTakeoffPdf(doc, runs)     the plan as a PDF with the takeoff inside: straight duct as linear marks along each piece
 *                                 (one item per shape, size and material), fittings as count marks where they sit (one item
 *                                 per fitting and size); each item's assembly has the sheet metal it needs. TakeoffCraft
 *                                 opens the PDF and offers the takeoff in it (its T10 "takeoff inside the PDF").
 *   ductPack(runs, name)          the same assemblies as a TakeoffCraft trade pack (format docs/ADDONS-SPEC.md §13): no
 *                                 quantities, no rates — Library › Trade packs › Open a pack file.
 * Quantities are TakeoffCraft's own: it measures the marks at the sheet's scale. No rates anywhere: a rate is the estimator's.
 */

import { t, fmtNum, takeoffPdf, takeoffPack, packKey } from './mep-core.js';
import { schedule } from './duct.js';

/** The references a pack names (titles of standards stay as published; our own line is in the person's language). */
export const sources = () => [
  { id: 'ashrae-fundamentals', title: 'ASHRAE Handbook—Fundamentals, Duct Design chapter', publisher: 'ASHRAE', edition: '2021' },   // i18n-ignore: a book's title
  { id: 'drawn-geometry', title: t('pack.source.drawn'), publisher: t('pack.source.by') },
];
/** CSI MasterFormat 2018 numbers by duct material. */
export const CSI = { galv: '23 31 13', smooth: '23 31 13', board: '23 31 16', flex: '23 33 46' };

const num = (v) => String(+v.toFixed(6));

/** Items from the runs: ducts (linear) and fittings (count), with the sheet metal as each assembly's component. */
export function ductItems(runs) {
  const S = schedule(runs), imp = S.u === 'in';
  const areaUnit = imp ? 'SF' : 'm²', per = (p) => (imp ? p / 12 : p / 1000);   // perimeter in ft or m per unit of length
  const sheet = t('tk.sheet');
  const items = [];
  for (const r of S.ducts) {
    items.push({ name: r.name, type: 'linear', unit: imp ? 'LF' : 'm', csi: CSI[r.mat] || CSI.galv, components: [{ name: sheet, unit: areaUnit, formula: 'L*' + num(per(r.perimeter)) }], marks: r.pieces, qty: r.len, area: r.area });
  }
  for (const f of S.fittings) {
    items.push({ name: f.name, type: 'count', unit: 'EA', csi: CSI[f.mat] || CSI.galv, components: [{ name: sheet, unit: areaUnit, formula: 'N*' + num(f.areaEach) }], marks: f.at.map((p) => [p]), qty: f.n, area: f.area });
  }
  return { S, items };
}

/** The plan with its takeoff inside (see the header). → { bytes, project, hash, scale, ftPerUnit, S } */
export async function ductTakeoffPdf(doc, runs) {
  if (!runs.length) throw new Error(t('err.noducts'));
  const { S, items } = ductItems(runs);
  const longest = S.ducts.flatMap((r) => r.pieces).sort((a, b) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) - Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]))[0] || null;
  const name = (doc.meta?.name || 'Drawing1') + ' ' + t('tk.suffix');
  const r = await takeoffPdf(doc, {
    name,
    cal: longest,
    build: (toPt) => items.map((it) => ({ name: it.name, type: it.type, unit: it.unit, csi: it.csi, components: it.components, marks: it.marks.map((m) => m.map(toPt)) })),
  });
  return { ...r, S };
}

/** The drawing's duct and fitting assemblies as a TakeoffCraft pack (no quantities, no rates). */
export function ductPack(runs, drawingName = 'Drawing1') {
  if (!runs.length) throw new Error(t('err.noducts'));
  const { items } = ductItems(runs);
  const used = new Set();
  return takeoffPack({
    id: 'hvac.' + (String(drawingName).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'drawing'),
    name: t('pack.name', { name: drawingName }).slice(0, 80),
    trade: t('pack.trade'),
    description: t('pack.description'),
    sources: sources(),
    csi: items.map((i) => i.csi),
    items: items.map((it) => ({
      key: packKey(it.name, used), name: it.name, type: it.type, unit: it.unit, waste: 0, csi: it.csi,
      sources: sources().map((s) => s.id), assume: [t(it.type === 'count' ? 'pack.assume.fitting' : 'pack.assume.duct')],
      components: it.components.map((c) => ({ ...c, waste: 0 })),
      note: t('pack.note', { qty: fmtNum(it.qty, it.type === 'count' ? 0 : 1), unit: it.unit }),
    })),
  });
}
