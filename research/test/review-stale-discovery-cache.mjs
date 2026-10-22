// REVIEW REPRO (resume robustness): discovery responses in raw/ never expire. A market that was
// not yet closed/resolved when first listed keeps being skipped as not_closed on every later
// run, even after it resolves, for --strategy event-slugs (URL has no date) and for events-tag
// with a fixed --until. SYNTHETIC mock data only.
// Run: node research/test/review-stale-discovery-cache.mjs   Exit 1 = bug reproduced, 0 = fixed.
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

const fixture = buildFixture({ nEvents: 8, seed: 3 });
const target = fixture.byCid.get(fixture.tricky.notClosed); // closed=false, outcomePrices 0.62/0.38
const srv = await startMockServer({ fixture, faults: false });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cache-'));
const FAST = ['--rps', '500', '--concurrency', '8', '--retry-base-ms', '5', '--quiet'];
const has = (dir) => {
  const f = path.join(dir, 'markets.jsonl');
  return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(target.meta.cid);
};
let bug = false;
try {
  const slugs = path.join(root, 'slugs.txt');
  fs.writeFileSync(slugs, `${target.event.slug}\n`);
  const modes = {
    'event-slugs': (dir) => ['--data-dir', dir, '--strategy', 'event-slugs', '--event-slugs', slugs, ...FAST],
    'events-tag --until': (dir) => ['--data-dir', dir, '--since', '2025-01-01', '--until', '2025-12-31', '--page-size', '50', ...FAST],
  };
  for (const [name, args] of Object.entries(modes)) {
    // Fresh unresolved state for each mode.
    target.market.closed = false;
    target.market.outcomePrices = '["0.62","0.38"]';
    const dir = path.join(root, name.replace(/\W+/g, '_'));
    const r1 = await runNode([COLLECT, ...args(dir)], srv.env);
    // The game settles; the live API now reports it closed and resolved.
    target.market.closed = true;
    target.market.outcomePrices = target.meta.winnerIndex === 0 ? '["1","0"]' : '["0","1"]';
    const r2 = await runNode([COLLECT, ...args(dir)], srv.env);
    const r3 = await runNode([COLLECT, ...args(dir), '--no-cache'], srv.env);
    console.log(`${name}: run1 not_closed=${r1.summary.skipped.not_closed ?? 0}; after resolution run2 not_closed=${r2.summary.skipped.not_closed ?? 0}, collected=${has(dir) && r2.summary.kept > 0}; run3 --no-cache kept=${r3.summary.kept}`);
    if (r2.summary.kept === 0 && r3.summary.kept > 0) bug = true;
  }
  if (bug) {
    console.log('BUG REPRODUCED: resumed runs serve the stale unresolved snapshot from raw/; the market is collected only with --no-cache');
    process.exitCode = 1;
  } else console.log('OK: resumed runs see the resolved state');
} finally {
  await srv.close();
  fs.rmSync(root, { recursive: true, force: true });
}
