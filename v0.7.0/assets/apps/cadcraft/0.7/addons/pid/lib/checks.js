/* SPDX-License-Identifier: Apache-2.0 */
/**
 * checks.js — the P&ID checks (0.7 LC.5). DOM-free. runChecks(model) → [{ code, level, vars, items: [uid…], at: {x, y} }], each
 * one something a person can find (PIDCHECK zooms to it). The message words come from the language file as `check.<code>`.
 *
 *   no-tag         error    a symbol that needs a tag (equipment, instruments, relief devices) has none
 *   dup-tag        error    two symbols with one full tag (a tag's case does not count; off-page connectors may repeat)
 *   open-end       error    a line end connected to nothing
 *   open-port      warning  a valve or in-line item with one side connected to nothing
 *   no-line-number warning  a process line with no line number
 *   no-loop        warning  an instrument tag with letters but no loop number
 *   ln-changes     warning  two process lines of different numbers meet end to end with nothing between them
 *                           (a reducer or spec break between them is the right way to change size or spec)
 *   inst-alone     warning  an instrument balloon with no line attached
 */

import { splitTag } from './symbols.js';
import { duplicates } from './tags.js';
import { linkedTo } from './model.js';

export function runChecks(model) {
  const out = [];
  const at = (x, y) => ({ x, y });
  const tagged = model.symbols.filter((s) => s.tag);

  for (const s of model.symbols) {
    if (s.def.tagged === 'required' && !s.tag) out.push({ code: 'no-tag', level: 'error', vars: { what: s.sym }, items: [s.uid], at: at(s.x, s.y) });
    if (s.group === 'inst' && s.tag && !splitTag(s.tag).num) out.push({ code: 'no-loop', level: 'warning', vars: { tag: s.tag }, items: [s.uid], at: at(s.x, s.y) });
  }
  const dups = duplicates(tagged.filter((s) => s.group !== 'conn').map((s) => s.tag));
  for (const [tag, n] of dups) {
    const those = tagged.filter((s) => s.group !== 'conn' && s.tag.trim().toUpperCase() === tag);
    out.push({ code: 'dup-tag', level: 'error', vars: { tag: those[0].tag, n }, items: those.map((s) => s.uid), at: at(those[0].x, those[0].y) });
  }

  for (const ln of model.lines) {
    ln.ends.forEach((end, i) => {
      const joined = linkedTo(model, ln.uid, 'end' + i);
      if (!joined.length) out.push({ code: 'open-end', level: 'error', vars: { ln: ln.ln || '—', style: ln.style }, items: [ln.uid], at: at(end.x, end.y) });
      else if (ln.style === 'process') {
        for (const j of joined) {
          const o = model.byUid.get(j.uid);
          if (o && j.kind === 'line' && j.at !== 'mid' && o.style === 'process' && o.ln !== ln.ln && (o.ln || ln.ln) && ln.uid < o.uid) {
            out.push({ code: 'ln-changes', level: 'warning', vars: { a: ln.ln || '—', b: o.ln || '—' }, items: [ln.uid, o.uid], at: at(end.x, end.y) });
          }
        }
      }
    });
    if (ln.style === 'process' && !ln.ln) {
      const m = ln.pts[Math.floor(ln.pts.length / 2)];
      out.push({ code: 'no-line-number', level: 'warning', vars: {}, items: [ln.uid], at: at(m[0], m[1]) });
    }
  }

  for (const s of model.symbols) {
    if (s.group === 'valve' || s.group === 'line') {
      const open = s.conns.filter((c) => c.n !== 'actuator' && !linkedTo(model, s.uid, c.n).length);
      if (open.length && open.length < s.conns.filter((c) => c.n !== 'actuator').length) out.push({ code: 'open-port', level: 'warning', vars: { what: s.tag || s.sym, port: open[0].n }, items: [s.uid], at: at(open[0].x, open[0].y) });
    }
    if (s.group === 'inst' && !s.conns.some((c) => linkedTo(model, s.uid, c.n).length)) out.push({ code: 'inst-alone', level: 'warning', vars: { tag: s.tag || s.sym }, items: [s.uid], at: at(s.x, s.y) });
  }
  const rank = { error: 0, warning: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
