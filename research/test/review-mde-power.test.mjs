// REVIEW REPRO (statistical rigor / honest "no edge"): MDE80 overstates the kit's power.
//
// backtest.js summarizeBets(): mde80 = (z_{1-alpha/2} + z_{0.8}) * se, i.e. 80% power for a single
// two-sided 5% test. But SURVIVES needs BH significance across all m tested hypotheses, which for
// one real edge among nulls means one-sided p <= q/m (0.002 at m = 50), plus the CI and stress
// checks. The no-survivor verdict then says edges below MDE80 "would not have shown up", inviting
// the reading that edges at or above it would have. At true ROI = reported MDE80 the full rule
// detects the edge far less than 80% of the time.
//
// Run: node --test research/test/review-mde-power.test.mjs
// Expected today: FAILS (detection rate at the reported MDE80 is ~45%, not ~80%).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benjaminiHochberg, clusterBootstrapSums, makeRng, normalQuantile } from '../lib/stats.js';
import { betPnl, entryCost, DEFAULTS } from '../backtest.js';

test('an edge equal to the reported MDE80 is detected ~80% of the time by the SURVIVES rule', () => {
  const n = 1000, price = 0.5, m = 50, R = 300;
  const cost = entryCost(price, DEFAULTS.spread, DEFAULTS.fee);
  const stressCost = entryCost(price, DEFAULTS.stressSpread, DEFAULTS.fee);
  const zSum = normalQuantile(1 - DEFAULTS.alpha / 2) + normalQuantile(0.8);
  // Plant true ROI = the MDE80 the kit would report for n bets at this price.
  let w = cost;
  for (let it = 0; it < 20; it++) w = cost * (1 + zSum * Math.sqrt(w * (1 - w)) / cost / Math.sqrt(n));
  const trueRoi = w / cost - 1;
  const rng = makeRng('review-mde');
  let detected = 0, mdeSum = 0;
  for (let rep = 0; rep < R; rep++) {
    const bets = [];
    for (let i = 0; i < n; i++) bets.push({ e: i, won: rng() < w ? 1 : 0 });
    const s = clusterBootstrapSums(bets, (b) => b.e, (b) => [1, betPnl(b.won, cost)], { roi: (x) => x[1] / x[0] }, { B: DEFAULTS.boot, seed: rep }).stats.roi;
    mdeSum += zSum * s.se;
    const stress = bets.reduce((a, b) => a + betPnl(b.won, stressCost), 0) / n;
    // The other m-1 hypotheses carry no edge after costs (p near 1), the most favourable case for BH.
    const bh = benjaminiHochberg([s.p, ...Array(m - 1).fill(0.9)], DEFAULTS.fdr);
    if (bh.rejected[0] && s.lo > 0 && stress > 0) detected++;
  }
  const rate = detected / R;
  console.log(`true ROI ${(100 * trueRoi).toFixed(1)}%, mean reported MDE80 ${(100 * mdeSum / R).toFixed(1)}%, m = ${m}: detected ${(100 * rate).toFixed(0)}% of runs (MDE80 implies ~80%)`);
  console.log(`BH-aware MDE80 would be (z_{1-q/m} + z_0.8) * se = ${((normalQuantile(1 - DEFAULTS.fdr / m) + normalQuantile(0.8)) / zSum).toFixed(2)}x the reported value`);
  assert.ok(rate >= 0.7, `detection rate at the reported MDE80 is ${(100 * rate).toFixed(0)}%`);
});
