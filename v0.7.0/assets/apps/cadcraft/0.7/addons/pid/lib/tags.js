/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tags.js — tags on a P&ID (0.7 LC.5). DOM-free (tested in Node).
 *
 * Equipment and valves take a prefix and a number ("P-101"); an instrument takes the letters of its function and a loop number
 * ("FIC-101"): the first letter is what is measured, the letters after it say what the instrument does with it. The letter
 * meanings below follow the common instrument-identification convention (the idea of ISA-5.1); the wording is ours and a
 * drafting aid, not the standard's table.
 *
 *   nextTag(tags, prefix)        the next free "PREFIX-n" among existing tags (numbers start at 101)
 *   nextLoop(tags)               the next loop number nobody uses among instrument tags (101, 102, …)
 *   functionOf(fn)               the letters read out: { variable: 'F', modifiers: ['I','C'] } | null
 *   FIRST, LATER                 the letter tables (keys; words come from the language file as `isa.first.F` / `isa.later.I`)
 *   duplicates(tags)             the full tags used more than once (case-insensitive) → Map<tag, count>
 */

import { splitTag } from './symbols.js';

export const FIRST = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
export const LATER = ['A', 'C', 'D', 'E', 'G', 'H', 'I', 'K', 'L', 'M', 'O', 'P', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function nextTag(tags, prefix, start = 101) {
  const re = new RegExp('^' + esc(prefix) + '[- ]?(\\d+)', 'i');
  let max = start - 1;
  for (const tg of tags) { const m = re.exec(String(tg || '')); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return prefix + '-' + (max + 1);
}

export function nextLoop(tags, start = 101) {
  let max = start - 1;
  for (const tg of tags) { const { num } = splitTag(tg); const m = /^(\d+)/.exec(num); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return String(max + 1);
}

export function functionOf(fn) {
  const s = String(fn || '').toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(s)) return null;
  const [variable, ...modifiers] = s.split('');
  if (!FIRST.includes(variable)) return null;
  return { variable, modifiers };
}

export function duplicates(tags) {
  const seen = new Map();
  for (const tg of tags) { const k = String(tg || '').trim().toUpperCase(); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
  return new Map([...seen].filter(([, n]) => n > 1));
}
