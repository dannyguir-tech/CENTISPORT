#!/usr/bin/env node
// Collects RESOLVED Polymarket sports markets plus price history (and optionally trades) around
// game start into a research data dir. Safe to re-run: markets already in markets.jsonl and
// price/trade files already on disk are skipped, and discovery responses whose markets are all
// final are served from the raw/ cache.
import { randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHttpClient, createLimiter, HttpError, writeFileAtomic } from './lib/http.js';
import { createTape, TAPE_VERSION } from './lib/tape.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3600;
const DAY = 86400;
const TRADES_PAGE = 500;
const MIN_SPLIT_SEC = 3 * HOUR;

export const DEFAULT_BASES = {
  gamma: 'https://gamma-api.polymarket.com',
  clob: 'https://clob.polymarket.com',
  data: 'https://data-api.polymarket.com',
};

const HELP = `Usage: node research/collect.js [options]

Discovers resolved sports markets and writes, under --data-dir:
  markets.jsonl               one resolved market per line (deduped by conditionId)
  prices/<tokenId>.json       { tokenId, points:[{t,p}] } for [gameStart - pre-hours, gameStart + post-hours]
  trades/<conditionId>.jsonl  pre-game trades in [gameStart - pre-hours, gameStart] (with --trades)
  trades/<conditionId>.meta.json  how far back that tape is complete (also in markets.jsonl tradesInfo)
  raw/<sha1(url)>.json        response cache for discovery requests whose markets are all final
  collect-runs.jsonl          provenance: a "started" line before any market is written, then a
                              completed / failed / interrupted line (args, API bases, summary)

Options:
  --data-dir DIR              default research/data
  --strategy NAME             events-tag (default) | events-series | markets | event-slugs
  --tag LIST                  comma-separated tag slugs or numeric tag ids (default "sports")
  --series LIST               comma-separated series ids (events-series)
  --event-slugs FILE          one event slug or polymarket URL per line (event-slugs)
  --since YYYY-MM-DD          keep games starting on/after this date (UTC)
  --until YYYY-MM-DD          keep games starting on/before this date (UTC)
  --max-markets N             stop once markets.jsonl holds N markets (default 3000)
  --trades                    also fetch trades from data-api; markets already in markets.jsonl
                              without a current trade tape are backfilled first
  --max-trades-per-market N   default 3000 pre-game trades; paging stops there (tradesInfo.coverageFromT
                              records how far back the tape is complete; in-game trades never count)
  --max-trade-pages N         default 30 pages of ${TRADES_PAGE}
  --concurrency N             parallel requests (default 4)
  --rps N                     requests per second cap (default 4)
  --fidelity MIN              price history resolution in minutes (default 15)
  --pre-hours H / --post-hours H   price window around game start (default 78 / 2)
  --page-size N               discovery page size (default 100)
  --max-pages N               discovery page cap per tag/series (default 500)
  --order FIELD               gamma sort field, newest first (default endDate; "none" to omit)
  --window-hours H            sample over time: list events in end-date windows of H hours, newest
                              window first, from --until (+8 days) back to --since (needs --since;
                              default 0 = one listing, newest first)
  --max-markets-per-window N  with --window-hours: accept at most N markets per window (markets
                              already in markets.jsonl count); the rest are skipped as
                              sampled_out_window (default 0 = no cap). A capped window is read
                              until it holds 4N markets (or ends) and taken round-robin over sports
                              (fixed per-window shuffle), first game of each sport first
  --max-markets-per-game N    accept at most N markets per game (gameKey: the event slug up to its
                              date, else gamma gameId), in gamma's order; the rest are skipped as
                              sampled_out_game (default 0 = no cap)
  --timeout-ms N / --retries N / --retry-base-ms N   HTTP tuning (30000 / 6 / 1000)
  --no-cache                  do not read or write raw/ cache
  --quiet                     only warnings and the final summary
Env: GAMMA_BASE, CLOB_BASE, DATA_BASE override the API base URLs (e.g. the local mock server).
The final summary is printed to stdout as JSON; progress goes to stderr.`;

const OPTIONS = {
  'data-dir': { type: 'string', default: path.join(HERE, 'data') },
  strategy: { type: 'enum', values: ['events-tag', 'events-series', 'markets', 'event-slugs'], default: 'events-tag' },
  tag: { type: 'string', default: 'sports' },
  series: { type: 'string', default: null },
  'event-slugs': { type: 'string', default: null },
  since: { type: 'date', default: null },
  until: { type: 'date', default: null },
  'max-markets': { type: 'int', default: 3000, min: 1 },
  trades: { type: 'bool', default: false },
  'max-trades-per-market': { type: 'int', default: 3000, min: 1 },
  'max-trade-pages': { type: 'int', default: 30, min: 1 },
  concurrency: { type: 'int', default: 4, min: 1 },
  rps: { type: 'number', default: 4, min: 0.01 },
  fidelity: { type: 'int', default: 15, min: 1 },
  'pre-hours': { type: 'number', default: 78, min: 0 },
  'post-hours': { type: 'number', default: 2, min: 0 },
  'page-size': { type: 'int', default: 100, min: 1, max: 500 },
  'max-pages': { type: 'int', default: 500, min: 1 },
  order: { type: 'string', default: 'endDate' },
  'window-hours': { type: 'number', default: 0, min: 0 },
  'max-markets-per-window': { type: 'int', default: 0, min: 0 },
  'max-markets-per-game': { type: 'int', default: 0, min: 0 },
  'timeout-ms': { type: 'int', default: 30000, min: 1 },
  retries: { type: 'int', default: 6, min: 0 },
  'retry-base-ms': { type: 'int', default: 1000, min: 0 },
  'no-cache': { type: 'bool', default: false },
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
    if (eq >= 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
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
    out[camel(name)] = coerce(name, spec, value);
  }
  if (out.strategy === 'event-slugs' && !out.eventSlugs) throw new UsageError('--strategy event-slugs needs --event-slugs <file>');
  if (out.strategy === 'events-series' && !out.series) throw new UsageError('--strategy events-series needs --series <id,...>');
  if (out.since && out.until && out.since > out.until) throw new UsageError('--since is after --until');
  if (out.windowHours > 0 && !out.since) throw new UsageError('--window-hours needs --since (the oldest window)');
  if (out.windowHours > 0 && !['events-tag', 'events-series'].includes(out.strategy)) throw new UsageError('--window-hours works with --strategy events-tag or events-series');
  if (out.maxMarketsPerWindow > 0 && !(out.windowHours > 0)) throw new UsageError('--max-markets-per-window needs --window-hours');
  return out;
}

function coerce(name, spec, value) {
  if (spec.type === 'string') return value;
  if (spec.type === 'enum') {
    if (!spec.values.includes(value)) throw new UsageError(`--${name} must be one of ${spec.values.join(', ')}`);
    return value;
  }
  if (spec.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
      throw new UsageError(`--${name} must be YYYY-MM-DD`);
    }
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) throw new UsageError(`--${name} must be a number`);
  if (spec.min != null && n < spec.min) throw new UsageError(`--${name} must be >= ${spec.min}`);
  if (spec.max != null && n > spec.max) throw new UsageError(`--${name} must be <= ${spec.max}`);
  return n;
}

// ---------- parsing helpers (exported for tests) ----------

export function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// gamma mixes "2025-03-01T00:30:00Z", "2025-03-01 00:30:00+00" and date-only strings; a missing
// zone is taken as UTC (Date.parse would use the local zone).
export function parseTs(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.floor(raw > 1e12 ? raw / 1000 : raw) : null;
  let s = String(raw).trim();
  if (/^\d+$/.test(s)) return parseTs(Number(s));
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s);
  if (m) {
    let tz = (m[3] || 'Z').toUpperCase();
    if (/^[+-]\d{2}$/.test(tz)) tz += ':00';
    else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    s = `${m[1]}T${m[2]}${tz}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s += 'T00:00:00Z';
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const hasTimeOfDay = (raw) => typeof raw === 'string' && /\d{2}:\d{2}/.test(raw);

// event.startDate is normally the listing time. Trust it as a game time only when it sits on a
// round 5-minute mark (no fractional seconds) and settlement follows within 24h (the dataset
// builder's default window, so anything collected this way is also accepted there).
export function looksLikeGameTime(raw, settleRaw) {
  if (!hasTimeOfDay(raw) || /\.\d*[1-9]/.test(raw)) return false;
  const t = parseTs(raw);
  const settle = parseTs(settleRaw);
  if (t == null || settle == null || t % 300 !== 0) return false;
  return settle >= t && settle - t <= 24 * HOUR;
}

const SPORT_ALIASES = (() => {
  const groups = {
    nba: ['nba'], wnba: ['wnba'], nfl: ['nfl'], mlb: ['mlb'], nhl: ['nhl'],
    ncaab: ['ncaab', 'cbb', 'college-basketball', 'march-madness'],
    ncaaf: ['ncaaf', 'cfb', 'college-football'],
    soccer: ['soccer', 'epl', 'premier-league', 'english-premier-league', 'la-liga', 'laliga', 'serie-a', 'bundesliga', 'ligue-1',
      'ucl', 'champions-league', 'uefa-champions-league', 'europa-league', 'uel', 'mls', 'liga-mx', 'eredivisie', 'fa-cup',
      'efl-championship', 'world-cup', 'fifa-world-cup', 'club-world-cup', 'copa-america', 'euros'],
    tennis: ['tennis', 'atp', 'wta', 'wimbledon', 'roland-garros', 'australian-open'],
    mma: ['mma', 'ufc', 'pfl', 'bellator'],
    boxing: ['boxing'], golf: ['golf', 'pga', 'pga-tour', 'liv-golf'], f1: ['f1', 'formula-1', 'formula1'],
    cricket: ['cricket', 'ipl'],
    cs2: ['cs2', 'csgo', 'cs-go', 'counter-strike', 'counter-strike-2'],
    lol: ['lol', 'league-of-legends'], dota2: ['dota2', 'dota-2', 'dota'], valorant: ['valorant'],
    // Generic buckets for gamma's many smaller leagues (2026: setka table tennis, bkarg, cpbl, ...).
    // They come from tags, which are checked last, so a league-level match always wins.
    'table-tennis': ['table-tennis'], basketball: ['basketball'], baseball: ['baseball'], hockey: ['hockey'],
    handball: ['handball'], darts: ['darts'], pickleball: ['pickleball'], rugby: ['rugby'], volleyball: ['volleyball'],
    esports: ['esports'],
  };
  const map = new Map();
  for (const [key, list] of Object.entries(groups)) for (const a of list) map.set(a, key);
  return map;
})();

const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function slugPrefixes(slug) {
  if (!slug) return [];
  const parts = slugify(slug).split('-');
  return [3, 2, 1].filter((n) => parts.length > n).map((n) => parts.slice(0, n).join('-'));
}

// Evidence order: gamma's event.sport.sport league key ("nba", "cfb", "atp"), series, event/market
// slug prefix ("nba-lal-bos-..."), then tags. A league key with no alias is kept as is (slugified)
// when nothing else matches, rather than losing the sport.
export function inferSport(event, market, tags = []) {
  const league = event?.sport && typeof event.sport === 'object' ? event.sport.sport : null;
  const cands = [league];
  for (const s of Array.isArray(event?.series) ? event.series : []) cands.push(s?.slug, s?.ticker, s?.title);
  cands.push(...slugPrefixes(event?.slug), ...slugPrefixes(market?.slug), ...tags);
  for (const c of cands) {
    if (c == null || c === '') continue;
    const hit = SPORT_ALIASES.get(String(c).toLowerCase().trim()) || SPORT_ALIASES.get(slugify(c));
    if (hit) return hit;
  }
  return league != null && slugify(league) ? slugify(league) : null;
}

// One real game is often split across several gamma events ("mlb-mil-lad-2026-10-15",
// "...-player-props", "...-inning-1-winner", "...-more-markets"). Markets of one game are
// correlated, so the dataset clusters on this key: the event slug up to its date, else gamma's
// gameId, else the event slug.
export function gameKeyOf(event, market) {
  const slug = event?.slug ?? market?.slug ?? null;
  const dated = slug ? /^(.+?-\d{4}-\d{2}-\d{2})(?:-|$)/.exec(slugify(slug)) : null;
  if (dated) return dated[1];
  if (event?.gameId != null && String(event.gameId).trim() !== '') return `game-${String(event.gameId).trim()}`;
  return slug ?? null;
}

export function tagList(...lists) {
  const out = [];
  for (const list of lists) {
    for (const t of Array.isArray(list) ? list : []) {
      const v = typeof t === 'string' ? t : t && (t.slug || t.label);
      if (v && !out.includes(String(v))) out.push(String(v));
    }
  }
  return out;
}

// Number() would turn "", " ", null and false into 0 and true into 1, which lets a malformed or
// partly missing price array pass as a clean resolution.
const NUMERIC_RE = /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/;
const strictNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && NUMERIC_RE.test(v) ? Number(v) : NaN);

export function resolveWinner(outcomePrices, n) {
  const arr = parseJsonArray(outcomePrices);
  if (!arr || arr.length !== n) return { skip: 'missing_outcome_prices' };
  const p = arr.map(strictNumber);
  if (p.some((x) => !Number.isFinite(x))) return { skip: 'ambiguous_resolution' };
  const ones = p.flatMap((x, i) => (Math.abs(x - 1) < 1e-9 ? [i] : []));
  if (ones.length === 1 && p.every((x, i) => i === ones[0] || Math.abs(x) < 1e-6)) return { winnerIndex: ones[0] };
  if (p.every((x) => Math.abs(x - 1 / n) < 1e-6)) return { skip: 'voided_50_50' };
  return { skip: 'ambiguous_resolution' };
}

// A market that can no longer change: closed with a clean winner or a 50-50 void. Discovery
// responses are cached only when every market in them is final; otherwise a market fetched while
// open (or before its outcomePrices settled) would be replayed from raw/ and skipped forever.
export function isFinalMarket(m) {
  if (!m || typeof m !== 'object' || bool(m.closed) !== true) return false;
  const outcomes = parseJsonArray(m.outcomes);
  const res = resolveWinner(m.outcomePrices, outcomes ? outcomes.length : -1);
  return res.winnerIndex != null || res.skip === 'voided_50_50';
}

// Listing pages carry every market's full gamma object (~50 KB per event in 2026). Only these
// fields are read, so pages are trimmed to them before caching (and returned trimmed either way).
const EVENT_FIELDS = ['id', 'slug', 'ticker', 'title', 'startDate', 'endDate', 'startTime', 'closedTime', 'closed', 'negRisk', 'gameId', 'tags', 'series', 'sport', 'markets'];
const MARKET_FIELDS = ['id', 'conditionId', 'question', 'slug', 'outcomes', 'outcomePrices', 'clobTokenIds', 'closed', 'startDate', 'endDate', 'closedTime',
  'gameStartTime', 'eventStartTime', 'volume', 'volumeNum', 'negRisk', 'sportsMarketType', 'tags', 'events', 'feeType', 'feesEnabled', 'feeSchedule'];
const pick = (o, keys) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};
const slimTag = (t) => (t && typeof t === 'object' ? pick(t, ['id', 'slug', 'label']) : t);
const slimSeries = (x) => (x && typeof x === 'object' ? pick(x, ['id', 'slug', 'ticker', 'title']) : x);
function slimMarket(m) {
  const out = pick(m, MARKET_FIELDS);
  if (out && Array.isArray(out.tags)) out.tags = out.tags.map(slimTag);
  if (out && Array.isArray(out.events)) out.events = out.events.map((ev) => slimEvent(ev, false));
  return out;
}
function slimEvent(ev, withMarkets = true) {
  const out = pick(ev, withMarkets ? EVENT_FIELDS : EVENT_FIELDS.filter((k) => k !== 'markets'));
  if (!out || typeof out !== 'object') return out;
  if (Array.isArray(out.tags)) out.tags = out.tags.map(slimTag);
  if (Array.isArray(out.series)) out.series = out.series.map(slimSeries);
  if (out.sport && typeof out.sport === 'object') out.sport = pick(out.sport, ['sport', 'id']);
  if (Array.isArray(out.markets)) out.markets = out.markets.map(slimMarket);
  return out;
}
export const slimListing = (body) => (Array.isArray(body) ? body.map((x) => slimEvent(x)) : body && Array.isArray(body.data) ? { ...body, data: body.data.map((x) => slimEvent(x)) } : body);
export const slimMarketsListing = (body) => (Array.isArray(body) ? body.map(slimMarket) : body && Array.isArray(body.data) ? { ...body, data: body.data.map(slimMarket) } : body);

const eventIsFinal = (ev) => ev != null && typeof ev === 'object' && (!Array.isArray(ev.markets) || ev.markets.every(isFinalMarket));
// Empty listing pages are never cached either: more items may appear at that offset later.
const listingIsFinal = (itemIsFinal) => (body) => {
  const items = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
  return items != null && items.length > 0 && items.every(itemIsFinal);
};
const finalEventsPage = listingIsFinal(eventIsFinal);
const finalMarketsPage = listingIsFinal(isFinalMarket);

const GAME_START_FIELDS = [
  ['market.gameStartTime', (m) => m.gameStartTime],
  ['market.eventStartTime', (m) => m.eventStartTime],
  ['event.startTime', (m, ev) => ev?.startTime],
];

const ID_RE = /^[\w-]{1,130}$/; // ids become file names
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/**
 * Turns a gamma market (+ parent event) into a markets.jsonl record, or { skip: reason }.
 * Game start: market.gameStartTime, market.eventStartTime, event.startTime (all scheduled kickoff
 * fields), else event.startDate only if it looks like a game time. Never endDate/closedTime:
 * those are settlement times and would leak.
 */
export function normalizeMarket(m, ev, { sinceTs = null, untilTs = null } = {}) {
  if (!m || typeof m !== 'object' || typeof m.conditionId !== 'string' || !ID_RE.test(m.conditionId)) return { skip: 'bad_shape' };
  const outcomes = parseJsonArray(m.outcomes);
  const tokenIds = parseJsonArray(m.clobTokenIds);
  if (!outcomes || !tokenIds || outcomes.length < 2 || outcomes.length !== tokenIds.length || !tokenIds.every((t) => ID_RE.test(String(t)))) {
    return { skip: 'bad_shape' };
  }
  if (bool(m.closed) !== true) return { skip: 'not_closed' };
  const res = resolveWinner(m.outcomePrices, outcomes.length);
  if (res.skip) return res;

  const times = {
    gameStartTime: null,
    startDate: m.startDate ?? null,
    endDate: m.endDate ?? null,
    closedTime: m.closedTime ?? null,
    eventStartDate: ev?.startDate ?? null,
    eventEndDate: ev?.endDate ?? null,
    gameStartSource: null,
  };
  let startTs = null;
  for (const [source, get] of GAME_START_FIELDS) {
    const raw = get(m, ev);
    if (hasTimeOfDay(raw) && parseTs(raw) != null) {
      times.gameStartTime = raw;
      times.gameStartSource = source;
      startTs = parseTs(raw);
      break;
    }
  }
  if (startTs == null && looksLikeGameTime(times.eventStartDate, times.closedTime ?? times.endDate ?? times.eventEndDate)) {
    startTs = parseTs(times.eventStartDate);
    times.gameStartSource = 'eventStartDate';
  }
  if (startTs == null) return { skip: 'no_game_start' };
  // Settled before the scheduled start: wrong start time or a cancelled game; prices would leak.
  const closedTs = parseTs(times.closedTime);
  if (closedTs != null && closedTs <= startTs) return { skip: 'closed_before_start' };
  if ((sinceTs != null && startTs < sinceTs) || (untilTs != null && startTs >= untilTs)) return { skip: 'out_of_range' };

  const tags = tagList(ev?.tags, m.tags);
  return {
    startTs,
    record: {
      conditionId: m.conditionId,
      question: String(m.question ?? ''),
      slug: m.slug ?? null,
      eventSlug: ev?.slug ?? null,
      eventTitle: ev?.title ?? null,
      gameKey: gameKeyOf(ev, m),
      sport: inferSport(ev, m, tags),
      tags,
      outcomes: outcomes.map(String),
      tokenIds: tokenIds.map(String),
      winnerIndex: res.winnerIndex,
      times,
      volume: num(m.volumeNum ?? m.volume), // lifetime volume: leaks the future, never a feature
      negRisk: bool(m.negRisk ?? ev?.negRisk),
      collectedAt: 0,
    },
  };
}

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

export function normalizeTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = parseTs(raw.timestamp ?? raw.t);
  const size = Number(raw.size);
  const price = Number(raw.price);
  const side = String(raw.side || '').toUpperCase();
  if (!t || !(size > 0) || !Number.isFinite(price) || !raw.asset || (side !== 'BUY' && side !== 'SELL')) return null;
  return { t, asset: String(raw.asset), side, size, price, wallet: raw.proxyWallet || raw.maker || raw.taker || null };
}

const asArray = (body, url) => {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  throw new CollectError(`Unexpected response shape from ${url} (expected an array): ${JSON.stringify(body).slice(0, 200)}`);
};

function dedupeSort(points) {
  const byT = new Map();
  for (const pt of points) byT.set(pt.t, pt.p);
  return [...byT].sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, p }));
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readSlugList(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*/, '').trim();
    if (!line) continue;
    let slug = line;
    if (line.includes('/')) {
      const parts = line.replace(/[?#].*$/, '').split('/').filter(Boolean);
      const ei = parts.indexOf('event');
      slug = ei >= 0 && parts[ei + 1] ? parts[ei + 1] : parts[parts.length - 1];
    }
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

// ---------- discovery ----------

function tagFilters(spec) {
  return spec
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? { label: `tag_id=${t}`, params: { tag_id: t } } : { label: `tag_slug=${t}`, params: { tag_slug: t } }));
}

const isoSec = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');

// endDate can trail the game by days, so the server-side bound is loose; startTs is filtered exactly.
function endDateBounds(opts) {
  const until = opts.until ?? new Date().toISOString().slice(0, 10);
  return { min: opts.since ? parseTs(opts.since) : null, max: parseTs(until) + 8 * DAY };
}

function listingParams(ctx) {
  const p = { closed: 'true' };
  if (ctx.opts.order && ctx.opts.order !== 'none') Object.assign(p, { order: ctx.opts.order, ascending: 'false' });
  const { min, max } = endDateBounds(ctx.opts);
  if (min != null) p.end_date_min = isoSec(min);
  p.end_date_max = isoSec(max);
  return p;
}

// --window-hours: end-date windows [a, b - 1s] on a fixed UTC grid, newest first, so re-runs hit the
// same (cacheable) URLs and adjacent windows never overlap.
export function endDateWindows(opts) {
  const step = Math.round(opts.windowHours * HOUR);
  if (!(step > 0)) return null;
  const { min, max } = endDateBounds(opts);
  const out = [];
  for (let b = Math.ceil((max + 1) / step) * step; b > min; b -= step) {
    out.push({ min: isoSec(Math.max(min, b - step)), max: isoSec(b - 1), label: `${isoSec(Math.max(min, b - step))}..${isoSec(b - 1)}` });
  }
  return out;
}

const itemKey = (it) => (it && (it.id ?? it.conditionId ?? it.slug)) ?? JSON.stringify(it).slice(0, 200);
const OFFSET_CAP_RE = /offset/i;

// Advances by the number of items actually returned and stops on an empty page, so a server-side
// cap on `limit` below --page-size can't silently end discovery after the first page.
// gamma rejects deep offsets (offset > 2000 -> HTTP 422 "offset too large, use /events/keyset").
// When the listing is sorted by endDate newest first, paging then continues with a date cursor:
// end_date_max moves to the oldest endDate seen (inclusive) and offset restarts at 0; items at that
// boundary that were already yielded are dropped.
async function* pagedList(ctx, base, endpoint, params, label, cacheIf, shape = null) {
  const { pageSize, maxPages } = ctx.opts;
  const byEndDesc = params.order === 'endDate' && params.ascending === 'false';
  let cur = params;
  let offset = 0;
  let prevFirst = null;
  let edgeT = null; // oldest endDate yielded so far
  let edge = new Set(); // keys of yielded items with endDate === edgeT
  let resets = 0;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ ...cur, limit: String(pageSize), offset: String(offset) });
    const url = `${base}${endpoint}?${qs}`;
    let body;
    try {
      body = await ctx.http.getJson(url, { cache: ctx.cache, cacheIf, shape });
    } catch (err) {
      if (!(offset > 0 && err instanceof HttpError && (err.status === 422 || err.status === 400) && OFFSET_CAP_RE.test(err.body))) throw err;
      ctx.stats.discovery.offsetCapHits = (ctx.stats.discovery.offsetCapHits || 0) + 1;
      if (!byEndDesc || edgeT == null) {
        ctx.warn(`${label}: ${endpoint} rejects offset ${offset} and the listing is not sorted by endDate newest first, so it cannot go deeper; stopping`);
        return;
      }
      if (cur.end_date_max != null && parseTs(cur.end_date_max) === edgeT) {
        ctx.warn(`${label}: more than ${offset} items share endDate ${isoSec(edgeT)}; cannot page past them, stopping`);
        return;
      }
      if (!resets++) ctx.log(`${label}: ${endpoint} caps offset at ${offset - pageSize}..${offset}; continuing with end_date_max as a date cursor`);
      cur = { ...cur, end_date_max: isoSec(edgeT) };
      offset = 0;
      prevFirst = null;
      continue;
    }
    const items = asArray(body, url);
    ctx.stats.discovery.pages++;
    if (!items.length) return;
    const first = itemKey(items[0]);
    if (offset > 0 && first === prevFirst) {
      ctx.warn(`${label}: ${endpoint} returned the same page for offset ${offset}; the API seems to ignore offset, stopping`);
      return;
    }
    prevFirst = first;
    offset += items.length;
    const fresh = [];
    for (const it of items) {
      const key = itemKey(it);
      const t = parseTs(it?.endDate);
      if (edge.has(key) && t === edgeT) continue; // already yielded before a date-cursor reset
      fresh.push(it);
      if (t != null && (edgeT == null || t < edgeT)) {
        edgeT = t;
        edge = new Set();
      }
      if (t === edgeT) edge.add(key);
    }
    if (fresh.length) yield { items: fresh, url };
  }
  ctx.warn(`${label}: stopped after --max-pages ${maxPages}; raise it to go further back`);
}

const noEventsHelp = (ctx, what) =>
  `${what} returned nothing from ${ctx.bases.gamma} (closed=true${ctx.opts.since ? `, since ${ctx.opts.since}` : ''}${ctx.opts.until ? `, until ${ctx.opts.until}` : ''}). ` +
  'Gamma filter params are not guaranteed; try a numeric --tag (sent as tag_id), --strategy events-series --series <id>, ' +
  '--strategy markets --tag <id>, or --strategy event-slugs --event-slugs <file>, and check the date range.';

// FNV-1a: a fixed, outcome-blind shuffle key.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * Order for a capped window: round-robin over sports (in a fixed per-window shuffle), game-major:
 * the first game of every sport, then the second game of every sport, ...; a game's markets stay
 * together in gamma's order. Without it the cap fills with whatever ends last in the window, which
 * near "now" is all table tennis (setka endDate = start + 7 days). Uses only listing fields
 * (sport, slug, gameId, order), never prices, volume or outcomes.
 */
export function sampleOrder(pairs, windowLabel = '') {
  const sports = new Map(); // sport -> Map(gameKey -> pairs[])
  for (const p of pairs) {
    const sport = inferSport(p.event, p.market, tagList(p.event?.tags, p.market?.tags)) ?? 'unknown';
    const game = gameKeyOf(p.event, p.market) ?? p.market?.conditionId ?? '';
    if (!sports.has(sport)) sports.set(sport, new Map());
    const games = sports.get(sport);
    if (!games.has(game)) games.set(game, []);
    games.get(game).push(p);
  }
  const order = [...sports.keys()].sort((a, b) => hash32(`${windowLabel}|${a}`) - hash32(`${windowLabel}|${b}`) || (a < b ? -1 : 1));
  const lists = order.map((s) => [...sports.get(s).values()]);
  const out = [];
  for (let g = 0; out.length < pairs.length; g++) for (const games of lists) if (games[g]) out.push(...games[g]);
  return out;
}

async function* discoverEvents(ctx, filters) {
  let total = 0;
  let withMarkets = 0;
  const perFilter = new Map(filters.map((f) => [f.label, 0]));
  // Without --window-hours this is one window spanning the whole range.
  const windows = endDateWindows(ctx.opts) ?? [null];
  const cap = ctx.opts.maxMarketsPerWindow;
  for (const w of windows) {
    ctx.window = w ? w.label : null;
    ctx.windowFull = false;
    if (w) ctx.stats.discovery.windows++;
    // A capped window is buffered (until it holds 4x the cap in markets, or ends) and reordered by
    // sampleOrder; otherwise pages are passed on as they arrive.
    const buffer = w && cap > 0 ? [] : null;
    for (const f of filters) {
      if (ctx.windowFull || (buffer && buffer.length >= 4 * cap)) break;
      const params = { ...listingParams(ctx), ...f.params, ...(w ? { end_date_min: w.min, end_date_max: w.max } : {}) };
      for await (const { items } of pagedList(ctx, ctx.bases.gamma, '/events', params, w ? `${f.label} ${w.label}` : f.label, finalEventsPage, slimListing)) {
        perFilter.set(f.label, perFilter.get(f.label) + items.length);
        total += items.length;
        ctx.stats.discovery.events += items.length;
        const pairs = [];
        for (const ev of items) {
          if (!ev || !Array.isArray(ev.markets)) continue;
          withMarkets++;
          for (const m of ev.markets) pairs.push({ market: m, event: ev });
        }
        if (buffer) {
          buffer.push(...pairs);
          if (buffer.length >= 4 * cap) break;
          continue;
        }
        yield pairs;
        // The consumer sets windowFull once --max-markets-per-window is reached.
        if (ctx.windowFull) break;
      }
    }
    if (buffer && buffer.length) yield sampleOrder(buffer, w.label);
  }
  for (const [label, n] of perFilter) if (n === 0) ctx.warn(`${label} returned no closed events`);
  if (total === 0) throw new CollectError(noEventsHelp(ctx, `Discovery (${filters.map((f) => f.label).join(', ')})`));
  if (withMarkets === 0) throw new CollectError(`Events from ${ctx.bases.gamma}/events carry no "markets" array; the response shape has changed.`);
}

async function* discoverMarkets(ctx) {
  let total = 0;
  for (const f of tagFilters(ctx.opts.tag)) {
    let first = true;
    for await (const { items, url } of pagedList(ctx, ctx.bases.gamma, '/markets', { ...listingParams(ctx), ...f.params }, f.label, finalMarketsPage, slimMarketsListing)) {
      if (first && items.length) {
        const sporty = items.some((m) => m && (m.gameStartTime || m.sportsMarketType || inferSport(m.events?.[0], m, tagList(m.events?.[0]?.tags, m.tags))));
        if (!sporty) {
          throw new CollectError(`First page of ${url} has no sports-looking markets; the API may be ignoring the ${f.label} filter. Use a numeric --tag id or --strategy events-tag.`);
        }
      }
      first = false;
      total += items.length;
      ctx.stats.discovery.markets += items.length;
      yield items.map((m) => ({ market: m, event: Array.isArray(m?.events) && m.events[0] ? m.events[0] : null }));
    }
  }
  if (total === 0) throw new CollectError(noEventsHelp(ctx, `--strategy markets --tag ${ctx.opts.tag}`));
}

// 404s are not cached (cacheIf rejects a null body): a slug may simply not be live yet.
async function fetchEventBySlug(ctx, slug) {
  const enc = encodeURIComponent(slug);
  const direct = await ctx.http.getJson(`${ctx.bases.gamma}/events/slug/${enc}`, { cache: ctx.cache, allow404: true, cacheIf: eventIsFinal });
  if (direct && Array.isArray(direct.markets) && direct.markets.length) return direct;
  const url = `${ctx.bases.gamma}/events?slug=${enc}`;
  const listed = await ctx.http.getJson(url, { cache: ctx.cache, allow404: true, cacheIf: finalEventsPage });
  const ev = listed == null ? null : asArray(listed, url)[0];
  return ev && Array.isArray(ev.markets) && ev.markets.length ? ev : null;
}

async function* discoverEventSlugs(ctx) {
  let text;
  try {
    text = await readFile(ctx.opts.eventSlugs, 'utf8');
  } catch (err) {
    throw new CollectError(`Cannot read --event-slugs file ${ctx.opts.eventSlugs}: ${err.message}`);
  }
  const slugs = readSlugList(text);
  if (!slugs.length) throw new CollectError(`No slugs found in ${ctx.opts.eventSlugs}`);
  let found = 0;
  const batch = Math.max(ctx.opts.concurrency * 2, 8);
  for (let i = 0; i < slugs.length; i += batch) {
    const chunk = slugs.slice(i, i + batch);
    const events = await Promise.all(chunk.map((s) => fetchEventBySlug(ctx, s)));
    const pairs = [];
    events.forEach((ev, k) => {
      if (!ev) {
        ctx.skip('slug_not_found');
        ctx.warn(`event slug not found: ${chunk[k]}`);
        return;
      }
      found++;
      ctx.stats.discovery.events++;
      for (const m of ev.markets) pairs.push({ market: m, event: ev });
    });
    yield pairs;
  }
  if (!found) throw new CollectError(`None of the ${slugs.length} slugs in ${ctx.opts.eventSlugs} resolved at ${ctx.bases.gamma}`);
}

function discover(ctx) {
  switch (ctx.opts.strategy) {
    case 'events-series':
      return discoverEvents(ctx, ctx.opts.series.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ label: `series_id=${s}`, params: { series_id: s } })));
    case 'markets':
      return discoverMarkets(ctx);
    case 'event-slugs':
      return discoverEventSlugs(ctx);
    default:
      return discoverEvents(ctx, tagFilters(ctx.opts.tag));
  }
}

// ---------- per-market collection ----------

// clob rejects long ranges at fine fidelity. The accepted span is learned once (halving on each
// "too long" 400) and later windows are pre-chunked, so the probe isn't repeated per token.
async function fetchRange(ctx, tokenId, a, b) {
  if (b - a > ctx.priceSpanLimit) {
    let out = [];
    for (let s = a; s < b; s += ctx.priceSpanLimit) out = out.concat(await fetchRange(ctx, tokenId, s, Math.min(b, s + ctx.priceSpanLimit)));
    return out;
  }
  const url = `${ctx.bases.clob}/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${a}&endTs=${b}&fidelity=${ctx.opts.fidelity}`;
  try {
    return parseHistory(await ctx.http.getJson(url, { allow404: true }), url);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400 && /interval|too long|range/i.test(err.body) && b - a > MIN_SPLIT_SEC) {
      ctx.stats.prices.splits++;
      ctx.priceSpanLimit = Math.min(ctx.priceSpanLimit, Math.max(MIN_SPLIT_SEC, Math.floor((b - a) / 2)));
      return fetchRange(ctx, tokenId, a, b);
    }
    throw err;
  }
}

async function fetchPriceWindow(ctx, tokenId, a, b) {
  let pts = (await fetchRange(ctx, tokenId, a, b)).filter((pt) => pt.t >= a && pt.t <= b);
  if (!pts.length) {
    // Some resolved markets only answer interval=max; clip it to the window.
    const url = `${ctx.bases.clob}/prices-history?market=${encodeURIComponent(tokenId)}&interval=max&fidelity=${Math.max(ctx.opts.fidelity, 60)}`;
    pts = parseHistory(await ctx.http.getJson(url, { allow404: true }), url).filter((pt) => pt.t >= a && pt.t <= b);
    if (pts.length) ctx.stats.prices.maxFallback++;
  }
  return dedupeSort(pts);
}

async function loadOrFetchPrices(ctx, tokenId, a, b) {
  const file = path.join(ctx.dirs.prices, `${tokenId}.json`);
  const existing = await readJsonIfExists(file);
  if (existing && Array.isArray(existing.points)) {
    ctx.stats.prices.fromDisk++;
    return existing.points;
  }
  const points = await fetchPriceWindow(ctx, tokenId, a, b);
  await writeFileAtomic(file, JSON.stringify({ tokenId, points }));
  ctx.stats.prices.fetched++;
  if (!points.length) ctx.stats.prices.emptyTokens++;
  return points;
}

const tapeFiles = (ctx, conditionId) => {
  const base = path.join(ctx.dirs.trades, conditionId);
  return { trades: `${base}.jsonl`, meta: `${base}.meta.json` };
};

// Trades in [a, startTs] with coverage info. A tape on disk is reused only with its v2 sidecar;
// older tapes kept in-game trades and lost their coverage on resume, so they are fetched again.
async function loadOrFetchTrades(ctx, record, a, startTs) {
  const files = tapeFiles(ctx, record.conditionId);
  if (existsSync(files.trades)) {
    const meta = await readJsonIfExists(files.meta);
    if (meta && meta.v === TAPE_VERSION && meta.fromT === a && meta.toT === startTs) {
      ctx.stats.trades.fromDisk++;
      return meta;
    }
  }
  const { maxTradesPerMarket, maxTradePages } = ctx.opts;
  const tape = createTape({ conditionId: record.conditionId, tokenIds: record.tokenIds, fromT: a, toT: startTs, maxTrades: maxTradesPerMarket, normalize: normalizeTrade });
  let stop = null;
  let offset = 0;
  let probing = false;
  let shortLen = 0;
  for (let page = 0; !stop; page++) {
    if (page >= maxTradePages) {
      stop = 'max_pages';
      break;
    }
    const url = `${ctx.bases.data}/trades?market=${encodeURIComponent(record.conditionId)}&limit=${TRADES_PAGE}&offset=${offset}`;
    let body;
    try {
      body = await ctx.http.getJson(url, { allow404: true });
    } catch (err) {
      // data-api caps deep offsets with a 400; keep what we have and record the coverage.
      if (err instanceof HttpError && err.status === 400 && page > 0) {
        stop = 'deep_offset';
        break;
      }
      throw err;
    }
    if (body == null) {
      stop = 'end_of_tape';
      break;
    }
    const rows = asArray(body, url);
    if (probing) {
      probing = false;
      if (!rows.length) {
        // The short page really was the last one, so the server's cap is at least that long.
        ctx.tradesCapAtLeast = Math.max(ctx.tradesCapAtLeast, shortLen);
        stop = 'end_of_tape';
        break;
      }
      // A short page was followed by more rows: the server caps `limit` below what we asked for.
      ctx.tradesPageCap = Math.min(ctx.tradesPageCap ?? Infinity, shortLen);
      ctx.warn(`data-api /trades returns at most ${ctx.tradesPageCap} rows per page; paging by that`);
    }
    const state = tape.addPage(rows);
    if (state !== 'more') {
      stop = state;
      break;
    }
    offset += rows.length;
    if (!rows.length) stop = 'end_of_tape';
    else if (rows.length >= TRADES_PAGE) ctx.tradesPageCap ??= TRADES_PAGE;
    else if (ctx.tradesPageCap == null) {
      // Short page with the cap unknown: the last page, or a server-side cap. Shorter than a page
      // already proven complete means last page; otherwise one probe of the next offset decides.
      if (rows.length < ctx.tradesCapAtLeast) stop = 'end_of_tape';
      else {
        shortLen = rows.length;
        probing = true;
      }
    } else if (rows.length < ctx.tradesPageCap) stop = 'end_of_tape';
  }
  const { trades, info } = tape.finish(stop);
  // Tape first, then its sidecar: a crash in between leaves a tape without meta, which is refetched.
  await writeFileAtomic(files.trades, trades.map((t) => `${JSON.stringify(t)}\n`).join(''));
  await writeFileAtomic(files.meta, JSON.stringify(info));
  ctx.stats.trades.fetched++;
  ctx.stats.trades.rows += trades.length;
  if (info.truncated) ctx.stats.trades.truncated++;
  return info;
}

async function processMarket(ctx, { record, startTs }) {
  const a = startTs - Math.round(ctx.opts.preHours * HOUR);
  const b = startTs + Math.round(ctx.opts.postHours * HOUR);
  let series;
  try {
    series = await Promise.all(record.tokenIds.map((tid) => loadOrFetchPrices(ctx, tid, a, b)));
  } catch (err) {
    ctx.warn(`prices failed for ${record.conditionId}: ${err.message}`);
    return { skip: 'price_fetch_failed' };
  }
  if (series.every((s) => s.length === 0)) return { skip: 'no_price_history' };
  if (ctx.opts.trades) {
    try {
      record.tradesInfo = await loadOrFetchTrades(ctx, record, a, startTs);
    } catch (err) {
      ctx.warn(`trades failed for ${record.conditionId}: ${err.message}`);
      return { skip: 'trades_fetch_failed' };
    }
  }
  record.collectedAt = Math.floor(Date.now() / 1000);
  return { record };
}

// ---------- markets.jsonl bookkeeping ----------

// Loads collected conditionIds; drops torn/duplicate lines left by an interrupted run.
async function loadExistingMarkets(file, warn) {
  const ids = new Set();
  if (!existsSync(file)) return ids;
  let bad = 0;
  const scan = async (onGood) => {
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    const seen = new Set();
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o = null;
      try {
        o = JSON.parse(line);
      } catch {}
      if (!o || typeof o.conditionId !== 'string' || seen.has(o.conditionId)) {
        if (!onGood) bad++;
        continue;
      }
      seen.add(o.conditionId);
      if (onGood) await onGood(line);
      else ids.add(o.conditionId);
    }
  };
  await scan(null);
  if (bad) {
    warn(`markets.jsonl had ${bad} unreadable or duplicate line(s); rewriting without them`);
    const tmp = `${file}.${process.pid}.repair.tmp`;
    const out = createWriteStream(tmp);
    await scan((line) => new Promise((resolve) => (out.write(`${line}\n`) ? resolve() : out.once('drain', resolve))));
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    await rename(tmp, file);
  } else {
    const fh = await open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (size > 0) {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a) await appendFile(file, '\n');
      }
    } finally {
      await fh.close();
    }
  }
  return ids;
}

async function* readRecords(file) {
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o = null;
    try {
      o = JSON.parse(line);
    } catch {}
    if (o && typeof o.conditionId === 'string') yield o;
  }
}

// Streams markets.jsonl through fn(record) into a temp file, then swaps it in.
async function rewriteRecords(file, fn) {
  const tmp = `${file}.${process.pid}.rewrite.tmp`;
  const out = createWriteStream(tmp);
  for await (const rec of readRecords(file)) {
    if (!out.write(`${JSON.stringify(fn(rec))}\n`)) await new Promise((resolve) => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  await rename(tmp, file);
}

// The start normalizeMarket stored: gameStartTime, or eventStartDate when that was the source.
export function storedStartTs(times = {}) {
  return times.gameStartSource === 'eventStartDate' ? parseTs(times.eventStartDate) : parseTs(times.gameStartTime);
}

const hasCurrentTape = (ctx, rec) => rec.tradesInfo?.v === TAPE_VERSION && existsSync(tapeFiles(ctx, rec.conditionId).trades);

// Markets already in markets.jsonl but collected without --trades (the README's smoke test) or
// by an older collector get their tape before discovery starts. Otherwise the newest markets,
// i.e. the last out-of-sample fold, would silently have no trade features.
async function backfillTrades(ctx, marketsFile, limit) {
  if (!existsSync(marketsFile)) return;
  const todo = [];
  let total = 0;
  for await (const rec of readRecords(marketsFile)) {
    total++;
    if (!hasCurrentTape(ctx, rec)) todo.push(rec);
  }
  if (!todo.length) return;
  if (!ctx.opts.trades) {
    if (todo.length < total) ctx.warn(`${todo.length} of ${total} markets in markets.jsonl have no current trade tape; re-run with --trades to backfill them (their trade features stay null until then)`);
    return;
  }
  ctx.log(`backfilling trade tapes for ${todo.length} of ${total} markets already in markets.jsonl`);
  const infos = new Map();
  await Promise.all(
    todo.map((rec) =>
      limit(async () => {
        const startTs = storedStartTs(rec.times);
        try {
          if (startTs == null) throw new Error('no stored game start time');
          infos.set(rec.conditionId, await loadOrFetchTrades(ctx, rec, startTs - Math.round(ctx.opts.preHours * HOUR), startTs));
          ctx.stats.trades.backfilled++;
        } catch (err) {
          ctx.stats.trades.backfillFailed++;
          ctx.warn(`trade backfill failed for ${rec.conditionId}: ${err.message}`);
        }
      })
    )
  );
  if (infos.size) await rewriteRecords(marketsFile, (rec) => (infos.has(rec.conditionId) ? { ...rec, tradesInfo: infos.get(rec.conditionId) } : rec));
}

// ---------- main ----------

function resolveBases(env) {
  const strip = (s) => s.replace(/\/+$/, '');
  const bases = {
    gamma: strip(env.GAMMA_BASE || DEFAULT_BASES.gamma),
    clob: strip(env.CLOB_BASE || DEFAULT_BASES.clob),
    data: strip(env.DATA_BASE || DEFAULT_BASES.data),
  };
  return { bases, nonDefault: Object.keys(bases).some((k) => bases[k] !== DEFAULT_BASES[k]) };
}

export async function run(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    stdout.write(`${HELP}\n`);
    return null;
  }
  const t0 = Date.now();
  const say = (msg) => stderr.write(`[collect] ${msg}\n`);
  const log = opts.quiet ? () => {} : say;
  const warn = (msg) => say(`warning: ${msg}`);
  const { bases, nonDefault } = resolveBases(env);
  if (nonDefault) warn(`non-default API bases (${Object.values(bases).join(', ')}); output is only Polymarket data if these proxy Polymarket`);

  const dataDir = path.resolve(opts.dataDir);
  const dirs = { prices: path.join(dataDir, 'prices'), trades: path.join(dataDir, 'trades'), raw: path.join(dataDir, 'raw') };
  await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));

  // Provenance is written before any market can reach markets.jsonl, and the run's end is recorded
  // whatever happens, so a crashed or killed run with overridden bases still taints the data dir.
  const runsFile = path.join(dataDir, 'collect-runs.jsonl');
  const runLine = {
    runId: randomUUID(), tool: 'research/collect.js', at: new Date().toISOString(), argv, bases,
    synthetic: nonDefault ? 'API bases were overridden; treat this data as non-Polymarket unless they proxy Polymarket' : null,
  };
  const endLine = (status, extra) => `${JSON.stringify({ ...runLine, status, endedAt: new Date().toISOString(), ...extra })}\n`;
  await appendFile(runsFile, `${JSON.stringify({ ...runLine, status: 'started' })}\n`);
  const onSignal = (signal) => {
    try {
      appendFileSync(runsFile, endLine('interrupted', { signal }));
    } finally {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let summary = null;
  let error = null;
  try {
    summary = await collectInto({ opts, stdout, say, log, warn, bases, runLine, dataDir, dirs, t0 });
    return summary;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      await appendFile(runsFile, summary ? endLine('completed', summary) : endLine('failed', { error: String(error?.message ?? error).slice(0, 300) }));
    } catch (e) {
      warn(`could not record the end of this run in ${runsFile}: ${e.message}`);
    }
  }
}

async function collectInto({ opts, stdout, say, log, warn, bases, runLine, dataDir, dirs, t0 }) {
  const marketsFile = path.join(dataDir, 'markets.jsonl');

  const http = createHttpClient({
    concurrency: opts.concurrency,
    rps: opts.rps,
    cacheDir: opts.noCache ? null : dirs.raw,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    retryBaseMs: opts.retryBaseMs,
    log,
  });
  const stats = {
    discovery: { pages: 0, events: 0, markets: 0, candidates: 0, windows: 0, offsetCapHits: 0 },
    skipped: {},
    prices: { fetched: 0, fromDisk: 0, emptyTokens: 0, splits: 0, maxFallback: 0 },
    trades: { fetched: 0, fromDisk: 0, rows: 0, truncated: 0, backfilled: 0, backfillFailed: 0 },
  };
  const ctx = {
    opts, bases, http, dirs, stats, log, warn,
    cache: !opts.noCache,
    priceSpanLimit: Infinity,
    tradesPageCap: null, // learned server-side cap on /trades `limit`
    tradesCapAtLeast: 0,
    skip: (reason) => {
      stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
    },
  };

  const existing = await loadExistingMarkets(marketsFile, warn);
  const marketLimit = createLimiter(opts.concurrency);
  await backfillTrades(ctx, marketsFile, marketLimit);
  const sinceTs = opts.since ? parseTs(opts.since) : null;
  const untilTs = opts.until ? parseTs(opts.until) + DAY : null;
  let kept = 0;
  let alreadyCollected = 0;
  let pending = 0;
  const inflight = new Set();
  const backlog = Math.max(16, 4 * opts.concurrency);
  const total = () => existing.size + kept;
  const committed = () => total() + pending;
  let appendChain = Promise.resolve();
  const appendRecord = (rec) => (appendChain = appendChain.then(() => appendFile(marketsFile, `${JSON.stringify(rec)}\n`)));
  let lastLog = 0;
  const progress = (force = false) => {
    if (!force && Date.now() - lastLog < 5000) return;
    lastLog = Date.now();
    const s = http.stats;
    const skipped = Object.values(stats.skipped).reduce((x, y) => x + y, 0);
    const secs = (Date.now() - t0) / 1000;
    const win = ctx.window ? ` | window ${ctx.window}` : '';
    log(`pages ${stats.discovery.pages}${win} | kept ${kept} new, ${alreadyCollected} already | skipped ${skipped} | requests ${s.requests} (cache ${s.cacheHits}, retries ${s.retries}, 429s ${s.byStatus[429] || 0}) | ${(s.requests / Math.max(secs, 0.001)).toFixed(1)} req/s`);
  };

  if (existing.size >= opts.maxMarkets) {
    log(`markets.jsonl already holds ${existing.size} markets (>= --max-markets ${opts.maxMarkets}); nothing to do. Raise --max-markets to collect more.`);
  } else {
    log(`strategy ${opts.strategy}, ${existing.size} markets already collected, target ${opts.maxMarkets}`);
    const seen = new Set();
    // Sampling caps (--max-markets-per-window / --max-markets-per-game). Markets already in
    // markets.jsonl count, so a re-run walks the same listings and accepts the same markets.
    const perWindowCap = opts.maxMarketsPerWindow > 0 ? opts.maxMarketsPerWindow : Infinity;
    const perGameCap = opts.maxMarketsPerGame > 0 ? opts.maxMarketsPerGame : Infinity;
    const perGame = new Map();
    let windowKey;
    let inWindow = 0;
    try {
    for await (const pairs of discover(ctx)) {
      if (ctx.window !== windowKey) {
        windowKey = ctx.window;
        inWindow = 0;
      }
      const todo = [];
      for (const { market, event } of pairs) {
        stats.discovery.candidates++;
        const cid = market && typeof market.conditionId === 'string' ? market.conditionId : null;
        if (cid && seen.has(cid)) {
          ctx.skip('duplicate');
          continue;
        }
        if (cid) seen.add(cid);
        const isOld = cid != null && existing.has(cid);
        let n = null;
        if (!isOld) {
          n = normalizeMarket(market, event, { sinceTs, untilTs });
          if (n.skip) {
            ctx.skip(n.skip);
            continue;
          }
        }
        if (inWindow >= perWindowCap) {
          ctx.skip('sampled_out_window');
          continue;
        }
        const game = gameKeyOf(event, market) ?? cid;
        const g = perGame.get(game) || 0;
        if (g >= perGameCap) {
          ctx.skip('sampled_out_game');
          continue;
        }
        perGame.set(game, g + 1);
        inWindow++;
        if (inWindow >= perWindowCap) ctx.windowFull = true;
        if (isOld) alreadyCollected++;
        else todo.push(n);
      }
      // Launch only as many as could still fit (in flight counts), so failures can be backfilled
      // from the same page. Downloads run while discovery reads the next page, with a bounded
      // backlog, so listing latency does not add up serially.
      while (todo.length) {
        if (committed() >= opts.maxMarkets) {
          if (!inflight.size) break;
          await Promise.race(inflight);
          continue;
        }
        for (const cand of todo.splice(0, opts.maxMarkets - committed())) {
          pending++;
          const task = marketLimit(async () => {
            const res = await processMarket(ctx, cand);
            if (res.skip) ctx.skip(res.skip);
            else {
              kept++;
              await appendRecord(res.record);
            }
            progress();
          }).finally(() => {
            pending--;
            inflight.delete(task);
          });
          inflight.add(task);
        }
        while (inflight.size > backlog) await Promise.race(inflight);
      }
      progress();
      if (committed() >= opts.maxMarkets) {
        await Promise.all([...inflight]);
        if (total() >= opts.maxMarkets) break;
      }
    }
    } finally {
      // Also on a discovery error: downloads already started are finished and written first.
      await Promise.allSettled([...inflight]);
      await appendChain;
    }
  }

  const failures = (stats.skipped.price_fetch_failed || 0) + (stats.skipped.trades_fetch_failed || 0) + stats.trades.backfillFailed;
  const summary = {
    ok: failures === 0,
    synthetic: runLine.synthetic,
    dataDir,
    strategy: opts.strategy,
    bases,
    kept,
    alreadyCollected,
    totalInFile: total(),
    skipped: Object.fromEntries(Object.entries(stats.skipped).sort()),
    discovery: stats.discovery,
    prices: stats.prices,
    trades: opts.trades ? stats.trades : null,
    http: http.stats,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
  };
  progress(true);
  say(`done in ${summary.elapsedSec}s: kept ${kept} new, ${alreadyCollected} already collected, ${summary.totalInFile} in markets.jsonl`);
  const skippedText = Object.entries(summary.skipped).map(([k, v]) => `${k} ${v}`).join(', ');
  say(`skipped: ${skippedText || 'none'}`);
  say(`prices: ${stats.prices.fetched} tokens fetched (${stats.prices.emptyTokens} empty, ${stats.prices.splits} range splits, ${stats.prices.maxFallback} interval=max fallbacks), ${stats.prices.fromDisk} from disk`);
  if (opts.trades) say(`trades: ${stats.trades.fetched} markets fetched (${stats.trades.rows} trades, ${stats.trades.truncated} truncated before the window start), ${stats.trades.fromDisk} from disk, ${stats.trades.backfilled} backfilled for markets collected earlier`);
  if (failures) warn(`${failures} market(s) failed to download; re-run the same command to retry them`);
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    () => {},
    (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`[collect] ${err.message}\n\n${HELP}\n`);
        process.exitCode = 2;
      } else {
        process.stderr.write(`[collect] error: ${err instanceof CollectError ? err.message : err.stack || err}\n`);
        process.exitCode = 1;
      }
    }
  );
}
