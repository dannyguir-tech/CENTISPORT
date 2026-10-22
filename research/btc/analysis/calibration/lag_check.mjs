// Find the effective time a prices-history snapshot (t,p) refers to: median |p - tapePrice(t + lag)| over lags.
// tapePrice(x) = Up-equivalent price of the last taker print at or before x (needs a print within 10 s before x).
import { loadUpDown, tradesByCondition } from '../../lib/load.mjs';
const tf = process.argv[2] || '5m';
const recs = loadUpDown(tf); const tapes = tradesByCondition(tf);
const lags = []; for (let l = -90; l <= 60; l += 5) lags.push(l);
const err = lags.map(() => []);
for (const r of recs) {
  const tape = tapes.get(r.conditionId); if (!tape) continue;
  const tr = tape.trades; const ts = tr.map((x) => x.t);
  const upEq = tr.map((x) => (x.o === 'U' ? x.p : 1 - x.p));
  const lastIdx = (x) => { let lo = 0, hi = ts.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= x) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  for (const [t, p] of r.path) {
    if (t < r.windowStart + 30 || t > r.windowEnd - 30) continue;
    lags.forEach((l, i) => {
      const x = t + l; const j = lastIdx(x); if (j < 0 || x - ts[j] > 10) return;
      // median of the prints in the last 10 s (robust to bid/ask bounce)
      const v = []; for (let k = j; k >= 0 && ts[k] >= x - 10; k--) v.push(upEq[k]); v.sort((a, b) => a - b);
      err[i].push(Math.abs(v[v.length >> 1] - p));
    });
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
console.log(tf);
lags.forEach((l, i) => console.log(String(l).padStart(4), 'n', err[i].length, 'median', med(err[i]).toFixed(4), 'mean', mean(err[i]).toFixed(4)));
