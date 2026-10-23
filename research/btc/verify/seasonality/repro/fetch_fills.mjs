// Fetch real taker fills just after the FAV50 / FAV80 decision times for 1h, 4h and 1d Up/Down markets
// (no tapes exist for these timeframes), so snapshot-priced rules can be re-priced at executable fill prices.
//   4h: every market in the walk-forward OOS period, at t50 and t80 (window [t, t+600])
//   1h: every WEEKEND market in the OOS period + a seeded random 1000 weekday markets, at t50 (window [t, t+300])
//   1d: every market in the OOS period, at t50 (window [t, t+900])
// Uses the collector's polite cached client (rate limit, retries, gzip cache under data/raw/cache).
// Output: data/fills_probe.jsonl rows {tf, conditionId, action, t, wait, trades:[{t, side, o, p, s}]}
// Run: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt BTC_RPS=5 node fetch_fills.mjs
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, stats } from '/home/user/CENTISPORT/research/btc/lib/http.mjs';
import { DATA, mulberry32, writeJSONL } from '/home/user/CENTISPORT/research/btc/lib/util.mjs';
import { buildObs } from './features.mjs';
import { makeFolds } from './lib.mjs';

const DAPI = 'https://data-api.polymarket.com';
const plan = [];
for (const [tf, actions, wait] of [['4h', ['FAV50', 'FAV80'], 600], ['1h', ['FAV50'], 300], ['1d', ['FAV50'], 900]]) {
  const obs = buildObs(tf);
  const days = [...new Set(obs.map((o) => o.day))].sort();
  const { oosStart } = makeFolds(days);
  let sel = obs.filter((o) => o.day >= oosStart);
  if (tf === '1h') {
    const rnd = mulberry32(42);
    const wk = sel.filter((o) => o.weekend === 'WKDY').map((o) => [rnd(), o]).sort((a, b) => a[0] - b[0]).slice(0, 1000).map((x) => x[1]);
    sel = [...sel.filter((o) => o.weekend === 'WKND'), ...wk];
  }
  for (const o of sel) for (const a of actions) {
    const t = a === 'FAV50' ? o.t50 : o.t80; if (t == null) continue;
    const p = a === 'FAV50' ? o.p50 : o.p80; const pf = Math.max(p, 1 - p); if (pf < 0.55 || pf > 0.95) continue;
    plan.push({ tf, conditionId: o.conditionId, upTokenNeeded: true, action: a, t, wait });
  }
}
// token ids for Up/Down mapping
const tok = new Map();
for (const tf of ['1h', '4h', '1d']) for (const line of fs.readFileSync(path.join(DATA, `updown_${tf}.jsonl`), 'utf8').split('\n')) {
  if (!line) continue; const r = JSON.parse(line); tok.set(r.conditionId, [r.upToken, r.downToken]);
}
console.log('planned requests', plan.length, Object.entries(plan.reduce((m, p) => ((m[p.tf + p.action] = (m[p.tf + p.action] || 0) + 1), m), {})));
const out = []; let done = 0, errs = 0;
const t0 = Date.now();
const CONC = 5;
let next = 0;
async function worker() {
  while (next < plan.length) {
    const p = plan[next++];
    try {
      const page = await getJSON(`${DAPI}/trades?market=${p.conditionId}&limit=500&start=${Math.floor(p.t)}&end=${Math.floor(p.t + p.wait)}`, { allowStatus: [400, 404] });
      const [up, dn] = tok.get(p.conditionId) || [];
      const trades = Array.isArray(page) ? page.map((x) => ({ t: x.timestamp, side: x.side === 'BUY' ? 'B' : 'S', o: x.asset === up ? 'U' : x.asset === dn ? 'D' : '?', p: +x.price, s: +x.size })).sort((a, b) => a.t - b.t) : [];
      out.push({ tf: p.tf, conditionId: p.conditionId, action: p.action, t: p.t, wait: p.wait, ok: Array.isArray(page), trades });
    } catch (e) { errs++; out.push({ tf: p.tf, conditionId: p.conditionId, action: p.action, t: p.t, wait: p.wait, ok: false, err: String(e).slice(0, 200), trades: [] }); }
    if (++done % 250 === 0) console.log(`${done}/${plan.length} ${((Date.now() - t0) / 1000).toFixed(0)}s req=${stats.requests} hits=${stats.cacheHits} errs=${errs}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
writeJSONL(path.join(DATA, 'fills_probe.jsonl'), out);
console.log('done', out.length, 'errors', errs, 'secs', ((Date.now() - t0) / 1000).toFixed(0), JSON.stringify({ requests: stats.requests, cacheHits: stats.cacheHits, retries: stats.retries, failures: stats.failures }));
