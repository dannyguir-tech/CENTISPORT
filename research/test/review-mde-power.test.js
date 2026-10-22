// Review R4 (permanent): MDE80 must not overstate the kit's power.
//
// MDE80 used to be (z_{1-alpha/2} + z_0.8) x SE, the power of one two-sided 5% test. SURVIVES needs
// BH significance across all m tested hypotheses, which for one real edge among nulls means a
// one-sided p <= q/m (0.002 at m = 50), plus the CI and stress checks. An edge equal to that MDE80
// was detected in 42% of runs. MDE80 now uses z_{1-q/m} (the rank-1 BH threshold).
// SYNTHETIC data only. Run: node --test research/test/review-mde-power.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benjaminiHochberg, clusterBootstrapSums, makeRng, normalQuantile } from '../lib/stats.js';
import { betPnl, entryCost, mde80, DEFAULTS } from '../backtest.js';

const n = 1000, price = 0.5, m = 50, R = 300;
const cost = entryCost(price, DEFAULTS.spread, DEFAULTS.fee);
const stressCost = entryCost(price, DEFAULTS.stressSpread, DEFAULTS.fee);
const seOf = (w) => Math.sqrt(w * (1 - w)) / cost / Math.sqrt(n); // SE of ROI for n independent bets

// Win probability whose true ROI equals the MDE a given formula reports for that sample.
function plant(mdeOfSe) {
  let w = cost;
  for (let it = 0; it < 30; it++) w = cost * (1 + mdeOfSe(seOf(w)));
  return w;
}

// Share of R simulated samples that pass the kit's survival rule, with the other m-1 hypotheses
// carrying no edge after costs (p near 1, the most favourable case for BH).
function detectionRate(w, seedKey) {
  const rng = makeRng('review-mde', seedKey);
  let detected = 0, reported = 0;
  for (let rep = 0; rep < R; rep++) {
    const bets = [];
    for (let i = 0; i < n; i++) bets.push({ e: i, won: rng() < w ? 1 : 0 });
    const s = clusterBootstrapSums(bets, (b) => b.e, (b) => [1, betPnl(b.won, cost)], { roi: (x) => x[1] / x[0] }, { B: DEFAULTS.boot, seed: rep }).stats.roi;
    reported += mde80(s.se, m, DEFAULTS.fdr);
    const stress = bets.reduce((a, b) => a + betPnl(b.won, stressCost), 0) / n;
    const bh = benjaminiHochberg([s.p, ...Array(m - 1).fill(0.9)], DEFAULTS.fdr);
    if (bh.rejected[0] && s.lo > 0 && stress > 0) detected++;
  }
  return { rate: detected / R, meanReported: reported / R };
}

test('mde80 uses the rank-1 BH threshold z_{1-q/m}', () => {
  const se = 0.03;
  assert.ok(Math.abs(mde80(se, m, 0.1) - (normalQuantile(1 - 0.1 / m) + normalQuantile(0.8)) * se) < 1e-12);
  assert.ok(mde80(se, m, 0.1) / ((normalQuantile(0.975) + normalQuantile(0.8)) * se) > 1.3, 'about 1.33x the single-test value at m = 50');
  assert.equal(mde80(null, m, 0.1), null);
  assert.equal(mde80(se, 0, 0.1), null);
});

test('an edge equal to the reported MDE80 is detected about 80% of the time by the SURVIVES rule', () => {
  const w = plant((se) => mde80(se, m, DEFAULTS.fdr));
  const trueRoi = w / cost - 1;
  const { rate, meanReported } = detectionRate(w, 'bh');
  assert.ok(Math.abs(meanReported - trueRoi) < 0.05 * trueRoi, `planted ${trueRoi}, mean reported MDE80 ${meanReported}`);
  assert.ok(rate >= 0.7 && rate <= 0.9, `detection rate at the reported MDE80 is ${(100 * rate).toFixed(0)}%`);
});

test('the old single-test MDE80 overstated power (teeth for the test above)', () => {
  const w = plant((se) => (normalQuantile(1 - DEFAULTS.alpha / 2) + normalQuantile(0.8)) * se);
  const { rate } = detectionRate(w, 'single');
  assert.ok(rate < 0.6, `detection at the single-test MDE80 was ${(100 * rate).toFixed(0)}%`);
});
