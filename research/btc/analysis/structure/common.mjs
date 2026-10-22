// Shared helpers for the cross-market structure / arbitrage analysis.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fees, dayKey } from '../../lib/load.mjs';
import { mulberry32 } from '../../lib/util.mjs';

export const ROOT = '/home/user/CENTISPORT/research/btc';
export const REPORT = path.join(ROOT, 'reports', 'structure');
fs.mkdirSync(REPORT, { recursive: true });

// copy of collect.mjs parseStrike (importing collect.mjs would run its main())
function num(s) {
  if (s == null) return null;
  let t = String(s).replace(/[$,\s]/g, '');
  let mult = 1;
  if (/k$/i.test(t)) { mult = 1000; t = t.slice(0, -1); }
  const v = Number(t);
  return Number.isFinite(v) ? v * mult : null;
}
export function parseStrike(title = '', question = '') {
  const t = String(title).trim();
  const q = String(question);
  let m;
  if ((m = /^↑\s*([\d.,$k]+)/i.exec(t))) return { type: 'hit_up', k: num(m[1]) };
  if ((m = /^↓\s*([\d.,$k]+)/i.exec(t))) return { type: 'hit_down', k: num(m[1]) };
  if ((m = /^<\s*([\d.,$k]+)/i.exec(t))) return { type: 'below', hi: num(m[1]) };
  if ((m = /^>\s*([\d.,$k]+)/i.exec(t))) return { type: 'above_bucket', lo: num(m[1]) };
  if ((m = /^([\d.,$k]+)\s*[-–]\s*([\d.,$k]+)$/i.exec(t))) return { type: 'between', lo: num(m[1]), hi: num(m[2]) };
  if ((m = /^([\d.,$k]+)\+?$/i.exec(t)) && num(m[1]) != null) {
    if (/reach/i.test(q)) return { type: 'hit_up', k: num(m[1]) };
    if (/dip|fall|drop/i.test(q)) return { type: 'hit_down', k: num(m[1]) };
    if (/greater than|or more|or higher/i.test(q) && /on /i.test(q) && /price/i.test(q)) return { type: 'above_bucket', lo: num(m[1]) };
    return { type: 'above', k: num(m[1]) };
  }
  if ((m = /reach \$?([\d,.]+k?)/i.exec(q))) return { type: 'hit_up', k: num(m[1]) };
  if ((m = /dip to \$?([\d,.]+k?)/i.exec(q))) return { type: 'hit_down', k: num(m[1]) };
  if ((m = /less than \$?([\d,.]+k?)/i.exec(q))) return { type: 'below', hi: num(m[1]) };
  if ((m = /between \$?([\d,.]+k?) and \$?([\d,.]+k?)/i.exec(q))) return { type: 'between', lo: num(m[1]), hi: num(m[2]) };
  if ((m = /(?:greater than|above) \$?([\d,.]+k?)/i.exec(q))) return { type: 'above', k: num(m[1]) };
  return { type: 'unknown', raw: t };
}

// ------------------------------------------------------------------ fees
// fee per share for a taker BUY of a token at price p.
//  'docs_always' = 0.07 p (1-p) on every leg (verified v2 curve; conservative for pre-fee markets)  <- HEADLINE
//  'docs'        = per-record schedule (0 for feeType null, legacy schedule for crypto_fees)
//  'flat2'       = 2% of notional (stress)
//  'zero'        = no fee (diagnostic only)
export const FEE_MODELS = ['docs_always', 'docs', 'flat2', 'zero'];
export const feePS = (p, rec, model) => fees.takerFeePerShare(p, rec, model);

// ------------------------------------------------------------------ spread model
// Half-spread per leg (USDC/share) by market family and price band, measured from live books
// (see spreads.mjs -> reports/structure/spread_model.json). Fallbacks are conservative.
let SPREAD = null;
export function loadSpreadModel() {
  const f = path.join(REPORT, 'spread_model.json');
  SPREAD = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  return SPREAD;
}
export const BANDS = [0.01, 0.03, 0.07, 0.15, 0.3, 0.5001];
export function bandOf(p) { const q = Math.min(p, 1 - p); for (let i = 0; i < BANDS.length; i++) if (q < BANDS[i]) return i; return BANDS.length - 1; }
const FALLBACK_HS = { updown_5m: 0.005, updown_15m: 0.005, updown_1h: 0.01, updown_4h: 0.02, updown_1d: 0.01, above_daily: 0.0065, range_daily: 0.014, above_hourly: 0.015, hit_daily: 0.002, hit_weekly: 0.002, hit_monthly: 0.002 };
export function halfSpread(kind, p) {
  if (!SPREAD) loadSpreadModel();
  const k = SPREAD && SPREAD.byKind && SPREAD.byKind[kind];
  const b = bandOf(p);
  if (k && k[b] && k[b].n >= 5) return Math.max(k[b].median, 0.0005);
  if (k && k.all && k.all.n >= 5) return Math.max(k.all.median, 0.0005);
  return FALLBACK_HS[kind] ?? 0.01;
}
// Executable taker BUY price of a token whose mid is p, under a cost scenario.
//  scenario 'hs'  : mid + observed half-spread (family x price band)
//  scenario 'hc1' : mid + max(1c, observed half-spread)   <- HEADLINE (task default >= 1c haircut)
export function askFromMid(p, kind, scenario) {
  const hs = halfSpread(kind, p);
  const h = scenario === 'hc1' ? Math.max(0.01, hs) : scenario === 'mid' ? 0 : hs;
  return Math.min(1, p + h);
}
export const COST_SCENARIOS = ['hc1', 'hs', 'mid'];

// ------------------------------------------------------------------ path helpers
export function makeIdx(pathArr) { return pathArr || []; }
export function at(pathArr, T, maxStale) {
  if (!pathArr || !pathArr.length || pathArr[0][0] > T) return null;
  let lo = 0, hi = pathArr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pathArr[mid][0] <= T) lo = mid; else hi = mid - 1; }
  return T - pathArr[lo][0] <= maxStale ? pathArr[lo][1] : null;
}

// ------------------------------------------------------------------ statistics
export function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
/**
 * Day-clustered bootstrap of the ratio sum(profit)/sum(cost) (ROI) and of mean profit per trade.
 * trades: [{day, profit, cost}]. Returns {roi, ci:[lo,hi], meanProfit, ciProfit, pOneSided (P(roi<=0)), nDays}.
 */
export function bootstrapByDay(trades, B = 2000, seed = 7) {
  const byD = new Map();
  for (const t of trades) { if (!byD.has(t.day)) byD.set(t.day, { p: 0, c: 0, n: 0 }); const d = byD.get(t.day); d.p += t.profit; d.c += t.cost; d.n++; }
  const days = [...byD.values()];
  const P = days.reduce((s, d) => s + d.p, 0), C = days.reduce((s, d) => s + d.c, 0), N = days.reduce((s, d) => s + d.n, 0);
  const roi = C > 0 ? P / C : NaN;
  if (days.length < 2) return { roi, ci: [NaN, NaN], meanProfit: N ? P / N : NaN, ciProfit: [NaN, NaN], pOneSided: NaN, nDays: days.length };
  const rng = mulberry32(seed);
  const rs = [], ms = [];
  let le0 = 0;
  for (let b = 0; b < B; b++) {
    let p = 0, c = 0, n = 0;
    for (let i = 0; i < days.length; i++) { const d = days[Math.floor(rng() * days.length)]; p += d.p; c += d.c; n += d.n; }
    const r = c > 0 ? p / c : 0; rs.push(r); ms.push(n ? p / n : 0); if (r <= 0) le0++;
  }
  rs.sort((a, b) => a - b); ms.sort((a, b) => a - b);
  const q = (a, x) => a[Math.min(a.length - 1, Math.max(0, Math.floor(x * a.length)))];
  return { roi, ci: [q(rs, 0.025), q(rs, 0.975)], meanProfit: P / N, ciProfit: [q(ms, 0.025), q(ms, 0.975)], pOneSided: (le0 + 1) / (B + 1), nDays: days.length };
}
/** Benjamini-Hochberg: returns array of booleans (significant at q). */
export function bh(pvals, q = 0.1) {
  const idx = pvals.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  let kmax = -1;
  idx.forEach(([p], k) => { if (p <= ((k + 1) / m) * q) kmax = k; });
  const sig = pvals.map(() => false);
  for (let k = 0; k <= kmax; k++) sig[idx[k][1]] = true;
  return sig;
}
export const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
export { dayKey };

export function writeJSON(name, obj) { fs.writeFileSync(path.join(REPORT, name), JSON.stringify(obj, null, 1)); }
export function writeCSV(name, rows) {
  if (!rows.length) { fs.writeFileSync(path.join(REPORT, name), ''); return; }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v).replace(/"/g, "'") : String(v).includes(',') ? `"${v}"` : String(v));
  fs.writeFileSync(path.join(REPORT, name), [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
}
export function readGz(f) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')); }
