#!/usr/bin/env node
// SYNTHETIC data generator for validating the research tooling. It writes the collector's raw
// formats (markets.jsonl, prices/<tokenId>.json, trades/<conditionId>.jsonl) plus a ground-truth
// file kept OUTSIDE the data dir. Nothing produced here is evidence about real markets.
//
// Model. Each market is driven by a latent Gaussian random walk S whose value at game end decides
// the outcome. The fair probability at time t is P(outcome | S_t) = Phi((S_t - thr) / sqrt(Vrem(t))),
// an exact martingale, so in the "null" world prices are calibrated at every decision time and no
// selection rule can beat costs. The "planted" world distorts only the displayed prices (longshots
// overpriced, unders underpriced) and adds informed wallets that buy the eventual winner without
// moving the price. Both worlds share every random draw except those, so a seed gives paired worlds.
//
// The "stress" world keeps null-world prices and adds data defects the builder must neutralise
// (from its own random stream, so the null and planted worlds are unchanged):
//   - one-sided gaps: token 1's series misses 1-5h stretches, so its last quote is often stale;
//   - impact flow: buyers of the token whose fair price rose arrive during each hour, before the
//     next quote prints. Flow after a stale quote reveals the move; buying at the stale quote then
//     looks profitable but was never on offer;
//   - busy tapes: heavy live betting in front of the pre-game trades, paged with the collector's
//     own tape rules (lib/tape.js) under tight page caps, so some tapes stop before the window.
// Prices still reflect everything known at their timestamp, so no rule using only information up
// to its fill price can beat costs; every survivor is false.
//
// truth.jsonl, one line per market: { conditionId, startTs, winnerIndex, informedTarget, q0 } where
// q0[k] is outcome 0's true win probability k hours before start, using everything the generator
// knows at that time (latent state plus any informed trade already printed). Outcome 1 is 1 - q0[k].
// Busy markets also carry tokenIds and their full pre-game tape [[t, tokenIndex, side, size, price,
// wallet], ...] so the self-test can check that trade features are exact or null.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRng, normalCdf, randNormal } from './stats.js';
import { createTape, TAPE_VERSION } from './tape.js';

const HOUR = 3600;
const DAY = 86400;
// Share of the in-game variance (total 1) released in hours 1, 2 and 3 after start.
const IN_GAME = [0.35, 0.35, 0.3];

export const PLANTED_EDGES = Object.freeze({
  'favorite-longshot': 'outcomes displayed at ~0.05-0.25 win longshotBias less often than priced, so their favorite complements are underpriced',
  'under-totals': 'unders on game totals win underBias more often than priced',
  'under-props': 'unders / No on player props win underBias more often than priced',
  'large-flow-follow': 'informed wallets buy the eventual winner (informedAccuracy) without moving the price',
});
// Mirror images of the planted edges: their true edge is negative in the planted world.
export const PLANTED_MIRRORS = Object.freeze(['baseline-all', 'longshot-buy', 'over-control', 'large-flow-fade']);

export const DEFAULTS = Object.freeze({
  world: 'null',
  events: 2500,
  seed: 1,
  from: '2024-04-01',
  months: 18,
  preHours: 80,             // hourly history (and truth) from start-80h to start
  lateListProb: 0.12,       // markets listed only 4-30h before start
  gapProb: 0.03,            // per-hour chance a gap of up to gapMaxH missing points starts
  gapMaxH: 9,
  jitterProb: 0.5,          // points stamped up to jitterMaxSec after their grid hour
  jitterMaxSec: 600,
  vigProb: 0.25,            // both sides quoted above fair by vig/2 (never below: that would be an edge)
  vigMax: 0.03,
  preVarMin: 0.04,          // pre-game information variance as a share of in-game variance
  preVarMax: 0.2,
  newsProb: 0.015,          // per-hour chance of a news spike in information flow
  eventStartFallbackProb: 0.15, // events with gameStartTime null and eventStartDate = kickoff
  dirtyProb: 0.03,          // markets with broken times or a missing price file (must be dropped/handled)
  tradeCoverage: 0.92,      // share of markets with a trades file
  retailPerDay: 25,
  whaleProb: 0.3,           // uninformed large trades (both worlds)
  // planted world only
  longshotBias: 0.05,
  longshotLo: 0.05,
  longshotHi: 0.25,
  underBias: 0.05,
  informedProb: 0.3,
  informedAccuracy: 0.68,
  // stress world only
  oneSidedGapProb: 0.25,    // per-hour chance a gap starts in token 1's series only
  oneSidedGapMaxH: 5,
  impactPerMove: 150,       // impact trades per unit of displayed price change in an hour
  impactUsd: 1500,
  busyProb: 0.06,           // markets with heavy in-game trading
  busyInGameMin: 2500,
  busyInGameMax: 6000,
  tapePageSize: 500,        // collector paging applied to busy tapes (tight page cap on purpose)
  tapeMaxPages: 8,
  tapeMaxTrades: 3000,
});

export const WORLDS = Object.freeze(['null', 'planted', 'stress']);

const FIRST = ['Marcus', 'Tyler', 'Andre', 'Jalen', 'Devon', 'Cole', 'Isaiah', 'Mason', 'Darius', 'Owen', 'Rafael', 'Luca', 'Niko', 'Theo', 'Samir', 'Victor', 'Elias', 'Jonah', 'Kai', 'Bruno'];
const LAST = ['Carter', 'Brooks', 'Hayes', 'Ellis', 'Morrow', 'Vance', 'Okafor', 'Lindqvist', 'Moreau', 'Santos', 'Novak', 'Reyes', 'Kowalski', 'Adeyemi', 'Fischer', 'Duarte', 'Whitlock', 'Ivers', 'Castell', 'Bauer'];

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const SPORTS = Object.freeze({
  nba: {
    weight: 0.22, months: [1, 2, 3, 4, 5, 6, 10, 11, 12], hours: [23.5, 0, 0.5, 1, 2, 2.5, 3],
    teams: ['Lakers', 'Celtics', 'Warriors', 'Knicks', 'Bucks', 'Nuggets', 'Suns', 'Heat', '76ers', 'Mavericks', 'Clippers', 'Grizzlies', 'Cavaliers', 'Kings', 'Pelicans', 'Hawks', 'Bulls', 'Raptors', 'Thunder', 'Timberwolves', 'Magic', 'Pacers', 'Jazz', 'Spurs'],
    ml: { sigma: 1.0, home: 0.12, scale: 12 }, spread: { prob: 0.85 },
    total: { base: 226, jitter: 8, scale: 18, step: 5, alt: 2, team: { prob: 1, base: 113, jitter: 5 }, parts: [['1H', 113, 4], ['2H', 112, 4]] },
    props: { n: [3, 7], ou: [['Points', 12, 32], ['Rebounds', 4, 12], ['Assists', 3, 10]], yn: [], longshot: { n: [1, 3], labels: ['Triple-Double', '40+ Points'] } },
  },
  nfl: {
    weight: 0.12, months: [1, 2, 9, 10, 11, 12], hours: [17, 18, 20.5, 21.5, 0.25, 1.25],
    teams: ['Chiefs', 'Bills', 'Eagles', 'Cowboys', '49ers', 'Ravens', 'Bengals', 'Lions', 'Packers', 'Dolphins', 'Jets', 'Steelers', 'Chargers', 'Broncos', 'Seahawks', 'Rams', 'Vikings', 'Bears', 'Saints', 'Buccaneers', 'Falcons', 'Texans', 'Colts', 'Jaguars'],
    ml: { sigma: 0.9, home: 0.1, scale: 13 }, spread: { prob: 0.9 },
    total: { base: 45, jitter: 4, scale: 13, step: 3.5, alt: 2, team: { prob: 1, base: 22.5, jitter: 3 }, parts: [['1H', 22.5, 2], ['2H', 21.5, 2]] },
    props: { n: [3, 7], ou: [['Passing Yards', 190, 300], ['Rushing Yards', 35, 95], ['Receiving Yards', 35, 95]], yn: ['Anytime Touchdown'], longshot: { n: [1, 3], labels: ['2+ Touchdowns'] } },
  },
  mlb: {
    weight: 0.2, months: [4, 5, 6, 7, 8, 9, 10], hours: [17, 18, 23, 0, 1, 2],
    teams: ['Yankees', 'Red Sox', 'Dodgers', 'Astros', 'Braves', 'Mets', 'Phillies', 'Padres', 'Cubs', 'Mariners', 'Blue Jays', 'Orioles', 'Twins', 'Guardians', 'Brewers', 'Rays', 'Diamondbacks', 'Tigers', 'Royals', 'Reds'],
    ml: { sigma: 0.45, home: 0.06, scale: 4 }, spread: { prob: 0.6, fixed: 1.5 },
    total: { base: 8.5, jitter: 1, scale: 3.5, step: 1, alt: 2, team: { prob: 1, base: 4.5, jitter: 0.6 }, parts: [['1st 5 Innings', 4.5, 0.6]] },
    props: { n: [2, 5], ou: [['Strikeouts', 3.5, 8.5], ['Hits', 0.5, 1.5], ['RBIs', 0.5, 1.5]], yn: [], longshot: { n: [1, 3], labels: ['Home Run'] } },
  },
  nhl: {
    weight: 0.14, months: [1, 2, 3, 4, 5, 6, 10, 11, 12], hours: [23, 0, 0.5, 1, 2],
    teams: ['Bruins', 'Rangers', 'Maple Leafs', 'Oilers', 'Avalanche', 'Panthers', 'Lightning', 'Golden Knights', 'Stars', 'Hurricanes', 'Devils', 'Canucks', 'Penguins', 'Capitals', 'Flames', 'Predators', 'Islanders', 'Senators', 'Red Wings', 'Kraken'],
    ml: { sigma: 0.5, home: 0.08, scale: 2.5 }, spread: { prob: 0.5, fixed: 1.5 },
    total: { base: 6, jitter: 0.5, scale: 2.2, step: 1, alt: 1, team: { prob: 1, base: 3.5, jitter: 0.4 }, parts: [['1P', 1.5, 0.3]] },
    props: { n: [2, 4], ou: [['Points', 0.5, 1.5]], yn: [], longshot: { n: [1, 2], labels: ['to score 2+ goals'] } },
  },
  soccer: {
    weight: 0.18, months: [1, 2, 3, 4, 5, 8, 9, 10, 11, 12], hours: [12, 14, 15, 17, 19, 20],
    teams: ['Arsenal', 'Chelsea', 'Liverpool', 'Man City', 'Man United', 'Tottenham', 'Newcastle', 'Aston Villa', 'Real Madrid', 'Barcelona', 'Atletico Madrid', 'Bayern Munich', 'Dortmund', 'PSG', 'Inter', 'AC Milan', 'Juventus', 'Napoli', 'Benfica', 'Porto'],
    threeWay: { sigma: 0.7, home: 0.15, draw: 0.33 },
    total: { base: 2.5, jitter: 0, scale: 1.6, step: 1, alt: 2, team: { prob: 1, base: 1.5, jitter: 0 }, parts: [['1H', 1.5, 0], ['2H', 1.5, 0]] },
    props: { n: [2, 4], ou: [], yn: ['to score'], longshot: { n: [1, 3], labels: ['to score 2+ goals'] } },
  },
  cs2: {
    weight: 0.14, months: ALL_MONTHS, hours: [10, 13, 16, 19],
    teams: ['NAVI', 'FaZe', 'Vitality', 'G2', 'Spirit', 'MOUZ', 'Heroic', 'Astralis', 'Liquid', 'Complexity', 'Virtus.pro', 'Eternal Fire', 'The MongolZ', 'FURIA'],
    esports: { sigma: 1.0, maps: 2 },
  },
  tennis: {
    weight: 0.12, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], hours: [10, 12, 14, 16, 18, 23],
    players: true,
    tennis: { sigma: 1.2, games: [20.5, 24.5] },
  },
});
const SPORT_KEYS = Object.keys(SPORTS);
const playerName = (rng) => `${pick(rng, FIRST)} ${pick(rng, LAST)}`;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const half = (x) => Math.floor(x) + 0.5; // betting lines end in .5 so there are no pushes
const pad = (n) => String(n).padStart(2, '0');
const isoTime = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
const isoMs = (ts) => new Date(ts * 1000).toISOString();
const dateStr = (ts) => isoTime(ts).slice(0, 10);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const HEX = '0123456789abcdef';
const hex = (rng, n) => { let s = ''; for (let i = 0; i < n; i++) s += HEX[Math.floor(rng() * 16)]; return s; };
const digits = (rng, n) => { let s = String(1 + Math.floor(rng() * 9)); for (let i = 1; i < n; i++) s += Math.floor(rng() * 10); return s; };

function gammaTime(ts) {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00`;
}

function poisson(rng, lam) {
  if (!(lam > 0)) return 0;
  if (lam > 40) return Math.max(0, Math.round(lam + Math.sqrt(lam) * randNormal(rng)));
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

function pickWeighted(rng, keys, weightOf) {
  const total = keys.reduce((s, k) => s + weightOf(k), 0);
  let u = rng() * total;
  for (const k of keys) { u -= weightOf(k); if (u <= 0) return k; }
  return keys[keys.length - 1];
}

// ---------- latent model ----------

// S[k] is the latent k hours before start (k = K..0); V[k] is the variance still to come after
// hour k, including the whole game. Hourly variance rises toward start and has news spikes.
function makeLatent(rng, mu0, o) {
  const K = o.preHours;
  const fPre = o.preVarMin + rng() * (o.preVarMax - o.preVarMin);
  const w = new Float64Array(K + 1);
  let tot = 0;
  for (let k = 1; k <= K; k++) {
    let b = 1 + 4 * Math.exp(-k / 10);
    if (rng() < o.newsProb) b *= 10 + 20 * rng();
    w[k] = b;
    tot += b;
  }
  const S = new Float64Array(K + 1), V = new Float64Array(K + 1);
  S[K] = mu0;
  for (let k = K; k >= 1; k--) {
    w[k] *= fPre / tot;
    S[k - 1] = S[k] + Math.sqrt(w[k]) * randNormal(rng);
  }
  V[0] = 1;
  for (let k = 1; k <= K; k++) V[k] = V[k - 1] + w[k];
  const in1 = S[0] + Math.sqrt(IN_GAME[0]) * randNormal(rng);
  const in2 = in1 + Math.sqrt(IN_GAME[1]) * randNormal(rng);
  const end = in2 + Math.sqrt(IN_GAME[2]) * randNormal(rng);
  return { S, V, inS: [in1, in2], inV: [IN_GAME[1] + IN_GAME[2], IN_GAME[2]], end };
}

// P(outcome 0) given latent value x with variance v still to come.
function probYes(m, x, v) {
  const sd = Math.sqrt(v);
  if (m.kind === 'band') return normalCdf((m.hi - x) / sd) - normalCdf((m.lo - x) / sd);
  return normalCdf((m.sign * x - m.thr) / sd);
}
const wins0 = (m, x) => (m.kind === 'band' ? x > m.lo && x <= m.hi : m.sign * x - m.thr > 0);

// Full bias where the longshot's displayed price lands in [longshotLo, longshotHi]; linear tapers
// at both ends keep the displayed price monotone in the fair one.
function longshotWeight(qs, o) {
  const a = Math.max(0.001, o.longshotLo - o.longshotBias), b = o.longshotHi - o.longshotBias;
  if (qs <= 0) return 0;
  if (qs < a) return qs / a;
  if (qs <= b) return 1;
  return Math.max(0, 1 - (qs - b) / 0.1);
}

// Displayed-minus-fair for outcome 0. overSide: outcome 0 is an Over / Yes on a total or prop.
// The under bias fades out where the longshot bias is at full strength (and vice versa);
// otherwise an Over favorite would carry both and the two planted edges would cancel.
export function plantedAdjust(q, overSide, o) {
  const qs = Math.min(q, 1 - q);
  let a = (q < 0.5 ? 1 : -1) * o.longshotBias * longshotWeight(qs, o);
  if (overSide) a += o.underBias * clamp((qs - (o.longshotHi - o.longshotBias)) / 0.1, 0, 1);
  return a;
}

// ---------- event construction ----------

function sampleStart(rng, sp, fromTs, toTs) {
  for (let tries = 0; tries < 200; tries++) {
    const day = fromTs + Math.floor(rng() * ((toTs - fromTs) / DAY)) * DAY;
    if (!sp.months.includes(new Date(day * 1000).getUTCMonth() + 1)) continue;
    return day + Math.round(pick(rng, sp.hours) * HOUR);
  }
  throw new Error('could not place an in-season date; widen --months');
}

// Market specs: question/outcomes plus how outcome 0's probability derives from a latent.
// cls is the market type the question is written to classify as (checked by the self-test).
function buildSpecs(rng, sp, a, b, date, o) {
  const specs = [];
  const add = (s) => specs.push({ kind: 'gt', sign: 1, thr: 0, overSide: false, negRisk: false, ...s });
  if (sp.esports) {
    const mu = sp.esports.sigma * randNormal(rng);
    const prefix = `Counter-Strike: ${a} vs. ${b}`;
    add({ suffix: 'match', cls: 'moneyline', question: `${prefix} (BO3)`, outcomes: [a, b], latent: makeLatent(rng, mu, o) });
    for (let m = 1; m <= sp.esports.maps; m++) {
      add({ suffix: `map-${m}`, cls: 'map', question: `${prefix} - Map ${m} Winner`, outcomes: [a, b], latent: makeLatent(rng, 0.6 * mu + 0.25 * randNormal(rng), o) });
    }
    if (rng() < 0.8) add({ suffix: 'total-maps', cls: 'total', overSide: true, question: `${prefix} - Total Maps O/U 2.5`, outcomes: ['Over', 'Under'], latent: makeLatent(rng, -0.1 + 0.3 * randNormal(rng), o) });
    return specs;
  }
  if (sp.tennis) {
    const mu = sp.tennis.sigma * randNormal(rng);
    add({ suffix: 'match', cls: 'moneyline', question: `${a} vs. ${b}`, outcomes: [a, b], latent: makeLatent(rng, mu, o) });
    if (rng() < 0.7) add({ suffix: 'set-1', cls: 'moneyline', question: `${a} vs. ${b}: Set 1 Winner`, outcomes: [a, b], latent: makeLatent(rng, 0.7 * mu + 0.3 * randNormal(rng), o) });
    const [lo, hi] = sp.tennis.games;
    const line = half(lo + rng() * (hi - lo));
    add({ suffix: `total-games-${String(line).replace('.', 'pt')}`, cls: 'total', overSide: true, question: `${a} vs. ${b}: Total Games O/U ${line}`, outcomes: ['Over', 'Under'], latent: makeLatent(rng, 0.4 * randNormal(rng), o) });
    return specs;
  }
  if (sp.threeWay) {
    // a = home. Latent is the home goal-difference signal; |S_T| <= draw band means a draw.
    const tw = sp.threeWay;
    const L = makeLatent(rng, tw.home + tw.sigma * randNormal(rng), o);
    add({ suffix: 'home', cls: 'moneyline', negRisk: true, question: `Will ${a} win on ${date}?`, outcomes: ['Yes', 'No'], latent: L, thr: tw.draw });
    add({ suffix: 'draw', cls: 'moneyline', negRisk: true, question: `Will ${a} vs. ${b} end in a draw?`, outcomes: ['Yes', 'No'], latent: L, kind: 'band', lo: -tw.draw, hi: tw.draw });
    add({ suffix: 'away', cls: 'moneyline', negRisk: true, question: `Will ${b} win on ${date}?`, outcomes: ['Yes', 'No'], latent: L, sign: -1, thr: tw.draw });
  } else {
    // a = away, b = home. Latent is the home margin in units of the in-game sd.
    const mu = sp.ml.home + sp.ml.sigma * randNormal(rng);
    const L = makeLatent(rng, mu, o);
    add({ suffix: 'ml', cls: 'moneyline', question: `${a} vs. ${b}`, outcomes: [a, b], latent: L, sign: -1 });
    if (rng() < sp.spread.prob) {
      const favHome = mu >= 0;
      const pts = sp.spread.fixed ?? half(Math.max(0, Math.abs(mu) * sp.ml.scale - 0.5));
      const fav = favHome ? b : a, dog = favHome ? a : b;
      add({ suffix: `spread-${slugify(fav)}-${String(pts).replace('.', 'pt')}`, cls: 'spread', question: `Spread: ${fav} (-${pts})`, outcomes: [fav, dog], latent: L, sign: favHome ? 1 : -1, thr: pts / sp.ml.scale });
    }
  }
  const t = sp.total;
  const main = half(t.base - 0.5 + t.jitter * randNormal(rng));
  const TL = makeLatent(rng, 0.2 * randNormal(rng), o);
  const lines = [0];
  // Alternate lines share the game-total latent, so they add correlated bets rather than new events.
  for (let j = 1; j <= t.alt; j++) {
    if (rng() < 0.3 / j) lines.push(-j);
    if (rng() < 0.3 / j) lines.push(j);
  }
  for (const j of lines) {
    const line = main + j * t.step;
    if (line <= 0) continue;
    add({ suffix: `total-${String(line).replace('.', 'pt')}`, cls: 'total', overSide: true, question: `${a} vs. ${b}: O/U ${line}`, outcomes: ['Over', 'Under'], latent: TL, thr: (j * t.step) / t.scale });
  }
  if (t.team) {
    for (const team of [a, b]) {
      if (rng() >= t.team.prob) continue;
      const line = half(t.team.base - 0.5 + t.team.jitter * randNormal(rng));
      add({ suffix: `team-total-${slugify(team)}`, cls: 'total', overSide: true, question: `${team} Team Total: O/U ${line}`, outcomes: ['Over', 'Under'], latent: makeLatent(rng, 0.2 * randNormal(rng), o) });
    }
  }
  for (const [label, base, jitter] of t.parts || []) {
    if (rng() >= 0.85) continue;
    const line = half(base - 0.5 + jitter * randNormal(rng));
    add({ suffix: `total-${slugify(label)}`, cls: 'total', overSide: true, question: `${a} vs. ${b}: ${label} O/U ${line}`, outcomes: ['Over', 'Under'], latent: makeLatent(rng, 0.2 * randNormal(rng), o) });
  }
  const pr = sp.props;
  const nProps = pr.n[0] + Math.floor(rng() * (pr.n[1] - pr.n[0] + 1));
  const used = new Set();
  for (let i = 0; i < nProps; i++) {
    const who = playerName(rng);
    if (used.has(who)) continue;
    used.add(who);
    const useYn = pr.yn.length && (!pr.ou.length || rng() < 0.35);
    if (useYn) {
      const kind = pick(rng, pr.yn);
      const question = kind === 'to score' ? `${who} to score vs. ${pick(rng, [a, b])}?` : `${who}: ${kind}?`;
      add({ suffix: `prop-${slugify(who)}-${slugify(kind)}`, cls: 'prop', overSide: true, question, outcomes: ['Yes', 'No'], latent: makeLatent(rng, -0.6 + 0.45 * randNormal(rng), o) });
    } else {
      const [stat, lo, hi] = pick(rng, pr.ou);
      const line = half(lo + rng() * (hi - lo));
      add({ suffix: `prop-${slugify(who)}-${slugify(stat)}`, cls: 'prop', overSide: true, question: `${who}: ${stat} O/U ${line}`, outcomes: ['Over', 'Under'], latent: makeLatent(rng, 0.4 * randNormal(rng), o) });
    }
  }
  // Long-shot Yes/No props (Yes ~0.03-0.2): the main source of heavy favorites (their No side).
  const ls = pr.longshot;
  const nLs = ls ? ls.n[0] + Math.floor(rng() * (ls.n[1] - ls.n[0] + 1)) : 0;
  for (let i = 0; i < nLs; i++) {
    const who = playerName(rng);
    const label = pick(rng, ls.labels);
    if (used.has(`${who}|${label}`)) continue;
    used.add(`${who}|${label}`);
    const question = label.startsWith('to score') ? `${who} ${label} vs. ${pick(rng, [a, b])}?` : `${who}: ${label}?`;
    add({ suffix: `prop-${slugify(who)}-${slugify(label)}`, cls: 'prop', overSide: true, question, outcomes: ['Yes', 'No'], latent: makeLatent(rng, -1.4 + 0.35 * randNormal(rng), o) });
  }
  return specs;
}

// ---------- per-market emission ----------

const DIRTY = ['no_game_start', 'event_start_date_only', 'closed_before_start', 'missing_token_prices'];

function emitMarket(ev, spec, counter, o, ctx) {
  const rng = ev.rng;
  const K = o.preHours;
  const { startTs } = ev;
  const L = spec.latent;
  const planted = o.world === 'planted';
  const stress = o.world === 'stress' ? makeRng(o.seed, 'stress', counter) : null;
  const display = (q) => clamp(q + (planted ? plantedAdjust(q, spec.overSide, o) : 0), 0.003, 0.997);

  const conditionId = `0x${hex(rng, 56)}${counter.toString(16).padStart(8, '0')}`;
  const tokenIds = [0, 1].map((j) => `${digits(rng, 30)}${String(2 * counter + j).padStart(10, '0')}`);
  const qPre = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) qPre[k] = probYes(spec, L.S[k], L.V[k]);
  const qIn = L.inS.map((x, h) => probYes(spec, x, L.inV[h]));
  const winnerIndex = wins0(spec, L.end) ? 0 : 1;

  const openK = rng() < o.lateListProb ? 4 + Math.floor(rng() * 27) : K;
  const desync = rng() < 0.05;
  const dirty = rng() < o.dirtyProb ? pick(rng, DIRTY) : null;

  // Displayed prices for both tokens on the grid (also used to price trades).
  const quote = (q) => {
    const v = rng() < o.vigProb ? rng() * o.vigMax : 0;
    const m = display(q);
    return [r3(clamp(m + v / 2, 0.001, 0.999)), r3(clamp(1 - m + v / 2, 0.001, 0.999))];
  };
  const pre = [new Float64Array(K + 1), new Float64Array(K + 1)];
  const stamp = new Float64Array(K + 1);
  const pts = [[], []];
  let gap = 0;
  let gap1 = 0;
  for (let k = K; k >= 0; k--) {
    const [p0, p1] = quote(qPre[k]);
    pre[0][k] = p0;
    pre[1][k] = p1;
    // Draw every random number before any skip so all markets consume the stream identically.
    const jit = rng() < o.jitterProb ? Math.floor(rng() * o.jitterMaxSec) : 0;
    const startGap = rng() < o.gapProb;
    const gapLen = 1 + Math.floor(rng() * o.gapMaxH);
    const drop1 = desync && rng() < 0.1;
    // A point's value only uses information up to its grid hour, and it is stamped at or after it.
    stamp[k] = startTs - k * HOUR + jit;
    let skip1 = false;
    if (stress) {
      const u = stress(), len = 1 + Math.floor(stress() * o.oneSidedGapMaxH);
      if (gap1 > 0) { gap1--; skip1 = true; } else if (k > 0 && u < o.oneSidedGapProb) { gap1 = len - 1; skip1 = true; }
    }
    if (k > openK) continue;
    if (gap > 0) { gap--; continue; }
    if (startGap && k > 0) { gap = gapLen - 1; continue; }
    pts[0].push({ t: stamp[k], p: p0 });
    if (!drop1 && !skip1) pts[1].push({ t: stamp[k], p: p1 });
  }
  const inGame = qIn.map((q) => quote(q));
  inGame.forEach(([p0, p1], h) => {
    const t = startTs + (h + 1) * HOUR + Math.floor(rng() * 300);
    pts[0].push({ t, p: p0 });
    pts[1].push({ t, p: p1 });
  });
  // Post-game points are a leakage trap: features must never see them.
  const tEnd = startTs + 3 * HOUR + 600;
  pts[0].push({ t: tEnd, p: winnerIndex === 0 ? 0.999 : 0.001 });
  pts[1].push({ t: tEnd, p: winnerIndex === 1 ? 0.999 : 0.001 });

  const listTs = startTs - openK * HOUR - Math.floor(rng() * 6) * HOUR;
  const closedTs = startTs + 3 * HOUR + Math.floor((0.2 + rng() * 1.3) * HOUR);
  const volume = Math.round(Math.exp(Math.log(40000) + 1.2 * randNormal(rng)));

  const priceAt = (tok, ts) => {
    if (ts < startTs) return pre[tok][Math.min(K, Math.ceil((startTs - ts) / HOUR))];
    const h = Math.floor((ts - startTs) / HOUR);
    return h <= 0 ? pre[tok][0] : inGame[Math.min(1, h - 1)][tok];
  };
  const tr = genTrades({ startTs, openK, winnerIndex, tokenIds, priceAt }, makeRng(o.seed, 'trades', counter), planted ? makeRng(o.seed, 'informed', counter) : null, o, ctx);
  let tape = { trades: tr.trades, info: completeTapeInfo(tr.trades, startTs - K * HOUR, startTs + 3 * HOUR) };
  let busyTape = null;
  if (stress) {
    addImpactFlow(tr.trades, { startTs, openK, tokenIds, pre, stamp, priceAt }, stress, o, ctx);
    if (stress() < o.busyProb) {
      busyTape = tr.trades.filter((t) => t.t <= startTs);
      addLiveBurst(tr.trades, { startTs, tokenIds, priceAt }, stress, o, ctx);
      tape = collectTape(tr.trades, { conditionId, tokenIds, fromT: startTs - K * HOUR, toT: startTs }, o);
    } else tape.info = completeTapeInfo(tr.trades, startTs - K * HOUR, startTs + 3 * HOUR);
  }

  // Truth: finest information available at each hour (latent + informed trade if already printed).
  const acc = o.informedAccuracy;
  const q0 = new Array(K + 1);
  for (let k = 0; k <= K; k++) {
    let q = qPre[k];
    if (tr.informed && tr.informed.firstTs <= startTs - k * HOUR) {
      const qt = tr.informed.target === 0 ? q : 1 - q;
      const post = (acc * qt) / (acc * qt + (1 - acc) * (1 - qt));
      q = tr.informed.target === 0 ? post : 1 - post;
    }
    q0[k] = r5(q);
  }

  const times = {
    gameStartTime: ev.fallback ? null : gammaTime(startTs),
    startDate: isoMs(listTs),
    endDate: isoTime(startTs + 7 * DAY),
    closedTime: gammaTime(closedTs),
    eventStartDate: ev.fallback ? isoTime(startTs) : isoTime(ev.createdTs),
    eventEndDate: isoTime(startTs + 7 * DAY),
  };
  if (dirty === 'no_game_start') { times.gameStartTime = null; times.eventStartDate = null; }
  if (dirty === 'event_start_date_only') { times.gameStartTime = null; times.eventStartDate = dateStr(startTs); }
  if (dirty === 'closed_before_start') times.closedTime = gammaTime(startTs - 2 * HOUR);

  const record = {
    conditionId,
    question: spec.question,
    slug: `${ev.eventSlug}-${spec.suffix}`,
    eventSlug: ev.eventSlug,
    eventTitle: ev.eventTitle,
    sport: ev.sportKey,
    tags: ev.tags,
    outcomes: spec.outcomes,
    tokenIds,
    winnerIndex,
    times,
    volume,
    negRisk: spec.negRisk,
    collectedAt: ctx.collectedAt,
  };
  if (tr.collected) record.tradesInfo = tape.info;
  const truth = { conditionId, startTs, winnerIndex, informedTarget: tr.informed ? tr.informed.target : null, q0 };
  if (busyTape && tr.collected) {
    truth.tokenIds = tokenIds;
    truth.tape = busyTape.map((t) => [t.t, t.asset === tokenIds[0] ? 0 : 1, t.side, t.size, t.price, t.wallet]);
  }
  return { record, pts, trades: tape.trades, writeTrades: tr.collected, truth, dirty, busy: !!busyTape };
}

// What collect.js records for a tape it read to the end: complete over [fromT, toT].
function completeTapeInfo(trades, fromT, toT) {
  return {
    v: TAPE_VERSION, n: trades.length, fromT, toT, truncated: false, stop: 'end_of_tape', coverageFromT: fromT,
    oldestT: trades.length ? trades[0].t : null, newestT: trades.length ? trades[trades.length - 1].t : null, pages: 1,
  };
}

// Pages a full tape the way collect.js does (newest first, fixed page size and page cap) through the
// shared tape rules, so busy markets get exactly the file and tradesInfo the collector would write.
function collectTape(trades, { conditionId, tokenIds, fromT, toT }, o) {
  const raw = trades.map((t, i) => ({ ...t, conditionId, transactionHash: `${conditionId}-${i}` })).sort((a, b) => b.t - a.t);
  const normalize = (r) => ({ t: r.t, asset: r.asset, side: r.side, size: r.size, price: r.price, wallet: r.wallet });
  const tape = createTape({ conditionId, tokenIds, fromT, toT, maxTrades: o.tapeMaxTrades, normalize });
  let stop = 'end_of_tape';
  for (let page = 0; ; page++) {
    if (page >= o.tapeMaxPages) { stop = 'max_pages'; break; }
    const rows = raw.slice(page * o.tapePageSize, (page + 1) * o.tapePageSize);
    const state = tape.addPage(rows);
    if (state !== 'more') { stop = state; break; }
    if (rows.length < o.tapePageSize) break;
  }
  return tape.finish(stop);
}

// Buyers of the token whose displayed price rose from grid hour k to k-1 trade after hour k's quote
// was stamped and no later than hour k-1, so a trade never reveals more than the newest quote
// stamped at or after it; only a stale quote can be "beaten" by reading the flow after it.
function addImpactFlow(trades, m, rng, o, ctx) {
  const { startTs, openK, tokenIds, pre, stamp, priceAt } = m;
  for (let k = Math.min(openK, o.preHours); k >= 1; k--) {
    const move = pre[0][k - 1] - pre[0][k];
    const n = Math.round(Math.abs(move) * o.impactPerMove);
    const tok = move > 0 ? 0 : 1;
    const lo = stamp[k] + 1, hi = startTs - (k - 1) * HOUR;
    for (let i = 0; i < n; i++) {
      const ts = lo + Math.floor(rng() * (hi - lo + 1));
      const notional = Math.exp(Math.log(o.impactUsd) + 0.5 * randNormal(rng));
      const price = priceAt(tok, ts);
      trades.push({ t: ts, asset: tokenIds[tok], side: 'BUY', size: r2(notional / price), price, wallet: ctx.wallets[Math.floor(rng() * ctx.wallets.length)] });
    }
  }
  trades.sort((x, y) => x.t - y.t);
}

function addLiveBurst(trades, m, rng, o, ctx) {
  const { startTs, tokenIds, priceAt } = m;
  const n = o.busyInGameMin + Math.floor(rng() * (o.busyInGameMax - o.busyInGameMin + 1));
  for (let i = 0; i < n; i++) {
    const ts = startTs + 1 + Math.floor(rng() * 2.5 * HOUR);
    const tok = rng() < 0.5 ? 0 : 1;
    trades.push({ t: ts, asset: tokenIds[tok], side: rng() < 0.6 ? 'BUY' : 'SELL', size: r2(20 / priceAt(tok, ts)), price: priceAt(tok, ts), wallet: ctx.wallets[Math.floor(rng() * ctx.wallets.length)] });
  }
  trades.sort((x, y) => x.t - y.t);
}

// Retail flow and uninformed whales in both worlds; informed wallets only in the planted world.
// Trade direction never depends on future prices or (pre-game) on the outcome, except informed flow.
function genTrades(m, trng, irng, o, ctx) {
  const { startTs, openK, winnerIndex, tokenIds, priceAt } = m;
  const trades = [];
  const windowH = Math.min(openK, 72);
  const push = (ts, tok, side, notional, wallet) => {
    const price = priceAt(tok, ts);
    trades.push({ t: ts, asset: tokenIds[tok], side, size: r2(notional / price), price, wallet });
  };
  const retailWallet = () => ctx.wallets[Math.floor(ctx.wallets.length * Math.pow(trng(), 2.5))];

  const activity = Math.exp(0.8 * randNormal(trng));
  const nRetail = poisson(trng, o.retailPerDay * activity * 1.5);
  for (let i = 0; i < nRetail; i++) {
    const x = trng() < 0.65 ? -14 * Math.log(1 - trng()) : trng() * windowH;
    const tok = trng() < 0.5 ? 0 : 1;
    const side = trng() < 0.6 ? 'BUY' : 'SELL';
    const notional = Math.exp(Math.log(40) + 1.2 * randNormal(trng));
    const wallet = retailWallet();
    if (x > windowH) continue;
    push(startTs - 1 - Math.floor(x * HOUR), tok, side, notional, wallet);
  }
  if (trng() < o.whaleProb) {
    const n = 1 + Math.floor(trng() * 3);
    const tok = trng() < 0.5 ? 0 : 1;
    const wallet = pick(trng, ctx.whales);
    for (let i = 0; i < n; i++) {
      const x = 0.25 + trng() * 35.75;
      const notional = Math.exp(Math.log(3000) + 0.6 * randNormal(trng));
      const side = trng() < 0.85 ? 'BUY' : 'SELL';
      if (x > windowH) continue;
      push(startTs - Math.floor(x * HOUR), tok, side, notional, wallet);
    }
  }
  // In-game flow toward the winner: a leakage trap (only trades before the decision may count).
  const nIn = poisson(trng, o.retailPerDay * activity * 0.5);
  for (let i = 0; i < nIn; i++) {
    const ts = startTs + Math.floor(trng() * 2.5 * HOUR);
    const tok = trng() < 0.8 ? winnerIndex : 1 - winnerIndex;
    push(ts, tok, 'BUY', Math.exp(Math.log(150) + 1.2 * randNormal(trng)), retailWallet());
  }
  const collected = trng() < o.tradeCoverage;

  let informed = null;
  if (irng && irng() < o.informedProb) {
    const target = irng() < o.informedAccuracy ? winnerIndex : 1 - winnerIndex;
    const n = 1 + Math.floor(irng() * 4);
    const wallet = pick(irng, ctx.whales);
    let firstTs = Infinity;
    for (let i = 0; i < n; i++) {
      const x = 0.5 + irng() * 29.5;
      // Steady mid-size tickets, like the uninformed whales: the signal is spread over the
      // $1k-$10k thresholds instead of hiding in a thin $30k tail the walk-forward might chase.
      const notional = Math.exp(Math.log(4000) + 0.5 * randNormal(irng));
      if (x > windowH) continue;
      const ts = startTs - Math.floor(x * HOUR);
      push(ts, target, 'BUY', notional, wallet);
      firstTs = Math.min(firstTs, ts);
    }
    if (firstTs < Infinity) informed = { target, firstTs };
  }
  trades.sort((x, y) => x.t - y.t);
  return { trades, collected, informed };
}

// ---------- driver ----------

// Writes markets.jsonl, prices/ and trades/ into dataDir and ground truth to truthFile (optional).
export function generateWorld(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!WORLDS.includes(o.world)) throw new Error(`world must be one of ${WORLDS.join(', ')}, got "${o.world}"`);
  if (!o.dataDir) throw new Error('generateWorld needs dataDir');
  if (!(Number.isInteger(o.events) && o.events > 0)) throw new Error('events must be a positive integer');
  const fromTs = Date.parse(`${o.from}T00:00:00Z`) / 1000;
  if (!Number.isFinite(fromTs)) throw new Error(`bad from date "${o.from}"`);
  const toDate = new Date(fromTs * 1000);
  toDate.setUTCMonth(toDate.getUTCMonth() + o.months);
  const toTs = toDate.getTime() / 1000;

  const dataDir = path.resolve(o.dataDir);
  fs.mkdirSync(path.join(dataDir, 'prices'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'trades'), { recursive: true });
  const wrng = makeRng(o.seed, 'wallets');
  const ctx = {
    collectedAt: toTs + 7 * DAY,
    wallets: Array.from({ length: 4000 }, () => `0x${hex(wrng, 40)}`),
    whales: Array.from({ length: 150 }, () => `0x${hex(wrng, 40)}`),
  };
  const truthFd = o.truthFile ? (fs.mkdirSync(path.dirname(path.resolve(o.truthFile)), { recursive: true }), fs.openSync(o.truthFile, 'w')) : null;

  const summary = {
    synthetic: true, world: o.world, seed: o.seed, events: o.events, dataDir, truthFile: o.truthFile ? path.resolve(o.truthFile) : null,
    range: { from: isoTime(fromTs), to: isoTime(toTs) },
    markets: 0, priceFiles: 0, tradeFiles: 0, informedMarkets: 0, busyMarkets: 0,
    bySport: {}, byClass: {}, classOf: {}, fallbackStart: [], dirty: Object.fromEntries(DIRTY.map((d) => [d, []])),
    params: Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, o[k]])),
  };
  const marketLines = [];
  const slugs = new Set();
  let counter = 0;
  let truthBuf = [];
  const flushTruth = () => { if (truthFd != null && truthBuf.length) fs.writeSync(truthFd, truthBuf.join('')); truthBuf = []; };

  try {
    for (let i = 0; i < o.events; i++) {
      const rng = makeRng(o.seed, 'event', i);
      const sportKey = pickWeighted(rng, SPORT_KEYS, (k) => SPORTS[k].weight);
      const sp = SPORTS[sportKey];
      const startTs = sampleStart(rng, sp, fromTs, toTs);
      let a, b;
      if (sp.players) {
        a = playerName(rng);
        do b = playerName(rng); while (b === a);
      } else {
        const ai = Math.floor(rng() * sp.teams.length);
        const bi = (ai + 1 + Math.floor(rng() * (sp.teams.length - 1))) % sp.teams.length;
        a = sp.teams[ai];
        b = sp.teams[bi];
      }
      let eventSlug = `${sportKey}-${slugify(a)}-${slugify(b)}-${dateStr(startTs)}`;
      for (let n = 2; slugs.has(eventSlug); n++) eventSlug = `${sportKey}-${slugify(a)}-${slugify(b)}-${dateStr(startTs)}-${n}`;
      slugs.add(eventSlug);
      const ev = {
        rng, sportKey, startTs, eventSlug,
        eventTitle: sp.esports ? `Counter-Strike: ${a} vs. ${b}` : `${a} vs. ${b}`,
        tags: sp.esports ? [sportKey, 'esports', 'games'] : [sportKey, 'sports', 'games'],
        fallback: rng() < o.eventStartFallbackProb,
        createdTs: startTs - (4 + Math.floor(rng() * 6)) * DAY,
      };
      const specs = buildSpecs(rng, sp, a, b, dateStr(startTs), o);
      for (const spec of specs) {
        const out = emitMarket(ev, spec, counter++, o, ctx);
        const { record } = out;
        marketLines.push([ev.startTs, JSON.stringify(record)]);
        for (let j = 0; j < 2; j++) {
          if (j === 1 && out.dirty === 'missing_token_prices') continue;
          fs.writeFileSync(path.join(dataDir, 'prices', `${record.tokenIds[j]}.json`), JSON.stringify({ tokenId: record.tokenIds[j], points: out.pts[j] }));
          summary.priceFiles++;
        }
        if (out.writeTrades) {
          fs.writeFileSync(path.join(dataDir, 'trades', `${record.conditionId}.jsonl`), out.trades.map((t) => JSON.stringify(t)).join('\n') + (out.trades.length ? '\n' : ''));
          summary.tradeFiles++;
        }
        truthBuf.push(JSON.stringify(out.truth) + '\n');
        if (truthBuf.length >= 500) flushTruth();
        summary.markets++;
        summary.bySport[sportKey] = (summary.bySport[sportKey] || 0) + 1;
        summary.byClass[spec.cls] = (summary.byClass[spec.cls] || 0) + 1;
        summary.classOf[record.conditionId] = spec.cls;
        if (out.truth.informedTarget != null) summary.informedMarkets++;
        if (out.busy) summary.busyMarkets++;
        if (out.dirty) summary.dirty[out.dirty].push(record.conditionId);
        else if (ev.fallback) summary.fallbackStart.push(record.conditionId);
      }
    }
    flushTruth();
  } finally {
    if (truthFd != null) fs.closeSync(truthFd);
  }
  marketLines.sort((x, y) => x[0] - y[0]);
  fs.writeFileSync(path.join(dataDir, 'markets.jsonl'), marketLines.map((x) => x[1]).join('\n') + '\n');
  // Same provenance file collect.js writes, so build-dataset/backtest flag this dir as synthetic.
  fs.appendFileSync(path.join(dataDir, 'collect-runs.jsonl'), JSON.stringify({
    at: new Date().toISOString(), tool: 'research/lib/synthetic.js',
    synthetic: `SYNTHETIC generator, ${o.world} world, seed ${o.seed}, ${o.events} events (tooling validation only)`,
    dataDir, kept: summary.markets,
  }) + '\n');
  return summary;
}

// ---------- CLI ----------

const USAGE = `Usage: node research/lib/synthetic.js --out <dataDir> [--world null|planted|stress] [--events 2500] [--seed 1]
       [--truth <file>] [--<param> <value> ...]
Writes SYNTHETIC markets.jsonl, prices/ and trades/ to <dataDir> (tooling validation only).
--truth defaults to <dataDir>.truth.jsonl, outside the data dir. Any DEFAULTS key can be overridden in
kebab-case, e.g. --longshot-bias 0.05 --informed-prob 0.3. Defaults:
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
  const s = generateWorld(o);
  const { classOf, fallbackStart, dirty, ...rest } = s;
  console.log(`SYNTHETIC ${s.world} world written (tooling validation only, not market data):`);
  console.log(JSON.stringify({ ...rest, fallbackStart: fallbackStart.length, dirty: Object.fromEntries(Object.entries(dirty).map(([k, v]) => [k, v.length])) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`synthetic: ${e.message}`); process.exitCode = 1; });
}
