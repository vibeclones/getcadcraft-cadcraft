/* SPDX-License-Identifier: Apache-2.0 */
/**
 * view.js — draws a Doc on two stacked canvases: `base` (the drawing, cached as one Path2D per
 * colour × lineweight and rebuilt only when the drawing changes) and `over` (crosshair, snap marker, rubber
 * band, selection, grips, selection window — redrawn on every pointer move).
 *
 *   const v = new View(baseCanvas, overCanvas, doc);
 *   v.fit();  v.zoomAt(sx, sy, 1.2);  v.panBy(dx, dy);  v.toWorld(sx, sy);  v.toScreen(x, y)
 *   v.pick(world, px) → id | null    v.pickAll(world, px) → [ids] nearest first    v.pickWindow(rect, crossing) → [ids]
 *   v.snap(world, { kinds, base }) → { x, y, kind } | null
 *   v.state = { cursor, snap, preview[], selection:Set, hover, grips[], hotGrip, box, lasso: { pts, mode }, crosshair, track: { rays, acquired, label } }
 *   (preview entities with `ghost: true` draw greyed and dashed: what TRIM / EXTEND will remove or add)
 *
 * In a layout the coordinates are paper units: the sheet is drawn on a desk tone, each viewport
 * shows the model (its cached paths, re-used through a transform and a clip), and the layout's
 * own entities go on top. Each space keeps its own zoom and pan.
 *
 * `v.lwDisplay` (status bar LWT, LWDISPLAY; off by default) draws lineweights by lwdisplay.js `lwPixels`: screen
 * weights in the model, true paper widths on a sheet (viewports included); off, every line is 1 px.
 *
 * Colours follow the page theme (html[data-space] paper/model): ACI 7 is the ink colour, pale
 * colours are darkened on paper and dark ones lightened on a dark screen so every layer reads.
 */

import {
  entityBounds, validBounds, emptyBounds, growPt, distToEntity, inWindow, snapPoints, prims,
  textLayout, ellipsePoints, intersect, grips as entityGrips, viewportCorners, viewportMatrix, dimParts, FONT_EM, TAU,
} from './geom.js';
import { walk } from './walk.js';
import { leaderGeometry } from './leader.js';
import { lwPixels } from './lwdisplay.js';
import { paneRects, paneAt, paneCount, clampSplit } from './panes.js';

const SNAP_PRIORITY = { end: 0, int: 0, mid: 1, cen: 1, quad: 2, node: 0, ins: 1, perp: 2, near: 9 };
/** Cursor sizes (Settings → Cursor): crosshair arm, pick box side and pick tolerance, in screen px. */
export const CURSOR_SIZES = { small: { arm: 20, box: 7, pick: 5 }, medium: { arm: 40, box: 9, pick: 6 }, large: { arm: 90, box: 13, pick: 8 } };
/** Drawing text: a Helvetica-metric face, the same one plotted PDFs use. */
export const DRAWING_FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';

export class View {
  constructor(base, over, doc) {
    this.base = base; this.over = over; this.doc = doc;
    this.bctx = base.getContext('2d'); this.octx = over.getContext('2d');
    this.cx = 0; this.cy = 0; this.zoom = 1;
    this.w = 1; this.h = 1; this.dpr = 1;
    // split screen (panes.js): the canvases are W × H; the active pane is the w × h rectangle at x0, y0, and every
    // coordinate the view hands out (toScreen, toWorld, T) is local to it. panes = null (one pane) or
    // { layout, fx, fy, active, list: [{ space, cx, cy, zoom, rect, doc? }] }
    this.W = 1; this.H = 1; this.x0 = 0; this.y0 = 0;
    this.panes = null; this.hoverPane = 0;
    this.paneShots = new WeakMap();   // pane → { canvas, key, doc, space }: its last picture while it is not active
    this.paneDoc = (p) => p.doc || this.doc;   // the drawing a pane shows (Q.3: cadcraft.js may hand another open one)
    this.caches = new WeakMap();  // entity Map → { version, origin, paths, fills, texts, points, viewports, bounds }
    this.views = new WeakMap();   // entity Map → { cx, cy, zoom } (each space keeps its own view)
    this.grid = true;
    this.lwDisplay = false;       // status bar LWT / LWDISPLAY (cadcraft.js)
    this.cursorSize = 'medium';   // CURSOR_SIZES key (cadcraft.js, from Settings)
    this.state = { cursor: null, snap: null, preview: [], selection: new Set(), hover: null, grips: [], hotGrip: null, box: null, crosshair: true };
    this.raf = 0; this.dirtyBase = true;
    this.shownSpace = doc.space;
    this.theme();
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => { this.theme(); this.invalidate(true); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-space'] });
    }
    new ResizeObserver(() => this.resize()).observe(base.parentElement);
    doc.on((kind) => { if (kind === 'space' || kind === 'load') this.spaceChanged(kind === 'load'); this.invalidate(true); });
    this.resize();
  }

  theme() {
    const cs = getComputedStyle(document.documentElement);
    const t = (n, d) => cs.getPropertyValue(n).trim() || d;
    this.colors = {
      bg: t('--sheet', '#f3f6f8'), ink: t('--ink', '#17202b'), ink2: t('--ink-2', '#34404e'), grid: t('--grid', '#d5dde5'),
      action: t('--action', '#1e48c8'), snap: t('--layer-orange', '#a84a00'), cross: t('--layer-green', '#17703a'),
      font: t('--font', 'system-ui, sans-serif'),
    };
    this.dark = luminance(this.colors.bg) < 0.4;
    this.colors.desk = mix(this.colors.bg, this.colors.ink, this.dark ? 0.12 : 0.1);
    this.colorCache = new Map();
    this.caches = new WeakMap();
  }

  /** A layer colour made readable on the current background. */
  ink(c) {
    if (c === 'ink') return this.colors.ink;
    let v = this.colorCache.get(c);
    if (v) return v;
    const L = luminance(c);
    v = !this.dark && L > 0.55 ? mix(c, '#000000', Math.min(0.55, (L - 0.4))) : this.dark && L < 0.12 ? mix(c, '#ffffff', 0.45) : c;
    this.colorCache.set(c, v);
    return v;
  }

  resize() {
    const r = this.base.parentElement.getBoundingClientRect();
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.base, this.over]) { c.width = Math.round(this.W * this.dpr); c.height = Math.round(this.H * this.dpr); }
    this.layoutPanes();
    this.invalidate(true);
  }

  /** The open space changed: keep the old view, restore (or fit) the new one. */
  spaceChanged(loaded) {
    if (this.switching) { this.shownSpace = this.doc.space; return; }   // activating a pane sets its own view
    if (this.panes) {
      if (loaded) { for (const p of this.panes.list) { p.space = this.doc.model; p.doc = null; } }
      else this.panes.list[this.panes.active].space = this.doc.space;
    }
    if (!loaded && this.shownSpace) this.views.set(this.shownSpace, { cx: this.cx, cy: this.cy, zoom: this.zoom });
    this.shownSpace = this.doc.space;
    const v = !loaded && this.views.get(this.doc.space);
    if (v) Object.assign(this, v); else if (loaded && this.panes) this.fitPanes(); else this.fit();
  }

  // ---- split screen (panes.js) ----
  /** Split into a layout ('single' | '2v' | '2h' | '3r' | '3l' | '4'): every new pane starts on the active pane's view. */
  setPanes(layout, { fx = 0.5, fy = 0.5, list = null, active = 0 } = {}) {
    const n = paneCount(layout);
    if (n < 2) {
      if (!this.panes) return;
      this.syncPane();
      const keep = this.panes.list[this.panes.active];
      this.panes = null;
      this.loadPane(keep);
      this.layoutPanes();
      this.invalidate(true);
      return;
    }
    this.syncPane();
    const cur = this.panes ? this.panes.list[this.panes.active] : { space: this.doc.space, cx: this.cx, cy: this.cy, zoom: this.zoom, doc: null };
    const old = this.panes ? this.panes.list : [];
    const panes = [];
    for (let i = 0; i < n; i++) panes.push({ ...(list?.[i] || old[i] || cur), rect: null });
    this.panes = { layout, fx: clampSplit(fx), fy: clampSplit(fy), active: Math.min(Math.max(0, active | 0), n - 1), list: panes };
    this.loadPane(panes[this.panes.active]);
    this.layoutPanes();
    this.invalidate(true);
  }
  /**
   * Linked views (Q.5, LINKVIEWS): every pane showing the same kind of space as the active one (the model, or a sheet)
   * takes its centre and zoom, so pan and zoom move together — two revisions tiled side by side stay lined up.
   */
  setLinked(on) {
    this.linked = !!on;
    this.invalidate(true);
  }
  followLinked() {
    if (!this.linked || !this.panes) return;
    const act = this.panes.list[this.panes.active];
    const isModel = (p) => p.space === this.paneDoc(p).model;
    for (const p of this.panes.list) if (p !== act && isModel(p) === isModel(act)) { p.cx = act.cx; p.cy = act.cy; p.zoom = act.zoom; }
  }
  /** Move a divider ('fx' | 'fy', 0–1). */
  setSplit(key, f) {
    if (!this.panes) return;
    this.syncPane();
    this.panes[key] = clampSplit(f);
    this.layoutPanes();
    this.invalidate(true);
  }
  /** The pane rectangles for the canvases' size; the active pane's rectangle becomes x0, y0, w, h (centre and zoom kept). */
  layoutPanes() {
    if (!this.panes) { this.x0 = 0; this.y0 = 0; this.w = this.W; this.h = this.H; this.onPanes?.(); return; }
    const rects = paneRects(this.panes.layout, this.panes.fx, this.panes.fy, this.W, this.H);
    this.panes.list.forEach((p, i) => { p.rect = rects[i]; });
    const r = rects[this.panes.active];
    this.x0 = r.x; this.y0 = r.y; this.w = r.w; this.h = r.h;
    this.onPanes?.();   // cadcraft.js: the dividers follow
  }
  /** The active pane's live view back into its record. */
  syncPane() {
    if (!this.panes) return;
    const p = this.panes.list[this.panes.active];
    p.cx = this.cx; p.cy = this.cy; p.zoom = this.zoom; p.space = this.doc.space;
  }
  loadPane(p) {
    this.cx = p.cx; this.cy = p.cy; this.zoom = p.zoom;
    if (p.rect) { this.x0 = p.rect.x; this.y0 = p.rect.y; this.w = p.rect.w; this.h = p.rect.h; }
  }
  /** The pane under a point of the canvases (CSS px from their top left), or -1. */
  paneAt(x, y) { return this.panes ? paneAt(this.panes.list.map((p) => p.rect), x, y) : 0; }
  /** Make pane i the active one: its view, and its space opens (doc.setSpace). Returns false when it already was. */
  activatePane(i, { sync = true } = {}) {
    if (!this.panes || i === this.panes.active || !this.panes.list[i]) return false;
    if (sync) this.syncPane();   // (not after doctabs.js swapped the drawing: it synced before)
    this.panes.active = i;
    const p = this.panes.list[i];
    this.loadPane(p);
    const lay = this.doc.layouts.find((l) => l.entities === p.space) || null;
    if (!lay && p.space !== this.doc.model) p.space = this.doc.model;   // its sheet was deleted
    this.switching = true;
    try { this.doc.setSpace(lay); } finally { this.switching = false; }
    this.invalidate(true);
    return true;
  }
  /** Fit pane p to its own drawing (tiling several open drawings, Q.3). */
  fitPaneTo(p) {
    const keep = { cx: this.cx, cy: this.cy, zoom: this.zoom, w: this.w, h: this.h, doc: this.doc };
    this.doc = this.paneDoc(p); this.w = p.rect.w; this.h = p.rect.h;
    try { this.fit(); p.cx = this.cx; p.cy = this.cy; p.zoom = this.zoom; } finally { Object.assign(this, keep); }
    if (p === this.panes?.list[this.panes.active]) this.loadPane(p);
  }
  /** doctabs.js is about to trade the drawing in this.doc for another: remember this one's view. */
  beforeSwap() {
    this.syncPane();
    this.views.set(this.doc.space, { cx: this.cx, cy: this.cy, zoom: this.zoom });
    this.switching = true;
  }
  /** … and has: show the new drawing as it was last seen (or whole), unless a pane brings its own view (`keepView`). */
  afterSwap({ keepView = false } = {}) {
    this.switching = false;
    this.shownSpace = this.doc.space;
    if (!keepView) {
      const v = this.views.get(this.doc.space);
      if (v) Object.assign(this, v); else this.fit();
      if (this.panes) Object.assign(this.panes.list[this.panes.active], { cx: this.cx, cy: this.cy, zoom: this.zoom, space: this.doc.space });
    }
    this.invalidate(true);
  }

  /** Draw `fn` into pane p: its rectangle clipped, its view and drawing in place, then everything put back. */
  inPane(ctx, p, fn) {
    const keep = { cx: this.cx, cy: this.cy, zoom: this.zoom, x0: this.x0, y0: this.y0, w: this.w, h: this.h, doc: this.doc };
    const active = p === this.panes.list[this.panes.active];
    if (!active) { this.cx = p.cx; this.cy = p.cy; this.zoom = p.zoom; this.doc = this.paneDoc(p); }
    this.x0 = p.rect.x; this.y0 = p.rect.y; this.w = p.rect.w; this.h = p.rect.h;
    const d = this.dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath(); ctx.rect(Math.round(d * p.rect.x), Math.round(d * p.rect.y), Math.round(d * p.rect.w), Math.round(d * p.rect.h)); ctx.clip();
    try { fn(); } finally { ctx.restore(); Object.assign(this, keep); }
  }
  /** What the panes show, for saving (the file's VPORT table): view heights instead of zooms, sheets by name. */
  paneState() {
    if (!this.panes) return null;
    this.syncPane();
    return {
      layout: this.panes.layout, fx: this.panes.fx, fy: this.panes.fy, active: this.panes.active,
      list: this.panes.list.map((p) => {
        const lay = this.doc.layouts.find((l) => l.entities === p.space);
        return { cx: p.cx, cy: p.cy, h: (p.rect?.h || this.h) / p.zoom, ...(lay ? { sheet: lay.name } : {}) };
      }),
    };
  }
  /** Back from paneState (or a file's, through panes.cleanPanes): missing panes copy the view on screen. */
  restorePanes(st) {
    if (!st) { this.setPanes('single'); return; }
    const n = paneCount(st.layout);
    const rects = paneRects(st.layout, st.fx, st.fy, this.W, this.H);
    const list = [];
    for (let i = 0; i < n; i++) {
      const q = st.list[i];
      const lay = q?.sheet ? this.doc.layouts.find((l) => l.name === q.sheet) : null;
      list.push(q ? { space: lay ? lay.entities : this.doc.model, cx: q.cx, cy: q.cy, zoom: rects[i].h / q.h, doc: null } : { space: this.doc.model, cx: this.cx, cy: this.cy, zoom: this.zoom, doc: null });
    }
    this.panes = null;   // replaced whole: nothing of the old panes to keep
    this.setPanes(st.layout, { fx: st.fx, fy: st.fy, list, active: st.active });
    const lay = this.doc.layouts.find((l) => l.entities === this.panes.list[this.panes.active].space) || null;
    this.switching = true;
    try { this.doc.setSpace(lay); } finally { this.switching = false; }
  }

  // ---- coordinates ----
  toScreen(x, y) { return { x: (x - this.cx) * this.zoom + this.w / 2, y: this.h / 2 - (y - this.cy) * this.zoom }; }
  toWorld(sx, sy) { return { x: (sx - this.w / 2) / this.zoom + this.cx, y: (this.h / 2 - sy) / this.zoom + this.cy }; }
  get pixel() { return 1 / this.zoom; }
  /** World (or paper) → CSS pixels as an affine [a, b, c, d, e, f]. */
  get T() { return [this.zoom, 0, 0, -this.zoom, this.w / 2 - this.cx * this.zoom, this.h / 2 + this.cy * this.zoom]; }

  zoomAt(sx, sy, f) {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(1e9, Math.max(1e-9, this.zoom * f));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x; this.cy += before.y - after.y;
    this.invalidate(true);
  }
  panBy(dx, dy) { this.cx -= dx / this.zoom; this.cy += dy / this.zoom; this.invalidate(true); }

  extents() {
    const b = emptyBounds();
    const bounds = this.ensureCache().bounds;
    for (const e of this.doc.entities.values()) {
      if (!this.doc.visible(e)) continue;
      const eb = bounds.get(e.id);
      if (eb && validBounds(eb)) { growPt(b, eb.minX, eb.minY); growPt(b, eb.maxX, eb.maxY); }
    }
    const lay = this.doc.layout;
    if (lay) { const p = lay.paper; growPt(b, p.x0, p.y0); growPt(b, p.x0 + p.w, p.y0 + p.h); }
    return b;
  }
  fit(b = this.extents(), margin = 0.9) {
    if (!validBounds(b)) { this.cx = 0; this.cy = 0; this.zoom = Math.min(this.w, this.h) / 120; this.invalidate(true); return; }
    const bw = Math.max(b.maxX - b.minX, 1e-6), bh = Math.max(b.maxY - b.minY, 1e-6);
    this.cx = (b.minX + b.maxX) / 2; this.cy = (b.minY + b.maxY) / 2;
    this.zoom = Math.min(this.w / bw, this.h / bh) * margin;
    this.invalidate(true);
  }
  /** Every pane to the whole drawing (after opening a file in split screen). */
  fitPanes() {
    if (!this.panes) { this.fit(); return; }
    this.syncPane();
    const b = this.extents(), keep = { w: this.w, h: this.h };
    for (const p of this.panes.list) {
      this.w = p.rect.w; this.h = p.rect.h;
      this.fit(b);
      p.cx = this.cx; p.cy = this.cy; p.zoom = this.zoom;
    }
    Object.assign(this, keep);
    this.loadPane(this.panes.list[this.panes.active]);
    this.invalidate(true);
  }
  /** The view as it is (for zoom previous), and back. */
  snapshot() { return { cx: this.cx, cy: this.cy, zoom: this.zoom }; }
  restore(s) { this.cx = s.cx; this.cy = s.cy; this.zoom = s.zoom; this.invalidate(true); }
  /** What is on screen, in world units: center, width, height. */
  viewRect() { return { cx: this.cx, cy: this.cy, w: this.w / this.zoom, h: this.h / this.zoom }; }

  // ---- picking ----
  boundsOf(e) { return this.ensureCache().bounds.get(e.id) || entityBounds(e, this.doc.blocks); }

  /** Crosshair arm and pick box (screen px) for the cursor size setting; the pick tolerance follows the box. */
  cursorSpec() {
    const c = CURSOR_SIZES[this.cursorSize] || CURSOR_SIZES.medium;
    return this.coarse ? { ...c, pick: Math.max(c.pick, 12), box: Math.max(c.box, 13) } : c;   // a finger (S.8): a bigger pick box
  }

  pick(p, px = this.cursorSpec().pick) {
    const tol = px / this.zoom;
    let best = null, bd = tol;
    const bounds = this.ensureCache().bounds;
    for (const e of this.doc.entities.values()) {
      if (!this.doc.editable(e)) continue;
      const b = bounds.get(e.id);
      if (!b || p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue;
      const d = distToEntity(e, p, this.doc.blocks);
      if (d <= bd) { bd = d; best = e.id; }
    }
    return best;
  }
  /** Every editable object within the pick box of p, nearest first (Tab cycles through them). */
  pickAll(p, px = this.cursorSpec().pick) {
    const tol = px / this.zoom, hits = [];
    const bounds = this.ensureCache().bounds;
    for (const e of this.doc.entities.values()) {
      if (!this.doc.editable(e)) continue;
      const b = bounds.get(e.id);
      if (!b || p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue;
      const d = distToEntity(e, p, this.doc.blocks);
      if (d <= tol) hits.push([d, e.id]);
    }
    return hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
  }

  pickWindow(w, crossing) {
    const out = [];
    const bounds = this.ensureCache().bounds;
    for (const e of this.doc.entities.values()) {
      if (!this.doc.editable(e)) continue;
      const b = bounds.get(e.id);
      if (!b || b.maxX < w.minX || b.minX > w.maxX || b.maxY < w.minY || b.minY > w.maxY) continue;
      if (inWindow(e, w, crossing, this.doc.blocks)) out.push(e.id);
    }
    return out;
  }

  /** The best object snap within the aperture (px) of p. */
  snap(p, { kinds, base = null, px = 10 }) {
    if (!kinds || !kinds.size) return null;
    const r = px / this.zoom;
    const bounds = this.ensureCache().bounds;
    const nearby = [];
    for (const e of this.doc.entities.values()) {
      if (!this.doc.visible(e)) continue;
      const b = bounds.get(e.id);
      if (!b || p.x < b.minX - r || p.x > b.maxX + r || p.y < b.minY - r || p.y > b.maxY + r) continue;
      nearby.push(e);
      if (nearby.length > 400) break;
    }
    let best = null;
    const consider = (c) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d > r) return;
      const pr = SNAP_PRIORITY[c.kind] ?? 5;
      if (!best || pr < best.pr || (pr === best.pr && d < best.d)) best = { ...c, d, pr };
    };
    for (const e of nearby) for (const c of snapPoints(e, p, r, kinds, this.doc.blocks, base)) consider(c);
    if (kinds.has('int') && nearby.length > 1) {
      const ps = nearby.slice(0, 60).map((e) => prims(e, this.doc.blocks).filter((q) => !q.box && nearPrim(q, p, r)));
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        for (const a of ps[i]) for (const b of ps[j]) for (const x of intersect(a, b)) consider({ kind: 'int', x: x.x, y: x.y });
      }
    }
    return best;
  }

  // ---- rendering ----
  invalidate(base = false) {
    if (base) this.dirtyBase = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  /** CSS px per paper mm on the open sheet (viewports included), 0 in the model. */
  paperPxPerMm() {
    const lay = this.spaceLayout !== undefined ? this.spaceLayout : this.doc.layout;   // the space being drawn (split screen)
    if (!lay) return 0;
    return Math.hypot(this.T[0], this.T[1]) / (lay.paper?.unit === 'in' ? 25.4 : 1);
  }

  /** The cache of the open space. */
  ensureCache() { return this.cacheOf(this.doc.space); }

  cacheOf(map) {
    const v = this.doc.version;
    const hit = this.caches.get(map);
    if (hit && hit.version === v) return hit;
    const t0 = performance.now();
    const paths = new Map(), fills = new Map(), texts = [], points = [], viewports = [], bounds = new Map();
    const ext = emptyBounds();
    for (const e of map.values()) {
      const b = entityBounds(e, this.doc.blocks);
      bounds.set(e.id, b);
      if (validBounds(b) && this.doc.visible(e)) { growPt(ext, b.minX, b.minY); growPt(ext, b.maxX, b.maxY); }
    }
    const origin = validBounds(ext) ? { x: (ext.minX + ext.maxX) / 2, y: (ext.minY + ext.maxY) / 2 } : { x: 0, y: 0 };
    // one Path2D per colour × lineweight (mm; below 0 = default) × alpha, drawn 1 px wide unless lineweights are shown.
    // walk.js may pass a 4th argument { alpha (0–1: transparency), wipe (a fill in the background colour) } (P.5, P.6)
    const alphaOf = (o) => (o && Number.isFinite(o.alpha) ? Math.max(0, Math.min(1, o.alpha)) : 1);
    const pathFor = (c, lw = -3, o = null) => {
      const w = Number.isFinite(lw) && lw >= 0 ? lw : -3, a = alphaOf(o), k = c + '|' + w + '|' + a;
      let p = paths.get(k); if (!p) { p = { path: new Path2D(), color: c, lw: w, alpha: a }; paths.set(k, p); } return p.path;
    };
    const fillFor = (c, solid, o = null) => {
      const a = alphaOf(o), wipe = !!o?.wipe, k = c + (solid ? '' : '~') + '|' + a + (wipe ? '|w' : '');
      let p = fills.get(k); if (!p) { p = { path: new Path2D(), color: c, solid, alpha: a, wipe }; fills.set(k, p); } return p;
    };
    const ring = (path, l) => { path.moveTo(l[0] - origin.x, l[1] - origin.y); for (let i = 2; i + 1 < l.length; i += 2) path.lineTo(l[i] - origin.x, l[i + 1] - origin.y); };
    walk(this.doc, map.values(), {
      stroke(color, ps, lw, o) {
        const p = pathFor(color, lw, o);
        let lx = Infinity, ly = Infinity;   // (NaN would fail every comparison and skip the first moveTo)
        for (const q of ps) {
          if (q.k === 'L') {
            if (Math.abs(q.x1 - lx) > 1e-12 || Math.abs(q.y1 - ly) > 1e-12) p.moveTo(q.x1 - origin.x, q.y1 - origin.y);
            p.lineTo(q.x2 - origin.x, q.y2 - origin.y); lx = q.x2; ly = q.y2;
          } else {
            const sx = q.cx + q.r * Math.cos(q.rev ? q.a1 : q.a0), sy = q.cy + q.r * Math.sin(q.rev ? q.a1 : q.a0);
            if (Math.abs(sx - lx) > 1e-9 || Math.abs(sy - ly) > 1e-9) p.moveTo(sx - origin.x, sy - origin.y);
            if (q.rev) p.arc(q.cx - origin.x, q.cy - origin.y, q.r, q.a1, q.a0, true);
            else p.arc(q.cx - origin.x, q.cy - origin.y, q.r, q.a0, q.a1, false);
            const ea = q.rev ? q.a0 : q.a1;
            lx = q.cx + q.r * Math.cos(ea); ly = q.cy + q.r * Math.sin(ea);
          }
        }
      },
      fill(color, loops, solid, o) {
        const f = fillFor(color, solid, o);
        for (const l of loops) { ring(f.path, l); f.path.closePath(); }
        if (!solid) { const p = pathFor(color, -3, o); for (const l of loops) ring(p, l); }   // patterned: tone plus outline
      },
      text(color, e, o) { texts.push({ e, color, alpha: alphaOf(o) }); },
      point(color, x, y) { points.push({ x, y, color }); },
      viewport(e) { viewports.push(e); },
    });
    const cache = { version: v, origin, paths: [...paths.values()], fills: [...fills.values()], texts, points, viewports, bounds, ms: performance.now() - t0 };
    this.caches.set(map, cache);
    return cache;
  }

  render() {
    if (this.dirtyBase) { this.renderBase(); this.dirtyBase = false; }
    this.renderOver();
  }

  renderBase() {
    const ctx = this.bctx;
    if (!this.panes) { this.renderSpace(ctx, this.doc.space); return; }
    // split screen: the gaps between panes in the desk tone, then every pane in its own clip
    this.syncPane();
    this.followLinked();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colors.desk;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    // a pane that is not active and has not changed is copied back from its last picture (Q.2: panning one pane on the
    // biggest drawing redraws one pane, not four)
    const act = this.panes.list[this.panes.active], d = this.dpr;
    for (const p of this.panes.list) {
      const r = p.rect, sx = Math.round(d * r.x), sy = Math.round(d * r.y), sw = Math.max(1, Math.round(d * r.w)), sh = Math.max(1, Math.round(d * r.h));
      const key = p === act ? null : [this.paneDoc(p).version, p.cx, p.cy, p.zoom, sx, sy, sw, sh, this.grid, this.lwDisplay, this.ucs, this.colors.bg, this.colors.ink].join('|');
      const shot = this.paneShots.get(p);
      if (key && shot && shot.key === key && this.paneDoc(p) === shot.doc && p.space === shot.space) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(shot.canvas, sx, sy);
        continue;
      }
      this.inPane(ctx, p, () => this.renderSpace(ctx, p.space));
      if (key && typeof document !== 'undefined') {
        const c = shot?.canvas || document.createElement('canvas');
        if (c.width !== sw || c.height !== sh) { c.width = sw; c.height = sh; }
        const cc = c.getContext('2d');
        cc.clearRect(0, 0, sw, sh);
        cc.drawImage(this.base, sx, sy, sw, sh, 0, 0, sw, sh);
        this.paneShots.set(p, { canvas: c, key, doc: this.paneDoc(p), space: p.space });
      }
    }
  }

  /** Fill the active pane (device pixels). */
  fillPane(ctx, color) {
    const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(d * this.x0), Math.floor(d * this.y0), Math.ceil(d * this.w) + 1, Math.ceil(d * this.h) + 1);
  }

  /** One space (the model or a sheet's entities) into the active pane. */
  renderSpace(ctx, space) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const lay = this.doc.layouts.find((l) => l.entities === space) || null;
    this.spaceLayout = lay;
    try { this.drawSpace(ctx, space, lay); } finally { this.spaceLayout = undefined; }
  }
  drawSpace(ctx, space, lay) {
    if (!lay) {
      this.fillPane(ctx, this.colors.bg);
      if (this.grid) this.drawGrid(ctx);
      this.drawCache(ctx, this.cacheOf(space), this.T);
      if (this.ucs !== false) this.drawUcs(ctx);   // Settings › CadCraft › Corner indicator: axis icon (default)
      return;
    }
    // a layout: the sheet on the desk, the model through each viewport, then the sheet's own lines
    const d = this.dpr, p = lay.paper;
    this.fillPane(ctx, this.colors.desk);
    const a = this.toScreen(p.x0, p.y0 + p.h), b = this.toScreen(p.x0 + p.w, p.y0);
    ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0);
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = this.colors.ink2; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    const cache = this.cacheOf(space);
    if (cache.viewports.length) {
      const model = this.cacheOf(this.doc.model);
      for (const vp of cache.viewports) {
        if (vp.on === false) continue;   // a viewport turned off (P.7) shows its frame only
        const c = viewportCorners(vp).map((q) => this.toScreen(q.x, q.y));
        ctx.save();
        ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0);
        ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (const q of c.slice(1)) ctx.lineTo(q.x, q.y); ctx.closePath();
        ctx.clip();
        this.drawCache(ctx, model, mul(this.T, viewportMatrix(vp)));
        ctx.restore();
      }
    }
    this.drawCache(ctx, cache, this.T);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Stroke and fill a cache through T (world → CSS px). */
  drawCache(ctx, cache, T) {
    const d = this.dpr, o = cache.origin, k = Math.hypot(T[0], T[1]);
    ctx.setTransform(d * T[0], d * T[1], d * T[2], d * T[3], d * (T[0] * o.x + T[2] * o.y + T[4] + this.x0), d * (T[1] * o.x + T[3] * o.y + T[5] + this.y0));
    ctx.lineWidth = 1 / k;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const f of cache.fills) {
      ctx.fillStyle = f.wipe ? this.colors.bg : this.ink(f.color);
      ctx.globalAlpha = (f.wipe ? 1 : f.solid ? 0.85 : 0.18) * (f.alpha ?? 1);
      ctx.fill(f.path, 'evenodd');
    }
    ctx.globalAlpha = 1;
    for (const p of cache.paths) {
      ctx.globalAlpha = p.alpha ?? 1;
      ctx.strokeStyle = this.ink(p.color);
      ctx.lineWidth = this.lwDisplay ? lwPixels(p.lw, this.paperPxPerMm()) / k : 1 / k;
      ctx.stroke(p.path);
    }
    ctx.globalAlpha = 1;
    // points: a small cross, fixed on screen
    ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0);
    ctx.lineWidth = 1;
    for (const p of cache.points) {
      const s = ap(T, p.x, p.y);
      if (s.x < -5 || s.y < -5 || s.x > this.w + 5 || s.y > this.h + 5) continue;
      ctx.strokeStyle = this.ink(p.color);
      ctx.beginPath(); ctx.moveTo(s.x - 3, s.y); ctx.lineTo(s.x + 3, s.y); ctx.moveTo(s.x, s.y - 3); ctx.lineTo(s.x, s.y + 3); ctx.stroke();
    }
    this.drawTexts(ctx, cache.texts, T);
  }

  drawTexts(ctx, texts, T = this.T) {
    const d = this.dpr, k = Math.hypot(T[0], T[1]);
    for (const { e, color, alpha } of texts) {
      const hpx = e.h * k;
      if (hpx < 1.5) continue;
      const s = ap(T, e.x, e.y);
      const reach = (String(e.s).length + 2) * hpx * 1.5;
      if (s.x < -reach || s.y < -reach || s.x > this.w + reach || s.y > this.h + reach) continue;
      const lay = textLayout(e);
      ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0);
      ctx.translate(s.x, s.y);
      ctx.rotate(-(e.rot || 0));
      if (e.wf && e.wf !== 1) ctx.scale(e.wf, 1);
      if (e.obl) ctx.transform(1, 0, -Math.tan(e.obl), 1, 0, 0);   // oblique angle (P.7): the glyphs lean right for a positive angle
      ctx.globalAlpha = alpha ?? 1;
      ctx.fillStyle = this.ink(color);
      ctx.font = (hpx * FONT_EM).toFixed(2) + 'px ' + DRAWING_FONT;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = e.ha === 'center' ? 'center' : e.ha === 'right' ? 'right' : 'left';
      lay.lines.forEach((line, i) => ctx.fillText(line, 0, -lay.baselines[i] * k));
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawGrid(ctx) {
    // spacing: a power of ten (×1, ×2, ×5) at least 14 px apart
    const target = 14 / this.zoom;
    const p10 = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5, 10].map((k) => k * p10).find((s) => s >= target);
    const major = step * 5;
    const tl = this.toWorld(0, 0), br = this.toWorld(this.w, this.h);
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0);
    ctx.lineWidth = 1;
    for (const [s, alpha] of [[step, 0.45], [major, 1]]) {
      ctx.strokeStyle = this.colors.grid;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let x = Math.ceil(tl.x / s) * s; x <= br.x; x += s) { const sx = Math.round(this.toScreen(x, 0).x) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h); }
      for (let y = Math.ceil(br.y / s) * s; y <= tl.y; y += s) { const sy = Math.round(this.toScreen(0, y).y) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(this.w, sy); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.gridStep = step;
  }

  drawUcs(ctx) {
    const d = this.dpr, x = 18, y = this.h - 18, L = 34;
    ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0);
    ctx.strokeStyle = this.colors.ink2; ctx.fillStyle = this.colors.ink2; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + L, y); ctx.moveTo(x, y); ctx.lineTo(x, y - L); ctx.stroke();
    ctx.font = '600 11px ' + this.colors.font;
    ctx.fillText('X', x + L + 4, y + 4); ctx.fillText('Y', x - 3, y - L - 5);
  }

  /** Stroke an entity (with block expansion) in screen space on the overlay. */
  traceEntity(ctx, e) {
    const ps = e.type === 'ellipse' ? ellipseAsPrims(e) : prims(e, this.doc.blocks);
    for (const q of ps) {
      if (q.k === 'L') { const a = this.toScreen(q.x1, q.y1), b = this.toScreen(q.x2, q.y2); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      else { const c = this.toScreen(q.cx, q.cy), s = this.toScreen(q.cx + q.r * Math.cos(q.a0), q.cy + q.r * Math.sin(q.a0)); ctx.moveTo(s.x, s.y); ctx.arc(c.x, c.y, q.r * this.zoom, -q.a0, -q.a1, true); }
    }
    if (e.type === 'point') { const s = this.toScreen(e.x, e.y); ctx.moveTo(s.x - 4, s.y - 4); ctx.lineTo(s.x + 4, s.y + 4); ctx.moveTo(s.x - 4, s.y + 4); ctx.lineTo(s.x + 4, s.y - 4); }
  }

  renderOver() {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.over.width, this.over.height);
    if (!this.panes) { this.overPane(ctx, true); return; }
    // split screen: the other panes show the selection and the rubber band; the active one everything, and a frame
    this.syncPane();
    const act = this.panes.list[this.panes.active];
    for (const p of this.panes.list) if (p !== act) this.inPane(ctx, p, () => { if (p.space === this.doc.space && this.paneDoc(p) === this.doc) this.overPane(ctx, false); });
    this.inPane(ctx, act, () => this.overPane(ctx, true));
    const d = this.dpr;
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    for (const p of this.panes.list) {
      const r = p.rect, on = p === act;
      ctx.strokeStyle = on ? this.colors.action : this.colors.grid; ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(r.x + (on ? 1 : 0.5), r.y + (on ? 1 : 0.5), r.w - (on ? 2 : 1), r.h - (on ? 2 : 1));
    }
    ctx.restore();
  }

  /** The overlay of the active pane (`full`), or only the selection and the rubber band (another pane on the same space). */
  overPane(ctx, full) {
    const d = this.dpr, st = this.state;
    ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // constraints: bars and dimensional constraints (gview.js, set by params-panel.js)
    if (full && this.extraOverlay) { try { this.extraOverlay(ctx, this); } catch (err) { console.error(err); } ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0); ctx.globalAlpha = 1; ctx.setLineDash([]); }

    // hover
    if (full && st.hover && !st.selection.has(st.hover) && !st.preview.some((e) => e.ghost)) {   // TRIM / EXTEND show the piece, not the object
      const e = this.doc.get(st.hover);
      if (e) { ctx.strokeStyle = this.colors.action; ctx.lineWidth = 3; ctx.globalAlpha = 0.45; ctx.beginPath(); this.traceEntity(ctx, e); ctx.stroke(); ctx.globalAlpha = 1; }
    }
    // selection: dashed in the action colour, with grips
    if (st.selection.size) {
      ctx.strokeStyle = this.colors.action; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      let n = 0;
      for (const id of st.selection) { const e = this.doc.get(id); if (e && ++n <= 5000) this.traceEntity(ctx, e); }
      ctx.stroke();
      ctx.setLineDash([]);
      if (full && st.grips.length) {
        const gh = this.coarse ? 7 : 4;   // grips for a finger (S.8) are bigger
        for (const g of st.grips) {
          const s = this.toScreen(g.x, g.y);
          const hot = st.hotGrip && st.hotGrip.id === g.id && st.hotGrip.key === g.key;
          ctx.fillStyle = hot ? this.colors.snap : this.colors.action;
          ctx.fillRect(s.x - gh, s.y - gh, 2 * gh, 2 * gh);
          ctx.strokeStyle = this.colors.bg; ctx.lineWidth = 1; ctx.strokeRect(s.x - gh - 0.5, s.y - gh - 0.5, 2 * gh + 1, 2 * gh + 1);
        }
      }
    }
    // rubber band
    // what a TRIM / EXTEND will remove or add (preview entities marked `ghost`): greyed and dashed, a little wider
    const ghosts = st.preview.filter((e) => e.ghost);
    if (ghosts.length) {
      ctx.save();
      ctx.beginPath();
      for (const e of ghosts) this.traceEntity(ctx, e);
      ctx.strokeStyle = this.colors.bg; ctx.lineWidth = 4; ctx.stroke();   // blank out the solid line under it, so the piece reads as fading
      ctx.strokeStyle = this.colors.ink2; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.stroke();
      ctx.restore();
    }
    if (st.preview.length > ghosts.length) {
      const list = st.preview.filter((e) => !e.ghost).flatMap((e) => (e.type === 'dim' ? dimParts(e, this.doc.blocks) : e.type === 'mleader' ? leaderGeometry(e) : [e]));
      ctx.strokeStyle = this.colors.ink; ctx.fillStyle = this.colors.ink; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      for (const e of list) if (e.type !== 'text') this.traceEntity(ctx, e);
      ctx.stroke();
      const texts = list.filter((e) => e.type === 'text').map((e) => ({ e, color: 'ink' }));
      if (texts.length) { this.drawTexts(ctx, texts); ctx.setTransform(d, 0, 0, d, d * this.x0, d * this.y0); }
    }
    if (!full) return;
    // selection window
    if (st.box) {
      const a = this.toScreen(st.box.a.x, st.box.a.y), b = this.toScreen(st.box.b.x, st.box.b.y);
      const crossing = b.x < a.x;
      const col = crossing ? this.colors.cross : this.colors.action;
      ctx.fillStyle = col; ctx.globalAlpha = 0.1;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.setLineDash(crossing ? [5, 4] : []);
      ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
    }
    // lasso (lasso.js) or a TRIM path: window = solid outline, crossing = dashed, both filled; fence = a dashed path
    if (st.lasso && st.lasso.pts.length > 1) {
      const L = st.lasso, sp = L.pts.map((q) => this.toScreen(q.x, q.y));
      const col = L.mode === 'crossing' ? this.colors.cross : L.mode === 'fence' ? this.colors.snap : this.colors.action;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(sp[0].x, sp[0].y); for (const q of sp.slice(1)) ctx.lineTo(q.x, q.y);
      if (L.mode === 'window' || L.mode === 'crossing') { ctx.closePath(); ctx.fillStyle = col; ctx.globalAlpha = 0.1; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.strokeStyle = col; ctx.lineWidth = L.mode === 'fence' ? 1.5 : 1;
      ctx.setLineDash(L.mode === 'window' ? [] : [5, 4]);
      ctx.stroke();
      ctx.restore();
    }
    // crosshair and pick box (split screen: only while the pointer is over the active pane)
    if (st.cursor && st.crosshair && (!this.panes || this.hoverPane === this.panes.active)) {
      const s = this.toScreen(st.cursor.x, st.cursor.y);
      ctx.strokeStyle = this.colors.ink; ctx.lineWidth = 1; ctx.globalAlpha = 0.85;
      ctx.beginPath();
      const cs = this.cursorSpec(), L = st.cursorMode === 'select' ? 0 : cs.arm, h = cs.box / 2;
      if (L) { ctx.moveTo(s.x - L, s.y + 0.5); ctx.lineTo(s.x + L, s.y + 0.5); ctx.moveTo(s.x + 0.5, s.y - L); ctx.lineTo(s.x + 0.5, s.y + L); }
      if (st.cursorMode !== 'point') ctx.rect(s.x - h, s.y - h, cs.box, cs.box);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // tracking (tracking.js): dotted rays, acquired points, the label by the cursor
    if (st.track) this.drawTrack(ctx, st.track, st.cursor);
    // snap marker
    if (st.snap) this.drawSnap(ctx, st.snap);
  }

  drawTrack(ctx, tr, cursor) {
    ctx.save();
    ctx.strokeStyle = this.colors.snap; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    const far = Math.hypot(this.w, this.h) * 2;
    ctx.beginPath();
    for (const r of tr.rays || []) {
      const a = this.toScreen(r.from.x, r.from.y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + Math.cos(r.ang) * far, a.y - Math.sin(r.ang) * far);
    }
    ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const p of tr.acquired || []) { const s = this.toScreen(p.x, p.y); ctx.moveTo(s.x - 4, s.y); ctx.lineTo(s.x + 4, s.y); ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x, s.y + 4); }
    ctx.stroke();
    if (tr.label && cursor) {
      const s = this.toScreen(cursor.x, cursor.y);
      ctx.font = '600 12px ' + this.colors.font;
      const w = ctx.measureText(tr.label).width + 10;
      const x = s.x + 14 + w > this.w - 4 ? s.x - 14 - w : s.x + 14, y = s.y - 30 < 4 ? s.y + 12 : s.y - 30;   // stay on screen
      ctx.fillStyle = this.colors.bg; ctx.globalAlpha = 0.92; ctx.fillRect(x, y, w, 18); ctx.globalAlpha = 1;
      ctx.strokeStyle = this.colors.snap; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 17);
      ctx.fillStyle = this.colors.ink; ctx.fillText(tr.label, x + 5, y + 13);
    }
    ctx.restore();
  }

  drawSnap(ctx, sn) {
    const s = this.toScreen(sn.x, sn.y), r = 6;
    ctx.strokeStyle = this.colors.snap; ctx.lineWidth = 2;
    ctx.beginPath();
    switch (sn.kind) {
      case 'end': ctx.rect(s.x - r, s.y - r, 2 * r, 2 * r); break;
      case 'mid': ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y + r * 0.8); ctx.lineTo(s.x - r, s.y + r * 0.8); ctx.closePath(); break;
      case 'cen': ctx.arc(s.x, s.y, r, 0, TAU); break;
      case 'quad': ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y); ctx.closePath(); break;
      case 'int': ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r); ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r); break;
      case 'perp': ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y + r); ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x, s.y); ctx.lineTo(s.x, s.y + r); break;
      case 'node': ctx.arc(s.x, s.y, r, 0, TAU); ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r); ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r); break;
      case 'ins': ctx.rect(s.x - r, s.y - r, r, r); ctx.rect(s.x, s.y, r, r); break;
      case 'near': ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r); ctx.lineTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y - r); ctx.closePath(); break;
      default: ctx.rect(s.x - r, s.y - r, 2 * r, 2 * r);
    }
    ctx.stroke();
    const label = SNAP_LABELS[sn.kind];
    if (label) {
      ctx.font = '600 12px ' + this.colors.font;
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = this.colors.snap;
      ctx.fillRect(s.x + 12, s.y + 10, w, 18);
      ctx.fillStyle = this.dark ? '#1d232b' : '#ffffff';
      ctx.fillText(label, s.x + 17, s.y + 23);
    }
  }

  gripsFor(ids) {
    const out = [];
    for (const id of ids) {
      const e = this.doc.get(id);
      if (!e || !this.doc.editable(e)) continue;
      for (const g of entityGrips(e)) out.push({ ...g, id });
      if (out.length > 2000) break;
    }
    return out;
  }
}

export const SNAP_LABELS = { end: 'Endpoint', mid: 'Midpoint', cen: 'Center', quad: 'Quadrant', int: 'Intersection', perp: 'Perpendicular', near: 'Nearest', node: 'Node', ins: 'Insertion' };

function nearPrim(q, p, r) {
  if (q.k === 'L') return Math.min(q.x1, q.x2) - r <= p.x && Math.max(q.x1, q.x2) + r >= p.x && Math.min(q.y1, q.y2) - r <= p.y && Math.max(q.y1, q.y2) + r >= p.y;
  return Math.abs(Math.hypot(p.x - q.cx, p.y - q.cy) - q.r) <= r;
}

function ellipseAsPrims(e) {
  const pts = ellipsePoints(e, 96), out = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push({ k: 'L', x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
  return out;
}

function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
const ap = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
function parseColor(c) {
  c = String(c).trim();
  if (c.startsWith('#')) {
    const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) return m[1].split(/[ ,]+/).slice(0, 3).map((x) => parseFloat(x) / 255);
  return [0.5, 0.5, 0.5];
}
function luminance(c) {
  const [r, g, b] = parseColor(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function mix(a, b, t) {
  const x = parseColor(a), y = parseColor(b);
  return '#' + x.map((v, i) => Math.round((v * (1 - t) + y[i] * t) * 255).toString(16).padStart(2, '0')).join('');
}
