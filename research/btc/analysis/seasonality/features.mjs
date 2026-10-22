// Observation table per timeframe: one row per settled Up/Down window with
//  - calendar features known at window start (UTC hour, session, weekday/weekend, day of week)
//  - trailing BTC realized vol (hourly-sampled Chainlink reference, strictly before window start)
//  - trailing market-volume ratio (same series, only windows already CLOSED before window start)
//  - decision prices (shifted snapshots, no look-ahead) at OPEN (pre-window quote), 50% and 80% of the window.
import { loadUpDown, chainlinkRefSeries, dayKey } from '../../lib/load.mjs';
import { effPath, lastAt, firstAfter } from './lib.mjs';

export const SESSIONS = [['ASIA', 0, 8], ['EU', 8, 13], ['US', 13, 20], ['LATE', 20, 24]];
export const sessionOf = (h) => SESSIONS.find(([, a, b]) => h >= a && h < b)[0];

const OPEN_STALE = { '5m': 180, '15m': 300, '1h': 600, '4h': 1800, '1d': 3600 };
const MAX_WAIT = { '5m': 45, '15m': 90, '1h': 180, '4h': 600, '1d': 1800 };
const VOLU_H = { '1d': [3 * 86400, 14 * 86400] }; // short, long horizons for the volume ratio
const DEFAULT_VOLU_H = [86400, 7 * 86400];

let hourRef = null;
function hourlyRef() {
  if (hourRef) return hourRef;
  hourRef = new Map();
  for (const [t, p] of chainlinkRefSeries()) if (t % 3600 === 0) hourRef.set(t, p);
  return hourRef;
}

/** Realized BTC vol (daily units) from hourly Chainlink marks strictly before T over the last 24 h. Needs >= 18 returns. */
export function trailingVol(T) {
  const ref = hourlyRef();
  const hLast = Math.ceil(T / 3600) * 3600 - 3600; // latest hour mark strictly < T
  let ss = 0, n = 0;
  for (let h = hLast; h > hLast - 24 * 3600; h -= 3600) {
    const a = ref.get(h), b = ref.get(h - 3600);
    if (a && b) { const r = Math.log(a / b); ss += r * r; n++; }
  }
  return n >= 18 ? Math.sqrt((ss / n) * 24) : null;
}

export function buildObs(tf) {
  const recs = loadUpDown(tf);
  const [Sh, Lh] = VOLU_H[tf] || DEFAULT_VOLU_H;
  const L0 = recs.length ? recs[0].windowEnd - recs[0].windowStart : 0;
  const ends = recs.map((r) => r.windowEnd);
  const avail = recs.map((r) => r.closedTs ?? r.windowEnd + 600);
  const lowerIdx = (x) => { let lo = 0, hi = ends.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ends[m] > x) hi = m; else lo = m + 1; } return lo; }; // first idx with end > x
  const obs = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const T = r.windowStart, L = r.windowEnd - r.windowStart;
    if (!(L > 0) || r.upWon == null) continue;
    const mid = T + L / 2;
    const dMid = new Date(mid * 1000);
    const hour = new Date(T * 1000).getUTCHours();
    // trailing volume ratio
    let volRatio = null;
    {
      let sS = 0, nS = 0, sL = 0, nL = 0;
      for (let j = lowerIdx(T - Lh); j < recs.length && ends[j] <= T; j++) {
        if (avail[j] > T || !(recs[j].volume >= 0)) continue;
        sL += recs[j].volume; nL++;
        if (ends[j] > T - Sh) { sS += recs[j].volume; nS++; }
      }
      const expS = Sh / L0, expL = Lh / L0;
      if (nS >= Math.max(2, 0.5 * expS) && nL >= 0.5 * expL && sL > 0) volRatio = (sS / nS) / (sL / nL);
    }
    const ep = effPath(r.path);
    const p0 = lastAt(ep, T, OPEN_STALE[tf]);
    const d50 = firstAfter(ep, T + 0.5 * L, MAX_WAIT[tf]);
    const d80 = firstAfter(ep, T + 0.8 * L, MAX_WAIT[tf]);
    obs.push({
      i, tf, slug: r.slug, conditionId: r.conditionId, day: dayKey(T), start: T, end: r.windowEnd, len: L,
      upWon: !!r.upWon, fee: r.fee, volume: r.volume,
      hour, session: sessionOf(hour), dow: dMid.getUTCDay(), weekend: dMid.getUTCDay() === 0 || dMid.getUTCDay() === 6 ? 'WKND' : 'WKDY',
      vol24: trailingVol(T), volRatio,
      q0: p0 && p0[1] > 0.02 && p0[1] < 0.98 ? p0[1] : null, t0: p0 ? p0[0] : null,
      t50: d50 && d50[0] < r.windowEnd ? d50[0] : null, p50: d50 && d50[0] < r.windowEnd ? d50[1] : null,
      t80: d80 && d80[0] < r.windowEnd ? d80[0] : null, p80: d80 && d80[0] < r.windowEnd ? d80[1] : null,
    });
  }
  return obs;
}

export const FAV_BAND = [0.55, 0.95];

/** Candidate trades for an action. OPEN: buy Up ('U') or Down ('D') at the pre-window quote.
 *  FAV50/FAV80: buy the favourite ('F') or the underdog ('G') if the favourite's price is in FAV_BAND. */
export function candidates(o, action) {
  if (action === 'OPEN') {
    if (o.q0 == null) return null;
    return { U: { tok: 'U', q: o.q0, won: o.upWon, t: o.t0 }, D: { tok: 'D', q: 1 - o.q0, won: !o.upWon, t: o.t0 } };
  }
  const p = action === 'FAV50' ? o.p50 : o.p80, t = action === 'FAV50' ? o.t50 : o.t80;
  if (p == null) return null;
  const favUp = p >= 0.5, pf = favUp ? p : 1 - p;
  if (pf < FAV_BAND[0] || pf > FAV_BAND[1]) return null;
  const favWon = favUp ? o.upWon : !o.upWon;
  return {
    F: { tok: favUp ? 'U' : 'D', q: pf, won: favWon, t },
    G: { tok: favUp ? 'D' : 'U', q: 1 - pf, won: !favWon, t },
  };
}
