/* SPDX-License-Identifier: Apache-2.0 */
/**
 * symbols.js — the P&ID symbol library (0.7 LC.5, session plant-design). DOM-free (tested in Node).
 *
 * Every shape here is drawn by CadCraft, in code, from the common ideas of the process-diagram standards: ISA-5.1 (instrument
 * identification and the balloon shapes), ISO 10628-2 (graphical symbols for chemical and process engineering diagrams) and
 * ISO 14617 (graphical symbols for diagrams). No vendor's symbol library, no standard's own artwork, is copied or traced; the
 * standards give the idea of a shape (a bow tie for a valve, a circle for a pump), not our lines. A drafting aid, not an
 * engineering approval: the help says so.
 *
 * The drawings in this file (the shapes in SYMBOLS and ACT) are dedicated to the public domain by CadCraft under CC0 1.0
 * (https://creativecommons.org/publicdomain/zero/1.0/): copy, change and sell them with no condition. The code around them is
 * Apache-2.0 like the rest of the add-on.
 *
 * A symbol is a record in SYMBOLS:
 *   group    valve | equip | inst | line | conn
 *   std      the standard whose idea it follows ('ISO 10628', 'ISA-5.1', 'ISO 14617')
 *   w, h     the extent in units of the symbol's size l (l = 1 is a valve's length, an instrument balloon's diameter)
 *   tagged   'required' (the check wants a tag) | 'optional' | 'none'
 *   prefix   the letters a new tag starts with ('P' → P-101); instruments take their letters from the person
 *   conn     connection points: [{ x, y, a (the direction a line leaves in, radians), n (name) }], in units of l
 *   shape()  the entities in units of l, about the origin (drawn once, scaled by drawSymbol)
 * Valves have a body and an optional actuator (ACTUATORS); the actuator sits on top of the body.
 *
 *   drawSymbol(data) → entities for { sym, act, l, tag } (the symbol, its actuator, its label), in drawing units
 *   connPoints(data) → [{ x, y, a, n }] in the symbol's own frame, drawing units (the object's x, y, rot place them)
 *   splitTag(tag) → { fn, num } (an instrument tag: letters over number)
 */

export const GROUPS = ['valve', 'equip', 'inst', 'line', 'conn'];
export const ACTUATORS = ['none', 'diaphragm', 'motor', 'solenoid', 'piston', 'manual'];
export const LIMITS = { tag: 24, text: 60, attrs: 12 };

// ---------------------------------------------------------------------------------------------------- drawing helpers (unit space)
const L = (x1, y1, x2, y2, extra) => ({ type: 'line', x1, y1, x2, y2, ...extra });
const poly = (pts, closed = true) => ({ type: 'poly', closed, pts: pts.map(([x, y]) => ({ x, y, b: 0 })) });
const fill = (pts) => ({ type: 'hatch', solid: true, loops: [pts.flat()] });
const circle = (cx, cy, r) => ({ type: 'circle', cx, cy, r });
const arc = (cx, cy, r, a0, a1) => ({ type: 'arc', cx, cy, r, a0, a1 });
const text = (x, y, h, s, extra) => ({ type: 'text', x, y, h, rot: 0, s, ha: 'center', va: 'middle', ...extra });
const rect = (x0, y0, x1, y1) => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const PI = Math.PI;
const conn = (x, y, a, n) => ({ x, y, a, n });

const bow = () => [poly([[-0.5, -0.25], [-0.5, 0.25], [0, 0]]), poly([[0.5, -0.25], [0.5, 0.25], [0, 0]])];
const IN_OUT = [conn(-0.5, 0, PI, 'in'), conn(0.5, 0, 0, 'out')];

/** Entities scaled about the origin (text heights too). */
export function scale(ents, k) {
  const s = (v) => v * k;
  return ents.map((e) => {
    switch (e.type) {
      case 'line': return { ...e, x1: s(e.x1), y1: s(e.y1), x2: s(e.x2), y2: s(e.y2) };
      case 'circle': return { ...e, cx: s(e.cx), cy: s(e.cy), r: s(e.r) };
      case 'arc': return { ...e, cx: s(e.cx), cy: s(e.cy), r: s(e.r) };
      case 'poly': return { ...e, pts: e.pts.map((p) => ({ x: s(p.x), y: s(p.y), b: p.b || 0 })) };
      case 'hatch': return { ...e, loops: e.loops.map((l) => l.map(s)) };
      case 'text': return { ...e, x: s(e.x), y: s(e.y), h: s(e.h) };
      default: return e;
    }
  });
}

const ZIG = (x0, x1, y, n, amp) => {   // a zigzag from x0 to x1 at height y
  const pts = [[x0, y]];
  for (let i = 1; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y + (i % 2 ? amp : -amp)]);
  pts.push([x1, y]);
  return poly(pts, false);
};

// ---------------------------------------------------------------------------------------------------- the library
export const SYMBOLS = {
  // ---- valve bodies (flow along +x)
  gate: { group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => bow() },
  globe: { group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => [...bow(), fill(circlePts(0, 0, 0.1))] },
  ball: { group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => [...bow(), circle(0, 0, 0.12)] },
  check: { noAct: true, group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => [poly([[-0.5, -0.25], [-0.5, 0.25], [0, 0]]), poly([[0.5, -0.25], [0.5, 0.25], [0, 0]]), fill([[0.5, -0.25], [0.5, 0.25], [0, 0]])] },
  butterfly: { group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => [L(-0.5, -0.25, -0.5, 0.25), L(0.5, -0.25, 0.5, 0.25), L(-0.25, -0.25, 0.25, 0.25), fill(circlePts(0, 0, 0.06))] },
  plug: { group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => [...bow(), rect(-0.07, -0.07, 0.07, 0.07)] },
  needle: { group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => [...bow(), fill([[-0.06, 0.12], [0.06, 0.12], [0, 0]])] },
  diaphragm: { group: 'valve', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'optional', prefix: 'HV', conn: IN_OUT, shape: () => [...bow(), arc(0, 0, 0.14, 0, PI), L(-0.14, 0, 0.14, 0)] },
  angle: {
    group: 'valve', std: 'ISO 10628', w: 1, h: 1, tagged: 'optional', prefix: 'HV', conn: [conn(-0.5, 0, PI, 'in'), conn(0, -0.5, -PI / 2, 'out')],
    shape: () => [poly([[-0.5, -0.25], [-0.5, 0.25], [0, 0]]), poly([[-0.25, -0.5], [0.25, -0.5], [0, 0]])],
  },
  threeway: {
    group: 'valve', std: 'ISO 10628', w: 1, h: 1, tagged: 'optional', prefix: 'HV', conn: [conn(-0.5, 0, PI, 'a'), conn(0.5, 0, 0, 'b'), conn(0, -0.5, -PI / 2, 'c')],
    shape: () => [...bow(), poly([[-0.25, -0.5], [0.25, -0.5], [0, 0]])],
  },
  relief: {
    noAct: true, group: 'valve', std: 'ISO 10628', w: 1, h: 1.1, tagged: 'required', prefix: 'PSV', conn: [conn(0, -0.5, -PI / 2, 'in'), conn(0.5, 0, 0, 'out')],
    shape: () => [poly([[-0.25, -0.5], [0.25, -0.5], [0, 0]]), poly([[0.5, -0.25], [0.5, 0.25], [0, 0]]), poly([[0, 0], [0.1, 0.1], [-0.1, 0.2], [0.1, 0.3], [-0.1, 0.4], [0, 0.5]], false)],
  },
  rupture: {
    noAct: true, group: 'valve', std: 'ISO 10628', w: 0.5, h: 0.7, tagged: 'required', prefix: 'PSE', conn: [conn(-0.25, 0, PI, 'in'), conn(0.25, 0, 0, 'out')],
    shape: () => [L(-0.25, 0, -0.1, 0), L(0.1, 0, 0.25, 0), L(-0.1, -0.3, -0.1, 0.3), L(0.1, -0.3, 0.1, 0.3), arc(0, -0.3, 0.1, 0, PI)],
  },

  // ---- equipment (nozzles are the connection points)
  'vessel-v': {
    group: 'equip', std: 'ISO 10628', w: 0.5, h: 1.1, tagged: 'required', prefix: 'V',
    conn: [conn(0, 0.55, PI / 2, 'top'), conn(0, -0.55, -PI / 2, 'bottom'), conn(-0.25, 0.15, PI, 'left'), conn(0.25, -0.15, 0, 'right')],
    shape: () => [L(-0.25, -0.3, -0.25, 0.3), L(0.25, -0.3, 0.25, 0.3), arc(0, 0.3, 0.25, 0, PI), arc(0, -0.3, 0.25, PI, 2 * PI)],
  },
  'vessel-h': {
    group: 'equip', std: 'ISO 10628', w: 1.1, h: 0.5, tagged: 'required', prefix: 'V',
    conn: [conn(-0.55, 0, PI, 'left'), conn(0.55, 0, 0, 'right'), conn(0.1, 0.25, PI / 2, 'top'), conn(-0.1, -0.25, -PI / 2, 'bottom')],
    shape: () => [L(-0.3, 0.25, 0.3, 0.25), L(-0.3, -0.25, 0.3, -0.25), arc(0.3, 0, 0.25, -PI / 2, PI / 2), arc(-0.3, 0, 0.25, PI / 2, (3 * PI) / 2)],
  },
  tank: {
    group: 'equip', std: 'ISO 10628', w: 0.8, h: 0.7, tagged: 'required', prefix: 'T',
    conn: [conn(0, 0.35, PI / 2, 'top'), conn(0, -0.35, -PI / 2, 'bottom'), conn(-0.4, -0.2, PI, 'left'), conn(0.4, -0.2, 0, 'right')],
    shape: () => [poly([[-0.4, -0.35], [-0.4, 0.2], [0, 0.35], [0.4, 0.2], [0.4, -0.35]])],
  },
  sphere: {
    group: 'equip', std: 'ISO 10628', w: 0.8, h: 0.8, tagged: 'required', prefix: 'T',
    conn: [conn(0, 0.4, PI / 2, 'top'), conn(0, -0.4, -PI / 2, 'bottom'), conn(-0.4, 0, PI, 'left'), conn(0.4, 0, 0, 'right')],
    shape: () => [circle(0, 0, 0.4)],
  },
  column: {
    group: 'equip', std: 'ISO 10628', w: 0.4, h: 1.6, tagged: 'required', prefix: 'C',
    conn: [conn(0, 0.8, PI / 2, 'top'), conn(0, -0.8, -PI / 2, 'bottom'), conn(-0.2, 0, PI, 'feed'), conn(0.2, 0.4, 0, 'side')],
    shape: () => [L(-0.2, -0.6, -0.2, 0.6), L(0.2, -0.6, 0.2, 0.6), arc(0, 0.6, 0.2, 0, PI), arc(0, -0.6, 0.2, PI, 2 * PI), L(-0.2, 0.3, 0.2, 0.3), L(-0.2, 0.05, 0.2, 0.05), L(-0.2, -0.2, 0.2, -0.2), L(-0.2, -0.45, 0.2, -0.45)],
  },
  reactor: {
    group: 'equip', std: 'ISO 10628', w: 0.5, h: 1.1, tagged: 'required', prefix: 'R',
    conn: [conn(0, 0.55, PI / 2, 'top'), conn(0, -0.55, -PI / 2, 'bottom'), conn(-0.25, 0.15, PI, 'left'), conn(0.25, -0.15, 0, 'right')],
    shape: () => [L(-0.25, -0.3, -0.25, 0.3), L(0.25, -0.3, 0.25, 0.3), arc(0, 0.3, 0.25, 0, PI), arc(0, -0.3, 0.25, PI, 2 * PI), poly([[-0.15, -0.3], [0.15, -0.2], [-0.15, -0.1], [0.15, 0], [-0.15, 0.1], [0.15, 0.2]], false)],
  },
  'exch-shell': {
    group: 'equip', std: 'ISO 10628', w: 0.6, h: 0.6, tagged: 'required', prefix: 'E',
    conn: [conn(-0.3, 0, PI, 'tube in'), conn(0.3, 0, 0, 'tube out'), conn(-0.15, 0.3, PI / 2, 'shell in'), conn(0.15, -0.3, -PI / 2, 'shell out')],   // i18n-ignore: connection names are data, matched with the Plant add-on's nozzle names
    shape: () => [circle(0, 0, 0.3), poly([[-0.3, 0], [-0.15, 0.18], [-0.05, -0.18], [0.05, 0.18], [0.15, -0.18], [0.3, 0]], false)],
  },
  'exch-plate': {
    group: 'equip', std: 'ISO 10628', w: 0.4, h: 0.6, tagged: 'required', prefix: 'E',
    conn: [conn(-0.2, 0.3, PI / 2, 'hot in'), conn(0.2, -0.3, -PI / 2, 'hot out'), conn(0.2, 0.3, PI / 2, 'cold out'), conn(-0.2, -0.3, -PI / 2, 'cold in')],   // i18n-ignore: connection names are data, matched with the Plant add-on's nozzle names
    shape: () => [rect(-0.2, -0.3, 0.2, 0.3), L(-0.1, -0.3, -0.1, 0.3), L(0, -0.3, 0, 0.3), L(0.1, -0.3, 0.1, 0.3)],
  },
  aircooler: {
    group: 'equip', std: 'ISO 10628', w: 0.8, h: 0.35, tagged: 'required', prefix: 'AC',
    conn: [conn(-0.4, 0, PI, 'in'), conn(0.4, 0, 0, 'out')],
    shape: () => [rect(-0.4, -0.175, 0.4, 0.175), L(-0.2, -0.175, 0.2, 0.175), L(-0.2, 0.175, 0.2, -0.175)],
  },
  heater: {
    group: 'equip', std: 'ISO 10628', w: 0.6, h: 0.8, tagged: 'required', prefix: 'H',
    conn: [conn(-0.3, 0, PI, 'in'), conn(0.3, 0, 0, 'out'), conn(0, 0.4, PI / 2, 'stack')],
    shape: () => [rect(-0.3, -0.3, 0.3, 0.3), L(-0.06, 0.3, -0.06, 0.4), L(0.06, 0.3, 0.06, 0.4), ZIG(-0.25, 0.25, 0, 6, 0.15)],
  },
  'pump-cf': {
    group: 'equip', std: 'ISO 10628', w: 0.75, h: 0.5, tagged: 'required', prefix: 'P',
    conn: [conn(-0.25, 0, PI, 'suction'), conn(0.5, 0.25, 0, 'discharge')],
    shape: () => [circle(0, 0, 0.25), L(0, 0.25, 0.5, 0.25), poly([[-0.18, -0.18], [0, 0.0], [-0.18, 0.18]], false)],
  },
  'pump-pd': {
    group: 'equip', std: 'ISO 10628', w: 0.75, h: 0.5, tagged: 'required', prefix: 'P',
    conn: [conn(-0.25, 0, PI, 'suction'), conn(0.5, 0.25, 0, 'discharge')],
    shape: () => [circle(0, 0, 0.25), L(0, 0.25, 0.5, 0.25), circle(-0.08, 0, 0.08), circle(0.08, 0, 0.08)],
  },
  compressor: {
    group: 'equip', std: 'ISO 10628', w: 0.5, h: 0.5, tagged: 'required', prefix: 'K',
    conn: [conn(-0.25, 0, PI, 'suction'), conn(0.25, 0, 0, 'discharge')],
    shape: () => [circle(0, 0, 0.25), L(-0.17, 0.18, 0.25, 0.08), L(-0.17, -0.18, 0.25, -0.08)],
  },
  fan: {
    group: 'equip', std: 'ISO 10628', w: 0.5, h: 0.5, tagged: 'required', prefix: 'FN',
    conn: [conn(-0.25, 0, PI, 'in'), conn(0.25, 0, 0, 'out')],
    shape: () => [circle(0, 0, 0.25), L(0, 0, 0, 0.25), L(0, 0, 0.217, -0.125), L(0, 0, -0.217, -0.125)],
  },
  filter: {
    group: 'equip', std: 'ISO 10628', w: 0.5, h: 0.5, tagged: 'required', prefix: 'F',
    conn: [conn(-0.25, 0, PI, 'in'), conn(0.25, 0, 0, 'out')],
    shape: () => [rect(-0.25, -0.25, 0.25, 0.25), L(-0.25, 0.25, 0.25, -0.25, { lt: 'DASHED' })],
  },
  agitator: {
    group: 'equip', std: 'ISO 10628', w: 0.4, h: 0.8, tagged: 'optional', prefix: 'M',
    conn: [],
    shape: () => [L(0, 0.4, 0, -0.3), L(-0.15, -0.3, 0.15, -0.3), circle(0, 0.48, 0.08)],
  },

  // ---- instruments: balloons (diameter 1 = l); the tag's letters over its number sit inside
  'inst-field': { group: 'inst', std: 'ISA-5.1', w: 1, h: 1, tagged: 'required', prefix: '', conn: balloonConn(), shape: () => [circle(0, 0, 0.5)] },
  'inst-panel': { group: 'inst', std: 'ISA-5.1', w: 1, h: 1, tagged: 'required', prefix: '', conn: balloonConn(), shape: () => [circle(0, 0, 0.5), L(-0.5, 0, 0.5, 0)] },
  'inst-local': { group: 'inst', std: 'ISA-5.1', w: 1, h: 1, tagged: 'required', prefix: '', conn: balloonConn(), shape: () => [circle(0, 0, 0.5), L(-0.5, 0, 0.5, 0, { lt: 'DASHED' })] },
  'inst-shared': { group: 'inst', std: 'ISA-5.1', w: 1.1, h: 1.1, tagged: 'required', prefix: '', conn: balloonConn(0.55), shape: () => [rect(-0.55, -0.55, 0.55, 0.55), circle(0, 0, 0.5)] },
  'inst-computer': { group: 'inst', std: 'ISA-5.1', w: 1.1, h: 1, tagged: 'required', prefix: '', conn: [conn(0, 0.48, PI / 2, 'top'), conn(0, -0.48, -PI / 2, 'bottom'), conn(-0.55, 0, PI, 'left'), conn(0.55, 0, 0, 'right')], shape: () => [poly([[-0.55, 0], [-0.275, 0.48], [0.275, 0.48], [0.55, 0], [0.275, -0.48], [-0.275, -0.48]])] },
  'inst-plc': { group: 'inst', std: 'ISA-5.1', w: 1.1, h: 1.1, tagged: 'required', prefix: '', conn: balloonConn(0.55), shape: () => [rect(-0.55, -0.55, 0.55, 0.55), poly([[0, 0.5], [0.5, 0], [0, -0.5], [-0.5, 0]])] },

  // ---- in-line items (flow along +x, length 1)
  reducer: { group: 'line', std: 'ISO 10628', w: 1, h: 0.5, tagged: 'none', prefix: '', conn: IN_OUT, shape: () => [poly([[-0.5, -0.25], [0.5, -0.12], [0.5, 0.12], [-0.5, 0.25]])] },
  cap: { group: 'line', std: 'ISO 10628', w: 0.2, h: 0.5, tagged: 'none', prefix: '', conn: [conn(0, 0, PI, 'in')], shape: () => [L(0, -0.25, 0, 0.25), L(0, 0.25, -0.12, 0.25), L(0, -0.25, -0.12, -0.25)] },
  flange: { group: 'line', std: 'ISO 10628', w: 0.2, h: 0.5, tagged: 'none', prefix: '', conn: [conn(-0.1, 0, PI, 'in'), conn(0.1, 0, 0, 'out')], shape: () => [L(-0.1, -0.25, -0.1, 0.25), L(0.1, -0.25, 0.1, 0.25)] },
  'blind-flange': { group: 'line', std: 'ISO 10628', w: 0.3, h: 0.5, tagged: 'none', prefix: '', conn: [conn(-0.15, 0, PI, 'in')], shape: () => [L(-0.15, -0.25, -0.15, 0.25), fill([[0, -0.25], [0.1, -0.25], [0.1, 0.25], [0, 0.25]])] },
  spectacle: { group: 'line', std: 'ISO 10628', w: 0.8, h: 0.4, tagged: 'optional', prefix: 'SB', conn: IN_OUT.map((c) => ({ ...c, x: c.x * 0.8 })), shape: () => [circle(-0.12, 0, 0.12), fill(circlePts(0.12, 0, 0.12)), L(-0.4, 0, -0.24, 0), L(0.24, 0, 0.4, 0)] },
  union: { group: 'line', std: 'ISO 10628', w: 0.35, h: 0.6, tagged: 'none', prefix: '', conn: [conn(-0.17, 0, PI, 'in'), conn(0.17, 0, 0, 'out')], shape: () => [L(-0.17, -0.2, -0.17, 0.2), L(0, -0.3, 0, 0.3), L(0.17, -0.2, 0.17, 0.2)] },
  orifice: { group: 'line', std: 'ISA-5.1', w: 0.1, h: 0.7, tagged: 'optional', prefix: 'FE', conn: [conn(-0.05, 0, PI, 'in'), conn(0.05, 0, 0, 'out')], shape: () => [L(-0.05, -0.35, -0.05, 0.35), L(0.05, -0.35, 0.05, 0.35)] },
  strainer: { group: 'line', std: 'ISO 10628', w: 1, h: 0.8, tagged: 'optional', prefix: 'S', conn: IN_OUT, shape: () => [rect(-0.5, -0.12, 0.5, 0.12), L(-0.15, -0.12, -0.3, -0.5), L(0.15, -0.12, 0.3, -0.5), L(-0.3, -0.5, 0.3, -0.5)] },
  'sight-glass': { group: 'line', std: 'ISO 10628', w: 0.4, h: 0.4, tagged: 'optional', prefix: 'LG', conn: [conn(-0.2, 0, PI, 'in'), conn(0.2, 0, 0, 'out')], shape: () => [circle(0, 0, 0.2), L(-0.2, 0, 0.2, 0)] },
  'expansion-joint': { group: 'line', std: 'ISO 10628', w: 0.6, h: 0.5, tagged: 'optional', prefix: 'EJ', conn: [conn(-0.3, 0, PI, 'in'), conn(0.3, 0, 0, 'out')], shape: () => [L(-0.3, -0.25, -0.3, 0.25), L(0.3, -0.25, 0.3, 0.25), poly([[-0.3, 0], [-0.2, 0.2], [-0.1, -0.2], [0, 0.2], [0.1, -0.2], [0.2, 0.2], [0.3, 0]], false)] },
  'flame-arrestor': { group: 'line', std: 'ISO 10628', w: 0.6, h: 0.6, tagged: 'optional', prefix: 'FA', conn: [conn(-0.3, 0, PI, 'in'), conn(0.3, 0, 0, 'out')], shape: () => [poly([[0, 0.3], [0.3, 0], [0, -0.3], [-0.3, 0]]), L(-0.12, 0.12, 0.12, -0.12), L(-0.12, 0, 0, -0.12)] },
  'spec-break': { group: 'line', std: 'ISO 14617', w: 0.2, h: 0.6, tagged: 'none', prefix: '', conn: [conn(0, 0, PI, 'in'), conn(0, 0, 0, 'out')], shape: () => [fill([[-0.04, -0.3], [0.04, -0.3], [0.04, 0.3], [-0.04, 0.3]])] },

  // ---- connectors and line ends
  'offpage-out': { group: 'conn', std: 'ISO 14617', w: 1, h: 0.5, tagged: 'optional', prefix: '', conn: [conn(-0.5, 0, PI, 'line')], shape: () => [poly([[-0.5, 0.25], [0.2, 0.25], [0.5, 0], [0.2, -0.25], [-0.5, -0.25]])] },
  'offpage-in': { group: 'conn', std: 'ISO 14617', w: 1, h: 0.5, tagged: 'optional', prefix: '', conn: [conn(0.5, 0, 0, 'line')], shape: () => [poly([[0.5, 0.25], [-0.2, 0.25], [-0.5, 0], [-0.2, -0.25], [0.5, -0.25]])] },
  flow: { group: 'conn', std: 'ISO 14617', w: 0.4, h: 0.3, tagged: 'none', prefix: '', conn: [], shape: () => [fill([[-0.2, -0.15], [0.2, 0], [-0.2, 0.15]])] },
  vent: { group: 'conn', std: 'ISO 10628', w: 0.4, h: 0.8, tagged: 'none', prefix: '', conn: [conn(0, -0.4, -PI / 2, 'line')], shape: () => [L(0, -0.4, 0, 0.2), L(-0.15, 0.4, 0, 0.2), L(0.15, 0.4, 0, 0.2)] },
  drain: { group: 'conn', std: 'ISO 10628', w: 0.4, h: 0.8, tagged: 'none', prefix: '', conn: [conn(0, 0.4, PI / 2, 'line')], shape: () => [L(0, 0.4, 0, -0.1), L(-0.2, -0.1, 0.2, -0.1), L(-0.13, -0.2, 0.13, -0.2), L(-0.06, -0.3, 0.06, -0.3)] },
  tiein: { group: 'conn', std: 'ISO 14617', w: 0.6, h: 0.6, tagged: 'optional', prefix: 'TI', conn: [conn(-0.3, 0, PI, 'line')], shape: () => [circle(0, 0, 0.3)] },
};

function circlePts(cx, cy, r, n = 16) {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * PI * i) / n), cy + r * Math.sin((2 * PI * i) / n)]);
}
function balloonConn(r = 0.5) { return [conn(0, r, PI / 2, 'top'), conn(0, -r, -PI / 2, 'bottom'), conn(-r, 0, PI, 'left'), conn(r, 0, 0, 'right')]; }

export const SYMBOL_IDS = Object.keys(SYMBOLS);
export const idsOf = (group) => SYMBOL_IDS.filter((k) => SYMBOLS[k].group === group);
export const isInstrument = (sym) => SYMBOLS[sym]?.group === 'inst';
export const isEquipment = (sym) => SYMBOLS[sym]?.group === 'equip';
export const isValve = (sym) => SYMBOLS[sym]?.group === 'valve';

// ---------------------------------------------------------------------------------------------------- tags
/** An instrument tag "FIC-101" / "FIC 101" / "TT-12A" → { fn: 'FIC', num: '101' }; anything else → { fn: tag, num: '' }. */
export function splitTag(tag) {
  const s = String(tag || '').trim();
  const m = /^([A-Za-z]{1,6})[\s-]*(\d+[A-Za-z]?(?:[-/]\w+)?)$/.exec(s);
  return m ? { fn: m[1].toUpperCase(), num: m[2].toUpperCase() } : { fn: s, num: '' };
}

/** The data of a symbol, cleaned (untrusted: a file someone sent). → data | null */
export function cleanSymbol(raw) {
  if (!raw || typeof raw !== 'object' || !SYMBOLS[raw.sym]) return null;
  const l = Number(raw.l);
  if (!(l > 0) || !Number.isFinite(l)) return null;
  const str = (v, n = LIMITS.text) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const attrs = {};
  if (raw.attrs && typeof raw.attrs === 'object') for (const k of Object.keys(raw.attrs).slice(0, LIMITS.attrs)) if (/^[a-z][a-z0-9_]{0,15}$/.test(k)) attrs[k] = str(raw.attrs[k]);
  return {
    sym: raw.sym, act: isValve(raw.sym) && !SYMBOLS[raw.sym].noAct && ACTUATORS.includes(raw.act) ? raw.act : 'none', l,
    tag: str(raw.tag, LIMITS.tag), desc: str(raw.desc), attrs,
  };
}

// ---------------------------------------------------------------------------------------------------- drawing
const ACT = {
  none: () => [],
  manual: () => [L(0, 0, 0, 0.35), L(-0.15, 0.35, 0.15, 0.35)],
  diaphragm: () => [L(0, 0, 0, 0.35), arc(0, 0.35, 0.17, 0, PI), L(-0.17, 0.35, 0.17, 0.35)],
  motor: () => [L(0, 0, 0, 0.37), circle(0, 0.52, 0.15), text(0, 0.52, 0.17, 'M')],
  solenoid: () => [L(0, 0, 0, 0.35), rect(-0.14, 0.35, 0.14, 0.6), text(0, 0.475, 0.17, 'S')],
  piston: () => [L(0, 0, 0, 0.35), rect(-0.15, 0.35, 0.15, 0.6), L(-0.15, 0.45, 0.15, 0.45)],
};

const lows = new Map();
/** The lowest y of a symbol's own drawing (units of l): its tag is written just under it. */
function lowest(id) {
  if (lows.has(id)) return lows.get(id);
  let y = Infinity;
  for (const e of SYMBOLS[id].shape()) {
    if (e.type === 'line') y = Math.min(y, e.y1, e.y2);
    else if (e.type === 'circle') y = Math.min(y, e.cy - e.r);
    else if (e.type === 'arc') { const full = Math.abs(e.a1 - e.a0) >= Math.PI * 1.5; y = Math.min(y, full || (e.a0 <= (3 * Math.PI) / 2 && e.a1 >= (3 * Math.PI) / 2) ? e.cy - e.r : Math.min(e.cy + e.r * Math.sin(e.a0), e.cy + e.r * Math.sin(e.a1))); }
    else if (e.type === 'poly') for (const p of e.pts) y = Math.min(y, p.y);
    else if (e.type === 'hatch') for (const l of e.loops) for (let i = 1; i < l.length; i += 2) y = Math.min(y, l[i]);
  }
  lows.set(id, Number.isFinite(y) ? y : -SYMBOLS[id].h / 2);
  return lows.get(id);
}

/** The entities of a placed symbol (cleaned data), about its origin, in drawing units. */
export function drawSymbol(d) {
  const def = SYMBOLS[d.sym];
  if (!def) return [];
  const out = [...def.shape()];
  if (def.group === 'valve' && d.act !== 'none') out.push(...ACT[d.act]());
  const { fn, num } = splitTag(d.tag);
  if (def.group === 'inst' || def.group === 'conn' && (d.sym === 'offpage-out' || d.sym === 'offpage-in' || d.sym === 'tiein')) {
    if (def.group === 'inst') {
      const th = 0.2;
      if (fn) out.push(text(0, num ? 0.13 : 0, th, fn.slice(0, 8)));
      if (num) out.push(text(0, -0.17, th, num.slice(0, 8)));
    } else if (d.tag) out.push(text(0, 0, 0.17, d.tag.slice(0, 10)));
  } else if (d.tag) {
    out.push(text(0, lowest(d.sym) - 0.14, 0.17, d.tag, { va: 'top' }));
  }
  return scale(out, d.l);
}

/** Where a signal reaches an actuator: the top of its drawing, in units of l (a hand wheel takes no signal). */
export const ACT_TOP = { diaphragm: 0.52, motor: 0.67, solenoid: 0.6, piston: 0.6 };

/** The connection points of a placed symbol in its own frame, drawing units (a valve's actuator adds `actuator`). */
export function connPoints(d) {
  const def = SYMBOLS[d.sym];
  if (!def) return [];
  const out = def.conn.map((c) => ({ x: c.x * d.l, y: c.y * d.l, a: c.a, n: c.n }));
  if (def.group === 'valve' && ACT_TOP[d.act]) out.push({ x: 0, y: ACT_TOP[d.act] * d.l, a: PI / 2, n: 'actuator' });
  return out;
}

/** A symbol's extent in drawing units: { w, h }. */
export function extent(d) {
  const def = SYMBOLS[d.sym];
  return def ? { w: def.w * d.l, h: (def.h + (def.group === 'valve' && d.act !== 'none' ? 0.6 : 0)) * d.l } : { w: 0, h: 0 };
}

/** How many shapes the library has, by group (the help and the tests quote it). */
export function counts() {
  const by = {};
  for (const k of SYMBOL_IDS) by[SYMBOLS[k].group] = (by[SYMBOLS[k].group] || 0) + 1;
  return { symbols: SYMBOL_IDS.length, actuators: ACTUATORS.length - 1, by };
}

/** Entities turned by `ang` about the origin and moved to p (the preview while placing; a placed symbol is turned by its reference). */
export function placeEnts(ents, p, ang = 0) {
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

/** Does this symbol sit IN a line (two connections facing each other on its x axis)? Such a symbol breaks the line it is put on. */
export function isInline(sym) {
  const d = SYMBOLS[sym];
  if (!d || d.conn.length !== 2) return false;
  const [a, b] = d.conn;
  return Math.abs(a.y) < 1e-9 && Math.abs(b.y) < 1e-9 && a.x < b.x + 1e-9 && Math.abs(Math.abs(a.a - b.a) - Math.PI) < 1e-9;
}
