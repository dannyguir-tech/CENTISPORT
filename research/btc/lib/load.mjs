// Loaders for the BTC Polymarket datasets produced by ../collect.mjs.
//
//   import { loadUpDown, loadTrades, loadLadders, loadLive, priceAt, chainlinkRefSeries } from
//     '/home/user/CENTISPORT/research/btc/lib/load.mjs';
//
// All timestamps are unix seconds (UTC). Prices are token prices in [0,1].
// Price paths are [[t, p], ...] sorted by t, from CLOB batch-prices-history at fidelity=1 (~1 point/min).
// They are mid/last-trade SNAPSHOTS, not executable quotes: add a spread haircut + taker fee
// (see ./fees.mjs) before treating a path price as a fill price.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, readJSONL, dayKey } from './util.mjs';

export * as fees from './fees.mjs';
export { DATA, dayKey };

export const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
export const WINDOW_SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
export const LADDER_KINDS = ['above_daily', 'range_daily', 'above_hourly', 'hit_daily', 'hit_weekly', 'hit_monthly'];

const cache = new Map();
function cached(key, fn) { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); }

export function loadManifest() {
  const f = path.join(DATA, 'manifest.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/**
 * Settled Up/Down markets for a timeframe ('5m'|'15m'|'1h'|'4h'|'1d'), sorted by windowStart.
 * Record fields:
 *   tf, slug, conditionId, upToken, downToken, windowStart, windowEnd, day ('YYYY-MM-DD' of windowStart, UTC),
 *   winner ('Up'|'Down'), upWon (bool), priceToBeat (Chainlink ref at window start, from gamma eventMetadata; null on old markets),
 *   finalPrice (Chainlink ref at window end; may be null), volume (USDC), createdTs, acceptingOrdersTs, closedTs,
 *   fee {feesEnabled, feeType, feeSchedule{rate,exponent,takerOnly,rebateRate}, ...}, tickSize, minOrderSize,
 *   path [[t, pUp]] over [pathFrom, pathTo] = [windowStart - max(windowLen, 600), windowEnd + 60].
 */
export function loadUpDown(tf) {
  if (!TIMEFRAMES.includes(tf)) throw new Error('unknown tf ' + tf);
  return cached('ud:' + tf, () => readJSONL(path.join(DATA, `updown_${tf}.jsonl`)).sort((a, b) => a.windowStart - b.windowStart));
}

/**
 * Trade tapes for a ~10% random subsample of 5m / 15m Up/Down markets.
 * Each row: {tf, slug, conditionId, upToken, downToken, windowStart, windowEnd, winner, volume, nTrades, truncated, takerOnly:true,
 *            trades:[{t, side:'B'|'S' (taker side), o:'U'|'D' (token), p, s (shares), w (taker proxy wallet), tx}] sorted by t}
 * data-api returns one row per TAKER fill (takerOnly default), so `side` is the aggressor side.
 * A taker BUY of Up at p is economically a SELL of Down at 1-p (and vice versa) through the CTF/neg-risk matching.
 */
export function loadTrades(tf) {
  return cached('tr:' + tf, () => readJSONL(path.join(DATA, `trades_${tf}.jsonl`)));
}
export function tradesByCondition(tf) {
  return cached('trm:' + tf, () => new Map(loadTrades(tf).map((r) => [r.conditionId, r])));
}

/**
 * Settled strike-ladder / bucket / barrier events, sorted by endTs.
 * kind: 'above_daily' (bitcoin-above-on-<date>, btc-multi-strikes-weekly), 'range_daily' (bitcoin-price-on-<date> neg-risk buckets),
 *       'above_hourly' (bitcoin-multi-strikes-hourly), 'hit_daily' | 'hit_weekly' | 'hit_monthly' (what-price-will-bitcoin-hit-*).
 * Event: {kind, series, slug, title, startTs, endTs, negRisk, markets:[...]}
 * Market: {conditionId, question, title, strike:{type:'above'|'below'|'between'|'above_bucket'|'hit_up'|'hit_down', k|lo|hi},
 *          yesToken, noToken, yesWon (bool), volume, createdTs, endTs, fee, tickSize,
 *          pathFine [[t,pYes]] (fidelity 1 over the last <=48h + 60s), pathCoarse [[t,pYes]] (fidelity 10 over full life, only if life > 48h)}
 */
export function loadLadders(kind) {
  if (!LADDER_KINDS.includes(kind)) throw new Error('unknown ladder kind ' + kind);
  return cached('ld:' + kind, () => readJSONL(path.join(DATA, `ladders_${kind}.jsonl`)).sort((a, b) => a.endTs - b.endTs));
}

/**
 * Live snapshot of open BTC markets with full order books (default: data/live/latest.json).
 * {fetchedAt, fetchedTs, events:[{kind, series, slug, startTs, endTs, windowStart, negRisk, eventMetadata,
 *   markets:[{conditionId, question, title, strike, outcomes, tokens:[{outcome, tokenId,
 *     book:{bestBid, bidSize, bestAsk, askSize, bids:[[p,s]] desc, asks:[[p,s]] asc, bookTs(ms), tickSize, minOrderSize}}]}]}]}
 */
export function loadLive(file = path.join(DATA, 'live', 'latest.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Last path price with t <= T (no look-ahead). Returns null if none or older than maxStaleSec. */
export function priceAt(pathArr, T, { maxStaleSec = Infinity } = {}) {
  if (!pathArr || !pathArr.length || pathArr[0][0] > T) return null;
  let lo = 0, hi = pathArr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pathArr[mid][0] <= T) lo = mid; else hi = mid - 1; }
  return T - pathArr[lo][0] <= maxStaleSec ? pathArr[lo][1] : null;
}
/** Same but returns [t, p] of the last point with t <= T. */
export function pointAt(pathArr, T) {
  if (!pathArr || !pathArr.length || pathArr[0][0] > T) return null;
  let lo = 0, hi = pathArr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pathArr[mid][0] <= T) lo = mid; else hi = mid - 1; }
  return pathArr[lo];
}
export const pathSlice = (pathArr, from, to) => (pathArr || []).filter(([t]) => t >= from && t <= to);

/** Trades of a tape with t <= T (no look-ahead). */
export const tradesUpTo = (tape, T) => (tape.trades || []).filter((x) => x.t <= T);

/**
 * BTC/USD reference series reconstructed from Up/Down eventMetadata (Chainlink data-stream values Polymarket used):
 * [[ts, price, tf]] where ts = windowStart and price = priceToBeat (known AT windowStart -> usable without look-ahead
 * for decisions at t >= windowStart). Deduplicated by ts (finest timeframe wins). This is the only BTC spot proxy
 * available in this sandbox (exchange feeds are blocked).
 */
export function chainlinkRefSeries(tfs = ['5m', '15m', '1h', '4h', '1d']) {
  return cached('cl:' + tfs.join(','), () => {
    const m = new Map();
    for (const tf of tfs) {
      let recs; try { recs = loadUpDown(tf); } catch { continue; }
      for (const r of recs) if (r.priceToBeat != null && !m.has(r.windowStart)) m.set(r.windowStart, [r.windowStart, r.priceToBeat, tf]);
    }
    return [...m.values()].sort((a, b) => a[0] - b[0]);
  });
}

/** Group records by UTC day (for day-clustered bootstrap / walk-forward). */
export function byDay(recs, tsKey = 'windowStart') {
  const m = new Map();
  for (const r of recs) { const d = dayKey(r[tsKey]); if (!m.has(d)) m.set(d, []); m.get(d).push(r); }
  return new Map([...m.entries()].sort());
}
