// Robustness: is the consecutive-window reversal seen in 1h/4h Up/Down results a property of BTC returns
// at that horizon (any alignment), or specific to the market's boundaries? Uses the Chainlink reference
// (15m/5m boundaries, Jun 24 / Sep 7 onwards) to compute sign agreement of consecutive non-overlapping
// returns for every alignment offset. Also splits the market-result reversal by period.
import fs from 'node:fs';
import { loadUpDown } from '../../lib/load.mjs';
import { buildCL } from './features.mjs';
const CL = buildCL();
const out = { horizons: [], marketByPeriod: [] };
const H = [[300, 300, 'Sep7'], [900, 900, 'Jun24'], [3600, 900, 'Jun24'], [14400, 900, 'Jun24'], [86400, 900, 'Jun24']];
for (const [h, step, from] of H) {
  const t0 = from === 'Sep7' ? Date.UTC(2026, 8, 7, 10) / 1000 : Date.UTC(2026, 5, 24, 10) / 1000;
  const t1 = Date.UTC(2026, 9, 22, 9) / 1000;
  const rows = [];
  for (let off = 0; off < h; off += step) {
    let n = 0, same = 0;
    let prevR = null;
    for (let t = Math.ceil((t0 - off) / h) * h + off; t + h <= t1; t += h) {
      const a = CL.get(t), b = CL.get(t + h);
      if (a == null || b == null) { prevR = null; continue; }
      const r = Math.log(b / a);
      if (prevR != null && r !== 0 && prevR !== 0) { n++; if (Math.sign(r) === Math.sign(prevR)) same++; }
      prevR = r;
    }
    rows.push({ offsetSec: off, n, pSame: n ? +(same / n).toFixed(4) : null });
  }
  const N = rows.reduce((s, r) => s + r.n, 0), S = rows.reduce((s, r) => s + (r.pSame || 0) * r.n, 0);
  out.horizons.push({ horizonSec: h, from, offsets: rows.length, pooledN: N, pooledPSame: +(S / N).toFixed(4), minPSame: Math.min(...rows.map((r) => r.pSame ?? 1)), maxPSame: Math.max(...rows.map((r) => r.pSame ?? 0)), byOffset: rows.length <= 24 ? rows : undefined });
}
for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
  const recs = loadUpDown(tf);
  const per = new Map();
  for (let i = 1; i < recs.length; i++) {
    const a = recs[i - 1], b = recs[i]; if (a.windowEnd !== b.windowStart) continue;
    const k = b.day.slice(0, 7); const c = per.get(k) || { n: 0, same: 0 }; c.n++; if (a.upWon === b.upWon) c.same++; per.set(k, c);
  }
  out.marketByPeriod.push({ tf, byMonth: [...per.entries()].map(([m, c]) => ({ m, n: c.n, pSame: +(c.same / c.n).toFixed(3) })) });
}
fs.writeFileSync('/home/user/CENTISPORT/research/btc/reports/momentum/btc_autocorr.json', JSON.stringify(out, null, 1));
for (const h of out.horizons) console.log('horizon', h.horizonSec, 'from', h.from, 'offsets', h.offsets, 'pooledN', h.pooledN, 'pSame', h.pooledPSame, 'range', h.minPSame, h.maxPSame);
for (const m of out.marketByPeriod) console.log(m.tf, m.byMonth.map((x) => `${x.m}:${x.pSame}(${x.n})`).join(' '));
