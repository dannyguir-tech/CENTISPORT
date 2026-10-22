// Polymarket taker-fee models for BTC markets.
//
// What is established (2026-10-22):
//  * Every current BTC market (Up/Down 5m/15m/1h/4h/daily, "bitcoin-above-on" ladders,
//    "bitcoin-price-on" buckets, "what-price-will-bitcoin-hit" barriers) carries
//      feesEnabled: true, feeType: "crypto_fees_v2",
//      feeSchedule: { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 }
//    and CLOB /clob-markets/<conditionId> returns the same as fd: { r: 0.07, e: 1, to: true }.
//    CLOB /fee-rate?token_id=... returns only the legacy {"base_fee":1000} (not the curve).
//  * Older hourly Up/Down markets (through ~spring 2026) carry feeType "crypto_fees",
//    feeSchedule { exponent: 2, rate: 0.25 }. Markets before the fee rollout have feeType null.
//  * Polymarket docs (docs.polymarket.com/trading/fees, via web search; the site itself is not
//    reachable from this sandbox) state: fee = C x feeRate x p x (1 - p), C = shares, p = trade
//    price; crypto feeRate 0.07, makers 0, maker rebate 20% of taker fees. Third-party calculators
//    quote "$1.75 per 100 shares at 50c" for crypto, which matches exactly this formula
//    (100 x 0.07 x 0.25 = 1.75), i.e. 1.75c per share = 3.5% of notional at p = 0.50.
//  * The older docs page gave a general form fee = C x p x feeRate x (p(1-p))^exponent
//    (the "extra p" form); with rate 0.07, exp 1 that is HALF the current-docs fee at p = 0.5.
//  * EMPIRICALLY VERIFIED (2026-10-22) on real taker fills: data-api /activity rows give usdcSize
//    (cash actually paid / received) alongside size and price. For taker BUYs
//    usdcSize - size*price, and for taker SELLs size*price - usdcSize, equal
//    size * 0.07 * p * (1 - p) to ~1e-5 USDC (e.g. SELL 82.28 @ 0.59475: observed 1.38818,
//    model 1.388188; BUY 6 @ 0.68333: observed 0.09088, model 0.09088). Fee is charged in USDC
//    on top of a buy and deducted from sell proceeds. See data/fees_verified.json (stage feeverify)
//    for the stratified sample across prices.
//
// HEADLINE model = 'docs' = 0.07 * p * (1-p) per share (verified). Other models are kept only as
// sensitivity checks: 'docs_extra_p' (older docs form, under-states), 'minp' (stress, 2x at p=0.5),
// flat 1%/2% of notional (flat2 exceeds 'docs' for p > ~0.71).
//
// All functions return fee in USDC PER SHARE traded at price p (p = price of the token you
// buy or sell, 0..1). Fee for a fill of C shares = C * feePerShare(...).

export const CURRENT_SCHEDULE = { feeType: 'crypto_fees_v2', rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 };
export const HEADLINE_MODEL = 'docs';

const clamp01 = (p) => Math.min(1, Math.max(0, p));

function sched(market) {
  // market may be a collected record ({fee:{...}}) or a raw gamma market or undefined
  const f = market && (market.fee || market);
  if (!f) return { enabled: true, ...CURRENT_SCHEDULE };
  const s = f.feeSchedule || f.schedule || null;
  const enabled = f.feesEnabled ?? f.enabled ?? (s ? true : false);
  return {
    enabled: !!enabled && !!s,
    feeType: f.feeType ?? null,
    rate: s ? Number(s.rate) : 0,
    exponent: s ? Number(s.exponent) : 1,
    rebateRate: s ? Number(s.rebateRate ?? 0) : 0,
  };
}

/** Candidate models. Each: (p, market?) -> USDC fee per share. */
export const MODELS = {
  // no fee (upper bound on profitability; also correct for maker fills)
  zero: () => 0,
  // HEADLINE: current docs formula generalised with the market's exponent:
  //   rate * (p(1-p))^exponent ; for crypto_fees_v2 = 0.07 * p * (1-p)
  docs: (p, m) => {
    const s = sched(m); if (!s.enabled) return 0; p = clamp01(p);
    return s.rate * Math.pow(p * (1 - p), s.exponent);
  },
  // older docs general form: rate * p * (p(1-p))^exponent  (half of 'docs' at p=0.5 for exp=1)
  docs_extra_p: (p, m) => {
    const s = sched(m); if (!s.enabled) return 0; p = clamp01(p);
    return s.rate * p * Math.pow(p * (1 - p), s.exponent);
  },
  // stress test: rate * min(p, 1-p)
  minp: (p, m) => {
    const s = sched(m); if (!s.enabled) return 0; p = clamp01(p);
    return s.rate * Math.min(p, 1 - p);
  },
  // flat % of notional regardless of market flags (stress / sanity)
  flat1: (p) => 0.01 * clamp01(p),
  flat2: (p) => 0.02 * clamp01(p),
  // current schedule applied to every market even if the record predates fees
  docs_always: (p) => CURRENT_SCHEDULE.rate * clamp01(p) * (1 - clamp01(p)),
};

export const MODEL_NAMES = Object.keys(MODELS);

/** Taker fee per share under a model. */
export function takerFeePerShare(p, market, model = HEADLINE_MODEL) {
  const f = MODELS[model];
  if (!f) throw new Error('unknown fee model ' + model);
  return f(p, market);
}

/**
 * All-in cost per share for a TAKER buy of a token whose reference (mid/last) price is pRef:
 *   exec = min(1, pRef + spreadHaircut); cost = exec + fee(exec).
 * Payout is $1 per share if the token wins. edge per share = winProb - cost.
 */
export function takerBuyCost(pRef, market, { model = HEADLINE_MODEL, haircut = 0.01 } = {}) {
  const exec = Math.min(0.999, Math.max(0.001, pRef + haircut));
  return exec + takerFeePerShare(exec, market, model);
}

/**
 * Approximate maker rebate per share filled at p: rebateRate x (taker fee on the matched fill).
 * Real rebates are paid daily, pro-rata to a maker's share of fee-curve-weighted volume in that
 * market, so this is an optimistic approximation. Makers pay no fee.
 */
export function makerRebatePerShare(p, market) {
  const s = sched(market);
  if (!s.enabled) return 0;
  return s.rebateRate * MODELS.docs(p, market);
}

/** Fee as a fraction of notional (fee / (p * shares)). */
export function feeRateOfNotional(p, market, model = HEADLINE_MODEL) {
  return p > 0 ? takerFeePerShare(p, market, model) / p : 0;
}

/** Small table for reports: fee per share and % of notional at common prices. */
export function feeTable(models = ['docs', 'docs_extra_p', 'minp', 'flat1', 'flat2'], prices = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]) {
  return prices.map((p) => {
    const row = { p };
    for (const m of models) row[m] = +takerFeePerShare(p, undefined, m).toFixed(5);
    return row;
  });
}
