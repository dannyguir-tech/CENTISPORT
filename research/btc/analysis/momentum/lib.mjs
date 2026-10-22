// Shared helpers for the momentum / reversal study.
// Execution, fees, walk-forward, day-clustered bootstrap, Benjamini-Hochberg, logistic regression.
import { fees, pointAt } from '../../lib/load.mjs';
import { mulberry32 } from '../../lib/util.mjs';

// ---------------------------------------------------------------------------------------------
// Timing. The CLOB prices-history point labelled t matches the taker tape best at real time
// t - 16 s (measured on the 5m/15m tapes: median |path - trade| is lowest at lag -16 s), i.e. the
// snapshot is ~16 s OLDER than its label. We therefore shift every path point back by LAG
// (no look-ahead: we only ever pretend to know a price later than it really existed, never earlier).
// External information known at real time T (Chainlink boundary value, a finished window's result)
// can only be traded at the first path point whose REAL time is >= T + LATENCY.
// ---------------------------------------------------------------------------------------------
export const LAG = 16;
export const LATENCY = 5;
export const HAIRCUT = 0.01; // per-share spread haircut on top of the snapshot mid (tapes: median taker buy = mid + 0.5c)
export const HEADLINE = 'docs_always'; // verified v2 curve 0.07*p*(1-p), applied to every market (conservative for old eras)
export const FEE_MODELS = ['zero', 'docs', 'docs_always', 'minp', 'flat2'];
export const BAND = [0.03, 0.95]; // only buy a token whose reference price is inside this band

export const clip = (p, lo = 0.005, hi = 0.995) => Math.min(hi, Math.max(lo, p));
export const logit = (p) => { p = clip(p); return Math.log(p / (1 - p)); };

export function erf(x) {
  // Abramowitz-Stegun 7.1.26 (|err| < 1.5e-7)
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

export const effPath = (path) => (path || []).map(([t, p]) => [t - LAG, p]);

/** last point with real time <= T and >= T - maxStale */
export function lastAt(ep, T, maxStale = Infinity) {
  const pt = pointAt(ep, T);
  if (!pt || T - pt[0] > maxStale) return null;
  return pt;
}
/** index of first point with t >= T */
export function firstIdxAtOrAfter(ep, T) {
  let lo = 0, hi = ep.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ep[m][0] >= T) hi = m; else lo = m + 1; }
  return lo;
}
/** first point with real time in [T, T + maxWait] */
export function firstAfter(ep, T, maxWait) {
  const i = firstIdxAtOrAfter(ep, T);
  if (i >= ep.length || ep[i][0] > T + maxWait) return null;
  return ep[i];
}

// ---------------------------------------------------------------------------------------------
// Trades. A trade = buy one side as TAKER at reference (mid) price pRef of that side's token.
//   exec = pRef + haircut ; cost/share = exec + fee(exec) ; payout 1 if the side wins.
//   flat-stake pnl per $1 = win / cost - 1 ; per-share edge = win - cost.
// ---------------------------------------------------------------------------------------------
export function mkTrade({ day, t, side, pUp, win, fee, id, extra }) {
  const pRef = side === 'U' ? pUp : 1 - pUp;
  if (!(pRef >= BAND[0] && pRef <= BAND[1])) return null;
  return { day, t, side, pRef, win: win ? 1 : 0, fee, id, ...(extra || {}) };
}

export function costOf(pRef, fee, model = HEADLINE, haircut = HAIRCUT) {
  const exec = Math.min(0.995, Math.max(0.005, pRef + haircut));
  return exec + fees.takerFeePerShare(exec, { fee }, model);
}
export function pnlOf(t, model = HEADLINE, haircut = HAIRCUT) {
  const c = costOf(t.pRef, t.fee, model, haircut);
  return { cost: c, pnl: t.win / c - 1, edge: t.win - c };
}
export function summarize(trades, model = HEADLINE, haircut = HAIRCUT) {
  let n = 0, w = 0, sc = 0, sp = 0, se = 0, sr = 0;
  for (const t of trades) { const r = pnlOf(t, model, haircut); n++; w += t.win; sc += r.cost; sp += r.pnl; se += r.edge; sr += t.pRef; }
  return n ? { n, winRate: w / n, avgCost: sc / n, avgRef: sr / n, edge: se / n, roi: sp / n } : { n: 0, winRate: null, avgCost: null, avgRef: null, edge: null, roi: null };
}

// ---------------------------------------------------------------------------------------------
// Walk-forward. Days sorted; first 40% of days = initial training; then blocks of ~10% of days.
// Each block's threshold is chosen on ALL earlier days only (max training flat-stake ROI under the
// headline fee model, subject to a minimum trade count), then applied to the block (OOS).
// ---------------------------------------------------------------------------------------------
export function walkForward({ days, nWinByDay, thetas, tradesFor, initFrac = 0.4, blockFrac = 0.1, minAbs = 15, minFrac = 0.01 }) {
  const D = days.length;
  const nInit = Math.max(3, Math.floor(initFrac * D));
  const blk = Math.max(1, Math.ceil(blockFrac * D));
  const di = new Map(days.map((d, i) => [d, i]));
  const per = thetas.map((th) => {
    const tr = tradesFor(th);
    const n = new Float64Array(D), p = new Float64Array(D); const byDay = Array.from({ length: D }, () => []);
    for (const t of tr) { const i = di.get(t.day); if (i == null) continue; n[i]++; p[i] += pnlOf(t).pnl; byDay[i].push(t); }
    return { th, n, p, byDay };
  });
  const winPrefix = []; let acc = 0; for (const d of days) { acc += nWinByDay.get(d) || 0; winPrefix.push(acc); }
  const oos = [], choices = [];
  for (let s = nInit; s < D; s += blk) {
    const e = Math.min(D, s + blk);
    const trainWin = winPrefix[s - 1];
    const minN = Math.max(minAbs, Math.ceil(minFrac * trainWin));
    let best = null, mostN = null;
    for (const P of per) {
      let n = 0, pp = 0; for (let i = 0; i < s; i++) { n += P.n[i]; pp += P.p[i]; }
      const roi = n ? pp / n : -Infinity;
      if (!mostN || n > mostN.n) mostN = { P, n, roi };
      if (n >= minN && (!best || roi > best.roi)) best = { P, n, roi };
    }
    const ch = best || mostN;
    choices.push({ from: days[s], to: days[e - 1], theta: ch.P.th, trainN: ch.n, trainROI: Number.isFinite(ch.roi) ? +ch.roi.toFixed(4) : null });
    for (let i = s; i < e; i++) oos.push(...ch.P.byDay[i]);
  }
  return { oos, choices, oosDays: days.slice(nInit), trainDays: days.slice(0, nInit) };
}

// ---------------------------------------------------------------------------------------------
// Day-clustered bootstrap of flat-stake ROI (ratio of sums) and per-share edge.
// One-sided p-value for H0: ROI <= 0 via the centred bootstrap: p = P*(ROI* - ROI^ >= ROI^).
// ---------------------------------------------------------------------------------------------
export function bootstrap(trades, days, { model = HEADLINE, haircut = HAIRCUT, B = 2000, seed = 12345 } = {}) {
  const di = new Map(days.map((d, i) => [d, i]));
  const D = days.length;
  const N = new Float64Array(D), P = new Float64Array(D), E = new Float64Array(D);
  for (const t of trades) { const i = di.get(t.day); if (i == null) continue; const r = pnlOf(t, model, haircut); N[i]++; P[i] += r.pnl; E[i] += r.edge; }
  let sn = 0, sp = 0, se = 0; for (let i = 0; i < D; i++) { sn += N[i]; sp += P[i]; se += E[i]; }
  if (!sn) return { roi: null, ci: [null, null], edgeCi: [null, null], p: 1 };
  const roi = sp / sn, edge = se / sn;
  const rnd = mulberry32(seed);
  const rs = [], es = [];
  for (let b = 0; b < B; b++) {
    let n = 0, p = 0, e = 0;
    for (let k = 0; k < D; k++) { const i = Math.floor(rnd() * D); n += N[i]; p += P[i]; e += E[i]; }
    if (n) { rs.push(p / n); es.push(e / n); }
  }
  rs.sort((a, b) => a - b); es.sort((a, b) => a - b);
  const q = (a, x) => a[Math.min(a.length - 1, Math.max(0, Math.floor(x * (a.length - 1))))];
  let cnt = 0; for (const r of rs) if (r - roi >= roi) cnt++;
  const p = roi > 0 ? (1 + cnt) / (rs.length + 1) : 1;
  return { roi, edge, ci: [q(rs, 0.025), q(rs, 0.975)], edgeCi: [q(es, 0.025), q(es, 0.975)], p };
}

export function benjaminiHochberg(ps, q = 0.10) {
  const m = ps.length;
  const idx = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  let kmax = -1;
  idx.forEach(([p], k) => { if (p <= ((k + 1) / m) * q) kmax = k; });
  const sig = new Array(m).fill(false);
  for (let k = 0; k <= kmax; k++) sig[idx[k][1]] = true;
  // BH-adjusted p (q-values)
  const adj = new Array(m); let minv = 1;
  for (let k = m - 1; k >= 0; k--) { const [p, i] = idx[k]; minv = Math.min(minv, (p * m) / (k + 1)); adj[i] = Math.min(1, minv); }
  return { sig, adj };
}

// ---------------------------------------------------------------------------------------------
// Logistic regression (Newton/IRLS with a tiny ridge) + day-clustered bootstrap of coefficients.
// ---------------------------------------------------------------------------------------------
function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
export function logisticFit(X, y, { iters = 30, ridge = 1e-6 } = {}) {
  const k = X[0].length; let beta = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: k }, () => new Array(k).fill(0)); const g = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const x = X[i]; let z = 0; for (let j = 0; j < k; j++) z += beta[j] * x[j];
      const mu = 1 / (1 + Math.exp(-z)); const w = mu * (1 - mu);
      for (let j = 0; j < k; j++) { g[j] += (y[i] - mu) * x[j]; for (let l = 0; l < k; l++) H[j][l] += w * x[j] * x[l]; }
    }
    for (let j = 0; j < k; j++) { H[j][j] += ridge; g[j] -= ridge * beta[j]; }
    const step = solve(H, g);
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return beta;
}
export function logisticBoot(rows, featFn, names, { B = 300, seed = 7 } = {}) {
  // rows: [{day, y, ...}] ; featFn(row) -> [1, f1, f2...]
  const X = rows.map(featFn), y = rows.map((r) => r.y);
  const beta = logisticFit(X, y);
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const byDay = new Map(days.map((d) => [d, []]));
  rows.forEach((r, i) => byDay.get(r.day).push(i));
  const rnd = mulberry32(seed); const bs = names.map(() => []);
  for (let b = 0; b < B; b++) {
    const Xi = [], yi = [];
    for (let k = 0; k < days.length; k++) { const d = days[Math.floor(rnd() * days.length)]; for (const i of byDay.get(d)) { Xi.push(X[i]); yi.push(y[i]); } }
    const bb = logisticFit(Xi, yi, { iters: 15 });
    bb.forEach((v, j) => bs[j].push(v));
  }
  const out = {};
  names.forEach((nm, j) => {
    const a = bs[j].sort((u, v) => u - v);
    const lo = a[Math.floor(0.025 * (a.length - 1))], hi = a[Math.floor(0.975 * (a.length - 1))];
    out[nm] = { beta: +beta[j].toFixed(4), ci95: [+lo.toFixed(4), +hi.toFixed(4)] };
  });
  return { n: rows.length, days: days.length, coef: out };
}

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
export const fmt = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
