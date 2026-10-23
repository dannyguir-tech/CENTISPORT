#!/usr/bin/env node
// Point-in-time dataset builder for the NON-SPORTS ("general") track. Reads what
// research/general/collect.js (or research/general/synthetic.js) wrote and emits dataset.jsonl rows
// in the format research/backtest.js reads (run it with --hypotheses research/general/hypotheses.js).
//
// One row per (market, side, decision). Decisions: anchor (scheduled end, market endDate) minus
// 1/3/7/14/30 days and listing + 1 day (offsetH -24). A row exists only if listing <= decisionTs <
// closedTime, the last Yes price point at or before decisionTs is at most 12 h old (24 h for
// offsets >= 7 d) and the price is in [0.01, 0.99] (lib.js decisionPlan + below).
//
// Every feature is computed as of the row's own price point (t <= decisionTs): lagged prices, and
// negRisk group features from member quotes stamped within 30 min before that point (never fresher).
// Labels: won, closePrice, clv, settleTs (= closedTime). backtest.js strips them before any
// hypothesis sees a row; it also strips the fee fields (BACKTEST.metaFields in hypotheses.js).
// closedTime is used only for "was the market open at decisionTs" and, for OTHER group members
// that had already closed by the row's point, their (then public) resolution.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSyntheticMarket, readProvenance } from '../build-dataset.js';
import {
  DAY, EARLY_OFFSET_H, GROUP_STAMP_TOL_SEC, GROUP_SYNC_SEC, HOUR, LOOKBACK_SEC, MAX_PRICE, MIN_PRICE, decisionPlan, lastIndexAtOrBefore, offsetLabel, patternClass,
  questionFlags,
} from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = Object.freeze({ dataDir: path.join(HERE, '..', 'data-general'), out: null });

const r6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };
const safeName = (s) => typeof s === 'string' && s.length > 0 && !/[\/\\]|\.\./.test(s);

export function readPriceFile(dataDir, tokenId) {
  if (!safeName(tokenId)) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(dataDir, 'prices', `${tokenId}.json`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const j = JSON.parse(raw);
  const pts = [];
  for (const x of Array.isArray(j.points) ? j.points : []) {
    const t = Number(x && x.t), p = Number(x && x.p);
    if (Number.isFinite(t) && Number.isFinite(p) && p >= 0 && p <= 1) pts.push({ t: Math.floor(t), p });
  }
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

// Last point with t <= ts and ts - t <= maxAgeSec, or null.
function pointAsOf(points, ts, maxAgeSec) {
  if (!points || !points.length) return null;
  const i = lastIndexAtOrBefore(points, ts);
  if (i < 0 || ts - points[i].t > maxAgeSec) return null;
  return points[i];
}

/**
 * negRisk group features as of T (the row's own price point). Members count once they have
 * traded (listing <= T and a price point <= T). A member closed by T adds its resolved value (public
 * at T); an open member needs its last quote at or before min(decisionTs, T + GROUP_STAMP_TOL_SEC)
 * to be at most GROUP_SYNC_SEC older than T. clob stamps each token's hourly points a few seconds
 * apart (all within the first minute of the hour, seen live), so a strict "at or before T" would
 * pair a row with its members' previous hour; the 2-minute tolerance absorbs that stamp jitter and
 * never reaches past the decision time. Any gap -> sums null.
 * -> { groupSize, groupYesSum, groupTop, nullReason }
 */
export function groupFeaturesAt(group, selfCid, selfYes, T, decisionTs = T) {
  const upTo = Math.min(decisionTs, T + GROUP_STAMP_TOL_SEC);
  if (!group || !Array.isArray(group.members) || !group.members.length) return { groupSize: null, groupYesSum: null, groupTop: null, nullReason: 'group_missing' };
  let size = 0, sum = 0, nullReason = null, topCid = null, topYes = -Infinity;
  const add = (cid, yes) => {
    sum += yes;
    if (yes > topYes || (yes === topYes && cid < topCid)) { topYes = yes; topCid = cid; }
  };
  let selfSeen = false;
  for (const mb of group.members) {
    if (mb.conditionId === selfCid) { selfSeen = true; size++; add(selfCid, selfYes); continue; }
    if (mb.listingTs != null && mb.listingTs > upTo) continue; // not listed yet
    if (mb.closedTs != null && mb.closedTs <= T) {
      // Closed by T: its resolution is public at T.
      size++;
      if (mb.resolvedYes !== 0 && mb.resolvedYes !== 1) nullReason ||= 'group_member_unresolved';
      else add(mb.conditionId, mb.resolvedYes); // a member that already resolved Yes is the group's top
      continue;
    }
    const pts = mb.points;
    if (pts == null) { size++; nullReason ||= 'group_member_prices_missing'; continue; }
    const i = lastIndexAtOrBefore(pts, upTo);
    if (i < 0) continue; // no quote yet: not trading yet (e.g. a placeholder activated later)
    size++;
    if (T - pts[i].t > GROUP_SYNC_SEC) { nullReason ||= 'group_quote_not_synchronous'; continue; }
    add(mb.conditionId, pts[i].p);
  }
  if (!selfSeen) { size++; add(selfCid, selfYes); }
  if (nullReason) return { groupSize: size, groupYesSum: null, groupTop: null, nullReason };
  return { groupSize: size, groupYesSum: r6(sum), groupTop: topCid === selfCid, nullReason: null };
}

export function validateRecord(m) {
  if (!m || typeof m !== 'object' || typeof m.conditionId !== 'string' || !m.conditionId) return null;
  if (!Array.isArray(m.outcomes) || m.outcomes.length !== 2 || !Array.isArray(m.tokenIds) || m.tokenIds.length !== 2) return null;
  if (m.yesIndex !== 0 && m.yesIndex !== 1) return null;
  if (m.winnerIndex !== 0 && m.winnerIndex !== 1) return null;
  if (typeof m.yesTokenId !== 'string' || m.yesTokenId !== String(m.tokenIds[m.yesIndex])) return null;
  return m;
}

/**
 * Rows for one market. yesPoints: sorted Yes price points (No = 1 - Yes). group: null or
 * { members: [{ conditionId, listingTs, closedTs, resolvedYes, points }] }.
 * counters: { rowDrops, featureNulls } (per decision / per row).
 */
export function buildGeneralRows(m, yesPoints, group, counters = { rowDrops: {}, featureNulls: {} }) {
  counters.rowDrops ||= {};
  counters.featureNulls ||= {};
  const { listingTs, anchorTs, closedTs } = m;
  const plan = decisionPlan({ listingTs, anchorTs, closedTs });
  for (const [k, v] of Object.entries(plan.drops)) bump(counters.rowDrops, k, v);
  if (plan.reason) { bump(counters.rowDrops, plan.reason); return []; }
  const flags = m.questionFlags && typeof m.questionFlags === 'object' ? m.questionFlags : questionFlags(m.question);
  const yesWon = m.winnerIndex === m.yesIndex;
  const noIndex = 1 - m.yesIndex;
  // Label only: last point at or before min(anchor, closedTime - 1 h), if it is at most a day old.
  const labelTs = Math.min(anchorTs, closedTs - HOUR);
  const labelPt = pointAsOf(yesPoints, labelTs, DAY);
  const rows = [];
  for (const d of plan.decisions) {
    if (!yesPoints || !yesPoints.length) { bump(counters.rowDrops, 'no_price_file'); continue; }
    const idx = lastIndexAtOrBefore(yesPoints, d.decisionTs);
    if (idx < 0) { bump(counters.rowDrops, 'no_price_before_decision'); continue; }
    const pt = yesPoints[idx];
    const priceAgeSec = d.decisionTs - pt.t;
    if (priceAgeSec > d.maxAgeSec) { bump(counters.rowDrops, 'stale_price'); continue; }
    const yes = pt.p;
    if (!(yes >= MIN_PRICE && yes <= MAX_PRICE)) { bump(counters.rowDrops, 'price_out_of_range'); continue; }
    const m1 = pointAsOf(yesPoints, pt.t - LOOKBACK_SEC.m1d, d.maxAgeSec);
    const m7 = pointAsOf(yesPoints, pt.t - LOOKBACK_SEC.m7d, d.maxAgeSec);
    let g = { groupSize: null, groupYesSum: null, groupTop: null, nullReason: null };
    if (m.negRisk) {
      g = groupFeaturesAt(group, m.conditionId, yes, pt.t, d.decisionTs);
      if (g.nullReason) bump(counters.featureNulls, g.nullReason);
    }
    for (const side of ['yes', 'no']) {
      const isYes = side === 'yes';
      const px = (p) => (p == null ? null : isYes ? p : r6(1 - p));
      const price = px(yes);
      const pm1 = m1 ? px(m1.p) : null;
      const pm7 = m7 ? px(m7.p) : null;
      const close = labelPt ? px(labelPt.p) : null;
      rows.push({
        id: `${m.conditionId}|${isYes ? m.yesIndex : noIndex}|${d.offsetH}`,
        eventKey: String(m.eventId ?? m.eventSlug ?? m.conditionId),
        conditionId: m.conditionId,
        outcomeIndex: isYes ? m.yesIndex : noIndex,
        outcome: isYes ? 'Yes' : 'No',
        side,
        startTs: anchorTs, // the anchor (scheduled end); backtest.js requires decisionTs < startTs
        decisionTs: d.decisionTs,
        offsetH: d.offsetH,
        offsetLabel: offsetLabel(d.offsetH),
        sport: m.category, // backtest.js per-group variants key on this field
        category: m.category,
        marketType: patternClass(flags),
        sideType: side,
        price,
        priceAgeSec,
        yesPrice: yes,
        price_m1d: pm1,
        price_m7d: pm7,
        mom1d: pm1 == null ? null : r6(price - pm1),
        mom7d: pm7 == null ? null : r6(price - pm7),
        daysToAnchor: r4((anchorTs - pt.t) / DAY),
        daysSinceListing: r4((pt.t - listingTs) / DAY),
        isDeadline: !!flags.isDeadline,
        isWin: !!flags.isWin,
        isThreshold: !!flags.isThreshold,
        negRisk: !!m.negRisk,
        groupSize: g.groupSize,
        groupYesSum: g.groupYesSum,
        groupTop: g.groupTop,
        // Cost metadata (stripped by backtest.js before hypotheses run; actual-fee sensitivity only).
        feeRate: Number.isFinite(m.feeRate) ? m.feeRate : 0,
        feeExponent: Number.isFinite(m.feeExponent) ? m.feeExponent : null,
        feeType: m.feeType ?? null,
        // Labels.
        won: (isYes ? yesWon : !yesWon) ? 1 : 0,
        closePrice: close,
        clv: close == null ? null : r6(close - price),
        settleTs: closedTs,
      });
    }
  }
  return rows;
}

// ---------- driver ----------

function loadGroup(dataDir, file, cache) {
  if (!safeName(file)) return null;
  if (cache.has(file)) return cache.get(file);
  let g = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'groups', file), 'utf8'));
    g = { ...j, members: (j.members || []).map((mb) => ({ ...mb, points: readPriceFile(dataDir, mb.yesTokenId) })) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  cache.set(file, g);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return g;
}

export async function buildGeneralDataset(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const dataDir = path.resolve(o.dataDir);
  const out = path.resolve(o.out || path.join(dataDir, 'dataset.jsonl'));
  const marketsFile = path.join(dataDir, 'markets.jsonl');
  if (!fs.existsSync(marketsFile)) throw new Error(`markets.jsonl not found in ${dataDir}; run research/general/collect.js first or pass --data-dir`);
  const summary = {
    tool: 'research/general/build-dataset.js', dataDir, out,
    rules: {
      anchor: 'market endDate (scheduled end); event endDate when the market has none; markets with neither are dropped (no_end_date)',
      decisions: 'anchor - {1,3,7,14,30} d, and listing + 1 d (offsetH -24, only if before the anchor)',
      rowExists: 'listing <= decisionTs < closedTime; last Yes point <= decisionTs at most 12 h old (24 h for offsets >= 7 d); price in [0.01, 0.99]',
      endDateFarFromClose: 'never dropped or used as a feature (depends on closedTime); counted in anchorVsClose',
      groupSync: `negRisk Yes-sum from member quotes at most ${GROUP_SYNC_SEC / 60} min older than the row's point (or up to ${GROUP_STAMP_TOL_SEC} s newer for clob's per-token stamp jitter, never after the decision), else null`,
    },
    marketsRead: 0, marketsUsed: 0, rows: 0, rowsByOffset: {}, rowsByCategory: {}, marketsByCategory: {}, eventsUsed: 0,
    marketDrops: {}, rowDrops: {}, featureNulls: {},
    anchorVsClose: { endMoreThan30dBeforeClose: 0, endMoreThan30dAfterClose: 0, anchorFromEventEndDate: 0 },
    fees: { marketsWithTakerFees: 0, marketsWithoutFees: 0, byFeeType: {} },
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  const ws = fs.createWriteStream(tmp);
  const seen = new Set(), events = new Set(), groupCache = new Map();
  let syntheticMarkets = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(marketsFile), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      summary.marketsRead++;
      let m;
      try { m = validateRecord(JSON.parse(line)); } catch { m = null; }
      if (!m) { bump(summary.marketDrops, 'invalid_record'); continue; }
      if (seen.has(m.conditionId)) { bump(summary.marketDrops, 'duplicate'); continue; }
      seen.add(m.conditionId);
      if (isSyntheticMarket(m)) syntheticMarkets++;
      if (m.anchorTs == null) { bump(summary.marketDrops, 'no_end_date'); continue; }
      if (m.closedTs == null) { bump(summary.marketDrops, 'no_closed_time'); continue; }
      const yesPoints = readPriceFile(dataDir, m.yesTokenId);
      if (!yesPoints || !yesPoints.length) { bump(summary.marketDrops, yesPoints ? 'empty_price_file' : 'no_price_file'); continue; }
      const group = m.negRisk ? loadGroup(dataDir, m.groupFile, groupCache) : null;
      if (m.negRisk && !group) bump(summary.featureNulls, 'group_file_missing');
      const rows = buildGeneralRows(m, yesPoints, group, summary);
      if (!rows.length) { bump(summary.marketDrops, 'no_rows'); continue; }
      summary.marketsUsed++;
      events.add(rows[0].eventKey);
      bump(summary.marketsByCategory, m.category || 'other');
      if (m.anchorSource === 'event.endDate') summary.anchorVsClose.anchorFromEventEndDate++;
      if (m.anchorTs < m.closedTs - 30 * DAY) summary.anchorVsClose.endMoreThan30dBeforeClose++;
      if (m.anchorTs > m.closedTs + 30 * DAY) summary.anchorVsClose.endMoreThan30dAfterClose++;
      if (m.feeRate > 0) summary.fees.marketsWithTakerFees++;
      else summary.fees.marketsWithoutFees++;
      bump(summary.fees.byFeeType, `${m.feeType ?? 'none'}${m.feeRate > 0 ? ` (rate ${m.feeRate}, exp ${m.feeExponent})` : ''}`);
      for (const r of rows) {
        summary.rows++;
        bump(summary.rowsByOffset, offsetLabel(r.offsetH));
        bump(summary.rowsByCategory, r.category);
        if (!ws.write(JSON.stringify(r) + '\n')) await once(ws, 'drain');
      }
    }
    ws.end();
    await once(ws, 'finish');
    fs.renameSync(tmp, out);
  } catch (e) {
    ws.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  summary.eventsUsed = events.size;
  summary.provenance = readProvenance(dataDir, syntheticMarkets);
  const summaryFile = path.join(path.dirname(out), `${path.basename(out, '.jsonl')}.summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n');
  summary.summaryFile = summaryFile;
  return summary;
}

const USAGE = `Usage: node research/general/build-dataset.js [--data-dir research/data-general] [--out <file>]
Builds <data-dir>/dataset.jsonl (+ dataset.summary.json) for research/backtest.js --hypotheses research/general/hypotheses.js.`;

export function optsFromArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') return { help: true };
    const eq = tok.indexOf('=');
    const key = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
    const val = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (!tok.startsWith('--') || val == null) throw new Error(`bad argument "${tok}" (see --help)`);
    if (key === 'data-dir') o.dataDir = val;
    else if (key === 'out') o.out = val;
    else throw new Error(`unknown option --${key}`);
  }
  return o;
}

function printSummary(s) {
  const fmt = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${k}: ${v}`).join('\n') || '    (none)';
  console.log(`dataset: ${s.out}`);
  console.log(`markets read ${s.marketsRead}, used ${s.marketsUsed} in ${s.eventsUsed} events, rows ${s.rows}`);
  console.log(`  rows per decision:\n${fmt(s.rowsByOffset)}`);
  console.log(`  markets per category:\n${fmt(s.marketsByCategory)}`);
  console.log(`  market drops:\n${fmt(s.marketDrops)}`);
  console.log(`  decision drops (per market x decision):\n${fmt(s.rowDrops)}`);
  console.log(`  features nulled (rows kept):\n${fmt(s.featureNulls)}`);
  console.log(`  endDate vs closedTime: ${JSON.stringify(s.anchorVsClose)}`);
  console.log(`  fees: ${s.fees.marketsWithTakerFees} markets with taker fees, ${s.fees.marketsWithoutFees} without`);
  const pv = s.provenance;
  console.log(`  provenance: ${pv.status === 'synthetic' ? 'SYNTHETIC (tooling validation only)' : pv.status} (${pv.collectRuns} collect runs${pv.bases.length ? `; bases ${pv.bases.join(', ')}` : ''})`);
  for (const r of pv.reasons) console.log(`    ${r}`);
  console.log(`summary written to ${s.summaryFile}`);
}

async function main() {
  const o = optsFromArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  const s = await buildGeneralDataset(o);
  printSummary(s);
  if (s.rows === 0) { console.error('ERROR: no dataset rows produced; check the drop reasons above.'); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`general build-dataset: ${e.message}`); process.exitCode = 1; });
}

export { EARLY_OFFSET_H };
