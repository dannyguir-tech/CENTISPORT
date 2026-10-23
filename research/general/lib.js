// Shared rules for the NON-SPORTS ("general") track: universe filters, category mapping, decision
// times, question-pattern flags and the fee formula. The collector, the dataset builder, the
// synthetic generator and the tests all use these functions, so the row-existence rules are
// applied identically everywhere (the collector's pre-filter is exactly the builder's rule).
//
// Pre-registered design (fixed before any real result was seen; see research/general/README.md):
// - anchor = the market's scheduled end (gamma market.endDate);
// - decisions at anchor - {1, 3, 7, 14, 30} days, plus listing + 1 day ("early");
// - a row exists only if listing <= decisionTs < closedTime (market open), the early decision is
//   before the anchor, the last price point is at most 12 h old (24 h for offsets >= 7 d) and the
//   price is in [0.01, 0.99]. closedTime, resolution status and lifetime volume are never features.
import { createHash } from 'node:crypto';

export const HOUR = 3600;
export const DAY = 86400;

// Decision offsets as backtest.js offsetH keys: hours before the anchor, and EARLY_OFFSET_H
// (negative = hours AFTER listing) for the listing + 1 day decision.
export const ANCHOR_OFFSETS_D = Object.freeze([1, 3, 7, 14, 30]);
export const ANCHOR_OFFSETS_H = Object.freeze(ANCHOR_OFFSETS_D.map((d) => d * 24));
export const EARLY_OFFSET_H = -24;
export const ALL_OFFSETS_H = Object.freeze([EARLY_OFFSET_H, ...ANCHOR_OFFSETS_H]);
export const offsetLabel = (h) => (h === EARLY_OFFSET_H ? 'listing+1d' : h % 24 === 0 ? `anchor-${h / 24}d` : `anchor-${h}h`);

export const MIN_PRICE = 0.01;
export const MAX_PRICE = 0.99;
// Price staleness: 12 h, or 24 h for offsets of 7 days or more. The early decision uses 12 h.
export const maxPriceAgeSec = (offsetH) => (offsetH >= 7 * 24 ? 24 : 12) * HOUR;
// Lookbacks for price_m1d / price_m7d (each taken with the row's own staleness limit).
export const LOOKBACK_SEC = Object.freeze({ m1d: DAY, m7d: 7 * DAY });
// negRisk group features use only member quotes stamped within this window before the row's point.
export const GROUP_SYNC_SEC = 30 * 60;
// clob stamps different tokens' hourly points up to ~60 s apart; a member quote this much newer
// than the row's point (and not after the decision) counts as synchronous.
export const GROUP_STAMP_TOL_SEC = 120;
export const DEFAULT_SINCE = '2024-01-01';

// ---------- small parsers (copied from research/collect.js so this track does not depend on its internals) ----------

export function parseTs(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.floor(raw > 1e12 ? raw / 1000 : raw) : null;
  let s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseTs(Number(s));
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

export function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

export const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const NUMERIC_RE = /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/;
const strictNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && NUMERIC_RE.test(v) ? Number(v) : NaN);

// Final outcomePrices: exactly one "1" and the rest "0" -> winner; all equal 1/n -> voided 50-50;
// anything else (partial, missing, fractional) -> ambiguous. Same rule as research/collect.js.
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

// UMA status must be final when present; automatically resolved markets often carry none.
export const UMA_FINAL = new Set(['resolved']);
export function umaIsFinal(status) {
  if (status == null || status === '') return true;
  return UMA_FINAL.has(String(status).toLowerCase());
}

// Index of the last element with t <= ts, or -1 (arr sorted by t).
export function lastIndexAtOrBefore(arr, ts) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// ---------- tags, categories, exclusions ----------

export const tagSlug = (t) => {
  const v = typeof t === 'string' ? t : t && (t.slug || t.label);
  return v == null ? null : String(v).toLowerCase().trim();
};
export const tagSlugs = (tags) => [...new Set((Array.isArray(tags) ? tags : []).map(tagSlug).filter(Boolean))];

export const CATEGORIES = Object.freeze(['politics', 'elections', 'geopolitics', 'crypto', 'economics-finance', 'tech-ai', 'culture-entertainment', 'science-weather', 'other']);

// First matching category wins, in this order (elections and geopolitics before politics because
// they are its more specific subsets). Each entry: exact tag slugs, plus a slug regex.
const CATEGORY_RULES = [
  ['elections', ['elections', 'global-elections', 'us-elections', 'world-elections', 'us-presidential-election', 'primaries', 'primary-elections',
    'senate-elections', 'midterms', 'mayoral-elections', 'main-election', 'international-election-props', 'house-primary', 'democratic-primary',
    'republican-primary', 'senate-primary', 'governor-primary', 'polling', 'margin-of-victory', 'nyc-mayor', 'state-presidential-election', 'deprec-us-election'],
  /(^|-)(elections?|primar(y|ies)|midterms?|referendum|ballot|electoral|caucus(es)?)(-|$)/],
  ['geopolitics', ['geopolitics', 'world', 'middle-east', 'iran', 'israel', 'ukraine', 'russia', 'gaza', 'china', 'foreign-policy', 'military-action',
    'military-strikes', 'military', 'war', 'trump-iran', 'putin', 'zelensky', 'zelenskyy', 'venezuela', 'lebanon', 'yemen', 'syria', 'hezbollah',
    'hamas', 'houthis', 'khamenei', 'strait-of-hormuz', 'hormuz', 'israel-x-iran', 'diplomacy-ceasefire', 'peace-deal', 'ukraine-peace-deal',
    'ukraine-map', 'north-korea', 'india-pakistan', 'world-affairs', 'global-politics', 'nato', 'us-iran', 'trump-putin', 'trump-zelenskyy', 'tanker'],
  /(^|-)(geopolitic\w*|ceasefire|invasion|missile|nuclear-deal)(-|$)/],
  ['politics', ['politics', 'us-politics', 'uptspt-politics', 'trump', 'donald-trump', 'trump-presidency', 'trump-cabinet', 'congress', 'courts',
    'court-cases', 'scotus', 'supreme-court', 'approval', 'approvals', 'biden', 'kamala', 'epstein', 'gov-shutdown', 'executive-actions',
    'us-government', 'potus', 'maga', 'trump-100-days', 'first-100-days', 'trump-speech', 'trump-daily', 'dhs', 'immigrationborder', 'big-beautiful-bill',
    'mamdani', 'starmer', 'minnesota-fraud', 'tariffs', 'trade-war'],
  /(^|-)(politic\w*|senate|congress\w*|governor|cabinet|impeach\w*|white-house)(-|$)/],
  ['crypto', ['crypto', 'crypto-prices', 'bitcoin', 'ethereum', 'solana', 'xrp', 'ripple', 'dogecoin', 'doge', 'memecoins', 'cryptocurrency', 'fdv',
    'microstrategy', 'mstr', 'hyperliquid', 'airdrops', 'token-launch', 'public-sales', 'stablecoins', 'defi', 'nft', 'nfts'],
  /(^|-)(crypto\w*|bitcoin|btc|ethereum|eth|solana|memecoin\w*|airdrop\w*|stablecoin\w*)(-|$)/],
  ['economics-finance', ['economy', 'economics', 'finance', 'fed', 'fed-rates', 'fomc', 'jerome-powell', 'inflation', 'cpi', 'gdp', 'equities', 'stocks',
    'stock-prices', 'earnings', 'earnings-calls', 'business', 'etf', 'commodities', 'oil', 'gold', 'silver', 'natural-gas', 'forex', 'treasuries',
    'macro-indicators', 'economic-policy', 'ipo', 'ipos', 'acquisitions', 'housing', 'real-estate', 'sp-500', 'indicies', 'derivatives', 'Global-Rates',
    'global-rates', 'finance-updown', 'pyth-finance', 'daily-close', 'pre-market', 'kpis', 'tsa', 'prices', 'gme', 'gamestop', 'privates'],
  /(^|-)(econom\w*|financ\w*|stocks?|equit(y|ies)|earnings|inflation|interest-rates?|recession|unemployment|jobs-report|usd[a-z]{3}|[a-z]{3}usd)(-|$)/],
  ['tech-ai', ['tech', 'technology', 'ai', 'big-tech', 'openai', 'anthropic', 'claude', 'gpt', 'chatgpt', 'grok', 'gemini', 'deepseek', 'ai-rankings',
    'ai-releases', 'sam-altman', 'spacex', 'tesla', 'apple', 'google', 'meta', 'nvidia', 'microsoft', 'internet', 'outage', 'app-store', 'app', 'compute',
    'social-media', 'twitter', 'x', 'tiktok'],
  /(^|-)(tech\w*|ai|artificial-intelligence|llms?|software|semiconductor\w*)(-|$)/],
  ['science-weather', ['science', 'weather', 'climate', 'climate-science', 'daily-temperature', 'highest-temperature', 'lowest-temperature', 'temperature',
    'global-temp', 'earthquake', 'earthquakes', 'natural-disaster', 'natural-disasters', 'hurricane', 'hurricanes', 'tornado-risk', 'rain', 'precipitation',
    'drought', 'space', 'pandemics', 'fda', 'drug', 'health'],
  /(^|-)(weather|temperature|climate|hurricane\w*|earthquake\w*|tornado\w*|science|space|nasa|pandemic\w*|disease)(-|$)/],
  ['culture-entertainment', ['pop-culture', 'culture', 'entertainment', 'movies', 'music', 'awards', 'oscars', 'grammys', 'emmys', 'golden-globes', 'bafta',
    'critics-choice', 'eurovision', 'netflix', 'top-netflix', 'youtube', 'mrbeast', 'celebrities', 'celebrity', 'mention-markets', 'tweets-markets',
    'elon-tweets', 'elon-musk', 'box-office', 'rotten-tomatoes', 'billboard', 'spotify', 'song', 'album', 'charts', 'tv', 'reality-tv', 'big-brother-usa',
    'podcast', 'rogan', 'taylor-swift', 'kanye', 'anime', 'pokemon', 'collectibles', 'gaming', 'gta-vi', 'streaming', 'streamer', 'views', 'creators'],
  /(^|-)(culture|movies?|music|awards?|oscars?|grammys?|celebrit\w*|box-office|tv|netflix|youtube|tweets?|mentions?)(-|$)/],
];
const CATEGORY_TAGSETS = CATEGORY_RULES.map(([cat, list, re]) => [cat, new Set(list.map((s) => s.toLowerCase())), re]);

export function categoryOf(tags) {
  const slugs = tagSlugs(tags);
  for (const [cat, set] of CATEGORY_TAGSETS) if (slugs.some((s) => set.has(s))) return cat;
  for (const [cat, , re] of CATEGORY_TAGSETS) if (slugs.some((s) => re.test(s))) return cat;
  return 'other';
}

// Sports (studied by the sports track) are excluded: the generic sports/esports tags always; a
// league/game tag ('nfl', 'soccer', 'games', ...) only when no non-sports category tag is present
// (so "Will Taylor Swift attend the Super Bowl?" tagged nfl + pop-culture stays in), and any market
// carrying a sports fee type.
const SPORTS_ALWAYS = new Set(['sports', 'esports', 'counter-strike', 'counter-strike-2', 'cs2', 'csgo', 'lol', 'league-of-legends', 'dota-2', 'dota2',
  'valorant', 'mobile-legends-bang-bang', 'rocket-league', 'overwatch', 'rainbow-six', 'call-of-duty-league']);
const SPORTS_LEAGUE = new Set(['nba', 'wnba', 'nfl', 'mlb', 'nhl', 'ncaab', 'ncaaf', 'cbb', 'cfb', 'college-basketball', 'college-football', 'march-madness',
  'soccer', 'epl', 'premier-league', 'la-liga', 'serie-a', 'bundesliga', 'ligue-1', 'ucl', 'champions-league', 'europa-league', 'mls', 'world-cup',
  'fifa-world-cup', 'club-world-cup', 'copa-america', 'euros', 'tennis', 'atp', 'wta', 'wimbledon', 'us-open', 'australian-open', 'roland-garros', 'mma',
  'ufc', 'boxing', 'golf', 'pga', 'pga-tour', 'liv-golf', 'f1', 'formula-1', 'nascar', 'cricket', 'ipl', 'table-tennis', 'basketball', 'baseball',
  'hockey', 'handball', 'darts', 'pickleball', 'rugby', 'volleyball', 'olympics', 'super-bowl', 'chess', 'cycling', 'horse-racing', 'games']);

export function isSportsEvent(tags, feeTypes = []) {
  const slugs = tagSlugs(tags);
  if (slugs.some((s) => SPORTS_ALWAYS.has(s))) return true;
  if (feeTypes.some((f) => /^sports/i.test(String(f || '')))) return true;
  if (slugs.some((s) => SPORTS_LEAGUE.has(s))) {
    const rest = slugs.filter((s) => !SPORTS_LEAGUE.has(s));
    return categoryOf(rest) === 'other';
  }
  return false;
}

// The recurring crypto "Up or Down" series (5m/15m/1h/4h/daily) are studied separately. gamma tags
// most of them up-or-down (excluded server-side too); some hourly ones only carry the title/series.
const UPDOWN_RE = /\bup\s*(or|\/)\s*down\b|(^|-)up-?or-?down(-|$)|(^|-)updown(-|$)/i;
export function isCryptoUpDown({ tags, title, slug, series } = {}) {
  const slugs = tagSlugs(tags);
  if (slugs.includes('up-or-down')) return true;
  const seriesSlugs = (Array.isArray(series) ? series : []).map((s) => (typeof s === 'string' ? s : s && (s.slug || s.ticker || s.title))).filter(Boolean);
  const named = UPDOWN_RE.test(String(title || '')) || UPDOWN_RE.test(String(slug || '')) || seriesSlugs.some((s) => UPDOWN_RE.test(String(s)));
  if (!named) return false;
  return categoryOf(slugs) === 'crypto' || seriesSlugs.some((s) => /btc|bitcoin|eth|sol|xrp|doge|bnb|crypto|hype|zcash/i.test(String(s)))
    || /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|doge|bnb|hype|zcash|crypto)\b/i.test(String(title || ''));
}

// ---------- question patterns ----------

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// "by June 30", "before 2026", "by end of 2025", "by Q3", "by 12/31", "before the election" is NOT a date.
// "by..." / "by ___" (date in the event's member list) also counts, with or without a space.
const DEADLINE_RE = new RegExp(
  `\\b(?:by|before)(?:\\s*(?:\\.\\.\\.|\u2026|___)|\\s+(?:the\\s+)?(?:(?:end|middle|start)\\s+of\\s+(?:the\\s+)?)?(?:${MONTH}\\b|(?:q[1-4]|h[12])\\b|(?:19|20)\\d{2}\\b|\\d{1,2}/\\d{1,2}\\b|`
  + '(?:year|month|week)[- ]?end\\b|eoy\\b|(?:this|next)\\s+(?:year|month|week)\\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day\\b|tomorrow\\b))', 'i');
const WIN_RE = /\bwin(?:s|ner|ners|ning)?\b/i;
const THRESHOLD_RE = /\b(?:above|below|over|under|reach(?:es|ed)?)\b[^?]*?(?:\d|___)/i;

export function questionFlags(question) {
  const q = String(question || '');
  return { isDeadline: DEADLINE_RE.test(q), isWin: WIN_RE.test(q), isThreshold: THRESHOLD_RE.test(q) };
}
// One label for calibration tables (marketType): deadline > threshold > win > other.
export const patternClass = (f) => (f.isDeadline ? 'deadline' : f.isThreshold ? 'threshold' : f.isWin ? 'win' : 'other');

// ---------- times & decision plan ----------

// Listing = when trading opened: acceptingOrdersTimestamp, else startDate, else createdAt.
// (createdAt can precede trading by weeks; startDate/acceptingOrders match the first price point.)
export function listingTsOf(times = {}) {
  return parseTs(times.acceptingOrdersTimestamp) ?? parseTs(times.startDate) ?? parseTs(times.createdAt);
}

// -> { decisions: [{ offsetH, decisionTs, maxAgeSec }], drops: { reason: n }, reason? }
// reason (market-level): no_end_date | no_closed_time | no_listing_time. The rule per decision:
// listing <= decisionTs < closedTs, and the early decision must precede the anchor. Uses closedTime
// only to ask "was the market still open at decisionTs", which is known at decisionTs.
export function decisionPlan({ listingTs, anchorTs, closedTs }, offsets = ALL_OFFSETS_H) {
  const drops = {};
  const bump = (k) => { drops[k] = (drops[k] || 0) + 1; };
  if (anchorTs == null) return { decisions: [], drops, reason: 'no_end_date' };
  if (closedTs == null) return { decisions: [], drops, reason: 'no_closed_time' };
  if (listingTs == null) return { decisions: [], drops, reason: 'no_listing_time' };
  const decisions = [];
  for (const offsetH of offsets) {
    const decisionTs = offsetH === EARLY_OFFSET_H ? listingTs + DAY : anchorTs - Math.round(offsetH * HOUR);
    if (decisionTs < listingTs) { bump('before_listing'); continue; }
    if (decisionTs >= closedTs) { bump('market_closed'); continue; }
    if (offsetH === EARLY_OFFSET_H && decisionTs >= anchorTs) { bump('early_not_before_anchor'); continue; }
    decisions.push({ offsetH, decisionTs, maxAgeSec: maxPriceAgeSec(offsetH) });
  }
  return { decisions, drops };
}

// Price windows the builder can read for these decisions: [decision - 7 d lookback - staleness, decision]
// for each decision, plus up to the label point (min(anchor, closedTs)). Merged when they overlap or
// sit within 2 days of each other. Clipped at listing - 1 h and closedTs.
export function priceWindows(plan, { listingTs, anchorTs, closedTs }) {
  if (!plan.decisions.length) return [];
  const raw = [];
  const end = Math.min(anchorTs, closedTs);
  for (const d of plan.decisions) {
    const a = d.decisionTs - LOOKBACK_SEC.m7d - 2 * d.maxAgeSec;
    raw.push([a, Math.max(d.decisionTs, d.offsetH === EARLY_OFFSET_H ? d.decisionTs : end)]);
  }
  const lo = listingTs - HOUR, hi = closedTs;
  const clipped = raw.map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const w of clipped) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1] + 2 * DAY) last[1] = Math.max(last[1], w[1]);
    else out.push([...w]);
  }
  return out;
}

// Merge window lists (union).
export function mergeWindows(...lists) {
  const all = lists.flat().filter((w) => Array.isArray(w) && w[1] > w[0]).map((w) => [...w]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const w of all) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push(w);
  }
  return out;
}
export const windowsCover = (have, want) => want.every(([a, b]) => (have || []).some(([x, y]) => x <= a && y >= b));

// ---------- fees ----------

// Polymarket taker fee per share = shares x price x rate x (price x (1 - price))^exponent, from the
// market's feeSchedule ({ rate, exponent, takerOnly, rebateRate }); 0 when fees are not enabled.
// Returned as a fraction of the price paid, so cost = price x (1 + feeFraction). Used only for the
// actual-fee SENSITIVITY; the headline cost model is the kit's flat --fee / --spread.
export function feeFraction(price, fee) {
  if (!fee || !(fee.rate > 0) || fee.enabled === false) return 0;
  const p = Math.min(1, Math.max(0, price));
  const e = Number.isFinite(fee.exponent) ? fee.exponent : 1;
  return fee.rate * (p * (1 - p)) ** e;
}

export function feeInfoOf(m) {
  const s = m && typeof m.feeSchedule === 'object' && m.feeSchedule ? m.feeSchedule : null;
  const enabled = bool(m?.feesEnabled);
  const rate = s && Number.isFinite(Number(s.rate)) ? Number(s.rate) : null;
  return {
    feeType: m?.feeType ?? null,
    feesEnabled: enabled,
    feeRate: enabled === true && rate != null ? rate : 0,
    feeExponent: s && Number.isFinite(Number(s.exponent)) ? Number(s.exponent) : null,
    feeTakerOnly: s ? bool(s.takerOnly) : null,
    feeSchedule: s,
  };
}

// ---------- sampling ----------

// Events are collected in a fixed pseudo-random order (sha1 of salt:eventId), so whatever subset a
// time budget allows is a uniform random sample of the universe, and resumed runs continue it.
export const sampleKey = (salt, eventId) => createHash('sha1').update(`${salt}:${eventId}`).digest('hex');

export const isYesNo = (outcomes) => Array.isArray(outcomes) && outcomes.length === 2
  && outcomes.map((o) => String(o).trim().toLowerCase()).sort().join('|') === 'no|yes';
