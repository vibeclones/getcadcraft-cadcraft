/* SPDX-License-Identifier: Apache-2.0 */
/**
 * laser-file.js — the Laser panel's settings in the drawing file (0.7 SU.772, session laser-cad; owner 2026-10-23: "keep the laser
 * settings in the DWG file too, and DXF"). DOM-free. Kept the way the plot style tables are (plotstyle.js): an unused block
 * CADCRAFT_LASER whose POINTs carry the job as CADCRAFT xdata strings ("CCLASER:<n>:<230 characters>" of one JSON text). Nothing
 * references the block, so other programs open the drawing unchanged (they keep an unused block; PURGE may drop it); a file
 * without it opens with the panel's defaults. dwg-save.js writes it (DWG 2000–2018 and DXF 2000, which is built from the same
 * model), dxf.js writes it in DXF R12 and reads it from any DXF, dwg-import.js reads it from a DWG; doc.load keeps it as
 * `doc.meta.laser` (cleaned by laser-model.js `cleanJob`, the file is untrusted).
 *
 *   laserPayload(doc) → [[string]…] one per POINT, or null when the drawing has no laser settings
 *   laserFromPayload(ents) → the job (cleanJob) or null; ents = [{ cc: [string…] }] (each POINT's CADCRAFT xdata strings)
 *   LASER_BLOCK, isLaserBlock(name)
 */
import { cleanJob } from './laser/laser-model.js';

export const LASER_BLOCK = 'CADCRAFT_LASER';
const PAYLOAD = 'cadcraft-laser', CHUNK = 230, MAX_TEXT = 2_000_000;
export const isLaserBlock = (name) => String(name || '').toUpperCase() === LASER_BLOCK;

/** The job worth keeping: settings with at least one layer, else null. */
export function keptJob(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const job = cleanJob(obj);
  return job.layers.length ? job : null;
}

export function laserPayload(doc) {
  const job = keptJob(doc?.meta?.laser);
  if (!job) return null;
  // ASCII only (a layer may be named in any language): every other character as a JSON \uXXXX escape, so each string is the same
  // bytes in an R12 DXF's code page, a DXF 2000 and a DWG
  const text = JSON.stringify({ format: PAYLOAD, version: 1, job }).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const points = [];
  for (let i = 0; i < text.length; i += CHUNK) points.push(['CCLASER:' + (points.length + 1) + ':' + text.slice(i, i + CHUNK)]);
  return points;
}

export function laserFromPayload(ents) {
  const parts = [];
  for (const e of ents || []) {
    const m = /^CCLASER:(\d{1,7}):(.*)$/s.exec(String(e?.cc?.[0] ?? ''));
    if (m) parts.push([+m[1], m[2]]);
  }
  if (!parts.length) return null;
  parts.sort((a, b) => a[0] - b[0]);
  const text = parts.map((p) => p[1]).join('');
  if (text.length > MAX_TEXT) return null;
  try {
    const o = JSON.parse(text);
    return o && o.format === PAYLOAD && o.version === 1 ? keptJob(o.job) : null;
  } catch { return null; }
}
