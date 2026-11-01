/* SPDX-License-Identifier: Apache-2.0 */
/**
 * aliases.js — command aliases from one text file (0.4 part 2, Y.8; session cad-lisp). DOM-free.
 *
 * The file is the familiar program-parameters format: one alias per line, `L,  *LINE`; ";" starts a comment. Lines that
 * run a program of the computer (`NOTEPAD, START, 1, *File to edit: ,`) are skipped with a note: a browser app can't.
 * The person's aliases sit on top of the built-in ones; REINIT (or Save in the editor) applies the file again.
 *
 *   parseAliases(text, { lookup }) → { entries: [{ alias, command, line }], skipped: [{ line, text }], errors: [{ line, msg }] }
 *   applyAliases(ctx, text)                    → { applied, errors }   ctx from lisp/install.js: { lookup, commands, aliases, builtinAliases, userAliases }
 *   exportPgp(ctx)                             → the built-in and the person's aliases as one file (Export)
 *   STORE_KEY                                  localStorage key of the person's file in the browser
 */
import { t } from './i18n.js';

export const STORE_KEY = 'cadcraft.aliases';
const NAME_RE = /^[A-Z0-9_.\-+?$#@~]{1,64}$/;

export const TEMPLATE = () => [
  t('aliases.file.head1'),
  t('aliases.file.head2'),
  t('aliases.file.head3'),
  ';',
  t('aliases.file.example'),
  ';   LL,     *LINE',
  '',
].join('\n');

export function parseAliases(text, { lookup = null } = {}) {
  const entries = [], skipped = [], errors = [];
  const seen = new Map();
  String(text ?? '').split(/\r?\n/).forEach((raw, k) => {
    const line = k + 1;
    const s = raw.replace(/;.*$/, '').trim();
    if (!s) return;
    const m = s.match(/^([^,\s]+)\s*,\s*(.*)$/);
    if (!m) { errors.push({ line, msg: t('aliases.err.format') }); return; }
    const alias = m[1].toUpperCase(), rest = m[2].trim();
    if (!rest.startsWith('*')) { skipped.push({ line, text: raw.trim() }); return; }
    const command = rest.slice(1).trim().split(/[\s,]/)[0].toUpperCase();
    if (!NAME_RE.test(alias)) { errors.push({ line, msg: t('aliases.err.name', { alias }) }); return; }
    if (!command) { errors.push({ line, msg: t('aliases.err.nocommand', { alias }) }); return; }
    const target = lookup ? lookup(command) : { name: command };
    if (!target) { errors.push({ line, msg: t('aliases.err.unknown', { alias, command }) }); return; }
    const own = lookup ? lookup(alias) : null;   // the alias is itself a command's name
    if (own && own.name === alias && own !== target) { errors.push({ line, msg: t('aliases.err.clash', { alias }) }); return; }
    if (seen.has(alias)) errors.push({ line, msg: t('aliases.err.twice', { alias, first: seen.get(alias) }) });
    seen.set(alias, line);
    entries.push({ alias, command: target.name || command, line });
  });
  return { entries, skipped, errors };
}

export function applyAliases(ctx, text) {
  const { aliases, builtinAliases, userAliases } = ctx;
  // take the previous file's aliases off, putting back any built-in one they covered
  for (const a of userAliases.keys()) { if (builtinAliases.has(a)) aliases.set(a, builtinAliases.get(a)); else aliases.delete(a); }
  userAliases.clear();
  const r = parseAliases(text, { lookup: ctx.lookup });
  for (const e of r.entries) { aliases.set(e.alias, e.command); userAliases.set(e.alias, e.command); }
  const errors = [...r.errors, ...r.skipped.map((s) => ({ line: s.line, msg: t('aliases.skipped.shell') }))];
  return { applied: r.entries.length, errors };
}

export function exportPgp(ctx) {
  const lines = [t('aliases.export.head'), ''];
  const all = new Map([...ctx.builtinAliases, ...ctx.userAliases]);
  for (const [a, c] of [...all].sort((x, y) => x[0].localeCompare(y[0]))) {
    const cmd = ctx.lookup ? ctx.lookup(c) : ctx.commands.get(c);
    if (!cmd || cmd.hidden) continue;
    lines.push((a + ',').padEnd(10) + '*' + c);
  }
  return lines.join('\r\n') + '\r\n';
}
