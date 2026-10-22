// Review R1 + DI-1 (permanent): decision-time trade features must not depend on trading after the
// decision. The collector pages /trades newest-first; it used to keep in-game trades and stop at
// --max-trades-per-market, so a market with heavy live betting lost its whole pre-game tape and the
// builder then reported 0 (not null) for every trade feature. Now in-game trades are paged through
// but never kept or counted, tradesInfo records how far back the tape is complete, and the builder
// nulls any row whose 24h window the tape does not cover. SYNTHETIC data only.
// Run: node --test research/test/review-trade-truncation.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { run as runCollect } from '../collect.js';
import { buildDataset, tradeFeatures } from '../build-dataset.js';
import { buildFixture, startMockServer } from './mock-server.js';

const HOUR = 3600;
const START = Date.UTC(2025, 5, 1, 0, 0, 0) / 1000;
const pg = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00');
const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
const readJsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const FLOW = ['nTrades24h', 'netBuyNotional24h', 'largeNetNotional24h', 'distinctWallets24h', 'topWalletShare24h'];
const flowOf = (r) => Object.fromEntries(FLOW.map((k) => [k, r[k]]));
const isNullFlow = (r) => FLOW.every((k) => r[k] === null);

// ---------- two markets with identical pre-game tapes; one also has heavy live betting ----------

function market(cid) {
  return {
    conditionId: cid, question: `[SYNTHETIC] Team ${cid} vs. Rival ${cid}`, slug: `nba-${cid}`,
    outcomes: '["Team","Rival"]', clobTokenIds: `["${cid}t0","${cid}t1"]`, outcomePrices: '["1","0"]',
    closed: true, gameStartTime: pg(START), startDate: new Date((START - 5 * 24 * HOUR) * 1000).toISOString(),
    endDate: new Date((START + 7 * 24 * HOUR) * 1000).toISOString(), closedTime: pg(START + 4 * HOUR),
  };
}

function tapeFor(cid) {
  const out = [];
  for (let i = 0; i < 100; i++) {
    out.push({ conditionId: cid, asset: `${cid}t0`, side: 'BUY', size: 50, price: 0.6, timestamp: START - 10 * HOUR + i * 300, proxyWallet: `0xw${i % 40}`, transactionHash: `pre-${i}` });
  }
  if (cid === 'busy') {
    for (let i = 0; i < 4000; i++) {
      out.push({ conditionId: cid, asset: `${cid}t${i % 2}`, side: 'BUY', size: 5, price: 0.5, timestamp: START + 60 + i, proxyWallet: `0xg${i % 300}`, transactionHash: `${cid}-live-${i}` });
    }
  }
  return out.sort((a, b) => b.timestamp - a.timestamp); // data-api order: newest first
}

function startApi() {
  const events = ['quiet', 'busy'].map((cid) => ({
    id: cid, slug: `nba-${cid}-2025-06-01`, title: `[SYNTHETIC] ${cid}`, startDate: pg(START - 5 * 24 * HOUR),
    endDate: pg(START + 7 * 24 * HOUR), tags: [{ slug: 'nba', label: 'NBA' }], series: [{ slug: 'nba' }], markets: [market(cid)],
  }));
  const tapes = { quiet: tapeFor('quiet'), busy: tapeFor('busy') };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams;
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/gamma/events') return send(Number(q.get('offset')) > 0 ? [] : events);
    if (u.pathname === '/clob/prices-history') {
      const a = Number(q.get('startTs')), b = Number(q.get('endTs'));
      const history = [];
      for (let t = Math.ceil(a / 900) * 900; t <= b; t += 900) history.push({ t, p: q.get('market').endsWith('t0') ? 0.6 : 0.4 });
      return send({ history });
    }
    if (u.pathname === '/data/trades') {
      const off = Number(q.get('offset')) || 0, lim = Number(q.get('limit')) || 100;
      return send((tapes[q.get('market')] || []).slice(off, off + lim));
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ env: { GAMMA_BASE: `${base}/gamma`, CLOB_BASE: `${base}/clob`, DATA_BASE: `${base}/data` }, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
  }));
}

test('identical pre-decision histories give identical trade features, however busy the game was', async () => {
  const api = await startApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-trunc-'));
  try {
    await runCollect(['--data-dir', dir, '--trades', '--since', '2025-01-01', '--until', '2025-12-31', '--quiet', '--rps', '500', '--retry-base-ms', '5'],
      { env: { ...process.env, ...api.env }, stdout: sink(), stderr: sink() });
    const info = Object.fromEntries(readJsonl(path.join(dir, 'markets.jsonl')).map((m) => [m.conditionId, m.tradesInfo]));
    assert.equal(info.busy.truncated, false, 'live trades no longer fill --max-trades-per-market');
    assert.equal(info.busy.n, 100);
    assert.ok(info.busy.newestT <= START, 'in-game trades are not stored');
    await buildDataset({ dataDir: dir });
    const rows = new Map(readJsonl(path.join(dir, 'dataset.jsonl')).map((r) => [r.id, r]));
    for (const h of [1, 3, 12, 24]) {
      for (const i of [0, 1]) {
        const quiet = rows.get(`quiet|${i}|${h}`), busy = rows.get(`busy|${i}|${h}`);
        assert.deepEqual(flowOf(busy), flowOf(quiet), `offset ${h}h outcome ${i}`);
      }
    }
    assert.equal(rows.get('busy|0|3').nTrades24h, 85, 'non-vacuous: the 3h window holds pre-game trades');
  } finally {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the bundled mock, with tapes that do / do not reach back over the windows ----------

// 3200 live trades in front of `nPre` pre-game trades spread over (gs - preSpanH, gs - 2h].
function injectTape(fixture, entry, nPre, preSpanH) {
  const { cid, gs, tokenIds } = entry.meta;
  const trades = [];
  const mk = (k, t, wallet, tok) => ({ proxyWallet: wallet, side: k % 5 ? 'BUY' : 'SELL', asset: tokenIds[tok], conditionId: cid, size: 2000, price: 0.6,
    timestamp: t, outcomeIndex: tok, transactionHash: `0x${k.toString(16).padStart(64, '0')}` });
  for (let k = 0; k < 3200; k++) trades.push(mk(k, gs + 60 + Math.floor((k * (2 * HOUR - 120)) / 3200), `0xingame${k % 50}`, 0));
  for (let k = 0; k < nPre; k++) trades.push(mk(10000 + k, gs - preSpanH * HOUR + Math.floor((k * (preSpanH - 2) * HOUR) / nPre), `0xpre${k % 80}`, k % 3 ? 0 : 1));
  trades.sort((a, b) => b.timestamp - a.timestamp);
  fixture.tradesCache.set(cid, trades);
  return trades;
}

async function collectAndBuild(maxTradePages, nPre, preSpanH) {
  const fixture = buildFixture({ nEvents: 3, seed: 11 });
  const entry = fixture.entries.find((e) => e.meta.kind === 'ok' && e.meta.type === 'moneyline' && e.meta.eventIndex === 1);
  const tape = injectTape(fixture, entry, nPre, preSpanH);
  const srv = await startMockServer({ fixture, faults: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-trunc-mock-'));
  try {
    const slugs = path.join(dir, 'slugs.txt');
    fs.writeFileSync(slugs, `${entry.event.slug}\n`);
    await runCollect(['--data-dir', dir, '--strategy', 'event-slugs', '--event-slugs', slugs, '--trades', '--max-trade-pages', String(maxTradePages),
      '--rps', '500', '--concurrency', '8', '--retry-base-ms', '5', '--quiet'], { env: srv.env, stdout: sink(), stderr: sink() });
    const rec = readJsonl(path.join(dir, 'markets.jsonl')).find((m) => m.conditionId === entry.meta.cid);
    const summary = await buildDataset({ dataDir: dir });
    const rows = readJsonl(path.join(dir, 'dataset.jsonl')).filter((x) => x.conditionId === entry.meta.cid);
    // Truth from the full tape over the same window, (price time - 24h, price time].
    const full = tape.map((t) => ({ t: t.timestamp, asset: t.asset, side: t.side, size: t.size, price: t.price, wallet: t.proxyWallet })).sort((a, b) => a.t - b.t);
    const truth = (r) => tradeFeatures(full, entry.meta.tokenIds, r.outcomeIndex, r.decisionTs - r.priceAgeSec, 1000);
    return { rec, summary, rows, truth };
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('complete tape behind heavy live betting: pre-game features are exact', async () => {
  const { rec, rows, truth } = await collectAndBuild(30, 300, 20);
  assert.equal(rec.tradesInfo.truncated, false);
  assert.ok(rows.length >= 6);
  for (const r of rows) assert.deepEqual(flowOf(r), truth(r), r.id);
  assert.ok(rows.some((r) => r.nTrades24h >= 280 && r.largeNetNotional24h !== 0), `non-vacuous: ${rows.map((r) => `${r.id} n=${r.nTrades24h} large=${r.largeNetNotional24h}`).join('; ')}`);
});

test('tape cut off inside the live trades: every trade feature is null, never 0', async () => {
  const { rec, summary, rows } = await collectAndBuild(4, 300, 20);
  assert.equal(rec.tradesInfo.truncated, true);
  assert.equal(rec.tradesInfo.stop, 'max_pages');
  assert.ok(rec.tradesInfo.coverageFromT > rec.tradesInfo.toT, 'nothing before kickoff was reached');
  assert.ok(rows.length >= 6);
  for (const r of rows) assert.ok(isNullFlow(r), `${r.id}: ${JSON.stringify(flowOf(r))}`);
  assert.equal(summary.featureNulls.trades_window_not_covered, rows.length);
});

test('tape cut off part-way through the pre-game trades: covered windows exact, the rest null', async () => {
  // 3200 live + 1200 pre-game over (gs-60h, gs-2h]; 8 pages reach back to about gs - 40h.
  const { rec, rows, truth } = await collectAndBuild(8, 1200, 60);
  assert.equal(rec.tradesInfo.truncated, true);
  const cov = rec.tradesInfo.coverageFromT;
  assert.ok(cov < rec.tradesInfo.toT - 36 * HOUR && cov > rec.tradesInfo.toT - 48 * HOUR, `coverage from ${(rec.tradesInfo.toT - cov) / HOUR}h before start`);
  for (const r of rows) {
    const from = r.decisionTs - r.priceAgeSec - 24 * HOUR;
    if (from >= cov) assert.deepEqual(flowOf(r), truth(r), `${r.id} is covered and must be exact`);
    else assert.ok(isNullFlow(r), `${r.id} is not covered and must be null`);
  }
  const offsets = (pred) => [...new Set(rows.filter(pred).map((r) => r.offsetH))].sort((a, b) => a - b);
  assert.deepEqual(offsets((r) => !isNullFlow(r)), [1, 3, 12]);
  assert.deepEqual(offsets(isNullFlow), [24]);
});
