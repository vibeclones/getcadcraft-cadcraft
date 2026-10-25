/* SPDX-License-Identifier: Apache-2.0 */
/**
 * lines.js — process and signal lines of a P&ID (0.7 LC.5). DOM-free (tested in Node).
 *
 * A line is one add-on object (kind `pidline`, 'world' frame): a polyline of corner points with a style, a flow arrow and — for a
 * process line — a LINE NUMBER built from its fields by a scheme the person can change. The default scheme reads
 * size-service-sequence-spec ("2"-PW-101-A1A"); it is CadCraft's own convention for a drafting aid, not a company's or a
 * standard's: any text is allowed (`lnOverride`).
 *
 *   STYLES                 process | pneumatic | electric | software | capillary (the signal styles follow the ideas of ISA-5.1)
 *   cleanLine(raw)         untrusted data → clean data | null (`lbl`: write the line number on this piece; a line cut into pieces by
 *                          valves carries it on the longest one)
 *   lineNumber(d, fmt)     the number the line carries (the override, else the scheme filled with its fields)
 *   nextSeq(lines, svc)    the next free sequence number for a service (101, 102, …)
 *   drawLine(d)            entities (the line, hash marks, arrows, the number written along it)
 *   transformLine(d, m)    the line after a move / rotate / scale / mirror (m = CadCraft's 2×3 matrix)
 *   endsOf(d)              the two ends [{x, y, a}] (a = the direction the line leaves in)
 */

import { pointAtLongest, readable } from './core.js';

export const STYLES = ['process', 'pneumatic', 'electric', 'software', 'capillary'];
export const ARROWS = ['none', 'end', 'start', 'both'];
export const DEFAULT_FORMAT = '{size}-{svc}-{seq}-{spec}';
export const LIMITS = { pts: 100, text: 40 };
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

export function cleanLine(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.pts)) return null;
  const pts = raw.pts.slice(0, LIMITS.pts).filter((p) => Array.isArray(p) && fin(p[0]) && fin(p[1])).map((p) => [p[0], p[1]]);
  const cleanPts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
  if (cleanPts.length < 2) return null;
  const str = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.text);
  const k = fin(raw.k) && raw.k > 0 ? raw.k : 1;
  return {
    pts: cleanPts, style: STYLES.includes(raw.style) ? raw.style : 'process',
    size: str(raw.size), svc: str(raw.svc), seq: str(raw.seq), spec: str(raw.spec), lnOverride: str(raw.lnOverride), insul: str(raw.insul),
    arrow: ARROWS.includes(raw.arrow) ? raw.arrow : 'end', lbl: raw.lbl !== false, k, th: fin(raw.th) && raw.th > 0 ? raw.th : k * 0.2,
  };
}

export function lineNumber(d, fmt = DEFAULT_FORMAT) {
  if (d.lnOverride) return d.lnOverride;
  if (d.style !== 'process') return '';
  const f = { size: d.size, svc: d.svc, seq: d.seq, spec: d.spec };
  if (!f.size && !f.svc && !f.seq && !f.spec) return '';
  return String(fmt || DEFAULT_FORMAT).replace(/\{(\w+)\}/g, (m, k) => (k in f ? f[k] : m)).replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

/** The next sequence number for a service among line data: the largest numeric seq of that service + 1, from 101. */
export function nextSeq(lines, svc) {
  let max = 100;
  for (const d of lines) if (d.svc === svc) { const n = parseInt(d.seq, 10); if (Number.isFinite(n) && n > max) max = n; }
  return String(max + 1);
}

export function endsOf(d) {
  const n = d.pts.length, [ax, ay] = d.pts[0], [bx, by] = d.pts[1], [cx, cy] = d.pts[n - 1], [ex, ey] = d.pts[n - 2];
  return [{ x: ax, y: ay, a: Math.atan2(ay - by, ax - bx) }, { x: cx, y: cy, a: Math.atan2(cy - ey, cx - ex) }];
}

const LT = { process: null, pneumatic: null, electric: 'DASHED', software: 'DOT', capillary: 'DASHDOT' };
export const LAYER_OF = { process: 'PID-LINE-PROC', pneumatic: 'PID-LINE-SIGNAL', electric: 'PID-LINE-SIGNAL', software: 'PID-LINE-SIGNAL', capillary: 'PID-LINE-SIGNAL' };

export function drawLine(d, fmt = DEFAULT_FORMAT) {
  const out = [];
  const pl = { type: 'poly', closed: false, pts: d.pts.map(([x, y]) => ({ x, y, b: 0 })) };
  if (LT[d.style]) pl.lt = LT[d.style];
  out.push(pl);
  // pneumatic signals: short slashes across the line, one every 4 symbol-lengths of paper-ish size (here: 0.5 of the symbol size)
  if (d.style === 'pneumatic') {
    const step = d.k * 0.5, tick = d.k * 0.1;
    for (let i = 1; i < d.pts.length; i++) {
      const [ax, ay] = d.pts[i - 1], [bx, by] = d.pts[i], len = Math.hypot(bx - ax, by - ay);
      if (len < step) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      for (let s = step; s < len - step / 2; s += step) {
        const px = ax + ux * s, py = ay + uy * s;
        out.push({ type: 'line', x1: px - tick * (ux - uy), y1: py - tick * (uy + ux), x2: px + tick * (ux - uy), y2: py + tick * (uy + ux) });
      }
    }
  }
  const [s0, s1] = endsOf(d);
  const arrow = (e) => {   // a solid triangle whose tip is the line's end, pointing the way the line leaves
    const len = d.k * 0.3, half = d.k * 0.1, ux = -Math.cos(e.a), uy = -Math.sin(e.a), nx = -uy, ny = ux;
    const bx = e.x + ux * len, by = e.y + uy * len;
    return { type: 'hatch', solid: true, loops: [[e.x, e.y, bx + nx * half, by + ny * half, bx - nx * half, by - ny * half]] };
  };
  if (d.arrow === 'end' || d.arrow === 'both') out.push(arrow(s1));
  if (d.arrow === 'start' || d.arrow === 'both') out.push(arrow(s0));
  const ln = lineNumber(d, fmt);
  const mid = ln && d.lbl ? pointAtLongest(d.pts) : null;   // a line cut by valves writes its number on one piece (lbl)
  if (mid) {   // the number reads left to right, just above the line
    const rot = readable(mid.ang), off = d.th * 0.9;
    out.push({ type: 'text', x: mid.x - Math.sin(rot) * off, y: mid.y + Math.cos(rot) * off, h: d.th, rot, s: ln, ha: 'center', va: 'middle' });
  }
  return out;
}

export function transformLine(d, m) {
  const out = structuredClone(d);
  out.pts = d.pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  if (sc > 1e-12 && Math.abs(sc - 1) > 1e-12) { out.k = d.k * sc; out.th = d.th * sc; }
  return out;
}
