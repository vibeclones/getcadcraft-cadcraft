/* SPDX-License-Identifier: Apache-2.0 */
/**
 * propcmds.js — the Properties panel's commands (0.4 track P; owner: session cad-props). commands.js installs them with
 * `installProps(def, opt)`, the way it installs pcommands.js and layertools.js; the panel (props.js) is reached through
 * `c.host.props`:
 *   PROPERTIES (PR, PROPS, CH, MO, DDMODIFY)  open the Properties panel (show it, unfold it from auto-hide, focus it)
 *   PROPERTIESCLOSE (PRCLOSE)                 fold it away (auto-hide)
 *   QPMODE (QP)                               Quick Properties by the cursor on / off (also the QP button in the status bar)
 *   _PROPPICK                                 hidden: the pick button beside a point — asks for the point, with snaps
 * None of them clears the selection.
 */

import { t } from './i18n.js';

export function installProps(def) {
  const keep = { noRepeat: true, keepSelection: true };
  def('PROPERTIES', ['PR', 'PROPS', 'CH', 'MO', 'DDMODIFY'], async (c) => { c.host.props?.open(); }, { ...keep, help: () => t('cmd.properties.help') });
  def('PROPERTIESCLOSE', ['PRCLOSE'], async (c) => { c.host.props?.close(); }, { ...keep, help: () => t('cmd.propertiesclose.help') });
  def('QPMODE', ['QP'], async (c) => { c.host.props?.toggleQuick(); }, { ...keep, help: () => t('cmd.qpmode.help') });
  def('_PROPPICK', [], async (c) => {
    const what = c.host.props?.pickLabel?.() || '';
    const p = await c.point(t('props.pick.prompt', { what }));
    c.host.props?.picked(p);
  }, { ...keep, hidden: true });
}
