/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — plot output field names; nothing here is read by a person. */
/**
 * pdf-emit.js — a PDF underlay's vector content as walk.js output calls, for plotting (0.7 D7.24). DOM-free.
 *
 *   emitPdf(vec, p, out)    vec = pdf-vector.js extractPage result; p = walk.js out.pdf's argument (m: page points → output units,
 *                           clip, alpha, mono); out = walk.js output (stroke, fill, text). Lines, curves (8 chords each), fills
 *                           (even-odd or non-zero as the PDF says) and text. Pictures inside the PDF are not printed.
 */
import { clipOut } from './xclip.js';
import { FONT_EM } from './geom.js';

const STEPS = 8;
export function emitPdf(vec, p, out0) {
  const m = p.m, X = (x, y) => m[0] * x + m[2] * y + m[4], Y = (x, y) => m[1] * x + m[3] * y + m[5];
  const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1, rot0 = Math.atan2(m[1], m[0]);
  const clip = p.clipped && p.clip && p.clip.length >= 6 ? p.clip.reduce((a, v, i) => (i % 2 ? (a[a.length - 1].y = v, a) : (a.push({ x: v, y: 0 }), a)), []) : null;
  const out = clip ? clipOut(out0, clip) : out0;
  const o = { alpha: p.alpha ?? 1 };
  const col = (hex) => (p.mono || !hex || hex === '#000000' ? 'ink' : hex === '#ffffff' ? 'ink' : hex);
  for (const sh of vec.shapes) {
    const strokes = [], loops = [];
    for (const sub of sh.subs) {
      const ring = [];
      let px = 0, py = 0;
      for (const op of sub.ops) {
        if (op[0] === 'M') { px = op[1]; py = op[2]; ring.push(X(px, py), Y(px, py)); }
        else if (op[0] === 'L') { px = op[1]; py = op[2]; ring.push(X(px, py), Y(px, py)); }
        else {
          for (let s = 1; s <= STEPS; s++) {
            const t = s / STEPS, u = 1 - t;
            const x = u * u * u * px + 3 * u * u * t * op[1] + 3 * u * t * t * op[3] + t * t * t * op[5];
            const y = u * u * u * py + 3 * u * u * t * op[2] + 3 * u * t * t * op[4] + t * t * t * op[6];
            ring.push(X(x, y), Y(x, y));
          }
          px = op[5]; py = op[6];
        }
      }
      if (ring.length < 4) continue;
      if (sh.fill && ring.length >= 6) loops.push(ring);
      if (sh.stroke) {
        for (let i = 0; i + 3 < ring.length; i += 2) strokes.push({ k: 'L', x1: ring[i], y1: ring[i + 1], x2: ring[i + 2], y2: ring[i + 3] });
        if (sub.closed && ring.length >= 6) strokes.push({ k: 'L', x1: ring[ring.length - 2], y1: ring[ring.length - 1], x2: ring[0], y2: ring[1] });
      }
    }
    if (loops.length) out.fill(col(sh.fill), loops, true, o);
    if (strokes.length) out.stroke(col(sh.stroke), strokes, Math.max(0.05, sh.lw * k), o);
  }
  for (const tx of vec.texts) {
    out.text('ink', { type: 'text', x: X(tx.x, tx.y), y: Y(tx.x, tx.y), h: tx.h * k / FONT_EM, rot: (((tx.rot + rot0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), s: tx.s, ha: 'left', va: 'baseline', layer: '0' }, o);
  }
}
