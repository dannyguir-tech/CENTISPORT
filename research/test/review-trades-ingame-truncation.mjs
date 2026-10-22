// REVIEW REPRO (data integrity): in-game trades fill --max-trades-per-market, so the pre-game
// trades that every trade feature is computed from are dropped, and build-dataset then emits
// zero-valued trade features (not null) for a market that had heavy pre-game flow.
// SYNTHETIC mock data only. Run: node research/test/review-trades-ingame-truncation.mjs
// Exit 1 = bug reproduced, 0 = fixed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, startMockServer } from './mock-server.js';
import { buildDataset } from '../build-dataset.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, '..', 'collect.js');
const HOUR = 3600;

// Async spawn: the mock server lives in this process, so spawnSync would deadlock it.
function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('error', reject);
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const fixture = buildFixture({ nEvents: 3, seed: 11 });
const entry = fixture.entries.find((e) => e.meta.kind === 'ok' && e.meta.type === 'moneyline' && e.meta.eventIndex === 1);
const { cid, gs, tokenIds } = entry.meta;

// 3200 trades during the game (live betting) + 300 trades 2-20h before tip-off.
const trades = [];
const mk = (k, t, wallet) => ({
  proxyWallet: wallet, side: 'BUY', asset: tokenIds[0], conditionId: cid, size: 2000, price: 0.6,
  timestamp: t, outcomeIndex: 0, transactionHash: `0x${k.toString(16).padStart(64, '0')}`,
});
for (let k = 0; k < 3200; k++) trades.push(mk(k, gs + 60 + Math.floor((k * (2 * HOUR - 120)) / 3200), `0xingame${k % 50}`));
for (let k = 0; k < 300; k++) trades.push(mk(10000 + k, gs - 20 * HOUR + Math.floor((k * 18 * HOUR) / 300), `0xpre${k % 80}`));
trades.sort((a, b) => b.timestamp - a.timestamp); // data-api: newest first
fixture.tradesCache.set(cid, trades);

const srv = await startMockServer({ fixture, faults: false });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-trunc-'));
try {
  const slugs = path.join(dir, 'slugs.txt');
  fs.writeFileSync(slugs, `${entry.event.slug}\n`);
  const r = await runNode([COLLECT, '--data-dir', dir, '--strategy', 'event-slugs', '--event-slugs', slugs, '--trades',
    '--rps', '500', '--concurrency', '8', '--retry-base-ms', '5', '--quiet'], srv.env);
  if (r.status !== 0) throw new Error(`collect failed: ${r.stderr}`);

  const rec = fs.readFileSync(path.join(dir, 'markets.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((m) => m.conditionId === cid);
  const kept = fs.readFileSync(path.join(dir, 'trades', `${cid}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const preKept = kept.filter((t) => t.t <= gs - HOUR).length;
  console.log(`collector: tradesInfo=${JSON.stringify(rec.tradesInfo)}; kept ${kept.length} trades, ${preKept} of them at/before gs-1h (300 exist)`);

  await buildDataset({ dataDir: dir });
  const rows = fs.readFileSync(path.join(dir, 'dataset.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.conditionId === cid && x.outcomeIndex === 0);
  let bug = false;
  for (const row of rows.sort((a, b) => a.offsetH - b.offsetH)) {
    const truth = trades.filter((t) => t.timestamp <= row.decisionTs && t.timestamp > row.decisionTs - 24 * HOUR);
    const trueNet = truth.reduce((s, t) => s + t.size * t.price, 0);
    console.log(`offset ${row.offsetH}h: nTrades24h=${row.nTrades24h} (true ${truth.length}), largeNetNotional24h=${row.largeNetNotional24h} (true ${trueNet}), distinctWallets24h=${row.distinctWallets24h}`);
    if (truth.length > 0 && row.nTrades24h !== null && row.nTrades24h < truth.length) bug = true;
  }
  if (bug) {
    console.log('BUG REPRODUCED: truncated trade tape kept only in-game trades; builder reports non-null, undercounted pre-game trade features despite tradesInfo.truncated=true');
    process.exitCode = 1;
  } else console.log('OK: trade features are complete or nulled when the tape does not cover the window');
} finally {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
