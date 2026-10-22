// Run: node --test research/test/build-dataset.test.js
// Hand-made fixture with exact expected features, plus leakage tests: data injected one second
// after a decision time must not change any feature at that (or any earlier) decision.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDataset, isSyntheticMarket, parseTime, readProvenance, resolveGameStart } from '../build-dataset.js';
import { classifyMarketType, classifySide } from '../lib/market-type.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'build-dataset.js');
const H = 3600;
const S = Date.UTC(2025, 0, 10) / 1000; // game start for the fixture
const OFFSETS = [1, 3, 12, 24];
const LABELS = new Set(['won', 'closePrice', 'clv']);
const r2 = (x) => Math.round(x * 100) / 100;
const pA = (k) => r2(0.40 + 0.01 * (30 - k));

let root;
const tmpDir = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };

function writeJsonl(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
}
function writePrices(dir, tokenId, points) {
  fs.mkdirSync(path.join(dir, 'prices'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prices', `${tokenId}.json`), JSON.stringify({ tokenId, points }));
}
function addPrice(dir, tokenId, pt) {
  const f = path.join(dir, 'prices', `${tokenId}.json`);
  const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { tokenId, points: [] };
  j.points.push(pt); // appended out of order on purpose; the builder must sort
  fs.writeFileSync(f, JSON.stringify(j));
}
const readRows = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const features = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !LABELS.has(k)));

function market(over) {
  return {
    conditionId: 'c?', question: 'Q', slug: null, eventSlug: null, eventTitle: null, sport: 'nba', tags: ['nba'],
    outcomes: ['A', 'B'], tokenIds: ['x', 'y'], winnerIndex: 0,
    times: { gameStartTime: null, startDate: null, endDate: null, closedTime: null, eventStartDate: null, eventEndDate: null },
    volume: 1000, negRisk: false, collectedAt: 1736000000, ...over,
  };
}

function makeFixture(dir) {
  const ev = 'nba-lal-bos-2025-01-10';
  const markets = [
    market({ conditionId: 'c1', question: 'Lakers vs. Celtics', eventSlug: ev, outcomes: ['Lakers', 'Celtics'], tokenIds: ['tA', 'tB'], winnerIndex: 0, volume: 123456,
      times: { gameStartTime: '2025-01-10 00:00:00+00', startDate: '2025-01-03T00:00:00Z', endDate: '2025-01-17T00:00:00Z', closedTime: '2025-01-10 03:30:00+00', eventStartDate: '2025-01-08T12:00:00Z', eventEndDate: null } }),
    market({ conditionId: 'c2', question: 'Lakers vs. Celtics: O/U 220.5', eventSlug: ev, outcomes: ['Over', 'Under'], tokenIds: ['tO', 'tU'], winnerIndex: 1,
      times: { gameStartTime: null, startDate: null, endDate: null, closedTime: '2025-01-10T04:00:00Z', eventStartDate: '2025-01-10T00:00:00Z', eventEndDate: null } }),
    market({ conditionId: 'c3', times: { gameStartTime: null, endDate: '2025-01-10T00:00:00Z', closedTime: '2025-01-10T04:00:00Z' } }),
    market({ conditionId: 'c4', times: { eventStartDate: '2025-01-10', closedTime: '2025-01-10T04:00:00Z' } }),
    market({ conditionId: 'c5', times: { eventStartDate: '2025-01-05T00:00:00Z', closedTime: '2025-01-10T04:00:00Z' } }),
    market({ conditionId: 'c6', winnerIndex: null, times: { gameStartTime: '2025-01-10T00:00:00Z' } }),
    market({ conditionId: 'c7', times: { gameStartTime: '2025-01-11T00:00:00Z', closedTime: '2025-01-10T04:00:00Z' } }),
    'this is not json',
    market({ conditionId: 'c1', question: 'duplicate line' }),
    market({ conditionId: 'c9', tokenIds: ['nofile1', 'nofile2'], times: { gameStartTime: '2025-01-10T00:00:00Z' } }),
    market({ conditionId: 'c10', question: 'Spread: Lakers (-4.5)', outcomes: ['Lakers', 'Celtics'], tokenIds: ['tS1', 'tS2'], winnerIndex: 1,
      times: { gameStartTime: '2025-01-10T00:00:00Z', closedTime: '2025-01-10T03:00:00Z' } }),
  ];
  writeJsonl(path.join(dir, 'markets.jsonl'), markets);

  const a = [], b = [], o = [], u = [];
  for (let k = 30; k >= 0; k--) {
    a.push({ t: S - k * H - 300, p: pA(k) });
    b.push({ t: S - k * H, p: r2(1.02 - pA(k)) });
    o.push({ t: S - k * H, p: 0.52 });
    if (k >= 20) u.push({ t: S - k * H, p: 0.47 });
  }
  a.push({ t: S + H, p: 0.99 }); // in-game point: must never reach a feature
  writePrices(dir, 'tA', a.reverse());
  writePrices(dir, 'tB', b);
  writePrices(dir, 'tO', o);
  writePrices(dir, 'tU', u);
  writePrices(dir, 'tS1', [{ t: S - 2 * H, p: 0.55 }, { t: S - 1800, p: 0.56 }]);

  const T = (t, asset, side, size, price, wallet) => ({ t, asset, side, size, price, wallet });
  writeJsonl(path.join(dir, 'trades', 'c1.jsonl'), [
    T(S - 2 * H, 'tA', 'BUY', 100, 0.68, 'w1'),
    T(S - 3 * H, 'tA', 'BUY', 2000, 0.67, 'w2'),
    T(S - 5 * H, 'tB', 'BUY', 500, 0.35, 'w3'),
    T(S - 10 * H, 'tA', 'SELL', 50, 0.60, 'w1'),
    T(S - 26 * H, 'tA', 'BUY', 10000, 0.44, 'w4'),
    T(S - 1800, 'tB', 'BUY', 1000, 0.30, 'w5'),
    T(S - 4 * H, 'tA', 'BUY', 10, 0.66, null),
    T(S - 4 * H, 'tZ', 'BUY', 99999, 0.5, 'w9'), // unknown asset: ignored
    '{broken',
  ]);
}

function inject(dir, ts) {
  for (const [tok, p] of [['tA', 0.01], ['tB', 0.99], ['tO', 0.99], ['tU', 0.01], ['tS1', 0.99], ['tS2', 0.01]]) addPrice(dir, tok, { t: ts, p });
  fs.appendFileSync(path.join(dir, 'trades', 'c1.jsonl'),
    JSON.stringify({ t: ts, asset: 'tA', side: 'BUY', size: 1e6, price: 0.5, wallet: 'whale' }) + '\n' +
    JSON.stringify({ t: ts, asset: 'tB', side: 'SELL', size: 5e5, price: 0.5, wallet: 'whale2' }) + '\n');
  const mf = path.join(dir, 'markets.jsonl');
  const lines = fs.readFileSync(mf, 'utf8').split('\n').map((l) => {
    try { const m = JSON.parse(l); m.volume = 1e12; return JSON.stringify(m); } catch { return l; }
  });
  fs.writeFileSync(mf, lines.join('\n'));
}

const approx = (actual, expected, msg) => {
  if (expected == null) return assert.equal(actual, expected, msg);
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-6, `${msg}: expected ${expected}, got ${actual}`);
};
function assertRow(row, exp) {
  assert.ok(row, `missing row ${exp.id}`);
  for (const [k, v] of Object.entries(exp)) {
    if (typeof v === 'number' && !Number.isInteger(v)) approx(row[k], v, `${exp.id}.${k}`);
    else assert.deepEqual(row[k], v, `${exp.id}.${k}`);
  }
}

let base, baseRows, baseSummary;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-dataset-test-'));
  base = tmpDir('base');
  makeFixture(base);
  baseSummary = await buildDataset({ dataDir: base, offsets: OFFSETS });
  baseRows = byId(readRows(path.join(base, 'dataset.jsonl')));
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('time parsing and game-start rule', () => {
  assert.equal(parseTime('2025-01-10 00:00:00+00'), S);
  assert.equal(parseTime('2025-01-10T00:00:00'), S); // no zone -> UTC, not local time
  assert.equal(parseTime('2025-01-09T19:00:00-05'), S);
  assert.equal(parseTime('2025-01-09T19:00:00-0500'), S);
  assert.equal(parseTime(S * 1000), S);
  assert.equal(parseTime('garbage'), null);
  // endDate/closedTime are never used as a start
  assert.deepEqual(resolveGameStart({ endDate: '2025-01-10T00:00:00Z', closedTime: '2025-01-10T04:00:00Z' }), { reason: 'no_game_start' });
  assert.deepEqual(resolveGameStart({ gameStartTime: '2025-01-10T00:00:00Z', eventStartDate: '2025-01-09T00:00:00Z' }), { startTs: S, source: 'gameStartTime' });
  assert.deepEqual(resolveGameStart({ eventStartDate: '2025-01-10T00:00:00Z' }), { reason: 'event_start_unverifiable' });
  assert.deepEqual(resolveGameStart({ eventStartDate: '2025-01-10T05:00:00Z', closedTime: '2025-01-10T04:00:00Z' }), { reason: 'event_start_after_settlement' });
});

test('summary counts rows per offset and drops by reason', () => {
  assert.equal(baseSummary.marketsRead, 11);
  assert.equal(baseSummary.marketsUsed, 3);
  assert.equal(baseSummary.marketsWithTrades, 1);
  assert.equal(baseSummary.rows, 14);
  assert.equal(baseRows.size, 14);
  assert.deepEqual(baseSummary.rowsByOffset, { 1: 4, 3: 3, 12: 3, 24: 4 });
  assert.deepEqual(baseSummary.startSource, { gameStartTime: 2, eventStartDate: 1 });
  assert.deepEqual(baseSummary.marketDrops, {
    no_game_start: 1, event_start_no_time_of_day: 1, event_start_far_from_settlement: 1,
    invalid_record: 2, closed_before_start: 1, duplicate: 1, no_price_files: 1,
  });
  assert.deepEqual(baseSummary.rowDrops, { stale_price: 3, no_price_before_decision: 3, no_price_file: 4 });
  assert.ok(fs.existsSync(path.join(base, 'dataset.summary.json')));
  assert.deepEqual(fs.readdirSync(base).filter((f) => f.includes('.tmp-')), []);
});

test('row schema has exactly the spec fields in order', () => {
  const keys = ['id', 'eventKey', 'conditionId', 'outcomeIndex', 'outcome', 'startTs', 'decisionTs', 'offsetH', 'sport', 'marketType',
    'sideType', 'line', 'price', 'priceAgeSec', 'price_m6h', 'price_m24h', 'mom6h', 'mom24h', 'complementPrice', 'overround',
    'nTrades24h', 'netBuyNotional24h', 'largeNetNotional24h', 'distinctWallets24h', 'topWalletShare24h', 'won', 'closePrice', 'clv'];
  for (const r of baseRows.values()) assert.deepEqual(Object.keys(r), keys);
});

test('moneyline market with trades: exact features', () => {
  const common = { eventKey: 'nba-lal-bos-2025-01-10', conditionId: 'c1', startTs: S, sport: 'nba', marketType: 'moneyline', sideType: 'team', line: null };
  assertRow(baseRows.get('c1|0|1'), { ...common, id: 'c1|0|1', outcomeIndex: 0, outcome: 'Lakers', decisionTs: S - H, offsetH: 1,
    price: 0.69, priceAgeSec: 300, price_m6h: 0.63, price_m24h: 0.45, mom6h: 0.06, mom24h: 0.24, complementPrice: 0.33, overround: 0.02,
    nTrades24h: 5, netBuyNotional24h: 68 + 1340 - 175 - 30 + 6.6, largeNetNotional24h: 1340, distinctWallets24h: 3, topWalletShare24h: 1340 / 1613,
    won: 1, closePrice: 0.70, clv: 0.01 });
  assertRow(baseRows.get('c1|1|1'), { ...common, id: 'c1|1|1', outcomeIndex: 1, outcome: 'Celtics', decisionTs: S - H,
    price: 0.33, priceAgeSec: 0, price_m6h: 0.39, price_m24h: 0.57, mom6h: -0.06, mom24h: -0.24, complementPrice: 0.69, overround: 0.02,
    nTrades24h: 5, netBuyNotional24h: -(68 + 1340 - 175 - 30 + 6.6), largeNetNotional24h: -1340, distinctWallets24h: 3, topWalletShare24h: 1340 / 1613,
    won: 0, closePrice: 0.32, clv: -0.01 });
  // t == decisionTs is included (S-3h trade), window is (decisionTs-24h, decisionTs]
  assertRow(baseRows.get('c1|0|3'), { decisionTs: S - 3 * H, price: 0.67, priceAgeSec: 300, price_m6h: 0.61, price_m24h: 0.43,
    nTrades24h: 5, netBuyNotional24h: 1340 + 6.6 - 175 - 30 + 4400, largeNetNotional24h: 5740, distinctWallets24h: 4, topWalletShare24h: 4400 / 5945, id: 'c1|0|3' });
  assertRow(baseRows.get('c1|0|12'), { id: 'c1|0|12', price: 0.58, nTrades24h: 1, netBuyNotional24h: 4400, largeNetNotional24h: 4400, distinctWallets24h: 1, topWalletShare24h: 1 });
  assertRow(baseRows.get('c1|0|24'), { id: 'c1|0|24', price: 0.46, price_m6h: 0.40, mom6h: 0.06, price_m24h: null, mom24h: null, complementPrice: 0.56, overround: 0.02,
    nTrades24h: 1, netBuyNotional24h: 4400, closePrice: 0.70, clv: 0.24 });
});

test('totals market via eventStartDate, stale complement, no trades -> null trade features', () => {
  const nulls = { nTrades24h: null, netBuyNotional24h: null, largeNetNotional24h: null, distinctWallets24h: null, topWalletShare24h: null };
  assertRow(baseRows.get('c2|0|1'), { id: 'c2|0|1', eventKey: 'nba-lal-bos-2025-01-10', marketType: 'total', sideType: 'over', line: 220.5,
    price: 0.52, priceAgeSec: 0, mom6h: 0, complementPrice: null, overround: null, ...nulls, won: 0, closePrice: 0.52, clv: 0 });
  assertRow(baseRows.get('c2|0|24'), { id: 'c2|0|24', complementPrice: 0.47, overround: -0.01 });
  assertRow(baseRows.get('c2|1|24'), { id: 'c2|1|24', outcome: 'Under', sideType: 'under', line: 220.5, price: 0.47, price_m6h: 0.47, mom6h: 0,
    price_m24h: null, complementPrice: 0.52, overround: -0.01, ...nulls, won: 1, closePrice: 0.47, clv: 0 }); // close = last point <= start, even if stale
  for (const h of [1, 3, 12]) assert.equal(baseRows.has(`c2|1|${h}`), false, `stale c2|1|${h} must be dropped`);
});

test('spread market without eventSlug: eventKey falls back to conditionId', () => {
  assertRow(baseRows.get('c10|0|1'), { id: 'c10|0|1', eventKey: 'c10', marketType: 'spread', sideType: 'team', line: -4.5,
    price: 0.55, priceAgeSec: 3600, price_m6h: null, complementPrice: null, nTrades24h: null, won: 0, closePrice: 0.56, clv: 0.01 });
  assert.equal([...baseRows.keys()].filter((k) => k.startsWith('c10|')).length, 1);
});

for (const h of OFFSETS) {
  test(`LEAKAGE: data at decisionTs+1 for ${h}h leaves every feature at offsets >= ${h}h unchanged`, async () => {
    const dir = tmpDir(`leak-${h}`);
    fs.cpSync(base, dir, { recursive: true });
    inject(dir, S - h * H + 1);
    await buildDataset({ dataDir: dir, offsets: OFFSETS });
    const rows = byId(readRows(path.join(dir, 'dataset.jsonl')));
    const ids = (m) => [...m.keys()].filter((id) => Number(id.split('|')[2]) >= h).sort();
    assert.deepEqual(ids(rows), ids(baseRows), 'row set must not change');
    for (const id of ids(baseRows)) assert.deepEqual(features(rows.get(id)), features(baseRows.get(id)), `features changed for ${id}`);
    // the injected data is genuinely visible to later decisions, so the check above is not vacuous
    const later = OFFSETS.filter((x) => x < h);
    if (later.length) assert.notDeepEqual(features(rows.get(`c1|0|${later[0]}`)), features(baseRows.get(`c1|0|${later[0]}`)));
  });

  test(`boundary: data at exactly decisionTs for ${h}h is used`, async () => {
    const dir = tmpDir(`edge-${h}`);
    fs.cpSync(base, dir, { recursive: true });
    inject(dir, S - h * H);
    await buildDataset({ dataDir: dir, offsets: OFFSETS });
    const rows = byId(readRows(path.join(dir, 'dataset.jsonl')));
    const r = rows.get(`c1|0|${h}`);
    assert.equal(r.price, 0.01);
    assert.equal(r.priceAgeSec, 0);
    assert.equal(r.nTrades24h, baseRows.get(`c1|0|${h}`).nTrades24h + 2);
    assert.equal(r.distinctWallets24h, baseRows.get(`c1|0|${h}`).distinctWallets24h + 2);
  });
}

test('CLI: flags, custom output, summary print', () => {
  const out = path.join(root, 'cli', 'ds.jsonl');
  const res = spawnSync(process.execPath, [SCRIPT, '--data-dir', base, '--offsets', '24,1', '--max-price-age-h=0.5', '--large-trade-usd', '5000', '--out', out], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /rows per offset/);
  assert.match(res.stdout, /market drops/);
  const rows = byId(readRows(out));
  assert.deepEqual([...new Set([...rows.values()].map((r) => r.offsetH))].sort((x, y) => x - y), [1, 24]);
  assert.equal(rows.has('c10|0|1'), false, 'price 1h old must be dropped at --max-price-age-h 0.5');
  assert.equal(rows.get('c1|0|1').priceAgeSec, 300);
  assert.equal(rows.get('c1|0|1').largeNetNotional24h, 0);
  assert.equal(rows.get('c1|0|24').largeNetNotional24h, 0);
  assert.ok(fs.existsSync(path.join(root, 'cli', 'ds.summary.json')));

  const bad = spawnSync(process.execPath, [SCRIPT, '--data-dir', base, '--offsets', '1,x'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--offsets must be a positive number/);
  const unknown = spawnSync(process.execPath, [SCRIPT, '--bogus', '1'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option --bogus/);
});

test('market-type classification (ported from the userscript)', () => {
  assert.equal(classifyMarketType('Lakers vs. Celtics', 'nba'), 'moneyline');
  assert.equal(classifyMarketType('Lakers vs. Celtics: O/U 220.5', 'nba'), 'total');
  assert.equal(classifyMarketType('Spread: Lakers (-4.5)', 'nba'), 'spread');
  assert.equal(classifyMarketType('LeBron James: Points O/U 25.5', 'nba'), 'prop');
  assert.equal(classifyMarketType('Will Patrick Mahomes throw 2+ touchdowns?', 'nfl'), 'prop');
  assert.equal(classifyMarketType('Lakers vs. Celtics Game 1', 'nba'), 'moneyline');
  assert.equal(classifyMarketType('LoL: T1 vs Gen.G - Game 2 Winner', 'lol'), 'map');
  assert.equal(classifyMarketType('CS2: NaVi vs FaZe - Map 1 Winner', 'cs2'), 'map');
  assert.equal(classifyMarketType('Counter-Strike: NaVi vs FaZe - Total Maps O/U 2.5', 'cs2'), 'total');
  assert.equal(classifyMarketType('T1 vs Gen.G', 'lol'), 'moneyline');
  assert.equal(classifyMarketType('Arsenal vs. Chelsea: O/U 2.5', null), 'total');
  assert.equal(classifyMarketType('', 'nba'), 'other');

  assert.deepEqual(classifySide('Spread: Lakers (-4.5)', 'Lakers'), { sideType: 'team', line: -4.5 });
  assert.deepEqual(classifySide('Spread: Lakers (-4.5)', 'Celtics'), { sideType: 'team', line: 4.5 });
  assert.deepEqual(classifySide('Spread: St. Louis Cardinals (-1.5)', 'St Louis Cardinals'), { sideType: 'team', line: -1.5 });
  assert.deepEqual(classifySide('Lakers vs. Celtics: O/U 220.5', 'Over'), { sideType: 'over', line: 220.5 });
  assert.deepEqual(classifySide('Lakers vs. Celtics: O/U 220.5', 'Under'), { sideType: 'under', line: 220.5 });
  assert.deepEqual(classifySide('Will the game go over 220.5 points?', 'Yes'), { sideType: 'over', line: 220.5 });
  assert.deepEqual(classifySide('Will the game go over 220.5 points?', 'No'), { sideType: 'under', line: 220.5 });
  assert.deepEqual(classifySide('Will the Lakers win?', 'Yes'), { sideType: 'yes', line: null });
  assert.deepEqual(classifySide('Will the Lakers win?', 'No'), { sideType: 'no', line: null });
  assert.deepEqual(classifySide('Lakers vs. Celtics', 'Lakers'), { sideType: 'team', line: null });
  assert.deepEqual(classifySide('Lakers vs. Celtics', ''), { sideType: 'other', line: null });
});

test('provenance: collect-runs.jsonl and [SYNTHETIC] markers decide the status', () => {
  const dir = tmpDir('prov');
  assert.equal(readProvenance(dir).status, 'unknown');
  const real = { gamma: 'https://gamma-api.polymarket.com', clob: 'https://clob.polymarket.com', data: 'https://data-api.polymarket.com' };
  fs.writeFileSync(path.join(dir, 'collect-runs.jsonl'), JSON.stringify({ at: 'x', synthetic: null, bases: real }) + '\n');
  const p = readProvenance(dir);
  assert.equal(p.status, 'polymarket-api');
  assert.deepEqual(p.bases, Object.values(real).sort());
  assert.equal(readProvenance(dir, 3).status, 'synthetic', '[SYNTHETIC] markets taint a real-looking dir');
  fs.appendFileSync(path.join(dir, 'collect-runs.jsonl'), JSON.stringify({ synthetic: 'API bases were overridden', bases: { gamma: 'http://127.0.0.1:1/gamma' } }) + '\n');
  const mixed = readProvenance(dir);
  assert.equal(mixed.status, 'synthetic', 'one mock run taints the whole dir');
  assert.equal(mixed.syntheticRuns, 1);
  assert.ok(isSyntheticMarket({ question: '[SYNTHETIC] Lakers vs. Celtics' }));
  assert.ok(isSyntheticMarket({ question: 'Lakers vs. Celtics', eventTitle: '[SYNTHETIC] x' }));
  assert.ok(!isSyntheticMarket({ question: 'Lakers vs. Celtics', eventTitle: null }));

  // buildDataset records it in the summary (the hand-made fixture has no collect-runs.jsonl).
  const summary = JSON.parse(fs.readFileSync(path.join(base, 'dataset.summary.json'), 'utf8'));
  assert.equal(summary.provenance.status, 'unknown');
});
