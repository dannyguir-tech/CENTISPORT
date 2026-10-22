// Robustness check for the favourite/longshot slope: is slope > 1 a property of the market, or an artefact of the
// prices-history snapshots (smoothed / lagged)? On the 5m and 15m tape subsample, compare at the same decision instants:
//   snapshot price (last path point <= T)   vs   tape price = median Up-equivalent taker print in [T-10, T] (no look-ahead).
// Pooled over decision times 25/50/75/90% (one logistic fit per tf and price source; day-clustered bootstrap CI).
import fs from 'node:fs';
import { loadUpDown, tradesByCondition } from '../../lib/load.mjs';
import { logisticFit, logit, r4 } from './stats.mjs';
import { mulberry32 } from '../../lib/util.mjs';

const out = {};
for (const tf of ['5m', '15m']) {
  const recs = loadUpDown(tf); const tapes = tradesByCondition(tf);
  const rows = [];
  for (const r of recs) {
    const tape = tapes.get(r.conditionId); if (!tape || !r.path?.length) continue;
    const W = r.windowEnd - r.windowStart;
    for (const f of [0.25, 0.5, 0.75, 0.9]) {
      const T = Math.floor(r.windowStart + f * W);
      let snap = null; for (const [t, p] of r.path) { if (t <= T) snap = [t, p]; else break; }
      if (!snap || T - snap[0] > 90) continue;
      const v = tape.trades.filter((x) => x.t >= T - 10 && x.t <= T).map((x) => (x.o === 'U' ? x.p : 1 - x.p)).sort((a, b) => a - b);
      if (!v.length) continue;
      const tapeP = v[v.length >> 1];
      rows.push({ day: r.day, f, y: r.upWon ? 1 : 0, snap: snap[1], tape: tapeP });
    }
  }
  const fit = (sel, key) => { const s = sel.filter((x) => x[key] >= 0.02 && x[key] <= 0.98); return { n: s.length, beta: logisticFit(s.map((x) => [logit(x[key])]), s.map((x) => x.y)) }; };
  const days = [...new Set(rows.map((x) => x.day))]; const byDay = new Map(days.map((d) => [d, rows.filter((x) => x.day === d)]));
  const res = {};
  for (const key of ['snap', 'tape']) {
    const base = fit(rows, key); const bs = []; const rnd = mulberry32(42);
    for (let b = 0; b < 400; b++) { const s = []; for (let i = 0; i < days.length; i++) s.push(...byDay.get(days[(rnd() * days.length) | 0])); const f = fit(s, key); if (f.beta) bs.push(f.beta[1]); }
    bs.sort((a, b) => a - b);
    res[key] = { n: base.n, slope: r4(base.beta[1]), intercept: r4(base.beta[0]), slopeCI: [r4(bs[Math.floor(0.025 * bs.length)]), r4(bs[Math.floor(0.975 * bs.length)])] };
  }
  const diff = rows.map((x) => Math.abs(x.snap - x.tape)).sort((a, b) => a - b);
  res.medianAbsSnapMinusTape = r4(diff[diff.length >> 1]);
  res.nObs = rows.length; res.days = days.length;
  out[tf] = res;
  console.log(tf, JSON.stringify(res));
}
fs.writeFileSync('/home/user/CENTISPORT/research/btc/reports/calibration/tape_slope_check.json', JSON.stringify(out, null, 1));
