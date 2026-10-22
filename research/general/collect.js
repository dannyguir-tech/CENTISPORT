#!/usr/bin/env node
// Collector for the NON-SPORTS ("general") track: closed, cleanly resolved Yes/No Polymarket markets
// in every category except sports and the recurring crypto "Up or Down" series.
//
// 1. Index: lists every closed event once through gamma /events/keyset (status projection, 500 per
//    page; plain /events stops at offset ~2000) and stores it in <data-dir>/index/. Resumable.
// 2. Order: events are processed in a fixed pseudo-random order (sha1 of salt:eventId), so any
//    prefix is a uniform random sample of the universe. Re-running continues the same order.
// 3. Per event (fetched in batches with /events?id=..): normalise markets, apply the builder's own
//    row-existence rule (lib.js decisionPlan) to skip markets that cannot produce a row, and fetch the
//    YES token's price history over the windows the builder reads (No = 1 - Yes: the live probe found
//    prices-history for the two tokens to be exact complements). negRisk events also get every
//    member's Yes history (groups/<eventId>.json), so the builder can compute synchronized Yes-sums.
//
// Writes under --data-dir: markets.jsonl, prices/<yesTokenId>.json, groups/<eventId>.json,
// events-done.jsonl (resume bookkeeping), index/ and collect-runs.jsonl (provenance, same
// convention as research/collect.js). Summary JSON on the last stdout line.
import { randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHttpClient, HttpError, writeFileAtomic } from '../lib/http.js';
import { DEFAULT_BASES as KIT_BASES } from '../collect.js';
import {
  DAY, DEFAULT_SINCE, HOUR, bool, categoryOf, decisionPlan, feeInfoOf, isCryptoUpDown, isSportsEvent, isYesNo, listingTsOf, mergeWindows,
  parseJsonArray, parseTs, priceWindows, questionFlags, resolveWinner, sampleKey, tagSlugs, umaIsFinal, windowsCover,
} from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL = 'research/general/collect.js';
export const DEFAULT_BASES = Object.freeze({ gamma: KIT_BASES.gamma, clob: KIT_BASES.clob });
const ID_RE = /^[\w-]{1,130}$/;
// clob rejects startTs/endTs spans above 15 days ("interval is too long"; probed 2026-10-22: 360 h ok,
// 384 h rejected) at any fidelity. A request with startTs only returns history up to the end.
const SPAN_LIMIT_SEC = 360 * HOUR;
const OPEN_ENDED_MAX_SEC = 120 * DAY;

const HELP = `Usage: node research/general/collect.js [options]

Collects closed, cleanly resolved NON-SPORTS Yes/No markets (crypto Up-or-Down series excluded).
  --data-dir DIR          default research/data-general
  --since YYYY-MM-DD      markets created on/after this date (default ${DEFAULT_SINCE})
  --until YYYY-MM-DD      markets created before this date (default none)
  --max-markets N         stop once markets.jsonl holds N markets (default 1000000)
  --max-events N          process at most N new events in this run (default 0 = no cap)
  --sample-salt S         salt of the fixed pseudo-random event order (default general-v1)
  --refresh-index         rebuild the event index (default: reuse a complete index)
  --index-only            build/load the index, print universe counts, collect nothing
  --exclude-tag-ids LIST  sent as exclude_tag_id (default 1,102127 = sports, up-or-down)
  --event-batch N         events per /events?id= request (default 10)
  --concurrency N         parallel requests (default 8)
  --rps N                 requests per second cap (default 8)
  --fidelity MIN          prices-history fidelity in minutes (default 60)
  --timeout-ms N / --retries N / --retry-base-ms N   HTTP tuning (30000 / 6 / 1000)
  --quiet                 only warnings and the final summary
Env: GAMMA_BASE, CLOB_BASE override the API bases (the data dir is then marked synthetic).
Safe to stop (SIGTERM/Ctrl-C) and re-run: finished events are skipped, price files are reused.`;

const OPTIONS = {
  'data-dir': { type: 'string', default: path.join(HERE, '..', 'data-general') },
  since: { type: 'date', default: DEFAULT_SINCE },
  until: { type: 'date', default: null },
  'max-markets': { type: 'int', default: 1000000, min: 1 },
  'max-events': { type: 'int', default: 0, min: 0 },
  'sample-salt': { type: 'string', default: 'general-v1' },
  'refresh-index': { type: 'bool', default: false },
  'index-only': { type: 'bool', default: false },
  'exclude-tag-ids': { type: 'string', default: '1,102127' },
  'event-batch': { type: 'int', default: 10, min: 1, max: 50 },
  'index-page-size': { type: 'int', default: 500, min: 1, max: 500 },
  'max-index-pages': { type: 'int', default: 2000, min: 1 },
  concurrency: { type: 'int', default: 8, min: 1 },
  rps: { type: 'number', default: 8, min: 0.01, max: 20 },
  fidelity: { type: 'int', default: 60, min: 1 },
  'timeout-ms': { type: 'int', default: 30000, min: 1 },
  retries: { type: 'int', default: 6, min: 0 },
  'retry-base-ms': { type: 'int', default: 1000, min: 0 },
  quiet: { type: 'bool', default: false },
  help: { type: 'bool', default: false },
};

export class UsageError extends Error {}
export class CollectError extends Error {}
const camel = (s) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const out = {};
  for (const [name, spec] of Object.entries(OPTIONS)) out[camel(name)] = spec.default;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument "${arg}"`);
    let value;
    const eq = arg.indexOf('=');
    if (eq >= 0) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const name = arg.slice(2);
    const spec = OPTIONS[name];
    if (!spec) throw new UsageError(`Unknown option --${name}`);
    if (spec.type === 'bool') {
      if (value != null && !/^(true|false|1|0)$/i.test(value)) throw new UsageError(`--${name} takes no value`);
      out[camel(name)] = value == null || /^(true|1)$/i.test(value);
      continue;
    }
    if (value == null) {
      value = argv[++i];
      if (value == null) throw new UsageError(`--${name} needs a value`);
    }
    if (spec.type === 'string') out[camel(name)] = value;
    else if (spec.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new UsageError(`--${name} must be YYYY-MM-DD`);
      out[camel(name)] = value;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) throw new UsageError(`--${name} must be a number`);
      if (spec.min != null && n < spec.min) throw new UsageError(`--${name} must be >= ${spec.min}`);
      if (spec.max != null && n > spec.max) throw new UsageError(`--${name} must be <= ${spec.max}`);
      out[camel(name)] = n;
    }
  }
  if (out.since && out.until && out.since >= out.until) throw new UsageError('--since must be before --until');
  return out;
}

// ---------- normalisation (exported for tests) ----------

export function parseHistory(body, url) {
  if (body == null) return [];
  const series = Array.isArray(body) ? body : body.history;
  if (!Array.isArray(series)) throw new CollectError(`Unexpected prices-history shape from ${url}: ${JSON.stringify(body).slice(0, 160)}`);
  const pts = [];
  for (const pt of series) {
    const t = parseTs(pt?.t ?? pt?.timestamp);
    const p = Number(pt?.p ?? pt?.price);
    if (t != null && t > 0 && Number.isFinite(p) && p >= 0 && p <= 1) pts.push({ t, p });
  }
  return pts;
}

const seriesSlugs = (ev) => (Array.isArray(ev?.series) ? ev.series.map((s) => s && (s.slug || s.ticker)).filter(Boolean) : []);
const feeTypesOf = (ev) => (Array.isArray(ev?.markets) ? ev.markets.map((m) => m && m.feeType).filter(Boolean) : []);

// Event-level exclusion -> reason or null. Works on both the status projection and full events.
export function eventExclusion(ev) {
  if (!ev || typeof ev !== 'object') return 'bad_event';
  if (isSportsEvent(ev.tags, feeTypesOf(ev))) return 'sports';
  if (isCryptoUpDown({ tags: ev.tags, title: ev.title, slug: ev.slug, series: ev.series })) return 'crypto_up_or_down';
  return null;
}

// Compact index row from a status-projection event.
export function indexRow(ev) {
  return {
    id: String(ev.id),
    title: ev.title ?? null,
    slug: ev.slug ?? null,
    createdAt: ev.createdAt ?? null,
    endDate: ev.endDate ?? null,
    closedTime: ev.closedTime ?? null,
    negRisk: bool(ev.negRisk),
    tags: tagSlugs(ev.tags),
    series: seriesSlugs(ev),
    nMarkets: Array.isArray(ev.markets) ? ev.markets.length : null,
    feeTypes: [...new Set(feeTypesOf(ev))],
  };
}

/**
 * gamma market + its event -> { record, plan, windows } or { skip: reason }.
 * Universe: Yes/No, closed, active (inactive negRisk placeholders never traded), created in
 * [since, until), clean final winner, UMA status final when present, a scheduled end (market endDate,
 * else the event's endDate), a closedTime, a listing time, and at least one possible decision.
 */
export function normalizeGeneralMarket(m, ev, { sinceTs = null, untilTs = null } = {}) {
  if (!m || typeof m !== 'object' || typeof m.conditionId !== 'string' || !ID_RE.test(m.conditionId)) return { skip: 'bad_shape' };
  const outcomes = parseJsonArray(m.outcomes);
  const tokenIds = parseJsonArray(m.clobTokenIds);
  if (!outcomes || !tokenIds || outcomes.length !== 2 || tokenIds.length !== 2 || !tokenIds.every((t) => ID_RE.test(String(t)))) return { skip: 'not_binary' };
  if (!isYesNo(outcomes)) return { skip: 'not_yes_no' };
  if (bool(m.closed) !== true) return { skip: 'not_closed' };
  if (bool(m.active) === false) return { skip: 'inactive_placeholder' };
  const createdTs = parseTs(m.createdAt) ?? parseTs(m.startDate);
  if (sinceTs != null && (createdTs == null || createdTs < sinceTs)) return { skip: 'created_before_since' };
  if (untilTs != null && createdTs != null && createdTs >= untilTs) return { skip: 'created_after_until' };
  const res = resolveWinner(m.outcomePrices, 2);
  if (res.skip) return res;
  if (!umaIsFinal(m.umaResolutionStatus)) return { skip: 'non_final_resolution' };

  const yesIndex = outcomes.findIndex((o) => String(o).trim().toLowerCase() === 'yes');
  const times = {
    createdAt: m.createdAt ?? null,
    startDate: m.startDate ?? null,
    acceptingOrdersTimestamp: m.acceptingOrdersTimestamp ?? null,
    endDate: m.endDate ?? null,
    eventEndDate: ev?.endDate ?? null,
    closedTime: m.closedTime ?? null,
    umaEndDate: m.umaEndDate ?? null,
  };
  // Anchor = scheduled end. A market without endDate inherits its event's endDate (the scheduled end
  // that applies to every member); with neither, the market is dropped.
  let anchorTs = parseTs(times.endDate);
  let anchorSource = 'market.endDate';
  if (anchorTs == null) { anchorTs = parseTs(times.eventEndDate); anchorSource = anchorTs == null ? null : 'event.endDate'; }
  const listingTs = listingTsOf(times);
  const closedTs = parseTs(times.closedTime);
  const plan = decisionPlan({ listingTs, anchorTs, closedTs });
  if (plan.reason) return { skip: plan.reason };
  if (!plan.decisions.length) return { skip: 'no_possible_decision' };
  const windows = priceWindows(plan, { listingTs, anchorTs, closedTs });
  const tags = tagSlugs(ev?.tags);
  const negRisk = bool(m.negRisk) === true && typeof m.negRiskMarketID === 'string' && m.negRiskMarketID !== '';
  return {
    plan,
    windows,
    record: {
      conditionId: m.conditionId,
      marketId: m.id != null ? String(m.id) : null,
      eventId: ev?.id != null ? String(ev.id) : null,
      eventSlug: ev?.slug ?? null,
      eventTitle: ev?.title ?? null,
      question: String(m.question ?? ''),
      slug: m.slug ?? null,
      groupItemTitle: m.groupItemTitle ?? null,
      category: categoryOf(tags),
      tags,
      series: seriesSlugs(ev),
      outcomes: outcomes.map(String),
      tokenIds: tokenIds.map(String),
      yesIndex,
      yesTokenId: String(tokenIds[yesIndex]),
      winnerIndex: res.winnerIndex,
      times,
      listingTs,
      anchorTs,
      anchorSource,
      closedTs,
      negRisk,
      negRiskMarketID: negRisk ? m.negRiskMarketID : null,
      negRiskOther: bool(m.negRiskOther),
      umaResolutionStatus: m.umaResolutionStatus ?? null,
      ...feeInfoOf(m),
      volume: Number.isFinite(Number(m.volumeNum ?? m.volume)) ? Number(m.volumeNum ?? m.volume) : null, // lifetime: never a feature
      questionFlags: questionFlags(m.question),
      collectedAt: 0,
    },
  };
}

// negRisk members of the event that share a negRiskMarketID (inactive placeholders never traded and
// are left out). Every member is listed, in or out of the universe: the Yes-sum needs all of them.
export function groupMembers(ev, negRiskMarketID) {
  const out = [];
  for (const m of Array.isArray(ev?.markets) ? ev.markets : []) {
    if (!m || bool(m.negRisk) !== true || m.negRiskMarketID !== negRiskMarketID || bool(m.active) === false) continue;
    const outcomes = parseJsonArray(m.outcomes);
    const tokenIds = parseJsonArray(m.clobTokenIds);
    if (!isYesNo(outcomes) || !tokenIds || tokenIds.length !== 2 || !tokenIds.every((t) => ID_RE.test(String(t)))) continue;
    const yesIndex = outcomes.findIndex((o) => String(o).trim().toLowerCase() === 'yes');
    const res = bool(m.closed) === true ? resolveWinner(m.outcomePrices, 2) : { skip: 'open' };
    out.push({
      conditionId: m.conditionId,
      yesTokenId: String(tokenIds[yesIndex]),
      question: String(m.question ?? ''),
      listingTs: listingTsOf(m),
      closedTs: bool(m.closed) === true ? parseTs(m.closedTime) : null,
      // Only used for members already closed at the row's time (then it is public).
      resolvedYes: res.winnerIndex == null ? null : res.winnerIndex === yesIndex ? 1 : 0,
    });
  }
  return out;
}

// ---------- prices ----------

async function readJsonIfExists(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

function dedupeSort(points) {
  const byT = new Map();
  for (const pt of points) byT.set(pt.t, pt.p);
  return [...byT].sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, p }));
}

async function getHistory(ctx, tokenId, a, b) {
  const qs = b == null ? `startTs=${a}` : `startTs=${a}&endTs=${b}`;
  const url = `${ctx.bases.clob}/prices-history?market=${encodeURIComponent(tokenId)}&${qs}&fidelity=${ctx.opts.fidelity}`;
  ctx.stats.prices.requests++;
  return parseHistory(await ctx.http.getJson(url, { allow404: true }), url);
}

// One window [a, b]: a single bounded request when it fits the span limit, an open-ended request
// (startTs only, trimmed) when the market's history after a is short, else bounded chunks.
async function fetchWindow(ctx, tokenId, a, b, closedTs) {
  if (b - a <= ctx.spanLimit) {
    try {
      return await getHistory(ctx, tokenId, a, b);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400 && /interval|too long|range/i.test(err.body) && b - a > 3 * HOUR) {
        ctx.stats.prices.splits++;
        ctx.spanLimit = Math.max(3 * HOUR, Math.floor((b - a) / 2));
        return fetchWindow(ctx, tokenId, a, b, closedTs);
      }
      throw err;
    }
  }
  if (closedTs != null && closedTs - a <= OPEN_ENDED_MAX_SEC) {
    ctx.stats.prices.openEnded++;
    return (await getHistory(ctx, tokenId, a, null)).filter((pt) => pt.t <= b);
  }
  let out = [];
  for (let s = a; s < b; s += ctx.spanLimit) out = out.concat(await fetchWindow(ctx, tokenId, s, Math.min(b, s + ctx.spanLimit), closedTs));
  return out;
}

// prices/<tokenId>.json = { tokenId, fidelity, windows: [[a, b], ...], points: [{ t, p }] }. A file is
// reused when its windows cover the request; otherwise only the missing windows are fetched.
async function loadOrFetchPrices(ctx, tokenId, windows, closedTs) {
  const file = path.join(ctx.dirs.prices, `${tokenId}.json`);
  const existing = await readJsonIfExists(file);
  if (existing && Array.isArray(existing.points) && windowsCover(existing.windows, windows)) {
    ctx.stats.prices.fromDisk++;
    return existing;
  }
  const have = existing && Array.isArray(existing.windows) ? existing.windows : [];
  const missing = windows.filter((w) => !windowsCover(have, [w]));
  let points = existing && Array.isArray(existing.points) ? existing.points.slice() : [];
  for (const [a, b] of missing) points = points.concat((await fetchWindow(ctx, tokenId, a, b, closedTs)).filter((pt) => pt.t >= a && pt.t <= b));
  const rec = { tokenId, fidelity: ctx.opts.fidelity, windows: mergeWindows(have, windows), points: dedupeSort(points) };
  await writeFileAtomic(file, JSON.stringify(rec));
  ctx.stats.prices.fetched++;
  if (!rec.points.length) ctx.stats.prices.emptyTokens++;
  return rec;
}

const inWindows = (pts, windows) => pts.some((pt) => windows.some(([a, b]) => pt.t >= a && pt.t <= b));

// ---------- index ----------

async function readJsonl(file) {
  const out = [];
  if (!existsSync(file)) return out;
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line from a killed run */ }
  }
  return out;
}

async function buildIndex(ctx) {
  const dir = ctx.dirs.index;
  const metaFile = path.join(dir, 'meta.json');
  const rowsFile = path.join(dir, 'events.jsonl');
  const excludeIds = ctx.opts.excludeTagIds.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  const params = { closed: 'true', order: 'id', ascending: 'false', excludeTagIds: excludeIds };
  let meta = ctx.opts.refreshIndex ? null : await readJsonIfExists(metaFile);
  if (meta && JSON.stringify(meta.params) !== JSON.stringify(params)) {
    ctx.warn('index was built with different listing parameters; rebuilding it');
    meta = null;
  }
  if (!meta) {
    meta = { v: 1, params, complete: false, cursor: null, pages: 0, rows: 0, startedAt: new Date().toISOString() };
    await writeFile(rowsFile, '');
    await writeFileAtomic(metaFile, JSON.stringify(meta));
  }
  if (!meta.complete) {
    ctx.log(`indexing closed events from ${ctx.bases.gamma}/events/keyset (resuming at page ${meta.pages})`);
    while (meta.pages < ctx.opts.maxIndexPages) {
      const qs = new URLSearchParams({ closed: 'true', order: 'id', ascending: 'false', limit: String(ctx.opts.indexPageSize), market_projection: 'status' });
      for (const id of excludeIds) qs.append('exclude_tag_id', id);
      if (meta.cursor) qs.set('after_cursor', meta.cursor);
      const url = `${ctx.bases.gamma}/events/keyset?${qs}`;
      const body = await ctx.http.getJson(url);
      const events = body && Array.isArray(body.events) ? body.events : Array.isArray(body) ? body : null;
      if (!events) throw new CollectError(`Unexpected /events/keyset response from ${url}: ${JSON.stringify(body).slice(0, 200)}`);
      if (events.length) await appendFile(rowsFile, events.map((e) => `${JSON.stringify(indexRow(e))}\n`).join(''));
      meta.pages++;
      meta.rows += events.length;
      meta.cursor = body.next_cursor || null;
      if (!events.length || !meta.cursor) meta.complete = true;
      await writeFileAtomic(metaFile, JSON.stringify(meta));
      if (meta.pages % 20 === 0) ctx.log(`index: ${meta.pages} pages, ${meta.rows} events`);
      if (meta.complete) break;
    }
    if (!meta.complete) ctx.warn(`index stopped at --max-index-pages ${ctx.opts.maxIndexPages}; raise it to list older events`);
    meta.finishedAt = new Date().toISOString();
    await writeFileAtomic(metaFile, JSON.stringify(meta));
  }
  const rows = await readJsonl(rowsFile);
  if (!rows.length) throw new CollectError(`The event index is empty: ${ctx.bases.gamma}/events/keyset?closed=true returned no events.`);
  return { meta, rows };
}

// Index rows -> universe candidates in sample order, plus counts of what was excluded.
export function orderUniverse(rows, { sinceTs, salt }) {
  const counts = { indexed: rows.length, sports: 0, crypto_up_or_down: 0, closed_before_since: 0, duplicate: 0, kept: 0 };
  const seen = new Set();
  const keep = [];
  for (const r of rows) {
    if (!r || r.id == null || seen.has(String(r.id))) { counts.duplicate++; continue; }
    seen.add(String(r.id));
    const why = eventExclusion({ ...r, markets: (r.feeTypes || []).map((feeType) => ({ feeType })) });
    if (why) { counts[why] = (counts[why] || 0) + 1; continue; }
    // Every market closed at or before the event's closedTime, and was created before it.
    const closed = parseTs(r.closedTime);
    if (sinceTs != null && closed != null && closed < sinceTs) { counts.closed_before_since++; continue; }
    keep.push({ ...r, key: sampleKey(salt, r.id) });
  }
  keep.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  counts.kept = keep.length;
  return { order: keep, counts };
}

// ---------- per event ----------

async function processEvent(ctx, ev) {
  const res = { eventId: String(ev.id), kept: [], skipped: {} };
  const skip = (k) => { res.skipped[k] = (res.skipped[k] || 0) + 1; };
  const why = eventExclusion(ev);
  if (why) { skip(`event_${why}`); return res; }
  const markets = Array.isArray(ev.markets) ? ev.markets : [];
  if (!markets.length) { skip('event_without_markets'); return res; }
  // Markets already in markets.jsonl are normalised again (their group windows must not shrink on a
  // retry) and filtered out only when appending.
  const cands = [];
  for (const m of markets) {
    const n = normalizeGeneralMarket(m, ev, ctx.range);
    if (n.skip) skip(n.skip);
    else cands.push(n);
  }
  if (!cands.length) return res;

  // negRisk groups: every member's Yes history over the union of the in-universe members' windows.
  const groups = new Map();
  for (const c of cands) {
    if (!c.record.negRisk) continue;
    let g = groups.get(c.record.negRiskMarketID);
    if (!g) groups.set(c.record.negRiskMarketID, (g = { id: c.record.negRiskMarketID, cands: [] }));
    g.cands.push(c);
  }
  const fetchJobs = new Map(); // tokenId -> { windows, closedTs }
  const want = (tokenId, windows, closedTs) => {
    const j = fetchJobs.get(tokenId);
    if (j) { j.windows = mergeWindows(j.windows, windows); j.closedTs = Math.max(j.closedTs ?? 0, closedTs ?? 0) || null; }
    else fetchJobs.set(tokenId, { windows: mergeWindows(windows), closedTs });
  };
  for (const c of cands) if (!c.record.negRisk) want(c.record.yesTokenId, c.windows, c.record.closedTs);
  const groupFiles = [];
  for (const g of groups.values()) {
    const members = groupMembers(ev, g.id);
    const windows = mergeWindows(...g.cands.map((c) => c.windows));
    for (const mb of members) want(mb.yesTokenId, windows, mb.closedTs ?? Math.max(...g.cands.map((c) => c.record.closedTs)));
    groupFiles.push({ file: path.join(ctx.dirs.groups, `${encodeURIComponent(res.eventId)}--${g.id.slice(0, 18)}.json`), body: { eventId: res.eventId, negRiskMarketID: g.id, windows, members } });
    for (const c of g.cands) c.record.groupFile = path.basename(groupFiles[groupFiles.length - 1].file);
  }
  const series = new Map();
  await Promise.all([...fetchJobs].map(async ([tokenId, job]) => {
    try {
      series.set(tokenId, await loadOrFetchPrices(ctx, tokenId, job.windows, job.closedTs));
    } catch (err) {
      ctx.warn(`prices failed for token ${tokenId.slice(0, 12)}... (event ${res.eventId}): ${err.message}`);
      series.set(tokenId, null);
    }
  }));
  for (const g of groupFiles) await writeFileAtomic(g.file, JSON.stringify(g.body));
  let failed = false;
  for (const c of cands) {
    const s = series.get(c.record.yesTokenId);
    if (s === null || s === undefined) { skip('price_fetch_failed'); failed = true; continue; }
    if (!inWindows(s.points, c.windows)) { skip('no_price_history'); continue; }
    c.record.collectedAt = Math.floor(Date.now() / 1000);
    res.kept.push(c.record);
  }
  // A group with a failed member fetch is retried as a whole on the next run.
  for (const g of groupFiles) if (g.body.members.some((mb) => series.get(mb.yesTokenId) === null)) failed = true;
  res.failed = failed;
  return res;
}

// ---------- main ----------

function resolveBases(env) {
  const strip = (s) => s.replace(/\/+$/, '');
  const bases = { gamma: strip(env.GAMMA_BASE || DEFAULT_BASES.gamma), clob: strip(env.CLOB_BASE || DEFAULT_BASES.clob) };
  return { bases, nonDefault: Object.keys(bases).some((k) => bases[k] !== DEFAULT_BASES[k]) };
}

export async function run(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, installSignalHandlers = true } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { stdout.write(`${HELP}\n`); return null; }
  const t0 = Date.now();
  const say = (msg) => stderr.write(`[general-collect] ${msg}\n`);
  const log = opts.quiet ? () => {} : say;
  const warn = (msg) => say(`warning: ${msg}`);
  const { bases, nonDefault } = resolveBases(env);
  if (nonDefault) warn(`non-default API bases (${Object.values(bases).join(', ')}); this data dir will be marked synthetic`);
  const dataDir = path.resolve(opts.dataDir);
  const dirs = { prices: path.join(dataDir, 'prices'), groups: path.join(dataDir, 'groups'), index: path.join(dataDir, 'index') };
  await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));

  const runsFile = path.join(dataDir, 'collect-runs.jsonl');
  const runLine = {
    runId: randomUUID(), tool: TOOL, at: new Date().toISOString(), argv, bases,
    synthetic: nonDefault ? 'API bases were overridden; treat this data as non-Polymarket unless they proxy Polymarket' : null,
  };
  const endLine = (status, extra) => `${JSON.stringify({ ...runLine, status, endedAt: new Date().toISOString(), ...extra })}\n`;
  await appendFile(runsFile, `${JSON.stringify({ ...runLine, status: 'started' })}\n`);
  const onSignal = (signal) => {
    try { appendFileSync(runsFile, endLine('interrupted', { signal })); } finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
  };
  if (installSignalHandlers) { process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); }
  let summary = null;
  let error = null;
  try {
    summary = await collectInto({ opts, stdout, say, log, warn, bases, runLine, dataDir, dirs, t0 });
    return summary;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    if (installSignalHandlers) { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
    try {
      await appendFile(runsFile, summary ? endLine('completed', summary) : endLine('failed', { error: String(error?.message ?? error).slice(0, 300) }));
    } catch (e) {
      warn(`could not record the end of this run in ${runsFile}: ${e.message}`);
    }
  }
}

async function collectInto({ opts, stdout, say, log, warn, bases, dataDir, dirs, t0 }) {
  const marketsFile = path.join(dataDir, 'markets.jsonl');
  const doneFile = path.join(dataDir, 'events-done.jsonl');
  const http = createHttpClient({ concurrency: opts.concurrency, rps: opts.rps, cacheDir: null, timeoutMs: opts.timeoutMs, retries: opts.retries, retryBaseMs: opts.retryBaseMs, log });
  const stats = { prices: { requests: 0, fetched: 0, fromDisk: 0, emptyTokens: 0, splits: 0, openEnded: 0 }, events: { fetched: 0, notFound: 0, done: 0, failed: 0 }, skipped: {} };
  const sinceTs = parseTs(opts.since);
  const untilTs = opts.until ? parseTs(opts.until) : null;
  const ctx = { opts, bases, http, dirs, stats, log, warn, spanLimit: SPAN_LIMIT_SEC, range: { sinceTs, untilTs }, existing: new Set() };

  for (const r of await readJsonl(marketsFile)) if (r && typeof r.conditionId === 'string') ctx.existing.add(r.conditionId);
  const done = new Set((await readJsonl(doneFile)).filter((d) => d && d.eventId != null && !d.failed).map((d) => String(d.eventId)));
  const { meta, rows } = await buildIndex(ctx);
  const { order, counts } = orderUniverse(rows, { sinceTs, salt: opts.sampleSalt });
  const todo = order.filter((r) => !done.has(r.id));
  log(`index: ${rows.length} closed events (${meta.complete ? 'complete' : 'INCOMPLETE'}); universe ${order.length} events after exclusions ${JSON.stringify(counts)}; ${done.size} done, ${todo.length} to go; ${ctx.existing.size} markets in markets.jsonl`);

  let kept = 0;
  let processed = 0;
  const total = () => ctx.existing.size;
  let appendChain = Promise.resolve();
  const append = (file, text) => (appendChain = appendChain.then(() => appendFile(file, text)));
  let lastLog = 0;
  const progress = (force = false) => {
    if (!force && Date.now() - lastLog < 10000) return;
    lastLog = Date.now();
    const s = http.stats;
    const secs = (Date.now() - t0) / 1000;
    log(`events ${processed} this run (${done.size + stats.events.done} done of ${order.length}) | kept ${kept} new, ${total()} total | requests ${s.requests} (${(s.requests / Math.max(secs, 0.001)).toFixed(1)}/s, 429s ${s.byStatus[429] || 0}, retries ${s.retries})`);
  };

  const stopReason = () => (total() >= opts.maxMarkets ? 'max_markets' : opts.maxEvents && processed >= opts.maxEvents ? 'max_events' : null);
  if (!opts.indexOnly) {
    let next = 0;
    const workers = Math.max(1, Math.min(4, Math.ceil(opts.concurrency / 3)));
    const worker = async () => {
      while (next < todo.length && !stopReason()) {
        const room = opts.maxEvents ? Math.max(0, opts.maxEvents - processed) : Infinity;
        const batch = todo.slice(next, next + Math.min(opts.eventBatch, room));
        if (!batch.length) return;
        next += batch.length;
        processed += batch.length;
        const qs = new URLSearchParams({ limit: String(batch.length) });
        for (const r of batch) qs.append('id', r.id);
        const url = `${bases.gamma}/events?${qs}`;
        let events;
        try {
          const body = await http.getJson(url);
          events = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
          if (!events) throw new CollectError(`Unexpected /events response shape: ${JSON.stringify(body).slice(0, 160)}`);
        } catch (err) {
          warn(`event batch failed (${batch.map((r) => r.id).join(',')}): ${err.message}`);
          stats.events.failed += batch.length;
          continue;
        }
        stats.events.fetched += events.length;
        const byId = new Map(events.map((e) => [String(e.id), e]));
        for (const r of batch) {
          const ev = byId.get(r.id);
          let res;
          if (!ev) { stats.events.notFound++; res = { eventId: r.id, kept: [], skipped: { event_not_found: 1 } }; }
          else res = await processEvent(ctx, ev);
          for (const [k, v] of Object.entries(res.skipped)) stats.skipped[k] = (stats.skipped[k] || 0) + v;
          const fresh = res.kept.filter((rec) => !ctx.existing.has(rec.conditionId));
          for (const rec of fresh) ctx.existing.add(rec.conditionId);
          kept += fresh.length;
          if (fresh.length) await append(marketsFile, fresh.map((rec) => `${JSON.stringify(rec)}\n`).join(''));
          // Markets first, then the done line: a kill in between only redoes the event.
          await append(doneFile, `${JSON.stringify({ eventId: res.eventId, kept: fresh.length, skipped: res.skipped, failed: !!res.failed, at: Math.floor(Date.now() / 1000) })}\n`);
          if (res.failed) stats.events.failed++;
          else stats.events.done++;
          progress();
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    await appendChain;
  }

  const remaining = todo.length - stats.events.done;
  const s = http.stats;
  const summary = {
    ok: stats.events.failed === 0,
    synthetic: nonDefaultNote(bases),
    tool: TOOL,
    dataDir,
    bases,
    index: { complete: !!meta.complete, events: rows.length, universeEvents: order.length, exclusions: counts },
    kept,
    totalInFile: total(),
    eventsProcessed: processed,
    eventsDone: done.size + stats.events.done,
    eventsRemaining: Math.max(0, remaining),
    stop: opts.indexOnly ? 'index_only' : stopReason() || (remaining <= 0 ? 'universe_exhausted' : stats.events.failed ? 'failures' : 'end'),
    nothingLeft: remaining <= 0,
    skipped: Object.fromEntries(Object.entries(stats.skipped).sort()),
    events: stats.events,
    prices: stats.prices,
    http: s,
    share429: s.requests ? (s.byStatus[429] || 0) / s.requests : 0,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
  };
  progress(true);
  say(`done in ${summary.elapsedSec}s: kept ${kept} new markets (${summary.totalInFile} in markets.jsonl), ${summary.eventsDone}/${order.length} universe events done, stop: ${summary.stop}`);
  if (summary.share429 > 0.01) warn(`${(summary.share429 * 100).toFixed(1)}% of requests got HTTP 429: halve --rps / --concurrency`);
  if (stats.events.failed) warn(`${stats.events.failed} event(s) failed; re-run the same command to retry them`);
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const nonDefaultNote = (bases) => (Object.keys(bases).some((k) => bases[k] !== DEFAULT_BASES[k]) ? 'API bases were overridden; treat this data as non-Polymarket unless they proxy Polymarket' : null);

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then(
    () => {},
    (err) => {
      if (err instanceof UsageError) { process.stderr.write(`[general-collect] ${err.message}\n\n${HELP}\n`); process.exitCode = 2; }
      else { process.stderr.write(`[general-collect] error: ${err instanceof CollectError ? err.message : err.stack || err}\n`); process.exitCode = 1; }
    }
  );
}
