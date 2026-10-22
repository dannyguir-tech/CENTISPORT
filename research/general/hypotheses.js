// Hypothesis library for the NON-SPORTS ("general") track, for research/backtest.js:
//   node research/backtest.js --hypotheses research/general/hypotheses.js --data research/data-general/dataset.jsonl ...
// PRE-REGISTERED (fixed before any real-data result): the ids, bands, thresholds, offsets and the
// per-category variant bases below. Do not add, drop or retune them after seeing out-of-sample
// results; any other run is a labelled sensitivity analysis and never declares survival.
//
// Rows (research/general/build-dataset.js) are one per (market, side, decision): side 'yes' | 'no',
// price = that side's price, yesPrice = the Yes price, both as of the row's price point. Labels are
// stripped by backtest.js before select() sees a row. Each hypothesis has a single fixed parameter
// setting; the walk-forward chooses only the decision offset on training folds.
import { ANCHOR_OFFSETS_H, EARLY_OFFSET_H, offsetLabel } from './lib.js';

export const TRADE_FIELDS = Object.freeze([]);
export const ALL_OFFSETS = Object.freeze([...ANCHOR_OFFSETS_H]);

const has = (v) => typeof v === 'number' && Number.isFinite(v);
const between = (x, lo, hi) => has(x) && x >= lo && x <= hi;

function H(h) {
  return Object.freeze({
    role: 'candidate', trades: false, sport: null, baseId: h.id, maxOffsetH: null,
    ...h,
    anyOffset: h.anyOffset ?? false,
    offsets: Object.freeze([...(h.offsets || ANCHOR_OFFSETS_H)]),
    requires: Object.freeze([...(h.requires || [])]),
    paramGrid: Object.freeze((h.paramGrid || [{}]).map((p) => Object.freeze({ ...p }))),
  });
}

export const BASE_HYPOTHESES = Object.freeze([
  H({
    id: 'baseline-all', name: 'Buy every side at every decision', role: 'sanity', anyOffset: true, offsets: [EARLY_OFFSET_H, ...ANCHOR_OFFSETS_H],
    rationale: 'Sanity check, not an edge: buying both sides of everything must lose about the cost drag. A profitable baseline points to leakage or bad labels.',
    select: () => true,
  }),
  H({
    id: 'longshot-fade', name: 'Buy No on Yes longshots (Yes 0.02-0.15)',
    rationale: 'Favorite-longshot bias: small Yes probabilities are overpriced by optimistic/lottery demand, so No is cheap.',
    select: (r) => r.side === 'no' && between(r.yesPrice, 0.02, 0.15),
  }),
  H({
    id: 'longshot-fade-wide', name: 'Buy No when Yes is 0.15-0.35',
    rationale: 'The same bias one band higher: moderately unlikely Yes outcomes may still be overpriced.',
    select: (r) => r.side === 'no' && between(r.yesPrice, 0.15, 0.35),
  }),
  H({
    id: 'deadline-no', name: 'Buy No on "by/before <date>" markets (Yes 0.05-0.50)', requires: [],
    rationale: 'Deadline markets need the event to happen in time; traders overestimate how fast things happen, so No is underpriced as the clock runs.',
    select: (r) => r.side === 'no' && r.isDeadline === true && between(r.yesPrice, 0.05, 0.5),
  }),
  H({
    id: 'near-certain', name: 'Buy the side priced 0.90-0.98',
    rationale: 'The mirror of the longshot bias: near-certain outcomes are underpriced because capital is tied up for little return.',
    select: (r) => between(r.price, 0.9, 0.98),
  }),
  H({
    id: 'negrisk-overround-no', name: 'negRisk overround: buy No on members with Yes 0.05-0.40 when the Yes-sum >= 1.03', requires: ['groupYesSum'],
    rationale: 'Mutually exclusive outcomes whose synchronized Yes prices sum to well above 1 overprice at least some Yes; the mid-priced Yes are the usual excess.',
    select: (r) => r.side === 'no' && r.negRisk === true && has(r.groupYesSum) && r.groupYesSum >= 1.03 && between(r.yesPrice, 0.05, 0.4),
  }),
  H({
    id: 'negrisk-underround-yes', name: 'negRisk underround: buy Yes on the top member when the Yes-sum <= 0.97', requires: ['groupYesSum'],
    rationale: 'When synchronized Yes prices sum to well below 1, some Yes is underpriced; the favorite is the most likely winner.',
    select: (r) => r.side === 'yes' && r.negRisk === true && has(r.groupYesSum) && r.groupYesSum <= 0.97 && r.groupTop === true,
  }),
  H({
    id: 'momentum-follow-7d', name: 'Follow 7-day moves of >= 0.10', requires: ['mom7d'],
    rationale: 'Slow information diffusion: a side that gained 10+ points in a week keeps drifting the same way.',
    select: (r) => has(r.mom7d) && r.mom7d >= 0.1,
  }),
  H({
    id: 'momentum-fade-7d', name: 'Fade 7-day moves of >= 0.10', requires: ['mom7d'],
    rationale: 'Overreaction: a side that lost 10+ points in a week is oversold; buy it.',
    select: (r) => has(r.mom7d) && r.mom7d <= -0.1,
  }),
  H({
    id: 'early-listing-fade', name: 'At listing + 1 day, buy No when Yes is 0.10-0.40', offsets: [EARLY_OFFSET_H],
    rationale: 'New markets open with optimistic Yes prices set by thin, enthusiastic early flow.',
    select: (r) => r.side === 'no' && between(r.yesPrice, 0.1, 0.4),
  }),
  H({
    id: 'longshot-buy', name: 'Buy Yes longshots (Yes 0.02-0.15) (control)', role: 'control',
    rationale: 'Mirror of longshot-fade. If the longshot bias exists this loses more than the cost drag; if it wins, the longshot story is wrong here.',
    select: (r) => r.side === 'yes' && between(r.yesPrice, 0.02, 0.15),
  }),
]);

// Per-category variants (categories with >= 300 markets; backtest.js decides from the data). Fixed in advance.
export const SPORT_VARIANT_BASES = Object.freeze(['longshot-fade', 'deadline-no', 'near-certain']);
export const VARIANT_BASES = SPORT_VARIANT_BASES;

export function categoryVariant(base, category) {
  return H({
    ...base,
    id: `${base.id}@${category}`,
    name: `${base.name} [${category}]`,
    baseId: base.id,
    sport: category,
    rationale: `${base.rationale} Restricted to ${category}.`,
    select: (r, p) => r.category === category && base.select(r, p),
  });
}
export const sportVariant = categoryVariant;

export function buildHypotheses({ sports = [] } = {}) {
  const byId = new Map(BASE_HYPOTHESES.map((h) => [h.id, h]));
  const variants = [];
  for (const c of sports) for (const id of VARIANT_BASES) variants.push(categoryVariant(byId.get(id), c));
  return [...BASE_HYPOTHESES, ...variants];
}

// Taker fee per share = price x rate x (price x (1 - price))^exponent (market feeSchedule). Applied
// at the haircut price; markets without fees pay 0. Sensitivity only (headline: flat --fee).
export function actualFeeCost(meta, price, spread) {
  const px = price + spread;
  const rate = meta && Number.isFinite(meta.feeRate) ? meta.feeRate : 0;
  const e = meta && Number.isFinite(meta.feeExponent) ? meta.feeExponent : 1;
  const p = Math.min(1, Math.max(0, px));
  return Math.min(0.999, px * (1 + (rate > 0 ? rate * (p * (1 - p)) ** e : 0)));
}

// Settings research/backtest.js picks up from this module (backward-compatible extensions).
export const BACKTEST = Object.freeze({
  title: 'Polymarket non-sports edge backtest',
  groupLabel: 'category',
  anchorLabel: 'scheduled end (market endDate)',
  // Events are ordered into folds by their first decision, training rows must have SETTLED
  // (closedTime) at least --embargo-h before the test fold's first decision at the hypothesis's
  // own offsets. 30-day horizons make start-based embargoes meaningless here.
  foldBy: 'decision',
  embargoFrom: 'settle',
  cutoffScope: 'offsets',
  // Not features: fee schedules are as of collection, not decision time. Stripped from rows before
  // select() and used only for the actual-fee sensitivity.
  metaFields: ['feeRate', 'feeExponent', 'feeType'],
  altCosts: [{ id: 'actual-fees', label: 'actual taker fees (market feeSchedule) instead of the flat fee, same spread', cost: actualFeeCost }],
  offsetLabel,
});
