/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ws3d-core.js — the 3D tab's workings without a screen. No DOM, no three.js: bin/test-cadcraft-3d.mjs drives it in Node
 * through a Camera; ws3d.js (the browser) adds the three.js view and the pointer, wheel and key events.
 *
 *   const ws = new Workspace3D({ doc, engine, host });   host = cadcraft.js's command host (print, setSelection, …)
 *   ws.down(ev) · ws.move(ev) · ws.up(ev)   ev = {x, y, shift, ctrl, alt, button: 0, time}  (CSS px in the 3D view)
 *   ws.click(x, y, mods)                    down + up in place (tests, keyboard users)
 *   ws.value(text, {angle}) → bool          a value typed while a ModelCraft tool runs (lengths in drawing units)
 *   ws.fit() · ws.view(name) · ws.setStyle(key) · ws.lines() · ws.selectAll() · ws.clearSel() · ws.eraseSel()
 *
 * What a click means follows the command line (commands.js `engine.waiting`):
 *   a point is asked     → the point under the cursor (ModelCraft's inference: ends, edges, faces, else the ground), in
 *                          drawing units with z: {x, y, z}; previews of 2D commands lie on the ground
 *   a height is asked    → (prompt opts.height {rings, z0}) the height along Z from the base, following the cursor
 *   objects are asked    → the 2D object under the cursor on the ground (its outline, or the closed shape around it)
 *   a ModelCraft tool    → (prompt opts.ws === 'tool') the tool's own state machine (tools.js): push/pull, move, rotate,
 *                          orbit, select. When it makes its edit the waiting prompt gets {done3d: true}
 *   nothing asked        → ModelCraft's Select tool (click, window, crossing; double-click opens a group)
 * The 3D selection is `ws.th.sel` ([{t: 'e'|'f'|'i', id}] in the open group `ws.th.path`), separate from the 2D one.
 */

import { Camera, VIEWS } from './m3d/camera.js';
import { Tools } from './m3d/tools.js';
import { sceneOf, infer, pick, alongLine, rayPlane } from './m3d/infer.js';
import { eraseSel } from './m3d/model.js';
import { bboxAdd, sub, add, mul, norm, dist } from './m3d/vec.js';
import { walk } from './walk.js';
import { distToEntity, pointInPoly } from './geom.js';
import { outline2d, withUnit, STYLES } from './model3d.js';
import { t } from './i18n.js';

const MAX_SNAP_2D = 50000;   // 2D line pieces the 3D view snaps to (a huge drawing: the first ones)
/** Points along a primitive (an arc in short pieces), drawing units. */
function segPts(q) {
  if (q.k === 'L') return [{ x: q.x1, y: q.y1 }, { x: q.x2, y: q.y2 }];
  let sw = q.a1 - q.a0; while (sw <= 0) sw += 2 * Math.PI;
  const m = Math.max(2, Math.ceil(sw / (Math.PI / 24))), out = [];
  for (let i = 0; i <= m; i++) { const a = q.a0 + sw * i / m; out.push({ x: q.cx + q.r * Math.cos(a), y: q.cy + q.r * Math.sin(a) }); }
  return out;
}
/** Does segment p–q cross any edge of the polygon? */
function crossesPoly(p, q, poly) {
  const o = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (o(p, q, a) * o(p, q, b) < 0 && o(a, b, p) * o(a, b, q) < 0) return true;
  }
  return false;
}

export { STYLES };

export const VIEW_NAMES = ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'];
const TAU = Math.PI * 2;

export class Workspace3D {
  constructor({ doc, engine, host }) {
    this.doc = doc; this.engine = engine; this.host = host;
    this.model = doc.model3d;
    this.cam = new Camera();
    this.styleKey = 'edges';
    this.active = false;
    this.done = false;
    this.driving = null;        // {tool, copy} while a command drives a ModelCraft tool
    this.hover2d = null;
    this.lastEv = null;
    let sc = null;
    const ws = this;
    const th = this.th = {
      get model() { return ws.model; },
      cam: this.cam, path: [], sel: [], overlayState: null, mouse: null,
      get units() { return ws.model.syncUnits(); },
      // the solids' scene + the 2D drawing's lines on the ground as soft edges: ModelCraft's inference snaps to their ends,
      // middles and lengths; picking and window selection skip soft edges, so they are never selected (0.4 C14)
      scene() {
        if (!sc || sc.version !== ws.model.version || sc.docVersion !== ws.doc.version) { sc = sceneOf(ws.model); sc.docVersion = ws.doc.version; sc.edges.push(...ws.lines2d()); }
        return sc;
      },
      setSel(s) { th.sel = s.filter(Boolean); ws.changed(); },
      toolSet(name) { ws.onToolSet?.(name); },
      overlay(o) { th.overlayState = o; ws.invalidate(); },
      tip(t) { ws.tip = t || ''; ws.onTip?.(ws.tip); },
      vcb() {},
      print: (s) => host.print(s),
      changed() { ws.invalidate(); },
      openContext(path) {
        if (!ws.model.context(path)) return;
        th.path = path; th.sel = [];
        host.print(t('ws3d.editing_context', { name: ws.model.context(path).def.name }));
        ws.changed();
      },
      closeContext() {
        if (!th.path.length) return;
        const leaving = th.path[th.path.length - 1];
        th.path = th.path.slice(0, -1);
        th.sel = [{ t: 'i', id: leaving }];
        ws.changed();
      },
    };
    this.tools = new Tools(th);
    this.tools.collide = false;
    this.model.onRecord = () => { this.recorded = true; };
    this.recorded = false;
    this.tip = '';
    this.style = { ...STYLES[this.styleKey] };
    this.model.viewState = () => this.viewState();   // forFile3d saves the camera with the model (0.4 C14)
    doc.on((kind) => {
      if (kind === 'load') { th.path = []; th.sel = []; this.tools.set('select'); this.applySaved(); }
      this.validate();
      this.linesFor = null;
      this.invalidate();
    });
  }

  /** Meters per drawing unit. */
  get k() { return this.model.k; }
  /** The model space's visible 2D lines as scene edges (meters, z = 0, soft; arcs in short pieces), at most MAX_SNAP_2D. */
  lines2d() {
    const k = this.k, out = [];
    let n = 0;
    const seg = (x1, y1, x2, y2) => { if (n++ < MAX_SNAP_2D) out.push({ path: [], def: null, id: '2d' + n, a: [x1 * k, y1 * k, 0], b: [x2 * k, y2 * k, 0], soft: true, flat2d: true }); };
    walk(this.doc, this.doc.model.values(), {
      stroke: (c, ps) => {
        for (const q of ps) {
          if (q.k === 'L') { seg(q.x1, q.y1, q.x2, q.y2); continue; }
          let sw = q.a1 - q.a0; while (sw <= 0) sw += 2 * Math.PI;
          const m = Math.max(2, Math.ceil(sw / (Math.PI / 24)));
          for (let i = 0; i < m; i++) { const a = q.a0 + sw * i / m, b = q.a0 + sw * (i + 1) / m; seg(q.cx + q.r * Math.cos(a), q.cy + q.r * Math.sin(a), q.cx + q.r * Math.cos(b), q.cy + q.r * Math.sin(b)); }
        }
      },
      fill() {}, text() {}, point: (c, x, y) => seg(x, y, x, y),
    });
    return out;
  }
  /** The camera and visual style a drawing saved (model3d savedView), applied; false when it has none (0.4 C14). */
  applySaved() {
    const v = this.model.savedView;
    if (!v) return false;
    const cam = this.cam;
    cam.eye = v.eye.slice(); cam.target = v.target.slice(); cam.persp = v.persp; if (v.fov) cam.fov = v.fov;
    if (v.style) this.setStyle(v.style);
    this.invalidate();
    return true;
  }
  /** What is saved with the drawing: the view as it is now. */
  viewState() { const c = this.cam; return { eye: c.eye.slice(), target: c.target.slice(), persp: !!c.persp, fov: c.fov, style: this.styleKey }; }
  invalidate() { this.onInvalidate?.(); }
  changed() { this.onChanged?.(); this.invalidate(); }
  /** Selection and open group still exist (after undo, redo, open). */
  validate() {
    const th = this.th;
    if (!this.model.context(th.path)) th.path = [];
    const def = this.model.context(th.path).def;
    th.sel = th.sel.filter((s) => (s.t === 'e' ? def.edges.has(s.id) : s.t === 'f' ? def.faces.has(s.id) : s.t === 'i' ? def.insts.has(s.id) : this.model.guides.has(s.id)));
  }

  // ---- what a pointer event means now ----
  inputMode() {
    const w = this.engine.waiting;
    if (!w) return this.engine.busy ? 'none' : 'tool';
    if (w.opts?.ws === 'tool') return 'tool';
    if (w.kind === 'point') return 'point';
    if ((w.kind === 'number' || w.kind === 'distance') && w.opts?.height) return 'height';
    if (w.kind === 'distance' || w.kind === 'angle') return 'flat';
    if (w.kind === 'select') return 'select2d';
    if (w.kind === 'entity') return 'entity2d';
    return 'none';
  }

  down(ev) {
    this.lastEv = ev;
    this.mode = this.inputMode();
    this.pressAt = { x: ev.x, y: ev.y };
    if (this.mode !== 'tool') return;
    const T = this.tools;
    // copy: the move tool takes Ctrl at the base-point click as "copy"
    if (this.driving?.copy && T.name === 'move' && !T.tool.p0) ev = { ...ev, ctrl: true };
    // push/pull on a solid: open the solid (a group) the face belongs to, then let the tool pick the face
    if (T.name === 'push' && T.tool.fid === null && !this.th.path.length) {
      const s = pick(this.th.scene(), this.cam, ev.x, ev.y, { path: [] });
      if (s && s.t === 'i') { this.th.path = [s.id]; this.th.sel = []; this.openedForPush = true; }
    }
    T.down(ev);
    this.check();
  }
  move(ev) {
    this.lastEv = ev;
    this.th.mouse = { x: ev.x, y: ev.y };
    const mode = this.pressAt ? this.mode : this.inputMode();
    if (mode === 'tool') { this.tools.move(ev); return; }
    this.hover(mode, ev);
  }
  up(ev) {
    this.lastEv = ev;
    const mode = this.mode, at = this.pressAt;
    this.pressAt = null;
    if (mode === 'tool') { this.tools.up(ev); this.check(); return; }
    if (at && mode === 'select2d' && Math.hypot(ev.x - at.x, ev.y - at.y) > 6) { this.window2d(at, ev); return; }   // 0.4 C14
    if (!at || Math.hypot(ev.x - at.x, ev.y - at.y) > 6) return;
    this.clickFor(mode, ev);
  }
  click(x, y, mods = {}) { const ev = { x, y, button: 0, ...mods }; this.move(ev); this.down(ev); this.up(ev); }

  /** A tool made its edit and is idle again: tell the waiting prompt (the command that drives it ends or goes on). */
  check() {
    if (!this.recorded || this.tools.tool.busy) return;
    this.recorded = false;
    this.done = true;
    const w = this.engine.waiting;
    if (w && w.opts?.ws === 'tool') { this.done = false; this.engine.resolve({ done3d: true }); }
  }
  consumeDone() { const d = this.done; this.done = false; this.recorded = false; return d; }

  // ---- clicks and hovering for the command line ----
  clickFor(mode, ev) {
    const E = this.engine, w = E.waiting;
    if (!w) return;
    if (mode === 'point') { const p = this.pointAt(ev); if (p) E.resolve(p); return; }
    if (mode === 'height') { const h = this.heightAt(ev, w.opts.height); if (h !== null) E.resolve(h); return; }
    if (mode === 'flat') { const g = this.groundAt(ev, w.opts.base?.z ?? this.engine.base?.z ?? 0); if (g) E.click({ x: g.x, y: g.y }); return; }
    if (mode === 'select2d' || mode === 'entity2d') {
      const id = this.pick2d(ev);
      if (!id) { this.host.print(t('ws3d-core.nothing_found_there_click')); return; }
      if (mode === 'entity2d') { E.resolve({ id, point: this.groundAt(ev, 0) }); return; }
      if (w.set.has(id) && ev.shift) w.set.delete(id); else w.set.add(id);
      this.host.setSelection(w.set);
      if (w.opts.single) E.resolve(w.set);
      this.invalidate();
    }
  }
  hover(mode, ev) {
    const E = this.engine, w = E.waiting;
    const o = { lines: [] };
    let cursor = null;
    if (mode === 'point') {
      const r = this.inferAt(ev);
      if (r) { cursor = this.toUnits(r.p); o.marker = { p: r.p, kind: r.kind }; o.tip = r.tip; }
    } else if (mode === 'flat') {
      cursor = this.groundAt(ev, w.opts.base?.z ?? E.base?.z ?? 0);
    } else if (mode === 'height') {
      const spec = w.opts.height, h = this.heightAt(ev, spec);
      if (h !== null) { this.prismLines(o.lines, spec.rings, spec.z0 || 0, h); o.tip = fmtNum(h); }
    } else if (mode === 'select2d' || mode === 'entity2d') {
      const id = this.pick2d(ev);
      this.hover2d = id;
    }
    if (cursor) {
      this.host.cursor = { x: cursor.x, y: cursor.y };
      const z = (E.base && Number.isFinite(E.base.z) ? E.base.z : cursor.z) || 0;
      for (const e of E.preview(this.host.cursor)) this.entityLines(o.lines, e, z, 'axis');
    }
    this.th.overlayState = o.lines.length || o.marker || o.tip ? o : null;
    this.invalidate();
  }

  // ---- geometry under the cursor ----
  toUnits(p) { const k = this.k; return { x: p[0] / k, y: p[1] / k, z: p[2] / k }; }
  inferAt(ev) {
    const r = infer(this.th.scene(), this.cam, ev.x, ev.y, { axes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, snap: this.tools.snapping });
    return r && r.p ? r : null;
  }
  /** The point a click stands for (drawing units, with z). */
  pointAt(ev) { const r = this.inferAt(ev); return r ? this.toUnits(r.p) : this.groundAt(ev, 0); }
  /** Where the cursor's ray meets the level plane z (drawing units). */
  groundAt(ev, z = 0) {
    const k = this.k, ray = this.cam.ray(ev.x, ev.y);
    const g = rayPlane(ray.o, ray.d, { n: [0, 0, 1], d: z * k });
    return g && g.t > 0 ? { x: g.p[0] / k, y: g.p[1] / k, z } : null;
  }
  /** A height along Z from a base (the first ring's middle at z0) following the cursor (drawing units). */
  heightAt(ev, spec) {
    const k = this.k;
    const ring = spec?.rings?.[0];
    let cx = 0, cy = 0;
    if (ring?.length) { for (const [x, y] of ring) { cx += x; cy += y; } cx /= ring.length; cy /= ring.length; }
    else if (spec?.base) { cx = spec.base.x; cy = spec.base.y; }
    const a = alongLine(this.cam, ev.x, ev.y, [cx * k, cy * k, (spec?.z0 || 0) * k], [0, 0, 1]);
    return a ? a.s / k : null;
  }
  /** The 2D object under the cursor on the ground: its outline within a few pixels, else the smallest closed one around it. */
  /**
   * A drag while 2D objects are asked: the screen rectangle laid on the ground; left to right takes what is wholly inside
   * (window), right to left what it touches (crossing), as on the Model tab. Shift takes them out again.
   */
  window2d(a, b) {
    const E = this.engine, w = E.waiting;
    if (!w || !w.set) return;
    const crossing = b.x < a.x;
    const quad = [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]].map(([x, y]) => this.groundAt({ x, y }, 0));
    if (quad.some((q) => !q)) { this.host.print(t('ws3d.window.sky')); return; }
    const poly = quad.map((q) => ({ x: q.x, y: q.y }));
    const ids = [];
    for (const e of this.doc.model.values()) {
      if (!this.doc.editable(e)) continue;
      const pts = [], segs = [];
      walk(this.doc, [e], { stroke: (c, ps) => { for (const q of ps) { const s = segPts(q); pts.push(...s); for (let i = 0; i + 1 < s.length; i++) segs.push([s[i], s[i + 1]]); } }, fill: (c, loops) => { for (const l of loops) for (let i = 0; i + 1 < l.length; i += 2) pts.push({ x: l[i], y: l[i + 1] }); }, text: (c, te) => pts.push({ x: te.x, y: te.y }), point: (c, x, y) => pts.push({ x, y }) });
      if (!pts.length) continue;
      const inside = pts.map((p) => pointInPoly(p, poly));
      const take = crossing ? inside.some(Boolean) || segs.some(([p, q]) => crossesPoly(p, q, poly)) : inside.every(Boolean);
      if (take) ids.push(e.id);
    }
    for (const id of ids) { if (b.shift) w.set.delete(id); else w.set.add(id); }
    this.host.setSelection(w.set);
    this.host.print(t('ws3d.window.found', { n: ids.length }));
    if (w.opts.single && w.set.size) E.resolve(w.set);
    this.invalidate();
  }
  pick2d(ev) {
    const g = this.groundAt(ev, 0);
    if (!g) return null;
    const k = this.k;
    const tol = (this.cam.pixelSize([g.x * k, g.y * k, 0]) * 6) / k;
    let best = null, bestD = tol, inside = null, insideA = Infinity;
    for (const e of this.doc.model.values()) {
      if (!this.doc.editable(e)) continue;
      const d = distToEntity(e, g, this.doc.blocks);
      if (d <= bestD) { bestD = d; best = e.id; }
      if (!best && (e.type === 'poly' || e.type === 'circle' || e.type === 'ellipse')) {
        const o = outline2d(e);
        if (o.pts && o.area < insideA && pointInPoly(g, o.pts.map(([x, y]) => ({ x, y })))) { inside = e.id; insideA = o.area; }
      }
    }
    return best || inside;
  }

  // ---- overlay lines (meters) ----
  entityLines(out, e, z, kind, dash = false) {
    const k = this.k, Z = z * k;
    walk(this.doc, [e], {
      stroke: (c, ps) => { for (const p of ps) segsOf(p, (x1, y1, x2, y2) => out.push({ a: [x1 * k, y1 * k, Z], b: [x2 * k, y2 * k, Z], kind, dash })); },
      fill: (c, loops) => { for (const l of loops) for (let i = 0; i + 1 < l.length; i += 2) { const j = (i + 2) % l.length; out.push({ a: [l[i] * k, l[i + 1] * k, Z], b: [l[j] * k, l[j + 1] * k, Z], kind, dash }); } },
      text: () => {}, point: () => {},
    });
  }
  prismLines(out, rings, z0, h) {
    const k = this.k;
    for (const r of rings || []) {
      for (let i = 0; i < r.length; i++) {
        const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
        out.push({ a: [x1 * k, y1 * k, z0 * k], b: [x2 * k, y2 * k, z0 * k], kind: 'face' });
        out.push({ a: [x1 * k, y1 * k, (z0 + h) * k], b: [x2 * k, y2 * k, (z0 + h) * k], kind: 'face' });
        if (r.length <= 8 || i % Math.ceil(r.length / 8) === 0) out.push({ a: [x1 * k, y1 * k, z0 * k], b: [x1 * k, y1 * k, (z0 + h) * k], kind: 'axis-z', dash: true });
      }
    }
  }
  /** The 2D selection and the hovered object, drawn over the 3D view (meters). */
  selectionLines() {
    const out = [];
    for (const id of this.host.selection || []) { const e = this.doc.get(id); if (e && this.doc.inModel) this.entityLines(out, e, 0, 'face'); }
    if (this.hover2d && !(this.host.selection || new Set()).has(this.hover2d)) { const e = this.doc.model.get(this.hover2d); if (e) this.entityLines(out, e, 0, 'edge', true); }
    return out;
  }

  /**
   * The 2D model-space drawing as line batches by colour (meters, z = 0): {batches: Map(color → Float64Array),
   * bbox}. Layers that are off or frozen are left out; blocks and dimensions come expanded; text is left out.
   */
  lines() {
    const key = this.doc.version + '|' + this.k;
    if (this.linesFor === key && this.linesCache) return this.linesCache;
    const k = this.k, by = new Map();
    let bb = null;
    const put = (c, x1, y1, x2, y2) => {
      let a = by.get(c); if (!a) by.set(c, (a = []));
      a.push(x1 * k, y1 * k, x2 * k, y2 * k);
    };
    walk(this.doc, [...this.doc.model.values()], {
      stroke: (c, ps) => { for (const p of ps) segsOf(p, (x1, y1, x2, y2) => put(c, x1, y1, x2, y2)); },
      fill: (c, loops) => { for (const l of loops) for (let i = 0; i + 1 < l.length; i += 2) { const j = (i + 2) % l.length; put(c, l[i], l[i + 1], l[j], l[j + 1]); } },
      text: () => {}, point: () => {},
    });
    for (const a of by.values()) for (let i = 0; i < a.length; i += 2) bb = bboxAdd(bb, [a[i], a[i + 1], 0]);
    this.linesCache = { batches: by, bbox: bb };
    this.linesFor = key;
    return this.linesCache;
  }
  /** Everything there is to see: the solids and the drawing. */
  bbox() {
    let bb = this.model.bbox();
    const l = this.lines().bbox;
    if (l) { bb = bboxAdd(bb, l.min); bb = bboxAdd(bb, l.max); }
    const c = this.cloudBox?.();   // a point cloud (0.5 SG.1, ws3d.js)
    if (c) { bb = bboxAdd(bb, c.min); bb = bboxAdd(bb, c.max); }
    return bb;
  }
  /**
   * Look at everything from the current direction (or `dir`). Like Camera.fit, without its half-meter floor: a drawing in
   * millimeters may be a few centimeters across.
   */
  fit(dir = null) {
    const cam = this.cam, bb = this.bbox() || { min: [-5, -5, 0], max: [5, 5, 3] };
    const d = norm(dir || sub(cam.eye, cam.target));
    const c = mul(add(bb.min, bb.max), 0.5), r = Math.max(dist(bb.min, bb.max) / 2, 1e-3);
    const fovMin = (Math.min(cam.fov, cam.fov * cam.aspect) * Math.PI) / 360;
    cam.target = c;
    cam.eye = add(c, mul(d, (r / Math.sin(fovMin)) * 1.08));
    cam.clip(r);
    this.invalidate();
  }
  view(name) {
    if (name === 'persp' || name === 'parallel') { this.cam.persp = name === 'persp'; this.invalidate(); return; }
    if (name === 'extents') { this.fit(); return; }
    this.fit(VIEWS[VIEW_NAMES.includes(name) ? name : 'iso']);
  }
  setStyle(key) {
    if (!STYLES[key]) return false;
    this.styleKey = key;
    this.style = { ...STYLES[key] };
    this.onStyle?.(key);
    this.invalidate();
    return true;
  }

  // ---- driving ModelCraft's tools for a command ----
  begin(tool, { copy = false } = {}) {
    this.driving = { tool, copy };
    this.done = false; this.recorded = false;
    this.tools.set(tool);
  }
  end() {
    if (this.tools.tool.busy) this.tools.escape();
    this.driving = null;
    if (this.openedForPush) { this.th.path = []; this.th.sel = []; this.openedForPush = false; }
    this.tools.set('select');
    this.th.overlayState = null;
    this.done = false; this.recorded = false;
    this.changed();
  }
  /** A value typed at the command line while a tool runs. Lengths read in drawing units; ROTATE reads degrees. */
  value(text, { angle = false } = {}) {
    const T = this.tools, t = T.tool, units = this.doc.meta.units;
    let s = String(text).trim();
    // AutoCAD-style displacements: "@dx,dy[,dz]" or "dx,dy,dz" → ModelCraft's <dx,dy,dz>
    const m = /^@?\s*([-+.\d]+)\s*,\s*([-+.\d]+)\s*(?:,\s*([-+.\d]+))?$/.exec(s);
    if (m && T.name === 'move' && (s.startsWith('@') || m[3] !== undefined)) s = '<' + m[1] + ',' + m[2] + ',' + (m[3] ?? '0') + '>';
    const ev = this.lastEv || { x: this.cam.w / 2, y: this.cam.h / 2 };
    if (T.name === 'move' && !t.p0 && /^[<[]/.test(s)) {
      const c = T.selCenter();
      if (!c) { this.host.print(t('ws3d-core.select_what_move_first')); return false; }
      t.begin(c, !!this.driving?.copy);
    }
    if (T.name === 'rotate' && angle && t.stage < 2) {
      const c = t.stage === 1 ? t.c : T.selCenter();
      if (!c) { this.host.print(t('ws3d-core.select_what_rotate_first')); return false; }
      t.startAt(c, ev);
    }
    const ok = T.value(angle ? s : convertLengths(s, units));
    if (ok) this.check();
    return ok;
  }

  // ---- selection ----
  selectAll() {
    const def = this.model.context(this.th.path).def;
    this.th.setSel([...[...def.insts.keys()].map((id) => ({ t: 'i', id })), ...[...def.faces.keys()].map((id) => ({ t: 'f', id })), ...[...def.edges].filter(([, e]) => !e.soft).map(([id]) => ({ t: 'e', id }))]);
    return this.th.sel.length;
  }
  clearSel() { const had = this.th.sel.length; this.th.setSel([]); return had; }
  eraseSel() {
    const sel = this.th.sel.filter((s) => s.t !== 'g');
    const guides = this.th.sel.filter((s) => s.t === 'g');
    if (!sel.length && !guides.length) return 0;
    this.model.change('Erase', (m) => {
      eraseSel(m.context(this.th.path).def, sel);
      for (const g of guides) m.guides.delete(g.id);
      m.purge();
    });
    const n = sel.length + guides.length;
    this.th.setSel([]);
    return n;
  }
}

/** Points of a geom.js primitive as segments (arcs 48 to a turn). */
function segsOf(p, put) {
  if (p.k === 'L') { put(p.x1, p.y1, p.x2, p.y2); return; }
  if (p.k !== 'A') return;
  const sweep = p.a1 - p.a0, n = Math.max(2, Math.ceil(Math.abs(sweep) / (TAU / 48)));
  let px = p.cx + p.r * Math.cos(p.a0), py = p.cy + p.r * Math.sin(p.a0);
  for (let i = 1; i <= n; i++) {
    const a = p.a0 + (sweep * i) / n, x = p.cx + p.r * Math.cos(a), y = p.cy + p.r * Math.sin(a);
    put(px, py, x, y); px = x; py = y;
  }
}
/** Bare numbers in a typed value (also inside <…>, […] and lists) are drawing units: say so for ModelCraft's parser. */
function convertLengths(s, units) {
  const b = /^([[<])(.*)([\]>])$/.exec(s);
  if (b) return b[1] + b[2].split(/[,;]/).map((x) => withUnit(x, units)).join(',') + b[3];
  if (/[,;]/.test(s)) return s.split(/[,;]/).map((x) => withUnit(x, units)).join(',');
  return withUnit(s, units);
}
const fmtNum = (n) => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(4)).toString());
