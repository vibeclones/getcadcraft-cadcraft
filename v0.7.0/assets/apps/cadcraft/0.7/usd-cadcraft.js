/* SPDX-License-Identifier: Apache-2.0 */
/**
 * usd-cadcraft.js — the 3D tab's model as OpenUSD (0.7 XF.8, session `usd`; docs/USD-CONVENTIONS.md § 10). DOM-free.
 * The library is cc-usd (./usd/, a copy of lib/usd written by tools/usd/sync.mjs); the 3D model is ModelCraft's kernel
 * (./m3d/), written by the shared m3d writer: each solid (a group at the root) one Xform (kind component) with its faces
 * as a Mesh, colours as materials, a solid placed several times as one prototype. Metres, Z up.
 *
 *   cadUsd(model3d, { format = 'usda' | 'usdc' | 'usdz', name }) → { data, report: { objects, defs, prototypes } }
 */
import { UsdBuilder } from './usd/index.js';
import { writeM3d } from './usd/m3d.js';
import { faceTris, edgeFaces, isColor } from './m3d/model.js';

export function cadUsd(model3d, { format = 'usda', name = 'Drawing1' } = {}) {
  const b = new UsdBuilder({ app: 'CadCraft', source: name, doc: name });
  const report = writeM3d(b, model3d, { faceTris, edgeFaces, matOf: (paint) => (isColor(paint) ? b.colorMaterial(paint) : null) });
  return { data: format === 'usdz' ? b.usdz() : b.write(format), report };
}
