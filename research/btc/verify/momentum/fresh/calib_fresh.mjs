// Does the analyst's 'favourites are underpriced' calibration slope (logit win ~ logit p, slope 1.04-1.16) replicate on
// windows the analyst never saw? Same featW decision rows, day-clustered bootstrap (B=200), split by resolution regime.
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown } from './load_shim.mjs';
import * as base from '../../../lib/load.mjs';
import { featW } from './features.mjs';
import { logisticBoot, logit } from '../mod/lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const meta = new Map(); for (const tf of ['5m', '15m']) for (const r of loadUpDown(tf)) meta.set(r.slug, r);
const reg = (slug) => { const s = meta.get(slug)?.resolutionSource || ''; return /twap-60/.test(s) ? 'twap60' : /twap-30/.test(s) ? 'twap30' : 'plain'; };
const out = [];
for (const tf of ['5m', '15m']) {
  const first = base.loadUpDown(tf)[0].windowStart;
  for (const f of [0.2, 0.4, 0.6]) {
    const rows = featW(tf, f);
    const groups = { analyst: rows.filter((r) => r.t + 16 >= first), fresh: rows.filter((r) => r.t + 16 < first) };
    for (const g of ['plain', 'twap60']) groups[`fresh_${g}`] = groups.fresh.filter((r) => reg(r.id) === g);
    for (const [k, rs] of Object.entries(groups)) {
      if (rs.length < 300) continue;
      const dr = rs.map((r) => ({ day: r.day, y: r.win ? 1 : 0, lp: logit(r.p), dlp: logit(r.p) - logit(r.pPrev) }));
      const fit = logisticBoot(dr, (r) => [1, r.lp, r.dlp], ['const', 'logit_p', 'dlogit_recent'], { B: 200 });
      const o = { tf, f, sample: k, n: fit.n, days: fit.days, slope: fit.coef.logit_p, recentVel: fit.coef.dlogit_recent };
      out.push(o); console.log(JSON.stringify(o));
    }
  }
}
fs.writeFileSync(path.join(HERE, '..', 'out', 'calib_fresh.json'), JSON.stringify(out, null, 1));
