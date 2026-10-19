/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shortcuts.js — key combinations for buttons of your own (0.5 DR.9, My tools) and, later, any command (WL.18). DOM-free.
 *
 *   normKey(s)              'ctrl+shift+l' / 'Shift-Ctrl-L' / 'CTRL+SHIFT+L' → 'Ctrl+Shift+L' | null (not a key we take)
 *   keyOfEvent(e)           a keydown event (or { key, ctrlKey, metaKey, altKey, shiftKey }) → the same form | null
 *   RESERVED                keys CadCraft, the shell and the browser already use: never given to a tool
 *   keyProblem(k, taken)    why k can't be used ('format' | 'plain' | 'reserved' | 'taken'), or null; `taken` = Map key → owner
 *
 * A shortcut needs Ctrl (Cmd on a Mac counts as Ctrl) or Alt, or is a free function key (F2, F4–F6, F9): plain letters go
 * to the command line. Keys are written Ctrl+Alt+Shift+<key>, the key as a capital letter, a digit, F1–F12 or a name.
 */

const NAMED = { ESC: 'Escape', ESCAPE: 'Escape', DEL: 'Delete', DELETE: 'Delete', INS: 'Insert', INSERT: 'Insert', HOME: 'Home', END: 'End',
  PGUP: 'PageUp', PAGEUP: 'PageUp', PGDN: 'PageDown', PAGEDOWN: 'PageDown', SPACE: 'Space', TAB: 'Tab', ENTER: 'Enter', RETURN: 'Enter',
  LEFT: 'Left', RIGHT: 'Right', UP: 'Up', DOWN: 'Down', ARROWLEFT: 'Left', ARROWRIGHT: 'Right', ARROWUP: 'Up', ARROWDOWN: 'Down', BACKSPACE: 'Backspace' };

/** Keys already taken by CadCraft (cadcraft.js), the app shell (screen modes, settings, help) and the browser. */
export const RESERVED = new Set([
  'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+A', 'Ctrl+P', 'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Shift+V', 'Ctrl+D',
  'Ctrl+Shift+F', 'Ctrl+,', 'Ctrl+N', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Shift+T', 'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Ctrl+Q', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+L', 'Ctrl+F',
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', 'Alt+Left', 'Alt+Right', 'Alt+F4', 'Ctrl+0', 'Ctrl+=', 'Ctrl+-',
  'F1', 'F3', 'F7', 'F8', 'F10', 'F11', 'F12',
]);

/** A key combination in its one written form, or null. */
export function normKey(s) {
  if (typeof s !== 'string') return null;
  const raw = s.trim();
  if (!raw || raw.length > 40) return null;
  const parts = raw.split(/\s*[+-]\s*(?=.)/).filter(Boolean);
  if (raw.endsWith('++') || raw === '+') parts.push('+');
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    const u = p.toUpperCase();
    if (u === 'CTRL' || u === 'CONTROL' || u === 'CMD' || u === 'COMMAND' || u === 'META' || u === 'MOD') mods.add('Ctrl');
    else if (u === 'ALT' || u === 'OPTION' || u === 'OPT') mods.add('Alt');
    else if (u === 'SHIFT') mods.add('Shift');
    else if (key === null) key = keyName(p);
    else return null;   // two keys
  }
  if (!key) return null;
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key].join('+');
}

function keyName(p) {
  const u = p.toUpperCase();
  if (/^[A-Z0-9]$/.test(u)) return u;
  if (/^F([1-9]|1[0-2])$/.test(u)) return u;
  if (NAMED[u]) return NAMED[u];
  if (p.length === 1 && /[,.;'/\\[\]=`-]/.test(p)) return p;
  return null;
}

/** The combination a keydown is, in normKey's form (Cmd counts as Ctrl), or null for a modifier alone. */
export function keyOfEvent(e) {
  if (!e || typeof e.key !== 'string' || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.startsWith('Arrow')) k = k.slice(5);
  else if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
  else if (e.shiftKey && /^Digit\d$/.test(e.code || '')) k = e.code.slice(5);   // Shift+1 reads as '!': keep the digit
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  return normKey([...parts, k].join('+'));
}

/** Why a key can't be a tool's shortcut, or null. `taken`: Map key → who has it (another tool). */
export function keyProblem(k, taken = new Map()) {
  const n = normKey(k);
  if (!n) return 'format';
  const mods = n.split('+').slice(0, -1), key = n.split('+').pop();
  if (!mods.includes('Ctrl') && !mods.includes('Alt') && !/^F\d+$/.test(key)) return 'plain';
  if (RESERVED.has(n)) return 'reserved';
  if (taken.has(n)) return 'taken';
  return null;
}

// ---------------------------------------------------------------------------------------- keys for commands (0.5 WL.18)
/**
 * Shortcut keys for any command, kept per app (localStorage `cadcraft.shortcuts`): `{ format: 'cadcraft-shortcuts',
 * version: 1, keys: { 'Ctrl+Alt+L': 'LINE', 'F9': 'ZOOM E' } }` — a key runs that text at the command line (a command
 * and, optionally, what to type after it).
 *   cleanShortcuts(v, { known, taken }) → { keys: Map key → text, errors: [{ key, fills }] }   untrusted data made safe:
 *     `known(name)` says whether a command exists; `taken` = keys other things use (My tools), refused here
 */
export const SHORTCUTS_KEY = 'cadcraft.shortcuts';
export function cleanShortcuts(v, { known = () => true, taken = new Map() } = {}) {
  const keys = new Map(), errors = [];
  const src = v && typeof v === 'object' && v.format === 'cadcraft-shortcuts' && v.keys && typeof v.keys === 'object' ? v.keys : {};
  for (const [k0, text0] of Object.entries(src).slice(0, 300)) {
    const text = String(text0 ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    const k = normKey(k0);
    const why = !k ? 'format' : keyProblem(k, new Map([...taken, ...keys]));
    if (why) { errors.push({ key: 'keys.err.' + why, fills: { key: String(k0).slice(0, 40), other: taken.get(k) || keys.get(k) || '' } }); continue; }
    const cmd = text.split(/\s+/)[0];
    if (!cmd || !known(cmd)) { errors.push({ key: 'keys.err.command', fills: { key: k, cmd: cmd || '?' } }); continue; }
    keys.set(k, text);
  }
  return { keys, errors };
}
export const shortcutsData = (keys) => ({ format: 'cadcraft-shortcuts', version: 1, keys: Object.fromEntries(keys) });
