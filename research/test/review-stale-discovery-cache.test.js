// Review DI-4 (permanent): discovery responses in raw/ used to never expire. A market that was not
// yet closed/resolved when first listed kept being skipped as not_closed on every resumed run, even
// after it resolved: forever for --strategy event-slugs (the URL has no date, and 404s were cached
// too) and for events-tag with a fixed --until. Now only responses whose markets are all final are
// cached, cached entries are re-checked on read, and 404s are never cached.
// SYNTHETIC mock data only. Run: node --test research/test/review-stale-discovery-cache.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, startMockServer } from './mock-server.js';
import { run } from '../collect.js';

const sink = { write: () => true };
const FAST = ['--rps', '500', '--concurrency', '8', '--retry-base-ms', '5', '--quiet'];

async function scenario(name, argsFor) {
  const fixture = buildFixture({ nEvents: 8, seed: 3 });
  const target = fixture.byCid.get(fixture.tricky.notClosed); // closed=false, outcomePrices 0.62/0.38
  const srv = await startMockServer({ fixture, faults: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cache-'));
  const dir = path.join(root, 'data');
  const collected = () => fs.readFileSync(path.join(dir, 'markets.jsonl'), 'utf8').includes(target.meta.cid);
  try {
    const slugs = path.join(root, 'slugs.txt');
    fs.writeFileSync(slugs, `${target.event.slug}\n`);
    const args = argsFor(dir, slugs);
    const r1 = await run([...args, ...FAST], { env: srv.env, stdout: sink, stderr: sink });
    assert.equal(r1.skipped.not_closed, 1, `${name}: open at first sight`);
    // The game settles; the live API now reports it closed and resolved.
    target.market.closed = true;
    target.market.outcomePrices = target.meta.winnerIndex === 0 ? '["1","0"]' : '["0","1"]';
    const r2 = await run([...args, ...FAST], { env: srv.env, stdout: sink, stderr: sink });
    assert.equal(r2.skipped.not_closed ?? 0, 0, `${name}: the resumed run must see the resolved state`);
    assert.equal(r2.kept, 1, name);
    assert.ok(collected(), name);
    const before = srv.requests.length;
    const r3 = await run([...args, ...FAST], { env: srv.env, stdout: sink, stderr: sink });
    assert.equal(r3.kept, 0);
    return { r3, gamma: srv.requests.slice(before).filter((q) => q.path.startsWith('/gamma/')), fixture };
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('event-slugs: a market resolved after the first run is collected on resume', async () => {
  const { r3, gamma } = await scenario('event-slugs', (dir, slugs) => ['--data-dir', dir, '--strategy', 'event-slugs', '--event-slugs', slugs]);
  assert.deepEqual(gamma, [], 'the now-final event comes from raw/');
  assert.ok(r3.http.cacheHits > 0);
});

test('events-tag with a fixed --until: a market resolved after the first run is collected on resume', async () => {
  const { gamma, fixture } = await scenario('events-tag --until', (dir) => ['--data-dir', dir, '--since', '2025-01-01', '--until', '2025-12-31', '--page-size', '50']);
  // The single listing page still holds the fixture's permanently ambiguous market, so it is
  // re-read every time (as is the empty end-of-listing page); nothing else is.
  assert.ok(fixture.byCid.get(fixture.tricky.ambiguous), 'fixture keeps an unresolved market on the page');
  assert.ok(gamma.length > 0 && gamma.every((q) => q.path === '/gamma/events'));
});

test('a 404 for an event slug is not cached: the event is found once it is live', async () => {
  const fixture = buildFixture({ nEvents: 4, seed: 4 });
  const ev = fixture.events.find((e) => e.markets.some((m) => fixture.byCid.get(m.conditionId)?.meta.kind === 'ok'));
  const idx = fixture.events.indexOf(ev);
  fixture.events.splice(idx, 1); // not listed yet
  const srv = await startMockServer({ fixture, faults: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cache404-'));
  try {
    const slugs = path.join(root, 'slugs.txt');
    fs.writeFileSync(slugs, `${ev.slug}\n`);
    const args = ['--data-dir', path.join(root, 'data'), '--strategy', 'event-slugs', '--event-slugs', slugs, ...FAST];
    await assert.rejects(run(args, { env: srv.env, stdout: sink, stderr: sink }), /None of the 1 slugs/);
    fixture.events.splice(idx, 0, ev);
    const r2 = await run(args, { env: srv.env, stdout: sink, stderr: sink });
    assert.ok(r2.kept > 0, 'found on the second run');
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
