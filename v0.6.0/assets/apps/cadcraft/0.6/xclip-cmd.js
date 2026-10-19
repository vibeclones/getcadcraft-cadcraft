/* SPDX-License-Identifier: Apache-2.0 */
/** xclip-cmd.js — registers XCLIP (xclip.js, 0.5 WL.16) through commands.js's command registry when imported (cadcraft.js; tests). */
import { commandRegistry } from './commands.js';
import { installXclip } from './xclip.js';

installXclip(commandRegistry.add, commandRegistry.option);
