#!/usr/bin/env node
// BTC Polymarket data collector.
// Usage (from anywhere):
//   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
//     node /home/user/CENTISPORT/research/btc/collect.mjs [--stages=fees,updown,trades,ladders,live] [--tfs=5m,15m,1h,4h,1d]
// Every HTTP response for settled data is cached (gzip) under data/raw/cache, so re-runs resume.
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from './lib/http.mjs';
import { DATA, toTs, isoOf, dayKey, parseArr, mulberry32, writeJSONL, writeJSON, readJSONL, chunk, log } from './lib/util.mjs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DAPI = 'https://data-api.polymarket.com';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const STAGES = (args.stages || 'fees,updown,trades,ladders,live').split(',');
const T0 = Date.now();
const NOW = Math.floor(T0 / 1000);
const SETTLED_BEFORE = NOW - 15 * 60; // only windows that ended >= 15 min ago

export const UPDOWN = {
  '5m': { series: 'btc-up-or-down-5m', len: 300, days: 12, chunk: 20, winDays: 1 },
  '15m': { series: 'btc-up-or-down-15m', len: 900, days: 32, chunk: 20, winDays: 1 },
  '1h': { series: 'btc-up-or-down-hourly', len: 3600, days: 125, chunk: 20, winDays: 4 },
  '4h': { series: 'btc-up-or-down-4h', len: 14400, days: 200, chunk: 10, winDays: 16 },
  '1d': { series: 'btc-up-or-down-daily', len: 86400, days: 640, chunk: 5, winDays: 90 },
};
const TFS = (args.tfs || Object.keys(UPDOWN).join(',')).split(',');
// optional history overrides, e.g. --days5m=45 --days15m=90 --days1h=180
for (const tf of Object.keys(UPDOWN)) if (args['days' + tf]) UPDOWN[tf].days = Number(args['days' + tf]);
// trades subsample is drawn only from the most recent N days (spec: 5m ~12d, 15m ~32d)
const TRADE_DAYS = { '5m': Number(args.tradeDays5m || 12), '15m': Number(args.tradeDays15m || 32) };

export const LADDERS = [
  { series: 'btc-multi-strikes-weekly', kind: 'above_daily', days: 120, winDays: 30 },
  { series: 'bitcoin-neg-risk-weekly', kind: 'range_daily', days: 120, winDays: 30 },
  { series: 'bitcoin-multi-strikes-hourly', kind: 'above_hourly', days: 10, winDays: 2 },
  { series: 'bitcoin-hit-price-daily', kind: 'hit_daily', days: 90, winDays: 30 },
  { series: 'bitcoin-hit-price-weekly', kind: 'hit_weekly', days: 400, winDays: 200 },
  { series: 'bitcoin-hit-price-monthly', kind: 'hit_monthly', days: 400, winDays: 400 },
];

const manifestPath = path.join(DATA, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { datasets: {} };
manifest.datasets ||= {};
const problems = [];
const PREV_PROBLEMS = args.resetProblems ? [] : (manifest.problems || []);
function problem(msg) { problems.push(msg); log('PROBLEM', msg); }

// ---------------------------------------------------------------- gamma event paging
async function fetchSeriesEvents(series, fromTs, toTs, winDays, { closed = null, cache = true } = {}) {
  const seen = new Map();
  const wins = [];
  let a = Math.floor(fromTs / 86400) * 86400;
  while (a < toTs) { const b = Math.min(a + winDays * 86400, toTs); wins.push([a, b]); a = b; }
  await pool(wins, 4, async ([a, b]) => {
    for (let off = 0; off < 20000; off += 100) {
      const url = `${GAMMA}/events?series_slug=${series}&end_date_min=${isoOf(a)}&end_date_max=${isoOf(b)}` +
        `&limit=100&offset=${off}&order=endDate&ascending=true${closed === null ? '' : `&closed=${closed}`}`;
      const page = await getJSON(url, { cache });
      if (!Array.isArray(page)) { problem(`gamma non-array for ${url}`); break; }
      for (const e of page) seen.set(e.slug, e);
      if (page.length < 100) break;
    }
  });
  return [...seen.values()];
}

function feeFields(m) {
  return {
    feesEnabled: m.feesEnabled ?? null, feeType: m.feeType ?? null, feeSchedule: m.feeSchedule ?? null,
    makerBaseFee: m.makerBaseFee ?? null, takerBaseFee: m.takerBaseFee ?? null,
    makerRebatesFeeShareBps: m.makerRebatesFeeShareBps ?? null,
  };
}

// ---------------------------------------------------------------- Up/Down
function normUpDown(e, tf, cfg, skips) {
  const skip = (r) => { skips[r] = (skips[r] || 0) + 1; return null; };
  const m = e.markets && e.markets[0];
  if (!m) return skip('noMarket');
  if (e.markets.length !== 1) skips.multiMarketEvent = (skips.multiMarketEvent || 0) + 1;
  const outcomes = parseArr(m.outcomes), prices = parseArr(m.outcomePrices), toks = parseArr(m.clobTokenIds);
  if (!outcomes || !toks || toks.length !== 2) return skip('noTokens');
  const iUp = outcomes.findIndex((o) => /^up$/i.test(o)), iDn = outcomes.findIndex((o) => /^down$/i.test(o));
  if (iUp < 0 || iDn < 0) return skip('badOutcomes');
  if (!m.closed) return skip('notClosed');
  const pu = Number(prices && prices[iUp]), pd = Number(prices && prices[iDn]);
  let winner = null;
  if (pu === 1 && pd === 0) winner = 'Up'; else if (pu === 0 && pd === 1) winner = 'Down';
  else return skip(`unresolvedOrVoid(${prices})`);
  const windowEnd = toTs(m.endDate || e.endDate);
  let windowStart = toTs(m.eventStartTime || e.startTime), startInferred = false;
  if (!windowStart) { windowStart = windowEnd - cfg.len; startInferred = true; }
  const ms = /-(\d{10})$/.exec(e.slug);
  const slugTs = ms ? Number(ms[1]) : null;
  if (slugTs && slugTs !== windowStart) skips.slugTsMismatch = (skips.slugTsMismatch || 0) + 1;
  if (windowEnd - windowStart !== cfg.len) skips.lenMismatch = (skips.lenMismatch || 0) + 1;
  return {
    tf, slug: e.slug, eventId: e.id, marketId: m.id, conditionId: m.conditionId, question: m.question,
    upToken: toks[iUp], downToken: toks[iDn],
    windowStart, windowEnd, startInferred, day: dayKey(windowStart),
    winner, upWon: winner === 'Up',
    priceToBeat: e.eventMetadata?.priceToBeat ?? null, finalPrice: e.eventMetadata?.finalPrice ?? null,
    volume: Number(m.volumeNum ?? m.volume ?? 0),
    createdTs: toTs(m.createdAt), acceptingOrdersTs: toTs(m.acceptingOrdersTimestamp), closedTs: toTs(m.closedTime || e.closedTime),
    fee: feeFields(m),
    tickSize: m.orderPriceMinTickSize ?? null, minOrderSize: m.orderMinSize ?? null,
    resolutionSource: m.resolutionSource || e.resolutionSource || null,
    cryptoMarketConfigId: m.cryptoMarketConfigId ?? null,
    twapLookbackSeconds: m.cryptoMarketConfig?.twapLookbackSeconds ?? null,
    umaResolutionStatus: m.umaResolutionStatus ?? null,
    automaticallyResolved: m.automaticallyResolved ?? null,
  };
}

async function batchHistory(tokens, startTs, endTs, fidelity) {
  const res = await getJSON(`${CLOB}/batch-prices-history`, { method: 'POST', body: { markets: tokens, start_ts: startTs, end_ts: endTs, fidelity } });
  return (res && res.history) || {};
}

async function attachUpDownPaths(recs, cfg) {
  recs.sort((a, b) => a.windowStart - b.windowStart);
  const pre = Math.max(cfg.len, 600);
  const groups = chunk(recs, cfg.chunk);
  let done = 0;
  await pool(groups, 6, async (g) => {
    const start = Math.min(...g.map((r) => r.windowStart)) - pre;
    const end = Math.max(...g.map((r) => r.windowEnd)) + 60;
    const h = await batchHistory(g.map((r) => r.upToken), start, end, 1);
    for (const r of g) {
      r.pathFrom = r.windowStart - pre; r.pathTo = r.windowEnd + 60;
      r.path = (h[r.upToken] || []).filter((x) => x.t >= r.pathFrom && x.t <= r.pathTo).map((x) => [x.t, x.p]);
    }
    if (++done % 50 === 0) log(`  paths ${done}/${groups.length}`);
  });
}

function pathQuality(recs) {
  const ratios = [], npts = [];
  let empty = 0;
  for (const r of recs) {
    const n = (r.path || []).length; npts.push(n);
    if (!n) empty++;
    const inWin = (r.path || []).filter(([t]) => t >= r.windowStart && t <= r.windowEnd).length;
    ratios.push(inWin / (r.windowEnd - r.windowStart) * 60);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  return { medianPoints: med(npts), medianInWindowPtsPerMin: med(ratios) && +med(ratios).toFixed(3), emptyPaths: empty,
    pctAtLeast1PerMin: ratios.length ? +(ratios.filter((x) => x >= 0.9).length / ratios.length).toFixed(3) : null };
}

async function stageUpDown() {
  for (const tf of TFS) {
    const cfg = UPDOWN[tf];
    const t1 = Date.now();
    log(`[updown ${tf}] listing ${cfg.series} last ${cfg.days}d`);
    const evs = await fetchSeriesEvents(cfg.series, SETTLED_BEFORE - cfg.days * 86400, SETTLED_BEFORE, cfg.winDays);
    const skips = {};
    let recs = evs.map((e) => normUpDown(e, tf, cfg, skips)).filter(Boolean)
      .filter((r) => r.windowEnd <= SETTLED_BEFORE && r.windowEnd >= SETTLED_BEFORE - cfg.days * 86400);
    // de-dupe on conditionId
    recs = [...new Map(recs.map((r) => [r.conditionId, r])).values()];
    log(`[updown ${tf}] ${evs.length} events -> ${recs.length} settled; skips ${JSON.stringify(skips)}`);
    await attachUpDownPaths(recs, cfg);
    const file = path.join(DATA, `updown_${tf}.jsonl`);
    writeJSONL(file, recs);
    const feeTypes = {};
    for (const r of recs) { const k = `${r.fee.feeType}|${JSON.stringify(r.fee.feeSchedule)}`; feeTypes[k] = (feeTypes[k] || 0) + 1; }
    const q = pathQuality(recs);
    manifest.datasets[`updown_${tf}`] = {
      file, rows: recs.length, series: cfg.series, windowLenSec: cfg.len,
      firstWindowStart: recs.length ? isoOf(recs[0].windowStart) : null, lastWindowEnd: recs.length ? isoOf(recs[recs.length - 1].windowEnd) : null,
      days: new Set(recs.map((r) => r.day)).size, upWinRate: recs.length ? +(recs.filter((r) => r.upWon).length / recs.length).toFixed(4) : null,
      medianVolume: recs.length ? [...recs.map((r) => r.volume)].sort((a, b) => a - b)[Math.floor(recs.length / 2)] : null,
      totalVolume: Math.round(recs.reduce((s, r) => s + r.volume, 0)),
      withPriceToBeat: recs.filter((r) => r.priceToBeat != null).length,
      skips, feeTypes, pathQuality: q, secs: Math.round((Date.now() - t1) / 1000),
    };
    if (q.emptyPaths > recs.length * 0.05) problem(`updown ${tf}: ${q.emptyPaths}/${recs.length} empty price paths`);
    log(`[updown ${tf}] wrote ${recs.length} rows, pathQuality ${JSON.stringify(q)} (${manifest.datasets[`updown_${tf}`].secs}s)`);
    saveManifest();
  }
}

// ---------------------------------------------------------------- trades tapes
const tradeKey = (x) => `${x.transactionHash}|${x.asset}|${x.proxyWallet}|${x.side}|${x.size}|${x.price}|${x.timestamp}`;

async function fetchTrades(cid) {
  const seen = new Map();
  let mode = 'offset', truncated = false;
  let lastFull = false;
  for (let off = 0; off <= 50000; off += 500) {
    const page = await getJSON(`${DAPI}/trades?market=${cid}&limit=500&offset=${off}`, { allowStatus: [400, 404] });
    if (!Array.isArray(page)) { lastFull = true; break; }
    for (const x of page) seen.set(tradeKey(x), x);
    if (page.length < 500) { lastFull = false; break; }
    lastFull = true;
  }
  if (lastFull) {
    // offset cap hit: continue backwards with the `end` (timestamp, inclusive) cursor
    mode = 'offset+cursor';
    let end = Math.min(...[...seen.values()].map((x) => x.timestamp));
    for (let i = 0; i < 400; i++) {
      const page = await getJSON(`${DAPI}/trades?market=${cid}&limit=500&end=${end}`, { allowStatus: [400, 404] });
      if (!Array.isArray(page) || !page.length) break;
      let added = 0;
      for (const x of page) { const k = tradeKey(x); if (!seen.has(k)) { seen.set(k, x); added++; } }
      const mn = Math.min(...page.map((x) => x.timestamp));
      if (page.length < 500) break;
      if (!added && mn === end) { truncated = true; break; }
      end = added ? mn : mn - 1;
    }
  }
  return { trades: [...seen.values()], mode, truncated };
}

async function stageTrades() {
  for (const tf of ['5m', '15m']) {
    const t1 = Date.now();
    const all = readJSONL(path.join(DATA, `updown_${tf}.jsonl`));
    if (!all.length) { problem(`trades ${tf}: no updown records`); continue; }
    const maxEnd = Math.max(...all.map((r) => r.windowEnd));
    const recs = all.filter((r) => r.windowEnd > maxEnd - TRADE_DAYS[tf] * 86400).sort((a, b) => a.windowStart - b.windowStart);
    const rng = mulberry32(tf === '5m' ? 5005 : 15015);
    const frac = Number(args.tradeFrac || 0.10);
    const sample = recs.filter(() => rng() < frac);
    log(`[trades ${tf}] sampling ${sample.length}/${recs.length} markets`);
    let n = 0;
    const out = await pool(sample, 6, async (r) => {
      const { trades, mode, truncated } = await fetchTrades(r.conditionId);
      if (++n % 50 === 0) log(`  trades ${tf} ${n}/${sample.length}`);
      const tr = trades.map((x) => ({
        t: x.timestamp, side: x.side === 'BUY' ? 'B' : 'S', o: x.asset === r.upToken ? 'U' : x.asset === r.downToken ? 'D' : '?',
        p: x.price, s: x.size, w: x.proxyWallet, tx: x.transactionHash,
      })).sort((a, b) => a.t - b.t);
      return { tf, slug: r.slug, conditionId: r.conditionId, upToken: r.upToken, downToken: r.downToken, windowStart: r.windowStart, windowEnd: r.windowEnd,
        winner: r.winner, volume: r.volume, nTrades: tr.length, mode, truncated, takerOnly: true, trades: tr };
    });
    const good = out.filter((x) => x && !x.__error);
    const errs = out.filter((x) => x && x.__error);
    if (errs.length) problem(`trades ${tf}: ${errs.length} markets failed, e.g. ${errs[0].__error}`);
    const file = path.join(DATA, `trades_${tf}.jsonl`);
    writeJSONL(file, good);
    const nT = good.reduce((s, x) => s + x.nTrades, 0);
    manifest.datasets[`trades_${tf}`] = {
      file, rows: good.length, trades: nT, sampleFrac: frac, truncatedMarkets: good.filter((x) => x.truncated).length,
      cursorModeMarkets: good.filter((x) => x.mode !== 'offset').length,
      firstWindowStart: good.length ? isoOf(Math.min(...good.map((x) => x.windowStart))) : null,
      lastWindowEnd: good.length ? isoOf(Math.max(...good.map((x) => x.windowEnd))) : null,
      note: 'data-api /trades default takerOnly=true: one row per taker fill; side = taker side; w = taker proxy wallet',
      secs: Math.round((Date.now() - t1) / 1000),
    };
    log(`[trades ${tf}] wrote ${good.length} markets, ${nT} trades`);
    saveManifest();
  }
}

// ---------------------------------------------------------------- ladders / buckets / barriers
function num(s) {
  if (s == null) return null;
  let t = String(s).replace(/[$,\s]/g, '');
  let mult = 1;
  if (/k$/i.test(t)) { mult = 1000; t = t.slice(0, -1); }
  const v = Number(t);
  return Number.isFinite(v) ? v * mult : null;
}
export function parseStrike(title = '', question = '') {
  const t = String(title).trim();
  const q = String(question);
  let m;
  if ((m = /^↑\s*([\d.,$k]+)/i.exec(t))) return { type: 'hit_up', k: num(m[1]) };
  if ((m = /^↓\s*([\d.,$k]+)/i.exec(t))) return { type: 'hit_down', k: num(m[1]) };
  if ((m = /^<\s*([\d.,$k]+)/i.exec(t))) return { type: 'below', hi: num(m[1]) };
  if ((m = /^>\s*([\d.,$k]+)/i.exec(t))) return { type: 'above_bucket', lo: num(m[1]) };
  if ((m = /^([\d.,$k]+)\s*[-–]\s*([\d.,$k]+)$/i.exec(t))) return { type: 'between', lo: num(m[1]), hi: num(m[2]) };
  if ((m = /^([\d.,$k]+)\+?$/i.exec(t)) && num(m[1]) != null) {
    if (/reach/i.test(q)) return { type: 'hit_up', k: num(m[1]) };
    if (/dip|fall|drop/i.test(q)) return { type: 'hit_down', k: num(m[1]) };
    if (/greater than|or more|or higher/i.test(q) && /on /i.test(q) && /price/i.test(q)) return { type: 'above_bucket', lo: num(m[1]) };
    return { type: 'above', k: num(m[1]) };
  }
  if ((m = /reach \$?([\d,.]+k?)/i.exec(q))) return { type: 'hit_up', k: num(m[1]) };
  if ((m = /dip to \$?([\d,.]+k?)/i.exec(q))) return { type: 'hit_down', k: num(m[1]) };
  if ((m = /less than \$?([\d,.]+k?)/i.exec(q))) return { type: 'below', hi: num(m[1]) };
  if ((m = /between \$?([\d,.]+k?) and \$?([\d,.]+k?)/i.exec(q))) return { type: 'between', lo: num(m[1]), hi: num(m[2]) };
  if ((m = /(?:greater than|above) \$?([\d,.]+k?)/i.exec(q))) return { type: 'above', k: num(m[1]) };
  return { type: 'unknown', raw: t };
}

function normLadderMarket(e, m) {
  const outcomes = parseArr(m.outcomes) || [], prices = parseArr(m.outcomePrices) || [], toks = parseArr(m.clobTokenIds) || [];
  const iY = outcomes.findIndex((o) => /^yes$/i.test(o)), iN = outcomes.findIndex((o) => /^no$/i.test(o));
  let yesWon = null;
  if (m.closed && iY >= 0) {
    const py = Number(prices[iY]), pn = Number(prices[iN]);
    if (py === 1 && pn === 0) yesWon = true; else if (py === 0 && pn === 1) yesWon = false;
  }
  return {
    marketId: m.id, conditionId: m.conditionId, slug: m.slug, question: m.question, title: m.groupItemTitle || '', tokenIds: toks,
    strike: parseStrike(m.groupItemTitle || '', m.question || ''),
    yesToken: iY >= 0 ? toks[iY] : toks[0], noToken: iN >= 0 ? toks[iN] : toks[1], outcomes,
    closed: !!m.closed, yesWon, outcomePrices: prices.map(Number),
    volume: Number(m.volumeNum ?? m.volume ?? 0), createdTs: toTs(m.createdAt), endTs: toTs(m.endDate || e.endDate),
    closedTs: toTs(m.closedTime), umaResolutionStatus: m.umaResolutionStatus ?? null,
    negRisk: !!m.negRisk, tickSize: m.orderPriceMinTickSize ?? null, minOrderSize: m.orderMinSize ?? null,
    active: m.active ?? null, acceptingOrders: m.acceptingOrders ?? null,
    bestBid: m.bestBid ?? null, bestAsk: m.bestAsk ?? null, lastTradePrice: m.lastTradePrice ?? null,
    fee: feeFields(m),
  };
}

function normLadderEvent(e, cfg) {
  return {
    kind: cfg.kind, series: cfg.series, slug: e.slug, eventId: e.id, title: e.title,
    startTs: toTs(e.startDate), endTs: toTs(e.endDate), closed: !!e.closed, negRisk: !!(e.negRisk || e.enableNegRisk),
    resolutionSource: e.resolutionSource || null, eventMetadata: e.eventMetadata || null,
    markets: (e.markets || []).map((m) => normLadderMarket(e, m)),
  };
}

async function stageLadders() {
  for (const cfg of LADDERS) {
    const t1 = Date.now();
    log(`[ladders ${cfg.kind}] listing ${cfg.series} last ${cfg.days}d`);
    const evs = await fetchSeriesEvents(cfg.series, NOW - cfg.days * 86400, NOW - 3600, cfg.winDays);
    let events = evs.map((e) => normLadderEvent(e, cfg)).filter((e) => e.endTs && e.endTs <= NOW - 3600);
    let unresolvedMk = 0;
    for (const e of events) {
      const before = e.markets.length;
      e.markets = e.markets.filter((m) => m.yesWon !== null && m.yesToken);
      unresolvedMk += before - e.markets.length;
    }
    events = events.filter((e) => e.markets.length).sort((a, b) => a.endTs - b.endTs);
    log(`[ladders ${cfg.kind}] ${evs.length} events -> ${events.length} settled, ${events.reduce((s, e) => s + e.markets.length, 0)} markets (unresolved dropped ${unresolvedMk})`);
    // price paths
    const jobs = [];
    for (const e of events) {
      const born = Math.min(e.startTs || Infinity, ...e.markets.map((m) => m.createdTs || Infinity));
      const fineFrom = Math.max(born, e.endTs - 48 * 3600);
      for (const g of chunk(e.markets, 20)) {
        jobs.push({ g, from: fineFrom, to: e.endTs + 60, fid: 1, key: 'pathFine' });
        if (e.endTs - born > 48 * 3600) jobs.push({ g, from: born, to: e.endTs + 60, fid: 10, key: 'pathCoarse' });
      }
    }
    let done = 0;
    await pool(jobs, 6, async (j) => {
      const h = await batchHistory(j.g.map((m) => m.yesToken), j.from, j.to, j.fid);
      for (const m of j.g) { m[j.key] = (h[m.yesToken] || []).map((x) => [x.t, x.p]); m[j.key + 'Fidelity'] = j.fid; }
      if (++done % 100 === 0) log(`  ladder paths ${done}/${jobs.length}`);
    });
    const file = path.join(DATA, `ladders_${cfg.kind}.jsonl`);
    writeJSONL(file, events);
    const nm = events.reduce((s, e) => s + e.markets.length, 0);
    const unknown = events.reduce((s, e) => s + e.markets.filter((m) => m.strike.type === 'unknown').length, 0);
    if (unknown) problem(`ladders ${cfg.kind}: ${unknown} markets with unparsed strike`);
    const emptyFine = events.reduce((s, e) => s + e.markets.filter((m) => !(m.pathFine || []).length).length, 0);
    manifest.datasets[`ladders_${cfg.kind}`] = {
      file, rows: events.length, markets: nm, series: cfg.series,
      firstEnd: events.length ? isoOf(events[0].endTs) : null, lastEnd: events.length ? isoOf(events[events.length - 1].endTs) : null,
      unresolvedMarketsDropped: unresolvedMk, unparsedStrikes: unknown, emptyFinePaths: emptyFine,
      strikeTypes: events.flatMap((e) => e.markets.map((m) => m.strike.type)).reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {}),
      totalVolume: Math.round(events.reduce((s, e) => s + e.markets.reduce((a, m) => a + m.volume, 0), 0)),
      secs: Math.round((Date.now() - t1) / 1000),
    };
    log(`[ladders ${cfg.kind}] wrote ${events.length} events / ${nm} markets (${manifest.datasets[`ladders_${cfg.kind}`].secs}s)`);
    saveManifest();
  }
}

// ---------------------------------------------------------------- live snapshot with books
function summarizeBook(b) {
  const bids = (b.bids || []).map((x) => [Number(x.price), Number(x.size)]).sort((a, c) => c[0] - a[0]);
  const asks = (b.asks || []).map((x) => [Number(x.price), Number(x.size)]).sort((a, c) => a[0] - c[0]);
  return {
    bestBid: bids.length ? bids[0][0] : null, bidSize: bids.length ? bids[0][1] : null,
    bestAsk: asks.length ? asks[0][0] : null, askSize: asks.length ? asks[0][1] : null,
    bids, asks, bookTs: b.timestamp ? Number(b.timestamp) : null, tickSize: b.tick_size ? Number(b.tick_size) : null,
    minOrderSize: b.min_order_size ? Number(b.min_order_size) : null, lastTradePrice: b.last_trade_price ? Number(b.last_trade_price) : null,
    hash: b.hash || null,
  };
}

async function stageLive() {
  const t1 = Date.now();
  const series = [
    ...Object.entries(UPDOWN).map(([tf, c]) => ({ series: c.series, kind: `updown_${tf}`, horizon: tf === '5m' || tf === '15m' ? 6 * 3600 : 10 * 86400 })),
    ...LADDERS.map((c) => ({ series: c.series, kind: c.kind, horizon: 400 * 86400 })),
  ];
  const events = [];
  for (const s of series) {
    const evs = [];
    for (let off = 0; off < 3000; off += 100) {
      const page = await getJSON(`${GAMMA}/events?series_slug=${s.series}&closed=false&limit=100&offset=${off}&order=endDate&ascending=true`, { cache: false });
      if (!Array.isArray(page)) break;
      evs.push(...page);
      if (page.length < 100) break;
    }
    const keep = evs.filter((e) => { const end = toTs(e.endDate); return end && end > NOW && end < NOW + s.horizon; });
    for (const e of keep) {
      const ne = normLadderEvent(e, s);
      ne.windowStart = toTs(e.startTime || e.markets?.[0]?.eventStartTime) || null;
      events.push(ne);
    }
    log(`[live] ${s.series}: ${evs.length} open events, kept ${keep.length}`);
  }
  // books
  const tokens = [];
  for (const e of events) for (const m of e.markets) {
    const toks = [m.yesToken, m.noToken].filter(Boolean);
    // Up/Down markets have outcomes Up/Down, not Yes/No: normLadderMarket fell back to toks[0], toks[1]
    for (const t of toks) tokens.push(t);
  }
  const uniq = [...new Set(tokens)];
  const books = new Map();
  const tB = Math.floor(Date.now() / 1000);
  await pool(chunk(uniq, 200), 3, async (g) => {
    const res = await getJSON(`${CLOB}/books`, { method: 'POST', body: g.map((t) => ({ token_id: t })), cache: false });
    if (Array.isArray(res)) for (const b of res) books.set(String(b.asset_id), summarizeBook(b));
  });
  let missing = 0;
  for (const e of events) for (const m of e.markets) {
    m.tokens = m.outcomes.map((o, i) => {
      const tid = m.tokenIds[i];
      const b = books.get(String(tid));
      if (!b) missing++;
      return { outcome: o, tokenId: tid, book: b || null };
    });
  }
  const snap = { fetchedAt: new Date().toISOString(), fetchedTs: NOW, booksFetchedTs: tB, booksFetchSecs: Math.round(Date.now() / 1000) - tB,
    note: 'tokens[i] aligns with outcomes[i]; for Up/Down markets yesToken=Up token (outcomes[0]) and noToken=Down token. bids sorted desc, asks asc. book prices are per-token.',
    nEvents: events.length, nTokens: uniq.length, missingBooks: missing, events };
  const dir = path.join(DATA, 'live');
  const stamp = snap.fetchedAt.replace(/[:.]/g, '-');
  writeJSON(path.join(dir, `snapshot_${stamp}.json`), snap);
  writeJSON(path.join(dir, 'latest.json'), snap);
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  manifest.datasets.live_snapshot = { file: path.join(dir, 'latest.json'), stampedFile: path.join(dir, `snapshot_${stamp}.json`), fetchedAt: snap.fetchedAt,
    events: events.length, tokens: uniq.length, missingBooks: missing, eventsByKind: byKind, secs: Math.round((Date.now() - t1) / 1000) };
  if (missing) problem(`live: ${missing} tokens without a book in the /books response`);
  log(`[live] ${events.length} events, ${uniq.length} tokens, missing books ${missing}`);
  saveManifest();
}

// ---------------------------------------------------------------- fee evidence
async function stageFees() {
  const t1 = Date.now();
  const out = { fetchedAt: new Date().toISOString(), samples: [] };
  const probes = [
    ['btc-up-or-down-5m', 'updown_5m'], ['btc-up-or-down-15m', 'updown_15m'], ['btc-up-or-down-hourly', 'updown_1h'],
    ['btc-up-or-down-4h', 'updown_4h'], ['btc-up-or-down-daily', 'updown_1d'],
    ...LADDERS.map((c) => [c.series, c.kind]),
  ];
  for (const [series, kind] of probes) {
    const evs = await getJSON(`${GAMMA}/events?series_slug=${series}&closed=true&limit=2&order=endDate&ascending=false`, { cache: false });
    const e = Array.isArray(evs) && evs[0];
    if (!e) { out.samples.push({ series, kind, error: 'no closed events' }); continue; }
    const m = e.markets[0];
    const toks = parseArr(m.clobTokenIds) || [];
    const cm = await getJSON(`${CLOB}/clob-markets/${m.conditionId}`, { cache: false, allowStatus: [400, 404] });
    const fr = toks[0] ? await getJSON(`${CLOB}/fee-rate?token_id=${toks[0]}`, { cache: false, allowStatus: [400, 404] }) : null;
    out.samples.push({ series, kind, slug: e.slug, conditionId: m.conditionId, gamma: feeFields(m), clobMarketsFd: cm && cm.fd, clobMarketsMbfTbf: cm && [cm.mbf, cm.tbf], feeRateEndpoint: fr });
  }
  // older hourly regime
  const old = await getJSON(`${GAMMA}/events?series_slug=btc-up-or-down-hourly&closed=true&limit=1&end_date_max=2026-04-06T00:00:00Z&order=endDate&ascending=false`, { cache: true });
  if (Array.isArray(old) && old[0]) out.samples.push({ series: 'btc-up-or-down-hourly (2026-04)', slug: old[0].slug, gamma: feeFields(old[0].markets[0]) });
  out.docs = {
    source: 'docs.polymarket.com/trading/fees (read via web search; host not reachable from sandbox)',
    formula: 'fee = C * feeRate * p * (1 - p)  (C shares, p trade price); crypto feeRate 0.07; maker fee 0; maker rebate 20% of taker fees',
    olderDocsFormula: 'fee = C * p * feeRate * (p * (1 - p))^exponent ; legacy crypto 15m: feeRate 0.25, exponent 2 (peak 1.56%)',
    corroboration: 'third-party calculators: crypto max ~$1.75 per 100 shares at p=0.50 (= 100*0.07*0.25)',
  };
  writeJSON(path.join(DATA, 'fees_observed.json'), out);
  manifest.datasets.fees_observed = { file: path.join(DATA, 'fees_observed.json'), samples: out.samples.length, secs: Math.round((Date.now() - t1) / 1000) };
  log(`[fees] ${out.samples.length} samples; e.g. ${JSON.stringify(out.samples[0]).slice(0, 300)}`);
  saveManifest();
}

// ---------------------------------------------------------------- empirical fee verification
// data-api /activity rows carry usdcSize (cash actually paid/received incl. fee) next to size x price,
// so residual = usdcSize - size*price (BUY) or size*price - usdcSize (SELL) is the fee actually charged.
async function stageFeeVerify() {
  const t1 = Date.now();
  const rng = mulberry32(777);
  const picks = [];
  for (const tf of ['5m', '15m']) {
    const tapes = readJSONL(path.join(DATA, `trades_${tf}.jsonl`));
    const pool0 = [];
    for (const tp of tapes) for (const x of tp.trades) if (x.s >= 5) pool0.push({ tf, cid: tp.conditionId, slug: tp.slug, ...x });
    // stratify by price bucket so the curve shape is tested across p
    const buckets = new Map();
    for (const x of pool0) { const b = Math.min(9, Math.floor(x.p * 10)); if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(x); }
    for (const [, arr] of buckets) for (let i = 0; i < Math.min(arr.length, Number(args.feeN || 6)); i++) picks.push(arr[Math.floor(rng() * arr.length)]);
  }
  log(`[feeverify] checking ${picks.length} taker fills against /activity`);
  const rows = await pool(picks, 6, async (x) => {
    const act = await getJSON(`${DAPI}/activity?user=${x.w}&market=${x.cid}&limit=500&type=TRADE`, { allowStatus: [400, 404] });
    if (!Array.isArray(act)) return { ...x, match: false };
    const cands = act.filter((a) => a.transactionHash === x.tx && Math.abs(a.size - x.s) < 1e-6 && Math.abs(a.price - x.p) < 1e-9);
    if (!cands.length) return { ...x, match: false };
    const a = cands[0];
    const notional = a.size * a.price;
    const fee = a.side === 'BUY' ? a.usdcSize - notional : notional - a.usdcSize;
    const docs = a.size * 0.07 * a.price * (1 - a.price);
    const extra = a.size * 0.07 * a.price * a.price * (1 - a.price);
    const minp = a.size * 0.07 * Math.min(a.price, 1 - a.price);
    return { tf: x.tf, slug: x.slug, side: a.side, p: a.price, size: a.size, usdcSize: a.usdcSize, feeObserved: +fee.toFixed(6),
      docs: +docs.toFixed(6), docs_extra_p: +extra.toFixed(6), minp: +minp.toFixed(6), match: true, nCands: cands.length };
  });
  const ok = rows.filter((r) => r && r.match);
  const err = (k) => ok.length ? +(ok.reduce((s, r) => s + Math.abs(r.feeObserved - r[k]), 0) / ok.length).toFixed(6) : null;
  const within = (k, tol) => ok.filter((r) => Math.abs(r.feeObserved - r[k]) <= tol).length;
  const summary = {
    checked: picks.length, matched: ok.length,
    meanAbsErr: { docs: err('docs'), docs_extra_p: err('docs_extra_p'), minp: err('minp'), zero: ok.length ? +(ok.reduce((s, r) => s + Math.abs(r.feeObserved), 0) / ok.length).toFixed(6) : null },
    within1e4: { docs: within('docs', 1e-4), docs_extra_p: within('docs_extra_p', 1e-4), minp: within('minp', 1e-4), zero: ok.filter((r) => Math.abs(r.feeObserved) <= 1e-4).length },
    bySide: ['BUY', 'SELL'].map((sd) => ({ side: sd, n: ok.filter((r) => r.side === sd).length, docsWithin1e4: ok.filter((r) => r.side === sd && Math.abs(r.feeObserved - r.docs) <= 1e-4).length })),
  };
  const f = path.join(DATA, 'fees_verified.json');
  writeJSON(f, { fetchedAt: new Date().toISOString(), method: 'usdcSize from data-api /activity vs size*price for sampled TAKER fills (data-api /trades takerOnly)', summary, rows: ok });
  manifest.datasets.fees_verified = { file: f, ...summary, secs: Math.round((Date.now() - t1) / 1000) };
  log(`[feeverify] ${JSON.stringify(summary)}`);
  saveManifest();
}

function saveManifest() {
  manifest.updatedAt = new Date().toISOString();
  manifest.httpStats = stats;
  manifest.problems = [...new Set([...PREV_PROBLEMS, ...problems])];
  writeJSON(manifestPath, manifest);
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  log(`stages=${STAGES} tfs=${TFS} now=${isoOf(NOW)}`);
  const run = { fees: stageFees, updown: stageUpDown, trades: stageTrades, ladders: stageLadders, live: stageLive, feeverify: stageFeeVerify };
  for (const s of STAGES) {
    try { await run[s](); } catch (e) { problem(`stage ${s} failed: ${e && e.stack || e}`); }
  }
  manifest.lastRun = { startedAt: isoOf(NOW), stages: STAGES, secs: Math.round((Date.now() - T0) / 1000) };
  saveManifest();
  log(`done in ${Math.round((Date.now() - T0) / 1000)}s; http ${JSON.stringify(stats)}`);
}

main();
