/* SPDX-License-Identifier: Apache-2.0 */
/**
 * macro.js — button macros in AutoCAD's menu macro syntax, read into steps the command line can run (0.5 DR.9). DOM-free.
 *
 *   parseMacro(text, { getvar }) → { steps, repeat, commands, notes }
 *     steps     [{ kind: 'cancel' } | { kind: 'send', text } | { kind: 'enter' } | { kind: 'pause' } | { kind: 'toggle', what }]
 *               'send' = type the text and press Enter; 'enter' = Enter alone; 'pause' = wait for the person's own answer
 *     repeat    the macro started with * (run it again each time it ends, until Esc)
 *     commands  the command names it starts (the first word after a cancel, or at the start), upper case, prefixes off
 *     notes     what was left out or not understood, as keys + fills for t() ({ key, fills })
 *
 * Syntax read: ^C cancel; ^M, ; and a space = Enter; \ = pause for input; ^O ortho, ^G grid (toggles); ^P, ^I and ^Q
 * ignored; a leading * repeats; _ (international), . (built-in) and ' (transparent) prefixes dropped from a word;
 * + at a line's end joins lines; $M=… is DIESEL for the whole macro. DIESEL: only $(if,…), $(getvar,…), $(=,…) and
 * $(eq,…) — anything else stops the macro with a note (said, never guessed).
 */

const MAX = 4000;

/** Evaluate the small DIESEL subset; throws { diesel: name } on anything else. */
export function diesel(src, getvar = () => '') {
  let i = 0;
  const s = String(src);
  function expr() {
    // $(name,arg,…) with nested $( … ); plain text otherwise
    let out = '';
    while (i < s.length) {
      if (s[i] === '$' && s[i + 1] === '(') { out += call(); continue; }
      if (s[i] === ',' || s[i] === ')') break;
      out += s[i++];
    }
    return out;
  }
  function call() {
    i += 2;
    const args = [];
    for (;;) {
      args.push(expr());
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ')') { i++; break; }
      throw Object.assign(new Error('diesel'), { diesel: 'syntax' });
    }
    const name = args.shift().trim().toLowerCase();
    if (name === 'getvar') { const v = getvar(String(args[0] || '').trim().toUpperCase()); return v === null || v === undefined ? '' : String(v); }
    if (name === 'if') { const c = String(args[0] || '').trim(); return c !== '' && c !== '0' ? (args[1] ?? '') : (args[2] ?? ''); }
    if (name === '=') return Number(args[0]) === Number(args[1]) ? '1' : '0';
    if (name === 'eq') return String(args[0]) === String(args[1]) ? '1' : '0';
    throw Object.assign(new Error('diesel'), { diesel: name });
  }
  const r = expr();
  return r + s.slice(i);
}

export function parseMacro(text, { getvar = () => '' } = {}) {
  const notes = [];
  let src = String(text ?? '').slice(0, MAX).replace(/\+\s*\r?\n\s*/g, '').replace(/\r?\n/g, ';');
  if (/^\$M=/i.test(src)) {
    try { src = diesel(src.slice(3), getvar); } catch (err) { return { steps: [], repeat: false, commands: [], notes: [{ key: 'mytools.note.diesel', fills: { name: err.diesel || '?' } }] }; }
  } else if (src.includes('$(')) {
    try { src = diesel(src, getvar); } catch (err) { return { steps: [], repeat: false, commands: [], notes: [{ key: 'mytools.note.diesel', fills: { name: err.diesel || '?' } }] }; }
  }
  const steps = [];
  let repeat = false, buf = '', atCommand = true;
  const commands = [];
  if (src.startsWith('*')) { repeat = true; src = src.slice(1); }
  const word = (w) => w.replace(/^['_.]+/, '').replace(/^['_.]+/, '');
  const flush = (enter) => {
    if (buf) {
      let txt = buf;
      if (atCommand) { txt = word(txt); if (txt) commands.push(txt.toUpperCase()); }
      steps.push({ kind: 'send', text: txt });
      atCommand = false;
    } else if (enter) steps.push({ kind: 'enter' });
    buf = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '^' && i + 1 < src.length) {
      const k = src[i + 1].toUpperCase();
      i++;
      if (k === 'C') { flush(false); steps.push({ kind: 'cancel' }); atCommand = true; continue; }
      if (k === 'M') { flush(true); continue; }
      if (k === 'O') { flush(false); steps.push({ kind: 'toggle', what: 'ortho' }); continue; }
      if (k === 'G') { flush(false); steps.push({ kind: 'toggle', what: 'grid' }); continue; }
      if (k === 'P' || k === 'I' || k === 'Q') continue;
      notes.push({ key: 'mytools.note.control', fills: { key: '^' + k } });
      continue;
    }
    if (ch === ';' || ch === ' ') { flush(true); continue; }
    if (ch === '\\') { flush(false); steps.push({ kind: 'pause' }); continue; }
    buf += ch;
  }
  flush(false);
  // a command typed with no Enter after it at the end still runs (AutoCAD sends what is left)
  return { steps, repeat, commands: [...new Set(commands)], notes };
}
