// Run: node --test research/test/stats.test.js
// Statistics (bootstrap coverage, BH, Wilson), the cost model, and an instrumented walk-forward:
// parameter selection must only ever see rows from earlier folds, outside the embargo, and never
// labels. End-to-end runs on synthetic data check both directions: no false edge on null data,
// and a planted edge is found.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  makeRng, mulberry32, randInt, randNormal, quantile, wilson, normalCdf, normalQuantile,
  clusterBootstrap, clusterBootstrapSums, bootstrapPValue, benjaminiHochberg, mean,
} from '../lib/stats.js';
import {
  DEFAULTS, LABEL_FIELDS, assignFolds, betPnl, chooseParams, entryCost, prepareRow, runBacktest, walkForward,
} from '../backtest.js';
import { BASE_HYPOTHESES, buildHypotheses, grid } from '../hypotheses.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'backtest.js');
const H = 3600;
const OFFSETS = [1, 3, 12, 24];
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const hyp = (id) => BASE_HYPOTHESES.find((h) => h.id === id);

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-test-')); });
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Synthetic dataset.jsonl rows. Each market's latent probability is an hourly martingale and the
// winner is drawn from its final value, so prices are calibrated at every offset (no edge) unless
// `plant` adds true win probability to favorites whose final price is in [0.75, 0.90].
// Trade features are pure noise. Every third event has a second (totals) market sharing eventKey.
function genRows({ nEvents = 600, seed = 7, plant = 0, sports = ['nba', 'nfl'], trades = true, spacingH = 4 } = {}) {
  const rng = makeRng(seed, 'gen');
  const t0 = Date.UTC(2025, 0, 1) / 1000;
  const rows = [];
  for (let e = 0; e < nEvents; e++) {
    const eventKey = `ev-${e}`;
    const startTs = t0 + e * spacingH * H + randInt(rng, H);
    const sport = sports[e % sports.length];
    const nMarkets = e % 3 === 0 ? 2 : 1;
    for (let m = 0; m < nMarkets; m++) {
      const conditionId = `c${e}-${m}`;
      const isTotal = m === 1 || e % 4 === 1;
      const pathP = new Array(51); // pathP[h] = latent P(outcome 0) h hours before start
      pathP[50] = 0.08 + 0.84 * rng();
      for (let h = 49; h >= 0; h--) pathP[h] = clamp(pathP[h + 1] + 0.005 * randNormal(rng), 0.02, 0.98);
      let q = pathP[0];
      if (plant) {
        if (q >= 0.75 && q <= 0.9) q = Math.min(0.99, q + plant);
        else if (1 - q >= 0.75 && 1 - q <= 0.9) q = Math.max(0.01, q - plant);
      }
      const winner = rng() < q ? 0 : 1;
      const outcomes = isTotal ? ['Over 220.5', 'Under 220.5'] : ['Home', 'Away'];
      for (const off of OFFSETS) {
        const nu = 0.005 * randNormal(rng);
        const px = (i, h) => (i === 0 ? pathP[h] : 1 - pathP[h]);
        const prices = [r4(px(0, off) + nu / 2), r4(px(1, off) + nu / 2)];
        const wallets = randInt(rng, 80), nTr = wallets + randInt(rng, 100);
        const net = 2000 * randNormal(rng), large = Math.round(8000 * randNormal(rng));
        for (let i = 0; i < 2; i++) {
          const sign = i === 0 ? 1 : -1;
          const price = prices[i], m6 = r4(px(i, off + 6)), m24 = r4(px(i, off + 24));
          const closePrice = r4(px(i, 0));
          rows.push({
            id: `${conditionId}|${i}|${off}`, eventKey, conditionId, outcomeIndex: i, outcome: outcomes[i],
            startTs, decisionTs: startTs - off * H, offsetH: off, sport,
            marketType: isTotal ? 'total' : 'moneyline', sideType: isTotal ? (i === 0 ? 'over' : 'under') : 'team', line: isTotal ? 220.5 : null,
            price, priceAgeSec: 60, price_m6h: m6, price_m24h: m24, mom6h: r4(price - m6), mom24h: r4(price - m24),
            complementPrice: prices[1 - i], overround: r4(prices[0] + prices[1] - 1),
            nTrades24h: trades ? nTr : null,
            netBuyNotional24h: trades ? r4(sign * net) : null,
            largeNetNotional24h: trades ? sign * large : null,
            distinctWallets24h: trades ? wallets : null,
            topWalletShare24h: trades ? r4(rng()) : null,
            won: i === winner ? 1 : 0, closePrice, clv: r4(closePrice - price),
          });
        }
      }
    }
  }
  return rows;
}

// ---------- PRNG & basic helpers ----------

test('PRNG is deterministic, keyed and roughly uniform', () => {
  const a = makeRng(1, 'x'), b = makeRng(1, 'x'), c = makeRng(1, 'y');
  const sa = Array.from({ length: 5 }, a), sb = Array.from({ length: 5 }, b), sc = Array.from({ length: 5 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  const r = mulberry32(42);
  const xs = Array.from({ length: 20000 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(mean(xs) - 0.5) < 0.01);
  const ints = new Array(5).fill(0);
  for (let i = 0; i < 10000; i++) ints[randInt(r, 5)]++;
  assert.ok(ints.every((n) => n > 1800 && n < 2200), JSON.stringify(ints));
});

test('quantile, normal helpers and Wilson interval match known values', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
  assert.ok(close(normalQuantile(0.975), 1.959963985, 1e-6));
  assert.ok(close(normalQuantile(0.001), -3.090232306, 1e-6));
  assert.ok(close(normalCdf(1.959963985), 0.975, 1e-6));
  const w = wilson(5, 10);
  assert.ok(close(w.lo, 0.2366, 1e-4) && close(w.hi, 0.7634, 1e-4));
  const w0 = wilson(0, 10);
  assert.equal(w0.lo, 0);
  assert.ok(close(w0.hi, 0.2775, 1e-4));
  assert.ok(Number.isNaN(wilson(0, 0).p));
});

// ---------- Benjamini–Hochberg ----------

// Benjamini & Hochberg (1995), section 4: 15 p-values; at q = 0.05 BH rejects the first four
// (Bonferroni only the first three).
const BH95 = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719, 0.6528, 0.759, 1.0];

test('BH reproduces the Benjamini & Hochberg (1995) textbook example', () => {
  const r = benjaminiHochberg(BH95, 0.05);
  assert.equal(r.nRejected, 4);
  assert.deepEqual(r.rejected, BH95.map((_, i) => i < 4));
  assert.ok(close(r.threshold, (4 / 15) * 0.05));
  // Adjusted p-values (as R's p.adjust(method = "BH")), including the step-up monotone minimum.
  const expected = [0.0015, 0.003, 0.0095, 0.035625, 0.0603, 0.0638571, 0.0638571, 0.0645, 0.0765, 0.486, 0.5811818, 0.714875, 0.7532308, 0.8132143, 1];
  r.adjusted.forEach((a, i) => assert.ok(close(a, expected[i], 1e-6), `adj[${i}] ${a} vs ${expected[i]}`));
  r.adjusted.forEach((a, i) => assert.equal(r.rejected[i], a <= 0.05));
  assert.equal(benjaminiHochberg(BH95, 0.1).nRejected, 9); // 0.0459 <= 9/15 * 0.1
});

test('BH is order-invariant and handles edge cases', () => {
  const perm = [7, 2, 14, 0, 11, 5, 9, 3, 13, 1, 6, 12, 4, 10, 8];
  const shuffled = perm.map((i) => BH95[i]);
  const base = benjaminiHochberg(BH95, 0.05), r = benjaminiHochberg(shuffled, 0.05);
  perm.forEach((orig, j) => {
    assert.equal(r.rejected[j], base.rejected[orig]);
    assert.ok(close(r.adjusted[j], base.adjusted[orig]));
  });
  assert.equal(benjaminiHochberg([], 0.1).nRejected, 0);
  const withNaN = benjaminiHochberg([0.001, NaN, null, 0.002], 0.1);
  assert.deepEqual(withNaN.rejected, [true, false, false, true]);
  assert.equal(withNaN.adjusted[1], 1);
  assert.equal(benjaminiHochberg([0, 0, 0], 0.1).nRejected, 3);
});

// ---------- bootstrap ----------

function simClusters(rng, nClusters, mu) {
  const items = [];
  for (let c = 0; c < nClusters; c++) {
    const u = randNormal(rng); // shared cluster effect: ICC 0.5
    const m = 1 + randInt(rng, 6);
    for (let i = 0; i < m; i++) items.push({ c, id: items.length, x: mu + u + (-Math.log(1 - rng()) - 1) }); // skewed noise, mean 0
  }
  return items;
}
const meanSums = { mean: (s) => s[1] / s[0] };
const toVec = (it) => [1, it.x];

test('generic and sums cluster bootstraps agree draw-for-draw', () => {
  const items = simClusters(makeRng(3), 40, 0.2);
  const g = clusterBootstrap(items, (it) => it.c, (xs) => mean(xs.map((x) => x.x)), { B: 300, seed: 9 });
  const s = clusterBootstrapSums(items, (it) => it.c, toVec, meanSums, { B: 300, seed: 9 }).stats.mean;
  for (const k of ['estimate', 'lo', 'hi', 'se', 'p']) assert.ok(close(g[k], s[k], 1e-9), `${k}: ${g[k]} vs ${s[k]}`);
  assert.equal(g.nClusters, 40);
});

test('cluster bootstrap 95% CI covers the true mean about 95% of the time; an iid bootstrap does not', () => {
  const mu = 0.3, sims = 400, rng = makeRng(2024, 'coverage');
  let clusterCover = 0, naiveCover = 0;
  for (let s = 0; s < sims; s++) {
    const items = simClusters(rng, 80, mu);
    const cb = clusterBootstrapSums(items, (it) => it.c, toVec, meanSums, { B: 400, seed: [s, 'c'] }).stats.mean;
    const nb = clusterBootstrapSums(items, (it) => it.id, toVec, meanSums, { B: 400, seed: [s, 'n'] }).stats.mean;
    if (cb.lo <= mu && mu <= cb.hi) clusterCover++;
    if (nb.lo <= mu && mu <= nb.hi) naiveCover++;
  }
  const cov = clusterCover / sims, naive = naiveCover / sims;
  assert.ok(cov >= 0.9 && cov <= 0.985, `cluster coverage ${cov}`);
  assert.ok(naive < 0.88 && naive < cov - 0.05, `naive coverage ${naive} vs cluster ${cov}`);
});

test('one-sided bootstrap p-value is calibrated under the null and floors at 1/(B+1)', () => {
  const rng = makeRng(77, 'null');
  let rejections = 0;
  const sims = 400;
  for (let s = 0; s < sims; s++) {
    const items = simClusters(rng, 80, 0);
    if (clusterBootstrapSums(items, (it) => it.c, toVec, meanSums, { B: 400, seed: [s, 'p'] }).stats.mean.p <= 0.05) rejections++;
  }
  const rate = rejections / sims;
  assert.ok(rate >= 0.02 && rate <= 0.09, `null rejection rate ${rate}`);
  const strong = clusterBootstrapSums(simClusters(makeRng(5), 80, 3), (it) => it.c, toVec, meanSums, { B: 999 }).stats.mean;
  assert.equal(strong.p, 1 / 1000);
  assert.equal(bootstrapPValue([1, 2, -1, NaN], 0), 2 / 4);
  assert.equal(bootstrapPValue([], 0), 1);
});

// ---------- cost model ----------

test('cost model: haircut, fee, cap and pnl', () => {
  assert.ok(close(entryCost(0.5, 0.01, 0.01), 0.5151));
  assert.ok(close(entryCost(0.3, 0, 0), 0.3));
  assert.equal(entryCost(0.995, 0.01, 0.01), 0.999);
  assert.ok(close(betPnl(1, 0.5), 1));
  assert.equal(betPnl(0, 0.5), -1);
  // cost >= 0.99 rows are never bet, even when they would win
  const rows = [0.985, 0.98, 0.97].map((price, i) => prepareRow({ id: `r${i}`, eventKey: 'e', startTs: 100 * H, decisionTs: 99 * H, offsetH: 1, price, won: 1 }));
  const c = chooseParams(hyp('baseline-all'), [{ offsetH: 1, params: {} }], rows, { ...DEFAULTS, minN: 1 });
  assert.equal(c.trainN, 1); // only 0.97: (0.97 + 0.01) * 1.01 = 0.9898
});

// ---------- folds & walk-forward ----------

test('folds are time-ordered, keep whole events together and are roughly balanced', () => {
  const rows = genRows({ nEvents: 500, seed: 3 }).map(prepareRow);
  const folds = assignFolds(rows, 5);
  const foldOfEvent = new Map();
  for (const r of rows) {
    const prev = foldOfEvent.get(r.f.eventKey);
    if (prev != null) assert.equal(prev, r.fold, `event ${r.f.eventKey} split across folds`);
    foldOfEvent.set(r.f.eventKey, r.fold);
  }
  for (let k = 1; k < 5; k++) assert.ok(folds[k - 1].startMax <= folds[k].startMin, `fold ${k - 1} overlaps fold ${k}`);
  for (const f of folds) assert.ok(Math.abs(f.rows.length - rows.length / 5) < rows.length * 0.05);
  assert.throws(() => assignFolds(rows.slice(0, 8), 5), /non-empty/);
});

test('walk-forward selection only sees rows from earlier folds, outside the embargo, without labels (instrumented)', () => {
  const rows = genRows({ nEvents: 400, seed: 11 }).map(prepareRow);
  const folds = assignFolds(rows, 5);
  const foldOf = new Map(rows.map((r) => [r.f.id, r.fold]));
  const o = { ...DEFAULTS, minN: 10 };
  for (const id of ['favorite-longshot', 'momentum-fade-6h', 'wallet-surge']) {
    const base = hyp(id);
    const log = [];
    let phase = null, k = -1;
    const spy = { ...base, select: (r, p) => { log.push({ phase, k, id: r.id, startTs: r.startTs, sawLabel: LABEL_FIELDS.some((f) => f in r) }); return base.select(r, p); } };
    const wf = walkForward(spy, folds, o, { onPhase: (ph, fold) => { phase = ph; k = fold; } });
    const train = log.filter((x) => x.phase === 'train'), testCalls = log.filter((x) => x.phase === 'test');
    assert.ok(train.length > 0 && testCalls.length > 0, `${id}: both phases exercised`);
    assert.equal(log.filter((x) => x.phase == null).length, 0, 'select called outside a phase');
    for (const x of train) {
      assert.ok(foldOf.get(x.id) < x.k, `${id}: fold ${x.k} selection saw row ${x.id} from fold ${foldOf.get(x.id)}`);
      assert.ok(x.startTs + o.embargoH * H <= folds[x.k].decisionMin, `${id}: embargo violated by ${x.id}`);
    }
    for (const x of testCalls) assert.equal(foldOf.get(x.id), x.k);
    assert.ok(log.every((x) => !x.sawLabel), 'a hypothesis saw a label field');
    for (let kk = 1; kk < 5; kk++) {
      const seen = new Set(train.filter((x) => x.k === kk).map((x) => x.id));
      const embargoed = rows.filter((r) => r.fold < kk && r.f.startTs + o.embargoH * H > folds[kk].decisionMin);
      assert.ok(embargoed.length > 0, 'embargo should bite at every boundary in this fixture');
      assert.ok(embargoed.every((r) => !seen.has(r.f.id)));
    }
    for (const pf of wf.perFold) for (const r of pf.picks) assert.equal(r.fold, pf.fold);
  }
});

test('walk-forward choices are unchanged when labels of the test fold and later are scrambled', () => {
  const o = { ...DEFAULTS, minN: 20 };
  const h = hyp('favorite-longshot');
  const make = () => { const rows = genRows({ nEvents: 600, seed: 5 }).map(prepareRow); return { rows, folds: assignFolds(rows, 5) }; };
  const ref = walkForward(h, make().folds, o).perFold.map((f) => f.chosen);
  assert.ok(ref.every(Boolean), 'fixture should give a choice in every fold');
  for (let j = 1; j < 5; j++) {
    const { rows, folds } = make();
    for (const r of rows) if (r.fold >= j) r.won = 1 - r.won;
    const got = walkForward(h, folds, o).perFold.map((f) => f.chosen);
    for (let k = 1; k <= j; k++) assert.deepEqual(got[k - 1], ref[k - 1], `fold ${k} choice changed when folds >= ${j} were scrambled`);
  }
  // Teeth: a selector allowed to see the scrambled rows does change its choice.
  const cands = h.offsets.flatMap((offsetH) => h.paramGrid.map((params) => ({ offsetH, params })));
  const clean = make(), dirty = make();
  for (const r of dirty.rows) if (r.fold >= 1) r.won = 1 - r.won;
  assert.notDeepEqual(chooseParams(h, cands, dirty.rows, o), chooseParams(h, cands, clean.rows, o));
});

// ---------- hypotheses ----------

test('hypothesis library: shape, null-safe trade/momentum features, per-sport variants', () => {
  const ids = new Set();
  for (const h of BASE_HYPOTHESES) {
    assert.ok(h.id && h.name && h.rationale && Array.isArray(h.offsets) && h.paramGrid.length && typeof h.select === 'function', h.id);
    assert.ok(!ids.has(h.id), `duplicate id ${h.id}`);
    ids.add(h.id);
  }
  for (const id of ['baseline-all', 'favorite-longshot', 'longshot-buy', 'under-totals', 'under-props', 'over-control', 'momentum-follow-6h',
    'momentum-fade-6h', 'momentum-follow-24h', 'late-steam', 'large-flow-follow', 'large-flow-fade', 'wallet-surge', 'overround-cheap-side', 'cheap-favorite']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const nullRow = { price: 0.5, sport: 'nba', marketType: 'moneyline', sideType: 'team', mom6h: null, mom24h: null, complementPrice: null, overround: null,
    nTrades24h: null, netBuyNotional24h: null, largeNetNotional24h: null, distinctWallets24h: null, topWalletShare24h: null };
  for (const h of BASE_HYPOTHESES.filter((x) => x.trades || x.requires.length)) {
    for (const p of h.paramGrid) assert.equal(h.select(nullRow, p), false, `${h.id} selected a row with null features`);
  }
  assert.equal(hyp('large-flow-fade').select({ ...nullRow, largeNetNotional24h: -5000 }, { th: 3000 }), true);
  assert.equal(hyp('momentum-follow-6h').select({ ...nullRow, mom6h: 0 }, { th: 0.02 }), false);
  assert.deepEqual(grid({ a: [1, 2], b: ['x'] }), [{ a: 1, b: 'x' }, { a: 2, b: 'x' }]);
  const all = buildHypotheses({ sports: ['nba'] });
  const v = all.find((h) => h.id === 'favorite-longshot@nba');
  assert.ok(v && v.baseId === 'favorite-longshot' && v.sport === 'nba');
  assert.equal(v.select({ ...nullRow, price: 0.8 }, { lo: 0.7, hi: 0.85 }), true);
  assert.equal(v.select({ ...nullRow, price: 0.8, sport: 'nfl' }, { lo: 0.7, hi: 0.85 }), false);
  assert.ok(Object.isFrozen(prepareRow({ id: 'x', price: 0.5, won: 1, volume: 9, clv: 0.1, closePrice: 0.6 }).f));
  const f = prepareRow({ id: 'x', price: 0.5, won: 1, volume: 9, clv: 0.1, closePrice: 0.6 }).f;
  for (const k of [...LABEL_FIELDS, 'volume']) assert.ok(!(k in f), `${k} leaked into features`);
});

// ---------- end to end ----------

test('end-to-end on null synthetic data: nothing survives and the report says so', async () => {
  const dir = path.join(root, 'null');
  const data = path.join(dir, 'dataset.jsonl');
  writeJsonl(data, genRows({ nEvents: 2000, seed: 21 }));
  const label = 'SYNTHETIC null-edge test data';
  const { report, jsonPath, mdPath } = await runBacktest({ data, out: dir, name: 'null', sourceLabel: label, boot: 1000, minSportMarkets: 200 });
  assert.deepEqual(report.verdict.survivors, [], `false survivors: ${report.verdict.survivors}`);
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.ok(md.split('\n')[0].includes(label), 'markdown header must carry the source label');
  assert.match(md, /No hypothesis survived/);
  assert.match(md, /SYNTHETIC \/ MOCK DATA/);
  assert.match(report.verdict.text, /minimum detectable ROI \(80% power\) of the candidates ranged from/, 'a no-edge verdict must state its power');
  assert.match(md, /\| MDE80 \|/);
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(json.source.label, label);
  assert.equal(json.source.looksSynthetic, true);
  const base = json.hypotheses.find((h) => h.id === 'baseline-all');
  assert.ok(base.oos.roi.estimate < 0, `baseline ROI ${base.oos.roi.estimate}`);
  assert.ok(Math.abs(base.oos.roi.estimate - base.oos.hurdleRoi) < 3 * base.oos.roi.se + 0.005, 'baseline should lose about the cost drag');
  assert.ok(json.hypotheses.some((h) => h.id === 'momentum-fade-6h@nfl' && h.status === 'tested'));
  assert.equal(json.hypotheses.find((h) => h.id === 'under-props').status, 'skipped');
  assert.equal(json.bh.m, json.hypotheses.filter((h) => h.status === 'tested').length);
  const tested = json.hypotheses.filter((h) => h.status === 'tested');
  assert.ok(tested.every((h) => h.sensitivity.map((s) => s.spread).join() === '0,0.01,0.02'));
  // more spread can only hurt the same picks
  for (const h of tested.filter((x) => x.oos.n)) assert.ok(h.sensitivity[0].roi >= h.sensitivity[2].roi - 1e-12, h.id);
  assert.ok(json.calibration.moneyline && json.calibration.total);
});

test('end-to-end with a planted favorite edge: favorite-longshot survives', async () => {
  const dir = path.join(root, 'planted');
  const data = path.join(dir, 'dataset.jsonl');
  writeJsonl(data, genRows({ nEvents: 2000, seed: 22, plant: 0.08 }));
  const { report, mdPath } = await runBacktest({ data, out: dir, name: 'planted', sourceLabel: 'SYNTHETIC planted-edge test data', boot: 1000, minSportMarkets: 200 });
  const fl = report.hypotheses.find((h) => h.id === 'favorite-longshot');
  assert.ok(report.verdict.survivors.includes('favorite-longshot'), `survivors: ${report.verdict.survivors}; fl ${JSON.stringify(fl.verdict)}`);
  assert.ok(fl.oos.roi.lo > 0 && fl.stress.roi > 0 && fl.bh.significant && fl.oos.n >= 50);
  for (const id of ['baseline-all', 'longshot-buy']) assert.ok(!report.verdict.survivors.includes(id), `${id} should not survive`);
  assert.equal(report.verdict.sanityFailed, false);
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.match(md, /\*\*SURVIVES\*\*/);
  assert.match(md, /## Survivors/);
  assert.match(md, /Synthetic data: this run validates the tooling only/);
});

test('CLI: requires --source-label, skips trade hypotheses without trades, validates --only', () => {
  const dir = path.join(root, 'cli');
  const data = path.join(dir, 'dataset.jsonl');
  writeJsonl(data, genRows({ nEvents: 250, seed: 31, trades: false }));
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--data', data, '--out', dir, ...args], { encoding: 'utf8' });

  const missing = run('--boot', '50');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--source-label is required/);

  const ok = run('--source-label', 'synthetic cli fixture', '--boot', '200', '--min-n', '20', '--name', 'cli');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /data source: synthetic cli fixture/);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'cli.json'), 'utf8'));
  for (const id of ['large-flow-follow', 'large-flow-fade', 'wallet-surge']) {
    const h = json.hypotheses.find((x) => x.id === id);
    assert.equal(h.status, 'skipped');
    assert.match(h.skipReason, /trade features not collected/);
  }
  assert.ok(json.warnings.some((w) => /Only 250 events/.test(w)));
  assert.ok(fs.readFileSync(path.join(dir, 'cli.md'), 'utf8').startsWith('# Sports edge backtest | data source: synthetic cli fixture'));

  const only = run('--source-label', 'synthetic', '--boot', '100', '--min-n', '20', '--only', 'favorite-longshot,baseline-all', '--name', 'only');
  assert.equal(only.status, 0, only.stderr);
  const oj = JSON.parse(fs.readFileSync(path.join(dir, 'only.json'), 'utf8'));
  assert.deepEqual(oj.hypotheses.map((h) => h.id), ['baseline-all', 'favorite-longshot']);
  assert.ok(oj.warnings.some((w) => /--only narrowed the BH family/.test(w)));

  const bad = run('--source-label', 'synthetic', '--only', 'no-such-thing');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown hypothesis id/);
  assert.notEqual(run('--source-label', 'x', '--folds', '1').status, 0);
  assert.notEqual(run('--source-label', 'x', '--bogus', '1').status, 0);
});

test('provenance: synthetic data is labelled SYNTHETIC even under a "real" label', async () => {
  const rows = genRows({ nEvents: 300, seed: 41, trades: false });
  const dir = path.join(root, 'prov-synth');
  const data = path.join(dir, 'dataset.jsonl');
  writeJsonl(data, rows);
  fs.writeFileSync(path.join(dir, 'dataset.summary.json'), JSON.stringify({ dataDir: dir, provenance: { status: 'synthetic', collectRuns: 1, syntheticRuns: 1, syntheticMarkets: 0, bases: ['http://127.0.0.1:1/gamma'], reasons: ['research/collect.js: API bases were overridden'] } }));
  const { report, mdPath } = await runBacktest({ data, out: dir, name: 'p', sourceLabel: 'real: Polymarket', boot: 200, minN: 20 });
  assert.equal(report.source.labelLooksSynthetic, false);
  assert.equal(report.source.looksSynthetic, true);
  assert.match(report.verdict.text, /^Synthetic data: this run validates the tooling only/);
  assert.ok(report.warnings.some((w) => /does not say synthetic, but the data's provenance does/.test(w)));
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.match(md.split('\n')[0], /\[SYNTHETIC per provenance\]$/);
  assert.match(md, /SYNTHETIC \/ MOCK DATA/);

  // No summary: collect-runs.jsonl beside the dataset is read directly.
  const realDir = path.join(root, 'prov-real');
  const realData = path.join(realDir, 'dataset.jsonl');
  writeJsonl(realData, rows);
  const bases = { gamma: 'https://gamma-api.polymarket.com', clob: 'https://clob.polymarket.com', data: 'https://data-api.polymarket.com' };
  fs.writeFileSync(path.join(realDir, 'collect-runs.jsonl'), JSON.stringify({ synthetic: null, bases }) + '\n');
  const real = await runBacktest({ data: realData, out: realDir, name: 'r', sourceLabel: 'real: Polymarket', boot: 200, minN: 20 });
  assert.equal(real.report.source.provenance.status, 'polymarket-api');
  assert.equal(real.report.source.looksSynthetic, false);
  assert.ok(!/Synthetic data/.test(real.report.verdict.text));

  // Neither: provenance unknown, flagged as unverified.
  const unkDir = path.join(root, 'prov-unknown');
  const unkData = path.join(unkDir, 'dataset.jsonl');
  writeJsonl(unkData, rows);
  const unk = await runBacktest({ data: unkData, out: unkDir, name: 'u', sourceLabel: 'my data', boot: 200, minN: 20 });
  assert.equal(unk.report.source.provenance.status, 'unknown');
  assert.match(unk.report.verdict.text, /^Unverified data source/);
  assert.match(fs.readFileSync(unk.mdPath, 'utf8'), /PROVENANCE UNVERIFIED/);
});
