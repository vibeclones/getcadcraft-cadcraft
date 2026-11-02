/* SPDX-License-Identifier: Apache-2.0 */
/**
 * wild.js — AutoLISP wildcard patterns (wcmatch, ssget filters; 0.4 part 2, Y.3; session cad-lisp). DOM-free, import-free.
 */
/** AutoLISP wildcard pattern → RegExp (# digit, @ letter, . neither, * any run, ? one, ~ not (first), [..] [~..], ` escape, "," or). */
export function wcRegex(pattern) {
  const alts = [];
  let cur = '', i = 0;
  const p = String(pattern);
  const parts = [];
  while (i < p.length) {
    const c = p[i];
    if (c === '`' && i + 1 < p.length) { cur += '`' + p[i + 1]; i += 2; continue; }
    if (c === ',') { parts.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  parts.push(cur);
  for (const part of parts) {
    let neg = false, s = part, re = '';
    if (s.startsWith('~')) { neg = true; s = s.slice(1); }
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === '`' && k + 1 < s.length) { re += escRe(s[++k]); continue; }
      if (c === '#') re += '[0-9]';
      else if (c === '@') re += '[A-Za-z]';
      else if (c === '.') re += '[^A-Za-z0-9]';
      else if (c === '*') re += '[\\s\\S]*';
      else if (c === '?') re += '[\\s\\S]';
      else if (c === '[') {
        const end = s.indexOf(']', k + 2);
        if (end < 0) { re += '\\['; continue; }
        let set = s.slice(k + 1, end), inv = false;
        if (set.startsWith('~')) { inv = true; set = set.slice(1); }
        re += '[' + (inv ? '^' : '') + set.replace(/[\\\]^]/g, '\\$&') + ']';
        k = end;
      } else re += escRe(c);
    }
    alts.push({ neg, re: new RegExp('^(?:' + re + ')$') });
  }
  return alts;
}
const escRe = (c) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
export function wcmatch(s, pattern) { return wcRegex(pattern).some(({ neg, re }) => re.test(s) !== neg); }

