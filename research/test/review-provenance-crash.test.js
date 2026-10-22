// Review DI-2 (permanent): a collect run that does not finish must still leave provenance.
// collect.js used to append its collect-runs.jsonl line only after a clean finish, so a run with
// overridden API bases that crashed (non-retryable HTTP error, bad shape, Ctrl-C) left its markets
// in markets.jsonl with no record, and a later default-base run made the whole dir look like
// polymarket-api data. Now a "started" line (bases, synthetic flag) is written before any market
// and an end line (completed / failed / interrupted) after. The mock's [SYNTHETIC] prefixes are
// stripped to stand in for a non-Polymarket source that is not self-labelled. SYNTHETIC data only.
// Run: node --test research/test/review-provenance-crash.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, startMockServer } from './mock-server.js';
import { DEFAULT_BASES, run } from '../collect.js';
import { buildDataset } from '../build-dataset.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, '..', 'collect.js');
const sink = { write: () => true };
const readJsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

function unlabelledFixture(seed) {
  const fixture = buildFixture({ nEvents: 12, seed });
  for (const ev of fixture.events) {
    ev.title = ev.title.replace('[SYNTHETIC] ', '');
    for (const m of ev.markets) m.question = m.question.replace('[SYNTHETIC] ', '');
  }
  return fixture;
}

test('a crashed run with overridden bases taints the data dir even after a clean default-base run', async () => {
  const srv = await startMockServer({ fixture: unlabelledFixture(9), faults: false });
  // The listing's third page fails with a non-retryable 403 during the first (non-default) run.
  srv.faults.push({ name: 'events-403', status: 403, body: { error: 'forbidden' }, fired: false,
    match: (u) => u.pathname === '/gamma/events' && u.searchParams.get('offset') === '10' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prov-'));
  const args = ['--data-dir', dir, '--since', '2025-01-01', '--page-size', '5', '--rps', '500', '--concurrency', '8', '--retry-base-ms', '5', '--quiet'];
  const realFetch = globalThis.fetch;
  try {
    await assert.rejects(run([...args, '--max-markets', '40'], { env: srv.env, stdout: sink, stderr: sink }), /HTTP 403/);
    const afterCrash = readJsonl(path.join(dir, 'markets.jsonl')).length;
    assert.ok(afterCrash > 0, 'the crashed run left markets behind');
    const lines = readJsonl(path.join(dir, 'collect-runs.jsonl'));
    assert.deepEqual(lines.map((l) => l.status), ['started', 'failed']);
    assert.ok(lines.every((l) => l.synthetic && l.bases.gamma === srv.gammaBase && l.runId === lines[0].runId));
    assert.match(lines[1].error, /HTTP 403/);

    // Run 2 uses the default bases (no env override); fetch is routed to the mock to stand in for the real API.
    globalThis.fetch = (url, o) => realFetch(String(url).replace(DEFAULT_BASES.gamma, srv.gammaBase).replace(DEFAULT_BASES.clob, srv.clobBase).replace(DEFAULT_BASES.data, srv.dataBase), o);
    const s2 = await run([...args, '--max-markets', '45'], { env: {}, stdout: sink, stderr: sink });
    globalThis.fetch = realFetch;
    assert.ok(s2.kept > 0);
    assert.equal(s2.synthetic, null);

    const s = await buildDataset({ dataDir: dir });
    assert.equal(s.provenance.status, 'synthetic', `${afterCrash} markets from a non-default-base run must not pass as polymarket-api`);
    assert.equal(s.provenance.collectRuns, 2);
    assert.equal(s.provenance.syntheticRuns, 1);
  } finally {
    globalThis.fetch = realFetch;
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Ctrl-C (SIGINT) records an "interrupted" end line; even SIGKILL leaves the "started" line', async () => {
  const srv = await startMockServer({ fixture: unlabelledFixture(10), faults: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prov-sig-'));
  const runsOf = (dir) => {
    const f = path.join(dir, 'collect-runs.jsonl');
    return fs.existsSync(f) ? readJsonl(f) : [];
  };
  // Slow enough (10 req/s, ~8 requests per market) that the run is still going when the signal arrives.
  const startChild = (dir) => spawn(process.execPath, [COLLECT, '--data-dir', dir, '--since', '2025-01-01', '--rps', '10', '--quiet'],
    { env: { ...process.env, ...srv.env }, stdio: ['ignore', 'ignore', 'pipe'] });
  const killAfterMarkets = async (child, dir, signal) => {
    const exited = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));
    const mf = path.join(dir, 'markets.jsonl');
    for (let i = 0; i < 400 && !(fs.existsSync(mf) && fs.readFileSync(mf, 'utf8').trim()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(mf), 'a market was written before the signal');
    child.kill(signal);
    return exited;
  };
  try {
    const a = path.join(root, 'sigint');
    const res = await killAfterMarkets(startChild(a), a, 'SIGINT');
    assert.equal(res.code, 130);
    assert.deepEqual(runsOf(a).map((l) => l.status), ['started', 'interrupted']);
    assert.equal(runsOf(a)[1].signal, 'SIGINT');

    const b = path.join(root, 'sigkill');
    await killAfterMarkets(startChild(b), b, 'SIGKILL');
    assert.deepEqual(runsOf(b).map((l) => l.status), ['started']);
    assert.ok(runsOf(b)[0].synthetic, 'the started line already carries the overridden bases');
    // Built with nothing but that line, the dir is still marked synthetic.
    const s = await buildDataset({ dataDir: b });
    assert.equal(s.provenance.status, 'synthetic');
    assert.equal(s.provenance.unfinishedRuns, 1);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
