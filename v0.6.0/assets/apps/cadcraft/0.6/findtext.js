/* SPDX-License-Identifier: Apache-2.0 */
/**
 * findtext.js — find and replace words in a drawing (FIND; 0.4 C31; owner: cad-draw). No DOM: bin/test-cadcraft.mjs
 * runs it in Node.
 *
 *   findMatches(entities, spec) → [{ id, kind: 'text' | 'attr' | 'dim', tag?, before, after, count }]
 *     spec { find, replace (null = only find), matchCase, whole (whole words), wildcard (* any run, ? one character),
 *            kinds: { text, attr, dim } (default all) }
 *     Text: a text's words (single-line and paragraph text). Attributes: the values of block references' attributes
 *     (constant ones belong to the block, so not). Dimensions: a dimension's own text (the measured value itself is
 *     not text: an override with <> keeps measuring).
 *   applyMatches(doc, matches) → the number of objects changed (inside the caller's doc.change)
 */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The search as a RegExp (global), or null when there is nothing to find. */
export function findRegExp({ find, matchCase = false, whole = false, wildcard = false }) {
  const f = String(find ?? '');
  if (!f) return null;
  let body = wildcard ? f.split('').map((ch) => (ch === '*' ? '[^\\n]*?' : ch === '?' ? '[^\\n]' : esc(ch))).join('') : esc(f);
  if (whole) body = '(?<![\\p{L}\\p{N}_])' + body + '(?![\\p{L}\\p{N}_])';
  return new RegExp(body, 'gu' + (matchCase ? '' : 'i'));
}

export function findMatches(entities, spec) {
  const re = findRegExp(spec);
  if (!re) return [];
  const kinds = { text: true, attr: true, dim: true, ...(spec.kinds || {}) };
  const out = [];
  const test = (s) => {
    re.lastIndex = 0;
    const n = (String(s).match(re) || []).length;
    if (!n) return null;
    re.lastIndex = 0;
    return { count: n, after: spec.replace === null || spec.replace === undefined ? null : String(s).replace(re, () => String(spec.replace)) };
  };
  for (const e of entities) {
    if ((e.type === 'text' || e.type === 'mleader') && kinds.text) { const r = test(e.s ?? ''); if (r) out.push({ id: e.id, kind: 'text', before: e.s, ...r }); }
    else if (e.type === 'insert' && kinds.attr && e.attrs) {
      for (const tag of Object.keys(e.attrs)) { const r = test(e.attrs[tag]); if (r) out.push({ id: e.id, kind: 'attr', tag, before: e.attrs[tag], ...r }); }
    } else if (e.type === 'dim' && kinds.dim && e.text) {
      // only the words, never the <> that stands for the measurement
      const parts = String(e.text).split('<>'), hits = parts.map(test);
      if (hits.some(Boolean)) out.push({ id: e.id, kind: 'dim', before: e.text, count: hits.reduce((a, h) => a + (h?.count || 0), 0), after: spec.replace === null || spec.replace === undefined ? null : parts.map((p, i) => hits[i]?.after ?? p).join('<>') });
    }
  }
  return out;
}

export function applyMatches(doc, matches) {
  const byId = new Map();
  for (const m of matches) { if (m.after === null) continue; let a = byId.get(m.id); if (!a) byId.set(m.id, (a = [])); a.push(m); }
  let n = 0;
  for (const [id, ms] of byId) {
    const e = doc.get(id);
    if (!e || !doc.editable(e)) continue;
    const next = { ...e };
    for (const m of ms) {
      if (m.kind === 'text') next.s = m.after;
      else if (m.kind === 'dim') { next.text = m.after; delete next.block; }   // drawn again with its new words
      else if (m.kind === 'attr') next.attrs = { ...next.attrs, [m.tag]: m.after };
    }
    if (m0(next) === '') continue;
    doc.update(id, next);
    n++;
  }
  return n;
}
/** A text cannot end up empty (it would vanish): such a replacement is skipped. */
const m0 = (e) => (e.type === 'text' ? String(e.s).trim() : 'x');   // (a multileader may lose its words: its leader stays)
