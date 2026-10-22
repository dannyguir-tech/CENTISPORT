#!/usr/bin/env node
// Print-level check of the implied-state walk-forward OOS trades (hc1 scenario): fetch the traded market's taker
// fills around each decision time and re-price the entry from real ASK-side prints:
//   pl : last ask-side print in [t-30, t]   (what was just paid; no look-ahead)
//   pn : first ask-side print in (t, t+20]  (what a taker arriving right after t would likely have paid)
// ask-side print = taker BUY of the token at p, or taker SELL of the complement at q (-> 1-q).
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { REPORT, r4, bootstrapByDay, writeJSON } from './common.mjs';

const rows = fs.readFileSync(path.join(REPORT, 'implied', 'wf_oos.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.s === 'hc1' && ['implied_15m_5m_outer', 'implied_4h_15m_outer', 'implied_4h_5m_outer'].includes(r.rule)); // only rules whose mid-based WF OOS ROI was > 0
console.log('WF OOS hc1 rows', rows.length);
const fee = (p) => 0.07 * p * (1 - p);
let done = 0;
const res = await pool(rows, 5, async (r) => {
  const tr = [];
  for (let off = 0; off <= 3000; off += 500) {
    const page = await getJSON(`https://data-api.polymarket.com/trades?market=${r.cid}&start=${r.t - 30}&end=${r.t + 20}&limit=500&offset=${off}`, { allowStatus: [400, 404] });
    if (!Array.isArray(page)) break;
    tr.push(...page);
    if (page.length < 500) break;
  }
  const ask = tr.filter((x) => (String(x.asset) === String(r.tok) && x.side === 'BUY') || (String(x.asset) === String(r.comp) && x.side === 'SELL'))
    .map((x) => ({ t: x.timestamp, p: String(x.asset) === String(r.tok) ? Number(x.price) : 1 - Number(x.price), s: Number(x.size) })).sort((a, b) => a.t - b.t);
  const before = ask.filter((x) => x.t <= r.t), after = ask.filter((x) => x.t > r.t);
  const pl = before.length ? before[before.length - 1] : null, pn = after.length ? after[0] : null;
  if (++done % 200 === 0) console.log('done', done, 'requests', stats.requests);
  return { ...r, nPrints: tr.length, pl: pl && r4(pl.p + fee(pl.p)), pn: pn && r4(pn.p + fee(pn.p)), plSize: pl && pl.s, pnSize: pn && pn.s };
});
const good = res.filter((x) => x && !x.__error);
fs.writeFileSync(path.join(REPORT, 'implied', 'wf_oos_prints.jsonl'), good.map((x) => JSON.stringify(x)).join('\n') + '\n');
const out = [];
for (const rule of [...new Set(good.map((x) => x.rule))]) {
  const g = good.filter((x) => x.rule === rule);
  const o = { rule, n: g.length, mid: (() => { const b = bootstrapByDay(g); return { roi: r4(b.roi), ci: b.ci.map(r4), p: b.pOneSided }; })() };
  for (const k of ['pl', 'pn']) {
    const h = g.filter((x) => x[k] != null).map((x) => ({ day: x.day, cost: x[k], profit: x.payoff - x[k] }));
    const b = bootstrapByDay(h);
    o[k] = { n: h.length, avgCost: r4(h.reduce((a, x) => a + x.cost, 0) / h.length), winRate: r4(g.filter((x) => x[k] != null && x.payoff).length / h.length), roi: r4(b.roi), ci: b.ci.map(r4), p: b.pOneSided, days: b.nDays,
      slipVsAssumed: r4(g.filter((x) => x[k] != null).reduce((a, x) => a + x[k] - x.cost, 0) / h.length), midRoiSameSubset: r4(g.filter((x) => x[k] != null).reduce((a, x) => a + x.payoff - x.cost, 0) / g.filter((x) => x[k] != null).reduce((a, x) => a + x.cost, 0)) };
  }
  out.push(o);
}
writeJSON('implied/print_check.json', out);
console.log(JSON.stringify(out, null, 1));
console.log('requests', stats.requests, 'failures', stats.failures);
