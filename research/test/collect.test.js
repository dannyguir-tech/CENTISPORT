// Runs research/collect.js against the local SYNTHETIC mock API and checks outputs, skip
// accounting, retry behaviour and resume. Run: node --test research/test/collect.test.js
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.js';
import { cachePathFor, createHttpClient, createLimiter, createRateLimiter, fetchJson, HttpError, parseRetryAfter } from '../lib/http.js';
import { inferSport, looksLikeGameTime, normalizeMarket, parseTs, readSlugList, resolveWinner } from '../collect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, '..', 'collect.js');
const HOUR = 3600;
const PRE = 78 * HOUR; // collect.js defaults
const POST = 2 * HOUR;
const FAST = ['--rps', '300', '--concurrency', '8', '--retry-base-ms', '10', '--page-size', '5', '--since', '2025-01-01', '--until', '2025-12-31', '--quiet'];

let server;
let tmpRoot;

const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function runCollect(args, srv = server) {
  const start = srv.requests.length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COLLECT, ...args], { env: { ...process.env, ...srv.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      let summary = null;
      try {
        summary = JSON.parse(stdout.trim().split('\n').pop());
      } catch {}
      resolve({ code, stdout, stderr, summary, requests: srv.requests.slice(start) });
    });
  });
}

before(async () => {
  server = await startMockServer();
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'collect-test-'));
});

after(async () => {
  await server?.close();
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

describe('lib/http.js', () => {
  let srv;
  let base;
  const hits = new Map();
  before(async () => {
    srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const n = (hits.get(u.pathname) || 0) + 1;
      hits.set(u.pathname, n);
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (u.pathname === '/flaky') return n <= 2 ? json(503, { error: 'busy' }) : json(200, { ok: n });
      if (u.pathname === '/limited') return n === 1 ? json(429, {}, { 'retry-after': '1' }) : json(200, { ok: true });
      if (u.pathname === '/missing') return json(404, { error: 'nope' });
      if (u.pathname === '/bad') return json(400, { error: 'bad request' });
      if (u.pathname === '/slow') return setTimeout(() => json(200, { late: true }), 300);
      if (u.pathname === '/cached') return json(200, { value: n });
      return json(404, {});
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(async () => {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });

  test('retries 5xx with backoff and returns the eventual body', async () => {
    const retries = [];
    const body = await fetchJson(`${base}/flaky`, { retryBaseMs: 5, onRetry: (r) => retries.push(r) });
    assert.deepEqual(body, { ok: 3 });
    assert.equal(retries.length, 2);
  });

  test('honors Retry-After on 429', async () => {
    const t0 = Date.now();
    assert.deepEqual(await fetchJson(`${base}/limited`, { retryBaseMs: 1 }), { ok: true });
    assert.ok(Date.now() - t0 >= 950, 'waited for Retry-After');
  });

  test('404 -> null with allow404, 400 -> HttpError without retry', async () => {
    assert.equal(await fetchJson(`${base}/missing`, { allow404: true }), null);
    await assert.rejects(fetchJson(`${base}/bad`, { retryBaseMs: 1 }), (err) => err instanceof HttpError && err.status === 400);
    assert.equal(hits.get('/bad'), 1);
  });

  test('times out and gives up after the retry budget', async () => {
    await assert.rejects(fetchJson(`${base}/slow`, { timeoutMs: 50, retries: 1, retryBaseMs: 1 }), /gave up after 2 attempts|aborted|timeout/i);
    assert.equal(hits.get('/slow'), 2);
  });

  test('retries connection failures, then wraps the error with its cause', async () => {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    const retries = [];
    await assert.rejects(
      fetchJson(`http://127.0.0.1:${port}/x`, { retries: 2, retryBaseMs: 1, onRetry: (r) => retries.push(r) }),
      (err) => /gave up after 3 attempts/.test(err.message) && err.cause != null
    );
    assert.equal(retries.length, 2);
  });

  test('client cache: second call served from disk', async () => {
    const cacheDir = path.join(tmpRoot, 'httpcache');
    const client = createHttpClient({ cacheDir, rps: 100 });
    const a = await client.getJson(`${base}/cached`, { cache: true });
    const b = await client.getJson(`${base}/cached`, { cache: true });
    assert.deepEqual(a, b);
    assert.equal(client.stats.requests, 1);
    assert.equal(client.stats.cacheHits, 1);
    assert.ok(existsSync(cachePathFor(cacheDir, `${base}/cached`)));
  });

  test('limiters bound concurrency and request rate', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        limit(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 15));
          active--;
        })
      )
    );
    assert.equal(peak, 3);
    const wait = createRateLimiter(20);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await wait();
    assert.ok(Date.now() - t0 >= 180, 'five slots at 20 rps take >= ~200ms');
  });

  test('parseRetryAfter handles seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('2'), 2000);
    const now = Date.parse('2025-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Wed, 01 Jan 2025 00:00:05 GMT', now), 5000);
    assert.equal(parseRetryAfter('soon'), null);
  });
});

describe('collect.js helpers', () => {
  test('parseTs accepts gamma time formats as UTC', () => {
    const want = Date.UTC(2025, 2, 1, 0, 30) / 1000;
    assert.equal(parseTs('2025-03-01 00:30:00+00'), want);
    assert.equal(parseTs('2025-03-01T00:30:00Z'), want);
    assert.equal(parseTs('2025-03-01T00:30:00.000Z'), want);
    assert.equal(parseTs('2025-03-01 00:30:00'), want);
    assert.equal(parseTs('2025-02-28T19:30:00-05:00'), want);
    assert.equal(parseTs(String(want * 1000)), want);
    assert.equal(parseTs(''), null);
    assert.equal(parseTs('garbage'), null);
  });

  test('resolveWinner requires exactly one final 1', () => {
    assert.deepEqual(resolveWinner('["0","1"]', 2), { winnerIndex: 1 });
    assert.deepEqual(resolveWinner([1, 0], 2), { winnerIndex: 0 });
    assert.deepEqual(resolveWinner('["0.5","0.5"]', 2), { skip: 'voided_50_50' });
    assert.deepEqual(resolveWinner('["0.97","0.03"]', 2), { skip: 'ambiguous_resolution' });
    assert.deepEqual(resolveWinner('["1","1"]', 2), { skip: 'ambiguous_resolution' });
    assert.deepEqual(resolveWinner(null, 2), { skip: 'missing_outcome_prices' });
  });

  test('game start never falls back to settlement times', () => {
    const base = { conditionId: '0xabc', outcomes: '["A","B"]', clobTokenIds: '["1","2"]', outcomePrices: '["1","0"]', closed: true };
    const noStart = normalizeMarket({ ...base, endDate: '2025-03-01T03:00:00Z', closedTime: '2025-03-01 03:10:00+00' }, { startDate: '2025-02-25T10:11:12.345Z', endDate: '2025-03-01T03:00:00Z' });
    assert.deepEqual(noStart, { skip: 'no_game_start' });
    const viaEvent = normalizeMarket(base, { startTime: '2025-03-01T00:30:00Z' });
    assert.equal(viaEvent.startTs, Date.UTC(2025, 2, 1, 0, 30) / 1000);
    assert.equal(viaEvent.record.times.gameStartSource, 'event.startTime');
    assert.equal(looksLikeGameTime('2025-03-01T00:30:00Z', '2025-03-01T03:30:00Z'), true);
    assert.equal(looksLikeGameTime('2025-02-25T10:11:12.345Z', '2025-03-01T03:30:00Z'), false);
    assert.equal(looksLikeGameTime('2025-02-25T10:00:00Z', '2025-03-01T03:30:00Z'), false);
    const early = normalizeMarket({ ...base, gameStartTime: '2025-03-01 00:30:00+00', closedTime: '2025-02-28 23:00:00+00' }, {});
    assert.deepEqual(early, { skip: 'closed_before_start' });
  });

  test('sport inference and slug parsing', () => {
    assert.equal(inferSport({ series: [{ slug: 'premier-league' }], slug: 'epl-ars-che-2025-03-01' }, {}, []), 'soccer');
    assert.equal(inferSport({ slug: 'atp-sin-alc-2025-03-01' }, {}, ['sports']), 'tennis');
    assert.equal(inferSport({ slug: 'random-thing' }, {}, ['sports', 'UFC']), 'mma');
    assert.equal(inferSport({ slug: 'random-thing' }, {}, ['sports']), null);
    assert.deepEqual(readSlugList('# c\nnba-a-b\nhttps://polymarket.com/sports/nfl/nfl-x-y?tid=1\nhttps://polymarket.com/event/ev-slug/market-slug\nnba-a-b\n'), ['nba-a-b', 'nfl-x-y', 'ev-slug']);
  });
});

describe('collect.js against the mock API (events-tag)', () => {
  let dataDir;
  let fx;
  let okEntries;
  let run1;
  let run2;
  const marketsFile = () => path.join(dataDir, 'markets.jsonl');
  const ARGS = () => ['--data-dir', dataDir, '--trades', ...FAST];

  before(async () => {
    dataDir = path.join(tmpRoot, 'events-tag');
    fx = server.fixture;
    okEntries = fx.entries.filter((e) => e.meta.kind === 'ok');
  });

  test('run 1 stops at --max-markets', async () => {
    run1 = await runCollect([...ARGS(), '--max-markets', '8']);
    assert.equal(run1.code, 0, run1.stderr);
    assert.equal(run1.summary.kept, 8);
    const rows = readJsonl(marketsFile());
    assert.equal(rows.length, 8);
    assert.equal(new Set(rows.map((r) => r.conditionId)).size, 8);
    for (const r of rows) {
      for (const tid of r.tokenIds) assert.ok(existsSync(path.join(dataDir, 'prices', `${tid}.json`)), `prices for ${tid}`);
      assert.ok(existsSync(path.join(dataDir, 'trades', `${r.conditionId}.jsonl`)));
    }
    assert.ok(run1.summary.synthetic, 'non-default bases are flagged');
  });

  test('run 2 resumes: cached listings, no refetch of collected markets, exact skip accounting', async () => {
    run2 = await runCollect([...ARGS(), '--max-markets', '1000']);
    assert.equal(run2.code, 0, run2.stderr);
    const s = run2.summary;
    assert.equal(s.alreadyCollected, 8);
    assert.equal(s.kept, okEntries.length - 8);
    assert.equal(s.totalInFile, okEntries.length);

    const expected = {};
    for (const e of fx.entries) if (e.meta.kind !== 'ok' && e.meta.kind !== 'out_of_range') expected[e.meta.kind] = (expected[e.meta.kind] || 0) + 1;
    expected.duplicate = fx.dupEvent.markets.length;
    assert.deepEqual(s.skipped, Object.fromEntries(Object.entries(expected).sort()));

    const run1Listing = new Set(run1.requests.filter((r) => r.path === '/gamma/events').map((r) => r.url));
    const relisted = run2.requests.filter((r) => r.path === '/gamma/events' && run1Listing.has(r.url));
    assert.deepEqual(relisted, [], 'listing pages from run 1 come from raw/ cache');
    assert.ok(s.http.cacheHits >= run1Listing.size);

    const firstRows = readJsonl(marketsFile()).slice(0, 8);
    const oldTokens = new Set(firstRows.flatMap((r) => r.tokenIds));
    const oldCids = new Set(firstRows.map((r) => r.conditionId));
    assert.equal(run2.requests.filter((r) => r.path === '/clob/prices-history' && oldTokens.has(r.query.market)).length, 0);
    assert.equal(run2.requests.filter((r) => r.path === '/data/trades' && oldCids.has(r.query.market)).length, 0);
  });

  test('markets.jsonl content matches the fixture', () => {
    const rows = readJsonl(marketsFile());
    const byCid = new Map(rows.map((r) => [r.conditionId, r]));
    assert.equal(byCid.size, rows.length, 'deduped by conditionId');
    assert.deepEqual(new Set(byCid.keys()), new Set(okEntries.map((e) => e.meta.cid)));
    for (const e of fx.entries.filter((x) => x.meta.kind === 'out_of_range')) assert.ok(!byCid.has(e.meta.cid), '2024 event excluded');
    for (const { meta, market, event } of okEntries) {
      const r = byCid.get(meta.cid);
      assert.equal(r.winnerIndex, meta.winnerIndex);
      assert.deepEqual(r.outcomes, meta.outcomes);
      assert.deepEqual(r.tokenIds, meta.tokenIds);
      assert.equal(r.sport, meta.sport);
      assert.equal(r.eventSlug, event.slug);
      assert.equal(r.times.gameStartSource, meta.gameStartSource);
      assert.equal(typeof r.volume, 'number');
      assert.equal(typeof r.negRisk, 'boolean');
      assert.ok(Array.isArray(r.tags) && r.tags.includes('sports'));
      if (meta.gameStartSource === 'eventStartDate') assert.equal(r.times.gameStartTime, null);
      else assert.equal(parseTs(r.times.gameStartTime), meta.gs);
      assert.equal(r.times.closedTime, market.closedTime ?? null, 'raw strings preserved');
      assert.ok(r.tradesInfo && r.tradesInfo.n >= 0);
    }
    assert.ok(byCid.has(fx.tricky.arrayEncoded), 'array-encoded fields parsed');
  });

  test('price files cover the window around game start', () => {
    for (const { meta } of okEntries) {
      meta.tokenIds.forEach((tid, idx) => {
        const { tokenId, points } = JSON.parse(readFileSync(path.join(dataDir, 'prices', `${tid}.json`), 'utf8'));
        assert.equal(tokenId, tid);
        assert.ok(points.length > 0, `points for ${tid}`);
        for (let i = 0; i < points.length; i++) {
          const { t, p } = points[i];
          assert.ok(t >= meta.gs - PRE && t <= meta.gs + POST, 'inside window');
          assert.ok(p >= 0 && p <= 1);
          if (i) assert.ok(t > points[i - 1].t, 'strictly ascending');
        }
        assert.ok(points[0].t <= meta.gs - 72 * HOUR, 'reaches 72h before start');
        assert.ok(points.at(-1).t >= meta.gs + HOUR, 'reaches 1h after start');
        if (meta.maxOnlyToken === idx) assert.equal(points[1].t - points[0].t, 3600, 'interval=max fallback at 60m');
        else assert.equal(points[1].t - points[0].t, 15 * 60, '--fidelity 15');
      });
    }
    const npm = fx.byCid.get(fx.tricky.noPriceHistory).meta;
    for (const tid of npm.tokenIds) {
      assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'prices', `${tid}.json`), 'utf8')).points, [], 'empty marker written');
    }
    assert.ok(run1.summary.prices.splits + run2.summary.prices.splits >= 1, 'long range was split after a 400');
    assert.equal(run2.summary.prices.maxFallback, 1);
  });

  test('trades are paginated, windowed and normalized', () => {
    const e = fx.byCid.get(fx.tricky.manyTrades);
    const { gs, tokenIds } = e.meta;
    const all = fx.tradesCache.get(e.meta.cid);
    const want = all.filter((t) => t.timestamp >= gs - PRE && t.timestamp <= gs + POST);
    const got = readJsonl(path.join(dataDir, 'trades', `${e.meta.cid}.jsonl`));
    assert.ok(want.length > 500, 'fixture needs more than one page in window');
    assert.equal(got.length, want.length);
    for (let i = 0; i < got.length; i++) {
      const t = got[i];
      assert.deepEqual(Object.keys(t).sort(), ['asset', 'price', 'side', 'size', 't', 'wallet']);
      assert.ok(tokenIds.includes(t.asset));
      assert.ok(t.side === 'BUY' || t.side === 'SELL');
      assert.equal(typeof t.wallet, 'string');
      if (i) assert.ok(t.t >= got[i - 1].t);
    }
    const row = readJsonl(marketsFile()).find((r) => r.conditionId === e.meta.cid);
    assert.equal(row.tradesInfo.n, got.length);
    assert.equal(row.tradesInfo.truncated, false);
  });

  test('injected faults were retried (429 honoring Retry-After, 500, 502)', () => {
    const all = [...run1.requests, ...run2.requests];
    for (const f of server.faults) {
      assert.ok(f.fired, `${f.name} fired`);
      const i = all.findIndex((r) => r.at === f.firedAt && r.status === f.status);
      assert.ok(i >= 0, `${f.name} recorded`);
      const retry = all.slice(i + 1).find((r) => r.url === all[i].url);
      assert.ok(retry && retry.status === 200, `${f.name} retried successfully`);
      if (f.status === 429) assert.ok(retry.at - all[i].at >= 950, 'Retry-After: 1 honored');
    }
  });

  test('run 3 is a no-op with zero network requests', async () => {
    const run3 = await runCollect([...ARGS(), '--max-markets', '1000']);
    assert.equal(run3.code, 0, run3.stderr);
    assert.equal(run3.requests.length, 0);
    assert.equal(run3.summary.kept, 0);
    assert.equal(run3.summary.alreadyCollected, okEntries.length);
    assert.equal(run3.summary.http.requests, 0);
  });

  test('a torn last line is repaired and --max-markets already met short-circuits', async () => {
    await appendFile(marketsFile(), '{"conditionId":"0xdead","quest');
    const r = await runCollect([...ARGS(), '--max-markets', '5']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.requests.length, 0);
    assert.match(r.stderr, /rewriting without them/);
    const rows = readJsonl(marketsFile());
    assert.equal(rows.length, okEntries.length);
    assert.equal(readJsonl(path.join(dataDir, 'collect-runs.jsonl')).length, 4);
  });
});

describe('collect.js other strategies and failures', () => {
  test('event-slugs strategy', async () => {
    const dataDir = path.join(tmpRoot, 'event-slugs');
    const fx = server.fixture;
    const evOf = (i) => fx.entries.find((e) => e.meta.eventIndex === i).event;
    const slugFile = path.join(tmpRoot, 'slugs.txt');
    await writeFile(slugFile, `# synthetic slugs\n${evOf(0).slug}\nhttps://polymarket.com/sports/nfl/${evOf(1).slug}\nno-such-event-slug\n`);
    const r = await runCollect(['--data-dir', dataDir, '--strategy', 'event-slugs', '--event-slugs', slugFile, ...FAST]);
    assert.equal(r.code, 0, r.stderr);
    const want = fx.entries.filter((e) => e.meta.kind === 'ok' && (e.meta.eventIndex === 0 || e.meta.eventIndex === 1));
    assert.equal(r.summary.kept, want.length);
    assert.deepEqual(r.summary.skipped, { slug_not_found: 1, voided_50_50: 1 });
    assert.deepEqual(new Set(readJsonl(path.join(dataDir, 'markets.jsonl')).map((m) => m.conditionId)), new Set(want.map((e) => e.meta.cid)));
  });

  test('markets strategy with a numeric tag id', async () => {
    const dataDir = path.join(tmpRoot, 'markets');
    const r = await runCollect(['--data-dir', dataDir, '--strategy', 'markets', '--tag', '745', ...FAST]);
    assert.equal(r.code, 0, r.stderr);
    const want = server.fixture.entries.filter((e) => e.meta.kind === 'ok' && e.meta.sport === 'nba');
    assert.equal(r.summary.kept, want.length);
    assert.deepEqual(r.summary.skipped, { no_game_start: 1 });
    assert.ok(r.requests.some((q) => q.path === '/gamma/markets' && q.query.tag_id === '745'));
    for (const m of readJsonl(path.join(dataDir, 'markets.jsonl'))) {
      assert.equal(m.sport, 'nba');
      assert.ok(m.eventSlug);
    }
  });

  test('discovery survives a server that caps page size below --page-size', async () => {
    const capped = await startMockServer({ faults: false, limitCap: 3 });
    try {
      const dataDir = path.join(tmpRoot, 'capped');
      const r = await runCollect(['--data-dir', dataDir, ...FAST], capped);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.summary.kept, capped.fixture.entries.filter((e) => e.meta.kind === 'ok').length);
      assert.ok(r.requests.filter((q) => q.path === '/gamma/events').every((q) => q.query.limit === '5'));
    } finally {
      await capped.close();
    }
  });

  test('a discovery strategy that finds nothing fails loudly', async () => {
    const dataDir = path.join(tmpRoot, 'empty');
    const r = await runCollect(['--data-dir', dataDir, '--tag', 'no-such-tag', ...FAST]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /returned nothing/);
    assert.match(r.stderr, /--strategy event-slugs/);
    assert.equal(r.summary, null);
  });

  test('bad arguments exit with usage error', async () => {
    const r = await runCollect(['--strategy', 'bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--strategy must be one of/);
    assert.equal(r.requests.length, 0);
  });
});
