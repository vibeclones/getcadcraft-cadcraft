/* SPDX-License-Identifier: Apache-2.0 */
/**
 * scales.js — the drawing's own scale list (0.7 D7.19; SCALELISTEDIT). No DOM: bin/test-cadcraft.mjs runs it in Node.
 *
 * `doc.meta.scales` is null (the standard list only) or an array of { name, paper, drawing } — the file's ACAD_SCALELIST
 * (paper units : drawing units, so 1:50 is paper 1, drawing 50; 1/4" = 1'-0" is paper 0.25, drawing 12). Those that are
 * not already in sheets.js' standard list show up in the viewport and plot pickers (sheets.js scaleList); the whole list
 * is written back to DWG (ACAD_SCALELIST) and DXF 2000. Edits go through doc.setMeta, so they are one undo step.
 */
import { t } from './i18n.js';

export const MAX_SCALES = 500;
const NAME_RE = /^[^\u0000-\u001f]{1,255}$/;   // AutoCAD's own names hold : / " and ' (1:50, 1/4" = 1'-0")

/** A list from a file or a person → clean entries (finite positive numbers, a usable unique name), at most MAX_SCALES. */
export function cleanScales(list) {
  const out = [], seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s.name !== 'string') continue;
    const name = s.name.trim();
    if (!NAME_RE.test(name) || seen.has(name.toLowerCase())) continue;
    if (!(Number.isFinite(s.paper) && s.paper > 0 && Number.isFinite(s.drawing) && s.drawing > 0 && s.paper < 1e9 && s.drawing < 1e9)) continue;
    seen.add(name.toLowerCase());
    out.push({ name, paper: s.paper, drawing: s.drawing, ...(s.unit ? { unit: true } : {}) });
    if (out.length >= MAX_SCALES) break;
  }
  return out;
}

export const scalesOf = (doc) => (Array.isArray(doc.meta.scales) ? doc.meta.scales : []);
/** The n of 1:n a scale means. */
export const nOfScale = (s) => s.drawing / s.paper;

/** "1:75" → { paper: 1, drawing: 75 }; "2:1" → { paper: 2, drawing: 1 }; anything else → null. */
export function parseRatio(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const paper = Number(m[1]), drawing = Number(m[2]);
  return paper > 0 && drawing > 0 ? { paper, drawing } : null;
}
const fmt = (n) => Number(n.toPrecision(6)).toString();
/** The name a plain ratio gets. */
export const ratioName = (paper, drawing) => fmt(paper) + ':' + fmt(drawing);

/** Why a name or pair is refused, or null. `except` = the name being edited. */
export function problem(doc, { name, paper, drawing }, except = null) {
  if (!NAME_RE.test(String(name ?? '').trim())) return 'name';
  if (!(Number.isFinite(paper) && paper > 0 && Number.isFinite(drawing) && drawing > 0 && paper < 1e9 && drawing < 1e9)) return 'units';
  const low = String(name).trim().toLowerCase();
  if (scalesOf(doc).some((s) => s.name.toLowerCase() === low && s.name !== except)) return 'dup';
  if (scalesOf(doc).length >= MAX_SCALES && !except) return 'full';
  return null;
}

/** Add / edit / delete / reset inside doc.change (one undo step each). Returns { ok } or { error }. */
export function addScale(doc, s) {
  const e = problem(doc, s); if (e) return { error: e };
  const next = [...scalesOf(doc), { name: s.name.trim(), paper: s.paper, drawing: s.drawing }];
  doc.change('SCALELISTEDIT', () => doc.setMeta({ scales: next }));
  return { ok: true };
}
export function editScale(doc, oldName, s) {
  const list = scalesOf(doc), i = list.findIndex((x) => x.name === oldName);
  if (i < 0) return { error: 'missing' };
  const e = problem(doc, s, oldName); if (e) return { error: e };
  const next = list.slice(); next[i] = { name: s.name.trim(), paper: s.paper, drawing: s.drawing, ...(list[i].unit && s.paper === s.drawing ? { unit: true } : {}) };
  doc.change('SCALELISTEDIT', () => doc.setMeta({ scales: next }));
  return { ok: true };
}
export function deleteScale(doc, name) {
  const list = scalesOf(doc);
  if (!list.some((x) => x.name === name)) return { error: 'missing' };
  doc.change('SCALELISTEDIT', () => doc.setMeta({ scales: list.filter((x) => x.name !== name) }));
  return { ok: true };
}
/** Back to the standard list: the drawing keeps no list of its own. */
export function resetScales(doc) {
  if (doc.meta.scales == null) return { ok: true, same: true };
  doc.change('SCALELISTEDIT', () => doc.setMeta({ scales: null }));
  return { ok: true };
}

export const scaleLine = (s) => t('scales.line', { name: s.name, paper: fmt(s.paper), drawing: fmt(s.drawing) });
