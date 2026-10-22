// Verify the analyst's LAG=16s claim: which real time does a prices-history point labelled t represent?
// For every in-window path point of the tape-subsample markets, compare pUp(label t) with the Up-equivalent
// price of taker fills in [t+d-5, t+d+5] for d in -90..+30. Report median |diff| and the fraction of path
// points that equal (within 0.5c) the LAST trade at or before t+d (last-trade hypothesis) vs a mid.
import fs from 'node:fs';
import { loadUpDown, loadTrades } from '../../lib/load.mjs';
const out = {};
for (const tf of ['5m', '15m']) {
  const recs = new Map(loadUpDown(tf).map((r) => [r.conditionId, r]));
  const res = {};
  for (let d = -90; d <= 30; d += 2) res[d] = { diffs: [], lastEq: 0, n: 0 };
  for (const tp of loadTrades(tf)) {
    const r = recs.get(tp.conditionId); if (!r || !r.path) continue;
    const tr = tp.trades.map((x) => ({ t: x.t, pu: x.o === 'U' ? x.p : 1 - x.p }));
    for (const [t, p] of r.path) {
      if (t < r.windowStart + 20 || t > r.windowEnd - 5) continue;
      for (let d = -90; d <= 30; d += 2) {
        const T = t + d;
        const w = tr.filter((x) => x.t >= T - 5 && x.t <= T + 5);
        if (w.length) res[d].diffs.push(Math.abs(w.reduce((s, x) => s + x.pu, 0) / w.length - p));
        // last trade at or before T
        let last = null; for (const x of tr) { if (x.t <= T) last = x; else break; }
        if (last) { res[d].n++; if (Math.abs(last.pu - p) <= 0.005) res[d].lastEq++; }
      }
    }
  }
  const rows = [];
  for (const [d, v] of Object.entries(res)) {
    const s = v.diffs.sort((a, b) => a - b);
    rows.push({ d: +d, nWin: s.length, medAbsDiffWin: +(s[Math.floor(s.length / 2)] ?? NaN).toFixed(4), meanAbsDiffWin: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(4), fracEqLastTrade: +(v.lastEq / v.n).toFixed(3) });
  }
  rows.sort((a, b) => a.d - b.d);
  out[tf] = rows;
  const best = [...rows].sort((a, b) => a.meanAbsDiffWin - b.meanAbsDiffWin)[0];
  const bestLast = [...rows].sort((a, b) => b.fracEqLastTrade - a.fracEqLastTrade)[0];
  console.log(tf, 'best mean|diff| at d=', best.d, best.meanAbsDiffWin, 'median', best.medAbsDiffWin, '| best last-trade match at d=', bestLast.d, bestLast.fracEqLastTrade);
  for (const r of rows) if (r.d % 10 === 0 || Math.abs(r.d + 16) <= 4) console.log('  ', JSON.stringify(r));
}
fs.writeFileSync(new URL('./out/lagcheck.json', import.meta.url), JSON.stringify(out, null, 1));
