// Capacity attack: executable depth for a TAKER BUY of an Up/Down token, from the 114 live order-book polls
// (data/live_structure, every 20s, 2026-10-22 11:05-11:43Z) plus the two collector snapshots.
// Effective ask side for buying S = S asks  UNION  complement bids q (an S ask at 1-q via mint). Reports, per timeframe and
// window phase, the median best effective ask spread and USDC notional available within +1c / +2c of the best effective ask.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const DIR = '/home/user/CENTISPORT/research/btc/data/live_structure';
const LEN = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const rows = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json.gz')).sort()) {
  let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f)))); } catch { continue; }
  const T = j.fetchedTs;
  for (const ev of j.events || []) {
    if (!String(ev.kind).startsWith('updown_')) continue;
    const tf = ev.kind.slice(7); const ws = ev.windowStart; const L = LEN[tf];
    if (!(ws <= T && T < ws + L)) continue;
    const m = ev.markets[0]; const [tu, td] = m.tokenIds; const bu = j.books[tu], bd = j.books[td];
    if (!bu || !bd) continue;
    for (const [S, own, comp] of [['U', bu, bd], ['D', bd, bu]]) {
      const asks = [...(own.asks || []).map(([p, s]) => [p, s]), ...(comp.bids || []).map(([q, s]) => [1 - q, s])].filter(([p]) => p > 0 && p < 1).sort((a, b) => a[0] - b[0]);
      const bids = [...(own.bids || []), ...(comp.asks || []).map(([q, s]) => [1 - q, s])].filter(([p]) => p > 0 && p < 1).sort((a, b) => b[0] - a[0]);
      if (!asks.length || !bids.length) continue;
      const ba = asks[0][0], bb = bids[0][0]; const mid = (ba + bb) / 2;
      if (mid < 0.1 || mid > 0.9) continue;
      // own-token asks only: the books are mirrored (own best ask == 1 - complement best bid in 100% of polls),
      // so summing both sides would double count the same resting orders
      const dep = (c) => (own.asks || []).filter(([p]) => p <= ba + c + 1e-9).reduce((s, [p, sz]) => s + p * sz, 0);
      const ownOnlyBest = (own.asks || []).length ? Math.min(...own.asks.map((x) => x[0])) : null;
      rows.push({ tf, phase: (T - ws) / L, S, mid, spread: ba - bb, askMinusMid: ba - mid, d1: dep(0.01), d2: dep(0.02), d5: dep(0.05), ownBestAsk: ownOnlyBest, effBestAsk: ba });
    }
  }
}
const q = (a, x) => { const s = [...a].sort((u, v) => u - v); return s.length ? s[Math.min(s.length - 1, Math.floor(x * (s.length - 1)))] : null; };
const out = {};
for (const tf of Object.keys(LEN)) for (const [ph, lo, hi] of [['all', 0, 1], ['first25%', 0, 0.25], ['25-50%', 0.25, 0.5], ['50-100%', 0.5, 1]]) {
  const a = rows.filter((r) => r.tf === tf && r.phase >= lo && r.phase < hi); if (!a.length) continue;
  out[`${tf} ${ph}`] = { nBooks: a.length, medSpread: +q(a.map((r) => r.spread), 0.5).toFixed(4), medAskMinusMid: +q(a.map((r) => r.askMinusMid), 0.5).toFixed(4), p90AskMinusMid: +q(a.map((r) => r.askMinusMid), 0.9).toFixed(4), medDepth1c: Math.round(q(a.map((r) => r.d1), 0.5)), medDepth2c: Math.round(q(a.map((r) => r.d2), 0.5)), p25Depth2c: Math.round(q(a.map((r) => r.d2), 0.25)), medDepth5c: Math.round(q(a.map((r) => r.d5), 0.5)), fracOwnAskEqEff: +(a.filter((r) => r.ownBestAsk != null && Math.abs(r.ownBestAsk - r.effBestAsk) < 1e-6).length / a.length).toFixed(2) };
}
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'out', 'depth.json'), JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(16), JSON.stringify(v));
