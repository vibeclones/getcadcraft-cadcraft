/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pcommands.js — the parametric commands, AutoCAD's names and prompts (DOM-free; commands.js installs them with
 * its own def(), and bin/test-cadcraft-constraints.mjs drives them through the stub host).
 *
 *   GEOMCONSTRAINT (GCON) → GCHORIZONTAL GCVERTICAL GCPERPENDICULAR GCPARALLEL GCTANGENT GCCOINCIDENT GCCONCENTRIC
 *     GCCOLLINEAR GCSYMMETRIC GCEQUAL GCFIX
 *   DIMCONSTRAINT (DCON) → DCLINEAR DCHORIZONTAL DCVERTICAL DCALIGNED DCRADIUS DCDIAMETER DCANGULAR DCCONVERT
 *   PARAMETERS (PAR: the panel; host.parameters) · -PARAMETERS (the same at the command line: New/Edit/Rename/Delete/?)
 *   CONSTRAINTBAR (CBAR) · DCDISPLAY · DELCONSTRAINT (DELCON) · AUTOCONSTRAIN · SWBOUT (macro for SolidWorks, .swb)
 *
 * Picking: a click on an object takes the constraint point nearest the click (end, middle, centre, vertex) where a
 * point is asked for, and the line / circle / polyline segment under it where an object is. The first object
 * stays and the second moves to meet the constraint, as in AutoCAD. Host extras used when present:
 * host.parameters() (open the panel), host.constraintView ({ bars: 'all'|'none', hidden: Set, dims: bool }),
 * host.download(name, data, mime), host.redraw().
 */

import { addConstraint, removeConstraints, setDimInput, setParameter, removeParameter, describe, parseDimInput } from './params-doc.js';
import { GEOMETRIC, isDim, makeConstraint, dimEntityFor, nearestPointRef, curveRef, statusText, refKind, refPoint, refLine, constraintPoints } from './gcons.js';
import { segCount } from './gsolve.js';
import { docToSwb } from './swsketch.js';

import { t } from './i18n.js';
const SOLVABLE = new Set(['line', 'circle', 'arc', 'point', 'poly']);

export function installParametric(def, opt) {
  const modelOnly = (c) => { if (c.doc.inModel) return true; c.print(t('cmd.constraints_work_model_tab')); return false; };
  const say = (c, r, done) => { if (r.ok) { if (done) c.print(done); if (r.message) c.print(r.message); c.host.redraw?.(); } else c.print(r.error); return r.ok; };

  // ---- picking
  /** Ask for an object until `test` accepts it; an option or Enter (with a default) comes back as { option }. */
  async function pick(c, prompt, test, why, opts = {}) {
    for (;;) {
      const p = await c.entity(prompt, opts);
      if (p === null || p === undefined) return null;
      if (typeof p === 'string') return { option: optionKey(opts.options, p) };
      if (p.option) return { option: p.option };
      const e = c.doc.get(p.id);
      const r = e && SOLVABLE.has(e.type) ? test(e, p.point) : null;
      if (r) return { ref: { e: e.id, k: r }, id: e.id, point: p.point };
      c.print(why);
    }
  }
  const optionKey = (options = [], label) => (options.find((o) => o.label === label || o.key === label) || {}).key || label;
  const asPoint = (e, pt) => nearestPointRef(e, pt)?.k || null;
  const asKind = (...kinds) => (e, pt) => { const k = curveRef(e, pt); return k && kinds.includes(refKind(e, k)) ? k : null; };
  const asLine = asKind('L'), asRound = asKind('R'), asCurve = asKind('L', 'R');
  const W_LINE = t('cmd.select_line_straight_polyline'), W_ROUND = t('cmd.select_circle_arc_polyline');
  const W_POINT = t('cmd.select_line_polyline_circle');
  const firstPoint = (c, prompt, options, def) => pick(c, prompt, asPoint, W_POINT, { options, default: def });

  const add = (c, type, refs, extra = {}) => say(c, addConstraint(c.doc, type, refs, extra), GEOMETRIC[type] ? t('cmd.gc.added', { what: GEOMETRIC[type].label }) : null);

  // ---- geometric
  async function horizontalLike(c, type) {
    const a = await pick(c, t('cmd.select_object'), asLine, W_LINE, { options: [opt('2P', '2Points')], default: '2Points' });
    if (!a) return;
    if (a.option === '2P') {
      const p = await firstPoint(c, t('cmd.select_first_point'));
      if (!p || p.option) return;
      const q = await firstPoint(c, t('cmd.select_second_point'));
      if (!q || q.option) return;
      add(c, type, [p.ref, q.ref]);
      return;
    }
    add(c, type, [a.ref]);
  }
  async function twoCurves(c, type, test1, test2, why1, why2 = why1) {
    const a = await pick(c, t('cmd.fillet.first'), test1, why1);
    if (!a || a.option) return;
    c.host.setSelection(new Set([a.id]));
    const b = await pick(c, t('cmd.select_second_object'), test2, why2);
    c.host.setSelection(new Set());
    if (!b || b.option) return;
    return [a, b];
  }
  const G = {
    GCHORIZONTAL: { aliases: [], help: t('cmd.constraint_line_two_points'), fn: (c) => horizontalLike(c, 'horizontal') },
    GCVERTICAL: { aliases: [], help: t('cmd.constraint_line_two_points_2'), fn: (c) => horizontalLike(c, 'vertical') },
    GCPERPENDICULAR: { aliases: [], help: t('cmd.constraint_two_lines_stay'), fn: async (c) => { const p = await twoCurves(c, 'perpendicular', asLine, asLine, W_LINE); if (p) add(c, 'perpendicular', [p[0].ref, p[1].ref]); } },
    GCPARALLEL: { aliases: [], help: t('cmd.constraint_two_lines_stay_2'), fn: async (c) => { const p = await twoCurves(c, 'parallel', asLine, asLine, W_LINE); if (p) add(c, 'parallel', [p[0].ref, p[1].ref]); } },
    GCCOLLINEAR: { aliases: [], help: t('cmd.constraint_two_lines_stay_3'), fn: async (c) => { const p = await twoCurves(c, 'collinear', asLine, asLine, W_LINE); if (p) add(c, 'collinear', [p[0].ref, p[1].ref]); } },
    GCCONCENTRIC: { aliases: [], help: t('cmd.constraint_two_circles_arcs'), fn: async (c) => { const p = await twoCurves(c, 'concentric', asRound, asRound, W_ROUND); if (p) add(c, 'concentric', [p[0].ref, p[1].ref]); } },
    GCEQUAL: {
      aliases: [], help: t('cmd.constraint_two_lines_stay_4'),
      fn: async (c) => {
        const p = await twoCurves(c, 'equal', asCurve, asCurve, t('cmd.select_line_circle_arc'));
        if (!p) return;
        const k = (x) => refKind(c.doc.get(x.ref.e), x.ref.k);
        if (k(p[0]) !== k(p[1])) { c.print(t('cmd.equal_takes_two_lines')); return; }
        add(c, 'equal', [p[0].ref, p[1].ref]);
      },
    },
    GCTANGENT: {
      aliases: [], help: t('cmd.constraint_line_circle_arc'),
      fn: async (c) => {
        const p = await twoCurves(c, 'tangent', asCurve, asCurve, t('cmd.select_line_circle_arc'));
        if (!p) return;
        const k = (x) => refKind(c.doc.get(x.ref.e), x.ref.k);
        if (k(p[0]) === 'L' && k(p[1]) === 'L') { c.print(t('cmd.tangent_needs_circle_arc')); return; }
        const refs = k(p[0]) === 'R' && k(p[1]) === 'L' ? [p[1].ref, p[0].ref] : [p[0].ref, p[1].ref];
        add(c, 'tangent', refs, { pinEntity: p[0].ref.e });
      },
    },
    GCCOINCIDENT: {
      aliases: [], help: t('cmd.constraint_two_points_meet'),
      fn: async (c) => {
        const a = await firstPoint(c, t('cmd.select_first_point'), [opt('O', 'Object'), opt('A', 'Autoconstrain')], 'Object');
        if (!a) return;
        if (a.option === 'A') { await autoconstrain(c, { only: 'coincident' }); return; }
        if (a.option === 'O') {
          const o = await pick(c, t('cmd.select_object'), asCurve, t('cmd.select_line_circle_arc'));
          if (!o || o.option) return;
          c.host.setSelection(new Set([o.id]));
          const p = await firstPoint(c, t('cmd.select_point'));
          c.host.setSelection(new Set());
          if (!p || p.option) return;
          add(c, 'coincident', [p.ref, o.ref], { pinEntity: o.ref.e });
          return;
        }
        c.host.setSelection(new Set([a.id]));
        const b = await firstPoint(c, t('cmd.select_second_point'), [opt('O', 'Object')], 'Object');
        c.host.setSelection(new Set());
        if (!b) return;
        if (b.option === 'O') {
          const o = await pick(c, t('cmd.select_object'), asCurve, t('cmd.select_line_circle_arc'));
          if (!o || o.option) return;
          add(c, 'coincident', [a.ref, o.ref], { pinEntity: a.ref.e });
          return;
        }
        add(c, 'coincident', [b.ref, a.ref], { pinEntity: a.ref.e });
      },
    },
    GCFIX: {
      aliases: [], help: t('cmd.constraint_point_whole_object'),
      fn: async (c) => {
        const a = await firstPoint(c, t('cmd.select_point'), [opt('O', 'Object')], 'Object');
        if (!a) return;
        if (a.option === 'O') {
          const o = await pick(c, t('cmd.area.object'), (e) => (SOLVABLE.has(e.type) ? '*' : null), W_POINT);
          if (!o || o.option) return;
          add(c, 'fix', [o.ref]);
          return;
        }
        add(c, 'fix', [a.ref]);
      },
    },
    GCSYMMETRIC: {
      aliases: [], help: t('cmd.constraint_two_points_lines'),
      fn: async (c) => {
        const a = await pick(c, t('cmd.fillet.first'), asCurve, t('cmd.select_line_circle_arc_2'), { options: [opt('2P', '2Points')], default: '2Points' });
        if (!a) return;
        let refs;
        if (a.option === '2P') {
          const p = await firstPoint(c, t('cmd.select_first_point'));
          if (!p || p.option) return;
          const q = await firstPoint(c, t('cmd.select_second_point'));
          if (!q || q.option) return;
          refs = [p.ref, q.ref];
        } else {
          c.host.setSelection(new Set([a.id]));
          const b = await pick(c, t('cmd.select_second_object'), asCurve, t('cmd.select_line_circle_arc_2'));
          if (!b || b.option) return;
          refs = [a.ref, b.ref];
        }
        const m = await pick(c, t('cmd.select_symmetry_line'), asLine, W_LINE);
        c.host.setSelection(new Set());
        if (!m || m.option) return;
        add(c, 'symmetric', [...refs, m.ref]);
      },
    },
  };
  for (const [name, g] of Object.entries(G)) def(name, g.aliases, async (c) => { if (modelOnly(c)) await g.fn(c); }, { help: g.help });

  const GC_OPTIONS = [opt('H', 'Horizontal'), opt('V', 'Vertical'), opt('P', 'Perpendicular'), opt('PA', 'PArallel'), opt('T', 'Tangent'), opt('C', 'Coincident'), opt('CON', 'CONcentric'), opt('COL', 'COLlinear'), opt('S', 'Symmetric'), opt('E', 'Equal'), opt('F', 'Fix')];
  const GC_RUN = { H: 'GCHORIZONTAL', V: 'GCVERTICAL', P: 'GCPERPENDICULAR', PA: 'GCPARALLEL', T: 'GCTANGENT', C: 'GCCOINCIDENT', CON: 'GCCONCENTRIC', COL: 'GCCOLLINEAR', S: 'GCSYMMETRIC', E: 'GCEQUAL', F: 'GCFIX' };
  def('GEOMCONSTRAINT', ['GCON'], async (c) => {
    if (!modelOnly(c)) return;
    const k = await c.keyword(t('cmd.geomconstraint.enter_constraint_type'), { options: GC_OPTIONS, default: c.engine.lastGc || 'Horizontal' });
    const key = k?.option || optionKey(GC_OPTIONS, k) || 'H';
    const label = GC_OPTIONS.find((o) => o.key === key)?.label;
    if (!GC_RUN[key]) return;
    c.engine.lastGc = label;
    await G[GC_RUN[key]].fn(c);
  }, { help: t('cmd.geomconstraint.geometric_constraints_horizontal_vertical') });

  // ---- dimensional
  const linearRot = (p1, p2, cur) => {
    const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x), minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
    const outX = cur.x < minX ? minX - cur.x : cur.x > maxX ? cur.x - maxX : 0;
    const outY = cur.y < minY ? minY - cur.y : cur.y > maxY ? cur.y - maxY : 0;
    return outY >= outX ? 'hdist' : 'vdist';
  };
  /** Two point references: picked points, or an object's two ends (Enter / Object). */
  async function twoPoints(c) {
    const a = await firstPoint(c, t('cmd.geomconstraint.specify_first_constraint_point'), [opt('O', 'Object')], 'Object');
    if (!a) return null;
    if (a.option === 'O') {
      const o = await pick(c, t('cmd.area.object'), (e, pt) => { const k = curveRef(e, pt); return k && refKind(e, k) === 'L' ? k : null; }, W_LINE);
      if (!o || o.option) return null;
      const e = c.doc.get(o.id);
      if (e.type === 'line') return [{ e: e.id, k: 'p1' }, { e: e.id, k: 'p2' }];
      const i = +o.ref.k.slice(1);
      return [{ e: e.id, k: 'v' + i }, { e: e.id, k: 'v' + ((i + 1) % e.pts.length) }];
    }
    c.host.setSelection(new Set([a.id]));
    const b = await firstPoint(c, t('cmd.geomconstraint.specify_second_constraint_point'));
    c.host.setSelection(new Set());
    if (!b || b.option) return null;
    return [a.ref, b.ref];
  }
  /** Where the dimension goes (with a live preview), then its value / expression; adds it. */
  async function placeAndAdd(c, typeFor, refs) {
    const make = (cur) => {
      const type = typeof typeFor === 'function' ? typeFor(cur) : typeFor;
      const m = makeConstraint(c.doc, type, refs, { loc: cur, id: 'k0' });
      return m.c ? { c: m.c, type, d: dimEntityFor(c.doc, m.c) } : { error: m.error };
    };
    const probe = make(c.host.cursor || refPoint(c.doc.get(refs[0].e), refs[0].k));
    if (probe.error) { c.print(probe.error); return; }
    c.preview((cur) => { const m = make(cur); return m.d ? [m.d] : []; });
    const loc = await c.point(t('cmd.explode.specify_dimension_line_location'));
    c.preview(null);
    const m = make(loc);
    if (!m.c) { c.print(m.error); return; }
    const answer = await c.string('Dimension text <' + m.c.name + '=' + (Math.round(m.c.value * 1e6) / 1e6) + '>');
    const typed = String(answer ?? '').trim();
    const { name, expr } = typed ? parseDimInput(typed) : { name: null, expr: null };
    const r = addConstraint(c.doc, m.type, refs, { loc, expr: expr || null, name: name && name !== m.c.name ? name : null });
    if (say(c, r)) c.print(t('cmd.dc.added', { name: r.c.name, value: (Math.round(r.c.value * 1e6) / 1e6) + (r.c.type === 'angle' ? '°' : '') }));
  }
  const D = {
    DCLINEAR: { aliases: ['DCLIN'], help: t('cmd.geomconstraint.dimensional_constraint_horizontal_vertical'), fn: async (c) => { const r = await twoPoints(c); if (r) await placeAndAdd(c, (cur) => linearRot(refPoint(c.doc.get(r[0].e), r[0].k), refPoint(c.doc.get(r[1].e), r[1].k), cur), r); } },
    DCHORIZONTAL: { aliases: ['DCHOR'], help: t('cmd.geomconstraint.dimensional_constraint_horizontal_distance'), fn: async (c) => { const r = await twoPoints(c); if (r) await placeAndAdd(c, 'hdist', r); } },
    DCVERTICAL: { aliases: ['DCVER'], help: t('cmd.geomconstraint.dimensional_constraint_vertical_distance'), fn: async (c) => { const r = await twoPoints(c); if (r) await placeAndAdd(c, 'vdist', r); } },
    DCALIGNED: {
      aliases: ['DCALI'], help: t('cmd.geomconstraint.dimensional_constraint_true_distance'),
      fn: async (c) => {
        const a = await firstPoint(c, t('cmd.geomconstraint.specify_first_constraint_point'), [opt('O', 'Object'), opt('P', t('cmd.geomconstraint.point_line')), opt('2L', '2Lines')], 'Object');
        if (!a) return;
        if (a.option === 'P') {
          const p = await firstPoint(c, t('cmd.geomconstraint.specify_constraint_point'));
          if (!p || p.option) return;
          const l = await pick(c, t('cmd.geomconstraint.select_line'), asLine, W_LINE);
          if (!l || l.option) return;
          await placeAndAdd(c, 'dist', [p.ref, l.ref]);
          return;
        }
        if (a.option === '2L') {
          const l1 = await pick(c, t('cmd.chamfer.first'), asLine, W_LINE);
          if (!l1 || l1.option) return;
          const l2 = await pick(c, t('cmd.geomconstraint.select_second_line_make'), asLine, W_LINE);
          if (!l2 || l2.option) return;
          if (!say(c, addConstraint(c.doc, 'parallel', [l1.ref, l2.ref]))) return;
          await placeAndAdd(c, 'dist', [l1.ref, l2.ref]);
          return;
        }
        let refs;
        if (a.option === 'O') {
          const o = await pick(c, t('cmd.area.object'), asLine, W_LINE);
          if (!o || o.option) return;
          const e = c.doc.get(o.id);
          refs = e.type === 'line' ? [{ e: e.id, k: 'p1' }, { e: e.id, k: 'p2' }] : [{ e: e.id, k: 'v' + o.ref.k.slice(1) }, { e: e.id, k: 'v' + ((+o.ref.k.slice(1) + 1) % e.pts.length) }];
        } else {
          const b = await firstPoint(c, t('cmd.geomconstraint.specify_second_constraint_point'));
          if (!b || b.option) return;
          refs = [a.ref, b.ref];
        }
        await placeAndAdd(c, 'dist', refs);
      },
    },
    DCRADIUS: { aliases: ['DCRAD'], help: t('cmd.geomconstraint.dimensional_constraint_radius_circle'), fn: async (c) => { const o = await pick(c, t('cmd.mea.arc'), asRound, W_ROUND); if (o && !o.option) await placeAndAdd(c, 'radius', [o.ref]); } },
    DCDIAMETER: { aliases: ['DCDIA'], help: t('cmd.geomconstraint.dimensional_constraint_diameter_circle'), fn: async (c) => { const o = await pick(c, t('cmd.mea.arc'), asRound, W_ROUND); if (o && !o.option) await placeAndAdd(c, 'diameter', [o.ref]); } },
    DCANGULAR: {
      aliases: ['DCANG'], help: t('cmd.geomconstraint.dimensional_constraint_angle_between'),
      fn: async (c) => {
        const a = await pick(c, t('cmd.geomconstraint.select_first_line_arc'), (e, pt) => (e.type === 'arc' ? 'R' : asLine(e, pt)), t('cmd.geomconstraint.select_line_arc'));
        if (!a || a.option) return;
        if (c.doc.get(a.id).type === 'arc') { await placeAndAdd(c, 'angle', [a.ref]); return; }
        c.host.setSelection(new Set([a.id]));
        const b = await pick(c, t('cmd.mea.line2'), asLine, W_LINE);
        c.host.setSelection(new Set());
        if (!b || b.option) return;
        await placeAndAdd(c, 'angle', [a.ref, b.ref]);
      },
    },
    DCCONVERT: {
      aliases: [], help: t('cmd.geomconstraint.turn_dimensions_drawn_constrainable'),
      fn: async (c) => {
        const ids = await c.select(t('cmd.geomconstraint.select_dimensions_convert'));
        let n = 0, skipped = 0;
        for (const id of ids) {
          const d = c.doc.get(id);
          if (!d || d.type !== 'dim') { skipped++; continue; }
          const conv = convertDim(c.doc, d);
          if (!conv) { skipped++; continue; }
          const r = addConstraint(c.doc, conv.type, conv.refs, { loc: d.loc });
          if (!r.ok) { c.print(t('cmd.dcconvert.dim_error', { id, why: r.error })); skipped++; continue; }
          c.doc.change('DCCONVERT', () => c.doc.remove(id));
          n++;
        }
        c.host.setSelection(new Set());
        c.print(t('cmd.dcconvert.converted', { n }) + (skipped ? ' ' + t('cmd.dcconvert.skipped', { n: skipped }) : ''));
      },
    },
  };
  for (const [name, d] of Object.entries(D)) def(name, d.aliases, async (c) => { if (modelOnly(c)) await d.fn(c); }, { help: d.help });

  const DC_OPTIONS = [opt('LI', 'LInear'), opt('H', 'Horizontal'), opt('V', 'Vertical'), opt('AL', 'ALigned'), opt('AN', 'ANgular'), opt('R', 'Radial'), opt('D', 'Diameter'), opt('C', 'Convert')];
  const DC_RUN = { LI: 'DCLINEAR', H: 'DCHORIZONTAL', V: 'DCVERTICAL', AL: 'DCALIGNED', AN: 'DCANGULAR', R: 'DCRADIUS', D: 'DCDIAMETER', C: 'DCCONVERT' };
  def('DIMCONSTRAINT', ['DCON'], async (c) => {
    if (!modelOnly(c)) return;
    const p = await c.entity(t('cmd.dimconstraint.select_associative_dimension_convert'), { options: DC_OPTIONS, default: c.engine.lastDc || 'ALigned' });
    if (!p) return;
    if (typeof p === 'string' || p.option) {
      const key = p.option || optionKey(DC_OPTIONS, p);
      if (!DC_RUN[key]) return;
      c.engine.lastDc = DC_OPTIONS.find((o) => o.key === key).label;
      await D[DC_RUN[key]].fn(c);
      return;
    }
    const d = c.doc.get(p.id);
    if (d?.type !== 'dim') { c.print(t('cmd.dimconstraint.not_dimension_choose_option')); return; }
    const conv = convertDim(c.doc, d);
    if (!conv) { c.print(t('cmd.dimconstraint.dimension_not_lines_circles')); return; }
    const r = addConstraint(c.doc, conv.type, conv.refs, { loc: d.loc });
    if (!say(c, r)) return;
    c.doc.change('DCCONVERT', () => c.doc.remove(d.id));
    c.print(t('cmd.dcconvert.to', { name: r.c.name }));
  }, { help: t('cmd.dimconstraint.dimensional_constraints_linear_aligned') });

  // ---- managing
  def('DELCONSTRAINT', ['DELCON'], async (c) => {
    if (!modelOnly(c)) return;
    const ids = await c.select(t('cmd.sim.select'));
    if (!ids.size) return;
    const gone = c.doc.constraints.filter((k) => k.refs.some((r) => ids.has(r.e))).map((k) => k.id);
    const r = removeConstraints(c.doc, gone);
    c.host.setSelection(new Set());
    c.print(r.removed ? t('cmd.delconstraint.removed', { n: r.removed }) : t('cmd.delconstraint.those_objects_have_no'));
    c.host.redraw?.();
  }, { help: t('cmd.delconstraint.remove_every_constraint_geometric') });

  async function autoconstrain(c, { only = null, ids = null } = {}) {
    const st = c.engine.autoc || (c.engine.autoc = { dist: 0.05, angle: 1 });
    let set = ids;
    if (!set) {
      for (;;) {
        set = await c.select(t('cmd.sim.select'), { options: only ? [] : [opt('S', 'Settings')] });
        if (set && set.option === 'S') {
          const d = await c.distance(t('cmd.delconstraint.specify_distance_tolerance'), { default: st.dist });
          if (typeof d === 'number' && d >= 0) st.dist = d;
          const a = await c.number(t('cmd.delconstraint.specify_angle_tolerance_degrees'), { default: st.angle });
          if (typeof a === 'number' && a >= 0 && a < 45) st.angle = a;
          c.print(t('cmd.autoconstrain.tolerances', { dist: st.dist, angle: st.angle }));
          continue;
        }
        break;
      }
    }
    const ents = [...set].map((id) => c.doc.get(id)).filter((e) => e && SOLVABLE.has(e.type));
    if (!ents.length) { c.print(t('cmd.delconstraint.nothing_there_takes_constraints')); return; }
    const has = (type, refs) => c.doc.constraints.some((k) => k.type === type && k.refs.length === refs.length && refs.every((r) => k.refs.some((q) => q.e === r.e && q.k === r.k)));
    let n = 0;
    // coincident: ends within the distance tolerance (one constraint per pair of neighbours, chained)
    if (!only || only === 'coincident') {
      const ends = [];
      for (const e of ents) {
        const ks = e.type === 'line' ? ['p1', 'p2'] : e.type === 'arc' ? ['s', 'e'] : e.type === 'point' ? ['p'] : e.type === 'poly' && !e.closed ? ['v0', 'v' + (e.pts.length - 1)] : [];
        for (const k of ks) { const p = refPoint(e, k); ends.push({ e: e.id, k, x: p.x, y: p.y }); }
      }
      const joined = new Set();
      for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i], b = ends[j];
        if (a.e === b.e || joined.has(j) || Math.hypot(a.x - b.x, a.y - b.y) > st.dist) continue;
        const refs = [{ e: b.e, k: b.k }, { e: a.e, k: a.k }];
        if (has('coincident', refs)) { joined.add(j); continue; }
        const r = addConstraint(c.doc, 'coincident', refs, { pinFirst: false });
        if (r.ok) { n++; joined.add(j); }
      }
    }
    // horizontal / vertical: lines and straight polyline segments within the angle tolerance
    if (!only) {
      const tol = st.angle * Math.PI / 180;
      for (const e of ents) {
        const segs = e.type === 'line' ? ['L'] : e.type === 'poly' ? Array.from({ length: segCount(e) }, (_, i) => 's' + i).filter((k) => refKind(e, k) === 'L') : [];
        for (const k of segs) {
          const l = refLine(e, k);
          const a = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
          const h = Math.abs(Math.sin(a)) <= Math.sin(tol), v = Math.abs(Math.cos(a)) <= Math.sin(tol);
          const type = h ? 'horizontal' : v ? 'vertical' : null;
          if (!type || has(type, [{ e: e.id, k }]) || has(type === 'horizontal' ? 'vertical' : 'horizontal', [{ e: e.id, k }])) continue;
          const r = addConstraint(c.doc, type, [{ e: e.id, k }], { pinFirst: false });
          if (r.ok) n++;
        }
      }
    }
    c.host.setSelection(new Set());
    c.print(n ? t('cmd.autoconstrain.applied', { n }) + ' ' + statusText(c.doc) : t('cmd.autoconstrain.none', { dist: st.dist, angle: st.angle }));
    c.host.redraw?.();
  }
  def('AUTOCONSTRAIN', [], async (c) => { if (modelOnly(c)) await autoconstrain(c); }, { help: t('cmd.autoconstrain.add_coincident_horizontal_vertical') });

  def('PARAMETERS', ['PAR', 'PARAMETERSMANAGER', 'PARAM'], async (c) => {
    if (c.host.parameters) { c.host.parameters(); return; }
    listParams(c);
  }, { noRepeat: true, keepSelection: true, help: t('cmd.parameters.parameters_panel_user_parameters') });

  function listParams(c) {
    const d = describe(c.doc);
    if (!d.rows.length) c.print(t('cmd.parameters.no_parameters_yet_dimensional'));
    for (const r of d.rows) c.print('  ' + r.name + ' = ' + r.expr + (r.driving ? '' : '  → ' + (r.value === null ? '?' : Math.round(r.value * 1e6) / 1e6)) + '   (' + (r.kind === 'dim' ? t('cmd.parameters.kind.dim', { type: r.type.toLowerCase() }) : t('cmd.parameters.kind.user')) + ')' + (r.error ? '  ' + t('cmd.parameters.error', { why: r.error }) : ''));
    c.print(d.status);
  }
  def('-PARAMETERS', [], async (c) => {
    const k = await c.keyword(t('cmd.mea.option'), { options: [opt('N', 'New'), opt('E', 'Edit'), opt('R', 'Rename'), opt('D', 'Delete'), opt('?', '?')], default: '?' });
    const key = k?.option || (k === '?' ? '?' : k);
    if (key === 'N') {
      const name = (await c.string(t('cmd.parameters.enter_name_new_parameter'))).trim();
      if (!name) return;
      const expr = (await c.string('Enter expression <0>')).trim() || '0';
      say(c, setParameter(c.doc, name, expr), name + ' = ' + expr + '.');
    } else if (key === 'E') {
      const name = (await c.string(t('cmd.parameters.enter_name_parameter_edit'))).trim();
      if (!name) return;
      const con = c.doc.constraints.find((x) => isDim(x) && x.name === name);
      const cur = c.doc.params.vars.find((v) => v.name === name);
      if (!cur) { c.print(t('cmd.parameters.none_called', { name })); return; }
      const expr = (await c.string('Enter expression <' + cur.expr + '>')).trim();
      if (!expr) return;
      say(c, con ? setDimInput(c.doc, con.id, expr) : setParameter(c.doc, name, expr), name + ' = ' + expr + '.');
    } else if (key === 'R') {
      const from = (await c.string(t('cmd.parameters.enter_name_parameter_rename'))).trim();
      if (!from) return;
      const to = (await c.string(t('cmd.parameters.enter_new_name'))).trim();
      if (!to) return;
      const cur = c.doc.params.vars.find((v) => v.name === from);
      if (!cur) { c.print(t('cmd.parameters.none_called', { name: from })); return; }
      say(c, setParameter(c.doc, to, cur.expr, { rename: from }), t('params.is_now', { name: from, value: to }));
    } else if (key === 'D') {
      const name = (await c.string(t('cmd.parameters.enter_name_parameter_delete'))).trim();
      if (!name) return;
      let r = removeParameter(c.doc, name);
      if (!r.ok && r.uses) {
        const yn = await c.keyword(r.error + ' ' + t('cmd.parameters.inline_ask'), { options: [opt('Y', 'Yes'), opt('N', 'No')], default: 'No' });
        if ((yn?.option || yn) !== 'Y' && yn !== 'Yes') return;
        r = removeParameter(c.doc, name, { inline: true });
      }
      say(c, r, name + ' deleted.');
    } else listParams(c);
  }, { help: t('cmd.parameters.parameters_command_line_new') });

  def('CONSTRAINTBAR', ['CBAR'], async (c) => {
    const v = c.host.constraintView || (c.host.constraintView = { bars: 'all', hidden: new Set(), dims: true });
    const set = await c.select(t('cmd.sim.select'), { options: [opt('S', 'Showall'), opt('H', 'Hideall')] });
    if (set && set.option) {
      v.bars = set.option === 'S' ? 'all' : 'none'; v.hidden.clear();
      c.print(set.option === 'S' ? t('cmd.constraintbar.constraint_bars_shown') : t('cmd.constraintbar.constraint_bars_hidden'));
    } else if (set.size) {
      const k = await c.keyword(t('cmd.mea.option'), { options: [opt('S', 'Show'), opt('H', 'Hide')], default: 'Show' });
      const show = (k?.option || k) !== 'H' && k !== 'Hide';
      for (const id of set) { if (show) v.hidden.delete(id); else v.hidden.add(id); }
      if (show && v.bars === 'none') { v.bars = 'all'; for (const e of c.doc.model.keys()) if (!set.has(e)) v.hidden.add(e); }
      c.print(t(show ? 'cmd.constraintbar.shown_for' : 'cmd.constraintbar.hidden_for', { n: set.size }));
    }
    c.host.setSelection(new Set());
    c.host.redraw?.();
  }, { help: t('cmd.constraintbar.show_hide_constraint_bars') });

  def('DCDISPLAY', [], async (c) => {
    const v = c.host.constraintView || (c.host.constraintView = { bars: 'all', hidden: new Set(), dims: true });
    const k = await c.keyword(t('cmd.mea.option'), { options: [opt('S', 'Show'), opt('H', 'Hide')], default: v.dims ? 'Hide' : 'Show' });
    v.dims = (k?.option || k) === 'S' || k === 'Show';
    c.print(t(v.dims ? 'cmd.dcdisplay.shown' : 'cmd.dcdisplay.hidden'));
    c.host.redraw?.();
  }, { noRepeat: true, keepSelection: true, help: t('cmd.dcdisplay.show_hide_dimensional_constraints') });

  def('SWBOUT', ['SWMACRO'], async (c) => {
    const name = (c.doc.meta.name || 'Drawing1').replace(/[^\w.-]+/g, '_');
    const out = docToSwb(c.doc, { name });
    if (!out.ok) { c.print(out.error); return; }
    if (c.host.download) c.host.download(name + '.swb', out.bytes, 'text/plain');
    else c.engine.lastSwb = out;
    c.print('Wrote ' + name + '.swb: a macro that SolidWorks runs (Tools, Macro, Run) to build a part with one sketch on the Front Plane. ' + out.summary);
    for (const n of out.notes) c.print('  ' + n);
    c.print(t('cmd.swbout.not_yet_tested_solidworks'));
  }, { noRepeat: true, keepSelection: true, help: t('cmd.swbout.download_macro_solidworks_swb') });
}

/** A plain dimension → the constraint it stands for, when its points sit on constrainable geometry. */
export function convertDim(doc, d) {
  const ents = [...doc.model.values()].filter((e) => SOLVABLE.has(e.type));
  let size = 1;
  for (const e of ents) for (const p of constraintPoints(e)) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  const tol = 1e-7 * size;
  const pointAt = (p) => {
    for (const e of ents) for (const q of constraintPoints(e)) if (Math.hypot(q.x - p.x, q.y - p.y) <= tol) return { e: e.id, k: q.k };
    return null;
  };
  if (d.kind === 'linear' || d.kind === 'aligned') {
    const a = pointAt(d.p1), b = pointAt(d.p2);
    if (!a || !b) return null;
    if (d.kind === 'aligned') return { type: 'dist', refs: [a, b] };
    const rot = ((d.rot || 0) % Math.PI + Math.PI) % Math.PI;
    if (Math.abs(rot) < 1e-9 || Math.abs(rot - Math.PI) < 1e-9) return { type: 'hdist', refs: [a, b] };
    if (Math.abs(rot - Math.PI / 2) < 1e-9) return { type: 'vdist', refs: [a, b] };
    return { type: 'dist', refs: [a, b] };
  }
  if (d.kind === 'radius' || d.kind === 'diameter') {
    const r = Math.hypot(d.p1.x - d.c.x, d.p1.y - d.c.y);
    const e = ents.find((x) => (x.type === 'circle' || x.type === 'arc') && Math.hypot(x.cx - d.c.x, x.cy - d.c.y) <= tol && Math.abs(x.r - r) <= tol);
    return e ? { type: d.kind, refs: [{ e: e.id, k: 'R' }] } : null;
  }
  if (d.kind === 'angular') {
    const through = (a, b) => ents.find((e) => e.type === 'line' && onLine(e, a, tol) && onLine(e, b, tol));
    const l1 = through(d.c, d.p1), l2 = through(d.c, d.p2);
    if (l1 && l2 && l1 !== l2) return { type: 'angle', refs: [{ e: l1.id, k: 'L' }, { e: l2.id, k: 'L' }] };
    const arc = ents.find((e) => e.type === 'arc' && Math.hypot(e.cx - d.c.x, e.cy - d.c.y) <= tol);
    return arc ? { type: 'angle', refs: [{ e: arc.id, k: 'R' }] } : null;
  }
  return null;
}
function onLine(l, p, tol) {
  const ux = l.x2 - l.x1, uy = l.y2 - l.y1, L = Math.hypot(ux, uy) || 1e-300;
  return Math.abs(ux * (p.y - l.y1) - uy * (p.x - l.x1)) / L <= tol * 10;
}
