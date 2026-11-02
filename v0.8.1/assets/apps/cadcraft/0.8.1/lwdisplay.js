/* SPDX-License-Identifier: Apache-2.0 */
/**
 * lwdisplay.js — how wide a lineweight draws on screen when lineweight display is on (status bar LWT, LWDISPLAY).
 * No DOM. Off (the default, as in AutoCAD) every line is 1 px.
 *
 *   lwPixels(lw, paperPxPerMm = 0)
 *     lw: mm (walk.js `out.stroke` third argument); below 0 (-3 default, -2/-1 unresolved) = DEFAULT_LW.
 *     Screen weight: 0.25 mm or less = 1 px, above that in proportion (0.5 mm = 2 px), at most MAX_PX —
 *     the same rule as BimCraft's print view. On a sheet (paperPxPerMm > 0 = CSS px per paper mm) a weight is
 *     its true paper width, never thinner than its screen weight.
 */

export const DEFAULT_LW = 0.25;
export const MAX_PX = 12;

export function lwPixels(lw, paperPxPerMm = 0) {
  const mm = Number.isFinite(lw) && lw >= 0 ? lw : DEFAULT_LW;
  const screen = Math.min(MAX_PX, Math.max(1, mm / 0.25));
  return paperPxPerMm > 0 ? Math.max(screen, mm * paperPxPerMm) : screen;
}
