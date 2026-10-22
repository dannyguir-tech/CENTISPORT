#!/usr/bin/env node
// Live order-book poller for the cross-market structure scan.
// Every --every seconds it POSTs /books for every open BTC market token (Up/Down 5m/15m/1h/4h/1d near-term windows,
// daily "above" ladders, daily range buckets, hourly "above" ladders, hit daily/weekly/monthly) and stores a compact
// snapshot (top 25 levels per side) under data/live_structure/. Event lists are refreshed every --relist seconds; the
// last few CLOSED 5m/15m windows are fetched each poll so in-play windows get their Chainlink priceToBeat
// (= previous window's finalPrice) even when gamma has not yet populated eventMetadata.
//
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
//   node analysis/structure/live_poll.mjs --minutes=40 --every=20 --relist=300
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { DATA, toTs, parseArr, chunk, log } from '../../lib/util.mjs';
import { parseStrike } from './common.mjs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const MINUTES = Number(args.minutes || 40), EVERY = Number(args.every || 20), RELIST = Number(args.relist || 300);
const OUT = path.join(DATA, 'live_structure');
fs.mkdirSync(OUT, { recursive: true });

const SERIES = [
  { series: 'btc-up-or-down-5m', kind: 'updown_5m', ahead: 1200 },
  { series: 'btc-up-or-down-15m', kind: 'updown_15m', ahead: 2700 },
  { series: 'btc-up-or-down-hourly', kind: 'updown_1h', ahead: 3 * 3600 },
  { series: 'btc-up-or-down-4h', kind: 'updown_4h', ahead: 8 * 3600 },
  { series: 'btc-up-or-down-daily', kind: 'updown_1d', ahead: 2 * 86400 },
  { series: 'btc-multi-strikes-weekly', kind: 'above_daily', ahead: 9 * 86400 },
  { series: 'bitcoin-neg-risk-weekly', kind: 'range_daily', ahead: 9 * 86400 },
  { series: 'bitcoin-multi-strikes-hourly', kind: 'above_hourly', ahead: 3 * 3600 },
  { series: 'bitcoin-hit-price-daily', kind: 'hit_daily', ahead: 3 * 86400 },
  { series: 'bitcoin-hit-price-weekly', kind: 'hit_weekly', ahead: 9 * 86400 },
  { series: 'bitcoin-hit-price-monthly', kind: 'hit_monthly', ahead: 40 * 86400 },
];

function normEvent(e, kind) {
  const isUD = kind.startsWith('updown');
  const markets = (e.markets || []).filter((m) => !m.closed || isUD).map((m) => {
    const outcomes = parseArr(m.outcomes) || [], toks = parseArr(m.clobTokenIds) || [];
    return {
      conditionId: m.conditionId, question: m.question, title: m.groupItemTitle || '', outcomes, tokenIds: toks,
      strike: isUD ? null : parseStrike(m.groupItemTitle || '', m.question || ''),
      closed: !!m.closed, acceptingOrders: m.acceptingOrders ?? null, eventStartTime: toTs(m.eventStartTime) || null,
      feeType: m.feeType ?? null, feeSchedule: m.feeSchedule ?? null, negRisk: !!m.negRisk,
    };
  });
  return {
    kind, slug: e.slug, startTs: toTs(e.startDate), endTs: toTs(e.endDate), windowStart: toTs(e.startTime || e.markets?.[0]?.eventStartTime) || null,
    eventMetadata: e.eventMetadata || null, negRisk: !!(e.negRisk || e.enableNegRisk), markets,
  };
}

let events = [];
let lastList = 0;
async function relist(now) {
  const out = [];
  for (const s of SERIES) {
    const evs = [];
    for (let off = 0; off < 1000; off += 100) {
      const page = await getJSON(`${GAMMA}/events?series_slug=${s.series}&closed=false&limit=100&offset=${off}&order=endDate&ascending=true`, { cache: false });
      if (!Array.isArray(page)) break;
      evs.push(...page);
      if (page.length < 100) break;
    }
    for (const e of evs) { const end = toTs(e.endDate); if (end && end > now && end < now + s.ahead) out.push(normEvent(e, s.kind)); }
  }
  events = out;
  lastList = now;
  log(`relisted ${events.length} events`);
}

async function recentClosed(series) {
  const page = await getJSON(`${GAMMA}/events?series_slug=${series}&closed=true&limit=8&order=endDate&ascending=false`, { cache: false });
  return (Array.isArray(page) ? page : []).map((e) => ({ slug: e.slug, windowStart: toTs(e.startTime || e.markets?.[0]?.eventStartTime), endTs: toTs(e.endDate), eventMetadata: e.eventMetadata || null }));
}

const top = (lv, n = 25) => lv.slice(0, n);
async function pollOnce() {
  const now = Math.floor(Date.now() / 1000);
  if (now - lastList >= RELIST || !events.length) await relist(now);
  const toks = [...new Set(events.flatMap((e) => e.markets.flatMap((m) => m.tokenIds)))];
  const t0 = Date.now();
  const books = {};
  await pool(chunk(toks, 200), 3, async (g) => {
    const res = await getJSON(`${CLOB}/books`, { method: 'POST', body: g.map((t) => ({ token_id: t })), cache: false });
    if (Array.isArray(res)) for (const b of res) {
      const bids = (b.bids || []).map((x) => [Number(x.price), Number(x.size)]).sort((a, c) => c[0] - a[0]);
      const asks = (b.asks || []).map((x) => [Number(x.price), Number(x.size)]).sort((a, c) => a[0] - c[0]);
      books[String(b.asset_id)] = { ts: b.timestamp ? Number(b.timestamp) : null, bids: top(bids), asks: top(asks), tick: b.tick_size ? Number(b.tick_size) : null, ltp: b.last_trade_price ? Number(b.last_trade_price) : null };
    }
  });
  const booksMs = Date.now() - t0;
  const closed5 = await recentClosed('btc-up-or-down-5m');
  const closed15 = await recentClosed('btc-up-or-down-15m');
  const closed4h = await recentClosed('btc-up-or-down-4h');
  const snap = { fetchedTs: now, booksMs, nTokens: toks.length, nBooks: Object.keys(books).length, events, recentClosed: { '5m': closed5, '15m': closed15, '4h': closed4h }, books };
  const f = path.join(OUT, `poll_${now}.json.gz`);
  fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(snap)));
  return { now, booksMs, n: toks.length, nb: snap.nBooks };
}

const tEnd = Date.now() + MINUTES * 60 * 1000;
let n = 0;
while (Date.now() < tEnd) {
  const t1 = Date.now();
  try { const r = await pollOnce(); n++; if (n % 5 === 1) log(`poll ${n}: tokens ${r.n} books ${r.nb} in ${r.booksMs}ms; requests ${stats.requests}`); }
  catch (e) { log('poll failed', e && e.message); }
  const wait = EVERY * 1000 - (Date.now() - t1);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
log(`done: ${n} polls, requests ${stats.requests}, failures ${stats.failures}`);
