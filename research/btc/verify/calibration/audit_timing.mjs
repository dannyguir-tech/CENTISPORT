// Verifier (calibration family): look-ahead / timing / label audit.
//   node audit_timing.mjs  -> out/audit_timing.json
// 1. label check: upWon vs Chainlink finalPrice >= priceToBeat; closedTs - windowEnd
// 2. snapshot timing: which tape time does a prices-history point (t, p) match? Restricted to FAST moves, where a
//    look-ahead (point reflecting trades after t) would show up as a minimum at a positive lag.
// 3. 5m pre-window: staleness of the 'pre' snapshot, how many taker prints exist pre-window, effective half-spread pre-window.
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown, tradesByCondition } from '../../lib/load.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const out = {};
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(f * (s.length - 1))].toFixed(4) : null; };

// 1. labels
out.labels = {};
for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
  const recs = loadUpDown(tf);
  let both = 0, agree = 0, ties = 0; const lagClose = []; const dis = [];
  for (const r of recs) {
    if (r.closedTs) lagClose.push(r.closedTs - r.windowEnd);
    if (r.priceToBeat != null && r.finalPrice != null) {
      both++; const up = r.finalPrice >= r.priceToBeat; if (r.finalPrice === r.priceToBeat) ties++;
      if (up === !!r.upWon) agree++; else if (dis.length < 5) dis.push({ slug: r.slug, ptb: r.priceToBeat, fin: r.finalPrice, winner: r.winner });
    }
  }
  // contiguity: next window's priceToBeat == this window's finalPrice ?
  let cont = 0, contEq = 0;
  for (let i = 1; i < recs.length; i++) if (recs[i].windowStart === recs[i - 1].windowEnd && recs[i].priceToBeat != null && recs[i - 1].finalPrice != null) { cont++; if (Math.abs(recs[i].priceToBeat - recs[i - 1].finalPrice) < 1e-6) contEq++; }
  out.labels[tf] = { n: recs.length, withBoth: both, labelAgreesWithChainlink: agree, ties, disagreeSamples: dis, closedMinusEnd: { p05: q(lagClose, 0.05), p50: q(lagClose, 0.5), p95: q(lagClose, 0.95), min: Math.min(...lagClose) }, contiguousPairs: cont, nextPtbEqualsFinal: contEq };
}

// 2. snapshot timing on fast moves
out.snapshotLag = {};
for (const tf of ['5m', '15m']) {
  const recs = loadUpDown(tf); const tapes = tradesByCondition(tf);
  const lags = []; for (let l = -40; l <= 40; l += 2) lags.push(l);
  const errAll = lags.map(() => []), errFast = lags.map(() => []);
  for (const r of recs) {
    const tape = tapes.get(r.conditionId); if (!tape) continue;
    const tr = tape.trades; const ts = tr.map((x) => x.t); const up = tr.map((x) => (x.o === 'U' ? x.p : 1 - x.p));
    const lastIdx = (x) => { let lo = 0, hi = ts.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= x) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
    const tapeAt = (x) => { const j = lastIdx(x); if (j < 0 || x - ts[j] > 6) return null; const v = []; for (let k = j; k >= 0 && ts[k] >= x - 6; k--) v.push(up[k]); v.sort((a, b) => a - b); return v[v.length >> 1]; };
    for (const [t, p] of r.path) {
      if (t < r.windowStart + 45 || t > r.windowEnd - 45) continue;
      const a = tapeAt(t - 40), b = tapeAt(t + 40); const fast = a != null && b != null && Math.abs(b - a) >= 0.08;
      lags.forEach((l, i) => { const v = tapeAt(t + l); if (v == null) return; errAll[i].push(Math.abs(v - p)); if (fast) errFast[i].push(Math.abs(v - p)); });
    }
  }
  const med = (a) => q(a, 0.5); const mean = (a) => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(4) : null;
  const rows = lags.map((l, i) => ({ lag: l, nAll: errAll[i].length, medAll: med(errAll[i]), meanAll: mean(errAll[i]), nFast: errFast[i].length, medFast: med(errFast[i]), meanFast: mean(errFast[i]) }));
  const best = (k) => rows.filter((r) => r[k] != null).reduce((b, r) => (r[k] < b[k] ? r : b));
  out.snapshotLag[tf] = { bestLagMeanAll: best('meanAll').lag, bestLagMeanFast: best('meanFast').lag, bestLagMedFast: best('medFast').lag, rows };
}

// 3. 5m and 15m pre-window microstructure
out.preWindow = {};
for (const tf of ['5m', '15m']) {
  const recs = loadUpDown(tf); const tapes = tradesByCondition(tf); const W = tf === '5m' ? 300 : 900;
  const stale = []; const nPrintsPre = []; const hs = []; const devs = [];
  for (const r of recs) {
    const T = r.windowStart - 0.25 * W; let k = -1; for (let j = 0; j < r.path.length; j++) if (r.path[j][0] <= T) k = j; else break;
    if (k >= 0) { stale.push(T - r.path[k][0]); devs.push(Math.abs(r.path[k][1] - 0.5)); }
    const tape = tapes.get(r.conditionId); if (!tape) continue;
    const pre = tape.trades.filter((x) => x.t >= T - 60 && x.t <= T + 60); nPrintsPre.push(pre.length);
    const B = new Map();
    for (const x of pre) { const u = x.o === 'U' ? x.p : 1 - x.p; const buy = (x.side === 'B') === (x.o === 'U'); const kk = Math.floor(x.t / 10); if (!B.has(kk)) B.set(kk, { b: [], s: [] }); B.get(kk)[buy ? 'b' : 's'].push(u); }
    for (const [, v] of B) if (v.b.length && v.s.length) hs.push((Math.min(...v.b) - Math.max(...v.s)) / 2);
  }
  out.preWindow[tf] = { snapshots: stale.length, staleSec: { p50: q(stale, 0.5), p90: q(stale, 0.9) }, absDevFrom05: { p50: q(devs, 0.5), p90: q(devs, 0.9), p99: q(devs, 0.99) }, tapeMarkets: nPrintsPre.length, printsInPreWindow120s: { p10: q(nPrintsPre, 0.1), p50: q(nPrintsPre, 0.5), p90: q(nPrintsPre, 0.9), frac0: +(nPrintsPre.filter((x) => x === 0).length / Math.max(1, nPrintsPre.length)).toFixed(3) }, halfSpreadMinBuyMinusMaxSell10s: { n: hs.length, p25: q(hs, 0.25), p50: q(hs, 0.5), p75: q(hs, 0.75) } };
}
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', 'audit_timing.json'), JSON.stringify(out, null, 1));
const brief = JSON.parse(JSON.stringify(out)); for (const tf in brief.snapshotLag) brief.snapshotLag[tf].rows = brief.snapshotLag[tf].rows.filter((r) => r.lag % 8 === 0);
console.log(JSON.stringify(brief, null, 1));
