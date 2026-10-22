// REVIEW REPRO (provenance integrity): collect.js appends its collect-runs.jsonl line only after a
// clean finish. A run with overridden API bases that crashes (non-retryable HTTP error, bad
// shape, Ctrl-C) leaves its markets in markets.jsonl with no provenance record, and a later
// completed default-base run then makes build-dataset report the whole dir as "polymarket-api".
// The mock's [SYNTHETIC] prefixes are stripped here to stand in for any non-Polymarket source
// that is not self-labelled (a replay proxy, another mock). SYNTHETIC data only.
// Run: node research/test/review-provenance-crash.mjs   Exit 1 = bug reproduced, 0 = fixed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, startMockServer } from './mock-server.js';
import { DEFAULT_BASES, run } from '../collect.js';
import { buildDataset } from '../build-dataset.js';

const fixture = buildFixture({ nEvents: 12, seed: 9 });
for (const ev of fixture.events) {
  ev.title = ev.title.replace('[SYNTHETIC] ', '');
  for (const m of ev.markets) m.question = m.question.replace('[SYNTHETIC] ', '');
}
const srv = await startMockServer({ fixture, faults: false });
// The listing's third page fails with a non-retryable 403 during the first (non-default) run.
srv.faults.push({ name: 'events-403', status: 403, body: { error: 'forbidden' }, fired: false,
  match: (u) => u.pathname === '/gamma/events' && u.searchParams.get('offset') === '10' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prov-'));
const sink = { write: () => true };
const args = ['--data-dir', dir, '--since', '2025-01-01', '--page-size', '5', '--rps', '500', '--concurrency', '8', '--retry-base-ms', '5', '--quiet'];
const realFetch = globalThis.fetch;
try {
  let crashed = null;
  try { await run([...args, '--max-markets', '40'], { env: srv.env, stdout: sink, stderr: sink }); } catch (e) { crashed = e.message.slice(0, 60); }
  const afterCrash = fs.readFileSync(path.join(dir, 'markets.jsonl'), 'utf8').trim().split('\n').length;
  console.log(`run 1 (GAMMA_BASE etc. -> ${srv.url}) crashed: ${crashed}; markets.jsonl rows: ${afterCrash}; collect-runs.jsonl exists: ${fs.existsSync(path.join(dir, 'collect-runs.jsonl'))}`);

  // Run 2 uses the default bases (no env override); fetch is routed to the mock to stand in for the real API.
  globalThis.fetch = (url, o) => realFetch(String(url).replace(DEFAULT_BASES.gamma, srv.gammaBase).replace(DEFAULT_BASES.clob, srv.clobBase).replace(DEFAULT_BASES.data, srv.dataBase), o);
  const s2 = await run([...args, '--max-markets', '45'], { env: {}, stdout: sink, stderr: sink });
  globalThis.fetch = realFetch;
  console.log(`run 2 (default bases): kept ${s2.kept}, synthetic flag ${JSON.stringify(s2.synthetic)}`);

  const s = await buildDataset({ dataDir: dir });
  console.log(`build-dataset provenance: ${s.provenance.status} (${s.provenance.collectRuns} run line(s), bases ${s.provenance.bases.join(', ')}); markets used ${s.marketsUsed}`);
  if (crashed && afterCrash > 0 && s.provenance.status === 'polymarket-api') {
    console.log(`BUG REPRODUCED: ${afterCrash} markets from a non-default-base run are reported as polymarket-api data`);
    process.exitCode = 1;
  } else console.log('OK: the crashed non-default run is reflected in provenance');
} finally {
  globalThis.fetch = realFetch;
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
