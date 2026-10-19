/* SPDX-License-Identifier: Apache-2.0 */
/**
 * textmask-cmd.js — TEXTMASK (0.5 WL.8, session cad-files): a background mask behind texts, saved as MTEXT's background
 * in DWG (2004+) and DXF 2000 (`bgm: { color: 'bg' | ACI | '#rrggbb', scale }` on a text; walk.js draws it, plot.js
 * prints it). Registered through commands.js's registry when imported (cadcraft.js; Node tests).
 *
 *   TEXTMASK  select texts → [Background / Color / Off] → (Color: the colour number 1–255) → border offset factor (1–5;
 *             1.5 = half a text height round the text) — one undo step for every text chosen
 */
import { t } from './i18n.js';
import { commandRegistry } from './commands.js';

const opt = commandRegistry.option;

commandRegistry.add('TEXTMASK', ['TMASK'], async (c) => {
  const set = await c.select(t('mask.select'));
  const ids = [...(set || [])].filter((id) => c.doc.get(id)?.type === 'text');
  if (!ids.length) { c.print(t('mask.none')); return; }
  const k = await c.keyword(t('mask.prompt'), { options: [opt('B', t('opt.background')), opt('C', t('opt.color')), opt('O', t('opt.off'))], default: 'B' });
  const o = k?.option ?? k;
  if (!o) return;
  let bgm = null;
  if (o !== 'O') {
    let color = 'bg';
    if (o === 'C') {
      const n = await c.number(t('mask.color'), { default: 7 });
      if (typeof n !== 'number' || !(n >= 1 && n <= 255)) { c.print(t('mask.badcolor')); return; }
      color = Math.round(n);
    }
    const sc = await c.number(t('mask.scale'), { default: 1.5 });
    const scale = typeof sc === 'number' && sc >= 1 && sc <= 5 ? sc : 1.5;
    bgm = { color, scale };
  }
  c.doc.change('TEXTMASK', () => {
    for (const id of ids) {
      const e = c.doc.get(id);
      const { bgm: _old, ...rest } = e;   // eslint-disable-line no-unused-vars
      c.doc.update(id, bgm ? { ...rest, bgm } : rest);
    }
  });
  c.print(t(bgm ? 'mask.done' : 'mask.off', { n: ids.length }));
}, { help: () => t('mask.help') });
