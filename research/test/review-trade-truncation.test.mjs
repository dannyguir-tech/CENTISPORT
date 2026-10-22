// REVIEW REPRO (statistical rigor): decision-time trade features depend on trades AFTER decisionTs.
//
// collect.js pages /trades newest-first and keeps the newest --max-trades-per-market (3000) trades
// in [start-78h, start+2h]. A market with heavy in-game trading fills the cap with in-game trades
// and loses its pre-game tape. build-dataset.js ignores tradesInfo.truncated / oldestT and computes
// the 24h window features from whatever is on disk, so the pre-game features come out as 0 (not
// null). Two markets identical up to every decision time then get different features purely
// because one traded more after kickoff: look-ahead by construction. Trade hypotheses
// (large-flow-*, wallet-surge) silently drop exactly the markets with the most in-game action.
//
// Run: node --test research/test/review-trade-truncation.test.mjs
// Expected today: FAILS (feature of the busy market is 0 instead of matching or being null).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { run as runCollect } from '../collect.js';
import { buildDataset } from '../build-dataset.js';

const HOUR = 3600;
const START = Date.UTC(2025, 5, 1, 0, 0, 0) / 1000;
const pg = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00');

function market(cid) {
  return {
    conditionId: cid, question: `[SYNTHETIC] Team ${cid} vs. Rival ${cid}`, slug: `nba-${cid}`,
    outcomes: '["Team","Rival"]', clobTokenIds: `["${cid}t0","${cid}t1"]`, outcomePrices: '["1","0"]',
    closed: true, gameStartTime: pg(START), startDate: new Date((START - 5 * 24 * HOUR) * 1000).toISOString(),
    endDate: new Date((START + 7 * 24 * HOUR) * 1000).toISOString(), closedTime: pg(START + 4 * HOUR),
  };
}

// Same 100 pre-game trades for both markets; "busy" also has 4000 in-game trades.
function tradesFor(cid) {
  const out = [];
  for (let i = 0; i < 100; i++) {
    out.push({ conditionId: cid, asset: `${cid}t0`, side: 'BUY', size: 50, price: 0.6, timestamp: START - 10 * HOUR + i * 300, proxyWallet: `0xw${i % 40}`, transactionHash: `${cid}-pre-${i}` });
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
  const tapes = { quiet: tradesFor('quiet'), busy: tradesFor('busy') };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams;
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/gamma/events') return send(Number(q.get('offset')) > 0 ? [] : events);
    if (u.pathname === '/clob/prices-history') {
      const a = Number(q.get('startTs')), b = Number(q.get('endTs'));
      const tok = q.get('market');
      const history = [];
      for (let t = Math.ceil(a / 900) * 900; t <= b; t += 900) history.push({ t, p: tok.endsWith('t0') ? 0.6 : 0.4 });
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

const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

test('decision-time trade features must not depend on post-decision trading volume', async () => {
  const api = await startApi();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-trunc-'));
  try {
    await runCollect(['--data-dir', dir, '--trades', '--since', '2025-01-01', '--until', '2025-12-31', '--quiet', '--rps', '500', '--retry-base-ms', '5'],
      { env: { ...process.env, ...api.env }, stdout: sink(), stderr: sink() });
    const markets = readFileSync(path.join(dir, 'markets.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const info = Object.fromEntries(markets.map((m) => [m.conditionId, m.tradesInfo]));
    await buildDataset({ dataDir: dir });
    const rows = Object.fromEntries(readFileSync(path.join(dir, 'dataset.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
    const pick = (id) => { const r = rows[id]; return { nTrades24h: r.nTrades24h, netBuyNotional24h: r.netBuyNotional24h, distinctWallets24h: r.distinctWallets24h }; };
    const quiet = pick('quiet|0|3'), busy = pick('busy|0|3');
    console.log('tradesInfo', JSON.stringify(info));
    console.log('offset 3h features  quiet:', JSON.stringify(quiet), ' busy:', JSON.stringify(busy));
    // The collector knows the busy tape is truncated (oldest kept trade is after kickoff) ...
    assert.equal(info.busy.truncated, true);
    assert.ok(info.busy.oldestT > START, 'busy tape lost every pre-game trade');
    // ... but the dataset reports a confident 0 instead of matching the quiet market or being null.
    const ok = busy.nTrades24h === null || busy.nTrades24h === quiet.nTrades24h;
    assert.ok(ok, `busy market's pre-game nTrades24h is ${busy.nTrades24h} (quiet: ${quiet.nTrades24h}); identical pre-decision history, different feature => look-ahead via truncation`);
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
