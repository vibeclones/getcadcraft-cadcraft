/* SPDX-License-Identifier: Apache-2.0 */
/**
 * support.js — acad.lsp and acaddoc.lsp from a support folder the person picked (0.7 D7.28). No DOM.
 *
 *   const folder = bridgeFolder(window.cadcraftDesktop, path)       Studio's folder over the desktop bridge
 *   const r = await readSupportFiles(folder, ['acad.lsp', 'acaddoc.lsp'])
 *     → { files: [{ name, text, kind: 'lsp', startup: true }], notes: [{ name, why: 'size' | 'read' }] }
 *
 * Names match whatever case the file has (Windows folders). Only those two names are read: the folder is not
 * searched for other files. A file over MAX_FILE is skipped with a note, as APPLOAD does. Compiled files
 * (.fas, .vlx) and native ones stay refused: they are not these names.
 */
import { decodeSource } from './reader.js';

export const SUPPORT_NAMES = ['acad.lsp', 'acaddoc.lsp'];
const MAX_FILE = 2 * 1024 * 1024;

/** A read-only folder over the desktop bridge: { path, list(), read(name) }. null when there is no bridge. */
export function bridgeFolder(bridge, path) {
  if (!bridge || typeof bridge.listDir !== 'function' || typeof bridge.readFile !== 'function' || !path) return null;
  const sep = /\\/.test(path) && !/\//.test(path) ? '\\' : '/';
  const join = (n) => path.replace(/[\\/]+$/, '') + sep + n;
  return {
    path,
    async list() { return (await bridge.listDir(path)).filter((e) => !e.dir).map((e) => e.name); },
    async read(name) { return bridge.readFile(join(name)); },
  };
}

export async function readSupportFiles(folder, names = SUPPORT_NAMES) {
  const files = [], notes = [];
  let have;
  try { have = await folder.list(); } catch { return { files, notes: [{ name: '', why: 'read' }] }; }
  for (const want of names) {
    const real = have.find((n) => n.toLowerCase() === want);
    if (!real) continue;
    try {
      const bytes = await folder.read(real);
      if (bytes.byteLength > MAX_FILE) { notes.push({ name: real, why: 'size' }); continue; }
      files.push({ name: real, text: decodeSource(bytes), kind: 'lsp', startup: true, support: true });
    } catch { notes.push({ name: real, why: 'read' }); }
  }
  return { files, notes };
}
