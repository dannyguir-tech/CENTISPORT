// Exploration: check oracle/time alignment between ladder families and Up/Down markets.
import { loadUpDown, loadLadders } from '../../lib/load.mjs';
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16);
const ad = loadLadders('above_daily'), rd = loadLadders('range_daily'), hd = loadLadders('hit_daily'), hw = loadLadders('hit_weekly'), hm = loadLadders('hit_monthly'), ah = loadLadders('above_hourly');
const d1 = loadUpDown('1d'), h1 = loadUpDown('1h');
const d1ByEnd = new Map(d1.map((r) => [r.windowEnd, r]));
const rdByEnd = new Map(rd.map((e) => [e.endTs, e]));
let chk = { n: 0, aboveOk: 0, aboveBad: 0, bucketOk: 0, bucketBad: 0, noFinal: 0 };
for (const e of ad) {
  const u = d1ByEnd.get(e.endTs);
  const r = rdByEnd.get(e.endTs);
  if (!u) continue;
  chk.n++;
  if (u.finalPrice == null) { chk.noFinal++; continue; }
  for (const m of e.markets) { const pred = u.finalPrice > m.strike.k; if (pred === m.yesWon) chk.aboveOk++; else { chk.aboveBad++; console.log('above mismatch', e.slug, m.strike.k, u.finalPrice, m.yesWon); } }
  if (r) for (const m of r.markets) {
    const s = m.strike, f = u.finalPrice;
    const pred = s.type === 'below' ? f < s.hi : s.type === 'between' ? f >= s.lo && f < s.hi : f >= s.lo;
    if (pred === m.yesWon) chk.bucketOk++; else { chk.bucketBad++; console.log('bucket mismatch', r.slug, JSON.stringify(s), f, m.yesWon); }
  }
}
console.log('daily alignment', chk);
console.log('above_daily ends', ad.length, 'matched to 1d', ad.filter((e) => d1ByEnd.has(e.endTs)).length, 'range', ad.filter((e) => rdByEnd.has(e.endTs)).length);
// strikes
const strikesA = ad.slice(-3).map((e) => e.markets.map((m) => m.strike.k).sort((a, b) => a - b).join(','));
console.log('above strikes', strikesA);
console.log('range strikes', rd.slice(-3).map((e) => e.markets.map((m) => JSON.stringify(m.strike)).join(' ')));
console.log('hit_daily strikes', hd.slice(-2).map((e) => e.markets.map((m) => m.strike.type[4] + m.strike.k).join(' ')));
console.log('hit_daily ends', hd.slice(0, 3).map((e) => [e.slug, iso(e.startTs), iso(e.endTs)]));
console.log('hit_weekly ends', hw.slice(-3).map((e) => [e.slug, iso(e.startTs), iso(e.endTs), e.markets.length]));
console.log('hit_monthly', hm.map((e) => [e.slug, iso(e.startTs), iso(e.endTs), e.markets.length]));
// hourly: above_hourly vs 1h up/down
const h1ByEnd = new Map(h1.map((r) => [r.windowEnd, r]));
let hc = { n: 0, ok: 0, bad: 0, noFinal: 0 };
for (const e of ah) { const u = h1ByEnd.get(e.endTs); if (!u) continue; hc.n++; if (u.finalPrice == null) { hc.noFinal++; continue; }
  for (const m of e.markets) { const pred = u.finalPrice > m.strike.k; if (pred === m.yesWon) hc.ok++; else hc.bad++; } }
console.log('hourly alignment', hc);
// hit daily vs final price consistency (noon close > K implies hit_up yes)
let hh = { n: 0, viol: 0 };
const hdByEnd = new Map(hd.map((e) => [e.endTs, e]));
for (const u of d1) { if (u.finalPrice == null) continue; const dayEnd = hd.find((e) => e.startTs <= u.windowEnd && e.endTs > u.windowEnd); if (!dayEnd) continue;
  for (const m of dayEnd.markets) { hh.n++; if (m.strike.type === 'hit_up' && u.finalPrice >= m.strike.k && !m.yesWon) { hh.viol++; console.log('hit_up inconsistency', dayEnd.slug, m.strike.k, u.finalPrice); }
    if (m.strike.type === 'hit_down' && u.finalPrice <= m.strike.k && !m.yesWon) { hh.viol++; console.log('hit_down inconsistency', dayEnd.slug, m.strike.k, u.finalPrice); } } }
console.log('hit vs noon close', hh);
// chainlink ptb consistency between 5m, 15m, 4h at shared timestamps
const ptb = {}; for (const tf of ['5m', '15m', '4h', '1h']) ptb[tf] = new Map(loadUpDown(tf).filter((r) => r.priceToBeat != null).map((r) => [r.windowStart, r.priceToBeat]));
for (const [a, b] of [['5m', '15m'], ['15m', '4h'], ['5m', '4h'], ['15m', '1h'], ['5m', '1h']]) {
  let n = 0, eq = 0, diffs = [];
  for (const [t, p] of ptb[b]) { if (!ptb[a].has(t)) continue; n++; const d = ptb[a].get(t) - p; if (Math.abs(d) < 1e-6) eq++; else diffs.push(d); }
  diffs.sort((x, y) => Math.abs(x) - Math.abs(y));
  console.log(`ptb ${a} vs ${b}: shared ${n}, equal ${eq}, absdiff median ${diffs.length ? Math.abs(diffs[diffs.length >> 1]).toFixed(2) : '-'} p90 ${diffs.length ? Math.abs(diffs[Math.floor(diffs.length * 0.9)]).toFixed(2) : '-'}`);
}
// 4h alignment
const h4 = loadUpDown('4h'); console.log('4h starts mod 4h (UTC hours):', [...new Set(h4.slice(-20).map((r) => new Date(r.windowStart * 1000).getUTCHours()))]);
console.log('1d window (UTC hours):', [...new Set(d1.map((r) => new Date(r.windowEnd * 1000).getUTCHours()))]);
