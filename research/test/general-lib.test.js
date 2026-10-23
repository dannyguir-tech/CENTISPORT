// General (non-sports) track: shared rules, collector normalisation, builder no-lookahead and group
// synchronisation. SYNTHETIC values only (the gamma market below copies the shape of a live one).
// Run: node --test research/test/general-lib.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_OFFSETS_H, DAY, EARLY_OFFSET_H, GROUP_STAMP_TOL_SEC, GROUP_SYNC_SEC, HOUR, categoryOf, decisionPlan, feeFraction, feeInfoOf, isCryptoUpDown,
  isSportsEvent, maxPriceAgeSec, priceWindows, questionFlags, resolveWinner,
} from '../general/lib.js';
import { eventExclusion, eventTooShort, groupMembers, normalizeGeneralMarket, orderUniverse, parseArgs } from '../general/collect.js';
import { buildGeneralRows, groupFeaturesAt } from '../general/build-dataset.js';

const tags = (...s) => s.map((slug) => ({ slug }));
const T0 = Date.UTC(2025, 5, 1, 13, 46) / 1000;
const iso = (t) => new Date(t * 1000).toISOString();

// Shape of a live gamma market (2026-10 probe), times shifted into 2025.
function gammaMarket(over = {}) {
  return {
    id: '5880182', question: '[SYNTHETIC] Curfew in a major French city by June 30, 2025?', conditionId: `0x${'6c'.repeat(32)}`,
    slug: 'curfew-by-june-30', outcomes: '["Yes", "No"]', outcomePrices: '["0", "1"]',
    clobTokenIds: '["30230638519526624004052805098518879501398957399558925818312740302432877049053", "91578995045409591897522895664596614880778407687531737124806869293861449589050"]',
    active: true, closed: true, createdAt: iso(T0 - 14), startDate: iso(T0), acceptingOrdersTimestamp: iso(T0),
    endDate: iso(T0 + 29 * DAY), closedTime: new Date((T0 + 30 * DAY) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00'),
    umaResolutionStatus: 'resolved', negRisk: false, negRiskOther: false, groupItemTitle: 'June 30',
    feeType: 'politics_fees', feeSchedule: { exponent: 1, rate: 0.04, takerOnly: true, rebateRate: 0.25 }, feesEnabled: true, volumeNum: 31064.9,
    ...over,
  };
}
const EVENT = { id: '1211738', slug: 'curfew-by', title: '[SYNTHETIC] Curfew in a major French city by...?', endDate: iso(T0 + 60 * DAY), tags: tags('paris', 'world', 'france', 'politics', 'protests') };

test('categories: specific before general, sports and crypto Up-or-Down excluded', () => {
  assert.equal(categoryOf(tags('elections', 'politics')), 'elections');
  assert.equal(categoryOf(tags('politics', 'trump')), 'politics');
  assert.equal(categoryOf(tags('world', 'politics')), 'geopolitics');
  assert.equal(categoryOf(tags('crypto', 'crypto-prices', '1H')), 'crypto');
  assert.equal(categoryOf(tags('weather', 'daily-temperature')), 'science-weather');
  assert.equal(categoryOf(tags('equities', 'stocks')), 'economics-finance');
  assert.equal(categoryOf(tags('pop-culture', 'mention-markets')), 'culture-entertainment');
  assert.equal(categoryOf(tags('ai', 'openai')), 'tech-ai');
  assert.equal(categoryOf(tags('hide-from-new', 'recurring')), 'other');
  assert.equal(isSportsEvent(tags('sports', 'nba')), true);
  assert.equal(isSportsEvent(tags('nfl')), true);
  assert.equal(isSportsEvent(tags('nfl', 'pop-culture')), false, 'a culture market about a sports event stays in');
  assert.equal(isSportsEvent(tags('politics'), ['sports_fees_v2']), true);
  assert.equal(isCryptoUpDown({ tags: tags('crypto', 'up-or-down') }), true);
  assert.equal(isCryptoUpDown({ tags: tags('crypto'), title: 'Bitcoin Up or Down - June 1, 3PM ET' }), true);
  assert.equal(isCryptoUpDown({ tags: tags('crypto'), title: 'Bitcoin above ___ on June 1?' }), false);
  assert.equal(eventExclusion({ tags: tags('esports'), markets: [] }), 'sports');
});

test('question flags', () => {
  const f = (q) => questionFlags(q);
  assert.equal(f('Curfew in a major French city by October 24, 2026?').isDeadline, true);
  assert.equal(f('Will Israel invade Lebanon before March?').isDeadline, true);
  assert.equal(f('Ceasefire by end of 2025?').isDeadline, true);
  assert.equal(f('GPT-5.6 released by...?').isDeadline, true, 'fixed: "by..." without a space was missed');
  assert.equal(f('Will X happen by ___?').isDeadline, true);
  assert.equal(f('Will Biden say goodbye?').isDeadline, false);
  assert.equal(f('Will Trump say "tariff" before the election?').isDeadline, false, '"before the election" is not a date');
  assert.equal(f('Who will win the Lewisham Mayoral Election?').isWin, true);
  assert.equal(f('Will Alice be the winner of Eurovision?').isWin, true);
  assert.equal(f('Will Windows ship?').isWin, false);
  assert.equal(f('Ethereum above $2,500 on November 8?').isThreshold, true);
  assert.equal(f('Will the highest temperature in NYC be 70°F or below?').isThreshold, false, 'no number after the keyword');
  assert.equal(f('Will inflation reach 3% in 2025?').isThreshold, true);
  assert.equal(f('Will the Fed cut rates in June?').isThreshold, false);
});

test('resolution: one clean winner only', () => {
  assert.deepEqual(resolveWinner('["0", "1"]', 2), { winnerIndex: 1 });
  assert.deepEqual(resolveWinner('["0.5", "0.5"]', 2), { skip: 'voided_50_50' });
  assert.deepEqual(resolveWinner('["1", "1"]', 2), { skip: 'ambiguous_resolution' });
  assert.deepEqual(resolveWinner('["0.97", "0.03"]', 2), { skip: 'ambiguous_resolution' });
  assert.deepEqual(resolveWinner(null, 2), { skip: 'missing_outcome_prices' });
});

test('decision plan: anchor offsets, listing + 1 d, open at decision, early before anchor', () => {
  const listingTs = T0, anchorTs = T0 + 40 * DAY;
  const all = decisionPlan({ listingTs, anchorTs, closedTs: anchorTs + 3 * HOUR });
  assert.deepEqual(all.decisions.map((d) => d.offsetH), ALL_OFFSETS_H);
  assert.equal(all.decisions.find((d) => d.offsetH === EARLY_OFFSET_H).decisionTs, listingTs + DAY);
  assert.equal(all.decisions.find((d) => d.offsetH === 720).decisionTs, anchorTs - 30 * DAY);
  // Resolved Yes early: only decisions before closedTime exist.
  const early = decisionPlan({ listingTs, anchorTs, closedTs: listingTs + 5 * DAY });
  assert.deepEqual(early.decisions.map((d) => d.offsetH), [EARLY_OFFSET_H]);
  assert.equal(early.drops.market_closed, 5);
  // A 2-day market: anchor - 3 d and more precede listing; listing + 1 d is still before the anchor.
  const short = decisionPlan({ listingTs, anchorTs: listingTs + 2 * DAY, closedTs: listingTs + 2 * DAY + HOUR });
  assert.deepEqual(short.decisions.map((d) => d.offsetH), [EARLY_OFFSET_H, 24]);
  assert.equal(short.drops.before_listing, 4);
  // A market shorter than a day has none.
  assert.equal(decisionPlan({ listingTs, anchorTs: listingTs + 20 * HOUR, closedTs: listingTs + 21 * HOUR }).decisions.length, 0);
  assert.equal(decisionPlan({ listingTs, anchorTs: null, closedTs: listingTs }).reason, 'no_end_date');
  assert.equal(maxPriceAgeSec(24), 12 * HOUR);
  assert.equal(maxPriceAgeSec(168), 24 * HOUR);
  assert.equal(maxPriceAgeSec(EARLY_OFFSET_H), 12 * HOUR);
});

test('price windows cover every lookback the builder reads', () => {
  const m = { listingTs: T0, anchorTs: T0 + 90 * DAY, closedTs: T0 + 90 * DAY + 2 * HOUR };
  const plan = decisionPlan(m);
  const w = priceWindows(plan, m);
  const covered = (t) => w.some(([a, b]) => t >= a && t <= b);
  for (const d of plan.decisions) {
    for (const t of [d.decisionTs, d.decisionTs - d.maxAgeSec, d.decisionTs - DAY - d.maxAgeSec, d.decisionTs - 7 * DAY - 2 * d.maxAgeSec]) {
      if (t >= m.listingTs) assert.ok(covered(t), `offset ${d.offsetH}: ${t} not covered by ${JSON.stringify(w)}`);
    }
  }
  assert.ok(covered(m.anchorTs), 'the label point (anchor) is covered');
  assert.equal(w.length, 2, 'early and anchor windows stay separate when far apart');
});

test('fees: Polymarket taker formula as a fraction of price', () => {
  const info = feeInfoOf(gammaMarket());
  assert.equal(info.feeRate, 0.04);
  assert.equal(info.feeType, 'politics_fees');
  assert.ok(Math.abs(feeFraction(0.5, { rate: 0.04, exponent: 1 }) - 0.01) < 1e-12);
  assert.ok(Math.abs(feeFraction(0.5, { rate: 0.25, exponent: 2 }) - 0.015625) < 1e-12, 'crypto 15m schedule peaks at 1.56%');
  assert.equal(feeInfoOf(gammaMarket({ feesEnabled: false })).feeRate, 0);
});

test('collector normalisation: record fields and every skip reason', () => {
  const sinceTs = Date.UTC(2024, 0, 1) / 1000;
  const n = normalizeGeneralMarket(gammaMarket(), EVENT, { sinceTs });
  assert.equal(n.skip, undefined);
  const r = n.record;
  assert.equal(r.category, 'geopolitics');
  assert.equal(r.anchorTs, T0 + 29 * DAY);
  assert.equal(r.anchorSource, 'market.endDate');
  assert.equal(r.closedTs, T0 + 30 * DAY);
  assert.equal(r.listingTs, T0);
  assert.equal(r.yesIndex, 0);
  assert.equal(r.winnerIndex, 1);
  assert.equal(r.feeRate, 0.04);
  assert.equal(r.questionFlags.isDeadline, true);
  assert.equal(r.eventId, '1211738');
  assert.ok(n.windows.length >= 1);
  const skip = (over, ev = EVENT) => normalizeGeneralMarket(gammaMarket(over), ev, { sinceTs }).skip;
  assert.equal(skip({ outcomePrices: '["0.5", "0.5"]' }), 'voided_50_50');
  assert.equal(skip({ umaResolutionStatus: 'proposed' }), 'non_final_resolution');
  assert.equal(skip({ outcomes: '["Up", "Down"]' }), 'not_yes_no');
  assert.equal(skip({ closed: false }), 'not_closed');
  assert.equal(skip({ active: false }), 'inactive_placeholder');
  assert.equal(skip({ createdAt: '2023-12-31T00:00:00Z' }), 'created_before_since');
  assert.equal(skip({ endDate: null }, { ...EVENT, endDate: null }), 'no_end_date');
  assert.equal(skip({ closedTime: null }), 'no_closed_time');
  assert.equal(skip({ endDate: iso(T0 + 12 * HOUR), closedTime: iso(T0 + 13 * HOUR) }), 'no_possible_decision');
  const fb = normalizeGeneralMarket(gammaMarket({ endDate: null }), EVENT, { sinceTs });
  assert.equal(fb.record.anchorSource, 'event.endDate');
  assert.equal(fb.record.anchorTs, T0 + 60 * DAY);
});

test('negRisk members: inactive placeholders out, every active member in', () => {
  const nr = `0x${'ab'.repeat(32)}`;
  const mk = (i, over = {}) => gammaMarket({ conditionId: `0x${String(i).repeat(64)}`, negRisk: true, negRiskMarketID: nr, clobTokenIds: `["${i}1", "${i}2"]`, ...over });
  const ev = { ...EVENT, negRisk: true, markets: [mk(1, { outcomePrices: '["1", "0"]' }), mk(2), mk(3, { active: false }), mk(4, { closed: false })] };
  const g = groupMembers(ev, nr);
  assert.deepEqual(g.map((m) => m.yesTokenId), ['11', '21', '41']);
  assert.equal(g[0].resolvedYes, 1);
  assert.equal(g[1].resolvedYes, 0);
  assert.equal(g[2].resolvedYes, null, 'an open member has no resolution');
});

test('universe order: lifetime < 1 day and pre-since events out, order fixed by salt', () => {
  const ev = (id, c, e, extra = {}) => ({ id: String(id), createdAt: iso(c), endDate: iso(e), closedTime: iso(e + HOUR), tags: ['politics'], ...extra });
  const rows = [ev(1, T0, T0 + 10 * DAY), ev(2, T0, T0 + 20 * HOUR), ev(3, T0 - 400 * DAY, T0 - 380 * DAY), ev(4, T0, T0 + 3 * DAY, { tags: ['sports'] }), ev(5, T0, T0 + 2 * DAY), ev(1, T0, T0 + 10 * DAY)];
  assert.equal(eventTooShort(rows[1]), true);
  assert.equal(eventTooShort(rows[0]), false);
  const a = orderUniverse(rows, { sinceTs: T0 - 30 * DAY, salt: 's1' });
  assert.deepEqual(a.counts, { indexed: 6, sports: 1, crypto_up_or_down: 0, closed_before_since: 1, lifetime_under_1d: 1, duplicate: 1, kept: 2 });
  const b = orderUniverse([...rows].reverse(), { sinceTs: T0 - 30 * DAY, salt: 's1' });
  assert.deepEqual(a.order.map((r) => r.id), b.order.map((r) => r.id), 'order does not depend on listing order');
  assert.throws(() => parseArgs(['--rps', '2000']), /<= 1000/);
});

test('universe order: --balance category gives every prefix about equal listed markets per category, uniform within', () => {
  // 300 weather events of 11 markets, 300 geopolitics of 1, 40 tech of 4: a uniform order is ~93% weather markets.
  const ev = (id, tag, n) => ({ id: String(id), createdAt: iso(T0), endDate: iso(T0 + 10 * DAY), closedTime: iso(T0 + 10 * DAY), tags: [tag], nMarkets: n });
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(ev(1000 + i, 'weather', 11), ev(2000 + i, 'geopolitics', 1));
  for (let i = 0; i < 40; i++) rows.push(ev(3000 + i, 'ai', 4));
  const opts = { sinceTs: T0 - 30 * DAY, salt: 's1' };
  const uni = orderUniverse(rows, opts);
  const bal = orderUniverse(rows, { ...opts, balance: 'category' });
  assert.deepEqual(bal.counts, uni.counts);
  assert.deepEqual(bal.order.map((r) => r.id).sort(), uni.order.map((r) => r.id).sort(), 'same events, only the order differs');
  const load = (order, k) => {
    const out = {};
    for (const r of order.slice(0, k)) out[categoryOf(r.tags)] = (out[categoryOf(r.tags)] || 0) + r.nMarkets;
    return out;
  };
  for (const k of [30, 90, 150]) {
    const l = load(bal.order, k);
    const vals = Object.values(l);
    assert.equal(vals.length, 3, `prefix ${k} holds all three categories`);
    assert.ok(Math.max(...vals) - Math.min(...vals) <= 11, `prefix ${k}: listed markets per category within one event (${JSON.stringify(l)})`);
  }
  // Within a category the balanced order keeps the uniform (sha1) order.
  for (const tag of ['weather', 'geopolitics', 'ai']) {
    const ids = (o) => o.filter((r) => r.tags[0] === tag).map((r) => r.id);
    assert.deepEqual(ids(bal.order), ids(uni.order), tag);
  }
  // Exhausted categories drop out; the rest continue (weather, with the most markets, fills the tail).
  assert.equal(bal.order.length, 640);
  const lastGeo = bal.order.map((r) => categoryOf(r.tags)).lastIndexOf('geopolitics');
  assert.ok(lastGeo < 640 - 200, 'geopolitics (300 markets) is used up long before weather (3300)');
  assert.ok(bal.order.slice(lastGeo + 1).every((r) => categoryOf(r.tags) === 'science-weather'));
  assert.equal(parseArgs(['--balance', 'category']).balance, 'category');
  assert.equal(parseArgs([]).balance, 'none');
  assert.throws(() => parseArgs(['--balance', 'volume']), /one of none, category/);
});

// ---------- builder ----------

function marketRecord(over = {}) {
  const n = normalizeGeneralMarket(gammaMarket({ endDate: iso(T0 + 40 * DAY), closedTime: iso(T0 + 40 * DAY + 5 * HOUR), ...over }), EVENT, {});
  assert.equal(n.skip, undefined);
  return n.record;
}
const hourly = (from, to, f, stampOffset = 5) => {
  const out = [];
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) out.push({ t: t + stampOffset, p: f(t) });
  return out;
};

test('builder: rows per side and decision, labels, staleness, price range', () => {
  const m = marketRecord();
  const yes = hourly(m.listingTs, m.closedTs, (t) => 0.3 + 0.2 * Math.sin(t / 86400));
  const counters = { rowDrops: {}, featureNulls: {} };
  const rows = buildGeneralRows(m, yes, null, counters);
  assert.equal(rows.length, 2 * 6);
  for (const r of rows) {
    assert.ok(r.decisionTs < m.closedTs && r.decisionTs >= m.listingTs && r.decisionTs < r.startTs);
    assert.ok(r.priceAgeSec >= 0 && r.priceAgeSec <= maxPriceAgeSec(r.offsetH));
    assert.equal(r.won, r.side === 'no' ? 1 : 0);
    assert.equal(r.settleTs, m.closedTs);
    assert.ok(Math.abs(r.price - (r.side === 'yes' ? r.yesPrice : 1 - r.yesPrice)) < 1e-6);
    assert.equal(r.eventKey, '1211738');
    assert.equal(r.feeRate, 0.04);
  }
  // A 13-hour hole before anchor - 1 d drops that row (12 h limit) but not anchor - 7 d (24 h limit).
  const d1 = m.anchorTs - DAY, d7 = m.anchorTs - 7 * DAY;
  const holes = yes.filter((p) => !(p.t > d1 - 13 * HOUR && p.t <= d1) && !(p.t > d7 - 13 * HOUR && p.t <= d7));
  const c2 = { rowDrops: {}, featureNulls: {} };
  const r2 = buildGeneralRows(m, holes, null, c2);
  assert.equal(c2.rowDrops.stale_price, 1);
  assert.ok(!r2.some((r) => r.offsetH === 24));
  assert.ok(r2.some((r) => r.offsetH === 168));
  const c3 = { rowDrops: {}, featureNulls: {} };
  buildGeneralRows(m, yes.map((p) => ({ ...p, p: 0.995 })), null, c3);
  assert.equal(c3.rowDrops.price_out_of_range, 6);
});

function negRiskSetup() {
  const nr = `0x${'cd'.repeat(32)}`;
  const m = marketRecord({ negRisk: true, negRiskMarketID: nr });
  const end = m.closedTs;
  const self = hourly(m.listingTs, end, () => 0.4, 5);
  const members = [
    { conditionId: m.conditionId, listingTs: m.listingTs, closedTs: m.closedTs, resolvedYes: 0, points: self },
    { conditionId: '0xb', listingTs: m.listingTs, closedTs: m.closedTs, resolvedYes: 1, points: hourly(m.listingTs, end, () => 0.5, 40) },
    { conditionId: '0xc', listingTs: m.listingTs, closedTs: m.closedTs, resolvedYes: 0, points: hourly(m.listingTs, end, () => 0.2, 50) },
  ];
  return { m, self, group: { members } };
}

test('builder: NO LOOK-AHEAD (points and member quotes 1 s after each decision change no feature)', () => {
  const { m, self, group } = negRiskSetup();
  const base = buildGeneralRows(m, self, group);
  assert.ok(base.length >= 10);
  const strip = (r) => { const { won, closePrice, clv, settleTs, ...f } = r; return f; };
  for (const d of decisionPlan(m).decisions) {
    const inject = (pts) => [...pts, { t: d.decisionTs + 1, p: 0.97 }].sort((a, b) => a.t - b.t);
    const g2 = { members: group.members.map((mb) => ({ ...mb, points: inject(mb.points) })) };
    const after = buildGeneralRows(m, inject(self), g2);
    for (const side of ['yes', 'no']) {
      const a = base.find((r) => r.offsetH === d.offsetH && r.side === side);
      const b = after.find((r) => r.offsetH === d.offsetH && r.side === side);
      assert.deepEqual(strip(b), strip(a), `offset ${d.offsetH} ${side}`);
    }
  }
  const r = base.find((x) => x.offsetH === 24 && x.side === 'yes');
  assert.equal(r.groupSize, 3);
  assert.ok(Math.abs(r.groupYesSum - 1.1) < 1e-9);
  assert.equal(r.groupTop, false);
});

test('group sync: member stamps up to 2 min after the point count, later ones and stale ones do not', () => {
  const T = T0 + 10 * DAY;
  const g = (stamp, extra = {}) => ({ members: [{ conditionId: '0xb', listingTs: T0, closedTs: T + 30 * DAY, resolvedYes: 0, points: [{ t: T - HOUR, p: 0.31 }, { t: stamp, p: 0.3 }], ...extra }] });
  assert.equal(groupFeaturesAt(g(T + 50), '0xa', 0.6, T, T + 3600).groupYesSum, 0.9, '50 s later: the same hourly print');
  const late = groupFeaturesAt(g(T + GROUP_STAMP_TOL_SEC + 60), '0xa', 0.6, T, T + 3600);
  assert.equal(late.groupYesSum, null, 'its previous print is an hour old');
  assert.equal(late.nullReason, 'group_quote_not_synchronous');
  assert.equal(groupFeaturesAt(g(T + 50), '0xa', 0.6, T, T + 30).groupYesSum, null, 'never past the decision time');
  assert.equal(groupFeaturesAt(g(T - GROUP_SYNC_SEC + 60), '0xa', 0.6, T, T).groupYesSum, 0.9, '29 min older is synchronous');
  // A member closed by T counts at its (then public) resolution; one listed later is not counted.
  const closed = groupFeaturesAt({ members: [{ conditionId: '0xb', listingTs: T0, closedTs: T - DAY, resolvedYes: 1, points: [] }] }, '0xa', 0.02, T, T);
  assert.equal(closed.groupYesSum, 1.02);
  assert.equal(closed.groupTop, false, 'fixed: a member that already resolved Yes is the top, not the 0.02 row');
  const later = groupFeaturesAt({ members: [{ conditionId: '0xb', listingTs: T + DAY, closedTs: null, points: [{ t: T + DAY, p: 0.5 }] }] }, '0xa', 0.6, T, T);
  assert.equal(later.groupSize, 1);
  assert.equal(later.groupTop, true);
});
