// Check what a prices-history point (t, p) represents, using the 5m/15m taker tapes:
// compare p with Up-equivalent trade prices just before t vs just after t.
import { loadUpDown, tradesByCondition } from '../../lib/load.mjs';
const tf = process.argv[2] || '5m';
const recs = loadUpDown(tf); const tapes = tradesByCondition(tf);
const upEq = (x) => (x.o === 'U' ? x.p : 1 - x.p);
let stats = { n: 0, before: [], after: [], vwapB: [], vwapA: [], mixB: [] , lastB_eq:0, lastA_eq:0, buyEq:[], sellEq:[]};
for (const r of recs) {
  const tape = tapes.get(r.conditionId); if (!tape) continue;
  const tr = tape.trades;
  for (const [t, p] of r.path) {
    if (t < r.windowStart - 120 || t > r.windowEnd - 5) continue;
    // last trade before t, first after
    let lb = null, fa = null; const wb = [], wa = [];
    for (const x of tr) {
      if (x.t <= t) { lb = x; if (x.t > t - 60) wb.push(x); }
      else { if (!fa) fa = x; if (x.t <= t + 60) wa.push(x); }
    }
    if (!lb || !fa || t - lb.t > 20 || fa.t - t > 20) continue;
    stats.n++;
    stats.before.push(Math.abs(upEq(lb) - p)); stats.after.push(Math.abs(upEq(fa) - p));
    const vw = (a) => a.reduce((s, x) => s + upEq(x) * x.s, 0) / a.reduce((s, x) => s + x.s, 0);
    if (wb.length) stats.vwapB.push(Math.abs(vw(wb) - p)); if (wa.length) stats.vwapA.push(Math.abs(vw(wa) - p));
    if (Math.abs(upEq(lb) - p) < 0.0051) stats.lastB_eq++; if (Math.abs(upEq(fa) - p) < 0.0051) stats.lastA_eq++;
    // executable buy-up proxies within +-10s of t: (B,U) or (S,D)
    for (const x of tr) {
      if (Math.abs(x.t - t) > 10) continue;
      const isBuyUp = (x.side === 'B' && x.o === 'U') || (x.side === 'S' && x.o === 'D');
      (isBuyUp ? stats.buyEq : stats.sellEq).push(upEq(x) - p);
    }
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };
console.log(tf, 'points', stats.n);
console.log('|p - lastTradeBefore| median', med(stats.before), 'mean', mean(stats.before).toFixed(4), 'frac within 0.5c', (stats.lastB_eq / stats.n).toFixed(3));
console.log('|p - firstTradeAfter|  median', med(stats.after), 'mean', mean(stats.after).toFixed(4), 'frac within 0.5c', (stats.lastA_eq / stats.n).toFixed(3));
console.log('|p - vwap[t-60,t]| median', med(stats.vwapB), 'mean', mean(stats.vwapB).toFixed(4));
console.log('|p - vwap(t,t+60]| median', med(stats.vwapA), 'mean', mean(stats.vwapA).toFixed(4));
console.log('buy-Up-equiv fill - p within +-10s: n', stats.buyEq.length, 'median', med(stats.buyEq)?.toFixed(4), 'mean', mean(stats.buyEq).toFixed(4), 'q25', q(stats.buyEq, .25).toFixed(4), 'q75', q(stats.buyEq, .75).toFixed(4));
console.log('sell-Up-equiv fill - p within +-10s: n', stats.sellEq.length, 'median', med(stats.sellEq)?.toFixed(4), 'mean', mean(stats.sellEq).toFixed(4));
