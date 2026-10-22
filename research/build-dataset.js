#!/usr/bin/env node
// Builds the point-in-time dataset (dataset.jsonl) from markets.jsonl + prices/ + trades/.
// Every feature is computed from price points / trades with t <= decisionTs only; won,
// closePrice and clv are labels and the only fields allowed to look past decisionTs.
// Lifetime gamma volume is never read.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyMarketType, classifySide } from './lib/market-type.js';

const HOUR = 3600;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  dataDir: path.join(HERE, 'data'),
  offsets: [1, 3, 12, 24],
  maxPriceAgeH: 6,
  largeTradeUsd: 1000,
  // eventStartDate is only trusted as a game time when settlement follows within this window;
  // a larger gap usually means it is a listing/creation date, not kickoff.
  eventStartMaxGapH: 24,
});

const r6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

// ---------- time handling ----------

// Accepts ISO strings, gamma's "YYYY-MM-DD HH:MM:SS+00", and unix sec/ms numbers.
// Strings without a zone are read as UTC (Date.parse would otherwise use local time).
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v > 1e12 ? v / 1000 : v) : null;
  let s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseTime(Number(s));
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  if (m) {
    let tz = (m[3] || 'Z').toUpperCase();
    if (/^[+-]\d{2}$/.test(tz)) tz += ':00';
    else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    s = `${m[1]}T${m[2]}${tz}`;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function hasTimeOfDay(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim());
}

// Game start = gameStartTime, else eventStartDate when it plausibly is a game time.
// Never endDate/closedTime: those are settlement times and would put decisions in-game.
export function resolveGameStart(times, eventStartMaxGapH = DEFAULTS.eventStartMaxGapH) {
  const t = times || {};
  let startTs = parseTime(t.gameStartTime);
  let source = 'gameStartTime';
  if (startTs == null) {
    source = 'eventStartDate';
    const es = t.eventStartDate;
    if (es == null || es === '') return { reason: t.gameStartTime ? 'game_start_unparseable' : 'no_game_start' };
    if (!hasTimeOfDay(es)) return { reason: 'event_start_no_time_of_day' };
    startTs = parseTime(es);
    if (startTs == null) return { reason: 'event_start_unparseable' };
    const settle = parseTime(t.closedTime) ?? parseTime(t.endDate);
    if (settle == null) return { reason: 'event_start_unverifiable' };
    if (startTs > settle) return { reason: 'event_start_after_settlement' };
    if (settle - startTs > eventStartMaxGapH * HOUR) return { reason: 'event_start_far_from_settlement' };
  }
  const closed = parseTime(t.closedTime);
  // A market that closed before "start" means the start time is wrong; decisions could see settled prices.
  if (closed != null && closed <= startTs) return { reason: 'closed_before_start' };
  return { startTs, source };
}

// ---------- point-in-time lookups ----------

// Index of the last element with t <= ts, or -1. arr must be sorted by t.
export function lastIndexAtOrBefore(arr, ts) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Price as of ts: last point with t <= ts, or null when missing / older than maxAgeSec.
function priceAsOf(points, ts, maxAgeSec) {
  if (!points) return null;
  const i = lastIndexAtOrBefore(points, ts);
  if (i < 0 || ts - points[i].t > maxAgeSec) return null;
  return points[i];
}

const NULL_TRADE_FEATURES = Object.freeze({
  nTrades24h: null, netBuyNotional24h: null, largeNetNotional24h: null,
  distinctWallets24h: null, topWalletShare24h: null,
});

// Trades in (decisionTs - 24h, decisionTs]. Counts/wallets are market-level; net flows are
// signed toward this outcome (in a binary market, buying the other token counts against it).
export function tradeFeatures(trades, tokenIds, outcomeIndex, decisionTs, largeTradeUsd) {
  if (!trades) return { ...NULL_TRADE_FEATURES };
  const own = tokenIds[outcomeIndex];
  const binary = tokenIds.length === 2;
  const hi = lastIndexAtOrBefore(trades, decisionTs);
  const from = decisionTs - 24 * HOUR;
  let n = 0, net = 0, large = 0, walletGross = 0;
  const byWallet = new Map();
  for (let i = hi; i >= 0 && trades[i].t > from; i--) {
    const tr = trades[i];
    const notional = tr.size * tr.price;
    const dir = tr.asset === own ? 1 : binary ? -1 : 0;
    const signed = (tr.side === 'BUY' ? 1 : -1) * dir * notional;
    n++;
    net += signed;
    if (notional >= largeTradeUsd) large += signed;
    if (tr.wallet) {
      byWallet.set(tr.wallet, (byWallet.get(tr.wallet) || 0) + notional);
      walletGross += notional;
    }
  }
  let top = 0;
  for (const v of byWallet.values()) if (v > top) top = v;
  return {
    nTrades24h: n,
    netBuyNotional24h: r6(net) + 0,
    largeNetNotional24h: r6(large) + 0,
    distinctWallets24h: byWallet.size,
    topWalletShare24h: walletGross > 0 ? r6(top / walletGross) : null,
  };
}

// ---------- per-market row construction ----------

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; } }
  return null;
}

export function validateMarket(m) {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.conditionId !== 'string' || !m.conditionId) return null;
  const outcomes = asArray(m.outcomes);
  const tokenIds = asArray(m.tokenIds);
  if (!outcomes || !tokenIds || outcomes.length < 2 || outcomes.length !== tokenIds.length) return null;
  if (!Number.isInteger(m.winnerIndex) || m.winnerIndex < 0 || m.winnerIndex >= outcomes.length) return null;
  return { ...m, outcomes: outcomes.map(String), tokenIds: tokenIds.map(String) };
}

// pricesByToken: { tokenId: sorted points | null }; trades: sorted trades | null (not collected).
// counters.rowDrops is incremented per (outcome, offset) candidate that produced no row.
export function buildMarketRows(market, startTs, pricesByToken, trades, opts, counters = { rowDrops: {} }) {
  const o = { ...DEFAULTS, ...opts };
  const maxAge = o.maxPriceAgeH * HOUR;
  const { conditionId, outcomes, tokenIds, winnerIndex } = market;
  const sport = market.sport ? String(market.sport).toLowerCase() : null;
  const marketType = classifyMarketType(market.question, sport);
  const eventKey = market.eventSlug || conditionId;
  const rows = [];

  for (let i = 0; i < outcomes.length; i++) {
    const points = pricesByToken[tokenIds[i]];
    const compPoints = tokenIds.length === 2 ? pricesByToken[tokenIds[1 - i]] : null;
    const { sideType, line } = classifySide(market.question, outcomes[i]);
    const close = priceAsOf(points, startTs, maxAge);

    for (const offsetH of o.offsets) {
      if (!points) { bump(counters.rowDrops, 'no_price_file'); continue; }
      const decisionTs = startTs - Math.round(offsetH * HOUR);
      const idx = lastIndexAtOrBefore(points, decisionTs);
      if (idx < 0) { bump(counters.rowDrops, 'no_price_before_decision'); continue; }
      const pt = points[idx];
      const priceAgeSec = decisionTs - pt.t;
      if (priceAgeSec > maxAge) { bump(counters.rowDrops, 'stale_price'); continue; }

      const m6 = priceAsOf(points, decisionTs - 6 * HOUR, maxAge);
      const m24 = priceAsOf(points, decisionTs - 24 * HOUR, maxAge);
      const comp = priceAsOf(compPoints, decisionTs, maxAge);
      const closePrice = close ? close.p : null;

      rows.push({
        id: `${conditionId}|${i}|${offsetH}`,
        eventKey,
        conditionId,
        outcomeIndex: i,
        outcome: outcomes[i],
        startTs,
        decisionTs,
        offsetH,
        sport,
        marketType,
        sideType,
        line,
        price: pt.p,
        priceAgeSec,
        price_m6h: m6 ? m6.p : null,
        price_m24h: m24 ? m24.p : null,
        mom6h: m6 ? r6(pt.p - m6.p) : null,
        mom24h: m24 ? r6(pt.p - m24.p) : null,
        complementPrice: comp ? comp.p : null,
        overround: comp ? r6(pt.p + comp.p - 1) : null,
        ...tradeFeatures(trades, tokenIds, i, decisionTs, o.largeTradeUsd),
        won: i === winnerIndex ? 1 : 0,
        closePrice,
        clv: closePrice == null ? null : r6(closePrice - pt.p),
      });
    }
  }
  return rows;
}

// ---------- file loading ----------

const safeName = (s) => typeof s === 'string' && s.length > 0 && !/[\/\\]|\.\./.test(s);

export function readPrices(dataDir, tokenId) {
  if (!safeName(tokenId)) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(dataDir, 'prices', `${tokenId}.json`), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const j = JSON.parse(raw);
  const list = Array.isArray(j.points) ? j.points : Array.isArray(j.history) ? j.history : [];
  const pts = [];
  for (const x of list) {
    const t = Number(x && x.t), p = Number(x && x.p);
    if (Number.isFinite(t) && Number.isFinite(p) && p >= 0 && p <= 1) pts.push({ t: Math.floor(t), p });
  }
  pts.sort((a, b) => a.t - b.t);
  return pts.length ? pts : null;
}

// Returns sorted valid trades with t <= maxTs (later trades are never needed), or null if no file.
export async function readTrades(dataDir, conditionId, validAssets, maxTs) {
  if (!safeName(conditionId)) return null;
  const file = path.join(dataDir, 'trades', `${conditionId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let x;
    try { x = JSON.parse(line); } catch { continue; }
    const t = Number(x.t ?? x.timestamp), size = Number(x.size), price = Number(x.price);
    const side = String(x.side || '').toUpperCase();
    if (!Number.isFinite(t) || t > maxTs) continue;
    if (!(size > 0) || !(price >= 0 && price <= 1) || (side !== 'BUY' && side !== 'SELL')) continue;
    if (!validAssets.has(String(x.asset))) continue;
    out.push({ t: Math.floor(t), asset: String(x.asset), side, size, price, wallet: x.wallet || x.proxyWallet || null });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ---------- provenance ----------

const SYNTHETIC_MARK = /^\s*\[SYNTHETIC\]/i;
export const isSyntheticMarket = (m) => SYNTHETIC_MARK.test(m.question || '') || SYNTHETIC_MARK.test(m.eventTitle || '');

// Where the data came from, from <dataDir>/collect-runs.jsonl (written by collect.js and
// lib/synthetic.js). Any synthetic run or [SYNTHETIC] market taints the whole directory, because
// markets.jsonl accumulates across runs.
export function readProvenance(dataDir, syntheticMarkets = 0) {
  const file = path.join(dataDir, 'collect-runs.jsonl');
  const p = { status: 'unknown', collectRuns: 0, syntheticRuns: 0, syntheticMarkets, bases: [], reasons: [] };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const bases = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let run;
    try { run = JSON.parse(line); } catch { continue; }
    p.collectRuns++;
    if (run.bases && typeof run.bases === 'object') for (const b of Object.values(run.bases)) bases.add(String(b));
    if (run.synthetic) {
      p.syntheticRuns++;
      const why = `${run.tool || 'research/collect.js'}: ${run.synthetic}`;
      if (!p.reasons.includes(why)) p.reasons.push(why);
    }
  }
  p.bases = [...bases].sort();
  if (syntheticMarkets) p.reasons.push(`${syntheticMarkets} market(s) carry a [SYNTHETIC] question/title prefix`);
  if (p.syntheticRuns || syntheticMarkets) p.status = 'synthetic';
  else if (p.collectRuns) p.status = 'polymarket-api';
  else p.reasons.push(`no ${path.basename(file)} in the data dir, so the source cannot be checked`);
  return p;
}

// ---------- driver ----------

export async function buildDataset(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const dataDir = path.resolve(o.dataDir);
  const out = path.resolve(o.out || path.join(dataDir, 'dataset.jsonl'));
  const marketsFile = path.join(dataDir, 'markets.jsonl');
  if (!fs.existsSync(marketsFile)) throw new Error(`markets.jsonl not found in ${dataDir} — run the collector first or pass --data-dir`);
  const offsets = [...new Set(o.offsets)].sort((a, b) => a - b);
  const minOffsetSec = Math.round(offsets[0] * HOUR);

  const summary = {
    dataDir, out, offsets, maxPriceAgeH: o.maxPriceAgeH, largeTradeUsd: o.largeTradeUsd,
    eventStartMaxGapH: o.eventStartMaxGapH,
    marketsRead: 0, marketsUsed: 0, marketsWithTrades: 0, rows: 0,
    rowsByOffset: Object.fromEntries(offsets.map((h) => [h, 0])),
    startSource: {}, marketDrops: {}, rowDrops: {},
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  const ws = fs.createWriteStream(tmp);
  const seen = new Set();
  let syntheticMarkets = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(marketsFile), crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      summary.marketsRead++;
      let m;
      try { m = validateMarket(JSON.parse(line)); } catch { m = null; }
      if (!m) { bump(summary.marketDrops, 'invalid_record'); continue; }
      if (seen.has(m.conditionId)) { bump(summary.marketDrops, 'duplicate'); continue; }
      seen.add(m.conditionId);
      if (isSyntheticMarket(m)) syntheticMarkets++;

      const gs = resolveGameStart(m.times, o.eventStartMaxGapH);
      if (gs.reason) { bump(summary.marketDrops, gs.reason); continue; }

      const prices = {};
      let anyPrices = false;
      for (const tok of m.tokenIds) { prices[tok] = readPrices(dataDir, tok); anyPrices ||= !!prices[tok]; }
      if (!anyPrices) { bump(summary.marketDrops, 'no_price_files'); continue; }

      const trades = await readTrades(dataDir, m.conditionId, new Set(m.tokenIds), gs.startTs - minOffsetSec);
      const rows = buildMarketRows(m, gs.startTs, prices, trades, { ...o, offsets }, summary);
      if (!rows.length) { bump(summary.marketDrops, 'no_rows'); continue; }

      summary.marketsUsed++;
      bump(summary.startSource, gs.source);
      if (trades) summary.marketsWithTrades++;
      for (const r of rows) {
        summary.rows++;
        summary.rowsByOffset[r.offsetH]++;
        if (!ws.write(JSON.stringify(r) + '\n')) await once(ws, 'drain');
      }
    }
    ws.end();
    await once(ws, 'finish');
    fs.renameSync(tmp, out);
  } catch (e) {
    ws.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  summary.provenance = readProvenance(dataDir, syntheticMarkets);
  const summaryFile =path.join(path.dirname(out), `${path.basename(out, '.jsonl')}.summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n');
  summary.summaryFile = summaryFile;
  return summary;
}

// ---------- CLI ----------

const USAGE = `Usage: node research/build-dataset.js [options]
  --data-dir <dir>            data directory (default research/data)
  --offsets 1,3,12,24         decision offsets in hours before game start
  --max-price-age-h 6         drop rows whose last price point is older than this at decisionTs
  --large-trade-usd 1000      notional threshold for largeNetNotional24h
  --event-start-max-gap-h 24  max (closedTime|endDate - eventStartDate) to accept eventStartDate as game start
  --out <path>                output file (default <data-dir>/dataset.jsonl)`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') { a.help = true; continue; }
    if (!tok.startsWith('--')) throw new Error(`unexpected argument "${tok}"`);
    const eq = tok.indexOf('=');
    const key = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
    const val = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (val == null) throw new Error(`missing value for --${key}`);
    a[key] = val;
  }
  return a;
}

function num(name, v, { positive = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || (positive ? n <= 0 : n < 0)) throw new Error(`--${name} must be a ${positive ? 'positive' : 'non-negative'} number, got "${v}"`);
  return n;
}

export function optsFromArgs(argv) {
  const a = parseArgs(argv);
  if (a.help) return { help: true };
  const known = new Set(['data-dir', 'offsets', 'max-price-age-h', 'max-price-age', 'large-trade-usd', 'event-start-max-gap-h', 'out']);
  for (const k of Object.keys(a)) if (!known.has(k)) throw new Error(`unknown option --${k}`);
  const o = {};
  if (a['data-dir']) o.dataDir = a['data-dir'];
  if (a.out) o.out = a.out;
  if (a.offsets) o.offsets = a.offsets.split(',').filter(Boolean).map((s) => num('offsets', s.trim(), { positive: true }));
  const age = a['max-price-age-h'] ?? a['max-price-age'];
  if (age != null) o.maxPriceAgeH = num('max-price-age-h', age);
  if (a['large-trade-usd'] != null) o.largeTradeUsd = num('large-trade-usd', a['large-trade-usd']);
  if (a['event-start-max-gap-h'] != null) o.eventStartMaxGapH = num('event-start-max-gap-h', a['event-start-max-gap-h']);
  if (o.offsets && !o.offsets.length) throw new Error('--offsets is empty');
  return o;
}

function printSummary(s) {
  const fmt = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${k}: ${v}`).join('\n') || '    (none)';
  console.log(`dataset: ${s.out}`);
  console.log(`markets read ${s.marketsRead}, used ${s.marketsUsed} (with trades ${s.marketsWithTrades}), rows ${s.rows}`);
  console.log('  rows per offset (h before start):');
  for (const [h, n] of Object.entries(s.rowsByOffset)) console.log(`    ${h}h: ${n}`);
  console.log(`  game start source:\n${fmt(s.startSource)}`);
  console.log(`  market drops:\n${fmt(s.marketDrops)}`);
  console.log(`  row drops (per outcome x offset):\n${fmt(s.rowDrops)}`);
  const pv = s.provenance;
  console.log(`  provenance: ${pv.status === 'synthetic' ? 'SYNTHETIC (tooling validation only)' : pv.status} (${pv.collectRuns} collect runs${pv.bases.length ? `; bases ${pv.bases.join(', ')}` : ''})`);
  for (const r of pv.reasons) console.log(`    ${r}`);
  console.log(`summary written to ${s.summaryFile}`);
}

async function main() {
  const o = optsFromArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  const s = await buildDataset(o);
  printSummary(s);
  if (s.rows === 0) {
    console.error('ERROR: no dataset rows produced — check the drop reasons above (missing game start times or price files are the usual cause).');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`build-dataset: ${e.message}`); process.exitCode = 1; });
}
