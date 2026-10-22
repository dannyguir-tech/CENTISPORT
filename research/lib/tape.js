// Pre-game trade tape for one market, assembled from data-api /trades pages (newest first).
// collect.js and the synthetic generator both use it, so they apply the same keep and coverage
// rules. Only trades in [fromT, toT] (toT = game start) are kept: features never use later trades,
// so in-game trading must not use up --max-trades-per-market. Paging still walks through in-game
// trades (the API has no time filter) and stops once the tape passes fromT.
//
// info.coverageFromT records how far back the tape is complete: every trade with t > coverageFromT
// is present (t >= coverageFromT when not truncated). null means nothing can be trusted (a truncated
// tape that was not sorted newest-first). build-dataset nulls trade features whose 24h window
// starts before it, instead of reporting a confident 0 for trades that were never fetched.

export const TAPE_VERSION = 2;

// stop: why paging ended. Only end_of_tape and window_start mean the window is complete.
export const TAPE_STOPS = Object.freeze(['end_of_tape', 'window_start', 'max_trades', 'max_pages', 'deep_offset']);

export function createTape({ conditionId, tokenIds, fromT, toT, maxTrades, normalize }) {
  const tokens = new Set(tokenIds.map(String));
  const seen = new Set();
  const kept = [];
  let sorted = true;
  let prevT = Infinity;
  let oldestSeen = Infinity;
  let pages = 0;
  return {
    // -> 'more' | 'window_start' | 'max_trades'
    addPage(rows) {
      pages++;
      let minT = Infinity;
      for (const raw of rows) {
        // Guard against a filter-ignoring API returning other markets' trades.
        if (raw?.conditionId && raw.conditionId !== conditionId) continue;
        const tr = normalize(raw);
        if (!tr || !tokens.has(tr.asset)) continue;
        if (tr.t > prevT) sorted = false;
        prevT = tr.t;
        if (tr.t < minT) minT = tr.t;
        const key = raw.transactionHash ? `${raw.transactionHash}|${tr.asset}|${tr.side}|${tr.size}|${tr.price}|${tr.wallet}` : null;
        if (key) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        if (tr.t >= fromT && tr.t <= toT) kept.push(tr);
      }
      if (minT < oldestSeen) oldestSeen = minT;
      if (sorted && minT < fromT) return 'window_start';
      if (kept.length >= maxTrades) return 'max_trades';
      return 'more';
    },
    finish(stop) {
      if (!TAPE_STOPS.includes(stop)) throw new Error(`unknown tape stop "${stop}"`);
      const complete = stop === 'end_of_tape' || stop === 'window_start';
      kept.sort((x, y) => x.t - y.t);
      let coverageFromT = fromT;
      // Newest-first paging means everything newer than the oldest trade seen has been read.
      if (!complete) coverageFromT = sorted && Number.isFinite(oldestSeen) ? Math.max(fromT, oldestSeen) : null;
      return {
        trades: kept,
        info: {
          v: TAPE_VERSION, n: kept.length, fromT, toT, truncated: !complete, stop, coverageFromT,
          oldestT: kept.length ? kept[0].t : null, newestT: kept.length ? kept[kept.length - 1].t : null, pages,
        },
      };
    },
  };
}
