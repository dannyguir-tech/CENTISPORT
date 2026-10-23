#!/usr/bin/env node
// SYNTHETIC generator for the NON-SPORTS ("general") track. It builds gamma-like events and markets,
// runs them through the collector's own per-event code (collect.js processEvent: universe filters,
// negRisk group files, price windows) with a fake price source, and writes exactly what the real
// collector writes: markets.jsonl, prices/<yesTokenId>.json (trimmed to the collector's windows),
// groups/*.json and a collect-runs.jsonl line flagged synthetic. Ground truth goes to a separate file.
// Nothing produced here is evidence about real markets.
//
// Fair prices are exact martingales under the generator's own law, so in the "null" world every
// rule loses the cost drag:
//   deadline  "Will X happen by <date>?": the event time tau ~ Exp(lambda), lambda ~ Gamma(a, b0)
//             unknown. Fair Yes at t with no event yet = 1 - ((b0 + u) / (b0 + T))^a (u = days since
//             listing, T = days to the deadline). The market closes soon after tau (Yes, often long
//             before its endDate) or after the deadline (No). Ladders share one tau.
//   threshold "Will <asset> close above $K on <date>?": Brownian latent, fair = Phi((S - K) / sd_left).
//   win       negRisk "Who wins?" groups and plain binaries: the winner W is drawn from a prior; every
//             hour brings Gaussian signals about W and the fair price is the exact Bayesian posterior.
// Some negRisk groups list only part of the field (hidden outcomes keep prior mass), so calibrated
// synchronized Yes-sums fall below 1 with no edge; members also get a small independent logit-space
// bounce. Larger bounces would not be null: given the group sum, a member's bounce is partly
// predictable (a 0.15 logit bounce gave negrisk-underround-yes a true +1.5% in an early run). Points
// are stamped within a minute after the hour (sometimes up to 15 min later), with occasional gaps.
// The "planted" world distorts only displayed Yes prices: longshots shown at ~0.02-0.15 win
// longshotBias (5 pp) less often than priced. Both worlds share every other random draw.
//
// truth.jsonl, one line per kept market: { conditionId, eventId, kind, category, anchorTs, closedTs,
// listingTs, yesWon, q: { <hourTs>: fair Yes } } with q for the grid hours a decision row can price
// at (each decision's staleness window). A point stamped hourTs + s (s < 1 h) shows information as of
// hourTs, so the audit prices a bet at q[floor(T / 3600) * 3600] for its price point T.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRng, normalCdf, randNormal } from '../lib/stats.js';
import { processEvent } from './collect.js';
import { DAY, HOUR, decisionPlan } from './lib.js';

export const WORLDS = Object.freeze(['null', 'planted']);
export const PLANTED_EDGES = Object.freeze({
  'longshot-fade': 'Yes prices displayed at about 0.02-0.15 win longshotBias (5 pp) less often than priced, so No is underpriced there',
});
// Mirror images of the planted edge: their true edge is negative in the planted world.
export const PLANTED_MIRRORS = Object.freeze(['longshot-buy', 'baseline-all']);
export const KINDS = Object.freeze(['deadline', 'ladder', 'threshold', 'negrisk', 'binary']);
// Dirty single-market events: the collector logic must drop the first five, keep the last two.
export const DIRTY = Object.freeze(['voided', 'ambiguous', 'non_final', 'no_end_date', 'missing_prices', 'event_end_only', 'late_close']);
export const DIRTY_DROP_REASON = Object.freeze({
  voided: 'voided_50_50', ambiguous: 'ambiguous_resolution', non_final: 'non_final_resolution', no_end_date: 'no_end_date', missing_prices: 'no_price_history',
});

export const DEFAULTS = Object.freeze({
  world: 'null',
  events: 5000,
  seed: 1,
  from: '2024-01-01',      // the collector's --since: markets created earlier are dropped
  months: 24,
  lifeMinD: 1.5,           // market lifetimes (listing to anchor), log-uniform
  lifeMaxD: 160,
  jitterProb: 0.03,        // share of points stamped 1-15 min after the hour (else within its first minute)
  jitterMaxSec: 900,
  gapProb: 0.0015,          // per-hour chance a gap of 1..gapMaxH missing points starts
  gapMaxH: 40,
  bounceLogit: 0.05,       // negRisk members: displayed Yes = logistic(logit(fair) + U(-b, b))
  hiddenProb: 0.4,         // negRisk groups whose field has 1-2 outcomes without a market (Yes-sum < 1, no edge)
  dirtyProb: 0.03,
  sportsProb: 0.02,        // events the collector must exclude as sports
  updownProb: 0.01,        // ... and as crypto Up or Down
  placeholderProb: 0.3,    // negRisk events with an inactive placeholder member
  feeFrom: '2025-07-01',   // markets listed after this carry a taker fee schedule
  // planted world only
  longshotBias: 0.05,
  longshotLo: 0.02,
  longshotHi: 0.15,
});

const CATS = {
  deadline: ['politics', 'geopolitics', 'tech-ai', 'culture-entertainment', 'other'],
  ladder: ['politics', 'geopolitics', 'tech-ai', 'other'],
  threshold: ['crypto', 'crypto', 'crypto', 'economics-finance', 'economics-finance'],
  negrisk: ['elections', 'elections', 'elections', 'culture-entertainment', 'culture-entertainment', 'science-weather', 'politics'],
  binary: ['economics-finance', 'science-weather', 'politics', 'other'],
};
const TAGS = {
  politics: ['politics'], elections: ['elections', 'politics'], geopolitics: ['geopolitics', 'world'], crypto: ['crypto', 'bitcoin'],
  'economics-finance': ['economy', 'fed'], 'tech-ai': ['ai', 'tech'], 'culture-entertainment': ['pop-culture', 'awards'],
  'science-weather': ['weather'], other: ['synthetic-misc'],
};
// Real gamma tag ids where known (sports 1 and up-or-down 102127 are excluded server-side).
const TAG_IDS = {
  sports: '1', 'up-or-down': '102127', politics: '2', elections: '144', geopolitics: '100265', world: '101970', crypto: '21', bitcoin: '235',
  economy: '100328', fed: '159', ai: '439', tech: '1401', 'pop-culture': '596', awards: '9000001', weather: '84', 'synthetic-misc': '9000002', nba: '745',
};
const FEE_BY_CAT = {
  politics: ['politics_fees', 0.04], elections: ['politics_fees', 0.04], geopolitics: ['politics_fees', 0.04], crypto: ['crypto_fees_v2', 0.07],
  'economics-finance': ['economics_fees', 0.05], 'tech-ai': ['tech_fees', 0.04], 'culture-entertainment': ['culture_fees', 0.05],
  'science-weather': ['weather_fees', 0.05], other: ['culture_fees', 0.05],
};
const KIND_WEIGHTS = { deadline: 0.3, ladder: 0.12, threshold: 0.2, negrisk: 0.23, binary: 0.15 };
const SYL = ['ka', 'lo', 'mi', 'ren', 'tor', 'vel', 'an', 'sa', 'dri', 'po', 'lun', 'ex', 'ber', 'qui', 'zo', 'mar', 'tel', 'cor'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const hex = (rng, n) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');
const digits = (rng, n) => String(1 + Math.floor(rng() * 9)) + Array.from({ length: n - 1 }, () => Math.floor(rng() * 10)).join('');
const word = (rng, n = 2) => { const w = Array.from({ length: n }, () => pick(rng, SYL)).join(''); return w[0].toUpperCase() + w.slice(1); };
const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const gammaClosed = (t) => new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00');
const dateText = (t) => { const d = new Date(t * 1000); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const logit = (p) => Math.log(p / (1 - p));
const logistic = (x) => 1 / (1 + Math.exp(-x));
const round4 = (p) => Math.round(clamp(p, 0.0005, 0.9995) * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// Marsaglia-Tsang gamma(shape, 1); shape < 1 by the U^(1/shape) boost.
function randGamma(rng, shape) {
  if (shape < 1) return randGamma(rng, shape + 1) * rng() ** (1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = randNormal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function pickWeighted(rng, weights) {
  const keys = Object.keys(weights);
  let r = rng() * keys.reduce((s, k) => s + weights[k], 0);
  for (const k of keys) { r -= weights[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

// Planted distortion of a displayed Yes price: full bias where the displayed price lands in
// [longshotLo, longshotHi]; linear tapers on both sides keep it monotone in the fair price.
export function plantedYes(f, o) {
  const b = o.longshotBias;
  const lo = Math.max(0.001, o.longshotLo), fullFrom = Math.max(0.001, lo + 0.005 - b), fullTo = o.longshotHi - b;
  let w;
  if (f <= 0) w = 0;
  else if (f < fullFrom) w = f / fullFrom;
  else if (f <= fullTo) w = 1;
  else w = Math.max(0, 1 - (f - fullTo) / 0.1);
  return f + b * w;
}

// ---------- fair-value paths on the hourly grid ----------

// grid: hour timestamps g[0..H-1] (multiples of 3600) from listing to close.
function hourGrid(listingTs, closedTs) {
  const g = [];
  for (let t = Math.ceil(listingTs / HOUR) * HOUR; t <= closedTs; t += HOUR) g.push(t);
  return g;
}

// Hazard (deadline) fair Yes for deadline D at hour t, given no event yet.
const hazardFair = (h, t, D) => 1 - ((h.b0 + (t - h.L) / DAY) / (h.b0 + (D - h.L) / DAY)) ** h.a;

function makeHazard(rng, L, Dmax) {
  const a = 0.6 + 2.4 * rng();
  const u = rng();
  const p0 = u < 0.5 ? 0.02 + 0.28 * rng() : u < 0.8 ? 0.3 + 0.4 * rng() : 0.7 + 0.25 * rng();
  const T = (Dmax - L) / DAY;
  const c = (1 - p0) ** (1 / a);
  const b0 = (T * c) / (1 - c);
  const lambda = randGamma(rng, a) / b0;
  const tau = L + (-Math.log(1 - rng()) / lambda) * DAY;
  return { a, b0, L, tau, p0 };
}

// Gaussian-signal posterior over K outcomes on the grid hours before the anchor A; after A the
// winner is public. Returns { winner, fair: Float64Array[K] per hour }.
function makeSignalPaths(rng, K, prior, grid, L, A) {
  let winner = K - 1;
  { let r = rng(); for (let i = 0; i < K; i++) { r -= prior[i]; if (r <= 0) { winner = i; break; } } }
  const T = Math.max(HOUR, A - L);
  const Itot = 3 + 13 * rng();
  const nPre = grid.filter((t) => t < A).length;
  const w = new Float64Array(Math.max(1, nPre));
  let tot = 0;
  for (let h = 0; h < nPre; h++) {
    let b = 1 + 6 * Math.exp(-(A - grid[h]) / (0.15 * T));
    if (rng() < 0.004) b *= 20;
    w[h] = b;
    tot += b;
  }
  const ll = new Float64Array(K);
  const logPrior = Array.from(prior, (p) => Math.log(Math.max(p, 1e-12)));
  const out = [];
  for (let h = 0; h < grid.length; h++) {
    const f = new Float64Array(K);
    if (grid[h] >= A) { f[winner] = 1; out.push(f); continue; }
    // Information released during the hour before grid[h] (none at the listing hour).
    if (h > 0) {
      const mu = Math.sqrt((w[h] * Itot) / tot);
      for (let i = 0; i < K; i++) {
        const y = (i === winner ? mu : 0) + randNormal(rng);
        ll[i] += mu * y - (mu * mu) / 2;
      }
    }
    let mx = -Infinity;
    for (let i = 0; i < K; i++) mx = Math.max(mx, logPrior[i] + ll[i]);
    let s = 0;
    for (let i = 0; i < K; i++) { f[i] = Math.exp(logPrior[i] + ll[i] - mx); s += f[i]; }
    for (let i = 0; i < K; i++) f[i] /= s;
    out.push(f);
  }
  return { winner, fair: out };
}

// ---------- markets & events ----------

function gammaMarket(rng, ev, m, o) {
  const tokenYes = digits(rng, 40), tokenNo = digits(rng, 40);
  const feeOn = m.listingTs >= o.feeFromTs;
  const [feeType, rate] = FEE_BY_CAT[ev.category];
  return {
    id: String(m.n),
    question: m.question,
    conditionId: `0x${hex(rng, 64)}`,
    slug: `synthetic-${m.n}`,
    outcomes: '["Yes", "No"]',
    clobTokenIds: JSON.stringify([tokenYes, tokenNo]),
    outcomePrices: m.outcomePrices ?? (m.yesWon ? '["1", "0"]' : '["0", "1"]'),
    active: m.active ?? true,
    closed: true,
    createdAt: iso(m.listingTs - 60),
    startDate: iso(m.listingTs),
    acceptingOrdersTimestamp: iso(m.listingTs),
    endDate: m.endDate === null ? null : iso(m.anchorTs),
    closedTime: gammaClosed(m.closedTs),
    umaResolutionStatus: m.umaStatus ?? 'resolved',
    negRisk: !!ev.negRiskMarketID,
    negRiskMarketID: ev.negRiskMarketID ?? null,
    negRiskOther: false,
    groupItemTitle: m.groupItemTitle ?? null,
    feeType: feeOn ? feeType : null,
    feesEnabled: feeOn,
    feeSchedule: feeOn ? { exponent: 1, rate, takerOnly: true, rebateRate: 0.25 } : null,
    volumeNum: Math.round(1000 + 1e5 * rng()),
  };
}

// Displayed Yes series for one market from its fair path: bounce (negRisk), planted bias, rounding,
// stamps (hour + jitter) and gaps. points: [{ t, p }].
function displaySeries(rng, grid, fairAt, o, { bounce = false } = {}) {
  const pts = [];
  let gapLeft = 0;
  for (let h = 0; h < grid.length; h++) {
    if (gapLeft > 0) { gapLeft--; continue; }
    if (h > 0 && rng() < o.gapProb) { gapLeft = Math.floor(rng() * o.gapMaxH); continue; }
    let f = fairAt(h);
    let d = f;
    if (f > 0 && f < 1) {
      if (bounce) d = logistic(logit(clamp(f, 1e-6, 1 - 1e-6)) + o.bounceLogit * (2 * rng() - 1));
      if (o.world === 'planted') d = plantedYes(d, o);
    }
    const stamp = grid[h] + (rng() < o.jitterProb ? 60 + Math.floor(rng() * (o.jitterMaxSec - 60)) : Math.floor(rng() * 60));
    pts.push({ t: stamp, p: round4(d) });
  }
  return pts;
}

const COMPANY = ['Zentra', 'Avalon Labs', 'Korvex', 'Lumio', 'Nexora', 'Quillon'];

// One synthetic event: { ev, specs: [{ m, gamma, grid, fairAt, points, ... }], gammaEvent } (gammaEvent is
// shaped like gamma /events output). o must come from worldOptions(). Exported for the mock-API test.
export function buildEvent(i, o) {
  const rng = makeRng(o.seed, 'gen-event', i);
  const n0 = i * 100;
  const span = o.toTs - o.fromTs;
  let kind = pickWeighted(rng, KIND_WEIGHTS);
  let dirty = null;
  let special = null;
  const u = rng();
  if (u < o.sportsProb) special = 'sports';
  else if (u < o.sportsProb + o.updownProb) special = 'updown';
  else if (rng() < o.dirtyProb) { dirty = pick(rng, DIRTY); kind = 'binary'; }
  const category = pick(rng, CATS[kind]);
  const lifeD = Math.exp(Math.log(o.lifeMinD) + rng() * (Math.log(o.lifeMaxD) - Math.log(o.lifeMinD)));
  const A = Math.floor((o.fromTs + 10 * DAY + rng() * (span - 12 * DAY)) / HOUR) * HOUR + (rng() < 0.5 ? 12 * HOUR : 0);
  const L = Math.floor((A - lifeD * DAY) / 60) * 60;
  const eventId = String(900000 + i);
  const ev = { id: eventId, kind, category, dirty, special, negRiskMarketID: null, title: '', slug: `synthetic-event-${i}`, tags: TAGS[category], markets: [] };
  const specs = []; // { m: market fields, series: { points }, truthFair: (t) => fair }

  const delay = () => HOUR + Math.floor(rng() * 30 * HOUR);
  const name = word(rng, 2);
  if (kind === 'deadline' || kind === 'ladder') {
    const M = kind === 'ladder' ? 2 + Math.floor(rng() * 3) : 1;
    const fr = Array.from({ length: M - 1 }, () => 0.2 + 0.75 * rng()).sort((a, b) => a - b);
    const deadlines = [...fr.map((f) => Math.floor((L + f * (A - L)) / HOUR) * HOUR), A];
    const hz = makeHazard(rng, L, A);
    ev.title = `[SYNTHETIC] Will the ${name} accord happen by...?`;
    for (let j = 0; j < M; j++) {
      const D = deadlines[j];
      const yesWon = hz.tau <= D;
      const closedTs = Math.floor(Math.min(hz.tau, D) + delay());
      const grid = hourGrid(L, closedTs);
      specs.push({
        m: { question: `[SYNTHETIC] Will the ${name} accord happen by ${dateText(D)}?`, anchorTs: D, listingTs: L, closedTs, yesWon, groupItemTitle: dateText(D) },
        grid,
        // Public at t: whether tau has happened. Yes once tau <= min(t, D); No once t >= D without it.
        fairAt: (h) => (hz.tau <= grid[h] && hz.tau <= D ? 1 : grid[h] >= D ? 0 : hazardFair(hz, grid[h], D)),
      });
    }
  } else if (kind === 'threshold') {
    const M = 1 + Math.floor(rng() * 5);
    const asset = pick(rng, COMPANY);
    const T = (A - L) / DAY;
    const zc = 0.7 * randNormal(rng);
    const strikes = Array.from({ length: M }, (_, j) => Math.sqrt(T) * (zc + 0.6 * (j - (M - 1) / 2)));
    const closedTs = A + Math.floor(HOUR + rng() * 8 * HOUR);
    const grid = hourGrid(L, closedTs);
    // Latent S on the grid; S at the anchor decides every strike.
    const S = new Float64Array(grid.length);
    let SA = null;
    for (let h = 0; h < grid.length; h++) {
      const prevT = h === 0 ? L : grid[h - 1];
      const dt = Math.max(0, Math.min(grid[h], A) - Math.min(prevT, A)) / DAY;
      S[h] = (h === 0 ? 0 : S[h - 1]) + Math.sqrt(dt) * randNormal(rng);
      if (SA == null && grid[h] >= A) SA = S[h];
    }
    if (SA == null) SA = S[grid.length - 1];
    ev.title = `[SYNTHETIC] ${asset} closing price on ${dateText(A)}?`;
    const base = 1000 + Math.floor(rng() * 9000);
    for (let j = 0; j < M; j++) {
      const K = strikes[j];
      const yesWon = SA > K;
      specs.push({
        m: { question: `[SYNTHETIC] Will ${asset} close above $${Math.round(base * (1 + 0.05 * K))} on ${dateText(A)}?`, anchorTs: A, listingTs: L, closedTs, yesWon },
        grid,
        fairAt: (h) => (grid[h] >= A ? (yesWon ? 1 : 0) : normalCdf((S[h] - K) / Math.sqrt((A - grid[h]) / DAY))),
      });
    }
  } else {
    const isGroup = kind === 'negrisk';
    const K = isGroup ? 4 + Math.floor(rng() * 9) : 2;
    // Some groups list only part of the field (no "Other" market): the hidden outcomes keep
    // prior mass, so calibrated Yes-sums are below 1 without any mispricing.
    const hidden = isGroup && rng() < o.hiddenProb ? 1 + Math.floor(rng() * 2) : 0;
    let prior;
    if (isGroup) {
      const g = Array.from({ length: K + hidden }, () => randGamma(rng, 0.7) + 1e-9);
      const s = g.reduce((a, b) => a + b, 0);
      prior = g.map((x) => x / s);
    } else {
      const p = 0.05 + 0.9 * rng();
      prior = [p, 1 - p];
    }
    const closeAt = (j) => A + Math.floor(HOUR + rng() * 20 * HOUR);
    const closes = Array.from({ length: isGroup ? K : 1 }, (_, j) => closeAt(j));
    if (dirty === 'late_close') closes[0] = A + Math.floor((31 + 30 * rng()) * DAY);
    const gridAll = hourGrid(L, Math.max(...closes));
    const sp = makeSignalPaths(rng, K + hidden, prior, gridAll, L, A);
    if (isGroup) {
      ev.negRiskMarketID = `0x${hex(rng, 64)}`;
      const contest = `${word(rng, 2)} ${pick(rng, ['Prize', 'Election', 'Award', 'Cup of Letters'])} ${new Date(A * 1000).getUTCFullYear()}`;
      ev.title = `[SYNTHETIC] Who will win the ${contest}?`;
      for (let j = 0; j < K; j++) {
        const grid = gridAll.filter((t) => t <= closes[j]);
        specs.push({
          m: { question: `[SYNTHETIC] Will ${word(rng, 2)} ${word(rng, 3)} win the ${contest}?`, anchorTs: A, listingTs: L, closedTs: closes[j], yesWon: sp.winner === j, groupItemTitle: `member ${j + 1}` },
          grid,
          fairAt: (h) => sp.fair[h][j],
          bounce: true,
        });
      }
      if (rng() < o.placeholderProb) {
        specs.push({ m: { question: `[SYNTHETIC] Will Person ${String.fromCharCode(65 + K)} win the ${contest}?`, anchorTs: A, listingTs: L, closedTs: closes[0], yesWon: false, active: false, groupItemTitle: 'placeholder' }, grid: [], fairAt: () => 0, placeholder: true });
      }
    } else {
      const org = `${word(rng, 2)} ${pick(rng, ['Central Bank', 'Regulator', 'Council', 'Agency'])}`;
      ev.title = `[SYNTHETIC] ${org} decision in ${MONTHS[new Date(A * 1000).getUTCMonth()]}?`;
      const grid = gridAll.filter((t) => t <= closes[0]);
      const m = { question: `[SYNTHETIC] Will the ${org} approve the ${word(rng, 2)} plan at its ${MONTHS[new Date(A * 1000).getUTCMonth()]} meeting?`, anchorTs: A, listingTs: L, closedTs: closes[0], yesWon: sp.winner === 0 };
      if (dirty === 'voided') m.outcomePrices = '["0.5", "0.5"]';
      if (dirty === 'ambiguous') m.outcomePrices = '["1", "1"]';
      if (dirty === 'non_final') m.umaStatus = 'proposed';
      if (dirty === 'no_end_date' || dirty === 'event_end_only') m.endDate = null;
      specs.push({ m, grid, fairAt: (h) => sp.fair[h][0], missing: dirty === 'missing_prices' });
    }
  }
  if (special === 'sports') { ev.tags = ['sports', 'nba']; ev.title = `[SYNTHETIC] ${word(rng)} vs. ${word(rng)}`; }
  if (special === 'updown') { ev.tags = ['crypto', 'up-or-down']; ev.title = `[SYNTHETIC] Bitcoin Up or Down - ${dateText(A)}`; }
  ev.endDate = dirty === 'no_end_date' ? null : iso(Math.max(...specs.map((s) => s.m.anchorTs)));
  for (let j = 0; j < specs.length; j++) {
    specs[j].m.n = n0 + j;
    specs[j].gamma = gammaMarket(rng, ev, specs[j].m, o);
    // Each market's display noise from its own stream, so the null and planted worlds share paths.
    const drng = makeRng(o.seed, 'display', i, j);
    specs[j].points = specs[j].placeholder || specs[j].missing ? [] : displaySeries(drng, specs[j].grid, specs[j].fairAt, o, { bounce: !!specs[j].bounce });
  }
  const gammaEvent = {
    id: eventId, title: ev.title, slug: ev.slug, negRisk: !!ev.negRiskMarketID, endDate: ev.endDate,
    createdAt: iso(L - 120), startDate: iso(L), closedTime: gammaClosed(Math.max(...specs.map((s) => s.m.closedTs))),
    tags: ev.tags.map((slug) => ({ id: TAG_IDS[slug] || '9000099', slug, label: slug })), series: [], markets: specs.map((s) => s.gamma),
  };
  return { ev, specs, gammaEvent };
}

// ---------- driver ----------

// Writes markets.jsonl, prices/, groups/ and collect-runs.jsonl into dataDir; ground truth to
// truthFile (optional). Returns a summary including the expected per-market facts.
export function worldOptions(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!WORLDS.includes(o.world)) throw new Error(`world must be one of ${WORLDS.join(', ')}, got "${o.world}"`);
  if (!(Number.isInteger(o.events) && o.events > 0)) throw new Error('events must be a positive integer');
  o.fromTs = Date.parse(`${o.from}T00:00:00Z`) / 1000;
  if (!Number.isFinite(o.fromTs)) throw new Error(`bad from date "${o.from}"`);
  const to = new Date(o.fromTs * 1000);
  to.setUTCMonth(to.getUTCMonth() + o.months);
  o.toTs = to.getTime() / 1000;
  o.feeFromTs = Date.parse(`${o.feeFrom}T00:00:00Z`) / 1000;
  return o;
}

export async function generateWorld(opts = {}) {
  if (!opts.dataDir) throw new Error('generateWorld needs dataDir');
  const o = worldOptions(opts);

  const dataDir = path.resolve(o.dataDir);
  const dirs = { prices: path.join(dataDir, 'prices'), groups: path.join(dataDir, 'groups') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const truthFd = o.truthFile ? (fs.mkdirSync(path.dirname(path.resolve(o.truthFile)), { recursive: true }), fs.openSync(o.truthFile, 'w')) : null;
  const summary = {
    synthetic: true, world: o.world, seed: o.seed, events: o.events, dataDir, truthFile: o.truthFile ? path.resolve(o.truthFile) : null,
    range: { from: iso(o.fromTs), to: iso(o.toTs) },
    marketsGenerated: 0, marketsKept: 0, priceFiles: 0, byKind: {}, byCategory: {}, skipped: {}, excludedEvents: { sports: 0, crypto_up_or_down: 0 },
    dirty: Object.fromEntries(DIRTY.map((d) => [d, []])),
    params: Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, o[k]])),
  };
  const lines = [];
  let truthBuf = [];
  const flushTruth = () => { if (truthFd != null && truthBuf.length) fs.writeSync(truthFd, truthBuf.join('')); truthBuf = []; };
  try {
    for (let i = 0; i < o.events; i++) {
      const { ev, specs, gammaEvent } = buildEvent(i, o);
      summary.marketsGenerated += specs.length;
      const byToken = new Map(specs.map((s) => [String(JSON.parse(s.gamma.clobTokenIds)[0]), s]));
      const ctx = {
        range: { sinceTs: o.fromTs, untilTs: null },
        dirs,
        warn: () => {},
        loadPrices: async (tokenId, windows) => {
          const s = byToken.get(tokenId);
          const pts = (s ? s.points : []).filter((pt) => windows.some(([a, b]) => pt.t >= a && pt.t <= b));
          const rec = { tokenId, fidelity: 60, windows, points: pts, synthetic: true };
          fs.writeFileSync(path.join(dirs.prices, `${tokenId}.json`), JSON.stringify(rec));
          summary.priceFiles++;
          return rec;
        },
      };
      const res = await processEvent(ctx, gammaEvent);
      for (const [k, v] of Object.entries(res.skipped)) summary.skipped[k] = (summary.skipped[k] || 0) + v;
      if (res.skipped.event_sports) summary.excludedEvents.sports++;
      if (res.skipped.event_crypto_up_or_down) summary.excludedEvents.crypto_up_or_down++;
      if (ev.dirty) summary.dirty[ev.dirty].push(specs[0].gamma.conditionId);
      for (const rec of res.kept) {
        rec.collectedAt = o.toTs + 7 * DAY;
        lines.push([rec.anchorTs, JSON.stringify(rec)]);
        summary.marketsKept++;
        summary.byKind[ev.kind] = (summary.byKind[ev.kind] || 0) + 1;
        summary.byCategory[rec.category] = (summary.byCategory[rec.category] || 0) + 1;
        if (truthFd == null) continue;
        const s = byToken.get(rec.yesTokenId);
        const plan = decisionPlan(rec);
        const q = {};
        for (const d of plan.decisions) {
          for (let h = 0; h < s.grid.length; h++) {
            const t = s.grid[h];
            if (t > d.decisionTs) break;
            if (t >= d.decisionTs - d.maxAgeSec - HOUR) q[t] = r6(s.fairAt(h));
          }
        }
        truthBuf.push(`${JSON.stringify({ conditionId: rec.conditionId, eventId: rec.eventId, kind: ev.kind, category: rec.category, anchorTs: rec.anchorTs, closedTs: rec.closedTs, listingTs: rec.listingTs, yesWon: rec.winnerIndex === rec.yesIndex ? 1 : 0, dirty: ev.dirty, q })}\n`);
        if (truthBuf.length >= 500) flushTruth();
      }
    }
    flushTruth();
  } finally {
    if (truthFd != null) fs.closeSync(truthFd);
  }
  lines.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(dataDir, 'markets.jsonl'), lines.map((x) => x[1]).join('\n') + (lines.length ? '\n' : ''));
  // Same provenance file the collector writes, so the builder and backtest flag this dir synthetic.
  fs.appendFileSync(path.join(dataDir, 'collect-runs.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), tool: 'research/general/synthetic.js', status: 'completed',
    synthetic: `SYNTHETIC general-track generator, ${o.world} world, seed ${o.seed}, ${o.events} events (tooling validation only)`,
    dataDir, kept: summary.marketsKept,
  })}\n`);
  return summary;
}

// ---------- CLI ----------

const USAGE = `Usage: node research/general/synthetic.js --out <dataDir> [--world null|planted] [--events 5000] [--seed 1]
       [--truth <file>] [--<param> <value> ...]
Writes a SYNTHETIC general-track data dir (tooling validation only). --truth defaults to
<dataDir>.truth.jsonl, outside the data dir. Any DEFAULTS key can be overridden in kebab-case:
${Object.entries(DEFAULTS).map(([k, v]) => `  ${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v}`).join('\n')}`;

function optsFromArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') return { help: true };
    if (!tok.startsWith('--')) throw new Error(`unexpected argument "${tok}"`);
    const eq = tok.indexOf('=');
    const key = (eq > 0 ? tok.slice(2, eq) : tok.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (val == null) throw new Error(`missing value for ${tok}`);
    if (key === 'out') o.dataDir = val;
    else if (key === 'truth') o.truthFile = val;
    else if (!(key in DEFAULTS)) throw new Error(`unknown option ${tok}`);
    else if (typeof DEFAULTS[key] === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) throw new Error(`${tok} must be a number`);
      o[key] = n;
    } else o[key] = val;
  }
  return o;
}

async function main() {
  const o = optsFromArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  if (!o.dataDir) throw new Error('--out <dataDir> is required (see --help)');
  if (o.truthFile === undefined) o.truthFile = `${path.resolve(o.dataDir).replace(/[\/\\]+$/, '')}.truth.jsonl`;
  const s = await generateWorld(o);
  const { dirty, ...rest } = s;
  console.log(`SYNTHETIC ${s.world} general world written (tooling validation only, not market data):`);
  console.log(JSON.stringify({ ...rest, dirty: Object.fromEntries(Object.entries(dirty).map(([k, v]) => [k, v.length])) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`general synthetic: ${e.stack || e.message}`); process.exitCode = 1; });
}
