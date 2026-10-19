/* SPDX-License-Identifier: Apache-2.0 */
/**
 * runtime.js — one ready LISP interpreter with every function installed (0.4 part 2; session cad-lisp). DOM-free.
 * The worker (worker.js) and the Node tests both start here, so they run the same language.
 *
 *   const L = createLisp({ host, out });   host: host-cad.js's CadHost (Node, page) or the worker's bridge to it
 */
import { Interp } from './interp.js';
import { installBuiltins } from './builtins.js';
import { installCadFns } from './cadfns.js';
import { installVl } from './vl.js';
import { installVla } from './vla.js';
import { installDcl } from './dcl.js';
import { knownMissing } from './missing.js';

export function createLisp({ host = null, out = () => {}, yieldEvery = 0 } = {}) {
  const L = new Interp({ host, out, yieldEvery });
  installBuiltins(L);
  installCadFns(L);
  installVl(L);
  installVla(L);
  installDcl(L);
  L.knownMissing = knownMissing;
  return L;
}
