/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: "Automation Error. …" texts are the error messages routines expect, not UI. */
/**
 * vla-host.js — the drawing as objects for vla- / vlax- (0.4 part 2, Y.11; session cad-lisp). DOM-free.
 * `vlaCall(host, op, h, args)` answers vla.js through host-cad.js's CadHost. Handles are plain { kind, key }:
 *
 *   App · Doc · Documents · Blocks · Layers · Layouts · Linetypes · TextStyles · DimStyles · Views   (collections)
 *   Block {key: name}   model space is "*Model_Space", the sheets "*Paper_Space", "*Paper_Space0", "*Paper_Space1" …
 *   Layer {key: name} · Layout {key: "Model" | sheet name} · Linetype / TextStyle / DimStyle / View {key: name}
 *   Ent {key: id}  an object of the model or a sheet;  Ent {key: "m:<block>:<n>"}  an object inside a block definition
 *   Att {key: id, tag}  an attribute of a block reference
 *
 * Objects inside block definitions get a serial number that follows them when the block is redefined here (deleting
 * one while vlax-for walks the block must not shift the others). Every change goes through doc.change, so a routine's
 * edits stay one undo step with its command. Values: numbers, { i }, strings, { bool }, { vla }, { arr, vt }.
 */
import { objectName, dxfType } from './dxflist.js';
import { entityBounds, txEntity, mTranslate, mRotate, mScale, mAbout, mMirror, explodeEntity, curveLength, entityArea } from '../geom.js';
import { dimMeasure } from '../dims.js';

const ERR = (m) => ({ error: 'Automation Error. ' + m });
const NOTFOUND = ERR('Key not found');
const B = (v) => ({ bool: !!v });
const I = (n) => ({ i: n | 0 });
const P3 = (x, y) => ({ arr: [+x || 0, +y || 0, 0], vt: 5 });
const ptIn = (v) => { const a = v && v.arr ? v.arr.map((x) => (x && typeof x === 'object' && 'i' in x ? x.i : x)) : null; return a && a.length >= 2 && a.every(Number.isFinite) ? { x: a[0], y: a[1] } : null; };
const numIn = (v) => (v && typeof v === 'object' && 'i' in v ? v.i : typeof v === 'number' ? v : NaN);
const boolIn = (v) => (v && typeof v === 'object' && 'bool' in v ? v.bool : v && typeof v === 'object' && 'i' in v ? v.i !== 0 : typeof v === 'number' ? v !== 0 : !!v);
const COLL = { BLOCKS: 'Blocks', LAYERS: 'Layers', LAYOUTS: 'Layouts', LINETYPES: 'Linetypes', TEXTSTYLES: 'TextStyles', DIMSTYLES: 'DimStyles', VIEWS: 'Views' };

/** The block-table name of a space: model, then each sheet. */
export function spaceBlockName(doc, map) {
  if (map === doc.model) return '*Model_Space';
  const k = doc.layouts.findIndex((l) => l.entities === map);
  return k === 0 ? '*Paper_Space' : '*Paper_Space' + (k - 1);
}
function spaceOf(doc, name) {
  const n = String(name).toUpperCase();
  if (n === '*MODEL_SPACE') return doc.model;
  const m = n.match(/^\*PAPER_SPACE(\d*)$/);
  if (!m) return null;
  const k = m[1] === '' ? 0 : +m[1] + 1;
  return doc.layouts[k]?.entities || null;
}

export function vlaCall(H, op, h, args) {
  const doc = H.doc;
  const S = (H.vlaState ||= { serial: new WeakMap(), next: 1 });
  const serialOf = (e) => { let s = S.serial.get(e); if (!s) { s = S.next++; S.serial.set(e, s); } return s; };
  const member = (key) => {
    const m = /^m:(.*):(\d+)$/.exec(key);
    if (!m) return null;
    const b = doc.blocks.get(m[1]);
    if (!b) return null;
    const idx = b.entities.findIndex((e) => S.serial.get(e) === +m[2]);
    return idx < 0 ? null : { b, idx, e: b.entities[idx] };
  };
  /** The object of an Ent handle: { e, map } (model / sheet) or { e, b, idx } (inside a block). */
  const ent = (hh) => {
    if (typeof hh.key === 'string' && hh.key.startsWith('m:')) return member(hh.key);
    const f = H.find(hh.key);
    return f && !f.block ? f : null;
  };
  const entH = (id) => ({ kind: 'Ent', key: id });
  const memberH = (b, e) => ({ kind: 'Ent', key: 'm:' + b.name + ':' + serialOf(e) });
  /** Redefine a block with new members; serial numbers follow their objects. */
  const redefine = (b, entities, label) => {
    const serials = entities.map((e) => S.serial.get(e));
    let nb = null;
    doc.change(label, () => { nb = doc.defineBlock({ ...b, entities }); });
    nb.entities.forEach((e, i) => { if (serials[i]) S.serial.set(e, serials[i]); });
    return nb;
  };
  const layerLocked = (e) => !!doc.layers.get(e.layer)?.locked;
  /** Replace an object (model, sheet or block member) with a changed copy. */
  const replace = (f, next, label = 'VLA') => {
    if (f.b) { const ents = f.b.entities.slice(); ents[f.idx] = next; redefine(f.b, ents, label); return; }
    doc.layer(next.layer ?? '0');
    doc.change(label, () => doc.update(f.e.id, next, f.map));
  };
  const addTo = (map, e, label = 'VLA') => {
    const full = { layer: doc.current.layer, color: doc.current.color, ...e };
    if (map && !(map instanceof Map)) {   // a block definition
      const ents = [...map.entities, full];
      const nb = redefine(map, ents, label);
      return memberH(nb, nb.entities[nb.entities.length - 1]);
    }
    let made = null;
    doc.change(label, () => { made = doc.add(full, map || doc.entities); });
    return entH(made.id);
  };
  const blockItems = (name) => {
    const sp = spaceOf(doc, name);
    if (sp) return [...sp.keys()].map(entH);
    const b = doc.blocks.get(name) || [...doc.blocks.values()].find((x) => x.name.toUpperCase() === String(name).toUpperCase());
    return b ? b.entities.map((e) => memberH(b, e)) : null;
  };
  const allBlockNames = () => ['*Model_Space', ...doc.layouts.map((l, k) => (k === 0 ? '*Paper_Space' : '*Paper_Space' + (k - 1))), ...doc.blocks.keys()];
  const findBlock = (name) => allBlockNames().find((n) => n.toUpperCase() === String(name).toUpperCase());
  const layoutNames = () => ['Model', ...doc.layouts.map((l) => l.name)];
  const collItems = (kind) => {
    switch (kind) {
      case 'Blocks': return allBlockNames().map((n) => ({ kind: 'Block', key: n }));
      case 'Layers': return [...doc.layers.keys()].map((n) => ({ kind: 'Layer', key: n }));
      case 'Layouts': return layoutNames().map((n) => ({ kind: 'Layout', key: n }));
      case 'Linetypes': return ['ByBlock', 'ByLayer', 'Continuous', ...doc.linetypes.keys()].map((n) => ({ kind: 'Linetype', key: n }));
      case 'TextStyles': return [{ kind: 'TextStyle', key: 'Standard' }];
      case 'DimStyles': return [{ kind: 'DimStyle', key: 'Standard' }];
      case 'Views': return (doc.views || []).map((v) => ({ kind: 'View', key: v.name }));
      case 'Documents': return [{ kind: 'Doc' }];
      default: return null;
    }
  };
  const itemOf = (kind, which) => {
    const items = collItems(kind);
    if (!items) return null;
    const n = numIn(which);
    if (Number.isFinite(n) && typeof which !== 'string') return items[n] || NOTFOUND;
    const s = String(which).toUpperCase();
    return items.find((x) => String(x.key ?? '').toUpperCase() === s) || NOTFOUND;
  };
  const color = (e) => (e.color === null || e.color === undefined ? 256 : typeof e.color === 'number' ? e.color : 256);

  const get = (hh, P) => {
    switch (hh.kind) {
      case 'App':
        if (P === 'ACTIVEDOCUMENT') return { vla: { kind: 'Doc' } };
        if (P === 'DOCUMENTS') return { vla: { kind: 'Documents' } };
        if (P === 'NAME' || P === 'CAPTION') return 'CadCraft';
        if (P === 'VERSION') return '24.0';
        if (P === 'APPLICATION') return { vla: { kind: 'App' } };
        break;
      case 'Doc':
        if (COLL[P]) return { vla: { kind: COLL[P] } };
        switch (P) {
          case 'NAME': return (doc.meta.name || 'Drawing1') + '.dwg';
          case 'FULLNAME': return (doc.meta.name || 'Drawing1') + '.dwg';
          case 'PATH': return '';
          case 'MODELSPACE': return { vla: { kind: 'Block', key: '*Model_Space' } };
          case 'PAPERSPACE': return { vla: { kind: 'Block', key: doc.layout ? spaceBlockName(doc, doc.layout.entities) : '*Paper_Space' } };
          case 'ACTIVELAYER': return { vla: { kind: 'Layer', key: doc.current.layer } };
          case 'ACTIVELAYOUT': return { vla: { kind: 'Layout', key: doc.layout ? doc.layout.name : 'Model' } };
          case 'ACTIVESPACE': return I(doc.layout ? 0 : 1);
          case 'SAVED': return B(!doc.dirty);
          case 'OBJECTNAME': return 'AcDbDatabase';
          case 'APPLICATION': return { vla: { kind: 'App' } };
          case 'DATABASE': return { vla: { kind: 'Doc' } };
          default: break;
        }
        break;
      case 'Documents': case 'Blocks': case 'Layers': case 'Layouts': case 'Linetypes': case 'TextStyles': case 'DimStyles': case 'Views':
        if (P === 'COUNT') return I(collItems(hh.kind).length);
        if (P === 'APPLICATION') return { vla: { kind: 'App' } };
        break;
      case 'Block': {
        const name = findBlock(hh.key);
        if (!name) return ERR('Object was erased');
        const sp = spaceOf(doc, name), b = sp ? null : doc.blocks.get(name);
        switch (P) {
          case 'NAME': return name;
          case 'COUNT': return I(sp ? sp.size : b.entities.length);
          case 'ISLAYOUT': return B(!!sp);
          case 'ISXREF': return B(!!b?.xref && !b.xref.of);
          case 'ISDYNAMICBLOCK': return B(false);
          case 'ISANONYMOUS': return B(name.startsWith('*') && !sp);
          case 'ORIGIN': return P3(b?.base?.x, b?.base?.y);
          case 'OBJECTNAME': return 'AcDbBlockTableRecord';
          case 'COMMENTS': return '';
          case 'PATH': return b?.xref?.path || '';
          case 'LAYOUT': { if (!sp) return ERR('Not applicable'); const k = name === '*Model_Space' ? 'Model' : doc.layouts.find((l) => l.entities === sp)?.name; return { vla: { kind: 'Layout', key: k } }; }
          case 'HANDLE': return name;
          default: break;
        }
        break;
      }
      case 'Layer': {
        const l = doc.layers.get(hh.key);
        if (!l) return ERR('Object was erased');
        switch (P) {
          case 'NAME': return l.name;
          case 'COLOR': return I(typeof l.color === 'number' ? l.color : 7);
          case 'LOCK': return B(l.locked);
          case 'FREEZE': return B(l.frozen);
          case 'LAYERON': return B(l.on !== false);
          case 'PLOTTABLE': return B(l.plot !== false);
          case 'LINETYPE': return l.linetype || 'Continuous';
          case 'LINEWEIGHT': return I(Number.isFinite(l.lineweight) && l.lineweight >= 0 ? Math.round(l.lineweight * 100) : -3);
          case 'DESCRIPTION': return '';
          case 'USED': return B([...doc.everyEntity()].some((e) => e.layer === l.name));
          case 'OBJECTNAME': return 'AcDbLayerTableRecord';
          case 'HANDLE': return 'L:' + l.name;
          default: break;
        }
        break;
      }
      case 'Layout': {
        const isModel = hh.key === 'Model', l = isModel ? null : doc.layouts.find((x) => x.name === hh.key);
        if (!isModel && !l) return ERR('Object was erased');
        switch (P) {
          case 'NAME': return isModel ? 'Model' : l.name;
          case 'BLOCK': return { vla: { kind: 'Block', key: isModel ? '*Model_Space' : spaceBlockName(doc, l.entities) } };
          case 'TABORDER': return I(isModel ? 0 : doc.layouts.indexOf(l) + 1);
          case 'MODELTYPE': return B(isModel);
          case 'OBJECTNAME': return 'AcDbLayout';
          default: break;
        }
        break;
      }
      case 'Linetype': case 'TextStyle': case 'DimStyle': case 'View':
        if (P === 'NAME') return hh.key;
        if (P === 'OBJECTNAME') return { Linetype: 'AcDbLinetypeTableRecord', TextStyle: 'AcDbTextStyleTableRecord', DimStyle: 'AcDbDimStyleTableRecord', View: 'AcDbViewTableRecord' }[hh.kind];
        break;
      case 'Att': {
        const f = H.find(hh.key);
        const e = f?.e;
        if (!e || e.type !== 'insert') return ERR('Object was erased');
        if (P === 'TAGSTRING') return hh.tag;
        if (P === 'TEXTSTRING') return String(e.attrs?.[hh.tag] ?? '');
        if (P === 'OBJECTNAME') return 'AcDbAttribute';
        if (P === 'LAYER') return e.layer;
        if (P === 'INVISIBLE') return B(!!doc.blocks.get(e.block)?.attdefs?.find((x) => x.tag === hh.tag)?.invisible);
        break;
      }
      case 'Ent': {
        const f = ent(hh);
        if (!f) return ERR('Object was erased');
        const e = f.e;
        switch (P) {
          case 'OBJECTNAME': case 'ENTITYNAME': return objectName(e);
          case 'HANDLE': return typeof hh.key === 'number' ? hh.key.toString(16).toUpperCase() : hh.key;
          case 'LAYER': return e.layer ?? '0';
          case 'COLOR': return I(color(e));
          case 'LINETYPE': return e.lt || 'ByLayer';
          case 'LINEWEIGHT': return I(Number.isFinite(e.lw) ? (e.lw < 0 ? e.lw : Math.round(e.lw * 100)) : -1);
          case 'LINETYPESCALE': return e.lts || 1;
          case 'VISIBLE': return B(true);
          case 'OWNERID': return I(0);
          default: break;
        }
        const type = dxfType(e);
        switch (type) {
          case 'LINE':
            if (P === 'STARTPOINT') return P3(e.x1, e.y1);
            if (P === 'ENDPOINT') return P3(e.x2, e.y2);
            if (P === 'LENGTH') return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
            if (P === 'ANGLE') { const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1); return a < 0 ? a + 2 * Math.PI : a; }
            if (P === 'DELTA') return P3(e.x2 - e.x1, e.y2 - e.y1);
            break;
          case 'CIRCLE': case 'ARC':
            if (P === 'CENTER') return P3(e.cx, e.cy);
            if (P === 'RADIUS') return e.r;
            if (type === 'CIRCLE') {
              if (P === 'DIAMETER') return 2 * e.r;
              if (P === 'AREA') return Math.PI * e.r * e.r;
              if (P === 'CIRCUMFERENCE') return 2 * Math.PI * e.r;
            } else {
              const sweep = (((e.a1 - e.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
              if (P === 'STARTANGLE') return e.a0;
              if (P === 'ENDANGLE') return e.a1;
              if (P === 'TOTALANGLE') return sweep;
              if (P === 'ARCLENGTH') return e.r * sweep;
              if (P === 'STARTPOINT') return P3(e.cx + e.r * Math.cos(e.a0), e.cy + e.r * Math.sin(e.a0));
              if (P === 'ENDPOINT') return P3(e.cx + e.r * Math.cos(e.a1), e.cy + e.r * Math.sin(e.a1));
              if (P === 'AREA') return entityArea(e)?.area ?? 0;
            }
            break;
          case 'LWPOLYLINE':
            if (P === 'COORDINATES') return { arr: e.pts.flatMap((p) => [p.x, p.y]), vt: 5 };
            if (P === 'CLOSED') return B(e.closed);
            if (P === 'CONSTANTWIDTH') return e.w || 0;
            if (P === 'ELEVATION') return 0;
            if (P === 'AREA') return entityArea(e)?.area ?? 0;
            if (P === 'LENGTH') return curveLength(e) ?? 0;
            break;
          case 'ELLIPSE':
            if (P === 'CENTER') return P3(e.cx, e.cy);
            if (P === 'MAJORAXIS') return P3(e.mx, e.my);
            if (P === 'RADIUSRATIO') return e.ratio;
            if (P === 'STARTANGLE') return e.t0 ?? 0;
            if (P === 'ENDANGLE') return e.t1 ?? 2 * Math.PI;
            if (P === 'MAJORRADIUS') return Math.hypot(e.mx, e.my);
            if (P === 'MINORRADIUS') return Math.hypot(e.mx, e.my) * e.ratio;
            break;
          case 'TEXT': case 'MTEXT':
            if (P === 'TEXTSTRING') return type === 'MTEXT' ? String(e.s ?? '').replace(/\n/g, '\\P') : String(e.s ?? '');
            if (P === 'INSERTIONPOINT' || P === 'TEXTALIGNMENTPOINT') return P3(e.x, e.y);
            if (P === 'HEIGHT') return e.h;
            if (P === 'ROTATION') return e.rot || 0;
            if (P === 'SCALEFACTOR') return e.wf || 1;
            if (P === 'STYLENAME') return 'Standard';
            if (P === 'WIDTH' && type === 'MTEXT') return e.ww || 0;
            break;
          case 'INSERT':
            if (P === 'NAME' || P === 'EFFECTIVENAME') return e.block;
            if (P === 'INSERTIONPOINT') return P3(e.x, e.y);
            if (P === 'ROTATION') return e.rot || 0;
            if (P === 'XSCALEFACTOR' || P === 'XEFFECTIVESCALEFACTOR') return e.sx ?? 1;
            if (P === 'YSCALEFACTOR' || P === 'YEFFECTIVESCALEFACTOR') return e.sy ?? 1;
            if (P === 'ZSCALEFACTOR' || P === 'ZEFFECTIVESCALEFACTOR') return e.sx ?? 1;
            if (P === 'HASATTRIBUTES') return B(!!(e.attrs && Object.keys(e.attrs).length) || !!doc.blocks.get(e.block)?.attdefs?.length);
            if (P === 'ISDYNAMICBLOCK') return B(false);
            break;
          case 'POINT':
            if (P === 'COORDINATES') return P3(e.x, e.y);
            break;
          case 'DIMENSION':
            if (P === 'MEASUREMENT') { try { return dimMeasure(e); } catch { return 0; } }
            if (P === 'TEXTOVERRIDE') return e.text || '';
            break;
          default: break;
        }
        break;
      }
      default: break;
    }
    return ERR('Unknown property: ' + P);
  };

  const put = (hh, P, v) => {
    switch (hh.kind) {
      case 'Doc':
        if (P === 'ACTIVELAYER') { const k = v?.vla?.key; if (!doc.layers.has(k)) return ERR('Invalid input'); doc.setLayer(k, {}, { current: true }); return true; }
        break;
      case 'Layer': {
        const l = doc.layers.get(hh.key);
        if (!l) return ERR('Object was erased');
        const patch = { NAME: () => ({ name: String(v) }), COLOR: () => ({ color: numIn(v) }), LOCK: () => ({ locked: boolIn(v) }), FREEZE: () => ({ frozen: boolIn(v) }),
          LAYERON: () => ({ on: boolIn(v) }), PLOTTABLE: () => ({ plot: boolIn(v) }), LINETYPE: () => ({ linetype: String(v) }),
          LINEWEIGHT: () => ({ lineweight: numIn(v) < 0 ? numIn(v) : numIn(v) / 100 }) }[P];
        if (!patch) break;
        if (P === 'FREEZE' && boolIn(v) && doc.current.layer === l.name) return ERR('Invalid layer');
        if (P === 'NAME' && (l.name === '0' || doc.layers.has(String(v)))) return ERR('Duplicate record name');
        doc.setLayer(l.name, patch());
        return true;
      }
      case 'Att': {
        const f = H.find(hh.key);
        if (!f || f.e.type !== 'insert') return ERR('Object was erased');
        if (P !== 'TEXTSTRING') break;
        replace(f, { ...f.e, attrs: { ...(f.e.attrs || {}), [hh.tag]: String(v) } });
        return true;
      }
      case 'Ent': {
        const f = ent(hh);
        if (!f) return ERR('Object was erased');
        if (layerLocked(f.e)) return ERR('On locked layer');
        const e = { ...f.e };
        const p = ptIn(v), n = numIn(v);
        switch (P) {
          case 'LAYER': if (typeof v !== 'string' || !v) return ERR('Invalid input'); e.layer = v; break;
          case 'COLOR': e.color = n === 256 ? null : n; break;
          case 'LINETYPE': if (/^bylayer$/i.test(String(v))) delete e.lt; else e.lt = String(v); break;
          case 'LINEWEIGHT': if (n === -1) delete e.lw; else e.lw = n < 0 ? n : n / 100; break;
          case 'LINETYPESCALE': e.lts = n; break;
          case 'STARTPOINT': if (!p || e.type !== 'line') return ERR('Invalid input'); e.x1 = p.x; e.y1 = p.y; break;
          case 'ENDPOINT': if (!p || e.type !== 'line') return ERR('Invalid input'); e.x2 = p.x; e.y2 = p.y; break;
          case 'CENTER': if (!p || !Number.isFinite(e.cx)) return ERR('Invalid input'); e.cx = p.x; e.cy = p.y; break;
          case 'RADIUS': if (!(n > 0) || !Number.isFinite(e.r)) return ERR('Invalid input'); e.r = n; break;
          case 'DIAMETER': if (!(n > 0) || e.type !== 'circle') return ERR('Invalid input'); e.r = n / 2; break;
          case 'STARTANGLE': if (e.type === 'arc') e.a0 = n; else if (e.type === 'ellipse') e.t0 = n; else return ERR('Invalid input'); break;
          case 'ENDANGLE': if (e.type === 'arc') e.a1 = n; else if (e.type === 'ellipse') e.t1 = n; else return ERR('Invalid input'); break;
          case 'TEXTSTRING': if (e.type !== 'text') return ERR('Invalid input'); e.s = String(v).replace(/\\P/g, '\n'); break;
          case 'INSERTIONPOINT': case 'COORDINATES':
            if (P === 'COORDINATES' && e.type === 'poly') {
              const a = (v?.arr || []).map(numIn);
              if (a.length < 4 || a.length % 2 || !a.every(Number.isFinite)) return ERR('Invalid input');
              e.pts = []; for (let k = 0; k < a.length; k += 2) e.pts.push({ x: a[k], y: a[k + 1], b: f.e.pts[k / 2]?.b || 0 });
              break;
            }
            if (!p || !Number.isFinite(e.x)) return ERR('Invalid input'); e.x = p.x; e.y = p.y; break;
          case 'HEIGHT': if (!(n > 0) || e.type !== 'text') return ERR('Invalid input'); e.h = n; break;
          case 'ROTATION': if (!Number.isFinite(n) || !('rot' in e || e.type === 'text' || e.type === 'insert')) return ERR('Invalid input'); e.rot = n; break;
          case 'XSCALEFACTOR': if (e.type !== 'insert' || !n) return ERR('Invalid input'); e.sx = n; break;
          case 'YSCALEFACTOR': if (e.type !== 'insert' || !n) return ERR('Invalid input'); e.sy = n; break;
          case 'NAME': if (e.type !== 'insert' || !doc.blocks.has(String(v))) return ERR('Invalid input'); e.block = String(v); break;
          case 'CLOSED': if (e.type !== 'poly') return ERR('Invalid input'); e.closed = boolIn(v); break;
          case 'CONSTANTWIDTH': if (e.type !== 'poly') return ERR('Invalid input'); if (n > 0) e.w = n; else delete e.w; break;
          case 'TEXTOVERRIDE': if (e.type !== 'dim') return ERR('Invalid input'); e.text = String(v); delete e.block; break;
          default: return ERR('Unknown property: ' + P);
        }
        replace(f, e, 'VLA');
        return true;
      }
      case 'Block': {
        if (P !== 'NAME') break;
        const name = findBlock(hh.key), b = doc.blocks.get(name);
        if (!b) return ERR('Invalid input');
        const to = String(v);
        if (!to || findBlock(to)) return ERR('Duplicate record name');
        doc.change('RENAME', () => {
          doc.defineBlock({ ...b, name: to });
          doc.removeBlock(name);
          for (const map of [doc.model, ...doc.layouts.map((l) => l.entities)]) for (const e of [...map.values()]) if (e.block === name) doc.update(e.id, { ...e, block: to }, map);
          for (const o of [...doc.blocks.values()]) if (o.entities.some((e) => e.block === name)) doc.defineBlock({ ...o, entities: o.entities.map((e) => (e.block === name ? { ...e, block: to } : e)) });
        });
        return true;
      }
      default: break;
    }
    return ERR('Property is read only: ' + P);
  };

  const call = (hh, M, a) => {
    if (M === 'UPDATE' || M === 'REGEN' || M === 'STARTUNDOMARK' || M === 'ENDUNDOMARK' || M === 'HIGHLIGHT' || M === 'EVALUATE') { if (M === 'REGEN') H.redraw(); return null; }
    if (hh.kind === 'App' && (M === 'ZOOMEXTENTS' || M === 'ZOOMALL')) { H.ui.zoomExtents?.(); return null; }
    if (M === 'ITEM') {
      if (hh.kind === 'Block') { const items = blockItems(findBlock(hh.key)); const n = numIn(a[0]); return items && items[n] ? { vla: items[n] } : NOTFOUND; }
      const r = itemOf(hh.kind, a[0]);
      return r === null ? ERR('Not applicable') : r.error ? r : { vla: r };
    }
    if (hh.kind === 'Layers' && M === 'ADD') { const n = String(a[0] ?? ''); if (!n) return ERR('Invalid input'); if (!doc.layers.has(n)) doc.setLayer(n, {}); return { vla: { kind: 'Layer', key: n } }; }
    if (hh.kind === 'Blocks' && M === 'ADD') {
      const p = ptIn(a[0]), n = String(a[1] ?? '');
      if (!p || !n) return ERR('Invalid input');
      if (findBlock(n)) return { vla: { kind: 'Block', key: findBlock(n) } };
      doc.change('BLOCK', () => doc.defineBlock({ name: n, base: p, entities: [] }));
      return { vla: { kind: 'Block', key: n } };
    }
    if (hh.kind === 'Doc' && M === 'HANDLETOOBJECT') { const id = parseInt(String(a[0]), 16); return H.find(id) ? { vla: entH(id) } : ERR('Invalid handle'); }
    if (hh.kind === 'Doc' && M === 'PURGEALL') {
      doc.change('PURGE', () => { for (const b of [...doc.blocks.values()]) if (!doc.blockUses(b.name) && !b.name.startsWith('*')) doc.removeBlock(b.name); });
      return null;
    }
    if (hh.kind === 'Block') {
      const name = findBlock(hh.key);
      if (!name) return ERR('Object was erased');
      const sp = spaceOf(doc, name), b = sp ? null : doc.blocks.get(name);
      const target = sp || b;
      const add = (e) => ({ vla: addTo(target, e) });
      const p = (k) => ptIn(a[k]), n = (k) => numIn(a[k]);
      switch (M) {
        case 'DELETE':
          if (sp) return ERR('Invalid input');
          if (doc.blockUses(name)) return ERR('Object is referenced');
          doc.change('DELETE', () => doc.removeBlock(name));
          return null;
        case 'ADDLINE': if (!p(0) || !p(1)) return ERR('Invalid input'); return add({ type: 'line', x1: p(0).x, y1: p(0).y, x2: p(1).x, y2: p(1).y });
        case 'ADDCIRCLE': if (!p(0) || !(n(1) > 0)) return ERR('Invalid input'); return add({ type: 'circle', cx: p(0).x, cy: p(0).y, r: n(1) });
        case 'ADDARC': if (!p(0) || !(n(1) > 0)) return ERR('Invalid input'); return add({ type: 'arc', cx: p(0).x, cy: p(0).y, r: n(1), a0: n(2), a1: n(3) });
        case 'ADDPOINT': if (!p(0)) return ERR('Invalid input'); return add({ type: 'point', x: p(0).x, y: p(0).y });
        case 'ADDTEXT': if (!p(1) || !(n(2) > 0)) return ERR('Invalid input'); return add({ type: 'text', s: String(a[0]), x: p(1).x, y: p(1).y, h: n(2), rot: 0, ha: 'left', va: 'baseline' });
        case 'ADDMTEXT': if (!p(0)) return ERR('Invalid input'); return add({ type: 'text', s: String(a[2] ?? '').replace(/\\P/g, '\n'), x: p(0).x, y: p(0).y, h: doc.current.textHeight || 2.5, rot: 0, ha: 'left', va: 'top', ...(n(1) > 0 ? { ww: n(1) } : {}) });
        case 'ADDLIGHTWEIGHTPOLYLINE': {
          const c = (a[0]?.arr || []).map(numIn);
          if (c.length < 4 || c.length % 2 || !c.every(Number.isFinite)) return ERR('Invalid input');
          const pts = []; for (let k = 0; k < c.length; k += 2) pts.push({ x: c[k], y: c[k + 1], b: 0 });
          return add({ type: 'poly', pts, closed: false });
        }
        case 'INSERTBLOCK': {
          const bn = String(a[1] ?? '');
          if (!p(0) || !doc.blocks.has(bn)) return ERR('Invalid input');
          return add({ type: 'insert', block: bn, x: p(0).x, y: p(0).y, sx: Number.isFinite(n(2)) ? n(2) : 1, sy: Number.isFinite(n(3)) ? n(3) : 1, rot: Number.isFinite(n(5)) ? n(5) : 0 });
        }
        default: break;
      }
    }
    if (hh.kind === 'Layer' && M === 'DELETE') {
      const l = doc.layers.get(hh.key);
      if (!l) return ERR('Object was erased');
      if (l.name === '0' || l.name === doc.current.layer || [...doc.everyEntity()].some((e) => e.layer === l.name) || [...doc.blocks.values()].some((b) => b.entities.some((e) => e.layer === l.name))) return ERR('Object is referenced');
      const state = doc.layerState();
      doc.change('DELETE', () => doc.setLayerState({ ...state, list: state.list.filter((x) => x.name !== l.name) }));
      return null;
    }
    if (hh.kind === 'Layout' && M === 'DELETE') {
      if (hh.key === 'Model') return ERR('Invalid input');
      const l = doc.layouts.find((x) => x.name === hh.key);
      if (!l) return ERR('Object was erased');
      doc.change('DELETE', () => doc.setLayouts(doc.layouts.filter((x) => x !== l)));
      return null;
    }
    if (hh.kind === 'Ent') {
      const f = ent(hh);
      if (!f) return ERR('Object was erased');
      const e = f.e;
      const tx = (m, keep, label) => {
        const moved = txEntity(e, m);
        if (!moved) return ERR('Invalid input');
        if (keep) { const made = f.b ? addTo(f.b, moved, label) : addTo(f.map, { ...moved, id: undefined }, label); return { vla: made }; }
        if (layerLocked(e)) return ERR('On locked layer');
        replace(f, { ...moved, id: e.id }, label);
        return null;
      };
      switch (M) {
        case 'DELETE':
          if (layerLocked(e)) return ERR('On locked layer');
          if (f.b) { redefine(f.b, f.b.entities.filter((_, k) => k !== f.idx), 'DELETE'); return null; }
          doc.change('DELETE', () => doc.remove(e.id, f.map));
          return null;
        case 'COPY': return tx([1, 0, 0, 1, 0, 0], true, 'COPY');
        case 'MOVE': { const p0 = ptIn(a[0]), p1 = ptIn(a[1]); if (!p0 || !p1) return ERR('Invalid input'); return tx(mTranslate(p1.x - p0.x, p1.y - p0.y), false, 'MOVE'); }
        case 'ROTATE': { const p0 = ptIn(a[0]); if (!p0) return ERR('Invalid input'); return tx(mAbout(p0, mRotate(numIn(a[1]))), false, 'ROTATE'); }
        case 'SCALEENTITY': { const p0 = ptIn(a[0]), s = numIn(a[1]); if (!p0 || !(s > 0)) return ERR('Invalid input'); return tx(mAbout(p0, mScale(s)), false, 'SCALE'); }
        case 'MIRROR': { const p0 = ptIn(a[0]), p1 = ptIn(a[1]); if (!p0 || !p1) return ERR('Invalid input'); return tx(mMirror(p0, p1), true, 'MIRROR'); }
        case 'GETBOUNDINGBOX': { const bb = entityBounds(e, doc.blocks); if (!bb) return ERR('Invalid extents'); return { min: [bb.minX, bb.minY, 0], max: [bb.maxX, bb.maxY, 0] }; }
        case 'GETATTRIBUTES': case 'GETCONSTANTATTRIBUTES': {
          if (e.type !== 'insert' || f.b) return { arr: [], vt: 9 };
          const defs = doc.blocks.get(e.block)?.attdefs || [];
          const tags = M === 'GETCONSTANTATTRIBUTES' ? defs.filter((x) => x.constant).map((x) => x.tag) : [...new Set([...defs.filter((x) => !x.constant).map((x) => x.tag), ...Object.keys(e.attrs || {})])];
          return { arr: tags.map((tag) => ({ vla: { kind: 'Att', key: e.id, tag } })), vt: 9 };
        }
        case 'EXPLODE': {
          if (e.type !== 'insert' || f.b) return ERR('Invalid input');
          const parts = explodeEntity(e, doc.blocks) || [];
          const made = parts.map((x) => addTo(f.map, x, 'EXPLODE'));
          return { arr: made.map((x) => ({ vla: x })), vt: 9 };
        }
        default: break;
      }
    }
    if (hh.kind === 'Att' && M === 'DELETE') return ERR('Invalid input');
    return ERR('Unknown method: ' + M);
  };

  const METHODS = {
    App: ['ZOOMEXTENTS', 'ZOOMALL', 'UPDATE'], Doc: ['REGEN', 'STARTUNDOMARK', 'ENDUNDOMARK', 'HANDLETOOBJECT', 'PURGEALL'],
    Blocks: ['ITEM', 'ADD'], Layers: ['ITEM', 'ADD'], Layouts: ['ITEM'], Linetypes: ['ITEM'], TextStyles: ['ITEM'], DimStyles: ['ITEM'], Views: ['ITEM'], Documents: ['ITEM'],
    Block: ['ITEM', 'DELETE', 'ADDLINE', 'ADDCIRCLE', 'ADDARC', 'ADDPOINT', 'ADDTEXT', 'ADDMTEXT', 'ADDLIGHTWEIGHTPOLYLINE', 'INSERTBLOCK'], Layer: ['DELETE'], Layout: ['DELETE'],
    Ent: ['DELETE', 'COPY', 'MOVE', 'ROTATE', 'SCALEENTITY', 'MIRROR', 'GETBOUNDINGBOX', 'HIGHLIGHT', 'UPDATE'], Att: ['UPDATE'],
  };

  switch (op) {
    case 'get': return get(h, String(args[0]).toUpperCase());
    case 'put': return put(h, String(args[0]).toUpperCase(), args[1]);
    case 'call': return call(h, String(args[0]).toUpperCase(), args[1] || []);
    case 'has': { const r = get(h, String(args[0]).toUpperCase()); if (r && r.error) return false; if (!args[1]) return true; return !['OBJECTNAME', 'HANDLE', 'COUNT', 'EFFECTIVENAME', 'AREA', 'LENGTH', 'ISLAYOUT', 'ISXREF', 'HASATTRIBUTES'].includes(String(args[0]).toUpperCase()); }
    case 'can': { const M = String(args[0]).toUpperCase(); return (METHODS[h.kind] || []).includes(M) || (h.kind === 'Ent' && ['GETATTRIBUTES', 'EXPLODE'].includes(M) && ent(h)?.e?.type === 'insert'); }
    case 'items': {
      if (h.kind === 'Block') { const items = blockItems(findBlock(h.key) || h.key); return items || ERR('Object was erased'); }
      const items = collItems(h.kind);
      return items || ERR('Not a collection');
    }
    case 'fromEname': {
      const id = h;
      if (typeof id === 'string' && id.startsWith('b:')) { const f = H.find(id); return f ? { vla: memberH(f.block, f.e) } : ERR('Invalid input'); }
      if (typeof id === 'string' && id.startsWith('a:')) { const m = /^a:(\d+):(.*)$/.exec(id); return m && H.subOf(id) ? { vla: { kind: 'Att', key: +m[1], tag: m[2] } } : ERR('Invalid input'); }
      if (typeof id === 'string' && id.startsWith('T:')) { const [, table, name] = id.match(/^T:([^:]+):(.*)$/) || []; return table === 'LAYER' ? { vla: { kind: 'Layer', key: name } } : table === 'BLOCK' ? { vla: { kind: 'Block', key: name } } : ERR('Invalid input'); }
      return H.find(id) ? { vla: entH(id) } : ERR('Invalid input');
    }
    case 'toEname': {
      if (h.kind !== 'Ent') return null;
      if (typeof h.key === 'number') return H.find(h.key) ? h.key : null;
      const f = member(h.key);
      return f ? 'b:' + f.b.name + ':' + f.idx : null;
    }
    case 'erased': return h.kind === 'Ent' ? !ent(h) : false;
    default: return ERR('Unknown operation');
  }
}
