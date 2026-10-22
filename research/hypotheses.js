// Hypothesis library for backtest.js.
// select(row, params) receives only point-in-time features — backtest.js strips the labels
// (won, closePrice, clv) and lifetime volume before calling it — and returns true to buy that
// row's outcome at decisionTs with a flat $1 stake. The backtester crosses paramGrid with
// `offsets`, so every candidate trades at a single decision offset (no stacking the same bet).
// Grids stay small on purpose: each extra candidate is another chance to fit noise in training.
//
// Fields: id, name, rationale, role ('sanity' | 'control' | 'candidate'), offsets, paramGrid,
// requires (features that must be non-null for a row to be usable), trades (needs trade tape).
// Hypotheses without explicit offsets (anyOffset) use whatever offsets the dataset was built with;
// maxOffsetH limits a hypothesis to decisions at most that many hours before start.

export const ALL_OFFSETS = Object.freeze([1, 3, 12, 24]);
export const TRADE_FIELDS = Object.freeze(['nTrades24h', 'netBuyNotional24h', 'largeNetNotional24h', 'distinctWallets24h', 'topWalletShare24h']);

// typeof guard matters: `null >= 0` is true in JS, so a bare comparison would select null features.
const has = (v) => typeof v === 'number' && Number.isFinite(v);
const inBand = (r, p) => r.price >= p.lo && r.price <= p.hi;
const bands = (...pairs) => pairs.map(([lo, hi]) => ({ lo, hi }));
const cross = (as, bs) => as.flatMap((a) => bs.map((b) => ({ ...a, ...b })));

// Cartesian product of { key: [values] } -> [{ key: value, ... }]
export function grid(spec) {
  return Object.entries(spec).reduce((acc, [k, vals]) => acc.flatMap((o) => vals.map((v) => ({ ...o, [k]: v }))), [{}]);
}

function H(h) {
  return Object.freeze({
    role: 'candidate', trades: false, sport: null, baseId: h.id, maxOffsetH: null,
    ...h,
    anyOffset: h.anyOffset ?? !h.offsets,
    offsets: Object.freeze([...(h.offsets || ALL_OFFSETS)]),
    requires: Object.freeze([...(h.requires || [])]),
    paramGrid: Object.freeze(h.paramGrid.map((p) => Object.freeze({ ...p }))),
  });
}

const momGrid = (ths) => grid({ th: ths });

export const BASE_HYPOTHESES = Object.freeze([
  H({
    id: 'baseline-all', name: 'Buy every outcome', role: 'sanity',
    rationale: 'Sanity check, not an edge: buying everything should lose roughly the cost drag (spread + fee) plus any overround. A profitable baseline points to a data or leakage bug.',
    paramGrid: [{}],
    select: () => true,
  }),
  H({
    id: 'favorite-longshot', name: 'Buy favorites (fade longshots)',
    rationale: 'Favorite-longshot bias: bettors overpay for longshots, which leaves favorites underpriced. Buys outcomes priced in a high band.',
    paramGrid: bands([0.6, 0.75], [0.7, 0.85], [0.75, 0.9], [0.8, 0.95], [0.85, 0.97], [0.6, 0.97]),
    select: (r, p) => inBand(r, p),
  }),
  H({
    id: 'longshot-buy', name: 'Buy longshots (control)', role: 'control',
    rationale: 'Mirror of favorite-longshot. If longshot bias exists this loses more than the cost drag; if it wins, the favorite-longshot story is wrong for these markets.',
    paramGrid: bands([0.02, 0.1], [0.05, 0.15], [0.1, 0.25], [0.02, 0.25]),
    select: (r, p) => inBand(r, p),
  }),
  H({
    id: 'under-totals', name: 'Buy unders on game totals',
    rationale: 'Recreational money prefers overs (people root for scoring), which can leave game-total unders below fair value.',
    paramGrid: bands([0.05, 0.95], [0.35, 0.65], [0.5, 0.95]),
    select: (r, p) => r.marketType === 'total' && r.sideType === 'under' && inBand(r, p),
  }),
  H({
    id: 'under-props', name: 'Buy unders / No on player props',
    rationale: 'Player-prop overs and "Yes" are the popular side; the under or "No" may be underpriced. includeNo also buys "No" on yes/no prop questions.',
    paramGrid: cross(grid({ includeNo: [false, true] }), bands([0.05, 0.95], [0.35, 0.65])),
    select: (r, p) => r.marketType === 'prop' && (r.sideType === 'under' || (p.includeNo && r.sideType === 'no')) && inBand(r, p),
  }),
  H({
    id: 'over-control', name: 'Buy overs on totals and props (control)', role: 'control',
    rationale: 'Control for the under hypotheses. Overs should not beat the cost drag if the under story holds.',
    paramGrid: bands([0.05, 0.95], [0.35, 0.65]),
    select: (r, p) => (r.marketType === 'total' || r.marketType === 'prop') && r.sideType === 'over' && inBand(r, p),
  }),
  H({
    id: 'momentum-follow-6h', name: 'Follow 6h price moves', requires: ['mom6h'],
    rationale: 'A price that rose over the last 6h may keep rising if it reflects slowly diffusing information (injuries, lineups).',
    paramGrid: momGrid([0.02, 0.04, 0.06, 0.1]),
    select: (r, p) => has(r.mom6h) && r.mom6h >= p.th,
  }),
  H({
    id: 'momentum-fade-6h', name: 'Fade 6h price moves', requires: ['mom6h'],
    rationale: 'Opposite of follow: 6h moves may be overreactions to noise or herd flow, so buy the outcome that dropped.',
    paramGrid: momGrid([0.02, 0.04, 0.06, 0.1]),
    select: (r, p) => has(r.mom6h) && r.mom6h <= -p.th,
  }),
  H({
    id: 'momentum-follow-24h', name: 'Follow 24h price moves', requires: ['mom24h'],
    rationale: 'Slower version of momentum-follow: day-long drifts may reflect information the market has not fully priced.',
    paramGrid: momGrid([0.03, 0.05, 0.08, 0.12]),
    select: (r, p) => has(r.mom24h) && r.mom24h >= p.th,
  }),
  H({
    id: 'late-steam', name: 'Follow late steam (1-3h before start)', requires: ['mom6h'], offsets: [1, 3], maxOffsetH: 3,
    rationale: 'Sharp money tends to arrive close to start; a large 6h move right before kickoff may still be incomplete.',
    paramGrid: momGrid([0.03, 0.05, 0.08]),
    select: (r, p) => has(r.mom6h) && r.mom6h >= p.th,
  }),
  H({
    id: 'large-flow-follow', name: 'Follow large-trade net flow (24h)', trades: true, requires: ['largeNetNotional24h'],
    rationale: 'Large trades may be informed; buy the side they net-bought (USD notional) in the 24h before the decision.',
    paramGrid: grid({ th: [1000, 3000, 10000, 30000] }),
    select: (r, p) => has(r.largeNetNotional24h) && r.largeNetNotional24h >= p.th,
  }),
  H({
    id: 'large-flow-fade', name: 'Fade large-trade net flow (24h)', trades: true, requires: ['largeNetNotional24h'],
    rationale: 'If large traders are mostly overconfident whales, the side they net-sold (or whose opponent they bought) is cheap.',
    paramGrid: grid({ th: [1000, 3000, 10000, 30000] }),
    select: (r, p) => has(r.largeNetNotional24h) && r.largeNetNotional24h <= -p.th,
  }),
  H({
    id: 'wallet-surge', name: 'Many wallets + net buying (24h)', trades: true, requires: ['distinctWallets24h', 'netBuyNotional24h'],
    rationale: 'Many distinct wallets trading plus net buying toward an outcome suggests broad information arrival rather than one account moving the price.',
    paramGrid: grid({ minWallets: [10, 25, 50], minNet: [0, 500, 2000] }),
    select: (r, p) => has(r.distinctWallets24h) && has(r.netBuyNotional24h) && r.distinctWallets24h >= p.minWallets && r.netBuyNotional24h > p.minNet,
  }),
  H({
    id: 'overround-cheap-side', name: 'Buy the cheap side of a mispriced pair', requires: ['overround', 'complementPrice'],
    rationale: 'Two-way prices should sum to about 1. mode "under": this side is cheaper than 1 - complement by th (a stale quote), so buy it; when the pair is underround both sides qualify. mode "over-dog": the pair is overround by th, so buy the underdog on the theory that the favorite carries the excess.',
    paramGrid: [...grid({ mode: ['under'], th: [0.01, 0.02, 0.04] }), ...grid({ mode: ['over-dog'], th: [0.02, 0.04] })],
    select: (r, p) => has(r.overround) && has(r.complementPrice)
      && (p.mode === 'under' ? r.overround <= -p.th : r.overround >= p.th && r.price < r.complementPrice),
  }),
  H({
    id: 'cheap-favorite', name: 'Buy slight favorites (0.50-0.60)',
    rationale: 'Slight favorites are where recreational money often prefers the more exciting underdog, so they may be underpriced.',
    paramGrid: bands([0.5, 0.6], [0.5, 0.55], [0.55, 0.6]),
    select: (r, p) => inBand(r, p) && (!has(r.complementPrice) || r.price >= r.complementPrice),
  }),
]);

// Fixed before looking at any results (the best-documented biases in the betting literature).
// Choosing variants after seeing which generic hypotheses did well would leak test information
// into the hypothesis set.
export const SPORT_VARIANT_BASES = Object.freeze(['favorite-longshot', 'under-totals', 'momentum-follow-6h', 'momentum-fade-6h', 'cheap-favorite']);

export function sportVariant(base, sport) {
  return H({
    ...base,
    id: `${base.id}@${sport}`,
    name: `${base.name} [${sport}]`,
    baseId: base.id,
    sport,
    rationale: `${base.rationale} Restricted to ${sport}.`,
    select: (r, p) => r.sport === sport && base.select(r, p),
  });
}

// sports: sport keys that have enough data for their own variants (decided by the backtester).
export function buildHypotheses({ sports = [] } = {}) {
  const byId = new Map(BASE_HYPOTHESES.map((h) => [h.id, h]));
  const variants = [];
  for (const s of sports) for (const id of SPORT_VARIANT_BASES) variants.push(sportVariant(byId.get(id), s));
  return [...BASE_HYPOTHESES, ...variants];
}
