// Review DI-3 (permanent): --trades on a data dir that already holds markets must backfill them.
// The README's recipe runs a smoke test without --trades, then the full run with --trades into the
// same dir. Markets from the smoke test were "already collected", so their trades were never
// fetched and nothing warned; they are the newest markets, i.e. the last out-of-sample fold.
// SYNTHETIC mock data only. Run: node --test research/test/review-trades-not-backfilled.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, startMockServer } from './mock-server.js';
import { run } from '../collect.js';

const readJsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const capture = () => {
  let text = '';
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
};

async function collect(srv, dir, extra) {
  const err = capture();
  const start = srv.requests.length;
  const summary = await run(['--data-dir', dir, '--since', '2025-01-01', '--rps', '500', '--concurrency', '8', '--retry-base-ms', '5', ...extra],
    { env: srv.env, stdout: capture(), stderr: err });
  return { summary, stderr: err.text, requests: srv.requests.slice(start) };
}

test('a --trades run backfills markets collected earlier without trades', async () => {
  const srv = await startMockServer({ fixture: buildFixture({ nEvents: 10, seed: 5 }), faults: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-backfill-'));
  try {
    await collect(srv, dir, ['--max-markets', '5', '--quiet']); // smoke test
    const smoke = readJsonl(path.join(dir, 'markets.jsonl')).map((m) => m.conditionId);
    const plain = await collect(srv, dir, ['--max-markets', '5']);
    assert.doesNotMatch(plain.stderr, /no current trade tape/, 'no warning while no market has trades');

    const full = await collect(srv, dir, ['--trades', '--max-markets', '15']);
    assert.equal(full.summary.alreadyCollected >= 5, true);
    assert.equal(full.summary.trades.backfilled, 5);
    assert.equal(full.summary.trades.backfillFailed, 0);
    assert.match(full.stderr, /backfilling trade tapes for 5 of 5 markets/);
    const markets = readJsonl(path.join(dir, 'markets.jsonl'));
    assert.equal(markets.length, 15);
    for (const m of markets) {
      assert.ok(fs.existsSync(path.join(dir, 'trades', `${m.conditionId}.jsonl`)), `trades for ${m.conditionId}`);
      assert.equal(m.tradesInfo?.v, 2, `tradesInfo rewritten for ${m.conditionId}`);
    }
    // The backfill used each stored start time: the tape window ends at kickoff.
    for (const cid of smoke) {
      const m = markets.find((x) => x.conditionId === cid);
      assert.equal(m.tradesInfo.toT, srv.fixture.byCid.get(cid).meta.gs);
    }
    const again = await collect(srv, dir, ['--trades', '--max-markets', '15']);
    assert.equal(again.summary.trades.backfilled, 0);
    assert.equal(again.requests.filter((r) => r.path === '/data/trades').length, 0, 'nothing refetched once backfilled');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without --trades a mixed dir warns; legacy tapes are refetched; a v2 tape whose record was lost is reused', async () => {
  const srv = await startMockServer({ fixture: buildFixture({ nEvents: 10, seed: 6 }), faults: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-backfill2-'));
  try {
    await collect(srv, dir, ['--trades', '--max-markets', '4', '--quiet']);
    await collect(srv, dir, ['--max-markets', '7', '--quiet']); // 3 more without trades
    const warn = await collect(srv, dir, ['--max-markets', '7']);
    assert.match(warn.stderr, /3 of 7 markets in markets\.jsonl have no current trade tape; re-run with --trades/);

    // Make one record look like an older collector's (no v, kept in-game trades), and drop the
    // tradesInfo of another as if the run died after writing its tape and sidecar.
    const mf = path.join(dir, 'markets.jsonl');
    const rows = readJsonl(mf);
    const withTape = rows.filter((m) => m.tradesInfo);
    const [legacy, lost] = withTape;
    fs.writeFileSync(mf, rows.map((m) => {
      if (m.conditionId === legacy.conditionId) return JSON.stringify({ ...m, tradesInfo: { n: m.tradesInfo.n, truncated: false, oldestT: m.tradesInfo.oldestT, newestT: m.tradesInfo.newestT } });
      if (m.conditionId === lost.conditionId) { const { tradesInfo, ...rest } = m; return JSON.stringify(rest); }
      return JSON.stringify(m);
    }).join('\n') + '\n');
    fs.rmSync(path.join(dir, 'trades', `${legacy.conditionId}.meta.json`));

    const r = await collect(srv, dir, ['--trades', '--max-markets', '7', '--quiet']);
    assert.equal(r.summary.trades.backfilled, 5, '3 never fetched + 1 legacy + 1 lost record');
    const fetched = new Set(r.requests.filter((q) => q.path === '/data/trades').map((q) => q.query.market));
    assert.ok(fetched.has(legacy.conditionId), 'legacy tape refetched');
    assert.ok(!fetched.has(lost.conditionId), 'v2 tape with sidecar reused');
    const after = new Map(readJsonl(mf).map((m) => [m.conditionId, m]));
    assert.deepEqual(after.get(lost.conditionId).tradesInfo, lost.tradesInfo);
    assert.equal(after.get(legacy.conditionId).tradesInfo.v, 2);
    assert.ok([...after.values()].every((m) => m.tradesInfo?.v === 2));
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
