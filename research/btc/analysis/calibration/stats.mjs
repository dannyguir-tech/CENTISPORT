// Statistics helpers for the calibration study (no dependencies).
import { mulberry32 } from '../../lib/util.mjs';

export const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
export const mean = (a) => (a.length ? sum(a) / a.length : NaN);
export const quantile = (a, q) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const pos = q * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
export const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
export const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// ---------- distributions ----------
export function normCdf(z) {
  // Abramowitz-Stegun 7.1.26 via erf, |err| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015; for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
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
/** Student-t CDF */
export function tCdf(t, df) {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  if (df > 200) return normCdf(t);
  const x = df / (df + t * t); const p = 0.5 * ibeta(x, df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

// ---------- day-clustered inference ----------
/**
 * items: [{day, y}] where y is a per-item value (e.g. PnL per $1). Returns cluster-robust mean, SE, t, one-sided p (H1: mean > 0).
 */
export function clusterMeanTest(items, dayOf = (x) => x.day, val = (x) => x.y) {
  const n = items.length; if (!n) return { n: 0 };
  const m = new Map(); let tot = 0;
  for (const it of items) { const d = dayOf(it), y = val(it); tot += y; const o = m.get(d) || [0, 0]; o[0] += y; o[1]++; m.set(d, o); }
  const mu = tot / n, D = m.size;
  let ss = 0; for (const [, [s, c]] of m) ss += (s - mu * c) ** 2;
  const se = D > 1 ? Math.sqrt(ss * D / (D - 1)) / n : NaN;
  const t = se > 0 ? mu / se : (mu > 0 ? Infinity : mu < 0 ? -Infinity : 0);
  const pOne = D > 1 ? 1 - tCdf(t, D - 1) : 1;
  const pTwo = D > 1 ? 2 * Math.min(tCdf(t, D - 1), 1 - tCdf(t, D - 1)) : 1;
  return { n, days: D, mean: mu, se, t, pOne, pTwo };
}

/**
 * Day-clustered bootstrap of a statistic computed from per-day aggregates.
 * dayAgg: array of per-day aggregate objects; stat(selectedAggs[]) -> number. Returns [lo, hi] percentile CI.
 */
export function bootstrapDays(dayAgg, stat, { reps = 2000, seed = 12345, alpha = 0.05 } = {}) {
  const D = dayAgg.length; if (D < 2) return [null, null];
  const rnd = mulberry32(seed); const vals = new Float64Array(reps); const pick = new Array(D);
  for (let r = 0; r < reps; r++) { for (let i = 0; i < D; i++) pick[i] = dayAgg[(rnd() * D) | 0]; vals[r] = stat(pick); }
  const v = Array.from(vals).filter(Number.isFinite);
  return [quantile(v, alpha / 2), quantile(v, 1 - alpha / 2)];
}

/** Benjamini-Hochberg: returns array of booleans (significant at q) and adjusted p-values (q-values). */
export function benjaminiHochberg(pvals, q = 0.10) {
  const m = pvals.length; const idx = pvals.map((p, i) => [p ?? 1, i]).sort((a, b) => a[0] - b[0]);
  let kMax = -1; idx.forEach(([p], r) => { if (p <= (q * (r + 1)) / m) kMax = r; });
  const sig = new Array(m).fill(false); for (let r = 0; r <= kMax; r++) sig[idx[r][1]] = true;
  const adj = new Array(m); let prev = 1;
  for (let r = m - 1; r >= 0; r--) { const [p, i] = idx[r]; prev = Math.min(prev, (p * m) / (r + 1)); adj[i] = Math.min(1, prev); }
  return { sig, adj, threshold: kMax >= 0 ? idx[kMax][0] : null, nSig: kMax + 1 };
}

// ---------- logistic regression (IRLS) ----------
function solve(A, b) {
  const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
/** X: array of feature arrays (without intercept); y: 0/1. Returns beta [intercept, ...]. */
export function logisticFit(X, y, { iters = 25, ridge = 1e-6 } = {}) {
  const n = y.length; if (!n) return null; const k = X[0].length + 1;
  let beta = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: k }, () => new Array(k).fill(0)); const g = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i]; let eta = beta[0]; for (let j = 1; j < k; j++) eta += beta[j] * xi[j - 1];
      const p = 1 / (1 + Math.exp(-eta)); const w = Math.max(p * (1 - p), 1e-9); const r = y[i] - p;
      g[0] += r; H[0][0] += w;
      for (let j = 1; j < k; j++) { const xj = xi[j - 1]; g[j] += r * xj; H[0][j] += w * xj; for (let l = j; l < k; l++) H[j][l] += w * xj * xi[l - 1]; }
    }
    for (let j = 0; j < k; j++) { H[j][j] += ridge; for (let l = 0; l < j; l++) H[j][l] = H[l][j]; }
    const step = solve(H, g); if (!step) break;
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return beta;
}
export const logit = (p, eps = 0.01) => { const q = Math.min(1 - eps, Math.max(eps, p)); return Math.log(q / (1 - q)); };
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
