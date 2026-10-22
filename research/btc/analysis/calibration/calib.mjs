// Pricing-bias / calibration study for Polymarket BTC Up/Down markets (5m, 15m, 1h, 4h, 1d).
//
//   node /home/user/CENTISPORT/research/btc/analysis/calibration/calib.mjs
//
// Outputs (reports/calibration/):
//   calib_<tf>.csv          Up-price bucket -> Up win rate, per decision time (signal = snapshot price, no look-ahead)
//   calib_folded_<tf>.csv   token-price bucket -> token win rate (Up and Down legs pooled; favourite/longshot view)
//   tests.json              logistic slope/intercept (favourite-longshot), Up/Down skew, late-window reaction,
//                           Chainlink under-reaction, streak tests, with day-clustered CIs
//   variants.csv            every rule variant: in-sample + OOS metrics (headline costs), p, BH q-value
//   results.json            everything above plus cost sensitivities, tape validation, capacity
//   summary.txt             console summary
import fs from 'node:fs';
import path from 'node:path';
import { fees, WINDOW_SEC } from '../../lib/load.mjs';
import { buildObs, FRACS, chainlinkMarks, tapeTools, LAG } from './obs.mjs';
import { clusterMeanTest, bootstrapDays, benjaminiHochberg, wilson, logisticFit, logit, sigmoid, r4, r2, mean, poissonBinomialTails } from './stats.mjs';

const OUT = '/home/user/CENTISPORT/research/btc/reports/calibration';
fs.mkdirSync(OUT, { recursive: true });
const TFS = ['5m', '15m', '1h', '4h', '1d'];
const FAST = process.argv.includes('--fast');
const BOOT = FAST ? 200 : 1000;
const BOOT_LOGIT = FAST ? 60 : 300;
const MIN_N = 20, MIN_DAYS = 5;            // minimum OOS trades / days for a variant to count as tested
const HAIRCUT = 0.01;                      // headline spread haircut over the reference price (taker)
const HEAD = { fee: 'docs_always', exec: 'interp', haircut: HAIRCUT };
const STAKE_CAP = { '5m': 300, '15m': 300, '1h': 250, '4h': 125, '1d': 250 }; // $ per trade within ~1c of the ask (live books)
const MAKER_DELTA = 0.01, MAKER_THROUGH = 0.01;
const SENS = [
  { name: 'head(docs_always,interp,h1c)', fee: 'docs_always', exec: 'interp', haircut: 0.01 },
  { name: 'fee0', fee: 'zero', exec: 'interp', haircut: 0.01 },
  { name: 'docs_perRecord', fee: 'docs', exec: 'interp', haircut: 0.01 },
  { name: 'minp', fee: 'minp', exec: 'interp', haircut: 0.01 },
  { name: 'flat2', fee: 'flat2', exec: 'interp', haircut: 0.01 },
  { name: 'haircut2c', fee: 'docs_always', exec: 'interp', haircut: 0.02 },
  { name: 'haircut0.5c(empirical half-spread)', fee: 'docs_always', exec: 'interp', haircut: 0.005 },
  { name: 'haircut0.2c(tick-level, extremes only)', fee: 'docs_always', exec: 'interp', haircut: 0.002 },
  { name: 'exec_snap(optimistic)', fee: 'docs_always', exec: 'snap', haircut: 0.01 },
  { name: 'exec_next(pessimistic)', fee: 'docs_always', exec: 'next', haircut: 0.01 },
  { name: 'zeroFee_zeroHaircut_snap', fee: 'zero', exec: 'snap', haircut: 0 },
];
const lines = [];
const say = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

// ---------------- cost model ----------------
function takerCost(ref, feeRec, cfg) {
  const exec = Math.min(0.999, Math.max(0.001, ref + cfg.haircut));
  return exec + fees.takerFeePerShare(exec, feeRec, cfg.fee);
}
const refOf = (d, tok, mode) => { const p = mode === 'snap' ? d.pSnap : mode === 'next' ? d.pNext : d.pInterp; return tok === 'U' ? p : 1 - p; };

/** A taker leg: buy token `tok` of obs o at decision d. */
function takerLeg(o, d, tok, extra = {}) {
  return { kind: 'taker', day: o.day, o, d, tok, q: tok === 'U' ? d.pSnap : 1 - d.pSnap, win: tok === 'U' ? o.upWon : 1 - o.upWon, ...extra };
}
/** A maker leg: bid for `tok` at L = q - delta placed at t_k; filled if a later in-window snapshot of the token <= L - through. */
function makerLeg(o, d, tok, extra = {}) {
  const q = tok === 'U' ? d.pSnap : 1 - d.pSnap; const L = Math.round((q - MAKER_DELTA) * 1000) / 1000;
  if (L < 0.01) return null;
  const minTok = tok === 'U' ? d.minAfter : (d.maxAfter == null ? null : 1 - d.maxAfter);
  const filled = minTok != null && minTok <= L - MAKER_THROUGH;
  return { kind: 'maker', day: o.day, o, d, tok, q, L, filled, win: tok === 'U' ? o.upWon : 1 - o.upWon, ...extra };
}
/** Per-$1 flat-stake PnL and cost of a leg under a cost config (null = no trade, e.g. unfilled maker). */
function legPnl(leg, cfg) {
  if (leg.kind === 'maker') {
    if (!leg.filled) return null;
    const rebate = cfg.rebate ? fees.makerRebatePerShare(leg.L, leg.o.fee) : 0;
    const c = leg.L; return { cost: c, y: (leg.win + rebate) / c - 1, win: leg.win };
  }
  const c = takerCost(refOf(leg.d, leg.tok, cfg.exec), leg.o.fee, cfg);
  return { cost: c, y: leg.win / c - 1, win: leg.win };
}

function metrics(legs, cfg = HEAD, { boot = true, seed = 7 } = {}) {
  const tr = []; for (const l of legs) { const r = legPnl(l, cfg); if (r) tr.push({ day: l.day, ...r }); }
  const n = tr.length; if (!n) return { n: 0 };
  const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y);
  const winRate = mean(tr.map((x) => x.win)), avgCost = mean(tr.map((x) => x.cost));
  const wins = tr.reduce((s, x) => s + x.win, 0);
  // p-value: the larger of (a) day-clustered t-test on per-$ PnL (one-sided) and (b) exact Poisson-binomial test of the win
  // count against break-even probabilities p_i = all-in cost_i (valid at extreme prices where (a) degenerates, e.g. 47/47 wins).
  const pb = poissonBinomialTails(tr.map((x) => Math.min(x.cost, 1)), wins).upper;
  const zb = tr.reduce((s, x) => s + x.win - x.cost, 0) / Math.sqrt(Math.max(1e-12, tr.reduce((s, x) => s + Math.min(x.cost, 1) * (1 - Math.min(x.cost, 1)), 0)));
  const out = { n, days: ct.days, winRate: r4(winRate), avgCost: r4(avgCost), edge: r4(winRate - avgCost), roi: r4(ct.mean), se: r4(ct.se), t: r2(ct.t), zBinom: r2(zb), tSel: Math.min(ct.t, zb), pCluster: ct.pOne, pBinom: pb, p: Math.max(ct.pOne, pb) };
  const [wl, wh] = wilson(wins, n);
  // binomial interval on the win rate (Wilson; conservative for heterogeneous p_i) -> edge per share; ROI via edge/avgCost
  out.edgeCI_binom = [r4(wl - avgCost), r4(wh - avgCost)]; out.roiCI_binom = [r4((wl - avgCost) / avgCost), r4((wh - avgCost) / avgCost)];
  if (boot && ct.days >= 2) {
    const agg = new Map(); for (const x of tr) { const a = agg.get(x.day) || { sy: 0, n: 0, sw: 0, sc: 0 }; a.sy += x.y; a.n++; a.sw += x.win; a.sc += x.cost; agg.set(x.day, a); }
    const A = [...agg.values()];
    const ci = bootstrapDays(A, (s) => { let sy = 0, nn = 0; for (const a of s) { sy += a.sy; nn += a.n; } return sy / nn; }, { reps: BOOT, seed });
    const ciE = bootstrapDays(A, (s) => { let sw = 0, sc = 0, nn = 0; for (const a of s) { sw += a.sw; sc += a.sc; nn += a.n; } return (sw - sc) / nn; }, { reps: BOOT, seed: seed + 1 });
    out.roiCI_boot = ci.map(r4); out.edgeCI_boot = ciE.map(r4);
    // reported CI = union of the day-bootstrap and the binomial (Wilson) interval: conservative at extreme win rates
    out.roiCI = [Math.min(out.roiCI_boot[0], out.roiCI_binom[0]), Math.max(out.roiCI_boot[1], out.roiCI_binom[1])];
    out.edgeCI = [Math.min(out.edgeCI_boot[0], out.edgeCI_binom[0]), Math.max(out.edgeCI_boot[1], out.edgeCI_binom[1])];
  }
  return out;
}

// ---------------- walk-forward folds ----------------
function folds(days) {
  const D = days.length; const n0 = Math.ceil(0.4 * D); const fs_ = Math.max(5, Math.round(0.1 * D));
  const out = []; for (let s = n0; s < D; s += fs_) out.push({ trainDays: new Set(days.slice(0, s)), testDays: new Set(days.slice(s, Math.min(D, s + fs_))), testFrom: days[s] });
  return { folds: out, isDays: new Set(days.slice(0, n0)), oosDays: new Set(days.slice(n0)), oosFrom: days[n0] };
}

// ---------------- band selection (walk-forward) ----------------
const EDGES = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98, 1.0001];
const binOf = (q) => { for (let i = EDGES.length - 2; i >= 0; i--) if (q >= EDGES[i]) return i; return 0; };
function bestBand(trainLegs, cfg, { straddleOK }) {
  const nb = EDGES.length - 1; const dayIdx = new Map(); const rows = [];
  for (const l of trainLegs) { const r = legPnl(l, cfg); if (!r) continue; if (!dayIdx.has(l.day)) dayIdx.set(l.day, dayIdx.size); const c = Math.min(r.cost, 1); rows.push([dayIdx.get(l.day), binOf(l.q), r.y, r.win - r.cost, c * (1 - c)]); }
  const D = dayIdx.size; if (D < 5) return null;
  const S = Array.from({ length: D }, () => new Float64Array(nb + 1)), C = Array.from({ length: D }, () => new Float64Array(nb + 1));
  const EW = new Float64Array(nb + 1), VW = new Float64Array(nb + 1);
  for (const [d, b, y, e, v] of rows) { S[d][b + 1] += y; C[d][b + 1] += 1; EW[b + 1] += e; VW[b + 1] += v; }
  for (let b = 1; b <= nb; b++) { EW[b] += EW[b - 1]; VW[b] += VW[b - 1]; }
  for (let d = 0; d < D; d++) for (let b = 1; b <= nb; b++) { S[d][b] += S[d][b - 1]; C[d][b] += C[d][b - 1]; }
  let best = null;
  for (let i = 1; i < nb - 1; i++) for (let j = i + 1; j <= nb - 1; j++) { // exclude the outer [0,.02) and [.98,1] bins
    if (!straddleOK && EDGES[i] < 0.5 && EDGES[j] > 0.5) continue;
    let n = 0, sy = 0, used = 0; const ds = new Float64Array(D), dc = new Float64Array(D);
    for (let d = 0; d < D; d++) { ds[d] = S[d][j] - S[d][i]; dc[d] = C[d][j] - C[d][i]; n += dc[d]; sy += ds[d]; if (dc[d]) used++; }
    if (n < 40 || used < 10) continue;
    const mu = sy / n; let ss = 0; for (let d = 0; d < D; d++) if (dc[d]) ss += (ds[d] - mu * dc[d]) ** 2;
    const se = Math.sqrt(ss * used / (used - 1)) / n; const tc = se > 0 ? mu / se : 0;
    // selection statistic = min(day-clustered t, binomial z vs break-even); the binomial z stops all-win bands (zero variance) from looking infinitely good
    const zb = (EW[j] - EW[i]) / Math.sqrt(Math.max(1e-12, VW[j] - VW[i])); const t = Math.min(tc, zb);
    if (!best || t > best.t) best = { lo: EDGES[i], hi: EDGES[j], n, roi: mu, t };
  }
  return best;
}

// ---------------- variant registry ----------------
const variants = [];
function addVariant(v) { variants.push(v); return v; }

// ---------------- main ----------------
const results = { generatedAt: new Date().toISOString(), config: { HEAD, LAG, MAKER_DELTA, MAKER_THROUGH, MIN_N, MIN_DAYS, STAKE_CAP, BOOT, FRACS }, perTf: {} };
const calibBinsTests = []; // descriptive bin tests for BH (separate family)

for (const tf of TFS) {
  const t0 = Date.now();
  const obs = buildObs(tf);
  const days = [...new Set(obs.map((o) => o.day))].sort();
  const F = folds(days);
  const R = (results.perTf[tf] = { nMarkets: obs.length, days: days.length, firstDay: days[0], lastDay: days.at(-1), oosFrom: F.oosFrom, nFolds: F.folds.length, upRate: null, tests: {}, calibration: {}, foldedCalibration: {} });
  const upK = obs.reduce((s, o) => s + o.upWon, 0); R.upRate = { k: upK, n: obs.length, rate: r4(upK / obs.length), wilson: wilson(upK, obs.length).map(r4) };
  say(`\n=== ${tf}: ${obs.length} markets, ${days.length} days (${days[0]}..${days.at(-1)}), OOS from ${F.oosFrom} (${F.oosDays.size} days, ${F.folds.length} folds); Up rate ${R.upRate.rate}`);

  // ---------- calibration tables ----------
  const csv = ['tf,decision,bin_lo,bin_hi,n,mean_pUp,up_rate,wilson_lo,wilson_hi,boot_lo,boot_hi,resid,p_two_cluster'];
  const csvF = ['tf,decision,bin_lo,bin_hi,n_legs,mean_token_price,token_win_rate,wilson_lo,wilson_hi,boot_lo,boot_hi,resid,p_two_cluster'];
  for (const fr of FRACS) {
    const rows = obs.filter((o) => o.d[fr.key]).map((o) => ({ day: o.day, p: o.d[fr.key].pSnap, y: o.upWon }));
    const tab = [], tabF = [];
    for (let b = 0; b < EDGES.length - 1; b++) {
      for (const folded of [false, true]) {
        let sel;
        if (!folded) sel = rows.filter((r) => r.p >= EDGES[b] && r.p < EDGES[b + 1]);
        else { sel = []; for (const r of rows) { if (r.p >= EDGES[b] && r.p < EDGES[b + 1]) sel.push({ day: r.day, p: r.p, y: r.y }); const q = 1 - r.p; if (q >= EDGES[b] && q < EDGES[b + 1]) sel.push({ day: r.day, p: q, y: 1 - r.y }); } }
        if (!sel.length) continue;
        const n = sel.length, k = sel.reduce((s, r) => s + r.y, 0), mp = mean(sel.map((r) => r.p));
        const ct = clusterMeanTest(sel, (r) => r.day, (r) => r.y - r.p);
        const agg = new Map(); for (const r of sel) { const a = agg.get(r.day) || { y: 0, n: 0 }; a.y += r.y; a.n++; agg.set(r.day, a); }
        const bci = n >= 10 ? bootstrapDays([...agg.values()], (s) => { let y = 0, nn = 0; for (const a of s) { y += a.y; nn += a.n; } return y / nn; }, { reps: BOOT, seed: b + 1 }) : [null, null];
        const pbt = poissonBinomialTails(sel.map((r) => r.p), k); const pPB = Math.min(1, 2 * Math.min(pbt.upper, pbt.lower));
        const pTwo = n >= 30 && ct.days >= 5 ? Math.max(ct.pTwo, pPB) : (n >= 10 ? pPB : null);
        const row = { lo: EDGES[b], hi: Math.min(1, EDGES[b + 1]), n, meanP: r4(mp), winRate: r4(k / n), wilson: wilson(k, n).map(r4), boot: bci.map(r4), resid: r4(k / n - mp), pCluster: n >= 30 && ct.days >= 5 ? ct.pTwo : null, pPoissonBinom: pPB, pTwo };
        (folded ? tabF : tab).push(row);
        (folded ? csvF : csv).push([tf, fr.key, row.lo, row.hi, n, row.meanP, row.winRate, ...row.wilson, ...row.boot, row.resid, row.pTwo == null ? '' : row.pTwo.toExponential(3)].join(','));
        if (folded && row.pTwo != null && n >= 30 && row.lo >= 0.5 - 1e-9) calibBinsTests.push({ tf, dk: fr.key, lo: row.lo, hi: row.hi, n, resid: row.resid, p: row.pTwo }); // folded table is symmetric: test favourite half only
      }
    }
    R.calibration[fr.key] = tab; R.foldedCalibration[fr.key] = tabF;
  }
  fs.writeFileSync(path.join(OUT, `calib_${tf}.csv`), csv.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, `calib_folded_${tf}.csv`), csvF.join('\n') + '\n');

  // ---------- favourite/longshot (logistic slope) + Up/Down skew ----------
  for (const fr of FRACS) {
    const rowsAll = obs.filter((o) => o.d[fr.key]); if (rowsAll.length < 50) continue;
    // favourite/longshot slope is fitted on tradable prices only (0.02 <= p <= 0.98): clipping 0.5c/99.5c prices to a logit cap
    // would itself bias the slope upward. Skew (mean residual) uses all rows.
    const rows = rowsAll.filter((o) => o.d[fr.key].pSnap >= 0.02 && o.d[fr.key].pSnap <= 0.98); if (rows.length < 50) continue;
    const X = rows.map((o) => [logit(o.d[fr.key].pSnap)]), Y = rows.map((o) => o.upWon);
    const beta = logisticFit(X, Y);
    const byD = new Map(); rows.forEach((o, i) => { if (!byD.has(o.day)) byD.set(o.day, []); byD.get(o.day).push(i); });
    const groups = [...byD.values()];
    const bs = []; let seed = 99;
    for (let rep = 0; rep < BOOT_LOGIT; rep++) {
      const rnd = mulberry(seed++); const xs = [], ys = [];
      for (let g = 0; g < groups.length; g++) for (const i of groups[(rnd() * groups.length) | 0]) { xs.push(X[i]); ys.push(Y[i]); }
      const b = logisticFit(xs, ys, { iters: 12 }); if (b) bs.push(b);
    }
    const ciA = [quant(bs.map((b) => b[0]), 0.025), quant(bs.map((b) => b[0]), 0.975)], ciB = [quant(bs.map((b) => b[1]), 0.025), quant(bs.map((b) => b[1]), 0.975)];
    const sk = clusterMeanTest(rowsAll, (o) => o.day, (o) => o.upWon - o.d[fr.key].pSnap);
    const sdP = Math.sqrt(mean(rowsAll.map((o) => (o.d[fr.key].pSnap - 0.5) ** 2)));
    const betaAll = logisticFit(rowsAll.map((o) => [logit(o.d[fr.key].pSnap, 0.001)]), rowsAll.map((o) => o.upWon));
    R.tests[`flb_skew_${fr.key}`] = {
      n: rowsAll.length, nSlopeFit: rows.length, slopeAllPricesEps001: r4(betaAll[1]), priceDispersion: r4(sdP), logitIntercept: r4(beta[0]), interceptCI: ciA.map(r4), logitSlope: r4(beta[1]), slopeCI: ciB.map(r4),
      slopeInterp: beta[1] > 1 ? 'slope>1: outcomes more extreme than prices (favourites underpriced / longshots overpriced)' : 'slope<1: prices more extreme than outcomes (favourites overpriced)',
      meanResidUpMinusPrice: r4(sk.mean), residSE: r4(sk.se), residPtwo: sk.pTwo,
    };
    say(`  ${tf} ${fr.key.padEnd(4)} n=${rowsAll.length} (slope fit n=${rows.length}; all-price slope ${r4(betaAll[1])}) sd(p-.5)=${r4(sdP)} logit slope ${r4(beta[1])} [${ciB.map(r4)}] intercept ${r4(beta[0])} [${ciA.map(r4)}]  mean(upWon-p)=${r4(sk.mean)} (p2=${sk.pTwo.toFixed(3)})`);
  }

  // ---------- late-window reaction (logit regression with price-change term) ----------
  const PAIRS = [['s0', 'f50'], ['f50', 'f75'], ['f75', 'f90']];
  for (const [e, l] of PAIRS) {
    const rows = obs.filter((o) => o.d[e] && o.d[l]); if (rows.length < 50) continue;
    const X = rows.map((o) => { const a = logit(o.d[l].pSnap), b = logit(o.d[e].pSnap); return [a, a - b]; }), Y = rows.map((o) => o.upWon);
    const beta = logisticFit(X, Y);
    const byD = new Map(); rows.forEach((o, i) => { if (!byD.has(o.day)) byD.set(o.day, []); byD.get(o.day).push(i); });
    const groups = [...byD.values()]; const bs = []; let seed = 555;
    for (let rep = 0; rep < BOOT_LOGIT; rep++) { const rnd = mulberry(seed++); const xs = [], ys = []; for (let g = 0; g < groups.length; g++) for (const i of groups[(rnd() * groups.length) | 0]) { xs.push(X[i]); ys.push(Y[i]); } const b = logisticFit(xs, ys, { iters: 12 }); if (b) bs.push(b); }
    const ciC = [quant(bs.map((b) => b[2]), 0.025), quant(bs.map((b) => b[2]), 0.975)];
    R.tests[`reaction_${e}_${l}`] = { n: rows.length, slopeLate: r4(beta[1]), changeCoef: r4(beta[2]), changeCoefCI: ciC.map(r4), interp: 'changeCoef>0: under-reaction (moves continue beyond the price); <0: over-reaction (moves partly revert)' };
    say(`  ${tf} reaction ${e}->${l}: n=${rows.length} coef(late logit)=${r4(beta[1])} coef(change)=${r4(beta[2])} CI [${ciC.map(r4)}]`);
  }

  // ---------- streak test ----------
  {
    const a = obs.filter((o) => o.prev1 === 1), b = obs.filter((o) => o.prev1 === 0);
    const ka = a.reduce((s, o) => s + o.upWon, 0), kb = b.reduce((s, o) => s + o.upWon, 0);
    const same = obs.filter((o) => o.prev1 != null).map((o) => ({ day: o.day, y: (o.upWon === o.prev1 ? 1 : 0) - 0.5 }));
    const ct = clusterMeanTest(same, (x) => x.day, (x) => x.y);
    R.tests.streak = { pUpAfterUp: r4(ka / a.length), nAfterUp: a.length, ciAfterUp: wilson(ka, a.length).map(r4), pUpAfterDown: r4(kb / b.length), nAfterDown: b.length, ciAfterDown: wilson(kb, b.length).map(r4), pSameAsPrev: r4(0.5 + ct.mean), pTwo: ct.pTwo };
    say(`  ${tf} streak: P(Up|prevUp)=${R.tests.streak.pUpAfterUp} (n=${a.length}) P(Up|prevDown)=${R.tests.streak.pUpAfterDown} (n=${b.length}) P(same)=${R.tests.streak.pSameAsPrev} p2=${ct.pTwo.toFixed(3)}`);
  }

  // ---------- rule variants ----------
  const inOOS = (l) => F.oosDays.has(l.day), inIS = (l) => F.isDays.has(l.day);
  const BANDS = [[0.02, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 0.98], [0.98, 0.999]];
  const legsFor = (dk, side, mk = takerLeg) => {
    const out = [];
    for (const o of obs) { const d = o.d[dk]; if (!d) continue; for (const tok of side === 'tok' ? ['U', 'D'] : side === 'up' ? ['U'] : ['D']) { const l = mk(o, d, tok); if (l) out.push(l); } }
    return out;
  };
  const fixed = (meta, legs) => addVariant({ ...meta, tf, kind: 'fixed', isLegs: legs.filter(inIS), oosLegs: legs.filter(inOOS) });
  const wf = (meta, oosLegs, foldInfo) => addVariant({ ...meta, tf, kind: 'walk-forward', isLegs: [], oosLegs, foldInfo });

  for (const fr of FRACS) {
    const dk = fr.key;
    for (const side of ['tok', 'up', 'down']) {
      const legs = legsFor(dk, side);
      // F1 fixed bands (taker)
      for (const [lo, hi] of BANDS) fixed({ family: 'F1_band_taker', dk, side, params: { lo, hi }, rule: `${tf} @${dk}: buy ${side === 'tok' ? 'the token (Up or Down)' : side === 'up' ? 'Up' : 'Down'} if its snapshot price in [${lo},${hi}) - taker` }, legs.filter((l) => l.q >= lo && l.q < hi));
      // F3 walk-forward band (taker)
      const oos = [], fi = [];
      for (const fo of F.folds) {
        const best = bestBand(legs.filter((l) => fo.trainDays.has(l.day)), HEAD, { straddleOK: side !== 'tok' });
        const use = best && best.t >= 1.5 && best.roi > 0;
        fi.push({ testFrom: fo.testFrom, chosen: best ? { lo: best.lo, hi: best.hi, trainN: best.n, trainRoi: r4(best.roi), trainT: r2(best.t) } : null, traded: !!use });
        if (use) for (const l of legs) if (fo.testDays.has(l.day) && l.q >= best.lo && l.q < best.hi) oos.push(l);
      }
      wf({ family: 'F3_wf_band_taker', dk, side, params: { select: 'max train cluster-t over contiguous bands, trade if t>=1.5' }, rule: `${tf} @${dk}: buy ${side} in the band chosen on earlier days (walk-forward) - taker` }, oos, fi);
      if (side === 'tok') {
        // F2 fixed bands (maker) and F5 walk-forward maker band
        const mlegs = legsFor(dk, 'tok', makerLeg);
        for (const [lo, hi] of BANDS) fixed({ family: 'F2_band_maker', dk, side, params: { lo, hi, delta: MAKER_DELTA }, rule: `${tf} @${dk}: rest a bid ${MAKER_DELTA * 100}c under the token's snapshot price when that price is in [${lo},${hi}) - maker (filled only if a later in-window snapshot trades ${MAKER_THROUGH * 100}c through)` }, mlegs.filter((l) => l.q >= lo && l.q < hi));
        const moos = [], mfi = [];
        for (const fo of F.folds) {
          const best = bestBand(mlegs.filter((l) => fo.trainDays.has(l.day)), HEAD, { straddleOK: false });
          const use = best && best.t >= 1.5 && best.roi > 0;
          mfi.push({ testFrom: fo.testFrom, chosen: best ? { lo: best.lo, hi: best.hi, trainN: best.n, trainRoi: r4(best.roi), trainT: r2(best.t) } : null, traded: !!use });
          if (use) for (const l of mlegs) if (fo.testDays.has(l.day) && l.q >= best.lo && l.q < best.hi) moos.push(l);
        }
        wf({ family: 'F5_wf_band_maker', dk, side: 'tok', params: { delta: MAKER_DELTA }, rule: `${tf} @${dk}: maker bid in walk-forward-chosen band` }, moos, mfi);
      }
    }
    // F7 always-buy skew rules
    for (const side of ['up', 'down']) fixed({ family: 'F7_always_side', dk, side, params: {}, rule: `${tf} @${dk}: always buy ${side} (price in [0.02,0.98)) - taker` }, legsFor(dk, side).filter((l) => l.q >= 0.02 && l.q < 0.98));
    // F4 walk-forward logistic calibration model
    {
      const rows = obs.filter((o) => o.d[dk]); const oos = [], fi = [];
      for (const fo of F.folds) {
        const tr = rows.filter((o) => fo.trainDays.has(o.day)); if (tr.length < 100) { fi.push({ testFrom: fo.testFrom, beta: null }); continue; }
        const beta = logisticFit(tr.map((o) => [logit(o.d[dk].pSnap)]), tr.map((o) => o.upWon));
        fi.push({ testFrom: fo.testFrom, beta: beta.map(r4) });
        for (const o of rows) {
          if (!fo.testDays.has(o.day)) continue; const d = o.d[dk]; const pi = sigmoid(beta[0] + beta[1] * logit(d.pSnap));
          // decide on SNAPSHOT-based cost (what is known at t_k): snapshot ref + haircut + fee
          const cU = takerCost(d.pSnap, o.fee, HEAD), cD = takerCost(1 - d.pSnap, o.fee, HEAD);
          if (pi - cU >= 0.01 && d.pSnap >= 0.02 && d.pSnap < 0.98) oos.push(takerLeg(o, d, 'U'));
          else if (1 - pi - cD >= 0.01 && d.pSnap > 0.02 && d.pSnap <= 0.98) oos.push(takerLeg(o, d, 'D'));
        }
      }
      wf({ family: 'F4_wf_logit_model', dk, side: 'model', params: { margin: 0.01 }, rule: `${tf} @${dk}: fit logit(P(Up)) = a + b*logit(p) on earlier days; buy the side whose model prob exceeds all-in cost by >=1c - taker` }, oos, fi);
    }
  }
  // F6 reaction rules (momentum / fade)
  const THR = [0.05, 0.1, 0.15, 0.2, 0.3];
  for (const [e, l] of PAIRS) {
    const base = obs.filter((o) => o.d[e] && o.d[l]).map((o) => ({ o, delta: o.d[l].pSnap - o.d[e].pSnap }));
    for (const dir of ['mom', 'fade']) {
      const legsThr = (thr) => base.filter((b) => Math.abs(b.delta) >= thr).map((b) => { const upSide = (b.delta > 0) === (dir === 'mom'); return takerLeg(b.o, b.o.d[l], upSide ? 'U' : 'D'); }).filter((x) => x.q >= 0.02 && x.q < 0.98);
      const byThr = new Map(THR.map((t) => [t, legsThr(t)]));
      for (const thr of THR) fixed({ family: 'F6_reaction_taker', dk: l, side: dir, params: { from: e, to: l, thr }, rule: `${tf}: if pUp moved >= ${thr} between ${e} and ${l}, buy the side it moved ${dir === 'mom' ? 'toward' : 'away from'} at ${l} - taker` }, byThr.get(thr));
      const oos = [], fi = [];
      for (const fo of F.folds) {
        let best = null;
        for (const thr of THR) {
          const tr = byThr.get(thr).filter((x) => fo.trainDays.has(x.day)); const m = metrics(tr, HEAD, { boot: false });
          if (m.n >= 40 && m.days >= 10 && (!best || m.tSel > best.t)) best = { thr, t: m.tSel, roi: m.roi, n: m.n };
        }
        const use = best && best.t >= 1.5 && best.roi > 0; fi.push({ testFrom: fo.testFrom, chosen: best, traded: !!use });
        if (use) for (const x of byThr.get(best.thr)) if (fo.testDays.has(x.day)) oos.push(x);
      }
      wf({ family: 'F6_wf_reaction_taker', dk: l, side: dir, params: { from: e, to: l }, rule: `${tf}: ${dir} rule ${e}->${l} with walk-forward threshold - taker` }, oos, fi);
    }
  }
  // F9 streak rules at window start
  for (const [name, key, same] of [['mom1', 'prev1', true], ['rev1', 'prev1', false], ['mom3', 'prev3same', true], ['rev3', 'prev3same', false]]) {
    const legs = obs.filter((o) => o[key] != null && o.d.s0).map((o) => takerLeg(o, o.d.s0, (o[key] === 1) === same ? 'U' : 'D')).filter((x) => x.q >= 0.02 && x.q < 0.98);
    fixed({ family: 'F9_streak_taker', dk: 's0', side: name, params: {}, rule: `${tf} @s0: buy ${same ? 'the same direction as' : 'against'} the previous ${key === 'prev1' ? 'window' : '3 windows (all same)'} - taker` }, legs);
    const mlegs = obs.filter((o) => o[key] != null && o.d.s0).map((o) => makerLeg(o, o.d.s0, (o[key] === 1) === same ? 'U' : 'D')).filter((x) => x && x.q >= 0.02 && x.q < 0.98);
    fixed({ family: 'F9_streak_maker', dk: 's0', side: name, params: { delta: MAKER_DELTA }, rule: `${tf} @s0: rest a bid ${MAKER_DELTA * 100}c under the snapshot for the side ${same ? 'matching' : 'opposite to'} the previous ${key === 'prev1' ? 'window' : '3 windows'} - maker` }, mlegs);
  }
  R.timing = { secs: (Date.now() - t0) / 1000 };
}

// ---------- F8 Chainlink under-reaction (15m/1h/4h/1d, from 2026-09-07) ----------
results.chainlink = {};
const MARKS = { '15m': { m33: 1 / 3, m67: 2 / 3 }, '1h': { f25: 0.25, f50: 0.5, f75: 0.75, f92: 11 / 12 }, '4h': { f25: 0.25, f50: 0.5, f75: 0.75, f90: 0.9 }, '1d': { f25: 0.25, f50: 0.5, f75: 0.75, f90: 0.9 } };
for (const tf of ['15m', '1h', '4h', '1d']) {
  const cm = chainlinkMarks(tf, MARKS[tf]); const days = [...new Set(cm.map((o) => o.day))].sort(); const F = folds(days);
  const RC = (results.chainlink[tf] = { nWindows: cm.length, days: days.length, oosFrom: F.oosFrom, ptbMatch: cm.filter((o) => o.ptbMatch === true).length, ptbMismatch: cm.filter((o) => o.ptbMatch === false).length, marks: {} });
  for (const mk of Object.keys(MARKS[tf])) {
    const rows = cm.filter((o) => o.m[mk]); if (rows.length < 30) continue;
    const feat = (o) => [logit(o.m[mk].pSnap), logit(normCdf2(o.m[mk].x))];
    const X = rows.map(feat), Y = rows.map((o) => o.upWon); const beta = logisticFit(X, Y);
    const byD = new Map(); rows.forEach((o, i) => { if (!byD.has(o.day)) byD.set(o.day, []); byD.get(o.day).push(i); });
    const groups = [...byD.values()]; const bs = []; let seed = 777;
    for (let rep = 0; rep < BOOT_LOGIT; rep++) { const rnd = mulberry(seed++); const xs = [], ys = []; for (let g = 0; g < groups.length; g++) for (const i of groups[(rnd() * groups.length) | 0]) { xs.push(X[i]); ys.push(Y[i]); } const b = logisticFit(xs, ys, { iters: 12 }); if (b) bs.push(b); }
    const ci = [quant(bs.map((b) => b[2]), 0.025), quant(bs.map((b) => b[2]), 0.975)];
    const corr = corrcoef(rows.map((o) => o.m[mk].pSnap), rows.map((o) => normCdf2(o.m[mk].x)));
    RC.marks[mk] = { n: rows.length, coefMarket: r4(beta[1]), coefFair: r4(beta[2]), coefFairCI: ci.map(r4), corrMarketFair: r4(corr), interp: 'coefFair>0 with CI excluding 0: market under-reacts to the Chainlink move known at the mark' };
    say(`  chainlink ${tf} ${mk}: n=${rows.length} corr(mkt,fair)=${r4(corr)} coef mkt=${r4(beta[1])} coef fair=${r4(beta[2])} CI [${ci.map(r4)}]`);
    const legU = (o, tok) => takerLeg({ ...o, day: o.day }, o.m[mk], tok);
    // fixed pure fair-value rules
    for (const marg of [0, 0.03, 0.06]) {
      const legs = [];
      for (const o of rows) { const d = o.m[mk]; const fair = normCdf2(d.x); const cU = takerCost(d.pSnap, o.fee, HEAD), cD = takerCost(1 - d.pSnap, o.fee, HEAD); if (fair - cU >= marg && d.pSnap < 0.98) legs.push(legU(o, 'U')); else if (1 - fair - cD >= marg && d.pSnap > 0.02) legs.push(legU(o, 'D')); }
      addVariant({ family: 'F8_chainlink_fair_taker', tf, dk: mk, side: 'fair', params: { margin: marg }, kind: 'fixed', rule: `${tf} @${mk} (5-min mark): buy the side whose Chainlink fair value Phi(ln(S/K)/(sigma*sqrt(tau))) exceeds all-in cost by >= ${marg} - taker`, isLegs: legs.filter((l) => F.isDays.has(l.day)), oosLegs: legs.filter((l) => F.oosDays.has(l.day)) });
    }
    // walk-forward combined model
    const oos = [], fi = [];
    for (const fo of F.folds) {
      const tr = rows.filter((o) => fo.trainDays.has(o.day)); if (tr.length < 60) { fi.push({ testFrom: fo.testFrom, beta: null }); continue; }
      const b = logisticFit(tr.map(feat), tr.map((o) => o.upWon)); fi.push({ testFrom: fo.testFrom, beta: b.map(r4) });
      for (const o of rows) { if (!fo.testDays.has(o.day)) continue; const d = o.m[mk]; const f = feat(o); const pi = sigmoid(b[0] + b[1] * f[0] + b[2] * f[1]); const cU = takerCost(d.pSnap, o.fee, HEAD), cD = takerCost(1 - d.pSnap, o.fee, HEAD); if (pi - cU >= 0.01 && d.pSnap < 0.98) oos.push(legU(o, 'U')); else if (1 - pi - cD >= 0.01 && d.pSnap > 0.02) oos.push(legU(o, 'D')); }
    }
    addVariant({ family: 'F8_wf_chainlink_model', tf, dk: mk, side: 'model', params: { margin: 0.01 }, kind: 'walk-forward', rule: `${tf} @${mk}: walk-forward logit model on market price + Chainlink fair value; buy side with model edge >= 1c - taker`, isLegs: [], oosLegs: oos, foldInfo: fi });
  }
}

// ---------- evaluate all variants ----------
say(`\nEvaluating ${variants.length} variants ...`);
let vi = 0;
for (const v of variants) {
  v.id = `${v.family}|${v.tf}|${v.dk}|${v.side}|${JSON.stringify(v.params)}`;
  v.oos = metrics(v.oosLegs, HEAD, { boot: true, seed: 1000 + vi++ });
  v.is = v.isLegs.length ? metrics(v.isLegs, HEAD, { boot: false }) : null;
  v.tested = v.oos.n >= MIN_N && (v.oos.days ?? 0) >= MIN_DAYS;
}
const tested = variants.filter((v) => v.tested);
const bh = benjaminiHochberg(tested.map((v) => v.oos.p), 0.10);
tested.forEach((v, i) => { v.bhQ = bh.adj[i]; v.bhSig = bh.sig[i]; });
// family-level BH (walk-forward procedures only) as a secondary view
const wfT = tested.filter((v) => v.kind === 'walk-forward'); const bhWF = benjaminiHochberg(wfT.map((v) => v.oos.p), 0.10);
wfT.forEach((v, i) => { v.bhQ_wfOnly = bhWF.adj[i]; v.bhSig_wfOnly = bhWF.sig[i]; });
say(`variants defined ${variants.length}, tested (OOS n>=${MIN_N}, days>=${MIN_DAYS}) ${tested.length}; BH q=0.10 significant: ${bh.nSig} (all) / ${bhWF.nSig} (walk-forward only, m=${wfT.length})`);

// ---------- sensitivities, tape validation, capacity for the interesting ones ----------
const tapes = { '5m': tapeTools('5m'), '15m': tapeTools('15m') };
function tapeValidate(v) {
  const tt = tapes[v.tf]; if (!tt) return null;
  const legs = v.oosLegs.concat(v.isLegs).filter((l) => tt.has(l.o.conditionId)); if (!legs.length) return { n: 0 };
  const out = { nLegsWithTape: legs.length };
  if (legs[0].kind === 'taker') {
    for (const [name, off] of [['askAtSnapTime(t_k-12s)', -LAG], ['askAtTk', 0]]) {
      const tr = []; const trH = [];
      for (const l of legs) {
        const ask = tt.askProxy(l.o.conditionId, l.tok, l.d.tDec + off); if (ask == null) continue;
        const c = ask + fees.takerFeePerShare(ask, l.o.fee, 'docs_always'); tr.push({ day: l.day, y: l.win / c - 1, cost: c, win: l.win });
        const h = legPnl(l, HEAD); trH.push({ day: l.day, y: h.y, cost: h.cost, win: l.win });
      }
      const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y), ch = clusterMeanTest(trH, (x) => x.day, (x) => x.y);
      out[name] = { n: tr.length, roiTape: r4(ct.mean), tTape: r2(ct.t), avgCostTape: r4(mean(tr.map((x) => x.cost))), roiHeadlineSameLegs: r4(ch.mean), avgCostHeadlineSameLegs: r4(mean(trH.map((x) => x.cost))), winRate: r4(mean(tr.map((x) => x.win))) };
    }
  } else {
    let agree = 0, pathF = 0, tapeF = 0; const tr = [];
    for (const l of legs) { const f = tt.makerFilled(l.o.conditionId, l.tok, l.d.tDec, l.L, l.o.E); if (f == null) continue; if (f === l.filled) agree++; if (l.filled) pathF++; if (f) { tapeF++; tr.push({ day: l.day, y: l.win / l.L - 1, win: l.win, cost: l.L }); } }
    const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y);
    out.maker = { legs: legs.length, pathFillRate: r4(pathF / legs.length), tapeFillRate: r4(tapeF / legs.length), agreement: r4(agree / legs.length), roiIfTapeFills: r4(ct.mean), tTapeFills: r2(ct.t), nTapeFills: tr.length, winRateTapeFills: r4(mean(tr.map((x) => x.win))) };
  }
  return out;
}
const interesting = variants.filter((v) => v.oos.n > 0 && (v.bhSig || (v.oos.roi > 0 && v.oos.t >= 1.5) || v.kind === 'walk-forward' || (v.tested && (v.tf === '5m' || v.tf === '15m') && /^F[129]/.test(v.family)) || (v.tested && v.sens == null && v.oos.edge > 0)));
for (const v of interesting) {
  v.sens = {};
  for (const s of SENS) { const m = metrics(v.oosLegs, s, { boot: false }); v.sens[s.name] = { n: m.n, roi: m.roi, edge: m.edge, t: m.t }; }
  if (v.oosLegs[0]?.kind === 'maker') { const m = metrics(v.oosLegs, { ...HEAD, rebate: true }, { boot: false }); v.sens['maker+rebate(optimistic)'] = { n: m.n, roi: m.roi, edge: m.edge, t: m.t }; }
  v.tape = tapeValidate(v);
}
for (const v of tested) {
  const oosDays = v.oos.days || 1; const perDay = v.oos.n / Math.max(1, oosDaysOf(v));
  v.tradesPerDay = r2(perDay);
  v.capacityUSDperDay = r2(Math.max(0, v.oos.roi) * perDay * STAKE_CAP[v.tf] * (v.oosLegs[0]?.kind === 'maker' ? 0.5 : 1));
  v.deployUSDperDay = r2(perDay * STAKE_CAP[v.tf]);
}
function oosDaysOf(v) { // calendar OOS days of the tf (not only days with trades)
  const R = results.perTf[v.tf]; if (v.family.startsWith('F8')) { const C = results.chainlink[v.tf]; return Math.round(C.days * 0.6); }
  return R ? R.days - Math.ceil(0.4 * R.days) : 1;
}

// ---------- descriptive BH over calibration bins ----------
const bhBins = benjaminiHochberg(calibBinsTests.map((x) => x.p), 0.10);
calibBinsTests.forEach((x, i) => { x.q = bhBins.adj[i]; x.sig = bhBins.sig[i]; });
results.calibrationBinTests = { m: calibBinsTests.length, nSig: bhBins.nSig, significant: calibBinsTests.filter((x) => x.sig).sort((a, b) => a.p - b.p) };
say(`\nDescriptive calibration-bin tests (folded favourite half, n>=30): m=${calibBinsTests.length}, BH-significant ${bhBins.nSig}`);
for (const x of results.calibrationBinTests.significant.slice(0, 25)) say(`  ${x.tf} ${x.dk} [${x.lo},${x.hi}) n=${x.n} resid=${x.resid} p=${x.p.toExponential(2)} q=${x.q.toFixed(3)}`);

// ---------- write variants ----------
const vcsv = ['id,family,kind,tf,decision,side,params,is_n,is_roi,is_t,oos_n,oos_days,oos_winRate,oos_avgCost,oos_edge,oos_roi,oos_roi_lo,oos_roi_hi,oos_t,oos_p,tested,bh_q,bh_sig,trades_per_day,capacity_usd_day'];
const csvQ = (x) => '"' + String(x).replace(/"/g, '""') + '"';
for (const v of variants) vcsv.push([csvQ(v.id), v.family, v.kind, v.tf, v.dk, v.side, csvQ(JSON.stringify(v.params)), v.is?.n ?? '', v.is?.roi ?? '', v.is?.t ?? '', v.oos.n, v.oos.days ?? '', v.oos.winRate ?? '', v.oos.avgCost ?? '', v.oos.edge ?? '', v.oos.roi ?? '', v.oos.roiCI?.[0] ?? '', v.oos.roiCI?.[1] ?? '', v.oos.t ?? '', v.oos.p != null ? v.oos.p.toExponential(3) : '', v.tested, v.bhQ != null ? v.bhQ.toFixed(4) : '', !!v.bhSig, v.tradesPerDay ?? '', v.capacityUSDperDay ?? ''].join(','));
fs.writeFileSync(path.join(OUT, 'variants.csv'), vcsv.join('\n') + '\n');
const slim = (v) => ({ id: v.id, family: v.family, kind: v.kind, tf: v.tf, dk: v.dk, side: v.side, params: v.params, rule: v.rule, is: v.is, oos: v.oos, tested: v.tested, bhQ: v.bhQ, bhSig: v.bhSig, bhQ_wfOnly: v.bhQ_wfOnly, tradesPerDay: v.tradesPerDay, capacityUSDperDay: v.capacityUSDperDay, deployUSDperDay: v.deployUSDperDay, sens: v.sens, tape: v.tape, foldInfo: v.foldInfo });
results.variantCounts = { defined: variants.length, tested: tested.length, bhSigAll: bh.nSig, bhThresholdP: bh.threshold, walkForwardTested: wfT.length, bhSigWalkForward: bhWF.nSig, byFamily: Object.fromEntries([...new Set(variants.map((v) => v.family))].map((f) => [f, { defined: variants.filter((v) => v.family === f).length, tested: tested.filter((v) => v.family === f).length }])) };
results.walkForward = wfT.map(slim);
results.topByOosT = tested.slice().sort((a, b) => b.oos.t - a.oos.t).slice(0, 40).map(slim);
results.bhSignificant = tested.filter((v) => v.bhSig).map(slim);
fs.writeFileSync(path.join(OUT, 'variants_detail.json'), JSON.stringify(interesting.map(slim)));
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(OUT, 'tests.json'), JSON.stringify({ perTf: Object.fromEntries(Object.entries(results.perTf).map(([k, v]) => [k, { upRate: v.upRate, tests: v.tests }])), chainlink: results.chainlink, calibrationBinTests: results.calibrationBinTests }, null, 1));

say('\nTop 25 tested variants by OOS cluster-t (headline costs: docs_always fee, interp exec, 1c haircut):');
for (const v of results.topByOosT.slice(0, 25)) say(`  ${v.id}  IS roi=${v.is?.roi ?? '-'} | OOS n=${v.oos.n} win=${v.oos.winRate} cost=${v.oos.avgCost} edge=${v.oos.edge} roi=${v.oos.roi} CI[${v.oos.roiCI}] t=${v.oos.t} p=${v.oos.p.toExponential(2)} q=${v.bhQ?.toFixed(3)} ${v.tape ? 'tape=' + JSON.stringify(v.tape) : ''}`);
say('\nWalk-forward procedures (OOS):');
for (const v of results.walkForward.sort((a, b) => b.oos.t - a.oos.t)) say(`  ${v.id}  n=${v.oos.n} win=${v.oos.winRate} cost=${v.oos.avgCost} edge=${v.oos.edge} roi=${v.oos.roi} CI[${v.oos.roiCI}] t=${v.oos.t} q=${v.bhQ?.toFixed(3)}`);
fs.writeFileSync(path.join(OUT, 'summary.txt'), lines.join('\n') + '\n');

// ---------- small local helpers ----------
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function quant(a, q) { const s = a.slice().sort((x, y) => x - y); if (!s.length) return NaN; const pos = q * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); }
function normCdf2(z) { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2); return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }
function corrcoef(a, b) { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); }
