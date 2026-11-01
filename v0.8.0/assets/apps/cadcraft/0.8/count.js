/* SPDX-License-Identifier: Apache-2.0 */
/**
 * count.js — count block references, highlight them, export counts and attribute tables (0.4 C34; owner: cad-files).
 * DOM-free: layertools.js installs COUNT, and bin/test-cadcraft.mjs drives it.
 *
 *   countBlocks(doc, entities)   → [{ block, n, ids }] most first, then by name (unnamed *blocks — dimensions, tables,
 *                                  hatches — left out; references inside other blocks are not counted)
 *   countsCsv(doc)               → CSV: Block, In the model, On sheets, Total
 *   attributesCsv(doc)           → CSV, one row per reference (model, then sheets): Block, Space, Layer, X, Y, Rotation,
 *                                  then one column per attribute tag (every tag any reference has, in first-seen order)
 *   COUNT (in layertools.js): pick a reference → every reference of its block in this space is selected and counted;
 *   Enter / A → the list; E → export (C counts | A attributes) as a .csv download
 * CSV: comma-separated, quoted when needed, CRLF; a cell starting with = + - @ gets a leading ' (formula injection).
 */
import { t } from './i18n.js';

export function countBlocks(doc, entities) {
  const by = new Map();
  for (const e of entities) {
    if (e.type !== 'insert' || !e.block || e.block.startsWith('*')) continue;
    let r = by.get(e.block);
    if (!r) by.set(e.block, (r = { block: e.block, n: 0, ids: [] }));
    r.n++; r.ids.push(e.id);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.block.localeCompare(b.block, undefined, { numeric: true }));
}

const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const num = (v) => (Number.isFinite(v) ? +v.toFixed(6) : '');

export function countsCsv(doc) {
  const model = countBlocks(doc, doc.model.values());
  const sheets = countBlocks(doc, doc.layouts.flatMap((l) => [...l.entities.values()]));
  const names = [...new Set([...model, ...sheets].map((r) => r.block))];
  const m = new Map(model.map((r) => [r.block, r.n])), s = new Map(sheets.map((r) => [r.block, r.n]));
  const rows = names.map((n) => [n, m.get(n) || 0, s.get(n) || 0, (m.get(n) || 0) + (s.get(n) || 0)]).sort((a, b) => b[3] - a[3] || String(a[0]).localeCompare(String(b[0])));
  return csv([[t('count.col.block'), t('count.col.model'), t('count.col.sheets'), t('count.col.total')], ...rows]);
}

export function attributesCsv(doc) {
  const refs = [];
  const add = (e, space) => { if (e.type === 'insert' && e.block && !e.block.startsWith('*')) refs.push({ e, space }); };
  for (const e of doc.model.values()) add(e, t('count.model'));
  for (const l of doc.layouts) for (const e of l.entities.values()) add(e, l.name);
  const tags = [];
  for (const { e } of refs) for (const k of Object.keys(e.attrs || {})) if (!tags.includes(k)) tags.push(k);
  const head = [t('count.col.block'), t('count.col.space'), t('count.col.layer'), 'X', 'Y', t('count.col.rotation'), ...tags];   // i18n-ignore: X, Y
  return csv([head, ...refs.map(({ e, space }) => [e.block, space, e.layer, num(e.x), num(e.y), num(((e.rot || 0) * 180) / Math.PI), ...tags.map((k) => e.attrs?.[k] ?? '')])]);
}
