#!/usr/bin/env node
// Print-first census of the nested Chainlink Up/Down relation (risk-free: outer and inner windows share the same
// end E and the same Chainlink final value; if ptb_inner >= ptb_outer then Up_inner => Up_outer, else Down_inner => Down_outer).
// Unlike verify_prints.mjs (which re-priced moments pre-selected by the ~1/min mid path), this scans EVERY taker print.
//
// For each pair we download every taker fill of both markets during the inner window [S_I, E] (data-api /trades) and
// build ask-side events per leg token X: a taker BUY of X at p (an ask at p existed) or a taker SELL of the complement
// at q (a complement bid at q = an ask for X at 1-q via CTF mint matching).
// Decision rule (no look-ahead): at each print time t, using only prints with timestamp <= t, take the latest ask-side
// print of each leg if it is at most W s old; basket cost = sum(p + 0.07 p (1-p)). Enter the first time
// 1 - cost > theta (one entry per pair). The "last print" is an optimistic proxy for the current ask (it may have been
// the last share at that price), so we also report FOLLOW-THROUGH: the first ask-side print of each leg strictly after t
// (within 15 s) — what a taker arriving after the signal actually paid.
// Grid: W {10, 30, 60} s x theta {0, 0.01, 0.02}. Walk-forward: (W, theta) chosen on the first 40% of days by ROI,
// OOS on the rest; day-clustered bootstrap; durations = seconds the violation persisted on the print clock.
// Usage: BTC_RPS=4 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node print_scan.mjs [--n15=600]
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown } from '../../lib/load.mjs';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { mulberry32 } from '../../lib/util.mjs';
import { REPORT, r4, dayKey, bootstrapByDay, writeJSON, writeCSV } from './common.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const N15 = Number(args.n15 || 600);
const fee = (p) => 0.07 * p * (1 - p);
const WS = [10, 30, 60], THS = [0, 0.01, 0.02];
const DAPI = 'https://data-api.polymarket.com';

// ------------------------------------------------------------------ pairs
function pairs(outerTf, innerTf) {
  const inner = new Map(loadUpDown(innerTf).map((r) => [r.windowEnd, r]));
  const out = [];
  for (const o of loadUpDown(outerTf)) {
    if (o.priceToBeat == null) continue;
    const i = inner.get(o.windowEnd);
    if (!i || i.priceToBeat == null || !(i.windowStart > o.windowStart)) continue;
    const d = i.priceToBeat - o.priceToBeat;
    const legs = d >= 0 ? [{ rec: o, tok: o.upToken, comp: o.downToken, won: o.upWon }, { rec: i, tok: i.downToken, comp: i.upToken, won: !i.upWon }]
                        : [{ rec: o, tok: o.downToken, comp: o.upToken, won: !o.upWon }, { rec: i, tok: i.upToken, comp: i.downToken, won: i.upWon }];
    out.push({ family: `nest_cl_${outerTf}_${innerTf}`, id: `${o.slug}|${i.slug}`, d, S: i.windowStart, E: o.windowEnd, day: dayKey(i.windowStart), legs, payoff: legs.filter((l) => l.won).length });
  }
  return out;
}
const rng = mulberry32(2026);
const p15 = pairs('15m', '5m').map((x) => [rng(), x]).sort((a, b) => a[0] - b[0]).slice(0, N15).map((x) => x[1]);
const all = [...pairs('4h', '15m'), ...pairs('4h', '5m'), ...p15];
console.log('pairs', all.length, JSON.stringify(all.reduce((m, p) => { m[p.family] = (m[p.family] || 0) + 1; return m; }, {})));

// ------------------------------------------------------------------ trades
async function tradesOf(cid, t0, t1) {
  const out = [];
  for (let off = 0; off <= 10000; off += 500) {
    const page = await getJSON(`${DAPI}/trades?market=${cid}&start=${t0}&end=${t1}&limit=500&offset=${off}`, { allowStatus: [400, 404] });
    if (!Array.isArray(page)) break;
    for (const x of page) out.push({ t: x.timestamp, side: x.side, asset: String(x.asset), p: Number(x.price), s: Number(x.size) });
    if (page.length < 500) break;
  }
  return out;
}
let done = 0;
const res = await pool(all, 4, async (pr) => {
  const evs = [];
  const nPrints = [];
  for (let li = 0; li < 2; li++) {
    const L = pr.legs[li];
    const tr = await tradesOf(L.rec.conditionId, pr.S, pr.E + 60);
    nPrints.push(tr.length);
    for (const x of tr) {
      if (x.t > pr.E) continue;
      if (x.asset === String(L.tok) && x.side === 'BUY') evs.push({ t: x.t, leg: li, p: x.p, s: x.s });
      else if (x.asset === String(L.comp) && x.side === 'SELL') evs.push({ t: x.t, leg: li, p: 1 - x.p, s: x.s });
    }
  }
  evs.sort((a, b) => a.t - b.t);
  const out = { family: pr.family, id: pr.id, day: pr.day, d: r4(pr.d), payoff: pr.payoff, nPrints, nAskEvents: evs.length, grid: {} };
  for (const W of WS) {
    // sweep: violation state between print times
    const last = [null, null];
    let maxMargin = -Infinity, violSec = 0, prevT = null, prevViol = false, firstByTh = {};
    for (let k = 0; k < evs.length; k++) {
      const e = evs[k];
      if (prevT != null && prevViol) violSec += Math.min(e.t - prevT, W);
      last[e.leg] = e;
      if (k + 1 < evs.length && evs[k + 1].t === e.t) { prevT = e.t; continue; } // process all prints at the same second first
      const ok = last.every((x) => x && e.t - x.t <= W);
      let viol = false;
      if (ok) {
        const cost = last.reduce((a, x) => a + x.p + fee(x.p), 0);
        const margin = 1 - cost;
        maxMargin = Math.max(maxMargin, margin);
        viol = margin > 0;
        for (const th of THS) if (margin > th && !firstByTh[th]) {
          // follow-through: first ask print of each leg strictly after t within 15 s
          const fol = [0, 1].map((li) => evs.find((x) => x.leg === li && x.t > e.t && x.t <= e.t + 15) || null);
          const folCost = fol.every(Boolean) ? fol.reduce((a, x) => a + x.p + fee(x.p), 0) : null;
          firstByTh[th] = { t: e.t, secToEnd: pr.E - e.t, cost: r4(cost), margin: r4(margin), sizeShares: r4(Math.min(last[0].s, last[1].s)), prices: last.map((x) => r4(x.p)), profit: r4(pr.payoff - cost), folCost: folCost == null ? null : r4(folCost), folProfit: folCost == null ? null : r4(pr.payoff - folCost) };
        }
      }
      prevT = e.t; prevViol = viol;
    }
    out.grid[W] = { maxMargin: Number.isFinite(maxMargin) ? r4(maxMargin) : null, violSec, first: firstByTh };
  }
  if (++done % 100 === 0) console.log(new Date().toISOString().slice(11, 19), 'pairs', done, '/', all.length, 'requests', stats.requests, 'cache', stats.cacheHits);
  return out;
});
const good = res.filter((r) => r && !r.__error);
fs.mkdirSync(path.join(REPORT, 'printscan'), { recursive: true });
fs.writeFileSync(path.join(REPORT, 'printscan', 'pairs.jsonl'), good.map((x) => JSON.stringify(x)).join('\n') + '\n');

// ------------------------------------------------------------------ stats
const fams = [...new Set(good.map((r) => r.family))];
const summary = { generatedAt: new Date().toISOString(), requests: stats.requests, failures: stats.failures, errors: res.length - good.length, families: {} };
const variants = [];
for (const f of fams) {
  const G = good.filter((r) => r.family === f);
  const days = [...new Set(G.map((r) => r.day))].sort();
  const fs_ = summary.families[f] = { pairs: G.length, days: days.length, from: days[0], to: days[days.length - 1], medAskEvents: G.map((r) => r.nAskEvents).sort((a, b) => a - b)[G.length >> 1], byW: {} };
  for (const W of WS) {
    const viol = G.filter((r) => r.grid[W].maxMargin != null && r.grid[W].maxMargin > 0);
    const vs = viol.map((r) => r.grid[W].violSec).sort((a, b) => a - b);
    fs_.byW[W] = { pairsWithViolation: viol.length, share: r4(viol.length / G.length), violSecP50: vs.length ? vs[vs.length >> 1] : null, violSecP90: vs.length ? vs[Math.floor(vs.length * 0.9)] : null,
      maxMarginP50: viol.length ? viol.map((r) => r.grid[W].maxMargin).sort((a, b) => a - b)[viol.length >> 1] : null };
    for (const th of THS) {
      const tr = G.filter((r) => r.grid[W].first[th]).map((r) => ({ day: r.day, ...r.grid[W].first[th], payoff: r.payoff }));
      if (!tr.length) continue;
      const b = bootstrapByDay(tr.map((x) => ({ day: x.day, profit: x.profit, cost: x.cost })));
      const fol = tr.filter((x) => x.folCost != null);
      const bf = fol.length ? bootstrapByDay(fol.map((x) => ({ day: x.day, profit: x.folProfit, cost: x.folCost }))) : null;
      const spanDays = (Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86400000 + 1;
      const scale = f === 'nest_cl_15m_5m' ? pairs('15m', '5m').length / G.length : 1;
      variants.push({ family: f, W, theta: th, mode: 'fixed', n: tr.length, days: b.nDays, winRate: r4(tr.filter((x) => x.profit > 0).length / tr.length), avgCost: r4(tr.reduce((a, x) => a + x.cost, 0) / tr.length), roi: r4(b.roi), ci: b.ci.map(r4), p: b.pOneSided,
        medSize: tr.map((x) => x.sizeShares).sort((a, c) => a - c)[tr.length >> 1], medSecToEnd: tr.map((x) => x.secToEnd).sort((a, c) => a - c)[tr.length >> 1],
        folN: fol.length, folRoi: bf ? r4(bf.roi) : null, folCi: bf ? bf.ci.map(r4) : null, folWin: fol.length ? r4(fol.filter((x) => x.folProfit > 0).length / fol.length) : null,
        usdPerDay: r4(tr.reduce((a, x) => a + Math.max(0, x.profit) * x.sizeShares, 0) * scale / spanDays), usdPerDayFollow: r4(fol.reduce((a, x) => a + x.folProfit * x.sizeShares, 0) * scale / spanDays) });
    }
  }
  // walk-forward over (W, theta)
  const nTr = Math.max(3, Math.floor(days.length * 0.4));
  const trainDays = new Set(days.slice(0, nTr)), testDays = new Set(days.slice(nTr));
  let best = null;
  for (const W of WS) for (const th of THS) {
    const tr = G.filter((r) => trainDays.has(r.day) && r.grid[W].first[th]).map((r) => r.grid[W].first[th]);
    if (tr.length < 3) continue;
    const roi = tr.reduce((a, x) => a + x.profit, 0) / tr.reduce((a, x) => a + x.cost, 0);
    if (!best || roi > best.roi) best = { W, th, roi: r4(roi), n: tr.length };
  }
  const pick = best || { W: 30, th: 0 };
  const oos = G.filter((r) => testDays.has(r.day) && r.grid[pick.W].first[pick.th]).map((r) => ({ day: r.day, ...r.grid[pick.W].first[pick.th] }));
  const b = bootstrapByDay(oos.map((x) => ({ day: x.day, profit: x.profit, cost: x.cost })));
  const fol = oos.filter((x) => x.folCost != null);
  const bf = fol.length ? bootstrapByDay(fol.map((x) => ({ day: x.day, profit: x.folProfit, cost: x.folCost }))) : null;
  const span = testDays.size ? (Date.parse([...testDays].pop()) - Date.parse([...testDays][0])) / 86400000 + 1 : 1;
  const scale = f === 'nest_cl_15m_5m' ? pairs('15m', '5m').length / G.length : 1;
  variants.push({ family: f, W: pick.W, theta: pick.th, mode: 'walk-forward', trainBest: best, oosFrom: [...testDays][0], oosTo: [...testDays].pop(), oosPairs: G.filter((r) => testDays.has(r.day)).length, n: oos.length, days: b.nDays,
    winRate: oos.length ? r4(oos.filter((x) => x.profit > 0).length / oos.length) : null, avgCost: oos.length ? r4(oos.reduce((a, x) => a + x.cost, 0) / oos.length) : null, roi: r4(b.roi), ci: b.ci.map(r4), p: b.pOneSided,
    medSize: oos.length ? oos.map((x) => x.sizeShares).sort((a, c) => a - c)[oos.length >> 1] : null,
    folN: fol.length, folRoi: bf ? r4(bf.roi) : null, folCi: bf ? bf.ci.map(r4) : null, folP: bf ? bf.pOneSided : null, folWin: fol.length ? r4(fol.filter((x) => x.folProfit > 0).length / fol.length) : null,
    usdPerDay: r4(oos.reduce((a, x) => a + Math.max(0, x.profit) * x.sizeShares, 0) * scale / span), usdPerDayFollow: r4(fol.reduce((a, x) => a + x.folProfit * x.sizeShares, 0) * scale / span) });
}
summary.variants = variants;
writeJSON('printscan/summary.json', summary);
writeCSV('printscan/variants.csv', variants.map((v) => ({ ...v, ci: `[${(v.ci || []).join(';')}]`, folCi: v.folCi ? `[${v.folCi.join(';')}]` : '', trainBest: v.trainBest ? JSON.stringify(v.trainBest) : '' })));
for (const [f, o] of Object.entries(summary.families)) console.log(f, JSON.stringify(o));
for (const v of variants) console.log(v.family.padEnd(16), v.mode.padEnd(12), 'W', v.W, 'th', v.theta, 'n', String(v.n).padEnd(4), 'win', v.winRate, 'cost', v.avgCost, 'roi', v.roi, 'ci', JSON.stringify(v.ci), 'p', v.p?.toFixed?.(4), '| follow n', v.folN, 'roi', v.folRoi, JSON.stringify(v.folCi), '| medSize', v.medSize, '$/day', v.usdPerDay, 'follow $/day', v.usdPerDayFollow);
console.log('requests', stats.requests, 'failures', stats.failures);
