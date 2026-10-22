// Fill-realism attack: for every OOS trade of the positive-ROI TAKER candidates, fetch the real taker fills of
// that market in [t_dec - 2s, t_dec + 60s] (t_dec = the analyst's decision real time = snapshot label - 16s) from
// data-api /trades?market=&start=&end=, so the snapshot price can be compared with prices that actually traded.
// Writes verify/momentum/data/cand_fills.jsonl. Polite: BTC_RPS<=3, cached under data/raw/cache.
//   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt BTC_RPS=2.5 BTC_CONC=3 node fetch_fills.mjs
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { loadUpDown } from '../../lib/load.mjs';
import { writeJSONL, log } from '../../lib/util.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const A = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'attack_LAG16_LAT5.json'), 'utf8')).candidates;
const IDS = ['A-mag-rev-5m', 'A-streak-rev-1h', 'W-lvl-mom-5m-f0.2', 'W-lvl-mom-15m-f0.2', 'X-cnt-mom-1h-from-15m', 'A-last5-mom-1h', 'A-prev-rev-4h', 'W-vel-mom-1d-f0.4', 'W-lvl-mom-5m-f0.4', 'X-cnt-mom-1d-from-4h', 'W-lvl-rev-1d-f0.2', 'W-vel-mom-1d-f0.8'];
const bySlug = new Map();
for (const tf of ['5m', '15m', '1h', '4h', '1d']) for (const r of loadUpDown(tf)) bySlug.set(r.slug, r);
const plan = new Map();
for (const id of IDS) for (const t of A[id].trades) {
  const r = bySlug.get(t.id); if (!r) continue;
  const key = `${r.conditionId}|${t.t}`;
  if (!plan.has(key)) plan.set(key, { conditionId: r.conditionId, slug: t.id, up: r.upToken, dn: r.downToken, t: t.t });
}
const items = [...plan.values()];
log('planned', items.length);
const out = []; let done = 0;
await pool(items, 3, async (p) => {
  const page = await getJSON(`https://data-api.polymarket.com/trades?market=${p.conditionId}&limit=500&start=${p.t - 2}&end=${p.t + 60}`, { allowStatus: [400, 404] });
  const trades = Array.isArray(page) ? page.map((x) => ({ t: x.timestamp, side: x.side === 'BUY' ? 'B' : 'S', o: x.asset === p.up ? 'U' : x.asset === p.dn ? 'D' : '?', p: +x.price, s: +x.size })).sort((a, b) => a.t - b.t) : null;
  out.push({ slug: p.slug, conditionId: p.conditionId, t: p.t, ok: Array.isArray(page), n: trades ? trades.length : 0, trades: trades || [] });
  if (++done % 200 === 0) log(`${done}/${items.length} req=${stats.requests} hits=${stats.cacheHits} fail=${stats.failures}`);
});
writeJSONL(path.join(HERE, 'data', 'cand_fills.jsonl'), out);
log('done', out.length, JSON.stringify({ requests: stats.requests, cacheHits: stats.cacheHits, retries: stats.retries, failures: stats.failures }));
