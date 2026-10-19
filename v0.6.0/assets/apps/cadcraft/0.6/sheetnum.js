/* SPDX-License-Identifier: Apache-2.0 */
/**
 * sheetnum.js — the sheet number a layout tab shows when Settings › CadCraft › Sheet tabs is "Sheet numbers only"
 * (0.5 WL.9). DOM-free.
 *
 *   sheetNumberOf(name, set?) → the number: the open sheet set's for that layout when it has one, else the first word of
 *                               the name when it reads like a sheet number (A-101, A1.01, S-2.3, E101, 12, M-201A), else
 *                               null (the tab keeps the name)
 */
const NUMBER = /^([A-Z]{0,4}[-.]?\d{1,5}(?:[.-]\d{1,4}){0,3}[A-Z]?)(?=$|[\s_:—–-]+\S)/i;

export function sheetNumberOf(name, set = null) {
  const n = String(name ?? '').trim();
  if (set && Array.isArray(set.sheets)) {
    const s = set.sheets.find((x) => x.layout === n && x.number);
    if (s) return String(s.number);
  }
  const m = NUMBER.exec(n);
  return m ? m[1] : null;
}
