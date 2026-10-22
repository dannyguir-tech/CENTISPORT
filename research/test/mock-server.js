// Local stand-in for Polymarket's gamma / clob / data-api endpoints, serving deterministic
// SYNTHETIC data. It exists only to exercise the research tooling offline: nothing it serves
// is market evidence. Titles and questions carry a "[SYNTHETIC]" prefix so it can't be mistaken
// for real data downstream.
//
//   node research/test/mock-server.js [--port 8787] [--events 18] [--seed 7] [--favorite-bias 0] [--no-faults]
//
// Prints GAMMA_BASE / CLOB_BASE / DATA_BASE exports for pointing collect.js at it.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HOUR = 3600;
const DAY = 86400;
const GRID = 300; // price path resolution (s)

const sha = (s) => createHash('sha256').update(s).digest('hex');
const seedOf = (s) => parseInt(sha(s).slice(0, 8), 16);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rng) => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

const isoZ = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
const pgTs = (ts) => new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00');
const dateStr = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

const SPORTS_TAG = { id: '1', slug: 'sports', label: 'Sports' };
const SPORTS = [
  { sport: 'nba', prefix: 'nba', series: { id: '10345', slug: 'nba', title: 'NBA' }, tag: { id: '745', slug: 'nba', label: 'NBA' },
    markets: ['moneyline', 'spread', 'total', 'prop'], totalLine: 224.5,
    teams: [['Lakers', 'lal'], ['Celtics', 'bos'], ['Knicks', 'nyk'], ['Warriors', 'gsw'], ['Heat', 'mia'], ['Bucks', 'mil']],
    players: ['LeBron James', 'Jayson Tatum', 'Stephen Curry', 'Jalen Brunson'] },
  { sport: 'nfl', prefix: 'nfl', series: { id: '10187', slug: 'nfl', title: 'NFL' }, tag: { id: '450', slug: 'nfl', label: 'NFL' },
    markets: ['moneyline', 'spread', 'total'], totalLine: 44.5,
    teams: [['Chiefs', 'kc'], ['Eagles', 'phi'], ['Bills', 'buf'], ['Ravens', 'bal']] },
  { sport: 'mlb', prefix: 'mlb', series: { id: '3', slug: 'mlb', title: 'MLB' }, tag: { id: '100381', slug: 'mlb', label: 'MLB' },
    markets: ['moneyline', 'total'], totalLine: 8.5,
    teams: [['Yankees', 'nyy'], ['Dodgers', 'lad'], ['Astros', 'hou'], ['Braves', 'atl']] },
  { sport: 'nhl', prefix: 'nhl', series: { id: '10346', slug: 'nhl', title: 'NHL' }, tag: { id: '899', slug: 'nhl', label: 'NHL' },
    markets: ['moneyline', 'total'], totalLine: 5.5,
    teams: [['Rangers', 'nyr'], ['Bruins', 'bos'], ['Oilers', 'edm'], ['Panthers', 'fla']] },
  { sport: 'soccer', prefix: 'epl', series: { id: '10188', slug: 'premier-league', title: 'Premier League' }, tag: { id: '82', slug: 'epl', label: 'EPL' },
    markets: ['win-yes', 'total'], totalLine: 2.5,
    teams: [['Arsenal', 'ars'], ['Chelsea', 'che'], ['Liverpool', 'liv'], ['Everton', 'eve']] },
  { sport: 'tennis', prefix: 'atp', series: null, tag: { id: '864', slug: 'tennis', label: 'Tennis' },
    markets: ['moneyline'], teams: [['Sinner', 'sin'], ['Alcaraz', 'alc'], ['Djokovic', 'djo'], ['Zverev', 'zve']] },
  { sport: 'mma', prefix: 'ufc', series: { id: '10500', slug: 'ufc', title: 'UFC' }, tag: { id: '279', slug: 'ufc', label: 'UFC' },
    markets: ['moneyline'], teams: [['Pereira', 'per'], ['Ankalaev', 'ank'], ['Makhachev', 'mak'], ['Topuria', 'top']] },
  { sport: 'cs2', prefix: 'cs2', series: { id: '10310', slug: 'counter-strike', title: 'Counter-Strike' }, tag: { id: '100780', slug: 'counter-strike-2', label: 'CS2' },
    markets: ['moneyline', 'map'], teams: [['Vitality', 'vit'], ['NAVI', 'navi'], ['FaZe', 'faze'], ['G2', 'g2']] },
  { sport: 'lol', prefix: 'lol', series: { id: '10311', slug: 'league-of-legends', title: 'LoL' }, tag: { id: '65', slug: 'league-of-legends', label: 'League of Legends' },
    markets: ['moneyline', 'map'], teams: [['T1', 't1'], ['Gen.G', 'gen'], ['G2 Esports', 'g2'], ['Fnatic', 'fnc']] },
];
const ESPORTS = new Set(['cs2', 'lol']);
const P0_RANGE = { moneyline: [0.2, 0.8], map: [0.25, 0.75], spread: [0.4, 0.6], total: [0.42, 0.58], prop: [0.35, 0.65], 'win-yes': [0.25, 0.7] };

function marketText(sp, type, a, b, gs, rng) {
  switch (type) {
    case 'spread': {
      const line = 1.5 + Math.floor(rng() * 8);
      return { q: `Spread: ${a[0]} (-${line})`, outcomes: [a[0], b[0]] };
    }
    case 'total':
      return { q: `${a[0]} vs. ${b[0]}: O/U ${sp.totalLine}`, outcomes: ['Over', 'Under'] };
    case 'prop': {
      const player = sp.players[Math.floor(rng() * sp.players.length)];
      return { q: `${player}: Points O/U ${(20 + Math.floor(rng() * 10) + 0.5).toFixed(1)}`, outcomes: ['Over', 'Under'] };
    }
    case 'win-yes':
      return { q: `Will ${a[0]} win on ${dateStr(gs)}?`, outcomes: ['Yes', 'No'] };
    case 'map':
      return { q: `${a[0]} vs. ${b[0]} - ${sp.sport === 'cs2' ? 'Map 1 Winner' : 'Game 1 Winner'}`, outcomes: [a[0], b[0]] };
    default:
      return { q: `${a[0]} vs. ${b[0]}`, outcomes: [a[0], b[0]] };
  }
}

// Pre-game logit random walk, then an in-game drift to the realised winner.
function buildPath(meta, rng, favoriteBias) {
  const nPre = Math.max(2, Math.floor((meta.gs - meta.listingTs) / GRID));
  const nIn = Math.ceil((meta.closeTs - meta.gs) / GRID) + 1;
  const path = new Float32Array(nPre + nIn);
  let x = logit(meta.p0);
  for (let k = 0; k < nPre; k++) {
    x += gauss(rng) * 0.012;
    x = clamp(x, -3.5, 3.5);
    path[k] = sigmoid(x);
  }
  const pg = path[nPre - 1];
  // favoriteBias > 0 plants a favourite-longshot bias; 0 means prices are calibrated (no edge).
  const trueProb = clamp(pg + favoriteBias * (pg - 0.5), 0.01, 0.99);
  const winnerIndex = rng() < trueProb ? 0 : 1;
  const target = winnerIndex === 0 ? 0.9995 : 0.0005;
  for (let j = 0; j < nIn; j++) {
    const s = j / (nIn - 1);
    path[nPre + j] = clamp(pg + (target - pg) * s ** 1.5 + gauss(rng) * 0.01 * (1 - s), 0.0005, 0.9995);
  }
  return { path, winnerIndex };
}

function buildTrades(entry, wallets) {
  const { meta, market } = entry;
  const rng = mulberry32(seedOf(`trades-${meta.cid}`));
  const out = [];
  const span = meta.closeTs - meta.listingTs;
  const inGame = meta.inGameTrades || 0;
  for (let k = 0; k < meta.nTrades + inGame; k++) {
    // The first nTrades are spread over the market's life, denser near the game; any extra ones
    // are live betting between kickoff and close (the tape the collector must page through).
    const t = k < meta.nTrades ? Math.round(meta.closeTs - span * rng() ** 2) : meta.gs + 1 + Math.floor(rng() * (meta.closeTs - meta.gs - 1));
    const idx = rng() < 0.5 ? 0 : 1;
    const whale = rng() < 0.03 ? 20 : 1;
    out.push({
      proxyWallet: wallets[Math.floor(rng() ** 2 * wallets.length)],
      side: rng() < 0.6 ? 'BUY' : 'SELL',
      asset: meta.tokenIds[idx],
      conditionId: meta.cid,
      size: Math.round(Math.exp(rng() * 7) * whale * 100) / 100,
      price: Math.round(clamp(priceAt(meta, idx, t), 0.01, 0.99) * 100) / 100,
      timestamp: t,
      title: market.question,
      slug: market.slug,
      outcome: meta.outcomes[idx],
      outcomeIndex: idx,
      transactionHash: `0x${sha(`tx-${meta.cid}-${k}`)}`,
    });
  }
  return out.sort((x, y) => y.timestamp - x.timestamp); // data-api returns newest first
}

function priceAt(meta, idx, t) {
  const k = clamp(Math.floor((t - meta.listingTs) / GRID), 0, meta.path.length - 1);
  const p0 = meta.path[k];
  return idx === 0 ? p0 : clamp(1 - p0 + meta.over, 0.0005, 0.9995);
}

/**
 * Builds the synthetic universe. Every market carries `meta.kind`, the outcome the collector is
 * expected to reach: 'ok' or a skip reason (voided_50_50, not_closed, ambiguous_resolution,
 * bad_shape, no_price_history, no_game_start) or 'out_of_range' for the 2024 event that a 2025
 * date filter should exclude server-side.
 */
export function buildFixture({ nEvents = 18, seed = 7, favoriteBias = 0, t0 = Date.UTC(2025, 2, 1, 0, 30) / 1000 } = {}) {
  const events = [];
  const entries = [];
  const tokens = new Map();
  const byCid = new Map();
  const wallets = Array.from({ length: 40 }, (_, k) => `0x${sha(`wallet-${seed}-${k}`).slice(0, 40)}`);
  let mIdx = 0;

  const addEvent = (i, gs, { old = false } = {}) => {
    const sp = SPORTS[i % SPORTS.length];
    const rng = mulberry32(seedOf(`ev-${seed}-${i}-${old}`));
    const ai = Math.floor(rng() * sp.teams.length);
    const bi = (ai + 1 + Math.floor(rng() * (sp.teams.length - 1))) % sp.teams.length;
    const a = sp.teams[ai];
    const b = sp.teams[bi];
    const slug = `${sp.prefix}-${a[1]}-${b[1]}-${dateStr(gs)}`;
    const listingTs = gs - 4 * DAY - Math.floor(rng() * 2 * DAY);
    const ev = {
      id: String(20000 + events.length),
      ticker: slug,
      slug,
      title: `[SYNTHETIC] ${a[0]} vs. ${b[0]}`,
      startDate: new Date(listingTs * 1000 + 17512).toISOString(), // listing time, not game time
      endDate: isoZ(gs + 3 * HOUR),
      startTime: isoZ(gs),
      closed: true,
      active: false,
      archived: false,
      negRisk: false,
      series: sp.series ? [{ id: sp.series.id, slug: sp.series.slug, ticker: sp.series.slug, title: sp.series.title }] : [],
      tags: [SPORTS_TAG, sp.tag, ...(ESPORTS.has(sp.sport) ? [{ id: '64', slug: 'esports', label: 'Esports' }] : [])],
      markets: [],
    };
    for (const type of sp.markets) {
      const mr = mulberry32(seedOf(`m-${seed}-${mIdx}`));
      const { q, outcomes } = marketText(sp, type, a, b, gs, mr);
      const [lo, hi] = P0_RANGE[type];
      const cid = `0x${sha(`cond-${seed}-${mIdx}`)}`;
      const tokenIds = [0, 1].map((k) => BigInt(`0x${sha(`tok-${seed}-${mIdx}-${k}`).slice(0, 30)}`).toString());
      const closeTs = gs + 3 * HOUR + Math.floor(mr() * 40 * 60);
      const meta = {
        kind: old ? 'out_of_range' : 'ok', type, sport: sp.sport, eventIndex: old ? -1 : i, cid, tokenIds, outcomes,
        gs, listingTs, closeTs, p0: lo + mr() * (hi - lo), over: Math.round(mr() * 20) / 1000,
        nTrades: 20 + Math.floor(mr() * 180), gameStartSource: 'market.gameStartTime',
      };
      const built = buildPath(meta, mr, favoriteBias);
      meta.path = built.path;
      meta.winnerIndex = built.winnerIndex;
      const vol = Math.round(1000 + mr() * 200000);
      const market = {
        id: String(500000 + mIdx),
        question: `[SYNTHETIC] ${q}`,
        conditionId: cid,
        slug: `${slug}-${type}`,
        outcomes: JSON.stringify(outcomes),
        outcomePrices: JSON.stringify(outcomes.map((_, k) => (k === meta.winnerIndex ? '1' : '0'))),
        clobTokenIds: JSON.stringify(tokenIds),
        closed: true,
        active: false,
        startDate: ev.startDate,
        endDate: ev.endDate,
        gameStartTime: pgTs(gs),
        closedTime: pgTs(closeTs),
        volume: String(vol),
        volumeNum: vol,
        negRisk: type === 'win-yes',
        sportsMarketType: type,
        umaResolutionStatus: 'resolved',
      };
      const entry = { market, event: ev, meta };
      ev.markets.push(market);
      entries.push(entry);
      byCid.set(cid, entry);
      tokenIds.forEach((tid, idx) => tokens.set(tid, { entry, idx }));
      mIdx++;
    }
    events.push(ev);
    return ev;
  };

  for (let i = 0; i < nEvents; i++) addEvent(i, t0 + i * 13 * HOUR);
  addEvent(0, Date.UTC(2024, 4, 1, 23, 0) / 1000, { old: true });

  // Futures-style event: resolved, sports-tagged, but no game time anywhere.
  const fut = {
    id: '29999', ticker: 'nba-champion-2025', slug: 'nba-champion-2025', title: '[SYNTHETIC] NBA Champion 2025',
    startDate: new Date((t0 - 40 * DAY) * 1000 + 4321).toISOString(), endDate: '2025-06-20T00:00:00Z',
    closed: true, active: false, archived: false, negRisk: true, series: [], tags: [SPORTS_TAG, SPORTS[0].tag], markets: [],
  };
  {
    const cid = `0x${sha(`cond-${seed}-futures`)}`;
    const tokenIds = [0, 1].map((k) => BigInt(`0x${sha(`tok-${seed}-futures-${k}`).slice(0, 30)}`).toString());
    const market = {
      id: '599999', question: '[SYNTHETIC] Will the Celtics win the 2025 NBA Finals?', conditionId: cid, slug: 'will-the-celtics-win-the-2025-nba-finals',
      outcomes: '["Yes","No"]', outcomePrices: '["0","1"]', clobTokenIds: JSON.stringify(tokenIds), closed: true, active: false,
      startDate: fut.startDate, endDate: fut.endDate, closedTime: '2025-06-20 03:12:44+00', volume: '987654.3', negRisk: true,
    };
    const meta = { kind: 'no_game_start', type: 'futures', sport: 'nba', eventIndex: -2, cid, tokenIds, outcomes: ['Yes', 'No'], winnerIndex: 1 };
    fut.markets.push(market);
    const entry = { market, event: fut, meta };
    entries.push(entry);
    byCid.set(cid, entry);
    events.push(fut);
  }

  // Tricky cases, applied by event index (cycles through SPORTS, so index 0 is NBA, 1 NFL...).
  const at = (i, type) => entries.find((e) => e.meta.eventIndex === i && e.meta.type === type);
  const tricky = {};
  const set = (key, i, type, fn) => {
    const e = at(i, type);
    if (!e) return;
    fn(e);
    tricky[key] = e.meta.cid;
  };
  set('arrayEncoded', 0, 'moneyline', ({ market }) => {
    market.outcomes = JSON.parse(market.outcomes);
    market.outcomePrices = JSON.parse(market.outcomePrices);
    market.clobTokenIds = JSON.parse(market.clobTokenIds);
  });
  set('voided', 1, 'spread', ({ market, meta }) => {
    market.outcomePrices = '["0.5","0.5"]';
    meta.kind = 'voided_50_50';
  });
  set('eventStartTimeFallback', 2, 'moneyline', ({ market, meta }) => {
    delete market.gameStartTime;
    meta.gameStartSource = 'event.startTime';
  });
  set('eventStartDateFallback', 3, 'moneyline', ({ market, event, meta }) => {
    delete market.gameStartTime;
    delete event.startTime;
    event.startDate = isoZ(meta.gs); // looks like a game time: round minute, endDate 3h later
    meta.gameStartSource = 'eventStartDate';
  });
  set('ambiguous', 4, 'total', ({ market, meta }) => {
    market.outcomePrices = '["0.97","0.03"]';
    meta.kind = 'ambiguous_resolution';
  });
  set('notClosed', 5, 'moneyline', ({ market, meta }) => {
    market.closed = false;
    market.outcomePrices = '["0.62","0.38"]';
    meta.kind = 'not_closed';
  });
  set('badShape', 6, 'moneyline', ({ market, meta }) => {
    market.clobTokenIds = JSON.stringify(meta.tokenIds.slice(0, 1));
    meta.kind = 'bad_shape';
  });
  set('noPriceHistory', 7, 'moneyline', ({ meta }) => {
    meta.kind = 'no_price_history';
  });
  set('maxOnlyHistory', 8, 'map', ({ meta }) => {
    meta.maxOnlyToken = 1;
  });
  set('manyTrades', 9, 'moneyline', ({ meta }) => {
    meta.nTrades = 1200;
  });
  // Heavy live betting: 3200 in-game trades sit in front of the pre-game tape (newest first), more
  // than --max-trades-per-market, so in-game trades must not count toward it.
  set('busyInGame', 10, 'moneyline', ({ meta }) => {
    meta.nTrades = 400;
    meta.inGameTrades = 3200;
  });
  const dupEvent = events.find((e) => e.markets.some((m) => byCid.get(m.conditionId).meta.eventIndex === 11)) || null;
  if (dupEvent) tricky.duplicatedEventSlug = dupEvent.slug;

  return { seed, events, entries, tokens, byCid, wallets, tricky, dupEvent, tradesCache: new Map() };
}

function tradesFor(fixture, entry) {
  let t = fixture.tradesCache.get(entry.meta.cid);
  if (!t) {
    t = buildTrades(entry, fixture.wallets);
    fixture.tradesCache.set(entry.meta.cid, t);
  }
  return t;
}

function filterEvents(fixture, q) {
  let list = fixture.events.filter((ev) => {
    if (q.has('closed') && String(ev.closed) !== q.get('closed')) return false;
    if (q.has('tag_slug') && !ev.tags.some((t) => t.slug === q.get('tag_slug'))) return false;
    if (q.has('tag_id') && !ev.tags.some((t) => t.id === q.get('tag_id'))) return false;
    if (q.has('series_id') && !ev.series.some((s) => s.id === q.get('series_id'))) return false;
    if (q.has('slug') && ev.slug !== q.get('slug')) return false;
    const end = Date.parse(ev.endDate);
    if (q.has('end_date_min') && end < Date.parse(q.get('end_date_min'))) return false;
    if (q.has('end_date_max') && end > Date.parse(q.get('end_date_max'))) return false;
    return true;
  });
  const order = q.get('order');
  if (order === 'endDate' || order === 'startDate') {
    const dir = q.get('ascending') === 'true' ? 1 : -1;
    list = list.slice().sort((x, y) => dir * (Date.parse(x[order]) - Date.parse(y[order])) || x.id.localeCompare(y.id));
  }
  // Offset pagination over a shifting set can repeat an item; reproduce that across a page boundary.
  if (fixture.dupEvent && list.includes(fixture.dupEvent) && list.length > 10) list.splice(10, 0, fixture.dupEvent);
  return list;
}

// The events a /gamma/events request returns, for tests that need to know what a cached page held.
export function eventsPage(fixture, url, limitCap = 500) {
  const q = new URL(url, 'http://mock').searchParams;
  return paginate(filterEvents(fixture, q), q, limitCap);
}

const paginate = (list, q, cap, def = 20) => {
  const limit = Math.min(cap, Math.max(1, Number(q.get('limit')) || def));
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  return list.slice(offset, offset + limit);
};

const eventStub = (ev) => {
  const { markets, ...rest } = ev;
  return rest;
};

function route(fixture, u, send, limitCap, tradesCap) {
  const q = u.searchParams;
  const p = u.pathname;
  if (p === '/gamma/events') return send(200, paginate(filterEvents(fixture, q), q, limitCap));
  if (p.startsWith('/gamma/events/slug/')) {
    const slug = decodeURIComponent(p.slice('/gamma/events/slug/'.length));
    const ev = fixture.events.find((e) => e.slug === slug);
    return ev ? send(200, ev) : send(404, { error: 'event not found' });
  }
  if (p === '/gamma/markets') {
    const evs = filterEvents(fixture, new URLSearchParams([...q].filter(([k]) => ['closed', 'tag_id', 'tag_slug', 'end_date_min', 'end_date_max', 'order', 'ascending'].includes(k))));
    const seen = new Set();
    const rows = [];
    for (const ev of evs) {
      for (const m of ev.markets) {
        if (seen.has(m.conditionId)) continue;
        seen.add(m.conditionId);
        if (q.has('closed') && String(m.closed) !== q.get('closed')) continue;
        if (q.has('slug') && m.slug !== q.get('slug')) continue;
        rows.push({ ...m, events: [eventStub(ev)] });
      }
    }
    return send(200, paginate(rows, q, limitCap));
  }
  if (p === '/clob/prices-history') return pricesHistory(fixture, q, send);
  if (p === '/data/trades') {
    const entry = fixture.byCid.get(q.get('market'));
    const limit = Math.min(tradesCap, Math.max(1, Number(q.get('limit')) || 100));
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    if (offset > 10000) return send(400, { error: 'offset too large' });
    if (!entry || !entry.meta.path) return send(200, []);
    return send(200, tradesFor(fixture, entry).slice(offset, offset + limit));
  }
  return send(404, { error: `no route ${p}` });
}

function pricesHistory(fixture, q, send) {
  const info = fixture.tokens.get(q.get('market'));
  if (!info || !info.entry.meta.path) return send(404, { error: 'market not found' });
  const { entry, idx } = info;
  const meta = entry.meta;
  if (meta.kind === 'no_price_history') return idx === 0 ? send(404, { error: 'no history' }) : send(200, { history: [] });
  const fid = Math.max(1, Math.floor(Number(q.get('fidelity')) || 1));
  let a;
  let b;
  if (q.has('startTs') || q.has('endTs')) {
    a = Number(q.get('startTs'));
    b = Number(q.get('endTs'));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return send(400, { error: 'invalid filters: startTs/endTs' });
    if (fid < 60 && b - a > 2 * DAY) return send(400, { error: "invalid filters: 'startTs' and 'endTs' interval is too long" });
    if (meta.maxOnlyToken === idx) return send(200, { history: [] });
  } else if (q.get('interval') === 'max') {
    a = meta.listingTs;
    b = meta.closeTs;
  } else if (q.has('interval')) {
    const span = { '1h': HOUR, '6h': 6 * HOUR, '1d': DAY, '1w': 7 * DAY, '1m': 30 * DAY }[q.get('interval')];
    if (!span) return send(400, { error: 'invalid interval' });
    b = Math.floor(Date.now() / 1000);
    a = b - span;
  } else {
    return send(400, { error: 'startTs/endTs or interval required' });
  }
  const step = fid * 60;
  const from = Math.ceil(Math.max(a, meta.listingTs) / step) * step;
  const to = Math.min(b, meta.closeTs);
  const history = [];
  for (let t = from; t <= to; t += step) history.push({ t, p: Math.round(clamp(priceAt(meta, idx, t), 0.001, 0.999) * 1000) / 1000 });
  return send(200, { history });
}

// One-shot faults so retry paths are exercised deterministically.
function defaultFaults(fixture) {
  const faults = [
    { name: 'events-429', status: 429, headers: { 'retry-after': '1' }, body: { error: 'rate limited' },
      match: (u) => u.pathname === '/gamma/events' && u.searchParams.get('offset') === '5' },
  ];
  const ml0 = fixture.byCid.get(fixture.tricky.arrayEncoded);
  if (ml0) faults.push({ name: 'prices-500', status: 500, body: { error: 'internal' },
    match: (u) => u.pathname === '/clob/prices-history' && u.searchParams.get('market') === ml0.meta.tokenIds[0] });
  if (fixture.tricky.manyTrades) faults.push({ name: 'trades-502', status: 502, body: 'Bad Gateway',
    match: (u) => u.pathname === '/data/trades' && u.searchParams.get('market') === fixture.tricky.manyTrades && u.searchParams.get('offset') === '500' });
  return faults.map((f) => ({ ...f, fired: false, firedAt: null }));
}

// limitCap / tradesCap mimic a server that silently returns fewer rows than the requested `limit`
// (gamma listings / data-api trades).
export async function startMockServer({ port = 0, host = '127.0.0.1', fixture = buildFixture(), faults = true, limitCap = 500, tradesCap = 500 } = {}) {
  const requests = [];
  const faultList = faults ? defaultFaults(fixture) : [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    const rec = { at: Date.now(), method: req.method, path: u.pathname, url: u.pathname + u.search, query: Object.fromEntries(u.searchParams), status: 0 };
    requests.push(rec);
    const send = (status, body, headers = {}) => {
      rec.status = status;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const fault = faultList.find((f) => !f.fired && f.match(u));
    if (fault) {
      fault.fired = true;
      fault.firedAt = rec.at;
      return send(fault.status, fault.body, fault.headers);
    }
    try {
      route(fixture, u, send, limitCap, tradesCap);
    } catch (err) {
      send(500, { error: String(err && err.message) });
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    port: actualPort,
    gammaBase: `${url}/gamma`,
    clobBase: `${url}/clob`,
    dataBase: `${url}/data`,
    env: { GAMMA_BASE: `${url}/gamma`, CLOB_BASE: `${url}/clob`, DATA_BASE: `${url}/data` },
    requests,
    fixture,
    faults: faultList,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
  };
  const fixture = buildFixture({ nEvents: Number(get('--events', 18)), seed: Number(get('--seed', 7)), favoriteBias: Number(get('--favorite-bias', 0)) });
  const srv = await startMockServer({ port: Number(get('--port', 8787)), fixture, faults: !args.includes('--no-faults') });
  console.log(`# SYNTHETIC mock Polymarket API (${fixture.entries.length} markets) — not real data`);
  for (const [k, v] of Object.entries(srv.env)) console.log(`export ${k}=${v}`);
}
