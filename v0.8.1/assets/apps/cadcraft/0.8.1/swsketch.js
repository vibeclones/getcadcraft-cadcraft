/* SPDX-License-Identifier: Apache-2.0 */
/**
 * swsketch.js — moving a CadCraft drawing to and from SolidWorks as one sketch (DOM-free; bin/test-cadcraft-constraints.mjs
 * checks it). SolidWorks is not available here: nothing this module writes has been run in SolidWorks. The tests
 * check the macro's structure and every API call against a table of method names and argument counts.
 *
 * Forward — docToSwb(doc, { name }) → { ok, text, bytes (Windows-1252, CRLF), notes, summary, counts }
 *   A plain-text VBA macro (.swb; Tools › Macro › Run in SolidWorks) that makes a new part from the default part
 *   template, sets the length unit to the drawing's, opens a sketch on the Front Plane (XY: CadCraft's x and y) and
 *   draws the model space's lines, circles, arcs, points and polylines (each polyline segment a line or an arc,
 *   joined by coincident relations), then adds the drawing's geometric constraints as sketch relations, its
 *   dimensional constraints as named dimensions (d1 → "d1@Sketch1"), its user parameters as global variables and
 *   every expression as an equation (EquationMgr). Coordinates go in metres, as the API wants. Every step checks
 *   its result, writes failures to "<macro folder>\<name>-cadcraft.log" and carries on; a message box sums up.
 *   The macro is split into one Sub per ~150 statements (VBA's 64 KB procedure limit).
 *   API calls used (SOLIDWORKS API Help, sldworksapi: method name → arguments):
 *     SldWorks.GetUserPreferenceStringValue(1) · SldWorks.NewDocument(4) · SldWorks.SetUserPreferenceToggle(2) ·
 *     SldWorks.GetCurrentMacroPathFolder(0) · ModelDocExtension.SetUserPreferenceInteger(3) ·
 *     ModelDocExtension.SelectByID2(9) · ModelDoc2.ClearSelection2(1) · ModelDoc2.SketchAddConstraints(1) ·
 *     ModelDoc2.AddDimension2(3) · ModelDoc2.AddHorizontalDimension2(3) · ModelDoc2.AddVerticalDimension2(3) ·
 *     ModelDoc2.AddRadialDimension2(3) · ModelDoc2.AddDiameterDimension2(3) · ModelDoc2.GetEquationMgr(0) ·
 *     ModelDoc2.EditRebuild3(0) · ModelDoc2.ViewZoomtofit2(0) · SketchManager.InsertSketch(1) · SketchManager.CreateLine(6) ·
 *     SketchManager.CreateCircleByRadius(4) · SketchManager.CreateArc(10) · SketchManager.CreatePoint(3) ·
 *     SketchLine/SketchArc.GetStartPoint2(0), GetEndPoint2(0), SketchArc.GetCenterPoint2(0) · SketchSegment.Select4(2) ·
 *     SketchPoint.Select4(2) · DisplayDimension.GetDimension2(1) · EquationMgr.Add2(3); properties
 *     SketchManager.AddToDB, SketchManager.DisplayWhenAdded, SketchManager.ActiveSketch, SketchSegment.ConstructionGeometry,
 *     Dimension.Name, Dimension.SystemValue, Feature.Name. Constants are written as numbers (no type library needed).
 *
 * Backward — readSwExport(json) → { ok, exp, sketches: [{ name, points, segments }], error }   (format
 *   "cadcraft-sw-export" v1, written by the SolidWorks-side macro tools/partcraft-sw/CadCraftExport.swb; see
 *   docs/PARAMETRIC-SPEC.md) · loadSwSketch(doc, exp, sketchName) → { ok, report: { notes } }: that sketch becomes
 *   the drawing (model space, millimetres): geometry, relations as constraints, dimensions as dimensional
 *   constraints named as in SolidWorks (D1 …), global variables as parameters, equations on its dimensions as
 *   their expressions. The sketch plane's position is ignored (the sketch is drawn flat, as seen on its plane).
 */

import { makeConstraint, isDim, targetKey, DIMENSIONAL, nextName, dimEntityFor } from './gcons.js';
import { solveAll } from './params-doc.js';
import { segCount, refKind } from './gsolve.js';
import { parse, formatNumber, NAME_RE, RESERVED } from './expr.js';
import { nameProblem, evaluateVars } from './params.js';

import { t } from './i18n.js';
const TAU = Math.PI * 2;
const UNIT_MM = { '': 1, millimeters: 1, centimeters: 10, meters: 1000, inches: 25.4, feet: 304.8, yards: 914.4, mils: 0.0254, microinches: 0.0000254 };
// swLengthUnit_e: swMM 0, swCM 1, swMETER 2, swINCHES 3, swFEET 4
const SW_UNIT = { '': 0, millimeters: 0, centimeters: 1, meters: 2, inches: 3, feet: 4 };
// swUserPreferenceIntegerValue_e.swUnitsLinear = 41 · swUserPreferenceStringValue_e.swDefaultTemplatePart = 8 ·
// swUserPreferenceToggle_e.swInputDimValOnCreate = 10 · swUserPreferenceOption_e.swDetailingNoOptionSpecified = 0
export const SW_CONST = { swUnitsLinear: 41, swDefaultTemplatePart: 8, swInputDimValOnCreate: 10, swDetailingNoOptionSpecified: 0 };
const REL = {
  coincident: 'sgCOINCIDENT', parallel: 'sgPARALLEL', perpendicular: 'sgPERPENDICULAR', tangent: 'sgTANGENT', concentric: 'sgCONCENTRIC',
  collinear: 'sgCOLINEAR', equal: 'sgSAMELENGTH', symmetric: 'sgSYMMETRIC', fix: 'sgFIXED',
};
const SW_FUNCS = { sin: 'sin', cos: 'cos', tan: 'tan', atan: 'atn', sqrt: 'sqr', abs: 'abs', sign: 'sgn', exp: 'exp', int: 'int' };

// ---------------------------------------------------------------- forward

export function docToSwb(doc, { name = 'Drawing1' } = {}) {
  const notes = [];
  const unit = doc.meta.units || '';
  const k = UNIT_MM[unit] ?? 1;
  if (!(unit in UNIT_MM)) notes.push(t('swsketch.units_nomatch', { unit }));
  const swUnit = SW_UNIT[unit] ?? 0;
  if (!(unit in SW_UNIT)) notes.push(t('swsketch.part_mm'));
  const M = (v) => num(Number((Number(v.toFixed(9)) * k / 1000).toFixed(12)));   // drawing units → metres (the API's unit); solver noise below 1e-9 dropped
  const ents = [...doc.model.values()];
  const out = { lines: 0, arcs: 0, circles: 0, points: 0, relations: 0, dimensions: 0, globals: 0, equations: 0 };
  let skipped = 0;

  // i18n-ignore-start: VBA statements and the macro's own log text (written into the .swb, English)
  // ---- geometry: one statement list; every sketch entity gets an index in segs() or pts()
  const geo = [];                 // statements
  const segOf = new Map();        // "<id>|L" / "<id>|R" / "<id>|s<i>" → segs index
  const ptOf = new Map();         // "<id>|<k>" → VBA expression for the point object
  const joins = [];               // [exprA, exprB] coincident pairs (polyline vertices)
  let ns = 0, np = 0;
  const seg = (stmt, what) => { const i = ns++; geo.push('Set segs(' + i + ') = ' + stmt, 'If segs(' + i + ') Is Nothing Then LogFail "' + what + '"'); return i; };
  for (const e of ents) {
    switch (e.type) {
      case 'line': {
        const i = seg('swSkMgr.CreateLine(' + [M(e.x1), M(e.y1), 0, M(e.x2), M(e.y2), 0].join(', ') + ')', 'line ' + e.id);
        segOf.set(e.id + '|L', i); ptOf.set(e.id + '|p1', 'segs(' + i + ').GetStartPoint2'); ptOf.set(e.id + '|p2', 'segs(' + i + ').GetEndPoint2');
        out.lines++; break;
      }
      case 'circle': {
        const i = seg('swSkMgr.CreateCircleByRadius(' + [M(e.cx), M(e.cy), 0, M(e.r)].join(', ') + ')', 'circle ' + e.id);
        segOf.set(e.id + '|R', i); ptOf.set(e.id + '|c', 'segs(' + i + ').GetCenterPoint2');
        out.circles++; break;
      }
      case 'arc': {
        const s = [e.cx + e.r * Math.cos(e.a0), e.cy + e.r * Math.sin(e.a0)], t = [e.cx + e.r * Math.cos(e.a1), e.cy + e.r * Math.sin(e.a1)];
        const i = seg('swSkMgr.CreateArc(' + [M(e.cx), M(e.cy), 0, M(s[0]), M(s[1]), 0, M(t[0]), M(t[1]), 0, 1].join(', ') + ')', 'arc ' + e.id);
        segOf.set(e.id + '|R', i);
        ptOf.set(e.id + '|c', 'segs(' + i + ').GetCenterPoint2'); ptOf.set(e.id + '|s', 'segs(' + i + ').GetStartPoint2'); ptOf.set(e.id + '|e', 'segs(' + i + ').GetEndPoint2');
        out.arcs++; break;
      }
      case 'point': {
        const i = np++;
        geo.push('Set pts(' + i + ') = swSkMgr.CreatePoint(' + [M(e.x), M(e.y), 0].join(', ') + ')', 'If pts(' + i + ') Is Nothing Then LogFail "point ' + e.id + '"');
        ptOf.set(e.id + '|p', 'pts(' + i + ')'); out.points++; break;
      }
      case 'poly': {
        const n = e.pts.length, first = [];
        for (let j = 0; j < segCount(e); j++) {
          const p = e.pts[j], q = e.pts[(j + 1) % n], b = p.b || 0;
          let i;
          if (Math.abs(b) < 1e-12) { i = seg('swSkMgr.CreateLine(' + [M(p.x), M(p.y), 0, M(q.x), M(q.y), 0].join(', ') + ')', 'polyline ' + e.id + ' segment ' + (j + 1)); out.lines++; }
          else {
            const a = bulgeCentre(p, q, b);
            // CreateArc runs from its start to its end, counter-clockwise for +1, clockwise for −1: a bulge's own sense
            i = seg('swSkMgr.CreateArc(' + [M(a.x), M(a.y), 0, M(p.x), M(p.y), 0, M(q.x), M(q.y), 0, b > 0 ? 1 : -1].join(', ') + ')', 'polyline ' + e.id + ' arc ' + (j + 1));
            out.arcs++;
          }
          segOf.set(e.id + '|s' + j, i);
          first.push(i);
        }
        e.pts.forEach((_, j) => {
          if (j < first.length) ptOf.set(e.id + '|v' + j, 'segs(' + first[j] + ').GetStartPoint2');
          else ptOf.set(e.id + '|v' + j, 'segs(' + first[j - 1] + ').GetEndPoint2');
        });
        for (let j = 1; j < first.length; j++) joins.push(['segs(' + first[j - 1] + ').GetEndPoint2', 'segs(' + first[j] + ').GetStartPoint2']);
        if (e.closed && first.length > 1) joins.push(['segs(' + first[first.length - 1] + ').GetEndPoint2', 'segs(' + first[0] + ').GetStartPoint2']);
        break;
      }
      default: skipped++; break;
    }
  }
  // i18n-ignore-end
  if (skipped) notes.push(t('swsketch.skipped', { n: skipped }));
  if (!ns && !np) return { ok: false, error: t('swsketch.there_nothing_model_put'), notes };

  // ---- relations
  // i18n-ignore-start: VBA statements (see above)
  const rel = [];
  const refExpr = (r) => {
    const key = r.e + '|' + r.k;
    if (ptOf.has(key)) return ptOf.get(key);
    if (segOf.has(key)) return 'segs(' + segOf.get(key) + ')';
    return null;
  };
  const midPts = new Map();
  const midOf = (r) => {
    // a line's middle: a construction point held at the middle (SolidWorks has no middle point of its own)
    const key = r.e + '|mid';
    if (midPts.has(key)) return midPts.get(key);
    const e = doc.model.get(r.e);
    if (e?.type !== 'line') return null;
    const i = np++;
    rel.push('Set pts(' + i + ') = swSkMgr.CreatePoint(' + [M((e.x1 + e.x2) / 2), M((e.y1 + e.y2) / 2), 0].join(', ') + ')');
    rel.push('If Not pts(' + i + ') Is Nothing Then pts(' + i + ').Select4 False, Nothing: segs(' + segOf.get(r.e + '|L') + ').Select4 True, Nothing: Relate "sgATMIDDLE", "middle of line ' + r.e + '"');
    midPts.set(key, 'pts(' + i + ')');
    return 'pts(' + i + ')';
  };
  const sel = (exprs, rname, what) => {
    const lines = ['swModel.ClearSelection2 True'];
    exprs.forEach((x, j) => lines.push('Pick ' + x + ', ' + (j ? 'True' : 'False')));
    lines.push('Relate "' + rname + '", "' + what + '"');
    return lines;
  };
  for (const [a, b] of joins) { rel.push(...sel([a, b], 'sgCOINCIDENT', 'polyline vertex')); out.relations++; }
  let lostRel = 0;
  for (const c of doc.constraints) {
    if (isDim(c)) continue;
    const exprs = c.refs.map((r) => (r.k === 'mid' ? midOf(r) : r.k === '*' ? refExpr({ e: r.e, k: wholeKey(doc.model.get(r.e)) }) : refExpr(r)));
    if (exprs.some((x) => !x)) { lostRel++; continue; }
    let rname = REL[c.type];
    const sig = c.refs.map((r) => refKind(doc.model.get(r.e), r.k)).join('');
    if (c.type === 'horizontal') rname = sig === 'PP' ? 'sgHORIZONTALPOINTS2D' : 'sgHORIZONTAL2D';
    if (c.type === 'vertical') rname = sig === 'PP' ? 'sgVERTICALPOINTS2D' : 'sgVERTICAL2D';
    if (!rname) { lostRel++; continue; }
    rel.push(...sel(exprs, rname, c.type + ' ' + c.id));
    out.relations++;
  }
  // i18n-ignore-end
  if (lostRel) notes.push(t('swsketch.lost_rel', { n: lostRel }));
  if (doc.constraints.some((c) => c.type === 'symmetric')) notes.push(t('swsketch.symmetric'));

  // ---- dimensions (named; their values set; expressions become equations below)
  const dims = [];
  const sketchDims = new Map();   // our name → SolidWorks dimension name (same name)
  for (const c of doc.constraints) {
    if (!isDim(c)) continue;
    const exprs = c.refs.map((r) => refExpr(r));
    if (exprs.some((x) => !x)) continue;
    const at = labelAt(doc, c);
    let call = 'swModel.AddDimension2(', pickList = exprs;
    if (c.type === 'hdist') call = 'swModel.AddHorizontalDimension2(';
    else if (c.type === 'vdist') call = 'swModel.AddVerticalDimension2(';
    else if (c.type === 'radius') call = 'swModel.AddRadialDimension2(';
    else if (c.type === 'diameter') call = 'swModel.AddDiameterDimension2(';
    else if (c.type === 'angle' && c.refs.length === 1) pickList = [ptOf.get(c.refs[0].e + '|c'), ptOf.get(c.refs[0].e + '|s'), ptOf.get(c.refs[0].e + '|e')];
    const value = c.type === 'angle' ? num(c.value * Math.PI / 180) : M(c.value);
    dims.push('swModel.ClearSelection2 True');
    pickList.forEach((x, j) => dims.push('Pick ' + x + ', ' + (j ? 'True' : 'False')));
    dims.push('Dimension ' + call + M(at.x) + ', ' + M(at.y) + ', 0), "' + c.name + '", ' + value + ', "' + c.name + ' (' + c.type + ')"');
    sketchDims.set(c.name, c.name);
    out.dimensions++;
  }

  // ---- global variables and equations (EquationMgr.Add2, index -1 = at the end)
  const eqs = [];
  const ev = evaluateVars(doc.params);
  const order = ev.order.filter((n) => doc.params.vars.some((v) => v.name === n));
  let lostEq = 0;
  const toSw = (expr) => swExpr(expr, (n) => (sketchDims.has(n) ? '""' + n + '@" & sketchName & """' : '""' + n + '""'));
  for (const n of order) {
    const v = doc.params.vars.find((x) => x.name === n);
    const dim = sketchDims.has(n);
    const lit = parse(v.expr, []).ok && parse(v.expr, []).ast.k === 'num';
    if (dim && lit) continue;                                   // a plain number: the dimension's own value
    const rhs = toSw(v.expr);
    if (!rhs.ok) { lostEq++; notes.push(t(dim ? 'swsketch.eq_value.dim' : 'swsketch.eq_value.param', { name: n, why: rhs.error, value: formatNumber(ev.values.get(n) ?? 0) })); }
    const text = rhs.ok ? rhs.text : formatNumber(ev.values.get(n) ?? 0);
    const lhs = dim ? '""' + n + '@" & sketchName & """' : '""' + n + '""';
    eqs.push('AddEquation "' + lhs + ' = ' + text + '", "' + n + '"');
    if (dim) out.equations++; else out.globals++;
  }
  if (doc.layouts.length) notes.push(t('swsketch.sheets_not_part_sketch'));

  // ---- the macro
  // i18n-ignore-start: the .swb text itself (comments and VBA, English)
  const head = [
    "' " + safe(name) + '.swb - written by the CadCraft drafting app (getcadcraft.com) on ' + new Date().toISOString().slice(0, 10) + '.',
    "' Run it in SolidWorks: Tools, Macro, Run, then choose this file. It makes a new part with one sketch on the Front Plane:",
    "' " + out.lines + ' lines, ' + out.arcs + ' arcs, ' + out.circles + ' circles, ' + out.points + ' points, ' + out.relations + ' relations, ' + out.dimensions + ' dimensions, ' + out.globals + ' global variables, ' + out.equations + ' equations.',
    "' Not yet tested in SolidWorks. Failures are written to " + safe(name) + "-cadcraft.log next to this macro; the macro carries on.",
    "' Units: the part uses the drawing's length unit; the API takes metres, so every coordinate below is in metres.",
    'Option Explicit',
    'Dim swApp As Object',
    'Dim swModel As Object',
    'Dim swSkMgr As Object',
    'Dim swEqnMgr As Object',
    'Dim segs(' + Math.max(0, ns - 1) + ') As Object',
    'Dim pts(' + Math.max(0, np - 1) + ') As Object',
    'Dim sketchName As String',
    'Dim logPath As String',
    'Dim fails As Long',
    'Dim done As Long',
    '',
    'Sub LogFail(what As String)',
    '    Dim f As Integer',
    '    fails = fails + 1',
    '    On Error Resume Next',
    '    f = FreeFile',
    '    Open logPath For Append As #f',
    '    Print #f, Now & "  could not make: " & what',
    '    Close #f',
    '    Err.Clear',
    'End Sub',
    '',
    'Sub Pick(obj As Object, append As Boolean)',
    '    On Error Resume Next',
    '    If obj Is Nothing Then Exit Sub',
    '    obj.Select4 append, Nothing',
    '    Err.Clear',
    'End Sub',
    '',
    'Sub Relate(kind As String, what As String)',
    '    On Error Resume Next',
    '    swModel.SketchAddConstraints kind',
    '    If Err.Number <> 0 Then LogFail what & " (" & kind & ")" Else done = done + 1',
    '    Err.Clear',
    '    swModel.ClearSelection2 True',
    'End Sub',
    '',
    'Sub Dimension(dd As Object, dimName As String, v As Double, what As String)',
    '    Dim d As Object',
    '    On Error Resume Next',
    '    If dd Is Nothing Then LogFail what: Exit Sub',
    '    Set d = dd.GetDimension2(0)',
    '    If d Is Nothing Then LogFail what: Exit Sub',
    '    d.Name = dimName',
    '    d.SystemValue = v',
    '    If Err.Number <> 0 Then LogFail what & " (name or value)" Else done = done + 1',
    '    Err.Clear',
    '    swModel.ClearSelection2 True',
    'End Sub',
    '',
    'Sub AddEquation(text As String, what As String)',
    '    Dim r As Long',
    '    On Error Resume Next',
    '    r = swEqnMgr.Add2(-1, text, True)',
    '    If Err.Number <> 0 Or r < 0 Then LogFail "equation for " & what & ": " & text Else done = done + 1',
    '    Err.Clear',
    'End Sub',
    '',
  ];
  const subs = [];
  const chunked = (prefix, stmts, pre = []) => {
    for (let i = 0; i < stmts.length; i += 150) {
      const nm = prefix + (Math.floor(i / 150) + 1);
      subs.push({ nm, body: ['    On Error Resume Next', ...pre.map((s) => '    ' + s), ...stmts.slice(i, i + 150).map((s) => '    ' + s), '    Err.Clear'] });
    }
  };
  chunked('Geometry', geo);
  chunked('Relations', rel);
  chunked('Dimensions', dims);
  chunked('Equations', eqs);
  const main = [
    'Sub main()',
    '    Dim tpl As String',
    '    Dim ok As Boolean',
    '    Dim feat As Object',
    '    Set swApp = Application.SldWorks',
    '    logPath = swApp.GetCurrentMacroPathFolder() & "\\' + safe(name) + '-cadcraft.log"',
    '    tpl = swApp.GetUserPreferenceStringValue(' + SW_CONST.swDefaultTemplatePart + ')',
    '    Set swModel = swApp.NewDocument(tpl, 0, 0, 0)',
    '    If swModel Is Nothing Then',
    '        MsgBox "Could not make a new part from the default part template (" & tpl & "). Set one in Tools, Options, Default Templates."',
    '        Exit Sub',
    '    End If',
    '    ok = swModel.Extension.SetUserPreferenceInteger(' + SW_CONST.swUnitsLinear + ', ' + SW_CONST.swDetailingNoOptionSpecified + ', ' + swUnit + ')',
    '    swApp.SetUserPreferenceToggle ' + SW_CONST.swInputDimValOnCreate + ', False',
    '    Set swSkMgr = swModel.SketchManager',
    '    ok = swModel.Extension.SelectByID2("Front Plane", "PLANE", 0, 0, 0, False, 0, Nothing, 0)',
    '    If Not ok Then LogFail "selecting the Front Plane"',
    '    swSkMgr.InsertSketch True',
    '    swSkMgr.AddToDB = True',
    '    swSkMgr.DisplayWhenAdded = False',
    '    Set feat = swSkMgr.ActiveSketch',
    '    sketchName = "Sketch1"',
    '    If Not feat Is Nothing Then sketchName = feat.Name',
    ...subs.filter((s) => /^(Geometry|Relations|Dimensions)/.test(s.nm)).map((s) => '    ' + s.nm),
    '    swSkMgr.AddToDB = False',
    '    swSkMgr.DisplayWhenAdded = True',
    '    swSkMgr.InsertSketch True',
    '    Set swEqnMgr = swModel.GetEquationMgr()',
    ...subs.filter((s) => /^Equations/.test(s.nm)).map((s) => '    ' + s.nm),
    '    ok = swModel.EditRebuild3()',
    '    swModel.ViewZoomtofit2',
    '    MsgBox "CadCraft sketch: " & done & " relations, dimensions and equations made, " & fails & " could not be made" & IIf(fails > 0, " (see " & logPath & ").", ".")',
    'End Sub',
    '',
  ];
  const lines = [...head, ...subs.flatMap((s) => ['Sub ' + s.nm + '()', ...s.body, 'End Sub', '']), ...main];
  // i18n-ignore-end
  const text = lines.join('\r\n') + '\r\n';
  const bytes = new Uint8Array([...text].map((ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : 63; }));
  const summary = t('swsketch.summary', out);
  return { ok: true, text, bytes, notes, summary, counts: out };
}

const num = (v) => { const s = Number(v.toPrecision(15)).toString(); return /e/i.test(s) ? v.toExponential(14).replace('e', 'E') : s; };
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'Drawing1';
const wholeKey = (e) => (e?.type === 'line' ? 'L' : e?.type === 'circle' || e?.type === 'arc' ? 'R' : e?.type === 'point' ? 'p' : null);
function bulgeCentre(p, q, b) {
  const th = 4 * Math.atan(b), c = Math.hypot(q.x - p.x, q.y - p.y), r = Math.abs(c / (2 * Math.sin(th / 2)));
  const h = r * Math.cos(th / 2) * (b > 0 ? 1 : -1), ux = (q.x - p.x) / c, uy = (q.y - p.y) / c;
  return { x: (p.x + q.x) / 2 - uy * h, y: (p.y + q.y) / 2 + ux * h };
}
/** Where a dimension's text goes (its label position on the drawing). */
function labelAt(doc, c) { const d = dimEntityFor(doc, c); return d ? d.loc : { x: 0, y: 0 }; }

/** An expression → SolidWorks equation text ("name" quoted by `quote`). → { ok, text } | { ok: false, error }. */
export function swExpr(src, quote) {
  const r = parse(src);
  if (!r.ok) return { ok: false, error: r.error };
  let bad = null;
  const P = { cmp: 0, '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
  const w = (n, ctx = 0) => {
    switch (n.k) {
      case 'num': return n.name === 'pi' ? 'pi' : num(n.v);
      case 'var': return quote(n.name);
      case 'neg': return '-' + w(n.a, 4);
      case 'cmp': bad = bad || t('swsketch.comparisons_have_no_solidworks'); return '0';
      case 'bin': {
        if (n.op === '%') { bad = bad || t('swsketch.remainder_operator_has_no'); return '0'; }
        const p = P[n.op];
        const s = w(n.a, p) + ' ' + n.op + ' ' + w(n.b, p + (n.op === '^' ? 0 : 1));
        return p < ctx ? '(' + s + ')' : s;
      }
      case 'call': {
        const f = SW_FUNCS[n.name];
        if (!f) { bad = bad || t('swsketch.fn_noform', { fn: n.name }); return '0'; }
        return f + '(' + n.args.map((a) => w(a)).join(', ') + ')';
      }
      default: bad = bad || t('swsketch.unknown_expression'); return '0';
    }
  };
  const text = w(r.ast);
  return bad ? { ok: false, error: bad } : { ok: true, text };
}

// ---------------------------------------------------------------- backward

const LIM = { features: 5000, points: 50000, segments: 50000, relations: 50000, dimensions: 20000, globals: 2000, equations: 5000 };
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;
const idOk = (s) => typeof s === 'string' && /^[\w.@-]{1,60}$/.test(s);

/** Untrusted export JSON (text or object) → { ok, exp, sketches } | { ok: false, error }. */
export function readSwExport(raw) {
  let j = raw;
  if (typeof raw === 'string') {
    if (raw.length > 50_000_000) return { ok: false, error: t('swsketch.export_too_large') };
    try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch { return { ok: false, error: t('swsketch.file_not_readable_json') }; }
  }
  if (!j || typeof j !== 'object' || j.format !== 'cadcraft-sw-export') return { ok: false, error: t('swsketch.json_not_export_cadcraft') };
  if (j.version !== 1) return { ok: false, error: t('swsketch.version', { version: String(j.version).slice(0, 10) }) };
  if (j.units !== undefined && j.units !== 'mm') return { ok: false, error: t('swsketch.export_not_millimetres') };
  if (!Array.isArray(j.features) || j.features.length > LIM.features) return { ok: false, error: t('swsketch.export_has_no_feature') };
  const sketches = [];
  for (const f of j.features) {
    if (!f || f.type !== 'sketch') continue;
    if (typeof f.name !== 'string' || !f.name.trim()) return { ok: false, error: t('swsketch.sketch_export_has_no') };
    const bad = (what) => ({ ok: false, error: t('swsketch.bad', { name: f.name.slice(0, 60), what }) });
    const pts = f.points ?? [], segs = f.segments ?? [], rels = f.relations ?? [], dims = f.dimensions ?? [];
    if (![pts, segs, rels, dims].every(Array.isArray) || pts.length > LIM.points || segs.length > LIM.segments || rels.length > LIM.relations || dims.length > LIM.dimensions) return bad(t('swsketch.lists_bad_too_long'));
    const pids = new Set(), sids = new Set();
    for (const p of pts) { if (!p || !idOk(p.id) || pids.has(p.id) || !finite(p.x) || !finite(p.y)) return bad(t('swsketch.point_bad')); pids.add(p.id); }
    for (const s of segs) {
      if (!s || !idOk(s.id) || sids.has(s.id) || pids.has(s.id)) return bad(t('swsketch.segment_bad'));
      if (s.type === 'line') { if (!pids.has(s.a) || !pids.has(s.b)) return bad(t('swsketch.bad.missing', { what: 'line ' + s.id })); }   // i18n-ignore: an id from the file
      else if (s.type === 'arc') { if (![s.c, s.s, s.e].every((x) => pids.has(x))) return bad(t('swsketch.bad.missing', { what: 'arc ' + s.id })); }   // i18n-ignore: an id from the file
      else if (s.type === 'circle') { if (!pids.has(s.c) || !finite(s.r) || !(s.r > 0)) return bad(t('swsketch.bad.bad', { what: 'circle ' + s.id })); }   // i18n-ignore: an id from the file
      else return bad(t('swsketch.bad.type', { what: 'segment ' + s.id }));   // i18n-ignore: an id from the file
      sids.add(s.id);
    }
    for (const r of rels) if (!r || typeof r.type !== 'string' || !Array.isArray(r.refs) || r.refs.length > 3 || !r.refs.every((x) => x === 'O' || pids.has(x) || sids.has(x))) return bad(t('swsketch.relation_bad'));
    for (const d of dims) if (!d || typeof d.type !== 'string' || !finite(d.value) || !Array.isArray(d.refs) || d.refs.length > 3 || !d.refs.every((x) => x === 'O' || pids.has(x) || sids.has(x)) || (d.name !== undefined && typeof d.name !== 'string')) return bad(t('swsketch.dimension_bad'));
    sketches.push({ name: f.name.slice(0, 120), suppressed: !!f.suppressed, plane: f.plane, points: pts, segments: segs, relations: rels, dimensions: dims });
  }
  if (!sketches.length) return { ok: false, error: t('swsketch.export_has_no_sketches') };
  for (const k of ['globals', 'equations']) if (j[k] !== undefined && (!Array.isArray(j[k]) || j[k].length > LIM[k])) return { ok: false, error: t('swsketch.bad.' + k) };
  return { ok: true, exp: j, sketches };
}

/**
 * Open one sketch of an export as the drawing (replaces it, like opening a file; not undoable).
 * → { ok, report: { notes, read }, error }.
 */
export function loadSwSketch(doc, exp, sketchName) {
  const r = readSwExport(exp);
  if (!r.ok) return r;
  const sk = r.sketches.find((s) => s.name === sketchName) || r.sketches[0];
  const notes = [];
  if (r.sketches.length > 1) notes.push(t('swsketch.load.several', { n: r.sketches.length, name: sk.name }));
  if (sk.plane) notes.push(t('swsketch.load.plane'));
  if (sk.suppressed) notes.push(t('swsketch.load.suppressed', { name: sk.name }));
  const P = new Map(sk.points.map((p) => [p.id, p]));
  // entities: segments, then points no segment uses
  const ents = [], refOfPoint = new Map(), refOfSeg = new Map(), extra = [];   // extra: shared sketch points → coincident pairs
  const usePoint = (pid, ref) => { if (refOfPoint.has(pid)) extra.push([refOfPoint.get(pid), ref]); else refOfPoint.set(pid, ref); };
  for (const s of sk.segments) {
    const i = ents.length;
    if (s.type === 'line') {
      const a = P.get(s.a), b = P.get(s.b);
      ents.push({ type: 'line', layer: s.construction ? 'CONSTRUCTION' : '0', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      refOfSeg.set(s.id, { i, k: 'L' }); usePoint(s.a, { i, k: 'p1' }); usePoint(s.b, { i, k: 'p2' });
    } else if (s.type === 'arc') {
      const c = P.get(s.c), st = P.get(s.s), en = P.get(s.e);
      ents.push({ type: 'arc', layer: s.construction ? 'CONSTRUCTION' : '0', cx: c.x, cy: c.y, r: Math.hypot(st.x - c.x, st.y - c.y), a0: ang(st.y - c.y, st.x - c.x), a1: ang(en.y - c.y, en.x - c.x) });
      refOfSeg.set(s.id, { i, k: 'R' }); usePoint(s.c, { i, k: 'c' }); usePoint(s.s, { i, k: 's' }); usePoint(s.e, { i, k: 'e' });
    } else {
      const c = P.get(s.c);
      ents.push({ type: 'circle', layer: s.construction ? 'CONSTRUCTION' : '0', cx: c.x, cy: c.y, r: s.r });
      refOfSeg.set(s.id, { i, k: 'R' }); usePoint(s.c, { i, k: 'c' });
    }
  }
  for (const p of sk.points) if (!refOfPoint.has(p.id)) { refOfPoint.set(p.id, { i: ents.length, k: 'p' }); ents.push({ type: 'point', layer: p.construction ? 'CONSTRUCTION' : '0', x: p.x, y: p.y }); }
  // "O" = the sketch origin (SolidWorks' is not a sketch point): a construction point at 0,0, fixed
  const usesOrigin = [...sk.relations, ...sk.dimensions].some((x) => x.refs.includes('O'));
  if (usesOrigin) { refOfPoint.set('O', { i: ents.length, k: 'p' }); ents.push({ type: 'point', layer: 'CONSTRUCTION', x: 0, y: 0 }); }
  const layers = ents.some((e) => e.layer === 'CONSTRUCTION') ? [{ name: 'CONSTRUCTION', color: 8 }] : [];
  doc.load({ entities: ents, layers, meta: { name: sk.name, units: 'millimeters', source: (exp?.name || 'export') + '.json', format: t('swsketch.load.format', { name: sk.name }) } });
  const ids = [...doc.model.keys()];
  const R = (x) => (x ? { e: ids[x.i], k: x.k } : null);
  const refFor = (id) => R(refOfPoint.get(id) || refOfSeg.get(id));

  // relations
  const plan = [];   // { type, refs, value?, name?, loc? }
  for (const [a, b] of extra) plan.push({ type: 'coincident', refs: [R(b), R(a)] });
  if (usesOrigin) plan.push({ type: 'fix', refs: [refFor('O')] });
  let lost = 0;
  const lostKinds = new Set();
  for (const rl of sk.relations) {
    const refs = rl.refs.map(refFor);
    let t = rl.type;
    if (t === 'midpoint') {
      const p = refs[0], l = refs[1];
      if (p && l && l.k === 'L') { plan.push({ type: 'coincident', refs: [p, { e: l.e, k: 'mid' }] }); continue; }
      lost++; lostKinds.add(t); continue;
    }
    if (!['horizontal', 'vertical', 'coincident', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'fix', 'collinear', 'symmetric'].includes(t)) { lost++; lostKinds.add(String(t).slice(0, 30)); continue; }
    if (t === 'fix' && refs.length === 1 && refs[0].k !== 'p' && !['p1', 'p2', 'c', 's', 'e'].includes(refs[0].k)) refs[0] = { e: refs[0].e, k: '*' };
    if (t === 'tangent' && refs.length === 2 && refs[0].k === 'R' && refs[1].k === 'L') refs.reverse();
    if (t === 'coincident' && refs.length === 2 && (refs[0].k === 'L' || refs[0].k === 'R')) refs.reverse();
    plan.push({ type: t, refs });
  }
  // dimensions
  const dimNames = new Map();   // SolidWorks name (D1) → ours
  const taken = new Set();
  for (const d of sk.dimensions) {
    const refs = d.refs.map(refFor);
    let type = { distance: 'dist', hdistance: 'hdist', vdistance: 'vdist', radius: 'radius', diameter: 'diameter', angle: 'angle' }[d.type];
    if (!type || refs.some((x) => !x)) { lost++; lostKinds.add(t('swsketch.load.lost_dim', { type: String(d.type).slice(0, 20) })); continue; }
    let rr = refs;
    if ((type === 'dist' || type === 'hdist' || type === 'vdist') && refs.length === 1 && refs[0].k === 'L') rr = [{ e: refs[0].e, k: 'p1' }, { e: refs[0].e, k: 'p2' }];
    if (type === 'dist' && rr.length === 2 && rr[0].k === 'L' && rr[1].k !== 'L') rr = [rr[1], rr[0]];
    let name = typeof d.name === 'string' && NAME_RE.test(d.name) && !RESERVED.has(d.name.toLowerCase()) && !taken.has(d.name) ? d.name : null;
    if (!name) name = nextName({ vars: [], links: [] }, DIMENSIONAL[type].prefix, taken);
    taken.add(name);
    if (typeof d.name === 'string') dimNames.set(d.name, name);
    if (typeof d.full === 'string') dimNames.set(d.full, name);
    plan.push({ type, refs: rr, value: d.value, name });
  }
  if (lost) notes.push(t('swsketch.load.lost', { n: lost, kinds: [...lostKinds].join(', ') }));

  // build the constraints against the geometry (not undoable: this is opening a file)
  const cs = [], params = { vars: [], links: [] };
  let refused = 0;
  doc.solving = true;
  for (const p of plan) {
    if (p.refs.some((x) => !x)) { refused++; continue; }
    const save = doc.constraints;
    doc.constraints = cs;
    const m = makeConstraint(doc, p.type, p.refs, { name: p.name, space: 'model' });
    doc.constraints = save;
    if (m.error) { refused++; continue; }
    const c = m.c;
    if (isDim(c)) {
      if (Number.isFinite(p.value) && p.value > 0) c.value = p.value;   // millimetres; angles in degrees
      params.vars.push({ name: c.name, expr: formatNumber(Math.round(c.value * 1e9) / 1e9) });
      params.links.push({ target: targetKey(c), expr: c.name });
    }
    cs.push(c);
  }
  doc.solving = false;
  if (refused) notes.push(t('swsketch.load.refused', { n: refused }));

  // global variables, then equations on this sketch's dimensions
  const swToOurs = (txt) => {
    let unknown = null;
    const s = String(txt).replace(/"([^"]{1,120})"/g, (_, n) => {
      if (dimNames.has(n)) return dimNames.get(n);
      const short = n.replace(/@.*$/, '');
      if (n.includes('@')) { if (n.endsWith('@' + sk.name) && dimNames.has(short)) return dimNames.get(short); unknown = unknown || n; return '0'; }
      if (NAME_RE.test(n)) return n;
      unknown = unknown || n; return '0';
    }).replace(/\bsqr\(/gi, 'sqrt(').replace(/\bsgn\(/gi, 'sign(').replace(/\batn\(/gi, 'atan(');
    return { s, unknown };
  };
  let lostEq = 0;
  for (const g of exp.globals || []) {
    if (!g || typeof g.name !== 'string' || typeof g.expr !== 'string') { lostEq++; continue; }
    if (nameProblem(g.name, params)) { lostEq++; notes.push(t('swsketch.load.global_name', { name: g.name.slice(0, 40), why: nameProblem(g.name, params) })); continue; }
    const tr = swToOurs(g.expr);
    if (tr.unknown || !parse(tr.s).ok) { lostEq++; notes.push(tr.unknown ? t('swsketch.load.global_unknown', { name: g.name, ref: tr.unknown }) : t('swsketch.load.global_unread', { name: g.name })); continue; }
    params.vars.push({ name: g.name, expr: tr.s, note: 'From SolidWorks' });   // i18n-ignore: stored in the drawing
  }
  for (const q of exp.equations || []) {
    if (!q || typeof q.lhs !== 'string' || typeof q.rhs !== 'string') { lostEq++; continue; }
    const lhs = q.lhs.replace(/^"|"$/g, '');
    const ours = dimNames.get(lhs) || (lhs.endsWith('@' + sk.name) ? dimNames.get(lhs.replace(/@.*$/, '')) : null);
    if (!ours) { if (!(exp.globals || []).some((g) => g.name === lhs)) lostEq++; continue; }
    const tr = swToOurs(q.rhs);
    const v = params.vars.find((x) => x.name === ours);
    if (tr.unknown || !parse(tr.s).ok || !v) { lostEq++; notes.push(t('swsketch.load.eq_unread', { lhs, name: ours })); continue; }
    v.expr = tr.s;
  }
  if (lostEq) notes.push(t('swsketch.load.lost_eq', { n: lostEq }));
  doc.constraints = cs; doc.params = params;
  // resolve: equations drive the dimensions, the sketch solves (it should already agree)
  const s = solveAll(doc, 'OPEN');
  if (!s.ok) notes.push(t('swsketch.load.unsolved', { why: s.error }));
  doc.undoStack.length = 0; doc.redoStack.length = 0;
  doc.markSaved();
  return { ok: true, sketch: sk.name, report: { notes, read: ents.length, constraints: cs.length } };
}
const ang = (y, x) => { let a = Math.atan2(y, x); if (a < 0) a += TAU; return a; };

