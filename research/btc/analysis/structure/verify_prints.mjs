#!/usr/bin/env node
// Print-level verification of the mid-path violation episodes.
// Price-history snapshots are mids (or last trades) and are NOT executable: a dead deep-ITM strike whose book is
// 0.01/0.99 shows a 0.50 mid. For a seeded random sample of the episodes that looked executable on mid + half-spread
// (episodes_exec.jsonl), we fetch the actual taker fills of every leg around the decision time from
// data-api /trades?market=<cid>&start=&end= and rebuild the basket cost from ASK-SIDE prints:
//   * a taker BUY of the leg token at p            -> an ask at p existed
//   * a taker SELL of the complementary token at q -> a bid for the complement at q existed = an ask for our token at 1-q
//     (CTF mint matching: the unified book shows complement bids as asks)
// Scenarios:
//   pl : last ask-side print of each leg in [t - Wback, t]  (no look-ahead; HEADLINE)
//   pm : cheapest ask-side print of each leg in [t - Wback, t + Wfwd]  (optimistic existence check; uses post-t prints)
// Usage: BTC_RPS=5 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node verify_prints.mjs [--cap=80] [--capMulti=30]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { mulberry32 } from '../../lib/util.mjs';
import { REPORT, feePS, r4, dayKey } from './common.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const CAP = Number(args.cap || 80), CAP_MULTI = Number(args.capMulti || 30);
const DAPI = 'https://data-api.polymarket.com';
const HIST = path.join(REPORT, 'hist');
const W = (kind) => (kind === 'updown_5m' || kind === 'updown_15m' ? [30, 30] : kind.startsWith('updown') ? [60, 60] : [300, 300]);
const BLOCK = 600;

// ------------------------------------------------------------------ sample episodes
const byFam = new Map();
const rl = readline.createInterface({ input: (fs.existsSync(path.join(HIST, 'episodes_exec.jsonl')) ? fs.createReadStream(path.join(HIST, 'episodes_exec.jsonl')) : fs.createReadStream(path.join(HIST, 'episodes_exec.jsonl.gz')).pipe((await import('node:zlib')).createGunzip())) });
for await (const line of rl) { if (!line) continue; const e = JSON.parse(line); if (!byFam.has(e.family)) byFam.set(e.family, []); byFam.get(e.family).push(e); }
const sample = [];
const population = {};
for (const [fam, eps] of byFam) {
  const rng = mulberry32(12345 + fam.length);
  const cap = eps[0].legs.length > 3 ? CAP_MULTI : CAP;
  const shuffled = eps.map((e) => [rng(), e]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const pick = shuffled.slice(0, cap);
  population[fam] = { execEpisodes: eps.length, sampled: pick.length };
  sample.push(...pick);
}
console.log('families', Object.keys(population).length, 'sampled episodes', sample.length);

// ------------------------------------------------------------------ fetch trades in blocks
const blockCache = new Map();
async function fetchBlock(cid, B) {
  const key = cid + '|' + B;
  if (blockCache.has(key)) return blockCache.get(key);
  const p = (async () => {
    const out = [];
    for (let off = 0; off <= 5000; off += 500) {
      const page = await getJSON(`${DAPI}/trades?market=${cid}&start=${B}&end=${B + BLOCK - 1}&limit=500&offset=${off}`, { allowStatus: [400, 404] });
      if (!Array.isArray(page)) break;
      for (const x of page) out.push({ t: x.timestamp, side: x.side, asset: String(x.asset), p: Number(x.price), s: Number(x.size) });
      if (page.length < 500) break;
    }
    return out;
  })();
  blockCache.set(key, p);
  return p;
}
async function tradesAround(cid, t0, t1) {
  const out = [];
  for (let B = Math.floor(t0 / BLOCK) * BLOCK; B <= t1; B += BLOCK) out.push(...(await fetchBlock(cid, B)));
  return out.filter((x) => x.t >= t0 && x.t <= t1);
}

// ------------------------------------------------------------------ evaluate
const FMS = ['docs_always', 'docs', 'flat2', 'zero'];
let done = 0, outOfRange = 0;
async function evalEpisode(e) {
  const t = e.start;
  const legsOut = [];
  for (const l of e.legs) {
    const [wb, wf] = W(l.kind);
    const tok = l.side === 'Y' ? String(l.yes) : String(l.no);
    const comp = l.side === 'Y' ? String(l.no) : String(l.yes);
    const tr = await tradesAround(l.cid, t - wb, t + wf);
    const ask = [], bid = [];
    for (const x of tr) {
      if (x.asset === tok && x.side === 'BUY') ask.push({ t: x.t, p: x.p, s: x.s });
      else if (x.asset === comp && x.side === 'SELL') ask.push({ t: x.t, p: 1 - x.p, s: x.s });
      else if (x.asset === tok && x.side === 'SELL') bid.push({ t: x.t, p: x.p, s: x.s });
      else if (x.asset === comp && x.side === 'BUY') bid.push({ t: x.t, p: 1 - x.p, s: x.s });
      else if (x.asset !== tok && x.asset !== comp) outOfRange++;
    }
    const before = ask.filter((x) => x.t <= t).sort((a, b) => a.t - b.t);
    const last = before.length ? before[before.length - 1] : null;
    const mn = ask.length ? ask.reduce((m, x) => (x.p < m.p ? x : m)) : null;
    const lastBid = bid.filter((x) => x.t <= t).sort((a, b) => a.t - b.t).pop() || null;
    legsOut.push({ kind: l.kind, side: l.side, won: l.won, nPrints: tr.length, nAsk: ask.length, last, min: mn, lastBid, fee: l.fee });
  }
  const res = { family: e.family, id: e.id, t, day: dayKey(t), minPay: e.minPay, payoff: e.payoff, v0: e.v0, maxV: e.maxV, mids0: e.mids0, nLegs: e.legs.length, legs: legsOut };
  for (const sc of ['pl', 'pm']) {
    const px = legsOut.map((l) => (sc === 'pl' ? l.last : l.min));
    if (px.some((x) => !x)) { res[sc] = null; continue; }
    const o = { prices: px.map((x) => r4(x.p)), sizeShares: Math.min(...px.map((x) => x.s)) };
    for (const fm of FMS) {
      const recFee = (i) => (legsOut[i].fee ? { fee: { feesEnabled: true, feeType: legsOut[i].fee, feeSchedule: legsOut[i].fee === 'crypto_fees_v2' ? { rate: 0.07, exponent: 1 } : { rate: 0.25, exponent: 2 } } } : { fee: { feesEnabled: false } });
      const cost = px.reduce((s, x, i) => s + x.p + feePS(x.p, recFee(i), fm), 0);
      o[fm] = { cost: r4(cost), margin: r4(e.minPay - cost), profit: r4(e.payoff - cost) };
    }
    res[sc] = o;
  }
  if (++done % 100 === 0) console.log(new Date().toISOString().slice(11, 19), 'evaluated', done, '/', sample.length, 'requests', stats.requests, 'cacheHits', stats.cacheHits);
  return res;
}
const results = await pool(sample, 6, evalEpisode);
const good = results.filter((r) => r && !r.__error);
const errs = results.filter((r) => r && r.__error);
fs.writeFileSync(path.join(HIST, 'verified_prints.jsonl'), good.map((x) => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(HIST, 'verified_population.json'), JSON.stringify({ population, errors: errs.length, errorSample: errs.slice(0, 5), requests: stats.requests, cacheHits: stats.cacheHits, failures: stats.failures, outOfRange }, null, 1));
// quick per-family summary
const fam = {};
for (const r of good) {
  const o = fam[r.family] ||= { sampled: 0, plAvail: 0, plArb: 0, pmAvail: 0, pmArb: 0, plProfit: 0, pmProfit: 0 };
  o.sampled++;
  if (r.pl) { o.plAvail++; if (r.pl.docs_always.margin > 0) { o.plArb++; o.plProfit += r.pl.docs_always.profit; } }
  if (r.pm) { o.pmAvail++; if (r.pm.docs_always.margin > 0) { o.pmArb++; o.pmProfit += r.pm.docs_always.profit; } }
}
console.table(fam);
console.log('requests', stats.requests, 'failures', stats.failures, 'errors', errs.length);
