// Build decision-time observations for the Up/Down calibration study.
//
// Timing conventions (verified in lag_check.mjs on the 5m/15m taker tapes): a prices-history point (t, p)
// best matches tape prices at about t-12 s (min median |error| at lag -10..-15 s; error grows for any
// positive lag), so a point never contains information from after its own timestamp.
//
// For a target decision time T we take k = last path point with t_k <= T (staleness <= maxStale) and:
//   pSnap   = p_k                          the SIGNAL (known at t_k, no look-ahead)
//   exec 'snap'   = p_k                     act at the moment the price was live (~t_k-12 s), zero extra latency (optimistic)
//   exec 'interp' = p_k + (LAG/dt)(p_{k+1}-p_k)   estimated price at t_k itself, i.e. ~12 s of latency (HEADLINE)
//   exec 'next'   = p_{k+1}                 ~60 s of latency (pessimistic)
// The next point is used only for the EXECUTION price (never for the signal), and only if it still reflects
// in-window trading (t_{k+1} - LAG < windowEnd); otherwise exec falls back to p_k.
// Maker fills use later in-window points (t_k < t_j <= windowEnd): min/max of pUp after the decision.
import { loadUpDown, tradesByCondition, WINDOW_SEC, chainlinkRefSeries } from '../../../lib/load.mjs';

export const LAG = 12;
export const FRACS = [
  { key: 'pre', f: -0.25, label: 'pre-window (start - 25% of window)' },
  { key: 's0', f: 0, label: 'window start' },
  { key: 'f25', f: 0.25, label: '25% through' },
  { key: 'f50', f: 0.5, label: '50% through' },
  { key: 'f75', f: 0.75, label: '75% through' },
  { key: 'f90', f: 0.9, label: '90% through' },
];
export const MAX_STALE = { '5m': 75, '15m': 90, '1h': 120, '4h': 120, '1d': 180 };

function lastIdx(path, T) {
  let lo = 0, hi = path.length - 1, a = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (path[m][0] <= T) { a = m; lo = m + 1; } else hi = m - 1; }
  return a;
}

/** Point-in-time quantities at a target time T for record r. Returns null if no fresh point. */
export function decisionAt(r, T, maxStale) {
  const path = r.path; if (!path || !path.length) return null;
  const k = lastIdx(path, T); if (k < 0 || T - path[k][0] > maxStale) return null;
  const [tk, pk] = path[k];
  let pNext = null, pInterp = pk, fallback = true;
  if (k + 1 < path.length) {
    const [tn, pn] = path[k + 1];
    if (tn - LAG < r.windowEnd && tn - tk <= 150) { pNext = pn; pInterp = pk + (LAG / (tn - tk)) * (pn - pk); fallback = false; }
  }
  let minAfter = Infinity, maxAfter = -Infinity, nAfter = 0;
  for (let j = k + 1; j < path.length && path[j][0] <= r.windowEnd; j++) { const p = path[j][1]; if (p < minAfter) minAfter = p; if (p > maxAfter) maxAfter = p; nAfter++; }
  return { k, tDec: tk, stale: T - tk, pSnap: pk, pInterp, pNext: pNext ?? pk, nextFallback: fallback, minAfter: nAfter ? minAfter : null, maxAfter: nAfter ? maxAfter : null, nAfter };
}

/** Per-timeframe observation table. */
export function buildObs(tf) {
  const recs = loadUpDown(tf).filter((r) => r.path && r.path.length && (r.winner === 'Up' || r.winner === 'Down'));
  const maxStale = MAX_STALE[tf];
  const out = [];
  let prev = null; const hist = [];
  for (const r of recs) {
    const W = r.windowEnd - r.windowStart;
    // previous contiguous outcomes (known at windowStart from the Chainlink reference that settles them)
    if (!prev || prev.windowEnd !== r.windowStart) hist.length = 0;
    const o = {
      tf, slug: r.slug, conditionId: r.conditionId, day: r.day, S: r.windowStart, E: r.windowEnd, W, nominalW: WINDOW_SEC[tf],
      upWon: r.upWon ? 1 : 0, fee: r.fee, feeType: r.fee?.feeType ?? null, volume: r.volume, priceToBeat: r.priceToBeat,
      prev1: hist.length >= 1 ? hist[hist.length - 1] : null,
      prev3same: hist.length >= 3 && hist.slice(-3).every((x) => x === hist[hist.length - 1]) ? hist[hist.length - 1] : null,
      d: {},
    };
    for (const fr of FRACS) {
      const T = Math.floor(r.windowStart + fr.f * W);
      const dd = decisionAt(r, T, maxStale); if (dd) o.d[fr.key] = dd;
    }
    out.push(o);
    hist.push(r.upWon ? 1 : 0); if (hist.length > 5) hist.shift();
    prev = r;
  }
  return out;
}

/**
 * Chainlink-reference features at 5-minute marks inside longer windows (15m/1h/4h/1d), from the 5m series'
 * priceToBeat values (Chainlink BTC/USD 60s-TWAP at each 5-minute boundary, available from 2026-09-07).
 * At mark m (known at m): x = ln(ref(m)/K) / (sigma5 * sqrt(tauEff/300)), sigma5 = stdev of the trailing 12
 * five-minute log returns (all <= m). fair = Phi(x). Market price = first path point with t_k >= m + 3 s.
 */
export function chainlinkMarks(tf, marksFrac) {
  const ref = new Map(chainlinkRefSeries(['5m']).map(([t, p]) => [t, p]));
  const recs = loadUpDown(tf).filter((r) => r.path && r.path.length && (r.winner === 'Up' || r.winner === 'Down'));
  const out = [];
  for (const r of recs) {
    const W = r.windowEnd - r.windowStart; const K = ref.get(r.windowStart);
    if (K == null) continue;
    const o = { tf, conditionId: r.conditionId, day: r.day, S: r.windowStart, E: r.windowEnd, upWon: r.upWon ? 1 : 0, fee: r.fee, K, ptbMatch: r.priceToBeat != null ? Math.abs(r.priceToBeat - K) < 1e-6 : null, m: {} };
    for (const [key, frac] of Object.entries(marksFrac)) {
      const m = r.windowStart + Math.round((frac * W) / 300) * 300; if (m <= r.windowStart || m >= r.windowEnd) continue;
      const pm = ref.get(m); if (pm == null) continue;
      const rets = []; let ok = true;
      for (let i = 0; i < 12; i++) { const a = ref.get(m - 300 * i), b = ref.get(m - 300 * (i + 1)); if (a == null || b == null) { ok = false; break; } rets.push(Math.log(a / b)); }
      if (!ok) continue;
      const mu = rets.reduce((s, x) => s + x, 0) / rets.length; const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (rets.length - 1));
      const tauEff = Math.max(r.windowEnd - m - 30, 1);
      const x = sd > 0 ? Math.log(pm / K) / (sd * Math.sqrt(tauEff / 300)) : 0;
      // first path point at or after m+3
      const path = r.path; let k = -1; for (let j = 0; j < path.length; j++) if (path[j][0] >= m + 3) { k = j; break; }
      if (k < 0 || path[k][0] - m > 90) continue;
      const dd = decisionAt(r, path[k][0], 1); if (!dd) continue;
      o.m[key] = { mark: m, x, sigma5: sd, move: Math.log(pm / K), ...dd };
    }
    out.push(o);
  }
  return out;
}

/**
 * Tape-based execution / fill checks (5m, 15m subsample). For a token ('U'|'D') at decision instant u:
 *   askProxy = median token-buy-equivalent print in [u, u+10] (taker BUY of the token or taker SELL of its complement)
 *   makerFilled(L, from u): any token-equivalent print <= L - 0.005 in (u, windowEnd]
 */
export function tapeTools(tf) {
  const tapes = tradesByCondition(tf);
  const idx = new Map();
  const arr = (cid) => { if (!idx.has(cid)) { const tp = tapes.get(cid); idx.set(cid, tp ? Float64Array.from(tp.trades.map((x) => x.t)) : null); } return idx.get(cid); };
  const firstAfter = (ts, u) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < u) lo = m + 1; else hi = m; } return lo; };
  return {
    has: (cid) => tapes.has(cid),
    askProxy(cid, tok, u) {
      const tape = tapes.get(cid); if (!tape) return null; const ts = arr(cid);
      const v = [];
      for (let i = firstAfter(ts, u); i < ts.length && ts[i] <= u + 10; i++) {
        const x = tape.trades[i]; const tokPx = x.o === tok ? x.p : 1 - x.p; const buysTok = (x.o === tok) === (x.side === 'B');
        if (buysTok) v.push(tokPx);
      }
      if (!v.length) return null; v.sort((a, b) => a - b); return v[v.length >> 1];
    },
    makerFilled(cid, tok, u, L, E) {
      const tape = tapes.get(cid); if (!tape) return null; const ts = arr(cid);
      for (let i = firstAfter(ts, u + 1e-6); i < ts.length && ts[i] <= E; i++) {
        const x = tape.trades[i]; const tokPx = x.o === tok ? x.p : 1 - x.p; if (tokPx <= L - 0.005) return true;
      }
      return false;
    },
  };
}
