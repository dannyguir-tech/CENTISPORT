// Effective half-spread from taker tapes: in 5-second buckets with both Up-equivalent taker buys and sells,
// half-spread = (vwap(buyEq) - vwap(sellEq)) / 2. Reported by Up-price band (folded to token price min(p,1-p)) and window phase.
// Also: "buy-equivalent fill minus the last path snapshot <= fill time" (fresh snapshot, <=20s old), median by band.
import { loadUpDown, tradesByCondition, loadLive, pointAt } from '../../lib/load.mjs';
import fs from 'node:fs';
const out = {};
for (const tf of ['5m', '15m']) {
  const recs = loadUpDown(tf); const tapes = tradesByCondition(tf);
  const bands = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5];
  const bi = (q) => { for (let i = bands.length - 2; i >= 0; i--) if (q >= bands[i]) return i; return 0; };
  const hs = bands.slice(0, -1).map(() => []); const slip = bands.slice(0, -1).map(() => []);
  const hsPhase = { early: [], mid: [], late: [] };
  for (const r of recs) {
    const tape = tapes.get(r.conditionId); if (!tape) continue;
    const W = r.windowEnd - r.windowStart; const B = new Map();
    for (const x of tape.trades) {
      if (x.t < r.windowStart || x.t >= r.windowEnd) continue;
      const up = x.o === 'U' ? x.p : 1 - x.p; const buy = (x.side === 'B') === (x.o === 'U');
      const k = Math.floor(x.t / 5); if (!B.has(k)) B.set(k, { b: [0, 0], s: [0, 0], t: x.t });
      const o = B.get(k)[buy ? 'b' : 's']; o[0] += up * x.s; o[1] += x.s;
      // slippage vs fresh snapshot, in token terms (token being bought)
      const pt = pointAt(r.path, x.t);
      if (pt && x.t - pt[0] <= 20) {
        const tokBuyPx = buy ? up : 1 - up; const tokSnap = buy ? pt[1] : 1 - pt[1];
        slip[bi(Math.min(tokSnap, 1 - tokSnap))].push(tokBuyPx - tokSnap);
      }
    }
    for (const [, v] of B) {
      if (!v.b[1] || !v.s[1]) continue;
      const mid = (v.b[0] / v.b[1] + v.s[0] / v.s[1]) / 2; const h = (v.b[0] / v.b[1] - v.s[0] / v.s[1]) / 2;
      hs[bi(Math.min(mid, 1 - mid))].push(h);
      const ph = (v.t - r.windowStart) / W; hsPhase[ph < 0.33 ? 'early' : ph < 0.75 ? 'mid' : 'late'].push(h);
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(4) : null; };
  const mean = (a) => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(4) : null;
  out[tf] = {
    halfSpreadByFoldedBand: bands.slice(0, -1).map((b, i) => ({ band: `${b}-${bands[i + 1]}`, n: hs[i].length, median: med(hs[i]), mean: mean(hs[i]) })),
    halfSpreadByPhase: Object.fromEntries(Object.entries(hsPhase).map(([k, a]) => [k, { n: a.length, median: med(a), mean: mean(a) }])),
    buySlipVsFreshSnapshot: bands.slice(0, -1).map((b, i) => ({ band: `${b}-${bands[i + 1]}`, n: slip[i].length, median: med(slip[i]), mean: mean(slip[i]) })),
  };
}
// live books: in-play and pre-created Up/Down markets
const L = loadLive(); const live = {};
for (const e of L.events) {
  if (!e.kind.startsWith('updown')) continue;
  const tf = e.kind.slice(7); live[tf] ??= { inplay: [], future: [] };
  for (const m of e.markets) for (const tk of m.tokens || []) {
    const b = tk.book; if (!b || b.bestAsk == null || b.bestBid == null) continue;
    const depth1c = (b.asks || []).filter(([p]) => p <= b.bestAsk + 0.01 + 1e-9).reduce((s, [p, q]) => s + p * q, 0);
    const rec = { outcome: tk.outcome, bid: b.bestBid, ask: b.bestAsk, spread: +(b.bestAsk - b.bestBid).toFixed(4), askDepth1cUSD: +depth1c.toFixed(1) };
    (e.windowStart != null && e.windowStart <= L.fetchedTs ? live[tf].inplay : live[tf].future).push(rec);
  }
}
const liveSum = {};
for (const [tf, v] of Object.entries(live)) {
  const s = (a, k) => { const x = a.map((r) => r[k]).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
  liveSum[tf] = { inplayTokens: v.inplay.length, inplay: v.inplay, futureTokens: v.future.length, futureMedianSpread: s(v.future, 'spread'), futureMedianAskDepth1cUSD: s(v.future, 'askDepth1cUSD') };
}
out.live = { fetchedAt: L.fetchedAt, ...liveSum };
fs.writeFileSync('/home/user/CENTISPORT/research/btc/reports/calibration/spread_estimates.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
