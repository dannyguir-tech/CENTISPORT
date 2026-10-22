// REVIEW REPRO (resume robustness): the README's real-run recipe does a smoke test WITHOUT
// --trades and then the full run WITH --trades into the same data dir. Markets from the smoke
// test are "already collected", so their trades are never fetched and nothing warns.
// SYNTHETIC mock data only. Run: node research/test/review-trades-not-backfilled.mjs
// Exit 1 = bug reproduced, 0 = fixed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, startMockServer } from './mock-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, '..', 'collect.js');

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('error', reject);
    c.on('close', (status) => resolve({ status, summary: JSON.parse(stdout.trim().split('\n').pop() || 'null'), stderr }));
  });
}

const srv = await startMockServer({ fixture: buildFixture({ nEvents: 10, seed: 5 }), faults: false });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-backfill-'));
try {
  const base = ['--data-dir', dir, '--since', '2025-01-01', '--rps', '500', '--concurrency', '8', '--retry-base-ms', '5'];
  await runNode([COLLECT, ...base, '--max-markets', '5', '--quiet'], srv.env); // smoke test
  const full = await runNode([COLLECT, ...base, '--trades', '--max-markets', '15'], srv.env); // full run
  const markets = fs.readFileSync(path.join(dir, 'markets.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const missing = markets.filter((m) => !fs.existsSync(path.join(dir, 'trades', `${m.conditionId}.jsonl`)));
  console.log(`full --trades run: kept ${full.summary.kept}, alreadyCollected ${full.summary.alreadyCollected}; ${missing.length}/${markets.length} markets have no trades file`);
  console.log(`warning about missing trades in stderr: ${/trade/i.test(full.stderr.replace(/trades: \d+ markets fetched.*/, '')) ? 'yes' : 'no'}`);
  if (missing.length) {
    console.log('BUG REPRODUCED: --trades on a resumed data dir silently skips trades for markets collected earlier without --trades');
    process.exitCode = 1;
  } else console.log('OK: trades were backfilled');
} finally {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
