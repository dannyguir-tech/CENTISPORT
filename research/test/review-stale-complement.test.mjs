// REVIEW REPRO (statistical rigor / cost model): a FAKE edge from non-synchronous prices.
//
// build-dataset.js takes `price` and `complementPrice` as each token's own last point, each allowed
// to be up to --max-price-age-h (6h) old, and computes overround from the two. When one token's
// series has a gap, overround compares a stale quote with a fresh one. overround-cheap-side
// (mode "under") then buys the stale side at its stale price, which the backtest treats as
// executable at decisionTs (entryCost only adds a flat haircut). The fresh complement already says
// the fair price moved, so this is buying at a price that was no longer on offer.
//
// World below: every printed price is the EXACT fair probability at its own timestamp (a
// martingale), so no rule can beat costs at executable prices. Token 1's series has short gaps
// (1-5h, inside the 6h max age; 25%/h start rate, 20k events). Nothing should survive. Dose-response
// seen while building this: 12%/h gaps at 30k events gave +5.3% printed vs -3.5% at the fresh price,
// CI lower bound +0.9%, p 0.012 (just short of BH); 25%/h gives a full SURVIVES.
//
// Run: node --test research/test/review-stale-complement.test.mjs
// Expected today: FAILS (overround-cheap-side SURVIVES; re-costed at the fresh price it loses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRng, normalCdf, randNormal } from '../lib/stats.js';
import { buildDataset } from '../build-dataset.js';
import { assignFolds, betPnl, entryCost, loadDataset, runBacktest, walkForward, DEFAULTS } from '../backtest.js';
import { BASE_HYPOTHESES } from '../hypotheses.js';

const HOUR = 3600;
const K = 80;
const r3 = (x) => Math.round(Math.min(0.999, Math.max(0.001, x)) * 1000) / 1000;
const pg = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00');

function writeWorld(dir, nEvents, seed) {
  fs.mkdirSync(path.join(dir, 'prices'), { recursive: true });
  const t0 = Date.UTC(2024, 0, 1) / 1000, span = 540 * 24 * HOUR;
  const vh = 1.0 / K; // pre-game information variance per hour (in-game variance = 1)
  const lines = [];
  for (let i = 0; i < nEvents; i++) {
    const rng = makeRng(seed, 'stale', i);
    const start = t0 + Math.floor((rng() * span) / HOUR) * HOUR;
    let S = Math.sqrt(0.8) * randNormal(rng);
    const q = new Array(K + 1);
    for (let k = K; k >= 0; k--) {
      if (k < K) S += Math.sqrt(vh) * randNormal(rng);
      q[k] = normalCdf(S / Math.sqrt(k * vh + 1)); // exact P(win | info at hour k)
    }
    const won0 = S + randNormal(rng) > 0;
    const cid = `m${i}`;
    const p0 = [], p1 = [];
    let gap = 0;
    for (let k = K; k >= 0; k--) {
      const t = start - k * HOUR;
      p0.push({ t, p: r3(q[k]) });
      if (gap > 0) { gap--; continue; }
      if (k > 0 && rng() < 0.25) { gap = Math.floor(rng() * 5); continue; } // token 1 only: 1-5h gaps
      p1.push({ t, p: r3(1 - q[k]) });
    }
    fs.writeFileSync(path.join(dir, 'prices', `${cid}t0.json`), JSON.stringify({ tokenId: `${cid}t0`, points: p0 }));
    fs.writeFileSync(path.join(dir, 'prices', `${cid}t1.json`), JSON.stringify({ tokenId: `${cid}t1`, points: p1 }));
    lines.push(JSON.stringify({
      conditionId: cid, question: `[SYNTHETIC] Team ${i} vs. Rival ${i}`, slug: cid, eventSlug: `ev-${cid}`, eventTitle: `[SYNTHETIC] ev ${i}`,
      sport: 'nba', tags: [], outcomes: ['Team', 'Rival'], tokenIds: [`${cid}t0`, `${cid}t1`], winnerIndex: won0 ? 0 : 1,
      times: { gameStartTime: pg(start), startDate: null, endDate: null, closedTime: pg(start + 4 * HOUR), eventStartDate: null, eventEndDate: null },
      volume: null, negRisk: false, collectedAt: 0,
    }));
  }
  fs.writeFileSync(path.join(dir, 'markets.jsonl'), lines.join('\n') + '\n');
}

test('calibrated-at-every-timestamp world: no hypothesis may survive (stale-quote arbitrage is not executable)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale-'));
  try {
    writeWorld(dir, 20000, 11);
    await buildDataset({ dataDir: dir });
    const data = path.join(dir, 'dataset.jsonl');
    const { report } = await runBacktest({ data, sourceLabel: 'SYNTHETIC review repro', out: dir, name: 'r' });
    const tested = report.hypotheses.filter((h) => h.status === 'tested');
    for (const h of tested) console.log(`${h.id.padEnd(22)} n ${String(h.oos.n).padStart(5)} roi ${(h.oos.roi.estimate * 100).toFixed(1)}% lo ${(h.oos.roi.lo * 100).toFixed(1)}% p ${h.oos.roi.p.toFixed(4)} ${h.verdict.label}`);

    // Re-cost the same OOS picks at the price actually on offer at decisionTs. Token 0 is never
    // stale, so token 1's fresh fair price is exactly 1 - complement.
    const hyp0 = BASE_HYPOTHESES.find((h) => h.id === 'overround-cheap-side');
    const { rows } = await loadDataset(data);
    const folds = assignFolds(rows, DEFAULTS.folds);
    const { picks } = walkForward({ ...hyp0, offsets: [1, 3, 12, 24] }, folds, DEFAULTS);
    let nStale = 0, pnlPrinted = 0, pnlFresh = 0, n = 0;
    for (const r of picks) {
      const fresh = r.f.outcomeIndex === 1 ? 1 - r.f.complementPrice : r.f.price;
      const cP = entryCost(r.f.price, DEFAULTS.spread, DEFAULTS.fee), cF = entryCost(fresh, DEFAULTS.spread, DEFAULTS.fee);
      if (cP >= DEFAULTS.maxCost || cF >= DEFAULTS.maxCost) continue;
      n++;
      if (r.f.priceAgeSec > 0) nStale++;
      pnlPrinted += betPnl(r.won, cP);
      pnlFresh += betPnl(r.won, cF);
    }
    console.log(`overround-cheap-side OOS picks: ${n}, with a stale own price: ${nStale}; ROI at printed price ${(100 * pnlPrinted / n).toFixed(1)}% vs at fresh executable price ${(100 * pnlFresh / n).toFixed(1)}%`);

    const survivors = tested.filter((h) => h.verdict.survives).map((h) => h.id);
    assert.deepEqual(survivors, [], `fake survivors in a world with no executable edge: ${survivors.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
