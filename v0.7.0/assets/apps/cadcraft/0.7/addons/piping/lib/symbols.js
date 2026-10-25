/* SPDX-License-Identifier: Apache-2.0 */
/**
 * symbols.js — the schematic symbols (0.5 MQ.2): valves and fittings on pipe runs, and a P&ID-style set to place on their own.
 * DOM-free. The shapes are drawn after the common conventions of process and instrumentation diagrams (ANSI/ISA-5.1 for the
 * instrument balloons, ISO 10628-2 for valve and equipment shapes); the drawings themselves are ours.
 *
 *   SYMBOLS                      every symbol key; VALVES — the ones that sit on a run
 *   drawSymbol(sym, L, H, tag)   CadCraft entities about the origin, the flow along +x: L long, H high
 *   placeEnts(ents, p, ang)      the same entities turned by ang and moved to p
 */

export const VALVES = ['gate', 'globe', 'ball', 'check', 'butterfly', 'plug', 'control', 'strainer', 'flange', 'union'];
export const SYMBOLS = [...VALVES, 'threeway', 'relief', 'reducer', 'cap', 'pump', 'instrument', 'panel', 'flow'];

const L = (x1, y1, x2, y2) => ({ type: 'line', x1, y1, x2, y2 });
const poly = (pts, closed = true) => ({ type: 'poly', closed, pts: pts.map(([x, y]) => ({ x, y, b: 0 })) });
const fill = (pts) => ({ type: 'hatch', solid: true, loops: [pts.flat()] });
const circle = (cx, cy, r) => ({ type: 'circle', cx, cy, r });
const disc = (cx, cy, r, n = 16) => fill(Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]));
const bow = (l, h) => [poly([[-l / 2, -h / 2], [-l / 2, h / 2], [0, 0]]), poly([[l / 2, -h / 2], [l / 2, h / 2], [0, 0]])];

/** A symbol about the origin, flow along +x, l long and h high; tag = a balloon's text ("PI 101": letters over the number). */
export function drawSymbol(sym, l, h = l / 2, tag = '') {
  switch (sym) {
    case 'gate': return bow(l, h);
    case 'globe': return [...bow(l, h), disc(0, 0, h / 5)];
    case 'ball': return [...bow(l, h), circle(0, 0, h / 4)];
    case 'check': return [poly([[-l / 2, -h / 2], [-l / 2, h / 2], [0, 0]]), poly([[l / 2, -h / 2], [l / 2, h / 2], [0, 0]]), fill([[l / 2, -h / 2], [l / 2, h / 2], [0, 0]])];
    case 'butterfly': return [L(-l / 2, -h / 2, -l / 2, h / 2), L(l / 2, -h / 2, l / 2, h / 2), L(-l / 4, -h / 2, l / 4, h / 2), disc(0, 0, h / 8)];
    case 'plug': return [...bow(l, h), poly([[-h / 6, -h / 6], [h / 6, -h / 6], [h / 6, h / 6], [-h / 6, h / 6]])];
    case 'control': return [...bow(l, h), L(0, 0, 0, h * 0.9), { type: 'arc', cx: 0, cy: h * 0.9, r: h / 2, a0: 0, a1: Math.PI }, L(-h / 2, h * 0.9, h / 2, h * 0.9)];
    case 'strainer': return [poly([[-l / 2, -h / 4], [l / 2, -h / 4], [l / 2, h / 4], [-l / 2, h / 4]]), L(-l / 6, -h / 4, l / 6, -h), L(0, -h / 4, l / 3, -h), L(l / 6, -h, l / 3, -h)];
    case 'flange': return [L(-l / 10, -h / 2, -l / 10, h / 2), L(l / 10, -h / 2, l / 10, h / 2)];
    case 'union': return [L(-l / 6, -h / 3, -l / 6, h / 3), L(0, -h / 2, 0, h / 2), L(l / 6, -h / 3, l / 6, h / 3)];
    case 'threeway': return [...bow(l, h), poly([[-h / 2, -l / 2], [h / 2, -l / 2], [0, 0]])];
    case 'relief': {
      const z = [];
      for (let i = 0; i < 4; i++) z.push([i % 2 ? h / 4 : -h / 4, h / 8 + (i * l) / 10]);
      return [poly([[-h / 2, -l / 2], [h / 2, -l / 2], [0, 0]]), poly([[l / 2, -h / 2], [l / 2, h / 2], [0, 0]]), poly([[0, 0], ...z], false)];
    }
    case 'reducer': return [poly([[-l / 2, -h / 2], [l / 2, -h / 4], [l / 2, h / 4], [-l / 2, h / 2]])];
    case 'cap': return [L(0, -h / 2, 0, h / 2), L(0, h / 2, -l / 6, h / 2), L(0, -h / 2, -l / 6, -h / 2)];
    case 'pump': return [circle(0, 0, l / 2), L(0, l / 2, l * 0.75, l / 2), L(l * 0.75, l / 2, l * 0.75, l * 0.3), poly([[-l * 0.35, -l * 0.35], [-l / 2, -l * 0.62], [l / 2, -l * 0.62], [l * 0.35, -l * 0.35]], false)];
    case 'instrument':
    case 'panel': {
      const out = [circle(0, 0, l / 2)];
      if (sym === 'panel') out.push(L(-l / 2, 0, l / 2, 0));
      const [a, ...b] = String(tag || '').trim().split(/\s+/);
      const th = l / 5;
      if (a) out.push({ type: 'text', x: 0, y: sym === 'panel' ? l / 8 : (b.length ? l / 10 : 0), h: th, rot: 0, s: a.slice(0, 8), ha: 'center', va: sym === 'panel' ? 'bottom' : 'middle' });
      if (b.length) out.push({ type: 'text', x: 0, y: sym === 'panel' ? -l / 8 : -l / 6, h: th, rot: 0, s: b.join(' ').slice(0, 8), ha: 'center', va: sym === 'panel' ? 'top' : 'middle' });
      return out;
    }
    case 'flow': return [fill([[-l / 2, -h / 2], [l / 2, 0], [-l / 2, h / 2]])];
    default: return [];
  }
}

/** Entities turned by `ang` about the origin and moved to p. */
export function placeEnts(ents, p, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const tx = (x, y) => [p.x + x * c - y * s, p.y + x * s + y * c];
  return ents.map((e) => {
    if (e.type === 'line') { const [x1, y1] = tx(e.x1, e.y1), [x2, y2] = tx(e.x2, e.y2); return { ...e, x1, y1, x2, y2 }; }
    if (e.type === 'circle') { const [cx, cy] = tx(e.cx, e.cy); return { ...e, cx, cy }; }
    if (e.type === 'arc') { const [cx, cy] = tx(e.cx, e.cy); return { ...e, cx, cy, a0: e.a0 + ang, a1: e.a1 + ang }; }
    if (e.type === 'poly') return { ...e, pts: e.pts.map((q) => { const [x, y] = tx(q.x, q.y); return { x, y, b: q.b || 0 }; }) };
    if (e.type === 'hatch') return { ...e, loops: e.loops.map((l) => { const o = []; for (let i = 0; i + 1 < l.length; i += 2) o.push(...tx(l[i], l[i + 1])); return o; }) };
    if (e.type === 'text') { const [x, y] = tx(e.x, e.y); return { ...e, x, y, rot: (e.rot || 0) + ang }; }
    return e;
  });
}
