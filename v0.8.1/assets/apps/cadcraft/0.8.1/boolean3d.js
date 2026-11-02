/* SPDX-License-Identifier: Apache-2.0 */
/**
 * boolean3d.js — union, subtract and intersect solids on the 3D tab (0.4 C12; owner: cad-files). DOM-free: the 3D
 * commands (commands3d.js) and bin/test-cadcraft-3d.mjs use it. The work is done by manifold-3d (Apache-2.0, vendored;
 * the app's import map names it), loaded the first time a boolean runs.
 *
 *   manifold(load?)                       → Promise<the manifold module> (once)
 *   booleanSolids(M, model, op, a, b)     op 'union' | 'subtract' | 'intersect'; a, b = root instance ids (b: the ones
 *                                         taken away, for subtract; for the others a holds every solid and b is []).
 *                                         → { iid, faces, volume } — one new solid in place of all of them, in one change
 *                                         of the model (one undo step); throws Error with a plain message when a solid is
 *                                         not closed or the result is empty
 *   solidTriangles(model, iid)            → [[x,y,z]×3 …] in meters (the instance with everything nested in it)
 *
 * Solids are welded and moved near the origin before manifold sees them (its vertices are 32-bit floats), and back after.
 * The result is one group whose coplanar triangles read as one face (m3d meshDef).
 */
import { faceTris, meshDef, solidInfo } from './m3d/model.js';
import { apply, mmul, translation } from './m3d/vec.js';
import { t } from './i18n.js';

let modulePromise = null;
/** The manifold-3d module, set up once. `load` lets Node tests pass the vendored file. */
export function manifold(load = () => import('manifold-3d')) {
  modulePromise ??= load().then(async (mod) => { const M = await (mod.default || mod)(); M.setup(); return M; });
  return modulePromise;
}

/** Every triangle of a root instance (its definition and the instances inside it), in meters. */
export function solidTriangles(model, iid) {
  const inst = model.root.insts.get(iid);
  if (!inst) return [];
  const out = [];
  const visit = (def, m, depth) => {
    if (!def || depth > 32) return;
    for (const f of def.faces.values()) for (const t of faceTris(def, f)) out.push(t.map((v) => apply(m, def.verts.get(v))));
    for (const sub of def.insts.values()) visit(model.def(sub.def), mmul(m, sub.m), depth + 1);
  };
  visit(model.def(inst.def), inst.m, 0);
  return out;
}

/** Triangles (meters) → a manifold Manifold near the origin `o`; throws when they do not close a volume. */
function toManifold(M, tris, o, label) {
  const key = new Map(), verts = [], idx = [];
  const vid = (p) => {
    const q = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const k = q.map((x) => Math.round(x * 1e7)).join(',');   // weld to 0.1 µm
    let i = key.get(k);
    if (i === undefined) { i = verts.length / 3; key.set(k, i); verts.push(q[0], q[1], q[2]); }
    return i;
  };
  for (const t of tris) {
    const a = vid(t[0]), b = vid(t[1]), c = vid(t[2]);
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  const mesh = new M.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(idx) });
  mesh.merge();
  const man = new M.Manifold(mesh);
  if (man.status() !== 'NoError' || man.isEmpty()) { man.delete?.(); throw new Error(t('cmd.bool.open', { name: label })); }
  return man;
}

export function booleanSolids(M, model, op, a, b = []) {
  const all = [...a, ...b];
  if (op === 'subtract' ? !(a.length && b.length) : all.length < 2) throw new Error(t(op === 'subtract' ? 'cmd.bool.need.subtract' : 'cmd.bool.need.two'));
  const tris = new Map(all.map((iid) => [iid, solidTriangles(model, iid)]));
  // the origin: the middle of everything, so the 32-bit vertices keep their precision
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const ts of tris.values()) for (const t of ts) for (const p of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const o = lo.map((v, k) => (v + hi[k]) / 2);
  const names = new Map([...model.root.insts].map(([iid, inst]) => [iid, model.def(inst.def)?.name || 'Solid']));
  const made = [];
  try {
    const of = (iid) => { const m = toManifold(M, tris.get(iid), o, names.get(iid) || t('cmd.bool.asolid')); made.push(m); return m; };
    const A = a.map(of), B = b.map(of);
    let r;
    if (op === 'union') r = M.Manifold.union(A);
    else if (op === 'intersect') r = M.Manifold.intersection(A);
    else r = M.Manifold.union(A).subtract(M.Manifold.union(B));
    made.push(r);
    if (r.isEmpty()) throw new Error(t(op === 'intersect' ? 'cmd.bool.empty.intersect' : 'cmd.bool.empty'));
    const g = r.getMesh();
    // back from 32-bit floats: each corner on the 1 µm grid of the drawing (exact sizes stay exact), relative to o again
    const r6 = (v, k) => Math.round((o[k] + v) * 1e6) / 1e6 - o[k];
    const P = (i) => [r6(g.vertProperties[i * g.numProp], 0), r6(g.vertProperties[i * g.numProp + 1], 1), r6(g.vertProperties[i * g.numProp + 2], 2)];
    const polys = [];
    for (let i = 0; i < g.triVerts.length; i += 3) polys.push([P(g.triVerts[i]), P(g.triVerts[i + 1]), P(g.triVerts[i + 2])]);
    const label = { union: 'UNION', subtract: 'SUBTRACT', intersect: 'INTERSECT' }[op];
    const base = names.get(a[0]) || 'Solid';
    let iid = null;
    model.change(label, (m) => {
      const def = meshDef(m, polys, m.uniqueName(base.replace(/\s*\(\d+\)$/, '')), 'group');
      for (const id of all) m.root.insts.delete(id);
      iid = m.place(m.root, def.id, translation(o));
    });
    const def = model.def(model.root.insts.get(iid).def);
    const info = solidInfo(def);
    return { iid, faces: info.faces, volume: Math.abs(info.volume), closed: info.closed };
  } finally {
    for (const m of made) m.delete?.();
  }
}
