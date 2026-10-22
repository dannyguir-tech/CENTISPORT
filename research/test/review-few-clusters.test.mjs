// REVIEW REPRO (statistical rigor): the SURVIVES rule counts bets, not independent events.
//
// judge() in backtest.js requires OOS n >= --min-n BETS, but the cluster bootstrap resamples
// EVENTS. When a hypothesis's bets sit in a handful of events (player props: dozens of correlated
// markets per game), a lucky run where every event goes the right way makes every bootstrap
// replicate positive, so p hits the floor 1/(B+1) = 0.0005 and the CI excludes 0. A valid
// cluster-level test cannot be more confident than 2^-C with C clusters (all-positive sign
// pattern), so 6 events can never justify p < 0.0156.
//
// Run: node --test research/test/review-few-clusters.test.mjs
// Expected today: both tests FAIL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clusterBootstrapSums, makeRng } from '../lib/stats.js';
import { betPnl, entryCost, runBacktest, DEFAULTS } from '../backtest.js';

test('cluster-bootstrap p must be (near) valid at the BH threshold when there are few events', () => {
  // Null with NEGATIVE true ROI: fair price 0.5, cost 0.5151 => true ROI -2.9%. 5 events x 12 bets,
  // perfectly correlated within an event. A valid level-0.002 test rejects at most 0.2% of the time.
  const C = 5, k = 12, R = 1500, level = 0.002;
  const cost = entryCost(0.5, DEFAULTS.spread, DEFAULTS.fee);
  const rng = makeRng('review-few', C);
  let rejects = 0;
  for (let rep = 0; rep < R; rep++) {
    const bets = [];
    for (let e = 0; e < C; e++) { const w = rng() < 0.5 ? 1 : 0; for (let j = 0; j < k; j++) bets.push({ e, pnl: betPnl(w, cost) }); }
    const s = clusterBootstrapSums(bets, (b) => b.e, (b) => [1, b.pnl], { roi: (x) => x[1] / x[0] }, { B: DEFAULTS.boot, seed: rep }).stats.roi;
    if (s.p <= level && s.lo > 0) rejects++;
  }
  const rate = rejects / R;
  console.log(`C=${C} events, n=${C * k} bets, true ROI ${(100 * (0.5 / cost - 1)).toFixed(1)}%: P(p <= ${level} and CI lo > 0) = ${(100 * rate).toFixed(2)}% (valid test: <= ${100 * level}%)`);
  assert.ok(rate <= 2 * level, `false-positive rate ${(100 * rate).toFixed(2)}% at nominal ${100 * level}%`);
});

test('a survivor backed by only 6 independent events must not pass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-few-'));
  try {
    const rng = makeRng('review-few-e2e');
    const t0 = Date.UTC(2024, 0, 1) / 1000, span = 500 * 86400;
    const lines = [];
    const add = (cid, eventKey, i, startTs, outcome, marketType, sideType, price, won) => {
      for (const offsetH of [1, 3, 12, 24]) {
        lines.push(JSON.stringify({
          id: `${cid}|${i}|${offsetH}`, eventKey, conditionId: cid, outcomeIndex: i, outcome, startTs, decisionTs: startTs - offsetH * 3600, offsetH,
          sport: 'nba', marketType, sideType, line: null, price, priceAgeSec: 0, price_m6h: null, price_m24h: null, mom6h: null, mom24h: null,
          complementPrice: null, overround: null, nTrades24h: null, netBuyNotional24h: null, largeNetNotional24h: null, distinctWallets24h: null, topWalletShare24h: null,
          won, closePrice: price, clv: 0,
        }));
      }
    };
    // Background: 2500 fairly priced moneylines (no edge anywhere).
    for (let e = 0; e < 2500; e++) {
      const start = t0 + Math.floor((rng() * span) / 3600) * 3600;
      const p = Math.round((0.2 + 0.6 * rng()) * 100) / 100;
      const w = rng() < p ? 1 : 0;
      add(`ml${e}`, `ev-ml${e}`, 0, start, 'A', 'moneyline', 'team', p, w);
      add(`ml${e}`, `ev-ml${e}`, 1, start, 'B', 'moneyline', 'team', Math.round((1 - p) * 100) / 100, 1 - w);
    }
    // 9 games with 30 player props each, fairly priced at 0.5; props in a game move together.
    // 3 early games (training) split; the 6 later games all go under: probability 1/64 under the null.
    for (let g = 0; g < 9; g++) {
      const start = t0 + Math.floor(((g < 3 ? 0.02 + 0.05 * g : 0.25 + 0.12 * (g - 3)) * span) / 3600) * 3600;
      const under = g < 3 ? g % 2 : 1;
      for (let j = 0; j < 30; j++) {
        add(`pr${g}x${j}`, `ev-game${g}`, 0, start, 'Over', 'prop', 'over', 0.5, 1 - under);
        add(`pr${g}x${j}`, `ev-game${g}`, 1, start, 'Under', 'prop', 'under', 0.5, under);
      }
    }
    const data = path.join(dir, 'dataset.jsonl');
    fs.writeFileSync(data, lines.join('\n') + '\n');
    const { report } = await runBacktest({ data, sourceLabel: 'SYNTHETIC review repro', out: dir, name: 'r' });
    const tested = report.hypotheses.filter((h) => h.status === 'tested');
    for (const h of tested) console.log(`${h.id.padEnd(18)} n ${String(h.oos.n).padStart(5)} events ${String(h.oos.nEvents).padStart(5)} roi ${(100 * h.oos.roi.estimate).toFixed(1)}% p ${h.oos.roi.p.toFixed(4)} bh ${h.bh.pAdj.toFixed(4)} ${h.verdict.label}`);
    for (const h of tested.filter((x) => x.verdict.survives)) {
      const bound = 2 ** -h.oos.nEvents;
      assert.ok(h.oos.roi.p >= bound, `${h.id} SURVIVES on ${h.oos.nEvents} events with p ${h.oos.roi.p.toFixed(4)}; no valid cluster-level test can go below 2^-${h.oos.nEvents} = ${bound.toFixed(4)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
