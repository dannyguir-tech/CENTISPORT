// Shared helpers for the seasonality / regime study (time of day, weekday vs weekend,
// trailing BTC volatility, trailing market volume).
//
// Conventions (kept consistent with ../momentum/lib.mjs):
//  * Price paths: CLOB prices-history snapshots. The point labelled t reflects the market at real time
//    t - LAG (LAG = 16 s, measured on the 5m/15m taker tapes). We shift every point back by LAG, so we
//    never pretend to know a price earlier than it existed.
//  * Decision at target time T: we trade at the FIRST shifted snapshot with real time in [T, T + maxWait]
//    at that snapshot's price (fresh price, no look-ahead: nothing after that snapshot is used).
//    The pre-open decision (OPEN) uses the LAST shifted snapshot at or before windowStart.
//  * Execution (taker): exec = pRef + haircut, cost = exec + fee(exec), payout 1 if the token wins.
//    flat-stake ROI per trade = won / cost - 1 ; edge per share = won - cost.
//  * Execution (maker, HYPOTHETICAL fill): rest a bid at pRef - 0.005, assume it fills, no fee,
//    plus the 20% rebate (optimistic). Fill probability / adverse selection are NOT observable.
import { fees, pointAt } from '../../lib/load.mjs';
import { mulberry32 } from '../../lib/util.mjs';

export const LAG = 16;
export const effPath = (p) => (p || []).map(([t, v]) => [t - LAG, v]);

export function lastAt(ep, T, maxStale = Infinity) {
  const pt = pointAt(ep, T);
  if (!pt || T - pt[0] > maxStale) return null;
  return pt;
}
export function firstAfter(ep, T, maxWait) {
  let lo = 0, hi = ep.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ep[m][0] >= T) hi = m; else lo = m + 1; }
  if (lo >= ep.length || ep[lo][0] > T + maxWait) return null;
  return ep[lo];
}

// ------------------------------------------------------------------------------------------
// Cost models
// ------------------------------------------------------------------------------------------
const clampP = (p) => Math.min(0.999, Math.max(0.001, p));

/** Empirical haircut (per share, on top of the fresh shifted snapshot) by tf and action.
 *  From slip_check.mjs (LAG 16): mean taker-buy slip vs a <=5 s old snapshot was
 *  5m: pre 0.54c, f10-60 1.19c, f60-90 2.03c ; 15m: pre 0.43c, f10-60 0.58c, f60-90 0.78c.
 *  Rounded UP; never below the 1c default. No tapes for 1h/4h/1d -> 1c (live in-play spreads 1c). */
export const EMP_HAIRCUT = {
  '5m': { OPEN: 0.01, FAV50: 0.015, FAV80: 0.02 },
  '15m': { OPEN: 0.01, FAV50: 0.01, FAV80: 0.01 },
  '1h': { OPEN: 0.01, FAV50: 0.01, FAV80: 0.01 },
  '4h': { OPEN: 0.01, FAV50: 0.01, FAV80: 0.01 },
  '1d': { OPEN: 0.01, FAV50: 0.01, FAV80: 0.01 },
};

/** Cost per share. cm = {exec:'taker'|'maker', fee: model name, h: haircut number | 'emp'} */
export function costOf(q, feeRec, cm, tf, action) {
  if (cm.exec === 'maker') {
    const exec = clampP(q - 0.005);
    return exec - fees.makerRebatePerShare(exec, feeRec);
  }
  const h = cm.h === 'emp' ? EMP_HAIRCUT[tf][action] : cm.h;
  const exec = clampP(q + h);
  return exec + fees.takerFeePerShare(exec, feeRec, cm.fee);
}

export const COST_MODELS = {
  headline: { exec: 'taker', fee: 'docs_always', h: 'emp' },
  docs_emp: { exec: 'taker', fee: 'docs', h: 'emp' },
  docsA_h1: { exec: 'taker', fee: 'docs_always', h: 0.01 },
  docsA_h2: { exec: 'taker', fee: 'docs_always', h: 0.02 },
  docsA_h3: { exec: 'taker', fee: 'docs_always', h: 0.03 },
  minp_emp: { exec: 'taker', fee: 'minp', h: 'emp' },
  flat1_emp: { exec: 'taker', fee: 'flat1', h: 'emp' },
  flat2_emp: { exec: 'taker', fee: 'flat2', h: 'emp' },
  gross: { exec: 'taker', fee: 'zero', h: 0 },
  maker: { exec: 'maker' },
};

// ------------------------------------------------------------------------------------------
// Distributions
// ------------------------------------------------------------------------------------------
export function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015; for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1; let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
export function tCdf(t, df) {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  if (df > 300) return normCdf(t);
  const x = df / (df + t * t); const p = 0.5 * ibeta(x, df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}
// regularized upper incomplete gamma Q(a, x) for chi-square survival
function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) { // series for P
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d; // continued fraction for Q
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
export const chi2Sf = (x, df) => (df <= 0 ? 1 : gammaQ(df / 2, x / 2));

// ------------------------------------------------------------------------------------------
// Day-clustered inference
// ------------------------------------------------------------------------------------------
/** items [{day, y}] -> ratio-of-sums mean with cluster-robust SE (clusters = days); one-sided p for mean > 0. */
export function clusterTest(items, val = (x) => x.y) {
  const n = items.length; if (!n) return { n: 0, days: 0, mean: null, se: null, t: null, pOne: 1, pTwo: 1 };
  const m = new Map(); let tot = 0;
  for (const it of items) { const y = val(it); tot += y; const o = m.get(it.day) || [0, 0]; o[0] += y; o[1]++; m.set(it.day, o); }
  const mu = tot / n, D = m.size;
  let ss = 0; for (const [, [s, c]] of m) ss += (s - mu * c) ** 2;
  const se = D > 1 ? Math.sqrt(ss * D / (D - 1)) / n : NaN;
  const t = se > 0 ? mu / se : 0;
  const pOne = D > 2 && se > 0 ? 1 - tCdf(t, D - 1) : 1;
  const pTwo = D > 2 && se > 0 ? 2 * Math.min(tCdf(t, D - 1), 1 - tCdf(t, D - 1)) : 1;
  return { n, days: D, mean: mu, se, t, pOne, pTwo };
}

/** Day-cluster bootstrap percentile CI for ratio-of-sums mean of y. */
export function bootCI(items, val = (x) => x.y, { B = 2000, seed = 20261022, alpha = 0.05 } = {}) {
  if (!items.length) return [null, null];
  const m = new Map();
  for (const it of items) { const o = m.get(it.day) || [0, 0]; o[0] += val(it); o[1]++; m.set(it.day, o); }
  const S = [...m.values()].map((v) => v[0]), C = [...m.values()].map((v) => v[1]); const D = S.length;
  if (D < 3) return [null, null];
  const rnd = mulberry32(seed); const st = new Float64Array(B);
  for (let b = 0; b < B; b++) { let s = 0, c = 0; for (let i = 0; i < D; i++) { const j = (rnd() * D) | 0; s += S[j]; c += C[j]; } st[b] = s / c; }
  st.sort();
  return [st[Math.floor(alpha / 2 * (B - 1))], st[Math.ceil((1 - alpha / 2) * (B - 1))]];
}

/** Benjamini-Hochberg. ps: array of p-values. Returns {rejected: bool[], qvals: number[], threshold}. */
export function benjaminiHochberg(ps, q = 0.10) {
  const m = ps.length; const idx = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  let kMax = -1; idx.forEach(([p], k) => { if (p <= (q * (k + 1)) / m) kMax = k; });
  const rejected = new Array(m).fill(false); for (let k = 0; k <= kMax; k++) rejected[idx[k][1]] = true;
  const qv = new Array(m); let run = 1;
  for (let k = m - 1; k >= 0; k--) { const [p, i] = idx[k]; run = Math.min(run, (p * m) / (k + 1)); qv[i] = Math.min(1, run); }
  return { rejected, qvals: qv, threshold: kMax >= 0 ? idx[kMax][0] : 0, nRejected: kMax + 1 };
}

// ------------------------------------------------------------------------------------------
// Misc
// ------------------------------------------------------------------------------------------
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
export const quantile = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
export const fmt = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
export function terciles(vals) {
  const s = vals.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length < 3) return null;
  return [s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)]];
}

/** Walk-forward folds over sorted distinct days: first initFrac of days = initial training, rest in K blocks. */
export function makeFolds(days, { initFrac = 0.4, K = 6 } = {}) {
  const n = days.length; const init = Math.max(5, Math.floor(initFrac * n));
  const rest = days.slice(init); const folds = [];
  for (let k = 0; k < K; k++) {
    const a = Math.floor((k * rest.length) / K), b = Math.floor(((k + 1) * rest.length) / K);
    if (b > a) folds.push({ k, start: rest[a], end: rest[b - 1], days: new Set(rest.slice(a, b)) });
  }
  return { oosStart: rest[0], folds };
}
