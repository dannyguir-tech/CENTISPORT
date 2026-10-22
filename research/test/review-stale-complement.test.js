// Review R2 (permanent): no fake edge from non-synchronous prices.
//
// price and complementPrice used to be each token's own last point, each up to --max-price-age-h
// old, and the 24h trade window ran to decisionTs. When one token's series had a gap, overround
// compared a stale quote with a fresh one, and overround-cheap-side bought the stale side at its
// stale price (SURVIVES at +9.7% ROI in this world; -0.2% at the price actually on offer). Trades
// newer than a stale price point leaked the same way. Features are now taken as of the row's price
// point: the complement is never fresher than it (and at most --max-sync-gap-min older), and the
// trade window ends at its timestamp.
//
// World: every printed price is the EXACT fair probability at its own timestamp (a martingale), so
// no rule can beat costs at executable prices. Token 1's series has 1-5h gaps (inside the 6h max
// age) starting at 25%/h. SYNTHETIC data only. Run: node --test research/test/review-stale-complement.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRng, normalCdf, randNormal } from '../lib/stats.js';
import { buildDataset } from '../build-dataset.js';
import { runBacktest } from '../backtest.js';

const HOUR = 3600;
const K = 80;
const r3 = (x) => Math.round(Math.min(0.999, Math.max(0.001, x)) * 1000) / 1000;
const pg = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00');
const readJsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const marketLine = (cid, i, start, winnerIndex, extra = {}) => JSON.stringify({
  conditionId: cid, question: `[SYNTHETIC] Team ${i} vs. Rival ${i}`, slug: cid, eventSlug: `ev-${cid}`, eventTitle: `[SYNTHETIC] ev ${i}`,
  sport: 'nba', tags: [], outcomes: ['Team', 'Rival'], tokenIds: [`${cid}t0`, `${cid}t1`], winnerIndex,
  times: { gameStartTime: pg(start), startDate: null, endDate: null, closedTime: pg(start + 4 * HOUR), eventStartDate: null, eventEndDate: null },
  volume: null, negRisk: false, collectedAt: 0, ...extra,
});

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
    lines.push(marketLine(cid, i, start, won0 ? 0 : 1));
  }
  fs.writeFileSync(path.join(dir, 'markets.jsonl'), lines.join('\n') + '\n');
}

test('calibrated-at-every-timestamp world with one-sided gaps: overround is synchronous and nothing survives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale-'));
  try {
    writeWorld(dir, 20000, 11);
    const summary = await buildDataset({ dataDir: dir });
    const data = path.join(dir, 'dataset.jsonl');
    // Both tokens print the exact fair price, so a pair quoted at the same time sums to 1 (+-0.001
    // rounding). A stale/fresh pair would not: that gap was the fake "cheap side".
    const rows = readJsonl(data);
    const paired = rows.filter((r) => r.overround != null);
    assert.ok(paired.length > rows.length / 2, 'non-vacuous: most rows still have a complement');
    const off = paired.filter((r) => Math.abs(r.overround) > 0.0011);
    assert.deepEqual(off.slice(0, 3).map((r) => `${r.id} overround ${r.overround}`), [], `${off.length} rows pair non-synchronous quotes`);
    assert.ok(summary.featureNulls.complement_not_synchronous > 1000, 'the gaps did hit: stale pairs were refused');

    const { report } = await runBacktest({ data, sourceLabel: 'SYNTHETIC review repro', out: dir, name: 'r' });
    const tested = report.hypotheses.filter((h) => h.status === 'tested');
    const survivors = tested.filter((h) => h.verdict.survives).map((h) => h.id);
    assert.deepEqual(survivors, [], `fake survivors in a world with no executable edge: ${survivors.join(', ')}`);
    const base = tested.find((h) => h.id === 'baseline-all');
    assert.ok(base.oos.roi.estimate < 0, 'buying everything loses the cost drag');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trades printed after a stale price point never reach that row\'s features', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stale-trades-'));
  try {
    const start = Date.UTC(2025, 2, 1, 0, 0) / 1000;
    fs.mkdirSync(path.join(dir, 'prices'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'trades'), { recursive: true });
    // Token 0's last point is 4h before start; token 1 keeps printing as the fair price moves.
    const pts0 = [], pts1 = [];
    for (let k = 30; k >= 1; k--) {
      const p = k > 4 ? 0.5 : 0.5 + 0.05 * (4 - k);
      if (k >= 4) pts0.push({ t: start - k * HOUR, p });
      pts1.push({ t: start - k * HOUR, p: r3(1 - p) });
    }
    fs.writeFileSync(path.join(dir, 'prices', 'mt0.json'), JSON.stringify({ tokenId: 'mt0', points: pts0 }));
    fs.writeFileSync(path.join(dir, 'prices', 'mt1.json'), JSON.stringify({ tokenId: 'mt1', points: pts1 }));
    // Quiet tape until the stale point, then heavy buying of token 0 (what moved the price).
    const trades = [];
    for (let k = 0; k < 10; k++) trades.push({ t: start - 20 * HOUR + k * HOUR, asset: 'mt0', side: 'BUY', size: 10, price: 0.5, wallet: `0xa${k}` });
    for (let k = 0; k < 40; k++) trades.push({ t: start - 4 * HOUR + 60 + k * 240, asset: 'mt0', side: 'BUY', size: 5000, price: 0.55, wallet: `0xb${k}` });
    fs.writeFileSync(path.join(dir, 'trades', 'm.jsonl'), trades.map((t) => JSON.stringify(t)).join('\n') + '\n');
    const tradesInfo = { v: 2, n: trades.length, fromT: start - 78 * HOUR, toT: start, truncated: false, stop: 'window_start', coverageFromT: start - 78 * HOUR, oldestT: trades[0].t, newestT: trades.at(-1).t, pages: 1 };
    fs.writeFileSync(path.join(dir, 'markets.jsonl'), marketLine('m', 0, start, 0, { tokenIds: ['mt0', 'mt1'], tradesInfo }) + '\n');
    await buildDataset({ dataDir: dir, offsets: [1] });
    const row = readJsonl(path.join(dir, 'dataset.jsonl')).find((r) => r.id === 'm|0|1');
    assert.equal(row.priceAgeSec, 3 * HOUR, 'token 0 is 3h stale at the 1h decision');
    assert.equal(row.price, 0.5);
    assert.deepEqual([row.nTrades24h, row.largeNetNotional24h, row.distinctWallets24h], [10, 0, 10], 'only trades up to the 0.5 quote count');
    assert.equal(row.complementPrice, 0.5, 'complement as of the stale quote, not the fresh 0.35');
    const fresh = readJsonl(path.join(dir, 'dataset.jsonl')).find((r) => r.id === 'm|1|1');
    assert.equal(fresh.nTrades24h, 50, 'the fresh token sees the whole tape up to its own quote');
    assert.equal(fresh.complementPrice, null, 'token 0 is 3h older than token 1: not synchronous');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
