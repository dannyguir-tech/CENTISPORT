// Fresh-data attack: fetch settled Up/Down windows that are OLDER than anything the analyst used,
// so the leads can be tested at their walk-forward-chosen thresholds on data that played no role in choosing them.
// Writes ONLY under verify/momentum/data/ (does not touch the shared data/updown_*.jsonl files).
//   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt BTC_RPS=4 BTC_CONC=4 node fetch_ext.mjs --tf=5m --from=2026-04-01 --to=2026-09-07T09:55:00Z
// Code for listing / normalising / price paths is copied from collect.mjs (same endpoints, same fields).
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { toTs, isoOf, dayKey, parseArr, writeJSONL, chunk, log } from '../../lib/util.mjs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const CFG = {
  '5m': { series: 'btc-up-or-down-5m', len: 300, chunk: 20, winDays: 1 },
  '15m': { series: 'btc-up-or-down-15m', len: 900, chunk: 20, winDays: 1 },
  '1h': { series: 'btc-up-or-down-hourly', len: 3600, chunk: 20, winDays: 4 },
  '4h': { series: 'btc-up-or-down-4h', len: 14400, chunk: 10, winDays: 16 },
};
const tf = args.tf; const cfg = CFG[tf];
const FROM = toTs(args.from), TO = toTs(args.to);
const OUTDIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
fs.mkdirSync(OUTDIR, { recursive: true });

async function fetchSeriesEvents(series, fromTs, toTs, winDays) {
  const seen = new Map(); const wins = [];
  let a = Math.floor(fromTs / 86400) * 86400;
  while (a < toTs) { const b = Math.min(a + winDays * 86400, toTs); wins.push([a, b]); a = b; }
  let done = 0;
  await pool(wins, 3, async ([a, b]) => {
    for (let off = 0; off < 20000; off += 100) {
      const url = `${GAMMA}/events?series_slug=${series}&end_date_min=${isoOf(a)}&end_date_max=${isoOf(b)}&limit=100&offset=${off}&order=endDate&ascending=true`;
      const page = await getJSON(url);
      if (!Array.isArray(page)) break;
      for (const e of page) seen.set(e.slug, e);
      if (page.length < 100) break;
    }
    if (++done % 10 === 0) log(`  listing ${done}/${wins.length} windows, ${seen.size} events, req=${stats.requests}`);
  });
  return [...seen.values()];
}
function feeFields(m) {
  return { feesEnabled: m.feesEnabled ?? null, feeType: m.feeType ?? null, feeSchedule: m.feeSchedule ?? null, makerBaseFee: m.makerBaseFee ?? null, takerBaseFee: m.takerBaseFee ?? null, makerRebatesFeeShareBps: m.makerRebatesFeeShareBps ?? null };
}
function normUpDown(e, skips) {
  const skip = (r) => { skips[r] = (skips[r] || 0) + 1; return null; };
  const m = e.markets && e.markets[0];
  if (!m) return skip('noMarket');
  const outcomes = parseArr(m.outcomes), prices = parseArr(m.outcomePrices), toks = parseArr(m.clobTokenIds);
  if (!outcomes || !toks || toks.length !== 2) return skip('noTokens');
  const iUp = outcomes.findIndex((o) => /^up$/i.test(o)), iDn = outcomes.findIndex((o) => /^down$/i.test(o));
  if (iUp < 0 || iDn < 0) return skip('badOutcomes');
  if (!m.closed) return skip('notClosed');
  const pu = Number(prices && prices[iUp]), pd = Number(prices && prices[iDn]);
  let winner = null;
  if (pu === 1 && pd === 0) winner = 'Up'; else if (pu === 0 && pd === 1) winner = 'Down'; else return skip('unresolvedOrVoid');
  const windowEnd = toTs(m.endDate || e.endDate);
  let windowStart = toTs(m.eventStartTime || e.startTime), startInferred = false;
  if (!windowStart) { windowStart = windowEnd - cfg.len; startInferred = true; }
  return {
    tf, slug: e.slug, conditionId: m.conditionId, upToken: toks[iUp], downToken: toks[iDn], windowStart, windowEnd, startInferred, day: dayKey(windowStart),
    winner, upWon: winner === 'Up', priceToBeat: e.eventMetadata?.priceToBeat ?? null, finalPrice: e.eventMetadata?.finalPrice ?? null,
    volume: Number(m.volumeNum ?? m.volume ?? 0), closedTs: toTs(m.closedTime || e.closedTime), fee: feeFields(m),
    resolutionSource: m.resolutionSource || e.resolutionSource || null, cryptoMarketConfigId: m.cryptoMarketConfigId ?? null,
  };
}
async function attachPaths(recs) {
  recs.sort((a, b) => a.windowStart - b.windowStart);
  const pre = Math.max(cfg.len, 600);
  const groups = chunk(recs, cfg.chunk);
  let done = 0;
  await pool(groups, 4, async (g) => {
    const start = Math.min(...g.map((r) => r.windowStart)) - pre;
    const end = Math.max(...g.map((r) => r.windowEnd)) + 60;
    const res = await getJSON(`${CLOB}/batch-prices-history`, { method: 'POST', body: { markets: g.map((r) => r.upToken), start_ts: start, end_ts: end, fidelity: 1 } });
    const h = (res && res.history) || {};
    for (const r of g) { r.pathFrom = r.windowStart - pre; r.pathTo = r.windowEnd + 60; r.path = (h[r.upToken] || []).filter((x) => x.t >= r.pathFrom && x.t <= r.pathTo).map((x) => [x.t, x.p]); }
    if (++done % 100 === 0) log(`  paths ${done}/${groups.length} req=${stats.requests}`);
  });
}
log(`[ext ${tf}] ${cfg.series} ${isoOf(FROM)} -> ${isoOf(TO)}`);
const evs = await fetchSeriesEvents(cfg.series, FROM, TO, cfg.winDays);
const skips = {};
let recs = evs.map((e) => normUpDown(e, skips)).filter(Boolean).filter((r) => r.windowEnd <= TO && r.windowStart >= FROM);
recs = [...new Map(recs.map((r) => [r.conditionId, r])).values()];
log(`[ext ${tf}] ${evs.length} events -> ${recs.length} settled; skips ${JSON.stringify(skips)}`);
await attachPaths(recs);
const file = path.join(OUTDIR, `updown_${tf}_ext.jsonl`);
writeJSONL(file, recs);
log(`[ext ${tf}] wrote ${recs.length} -> ${file}; days ${new Set(recs.map((r) => r.day)).size}; empty paths ${recs.filter((r) => !r.path || !r.path.length).length}; http ${JSON.stringify({ requests: stats.requests, cacheHits: stats.cacheHits, retries: stats.retries, failures: stats.failures })}`);
