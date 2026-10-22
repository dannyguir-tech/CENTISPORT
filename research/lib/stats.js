// Statistics for the backtester: seeded PRNG, cluster bootstrap, one-sided bootstrap p-values,
// Benjamini–Hochberg FDR, Wilson intervals and small summary helpers. Dependency-free and
// deterministic for a given seed.

// ---------- PRNG ----------

export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// mulberry32: tiny and fast; plenty for resampling (not for cryptography).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// makeRng(seed, 'hypothesis-id', ...) -> independent, reproducible stream per key combination.
export function makeRng(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts.flat()) {
    h = Math.imul(h ^ hashString(String(p)), 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
  }
  return mulberry32(h);
}

export const randInt = (rng, n) => Math.floor(rng() * n);

export function randNormal(rng) {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- summaries ----------

export function sum(xs) { let s = 0; for (const x of xs) s += x; return s; }
export function mean(xs) { return xs.length ? sum(xs) / xs.length : NaN; }
export function variance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - 1);
}
export const sd = (xs) => Math.sqrt(variance(xs));

// Linear-interpolation quantile (R type 7) of an ascending-sorted array.
export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  return lo + 1 < n ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

export function describe(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: v.length, mean: mean(v), sd: sd(v), min: v[0] ?? NaN,
    p25: quantile(v, 0.25), median: quantile(v, 0.5), p75: quantile(v, 0.75), max: v[v.length - 1] ?? NaN,
  };
}

// ---------- normal distribution ----------

// erfc with fractional error < 1.2e-7 (Numerical Recipes erfcc).
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
export const normalCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);

// Acklam's inverse normal CDF (relative error < 1.2e-9).
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lowTail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return lowTail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -lowTail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- intervals & tests ----------

export function wilson(k, n, z = 1.959963984540054) {
  if (!(n > 0)) return { p: NaN, lo: NaN, hi: NaN };
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// One-sided bootstrap p-value for H1: statistic > nullValue. The +1 keeps p > 0 so a finite
// number of replicates never claims certainty; the floor is 1/(B+1).
export function bootstrapPValue(replicates, nullValue = 0) {
  let n = 0, le = 0;
  for (const r of replicates) { if (!Number.isFinite(r)) continue; n++; if (r <= nullValue) le++; }
  return n ? (1 + le) / (n + 1) : 1;
}

// Percentile CI, bootstrap SE and one-sided p (never below pFloor) from a replicate vector.
export function summarizeReplicates(estimate, replicates, { alpha = 0.05, nullValue = 0, pFloor = 0 } = {}) {
  const v = Array.from(replicates).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length || !Number.isFinite(estimate)) return { estimate: Number.isFinite(estimate) ? estimate : null, lo: null, hi: null, se: null, p: 1, nValid: v.length };
  return {
    estimate,
    lo: quantile(v, alpha / 2),
    hi: quantile(v, 1 - alpha / 2),
    se: v.length > 1 ? sd(v) : 0,
    p: Math.max(pFloor, bootstrapPValue(v, nullValue)),
    nValid: v.length,
  };
}

// With C clusters, a lucky run where every cluster lands on the same side makes every bootstrap
// replicate agree, so the bootstrap p hits 1/(B+1). No valid cluster-level test can be more
// confident than that all-signs pattern allows (the sign-flip floor 2^-C), so p is floored there:
// 6 events can never give p < 1/64.
export const clusterPFloor = (C) => (C > 0 ? 2 ** -C : 1);

function groupClusters(items, keyOf) {
  const index = new Map(), clusters = [];
  for (const it of items) {
    const k = keyOf(it);
    let c = index.get(k);
    if (c === undefined) { c = clusters.length; index.set(k, c); clusters.push([]); }
    clusters[c].push(it);
  }
  return clusters;
}

// Generic cluster bootstrap: each replicate draws as many clusters as observed, with replacement,
// and evaluates stat() on the concatenated items, so within-cluster correlation is preserved.
export function clusterBootstrap(items, keyOf, stat, { B = 2000, seed = 1, alpha = 0.05, nullValue = 0 } = {}) {
  const clusters = groupClusters(items, keyOf);
  const C = clusters.length;
  const reps = new Float64Array(C ? B : 0);
  const rng = makeRng(seed);
  for (let b = 0; b < reps.length; b++) {
    const sample = [];
    for (let i = 0; i < C; i++) for (const it of clusters[randInt(rng, C)]) sample.push(it);
    reps[b] = stat(sample);
  }
  return { nClusters: C, nItems: items.length, B: reps.length, ...summarizeReplicates(C ? stat(items) : NaN, reps, { alpha, nullValue, pFloor: clusterPFloor(C) }) };
}

// Fast cluster bootstrap for statistics that depend on the data only through per-cluster sums
// (means, ratios of sums, differences of means). toVec(item) -> number[] of fixed length; each
// entry of `stats` maps the summed vector to a statistic. All statistics share the same draws
// (paired), and the draw sequence matches clusterBootstrap for the same seed.
export function clusterBootstrapSums(items, keyOf, toVec, stats, { B = 2000, seed = 1, alpha = 0.05, nullValue = 0 } = {}) {
  const clusters = groupClusters(items, keyOf);
  const C = clusters.length;
  const d = C ? toVec(clusters[0][0]).length : 0;
  const flat = new Float64Array(C * d);
  const total = new Float64Array(d);
  clusters.forEach((items, c) => {
    for (const it of items) {
      const v = toVec(it);
      for (let j = 0; j < d; j++) { flat[c * d + j] += v[j]; total[j] += v[j]; }
    }
  });
  const names = Object.keys(stats);
  const reps = Object.fromEntries(names.map((k) => [k, new Float64Array(C ? B : 0)]));
  const rng = makeRng(seed);
  const acc = new Float64Array(d);
  for (let b = 0; C && b < B; b++) {
    acc.fill(0);
    for (let i = 0; i < C; i++) {
      const off = randInt(rng, C) * d;
      for (let j = 0; j < d; j++) acc[j] += flat[off + j];
    }
    for (const k of names) reps[k][b] = stats[k](acc);
  }
  const out = { nClusters: C, nItems: items.length, B: C ? B : 0, stats: {} };
  for (const k of names) out.stats[k] = summarizeReplicates(C ? stats[k](total) : NaN, reps[k], { alpha, nullValue, pFloor: clusterPFloor(C) });
  return out;
}

// Benjamini–Hochberg step-up. Non-finite p-values count toward m but are never rejected.
// rejected[i] <=> adjusted[i] <= q.
export function benjaminiHochberg(pvals, q = 0.1) {
  const m = pvals.length;
  const p = pvals.map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1));
  const order = [...p.keys()].sort((a, b) => p[a] - p[b] || a - b);
  let kMax = -1;
  for (let r = 0; r < m; r++) if (Number.isFinite(pvals[order[r]]) && p[order[r]] <= ((r + 1) / m) * q) kMax = r;
  const rejected = new Array(m).fill(false);
  for (let r = 0; r <= kMax; r++) rejected[order[r]] = true;
  const adjusted = new Array(m);
  let run = 1;
  for (let r = m - 1; r >= 0; r--) {
    run = Math.min(run, (p[order[r]] * m) / (r + 1));
    adjusted[order[r]] = Number.isFinite(pvals[order[r]]) ? run : 1;
  }
  return { m, q, rejected, adjusted, nRejected: kMax + 1, threshold: kMax >= 0 ? ((kMax + 1) / m) * q : 0 };
}
