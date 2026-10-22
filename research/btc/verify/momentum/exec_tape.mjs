// Fill-realism attack on the 5m/15m tape subsample (no network).
// For the decision situations the candidates use, compare the snapshot reference price pRef of the side we would buy
// with prices that ACTUALLY traded for a buyer of that side in [t_dec, t_dec + W] (real time):
//   taker BUY of side S at p  -> p ;  taker SELL of the complement at q -> 1 - q (a resting complement bid = an S ask via mint).
// Reports the distribution of (first executable price - pRef) and (size-weighted VWAP - pRef), conditioned on the situation,
// so the analyst's flat +1c haircut can be checked exactly where the candidates trade.
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown, loadTrades, WINDOW_SEC } from '../../lib/load.mjs';
import { effPath, lastAt, firstAfter, fmt } from './mod/lib.mjs';
import { buildCL } from './mod/features.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CL = buildCL();
const W = 20;
const q = (a, x) => { const s = [...a].sort((u, v) => u - v); return s.length ? s[Math.min(s.length - 1, Math.floor(x * (s.length - 1)))] : null; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function buyPrices(trades, S, t0, t1) {
  const out = [];
  for (const x of trades) {
    if (x.t < t0) continue; if (x.t > t1) break;
    if (x.o === S && x.side === 'B') out.push({ t: x.t, p: x.p, s: x.s });
    else if (x.o !== S && x.side === 'S') out.push({ t: x.t, p: 1 - x.p, s: x.s });
  }
  return out;
}
function stat(rows) {
  const f = rows.map((r) => r.first), v = rows.map((r) => r.vwap);
  return { n: rows.length, meanFirstMinusRef: fmt(mean(f)), medFirst: fmt(q(f, 0.5)), p75First: fmt(q(f, 0.75)), p90First: fmt(q(f, 0.9)), meanVwapMinusRef: fmt(mean(v)), medVwap: fmt(q(v, 0.5)), fracFirstAboveRefPlus1c: fmt(f.filter((x) => x > 0.01).length / (f.length || 1)), fracFirstAboveRefPlus2c: fmt(f.filter((x) => x > 0.02).length / (f.length || 1)) };
}
const res = {};
for (const tf of ['5m', '15m']) {
  const L = WINDOW_SEC[tf];
  const all = loadUpDown(tf); const idx = new Map(all.map((r, i) => [r.conditionId, i]));
  const A = { all: [], z15: [], z2: [], z25: [], noFill: 0, tot: 0 }; // across-window open situation, side = reversal of prev
  const Wf = { f02: { all: [], m20: [], m30: [], m35: [] }, f04: { all: [], m30: [], m35: [] } };
  for (const tp of loadTrades(tf)) {
    const i = idx.get(tp.conditionId); if (i == null) continue;
    const b = all[i], a = all[i - 1];
    if (!b.path || !b.path.length) continue;
    const ep = effPath(b.path);
    // A situation (featA): first effective snapshot >= start + 5s
    if (a && a.windowEnd === b.windowStart) {
      const pt = firstAfter(ep, b.windowStart + 5, 90);
      if (pt && pt[0] < b.windowEnd) {
        const sig = CL.sigmaAt(b.windowStart);
        const z = a.priceToBeat && a.finalPrice && sig ? Math.log(a.finalPrice / a.priceToBeat) / (sig * Math.sqrt(L)) : null;
        const S = a.upWon ? 'D' : 'U'; // reversal side
        const pRef = S === 'U' ? pt[1] : 1 - pt[1];
        const bp = buyPrices(tp.trades, S, pt[0], pt[0] + W);
        A.tot++;
        if (!bp.length) A.noFill++;
        else {
          const row = { first: bp[0].p - pRef, vwap: bp.reduce((s, x) => s + x.p * x.s, 0) / bp.reduce((s, x) => s + x.s, 0) - pRef, pRef };
          A.all.push(row);
          if (z != null && Math.abs(z) >= 1.5) A.z15.push(row);
          if (z != null && Math.abs(z) >= 2) A.z2.push(row);
          if (z != null && Math.abs(z) >= 2.5) A.z25.push(row);
        }
      }
    }
    // W situation (featW lvl): last effective snapshot <= start + f*L, favourite of the move since the pre-window quote
    for (const [fk, f] of [['f02', 0.2], ['f04', 0.4]]) {
      const pt = lastAt(ep, b.windowStart + f * L, Math.max(90, 0.05 * L));
      if (!pt || pt[0] <= b.windowStart) continue;
      const open = lastAt(ep, b.windowStart, Math.max(900, L));
      const d = pt[1] - (open ? open[1] : 0.5);
      const S = d > 0 ? 'U' : 'D';
      const pRef = S === 'U' ? pt[1] : 1 - pt[1];
      if (!(pRef >= 0.03 && pRef <= 0.95)) continue;
      const bp = buyPrices(tp.trades, S, pt[0], pt[0] + W);
      if (!bp.length) continue;
      const row = { first: bp[0].p - pRef, vwap: bp.reduce((s, x) => s + x.p * x.s, 0) / bp.reduce((s, x) => s + x.s, 0) - pRef, pRef };
      Wf[fk].all.push(row);
      for (const m of [20, 30, 35]) if (Wf[fk]['m' + m] && Math.abs(d) > m / 100) Wf[fk]['m' + m].push(row);
    }
  }
  res[tf] = {
    A_reversalSideAtOpen: { windows: A.tot, noBuyFillWithin20s: A.noFill, all: stat(A.all), absZ_ge1_5: stat(A.z15), absZ_ge2: stat(A.z2), absZ_ge2_5: stat(A.z25) },
    W_favourite: Object.fromEntries(Object.entries(Wf).map(([k, o]) => [k, Object.fromEntries(Object.entries(o).map(([kk, rows]) => [kk, stat(rows)]))])),
  };
}
fs.writeFileSync(path.join(HERE, 'out', 'exec_tape.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
