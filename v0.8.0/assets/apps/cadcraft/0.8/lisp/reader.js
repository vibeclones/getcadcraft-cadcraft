/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: reader errors are the language's own messages ("malformed list on input"), as routines expect. */
/**
 * reader.js — LISP source text → forms (0.4 part 2, Y.2; session cad-lisp). DOM-free.
 *
 *   readAll(text)          → [form…]          a whole file (load, APPLOAD); throws LispError on a broken file
 *   readOne(text)          → { form, rest }    the first form only (the read function)
 *   decodeSource(bytes)    → text              UTF-8, or Windows-1252 when the bytes are not UTF-8 (older .lsp files)
 *
 * Syntax (AutoLISP reference): ( ) ' . "strings" with \\ \" \n \r \t \e and \nnn (octal), ; comments to the end of the
 * line and ;| inline |; comments, integers (32-bit; larger ones read as reals), reals (1. .5 1e3), symbols (any other run
 * of characters, read in upper case). A ( … . x) dotted pair needs spaces round the dot.
 */
import { sym, int, Cons, QUOTE, LispError } from './types.js';

const DELIM = /[\s()'";]/;
const INT_RE = /^[+-]?\d+$/;
const REAL_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?$/i;

export function decodeSource(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(u8); }
}

class Src {
  constructor(text) { this.s = String(text); this.i = 0; }
  skip() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
      if (s[this.i] !== ';') return;
      if (s[this.i + 1] === '|') {   // ;| inline comment |;
        const end = s.indexOf('|;', this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
      } else {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      }
    }
  }
  /** The next form; undefined at the end. */
  form(depth = 0) {
    this.skip();
    const s = this.s;
    if (this.i >= s.length) return undefined;
    const ch = s[this.i];
    if (ch === '(') {
      this.i++;
      const items = [];
      let tail = null;
      for (;;) {
        this.skip();
        if (this.i >= s.length) throw new LispError('malformed list on input', { incomplete: true });
        if (s[this.i] === ')') { this.i++; break; }
        if (s[this.i] === '.' && (this.i + 1 >= s.length || DELIM.test(s[this.i + 1])) && items.length) {
          this.i++;
          tail = this.form(depth + 1);
          if (tail === undefined) throw new LispError('malformed list on input', { incomplete: true });
          this.skip();
          if (s[this.i] !== ')') throw new LispError('malformed list on input');
          this.i++;
          break;
        }
        const f = this.form(depth + 1);
        if (f === undefined) throw new LispError('malformed list on input', { incomplete: true });
        items.push(f);
      }
      let r = tail;
      for (let k = items.length - 1; k >= 0; k--) r = new Cons(items[k], r);
      return r;
    }
    if (ch === ')') { this.i++; if (depth === 0) throw new LispError('extra right paren on input'); return undefined; }
    if (ch === "'") {
      this.i++;
      const f = this.form(depth + 1);
      if (f === undefined) throw new LispError('malformed list on input', { incomplete: true });
      return new Cons(QUOTE, new Cons(f, null));
    }
    if (ch === '"') return this.string();
    let j = this.i;
    while (j < s.length && !DELIM.test(s[j])) j++;
    const tok = s.slice(this.i, j);
    this.i = j;
    return atom(tok);
  }
  string() {
    const s = this.s;
    let out = '';
    this.i++;
    for (;;) {
      if (this.i >= s.length) throw new LispError('malformed string on input', { incomplete: true });
      const c = s[this.i++];
      if (c === '"') return out;
      if (c !== '\\') { out += c; continue; }
      const e = s[this.i++];
      if (e === 'n') out += '\n';
      else if (e === 'r') out += '\r';
      else if (e === 't') out += '\t';
      else if (e === 'e') out += '\x1b';
      else if (/[0-7]/.test(e || '')) {
        let oct = e;
        while (oct.length < 3 && /[0-7]/.test(s[this.i] || '')) oct += s[this.i++];
        out += String.fromCharCode(parseInt(oct, 8));
      } else if (e !== undefined) out += e;
    }
  }
}

function atom(tok) {
  if (INT_RE.test(tok)) {
    const n = Number(tok);
    return n >= -2147483648 && n <= 2147483647 ? int(n) : n;
  }
  if (REAL_RE.test(tok)) return Number(tok);
  if (/^nil$/i.test(tok)) return null;
  return sym(tok);
}

export function readAll(text) {
  const src = new Src(text);
  const out = [];
  for (;;) {
    const f = src.form();
    if (f === undefined) { src.skip(); if (src.i >= src.s.length) break; continue; }
    out.push(f);
  }
  return out;
}

export function readOne(text) {
  const src = new Src(text);
  const form = src.form();
  return { form: form === undefined ? null : form, rest: src.s.slice(src.i) };
}

/** Is this text a complete set of forms (command line: keep reading lines until the parens balance)? */
export function balanced(text) {
  try { readAll(text); return true; } catch (e) { return !e.incomplete; }
}
