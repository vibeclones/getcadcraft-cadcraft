/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — the messages here are errors for add-on developers, never shown to people. */
/**
 * commands-api.js — the command registry add-ons and CadCraft's own feature sets register through (0.4 part 2, A.3;
 * docs/ADDONS-SPEC.md §5.4). Import-free, so commands.js can use it for its own installers without an import circle.
 *
 *   const reg = commandApi({ def, lookup, commands, aliases }, 'core');   // commands.js: its def() and the two Maps
 *   installLayerTools(reg.add, reg.option);                               // CadCraft's own feature sets
 *   const mine = reg.scoped('electrical');                                // an add-on's view: what it adds it can remove
 *   const remove = mine.add('WIRE', ['WI'], async (c) => { … }, { help: () => api.t('wire.help') });
 *
 * add(name, aliases, fn, extra) registers a command exactly like commands.js def() (fn(c, engine), one undo step), but a
 * name or alias already taken — a built-in, a LISP routine, another add-on — is refused with an Error: add-ons never
 * replace commands. Names: A–Z, digits and _, starting with a letter, ≤ 31; a leading "-" / "_" makes a command-line or
 * hidden form (-PARAMETERS). Aliases the same, and may start with a digit. Every add returns remove(), which takes the command and the aliases that still point at it away.
 * `owner(name)` says who registered a command ('core' or an add-on id; built-ins defined before the registry: null).
 */

const NAME_RE = /^[-_]?[A-Z][A-Z0-9_]{0,30}$/;   // a leading - or _ = a command-line / hidden form (-PARAMETERS)
const ALIAS_RE = /^[-_]?[A-Z0-9][A-Z0-9_]{0,30}$/;

export function commandApi({ def, lookup, commands, aliases }, defaultOwner = 'core') {
  const owners = new Map();   // name → owner

  // "-NAME" is its own command (lookup would strip the dash and find NAME): only the exact name counts there
  const taken = (n) => commands.has(n) || aliases.has(n) || (!/^[-_]/.test(n) && !!lookup(n));

  function add(owner, name, aliasList, fn, extra = {}) {
    const n = String(name ?? '').toUpperCase();
    if (!NAME_RE.test(n)) throw new Error('commands.add: "' + name + '" is not a command name (A–Z, 0–9, _; ≤ 31; starts with a letter, or - / _ and a letter)');
    if (typeof fn !== 'function') throw new Error('commands.add: ' + n + ' needs a function');
    const al = (Array.isArray(aliasList) ? aliasList : []).map((a) => String(a).toUpperCase());
    for (const a of al) if (!ALIAS_RE.test(a)) throw new Error('commands.add: "' + a + '" is not an alias');
    // CadCraft's own feature sets ('core') may give a name that is only an alias elsewhere a command of its own (a command
    // wins over an alias in lookup: layertools' PUBLISH over PLOT's old alias); add-ons may not.
    if (owner === 'core' ? commands.has(n) : taken(n)) throw new Error('commands.add: ' + n + ' is already a command');
    for (const a of al) if (a === n || taken(a)) throw new Error('commands.add: ' + a + ' is already a command or an alias');
    const ex = { ...(extra && typeof extra === 'object' ? extra : {}) };
    delete ex.name; delete ex.fn; delete ex.aliases;
    def(n, al, fn, ex);
    owners.set(n, owner);
    let gone = false;
    return function remove() {
      if (gone) return;
      gone = true;
      const c = commands.get(n);
      if (c && c.fn === fn) commands.delete(n);
      for (const a of al) if (aliases.get(a) === n) aliases.delete(a);
      if (owners.get(n) === owner) owners.delete(n);
    };
  }

  const option = (key, label) => ({ key: String(key), label: String(label ?? key) });

  const api = {
    add: (name, al, fn, extra) => add(defaultOwner, name, al, fn, extra),
    option,
    has: (name) => taken(String(name ?? '').toUpperCase()),
    owner: (name) => { const c = lookup(String(name ?? '')); return c ? owners.get(c.name) ?? null : null; },
    /** Everything one owner registered (names). */
    ownedBy: (owner) => [...owners].filter(([, o]) => o === owner).map(([n]) => n),
    /** The registry as one add-on sees it: its adds are its own, and removeAll() takes them away again. */
    scoped(owner) {
      const mine = [];
      return {
        add(name, al, fn, extra) { const r = add(owner, name, al, fn, extra); mine.push(r); return r; },
        option,
        has: api.has,
        removeAll() { while (mine.length) mine.pop()(); },
      };
    },
  };
  return api;
}
