// Feature / signal tables for the momentum-reversal study. Every row only uses information
// available at its decision time (see lib.mjs for the timing conventions).
import { loadUpDown, loadTrades, WINDOW_SEC } from './load_shim.mjs';
import { effPath, lastAt, firstAfter, firstIdxAtOrAfter, LATENCY, normCdf } from '../mod/lib.mjs';

// how long we are willing to wait for the first executable path point after an information time
export const MAX_WAIT = { '5m': 90, '15m': 90, '1h': 120, '4h': 300, '1d': 600 };
// recent-velocity lookback for within-window rules
export const VEL_LOOK = { '5m': 60, '15m': 120, '1h': 300, '4h': 1200, '1d': 7200 };

// ---------------------------------------------------------------------------------------------
// Chainlink BTC/USD reference (only Chainlink-resolved series: 5m, 15m, 4h; 1h/1d resolve on
// Binance BTC_USDT and are excluded from the reference). Values at window boundaries, known at
// that boundary. sigmaAt(T) = realized vol per sqrt(second) over the trailing 3 days, using
// only points with ts <= T.
// ---------------------------------------------------------------------------------------------
export function buildCL() {
  const m = new Map();
  for (const tf of ['5m', '15m', '4h']) for (const r of loadUpDown(tf)) {
    if (r.priceToBeat != null && !m.has(r.windowStart)) m.set(r.windowStart, r.priceToBeat);
    if (r.finalPrice != null && !m.has(r.windowEnd)) m.set(r.windowEnd, r.finalPrice);
  }
  const ser = [...m.entries()].sort((a, b) => a[0] - b[0]);
  const ts = ser.map((x) => x[0]);
  const S2 = [0], DT = [0];
  for (let i = 1; i < ser.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap <= 14400) { const r = Math.log(ser[i][1] / ser[i - 1][1]); S2.push(S2[i - 1] + r * r); DT.push(DT[i - 1] + gap); }
    else { S2.push(S2[i - 1]); DT.push(DT[i - 1]); }
  }
  const lastLE = (T) => { let lo = 0, hi = ts.length - 1; if (!ts.length || ts[0] > T) return -1; while (lo < hi) { const md = (lo + hi + 1) >> 1; if (ts[md] <= T) lo = md; else hi = md - 1; } return lo; };
  const firstGE = (T) => { let lo = 0, hi = ts.length; while (lo < hi) { const md = (lo + hi) >> 1; if (ts[md] >= T) hi = md; else lo = md + 1; } return lo; };
  const sigCache = new Map();
  function sigmaAt(T, win = 3 * 86400) {
    if (sigCache.has(T)) return sigCache.get(T);
    const hi = lastLE(T), lo = firstGE(T - win);
    let s = null;
    if (hi > lo) { const dt = DT[hi] - DT[lo]; if (dt >= 6 * 3600) s = Math.sqrt((S2[hi] - S2[lo]) / dt); }
    sigCache.set(T, s);
    return s;
  }
  return { get: (T) => m.get(T) ?? null, sigmaAt, n: ser.length, first: ts[0], last: ts[ts.length - 1] };
}

const okLen = (r, tf) => Math.abs(r.windowEnd - r.windowStart - WINDOW_SEC[tf]) <= 1;

// ---------------------------------------------------------------------------------------------
// Within-window: decision at the last path point with real time <= start + f*L.
// p = Up mid there; pOpen = last pre-window quote; pPrev = Up mid VEL_LOOK seconds earlier;
// pNext = the following path point (robustness: one-point-later execution).
// ---------------------------------------------------------------------------------------------
export function featW(tf, f) {
  const L = WINDOW_SEC[tf];
  const staleMax = Math.max(90, 0.05 * L), look = VEL_LOOK[tf];
  const rows = [];
  for (const r of loadUpDown(tf)) {
    if (!r.path || !r.path.length || !okLen(r, tf)) continue;
    const ep = effPath(r.path);
    const T = r.windowStart + f * L;
    const pt = lastAt(ep, T, staleMax);
    if (!pt || pt[0] <= r.windowStart) continue;
    const open = lastAt(ep, r.windowStart, Math.max(900, L));
    const prev = lastAt(ep, pt[0] - look, Math.max(90, look / 2));
    if (!prev) continue;
    const ni = firstIdxAtOrAfter(ep, pt[0] + 1);
    const nxt = ni < ep.length && ep[ni][0] - pt[0] <= Math.max(120, 0.05 * L) && ep[ni][0] < r.windowEnd ? ep[ni] : null;
    rows.push({ day: r.day, t: pt[0], p: pt[1], pOpen: open ? open[1] : 0.5, pPrev: prev[1], pNext: nxt ? nxt[1] : null, win: r.upWon, fee: r.fee, id: r.slug, feeType: r.fee?.feeType ?? null, ep, end: r.windowEnd });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Across windows: window b follows window a (a.windowEnd == b.windowStart). Information about a
// is known at b.windowStart; execution in b at the first path point with real time >= start+LATENCY.
// prev = +1/-1 result of a; streak = signed run length of identical results ending at a;
// zMag = a's resolution-source log return / (sigma * sqrt(L)); z5 = Chainlink 5-min return into b's
// start / (sigma * sqrt(300)).
// ---------------------------------------------------------------------------------------------
export function featA(tf, CL) {
  const recs = loadUpDown(tf).filter((r) => okLen(r, tf));
  const L = WINDOW_SEC[tf];
  const rows = [];
  let streak = 0;
  for (let i = 0; i < recs.length; i++) {
    const a = recs[i - 1], b = recs[i];
    if (a && a.windowEnd === b.windowStart) {
      const sa = a.upWon ? 1 : -1;
      streak = Math.sign(streak) === sa ? streak + sa : sa;
    } else { streak = 0; continue; }
    if (!b.path || !b.path.length) continue;
    const ep = effPath(b.path);
    const pt = firstAfter(ep, b.windowStart + LATENCY, MAX_WAIT[tf]);
    if (!pt || pt[0] >= b.windowEnd) continue;
    const sig = CL.sigmaAt(b.windowStart);
    const zMag = a.priceToBeat && a.finalPrice && sig ? Math.log(a.finalPrice / a.priceToBeat) / (sig * Math.sqrt(L)) : null;
    // last-minute move of the previous window's own Up price (path proxy for late BTC drift), known by b's start
    const epa = a.path && a.path.length ? effPath(a.path) : null;
    const la1 = epa ? lastAt(epa, a.windowEnd, 75) : null, la0 = la1 ? lastAt(epa, la1[0] - 60, 45) : null;
    const lastMin = la1 && la0 ? Math.log(Math.min(0.995, Math.max(0.005, la1[1])) / (1 - Math.min(0.995, Math.max(0.005, la1[1])))) - Math.log(Math.min(0.995, Math.max(0.005, la0[1])) / (1 - Math.min(0.995, Math.max(0.005, la0[1])))) : null;
    const c0 = CL.get(b.windowStart), c1 = CL.get(b.windowStart - 300);
    const z5 = c0 && c1 && sig ? Math.log(c0 / c1) / (sig * Math.sqrt(300)) : null;
    rows.push({ day: b.day, t: pt[0], wait: pt[0] - b.windowStart, p: pt[1], win: b.upWon, fee: b.fee, id: b.slug, feeType: b.fee?.feeType ?? null, prev: a.upWon ? 1 : -1, streak, zMag, z5, lastMin, ep, end: b.windowEnd });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Cross-timeframe: long window r, sub-windows of subTf inside it. At each sub-boundary
// Tj = start + j*Ls (j = 1..m-1): c = (#Up - #Down) among the j finished sub-windows;
// zc = ln(CL(Tj)/CL(start)) / (sigma * sqrt(remaining - 20s)) -> P = Phi(zc) (driftless model);
// zLast = ln(CL(Tj)/CL(Tj-300)) / (sigma * sqrt(300)).
// Execution in the long market at the first path point with real time >= Tj + LATENCY.
// ---------------------------------------------------------------------------------------------
export function featX(longTf, subTf, CL) {
  const L = WINDOW_SEC[longTf], Ls = WINDOW_SEC[subTf], m = Math.round(L / Ls);
  const sub = new Map(loadUpDown(subTf).filter((r) => okLen(r, subTf)).map((r) => [r.windowStart, r]));
  const rows = [];
  for (const r of loadUpDown(longTf)) {
    if (!r.path || !r.path.length || !okLen(r, longTf)) continue;
    const ep = effPath(r.path);
    const cl0 = CL.get(r.windowStart);
    const dec = [];
    let c = 0;
    for (let j = 1; j < m; j++) {
      const s = sub.get(r.windowStart + (j - 1) * Ls);
      if (!s) break;
      c += s.upWon ? 1 : -1;
      const Tj = r.windowStart + j * Ls;
      const pt = firstAfter(ep, Tj + LATENCY, MAX_WAIT[longTf]);
      if (!pt || pt[0] >= r.windowEnd - 10) continue;
      const clT = CL.get(Tj), sig = CL.sigmaAt(Tj), clP = CL.get(Tj - 300);
      const tau = Math.max(30, r.windowEnd - pt[0] - 20);
      const zc = cl0 && clT && sig ? Math.log(clT / cl0) / (sig * Math.sqrt(tau)) : null;
      const zLast = clT && clP && sig ? Math.log(clT / clP) / (sig * Math.sqrt(300)) : null;
      dec.push({ j, t: pt[0], p: pt[1], c, zc, P: zc == null ? null : normCdf(zc), zLast });
    }
    if (dec.length) rows.push({ day: r.day, win: r.upWon, fee: r.fee, id: r.slug, feeType: r.fee?.feeType ?? null, dec, ep, end: r.windowEnd });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Tape (order-flow) signal on the ~10% subsample: Up-equivalent signed taker notional over
// [start, T] / total notional, T = start + f*L; executed at first path point >= T + LATENCY.
// ---------------------------------------------------------------------------------------------
export function featTape(tf, f) {
  const L = WINDOW_SEC[tf];
  const recs = new Map(loadUpDown(tf).map((r) => [r.conditionId, r]));
  const rows = [];
  for (const tp of loadTrades(tf)) {
    const r = recs.get(tp.conditionId);
    if (!r || !r.path || !r.path.length) continue;
    const T = r.windowStart + f * L;
    let net = 0, tot = 0;
    for (const x of tp.trades) {
      if (x.t > T) break;
      if (x.t < r.windowStart) continue;
      const usd = x.p * x.s;
      const sgn = (x.o === 'U' ? 1 : -1) * (x.side === 'B' ? 1 : -1);
      net += sgn * usd; tot += usd;
    }
    if (tot <= 0) continue;
    const ep = effPath(r.path);
    const pt = firstAfter(ep, T + LATENCY, MAX_WAIT[tf]);
    if (!pt || pt[0] >= r.windowEnd) continue;
    rows.push({ day: r.day, t: pt[0], p: pt[1], ofi: net / tot, tot, win: r.upWon, fee: r.fee, id: r.slug, feeType: r.fee?.feeType ?? null });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Early execution at the window open, tape subsample only: for window b (predecessor a), the
// executable entry for side S is the FIRST real taker BUY fill of S with on-chain time in
// [start+3s, start+20s] (that ask demonstrably existed then). Gives prevResult and zMag of a.
// ---------------------------------------------------------------------------------------------
export function featTapeOpen(tf, CL) {
  const L = WINDOW_SEC[tf];
  const all = loadUpDown(tf); const idx = new Map(all.map((r, i) => [r.conditionId, i]));
  const rows = [];
  for (const tp of loadTrades(tf)) {
    const i = idx.get(tp.conditionId); if (i == null || i === 0) continue;
    const a = all[i - 1], b = all[i];
    if (a.windowEnd !== b.windowStart) continue;
    const first = { U: null, D: null };
    for (const x of tp.trades) {
      const dt = x.t - b.windowStart;
      if (dt < 3) continue; if (dt > 20) break;
      if (x.side === 'B' && !first[x.o]) first[x.o] = x;
    }
    const sig = CL.sigmaAt(b.windowStart);
    const zMag = a.priceToBeat && a.finalPrice && sig ? Math.log(a.finalPrice / a.priceToBeat) / (sig * Math.sqrt(L)) : null;
    rows.push({ day: b.day, win: b.upWon, fee: b.fee, id: b.slug, feeType: b.fee?.feeType ?? null, prev: a.upWon ? 1 : -1, zMag, fU: first.U, fD: first.D });
  }
  return rows;
}
