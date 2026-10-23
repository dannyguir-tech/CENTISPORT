// Empirical execution haircut: taker BUY fill price vs the last price-path snapshot (same token),
// split by how fresh the snapshot is and by window phase. Used to pick the headline spread haircut.
import { loadUpDown, loadTrades, pointAt } from '/home/user/CENTISPORT/research/btc/lib/load.mjs';
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const q = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
const LAG = Number(process.argv[2] ?? 16); // snapshot label lags real time by ~16 s (momentum/lag_check)
const out = { LAG };
for (const tf of ['5m', '15m']) {
  const recs = new Map(loadUpDown(tf).map((r) => [r.conditionId, r]));
  const tapes = loadTrades(tf);
  const buckets = {};
  const add = (k, v) => { (buckets[k] ||= []).push(v); };
  for (const tp of tapes) {
    const r = recs.get(tp.conditionId); if (!r || !r.path?.length) continue;
    const L = r.windowEnd - r.windowStart;
    const ep = r.path.map(([t, p]) => [t - LAG, p]);
    for (const x of tp.trades) {
      if (x.side !== 'B') continue;
      const pt = pointAt(ep, x.t); if (!pt) continue;
      const age = x.t - pt[0];
      const snapTok = x.o === 'U' ? pt[1] : 1 - pt[1];
      if (snapTok < 0.05 || snapTok > 0.95) continue;
      const slip = x.p - snapTok;
      const ph = (x.t - r.windowStart) / L;
      const phase = ph < 0 ? 'pre' : ph < 0.1 ? 'open' : ph < 0.6 ? 'f10-60' : ph < 0.9 ? 'f60-90' : ph <= 1 ? 'f90-100' : 'post';
      add(`all|${phase}`, slip);
      if (age <= 5) add(`age<=5s|${phase}`, slip);
      if (age > 30) add(`age>30s|${phase}`, slip);
    }
  }
  out[tf] = Object.fromEntries(Object.entries(buckets).sort().map(([k, v]) => [k, { n: v.length, median: +med(v).toFixed(4), p25: +q(v, 0.25).toFixed(4), p75: +q(v, 0.75).toFixed(4), mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) }]));
}
console.log(JSON.stringify(out, null, 1));
