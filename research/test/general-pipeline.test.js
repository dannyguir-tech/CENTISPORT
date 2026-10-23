// General (non-sports) track end to end on SYNTHETIC data: the collector over HTTP against a local
// fake of gamma /events/keyset, /events?id= and clob /prices-history (with the live API's 15-day
// span limit), resume, provenance, equivalence with the in-process generator, the builder, and
// backtest.js --hypotheses research/general/hypotheses.js (settle embargo, fee metadata, loss floor).
// Run: node --test research/test/general-pipeline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { run as collect } from '../general/collect.js';
import { buildGeneralDataset } from '../general/build-dataset.js';
import { buildEvent, generateWorld, worldOptions } from '../general/synthetic.js';
import { DEFAULTS as BT_DEFAULTS, assignFolds, knownBy, loadDataset, losingEventsFloor, runBacktest, walkForward, foldCutoff } from '../backtest.js';
import * as GH from '../general/hypotheses.js';

const HOUR = 3600;
const SPAN_LIMIT = 15 * 24 * HOUR;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `general-${p}-`));
const sink = { write() {} };
const WORLD = { world: 'planted', seed: 11, events: 160 };

function fakeApi({ refuseOpenEnded = false } = {}) {
  const o = worldOptions(WORLD);
  const events = [];
  const points = new Map();
  for (let i = 0; i < o.events; i++) {
    const { specs, gammaEvent } = buildEvent(i, o);
    events.push(gammaEvent);
    for (const s of specs) points.set(String(JSON.parse(s.gamma.clobTokenIds)[0]), s.points);
  }
  events.sort((a, b) => Number(b.id) - Number(a.id));
  const stats = { keyset: 0, events: 0, prices: 0, refused: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/gamma/events/keyset') {
      stats.keyset++;
      const excl = new Set(u.searchParams.getAll('exclude_tag_id'));
      const list = events.filter((e) => !e.tags.some((t) => excl.has(t.id)));
      const start = Number(u.searchParams.get('after_cursor') || 0);
      const limit = Number(u.searchParams.get('limit'));
      const page = list.slice(start, start + limit).map(({ markets, ...e }) => ({ ...e, markets: markets.map((m) => ({ id: m.id, conditionId: m.conditionId, closed: m.closed, feeType: m.feeType })) }));
      return send(200, { events: page, next_cursor: start + limit < list.length ? String(start + limit) : null });
    }
    if (u.pathname === '/gamma/events') {
      stats.events++;
      const ids = new Set(u.searchParams.getAll('id'));
      return send(200, events.filter((e) => ids.has(e.id)));
    }
    if (u.pathname === '/clob/prices-history') {
      stats.prices++;
      const a = Number(u.searchParams.get('startTs'));
      const b = u.searchParams.has('endTs') ? Number(u.searchParams.get('endTs')) : null;
      if (b != null && b - a > SPAN_LIMIT) return send(400, { error: "invalid filters: 'startTs' and 'endTs' interval is too long" });
      if (b == null && refuseOpenEnded) { stats.refused++; return send(400, { error: 'invalid filters: endTs required' }); }
      const pts = (points.get(u.searchParams.get('market')) || []).filter((p) => p.t >= a && (b == null || p.t <= b));
      return send(200, { history: pts });
    }
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, stats, env: { GAMMA_BASE: `${base}/gamma`, CLOB_BASE: `${base}/clob` } });
  }));
}

const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byCid = (rows) => new Map(rows.map(({ collectedAt, groupFile, ...r }) => [r.conditionId, r]));
const sortRows = (rows) => rows.map((r) => JSON.stringify(r)).sort();

test('collector over HTTP == in-process generator; resumes; provenance synthetic', async () => {
  const api = await fakeApi();
  try {
    const dir = tmp('collect');
    const args = ['--data-dir', dir, '--rps', '500', '--concurrency', '8', '--quiet', '--index-page-size', '50'];
    // A capped first run, then the same command finishes the universe.
    const s1 = await collect([...args, '--max-markets', '60'], { env: api.env, stdout: sink, stderr: sink, installSignalHandlers: false });
    assert.equal(s1.stop, 'max_markets');
    assert.ok(s1.synthetic, 'non-default bases are flagged');
    assert.ok(s1.index.exclusions.kept > 0 && s1.index.events < WORLD.events, 'sports / up-or-down excluded server-side by tag id');
    const s2 = await collect(args, { env: api.env, stdout: sink, stderr: sink, installSignalHandlers: false });
    assert.equal(s2.nothingLeft, true);
    const before = { ...api.stats };
    const s3 = await collect(args, { env: api.env, stdout: sink, stderr: sink, installSignalHandlers: false });
    assert.equal(s3.kept, 0);
    assert.equal(api.stats.prices, before.prices, 'a finished collection makes no price requests');
    assert.equal(api.stats.keyset, before.keyset, 'a complete index is reused');
    const runs = readJsonl(path.join(dir, 'collect-runs.jsonl'));
    assert.equal(runs.filter((r) => r.status === 'started').length, 3);
    assert.equal(runs.filter((r) => r.status === 'completed').length, 3);

    // The same world written by the generator (which calls the collector's processEvent directly).
    const gdir = tmp('gen');
    await generateWorld({ ...WORLD, dataDir: gdir });
    const a = byCid(readJsonl(path.join(dir, 'markets.jsonl')));
    const b = byCid(readJsonl(path.join(gdir, 'markets.jsonl')));
    assert.ok(a.size > 100);
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
    for (const [cid, rec] of a) assert.deepEqual(rec, b.get(cid), cid);
    const sa = await buildGeneralDataset({ dataDir: dir });
    const sb = await buildGeneralDataset({ dataDir: gdir });
    assert.equal(sa.provenance.status, 'synthetic');
    assert.equal(sb.provenance.status, 'synthetic');
    assert.ok(sa.rows > 300);
    assert.deepEqual(sortRows(readJsonl(path.join(dir, 'dataset.jsonl'))), sortRows(readJsonl(path.join(gdir, 'dataset.jsonl'))), 'identical datasets');
    assert.ok(api.stats.prices > 0);
  } finally {
    api.server.close();
  }
});

test('collector: an API that refuses open-ended windows falls back to 15-day chunks (same data)', async () => {
  const api = await fakeApi({ refuseOpenEnded: true });
  try {
    const dir = tmp('chunks');
    const s = await collect(['--data-dir', dir, '--rps', '500', '--quiet', '--max-events', '40'], { env: api.env, stdout: sink, stderr: sink, installSignalHandlers: false });
    assert.equal(s.ok, true);
    assert.ok(api.stats.refused >= 1);
    assert.equal(s.events.failed, 0);
    const gdir = tmp('chunks-gen');
    await generateWorld({ ...WORLD, dataDir: gdir });
    const want = byCid(readJsonl(path.join(gdir, 'markets.jsonl')));
    const got = byCid(readJsonl(path.join(dir, 'markets.jsonl')));
    assert.ok(got.size > 10);
    for (const [cid, rec] of got) {
      assert.deepEqual(rec, want.get(cid));
      const p = (d) => JSON.parse(fs.readFileSync(path.join(d, 'prices', `${rec.yesTokenId}.json`), 'utf8')).points;
      assert.deepEqual(p(dir), p(gdir), `prices of ${cid}`);
    }
  } finally {
    api.server.close();
  }
});

test('collector refuses more than 20 rps against the real API', async () => {
  const dir = tmp('rps');
  await assert.rejects(collect(['--data-dir', dir, '--rps', '21', '--index-only'], { env: {}, stdout: sink, stderr: sink, installSignalHandlers: false }), /<= 20 against the Polymarket API/);
});

test('collector: the sample order (salt, balance) is fixed per data dir', async () => {
  const dir = tmp('sample');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({ salt: 'general-v1', balance: 'category' }));
  // Refused before any request is made (real bases, no network needed).
  await assert.rejects(collect(['--data-dir', dir, '--index-only'], { env: {}, stdout: sink, stderr: sink, installSignalHandlers: false }), /--balance category/);
  await assert.rejects(collect(['--data-dir', dir, '--index-only', '--balance', 'category', '--sample-salt', 'x'], { env: {}, stdout: sink, stderr: sink, installSignalHandlers: false }), /--sample-salt general-v1/);
  const api = await fakeApi();
  try {
    const d2 = tmp('sample-ok');
    const s = await collect(['--data-dir', d2, '--rps', '500', '--quiet', '--balance', 'category', '--max-events', '20'], { env: api.env, stdout: sink, stderr: sink, installSignalHandlers: false });
    assert.deepEqual(s.sample, { salt: 'general-v1', balance: 'category' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(d2, 'sample.json'), 'utf8')).balance, 'category');
    await assert.rejects(collect(['--data-dir', d2, '--rps', '500', '--quiet'], { env: api.env, stdout: sink, stderr: sink, installSignalHandlers: false }), /--balance category/);
  } finally {
    api.server.close();
  }
});

test('backtest --hypotheses general: settle embargo, fee metadata stripped, loss floor, altCosts', async () => {
  const dir = tmp('bt');
  await generateWorld({ world: 'null', seed: 5, events: 900, dataDir: dir });
  await buildGeneralDataset({ dataDir: dir });
  const data = path.join(dir, 'dataset.jsonl');
  const { report } = await runBacktest({ hypotheses: path.resolve('research/general/hypotheses.js'), data, sourceLabel: 'SYNTHETIC test', out: path.join(dir, 'reports'), name: 'bt', boot: 200 });
  assert.equal(report.config.foldBy, 'decision');
  assert.equal(report.config.embargoFrom, 'settle');
  assert.equal(report.config.cutoffScope, 'offsets');
  assert.equal(report.config.lossFloor, true);
  assert.equal(report.source.provenance.status, 'synthetic');
  assert.deepEqual(report.hypotheses.map((h) => h.baseId).filter((v, i, a) => a.indexOf(v) === i).sort(), GH.BASE_HYPOTHESES.map((h) => h.id).sort());
  const lf = report.hypotheses.find((h) => h.id === 'longshot-fade');
  assert.ok(lf.oos.lossFloor && lf.oos.roi.p >= lf.oos.lossFloor.p && lf.oos.roi.p >= lf.oos.roi.pBootstrap);
  assert.ok(report.hypotheses.every((h) => h.status !== 'tested' || (h.altCosts.length === 1 && h.altCosts[0].id === 'actual-fees')));
  assert.ok(report.data.feeMarkets && report.data.feeMarkets.withTakerFees > 0, 'markets listed after feeFrom carry fees');

  // --cost-model actual-fees (SENSITIVITY): the module's alt cost replaces the flat fee in training
  // and out-of-sample alike (a different --fee changes nothing), and the run declares no survivors.
  const s = await runBacktest({ hypotheses: path.resolve('research/general/hypotheses.js'), data, sourceLabel: 'SYNTHETIC test', out: path.join(dir, 'reports'), name: 'bt-af', boot: 200, costModel: 'actual-fees', fee: 0.3 });
  assert.equal(s.report.config.costModelId, 'actual-fees');
  assert.match(s.report.config.costModel, /^SENSITIVITY/);
  assert.deepEqual(s.report.verdict.survivors, []);
  assert.match(s.report.verdict.text, /\*\*Sensitivity run, not a headline result/);
  assert.ok(s.report.hypotheses.every((h) => h.status !== 'tested' || h.verdict.survives === false));
  assert.match(fs.readFileSync(s.mdPath, 'utf8'), /Costs \(SENSITIVITY, `--cost-model actual-fees`\)/);
  // early-listing-fade has one offset, so where both runs trade the same folds the picks are the same
  // and the cost-model run's ROI equals the headline run's actual-fee re-costing of those picks.
  const h1 = report.hypotheses.find((h) => h.id === 'early-listing-fade');
  const h2 = s.report.hypotheses.find((h) => h.id === 'early-listing-fade');
  if (h1.status === 'tested' && h2.status === 'tested' && JSON.stringify(h1.folds.map((f) => !!f.chosen)) === JSON.stringify(h2.folds.map((f) => !!f.chosen))) {
    const re = h1.altCosts[0].bySpread.find((b) => b.spread === 0.01);
    assert.equal(h2.oos.n, re.n);
    assert.ok(Math.abs(h2.oos.roi.estimate - re.roi) < 1e-9, `${h2.oos.roi.estimate} vs ${re.roi}`);
  }
  await assert.rejects(runBacktest({ hypotheses: path.resolve('research/general/hypotheses.js'), data, sourceLabel: 'SYNTHETIC test', out: path.join(dir, 'reports'), name: 'bt-x', boot: 50, costModel: 'nope' }), /no such BACKTEST.altCosts entry/);

  // Hypotheses never see labels or fee metadata; every training row had settled before the cutoff.
  const { rows } = await loadDataset(data, { metaFields: GH.BACKTEST.metaFields });
  for (const k of ['won', 'closePrice', 'clv', 'settleTs', 'feeRate', 'feeType', 'feeExponent', 'volume']) assert.ok(!(k in rows[0].f), k);
  assert.ok(rows[0].meta && 'feeRate' in rows[0].meta);
  const folds = assignFolds(rows, 5, { foldBy: 'decision' });
  const o = { ...BT_DEFAULTS, embargoFrom: 'settle', cutoffScope: 'offsets' };
  for (const h of GH.buildHypotheses({ sports: [] })) {
    const hyp = { ...h, offsets: [...h.offsets] };
    let checked = 0;
    walkForward(hyp, folds, o, {
      onPhase: (phase, k) => {
        if (phase !== 'train') return;
        const cutoff = foldCutoff(folds[k], hyp.offsets, 'offsets');
        for (let j = 0; j < k; j++) {
          for (const r of folds[j].rows) {
            if (!hyp.offsets.includes(r.f.offsetH) || !knownBy(r, cutoff, o.embargoH * HOUR, 'settle')) continue;
            assert.ok(r.settleTs + o.embargoH * HOUR <= cutoff);
            checked++;
          }
        }
        // Every test bet of this fold is decided at or after the cutoff.
        for (const r of folds[k].rows) if (hyp.offsets.includes(r.f.offsetH)) assert.ok(r.f.decisionTs >= cutoff);
      },
    });
    assert.ok(checked > 0 || h.id === 'early-listing-fade', h.id);
  }
});

test('losing-events floor: exact on a tiny case, degenerate lucky samples get a sane p', () => {
  // Two events, one bet each at cost 0.9 and 0.8; neither lost: P(0 losses) = 0.9 * 0.8.
  const f = losingEventsFloor([{ id: 'a', eventKey: 'e1', cost: 0.9, won: 1 }, { id: 'b', eventKey: 'e2', cost: 0.8, won: 1 }]);
  assert.ok(Math.abs(f.p - 0.72) < 1e-12);
  assert.equal(f.losingEvents, 0);
  // One loss among three: P(X <= 1) for Poisson-binomial(0.1, 0.2, 0.5).
  const g = losingEventsFloor([{ id: 'a', eventKey: 'e1', cost: 0.9, won: 1 }, { id: 'b', eventKey: 'e2', cost: 0.8, won: 0 }, { id: 'c', eventKey: 'e3', cost: 0.5, won: 1 }]);
  const p0 = 0.9 * 0.8 * 0.5;
  const p1 = 0.1 * 0.8 * 0.5 + 0.9 * 0.2 * 0.5 + 0.9 * 0.8 * 0.5;
  assert.ok(Math.abs(g.p - (p0 + p1)) < 1e-12);
  // 40 events of 0.93 favourites that all won: the bootstrap would say p ~ 0; the floor ~ 0.93^40.
  const lucky = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, eventKey: `e${i}`, cost: 0.93, won: 1 }));
  assert.ok(Math.abs(losingEventsFloor(lucky).p - 0.93 ** 40) < 1e-12);
  // One representative per event, chosen by id hash, not by outcome: order does not matter.
  const multi = [{ id: 'x1', eventKey: 'e', cost: 0.9, won: 0 }, { id: 'x2', eventKey: 'e', cost: 0.9, won: 1 }, { id: 'x3', eventKey: 'e', cost: 0.9, won: 1 }];
  assert.equal(losingEventsFloor(multi).p, losingEventsFloor([...multi].reverse()).p);
  assert.equal(losingEventsFloor(multi).events, 1);
});

test('sports defaults unchanged: no loss floor, start-based embargo, module wording', async () => {
  assert.equal(BT_DEFAULTS.lossFloor, false);
  assert.equal(BT_DEFAULTS.embargoFrom, 'start');
  assert.equal(GH.BACKTEST.groupLabel, 'category');
  // Pre-registered ids (fixed before any real run).
  assert.deepEqual(GH.BASE_HYPOTHESES.map((h) => h.id), ['baseline-all', 'longshot-fade', 'longshot-fade-wide', 'deadline-no', 'near-certain', 'negrisk-overround-no', 'negrisk-underround-yes', 'momentum-follow-7d', 'momentum-fade-7d', 'early-listing-fade', 'longshot-buy']);
  assert.deepEqual([...GH.VARIANT_BASES], ['longshot-fade', 'deadline-no', 'near-certain']);
});
