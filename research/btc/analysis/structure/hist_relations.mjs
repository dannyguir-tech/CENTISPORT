#!/usr/bin/env node
// Historical coherence / arbitrage screen across BTC market families.
//
// Every "relation" is a basket of tokens we would BUY as takers whose combined payoff is >= minPay in every state
// of the world (a no-arbitrage bound). A violation = basket cost < minPay. We evaluate it on the CLOB price-history
// snapshots (mid/last, ~1/min in the last 48h of a ladder market's life, ~1/10min before that; ~1/min for Up/Down),
// converting each leg to an executable taker price with a spread haircut + taker fee, and simulate one trade per
// violation episode. No look-ahead: at decision time t only path points with timestamp <= t are used, and the Up/Down
// priceToBeat values used are those fixed at (inner) window start <= t.
//
// Families (see README in the report):
//   above_daily_mono, above_hourly_mono       P(close > K) non-increasing in K                buy YES(K1) + NO(K2), K1<K2
//   hit_{daily,weekly,monthly}_mono           P(hit_up K) non-increasing in K; hit_down mirror buy YES(easier) + NO(harder)
//   range_allyes / range_allno                neg-risk buckets sum to 1                        buy all YES (pays 1) / all NO (pays n-1)
//   above_vs_range                            P(close>K) = sum of buckets >= K                 YES(>K)+YES(buckets<K) ; NO(>K)+YES(buckets>=K)
//   hit_vs_above_{daily,weekly,monthly}       close(noon D) > K' >= K  => hit_up K              YES(hit_up K)+NO(above K'); YES(hit_dn K)+YES(above K'')
//   hit_nest_{wd,md,mw}                       hit in inner period => hit in outer period       YES(outer K)+NO(inner K)
//   daily_ud_vs_above                         Up(1d) <=> close(noon D) >= ptb (same Binance candle) UP + NO(above K_hi>ptb) ; DOWN + YES(above K_lo<ptb)
//   hourly_ud_vs_above_hourly                 Up(1h) <=> close(1h candle) >= open (same candle) UP + NO(above K_hi) ; DOWN + YES(above K_lo)
//   nest_cl_{15m_5m,4h_15m,4h_5m}             Chainlink windows sharing the end E: if ptb_inner >= ptb_outer then Up_inner => Up_outer
//                                             (else Down_inner => Down_outer)                   UP(outer)+DOWN(inner)  or  DOWN(outer)+UP(inner)
//   nest_basis_{1h_15m,1h_5m,1d_4h}[_b100]    same with a Binance outer and Chainlink inner (NOT risk-free: oracle basis)
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown, loadLadders } from '../../lib/load.mjs';
import { askFromMid, feePS, dayKey, writeJSON, writeCSV, REPORT, loadSpreadModel, halfSpread, bandOf, r4 } from './common.mjs';

loadSpreadModel();
const SCEN = ['hc1', 'hs'];
const FMODELS = ['docs_always', 'docs', 'flat2', 'zero'];
const THETAS = [0, 0.005, 0.01, 0.02, 0.04];
const COOLDOWN = 600;
const MAX_GAP = 3; // ladder pairs: strikes at most 3 apart in the ladder
const SPREAD = JSON.parse(fs.readFileSync(path.join(REPORT, 'spread_model.json'), 'utf8'));
const depthShares = (kind, p) => { const k = SPREAD.byKind[kind]; const b = k && (k[bandOf(p)] || k.all); return b ? b.medDepthShares1c : 0; };

// ------------------------------------------------------------------ paths
// merged ladder path: coarse points before the fine window, then fine points. Drops the initial 0.5 placeholder run.
function prepLadderMarket(m) {
  if (m._prep) return m._prep;
  const fine = m.pathFine || [], coarse = m.pathCoarse || [];
  const fineStart = fine.length ? fine[0][0] : Infinity;
  const merged = [...coarse.filter(([t]) => t < fineStart), ...fine];
  let i0 = merged.findIndex(([, p]) => Math.abs(p - 0.5) > 1e-9);
  const valid = i0 >= 0 ? merged[i0][0] : Infinity;
  m._prep = { path: merged, fineStart, validStart: valid };
  return m._prep;
}
function prepUD(r) {
  if (r._prep) return r._prep;
  r._prep = { path: r.path || [], fineStart: r.path && r.path.length ? r.path[0][0] : Infinity, validStart: r.path && r.path.length ? r.path[0][0] : Infinity };
  return r._prep;
}
// cursor accessor: last point with t' <= t (t must be non-decreasing)
function cursor(pathArr) {
  let i = -1;
  return (t, maxStale) => {
    while (i + 1 < pathArr.length && pathArr[i + 1][0] <= t) i++;
    if (i < 0) return null;
    return t - pathArr[i][0] <= maxStale ? pathArr[i][1] : null;
  };
}

// leg: {kind, rec, side: 'Y'|'N', won (bool), prep}
const L = (kind, rec, side, won, prep) => ({ kind, rec, side, won, prep });
const legWon = (l) => (l.side === 'Y' ? l.won : !l.won);

// ------------------------------------------------------------------ evaluation
const trades = [];       // executable-scenario trades (all combos)
const episodes = [];     // raw mid violation episodes (zero cost)
const bestByRel = [];    // per relation: best hs/docs_always margin moment (for print verification)
const famStats = {};

function evalRelation(rel) {
  // rel: {family, id, legs, minPay, tFrom, tTo, bucketKind?}
  const fs_ = famStats[rel.family] ||= { relations: 0, points: 0, pointsMidViol: 0, pointsExecViolHs: 0, pointsExecViolHc1: 0 };
  fs_.relations++;
  const legs = rel.legs;
  const tFrom = Math.max(rel.tFrom, ...legs.map((l) => l.prep.validStart));
  const tTo = rel.tTo;
  if (!(tTo > tFrom)) return;
  const fineStart = Math.max(...legs.map((l) => l.prep.fineStart));
  const curs = legs.map((l) => cursor(l.prep.path));
  const payoff = legs.reduce((s, l) => s + (legWon(l) ? 1 : 0), 0);
  const legDesc = legs.map((l) => ({ kind: l.kind, side: l.side, cid: l.rec.conditionId, yes: l.rec.yesToken || l.rec.upToken, no: l.rec.noToken || l.rec.downToken, won: legWon(l), fee: l.rec.fee ? l.rec.fee.feeType : null }));
  const nC = SCEN.length * FMODELS.length;
  const state = Array.from({ length: nC * THETAS.length }, () => ({ armed: true, last: -Infinity }));
  let ep = null;
  let best = null;
  const step0 = rel.step || 60;
  let t = Math.ceil(tFrom / 60) * 60;
  if (rel.alignTo) t = tFrom; // Up/Down: start exactly at tFrom
  while (t <= tTo) {
    const fine = t >= fineStart;
    const stale = fine ? (rel.stale || 120) : 900;
    const step = fine ? step0 : 600;
    const mids = [];
    let ok = true;
    for (let i = 0; i < legs.length; i++) { const p = curs[i](t, stale); if (p == null) { ok = false; break; } mids.push(legs[i].side === 'Y' ? p : 1 - p); }
    if (ok) {
      fs_.points++;
      const midSum = mids.reduce((s, x) => s + x, 0);
      const vMid = rel.minPay - midSum;
      // raw mid violation episodes
      if (vMid > 1e-9) {
        fs_.pointsMidViol++;
        if (!ep) ep = { family: rel.family, id: rel.id, minPay: rel.minPay, payoff, start: t, end: t, n: 0, v0: r4(vMid), maxV: 0, tMax: t, maxMarginHs: -Infinity, fine, mids0: mids.map(r4), legs: legDesc };
        ep.end = t; ep.n++; if (vMid > ep.maxV) { ep.maxV = r4(vMid); ep.tMax = t; ep.midsMax = mids.map(r4); }
      } else if (ep) { episodes.push(ep); ep = null; }
      let c = 0;
      for (const s of SCEN) for (const fm of FMODELS) {
        let cost = 0, cap = Infinity;
        for (let i = 0; i < legs.length; i++) {
          const a = askFromMid(mids[i], legs[i].kind, s);
          cost += a + feePS(a, legs[i].rec, fm);
          cap = Math.min(cap, depthShares(legs[i].kind, mids[i]));
        }
        const margin = rel.minPay - cost;
        if (s === 'hs' && fm === 'docs_always') {
          if (margin > 0) fs_.pointsExecViolHs++;
          if (ep) ep.maxMarginHs = r4(Math.max(ep.maxMarginHs, margin));
          if (!best || margin > best.margin) best = { margin, t, mids: mids.map(r4), cost };
        }
        if (s === 'hc1' && fm === 'docs_always' && margin > 0) fs_.pointsExecViolHc1++;
        for (let k = 0; k < THETAS.length; k++) {
          const st = state[c * THETAS.length + k];
          if (margin > THETAS[k]) {
            if (st.armed && t - st.last >= COOLDOWN) {
              trades.push({ family: rel.family, id: rel.id, t, day: dayKey(t), s, fm, theta: THETAS[k], cost: r4(cost), payoff, profit: r4(payoff - cost), margin: r4(margin), capShares: Math.round(cap), fine, nLegs: legs.length });
              st.armed = false; st.last = t;
            }
          } else st.armed = true;
        }
        c++;
      }
    } else if (ep) { episodes.push(ep); ep = null; }
    t += step;
  }
  if (ep) episodes.push(ep);
  if (best) bestByRel.push({ family: rel.family, id: rel.id, ...best, minPay: rel.minPay, payoff, legs: legs.map((l) => ({ kind: l.kind, side: l.side, conditionId: l.rec.conditionId, yesToken: l.rec.yesToken || l.rec.upToken, noToken: l.rec.noToken || l.rec.downToken, title: l.rec.slug || l.rec.question })) });
}

// ------------------------------------------------------------------ builders
const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0) + 's', ...a);

function ladderMono(kind, family) {
  for (const e of loadLadders(kind)) {
    const ms = e.markets.filter((m) => m.strike.type === 'above').sort((a, b) => a.strike.k - b.strike.k);
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < Math.min(ms.length, i + 1 + MAX_GAP); j++) {
      const a = ms[i], b = ms[j];
      evalRelation({ family, id: `${e.slug}|${a.strike.k}<${b.strike.k}`, minPay: 1, tFrom: -Infinity, tTo: Math.min(a.effEndTs, b.effEndTs) - 60,
        legs: [L(kind, a, 'Y', a.yesWon, prepLadderMarket(a)), L(kind, b, 'N', b.yesWon, prepLadderMarket(b))] });
    }
  }
}
function hitMono(kind) {
  for (const e of loadLadders(kind)) {
    const up = e.markets.filter((m) => m.strike.type === 'hit_up').sort((a, b) => a.strike.k - b.strike.k);
    const dn = e.markets.filter((m) => m.strike.type === 'hit_down').sort((a, b) => b.strike.k - a.strike.k);
    for (const [ms, tag] of [[up, 'up'], [dn, 'dn']]) for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < Math.min(ms.length, i + 1 + MAX_GAP); j++) {
      const a = ms[i], b = ms[j];
      evalRelation({ family: `${kind}_mono`, id: `${e.slug}|${tag}|${a.strike.k}/${b.strike.k}`, minPay: 1, tFrom: -Infinity, tTo: Math.min(a.effEndTs, b.effEndTs) - 60,
        legs: [L(kind, a, 'Y', a.yesWon, prepLadderMarket(a)), L(kind, b, 'N', b.yesWon, prepLadderMarket(b))] });
    }
  }
}
function bucketsOf(e) {
  const bs = e.markets.filter((m) => ['below', 'between', 'above_bucket'].includes(m.strike.type));
  const lo = (m) => (m.strike.type === 'below' ? -Infinity : m.strike.lo), hi = (m) => (m.strike.type === 'above_bucket' ? Infinity : m.strike.hi);
  bs.sort((a, b) => lo(a) - lo(b));
  let okc = bs.length >= 3 && lo(bs[0]) === -Infinity && hi(bs[bs.length - 1]) === Infinity;
  for (let i = 1; i < bs.length && okc; i++) if (lo(bs[i]) !== hi(bs[i - 1])) okc = false;
  return okc ? bs.map((m) => ({ m, lo: lo(m), hi: hi(m) })) : null;
}
function rangeSum() {
  let bad = 0;
  for (const e of loadLadders('range_daily')) {
    const bs = bucketsOf(e);
    if (!bs) { bad++; continue; }
    const tTo = e.endTs - 60;
    evalRelation({ family: 'range_allyes', id: e.slug, minPay: 1, tFrom: -Infinity, tTo, legs: bs.map(({ m }) => L('range_daily', m, 'Y', m.yesWon, prepLadderMarket(m))) });
    evalRelation({ family: 'range_allno', id: e.slug, minPay: bs.length - 1, tFrom: -Infinity, tTo, legs: bs.map(({ m }) => L('range_daily', m, 'N', m.yesWon, prepLadderMarket(m))) });
  }
  if (bad) log('range events with non-contiguous buckets skipped:', bad);
}
function aboveVsRange() {
  const rByEnd = new Map(loadLadders('range_daily').map((e) => [e.endTs, e]));
  for (const e of loadLadders('above_daily')) {
    const r = rByEnd.get(e.endTs); if (!r) continue;
    const bs = bucketsOf(r); if (!bs) continue;
    for (const a of e.markets.filter((m) => m.strike.type === 'above')) {
      const K = a.strike.k;
      const below = bs.filter((b) => b.hi <= K), above = bs.filter((b) => b.lo >= K);
      if (below.length + above.length !== bs.length) continue; // K not a bucket boundary
      const tTo = e.endTs - 60;
      evalRelation({ family: 'above_vs_range', id: `${e.slug}|lo|${K}`, minPay: 1, tFrom: -Infinity, tTo,
        legs: [L('above_daily', a, 'Y', a.yesWon, prepLadderMarket(a)), ...below.map(({ m }) => L('range_daily', m, 'Y', m.yesWon, prepLadderMarket(m)))] });
      evalRelation({ family: 'above_vs_range', id: `${e.slug}|hi|${K}`, minPay: 1, tFrom: -Infinity, tTo,
        legs: [L('above_daily', a, 'N', a.yesWon, prepLadderMarket(a)), ...above.map(({ m }) => L('range_daily', m, 'Y', m.yesWon, prepLadderMarket(m)))] });
    }
  }
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function hitCoverage(e) {
  if (e.kind === 'hit_daily') return [e.endTs - 86400, e.endTs];
  if (e.kind === 'hit_weekly') return [e.endTs - 7 * 86400, e.endTs];
  // monthly: first day of the month named in the slug, 00:00 ET ~ end - daysInMonth*86400
  const m = /in-([a-z]+)-(\d{4})/.exec(e.slug);
  if (m) { const mi = MONTHS.indexOf(m[1]); const y = Number(m[2]); const days = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate(); return [e.endTs - days * 86400, e.endTs]; }
  return null; // e.g. "before-2027" style events are skipped
}
function hitVsAbove(hkind) {
  const hits = loadLadders(hkind).map((e) => ({ e, cov: hitCoverage(e) })).filter((x) => x.cov);
  for (const a of loadLadders('above_daily')) {
    const noon = a.endTs;
    const aboves = a.markets.filter((m) => m.strike.type === 'above').sort((x, y) => x.strike.k - y.strike.k);
    if (!aboves.length) continue;
    for (const { e: h, cov } of hits) {
      if (!(cov[0] <= noon - 3600 && noon <= cov[1])) continue;
      for (const m of h.markets) {
        let am = null, side;
        if (m.strike.type === 'hit_up') { am = aboves.find((x) => x.strike.k >= m.strike.k); side = 'N'; }
        else if (m.strike.type === 'hit_down') { am = [...aboves].reverse().find((x) => x.strike.k <= m.strike.k); side = 'Y'; }
        if (!am) continue;
        evalRelation({ family: `hit_vs_above_${hkind.slice(4)}`, id: `${h.slug}|${m.strike.type}${m.strike.k}|${a.slug}|${am.strike.k}`, minPay: 1, tFrom: -Infinity,
          tTo: Math.min(noon, m.effEndTs, am.effEndTs) - 60,
          legs: [L(hkind, m, 'Y', m.yesWon, prepLadderMarket(m)), L('above_daily', am, side, am.yesWon, prepLadderMarket(am))] });
      }
    }
  }
}
function hitNest(outerKind, innerKind, family) {
  const outers = loadLadders(outerKind).map((e) => ({ e, cov: hitCoverage(e) })).filter((x) => x.cov);
  const inners = loadLadders(innerKind).map((e) => ({ e, cov: hitCoverage(e) })).filter((x) => x.cov);
  for (const { e: o, cov: co } of outers) for (const { e: i, cov: ci } of inners) {
    if (!(co[0] <= ci[0] + 3600 && ci[1] <= co[1] + 3600)) continue; // inner period inside outer period (1h DST slack)
    for (const om of o.markets) {
      let im = null;
      if (om.strike.type === 'hit_up') im = i.markets.filter((x) => x.strike.type === 'hit_up' && x.strike.k >= om.strike.k).sort((x, y) => x.strike.k - y.strike.k)[0];
      else if (om.strike.type === 'hit_down') im = i.markets.filter((x) => x.strike.type === 'hit_down' && x.strike.k <= om.strike.k).sort((x, y) => y.strike.k - x.strike.k)[0];
      if (!im) continue;
      evalRelation({ family, id: `${o.slug}|${om.strike.type}${om.strike.k}|${i.slug}|${im.strike.k}`, minPay: 1, tFrom: -Infinity, tTo: Math.min(om.effEndTs, im.effEndTs) - 60,
        legs: [L(outerKind, om, 'Y', om.yesWon, prepLadderMarket(om)), L(innerKind, im, 'N', im.yesWon, prepLadderMarket(im))] });
    }
  }
}
function udVsAbove(tf, ladderKind, family) {
  const lad = new Map(loadLadders(ladderKind).map((e) => [e.endTs, e]));
  const kind = `updown_${tf}`;
  for (const u of loadUpDown(tf)) {
    if (u.priceToBeat == null) continue;
    const e = lad.get(u.windowEnd); if (!e) continue;
    const ks = e.markets.filter((m) => m.strike.type === 'above').sort((a, b) => a.strike.k - b.strike.k);
    const hi = ks.find((m) => m.strike.k > u.priceToBeat), lo = [...ks].reverse().find((m) => m.strike.k < u.priceToBeat);
    const tFrom = u.windowStart + 60, tTo = u.windowEnd - 60;
    const pu = prepUD(u);
    if (hi) evalRelation({ family, id: `${u.slug}|UP+NO>${hi.strike.k}`, minPay: 1, tFrom, tTo, legs: [L(kind, u, 'Y', u.upWon, pu), L(ladderKind, hi, 'N', hi.yesWon, prepLadderMarket(hi))] });
    if (lo) evalRelation({ family, id: `${u.slug}|DOWN+YES>${lo.strike.k}`, minPay: 1, tFrom, tTo, legs: [L(kind, u, 'N', u.upWon, pu), L(ladderKind, lo, 'Y', lo.yesWon, prepLadderMarket(lo))] });
  }
}
function nested(outerTf, innerTf, family, { buffer = 0 } = {}) {
  const inner = new Map(loadUpDown(innerTf).map((r) => [r.windowEnd, r]));
  for (const o of loadUpDown(outerTf)) {
    if (o.priceToBeat == null) continue;
    const i = inner.get(o.windowEnd);
    if (!i || i.priceToBeat == null || !(i.windowStart > o.windowStart)) continue;
    const d = i.priceToBeat - o.priceToBeat;
    if (Math.abs(d) < buffer) continue;
    const po = prepUD(o), pi = prepUD(i);
    const legs = d >= 0 ? [L(`updown_${outerTf}`, o, 'Y', o.upWon, po), L(`updown_${innerTf}`, i, 'N', i.upWon, pi)]
                        : [L(`updown_${outerTf}`, o, 'N', o.upWon, po), L(`updown_${innerTf}`, i, 'Y', i.upWon, pi)];
    evalRelation({ family, id: `${o.slug}|${i.slug}|d=${d.toFixed(2)}`, minPay: 1, tFrom: i.windowStart + 30, tTo: o.windowEnd - 30, legs, stale: 60, alignTo: true });
  }
}

// ------------------------------------------------------------------ run
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = (f) => !only.length || only.some((o) => f.startsWith(o));
const JOBS = [
  ['above_daily_mono', () => ladderMono('above_daily', 'above_daily_mono')],
  ['above_hourly_mono', () => ladderMono('above_hourly', 'above_hourly_mono')],
  ['hit_daily_mono', () => hitMono('hit_daily')],
  ['hit_weekly_mono', () => hitMono('hit_weekly')],
  ['hit_monthly_mono', () => hitMono('hit_monthly')],
  ['range_sum', () => rangeSum()],
  ['above_vs_range', () => aboveVsRange()],
  ['hit_vs_above_daily', () => hitVsAbove('hit_daily')],
  ['hit_vs_above_weekly', () => hitVsAbove('hit_weekly')],
  ['hit_vs_above_monthly', () => hitVsAbove('hit_monthly')],
  ['hit_nest_wd', () => hitNest('hit_weekly', 'hit_daily', 'hit_nest_wd')],
  ['hit_nest_md', () => hitNest('hit_monthly', 'hit_daily', 'hit_nest_md')],
  ['hit_nest_mw', () => hitNest('hit_monthly', 'hit_weekly', 'hit_nest_mw')],
  ['daily_ud_vs_above', () => udVsAbove('1d', 'above_daily', 'daily_ud_vs_above')],
  ['hourly_ud_vs_above_hourly', () => udVsAbove('1h', 'above_hourly', 'hourly_ud_vs_above_hourly')],
  ['nest_cl_15m_5m', () => nested('15m', '5m', 'nest_cl_15m_5m')],
  ['nest_cl_4h_15m', () => nested('4h', '15m', 'nest_cl_4h_15m')],
  ['nest_cl_4h_5m', () => nested('4h', '5m', 'nest_cl_4h_5m')],
  ['nest_basis_1h_15m', () => nested('1h', '15m', 'nest_basis_1h_15m')],
  ['nest_basis_1h_5m', () => nested('1h', '5m', 'nest_basis_1h_5m')],
  ['nest_basis_1d_4h', () => nested('1d', '4h', 'nest_basis_1d_4h')],
  ['nest_basis_1h_15m_b100', () => nested('1h', '15m', 'nest_basis_1h_15m_b100', { buffer: 100 })],
  ['nest_basis_1h_5m_b100', () => nested('1h', '5m', 'nest_basis_1h_5m_b100', { buffer: 100 })],
  ['nest_basis_1d_4h_b100', () => nested('1d', '4h', 'nest_basis_1d_4h_b100', { buffer: 100 })],
];
for (const [name, fn] of JOBS) { if (!want(name)) continue; const n0 = trades.length; fn(); log(name, 'done; trades so far', trades.length, '(+' + (trades.length - n0) + ')'); }

const outDir = path.join(REPORT, 'hist');
fs.mkdirSync(outDir, { recursive: true });
const suffix = only.length ? '_' + only.join('+') : '';
function writeLines(file, rows) { const fd = fs.openSync(file, 'w'); let buf = []; for (const r of rows) { buf.push(JSON.stringify(r)); if (buf.length >= 5000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; } } if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n'); fs.closeSync(fd); }
writeLines(path.join(outDir, `trades${suffix}.jsonl`), trades);
// episodes: keep full detail (legs, mids) only for those that were executable on the mid+half-spread screen; summarise the rest
writeLines(path.join(outDir, `episodes_exec${suffix}.jsonl`), episodes.filter((e) => e.maxMarginHs > 0));
{
  const q = (a, f) => (a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : null);
  const by = {};
  for (const e of episodes) { const o = by[e.family] ||= { n: 0, fine: 0, execHs: 0, dur: [], maxV: [] }; o.n++; if (e.fine) o.fine++; if (e.maxMarginHs > 0) o.execHs++; o.dur.push(e.end - e.start + (e.fine ? 60 : 600)); o.maxV.push(e.maxV); }
  const sum = {};
  for (const [f, o] of Object.entries(by)) { o.dur.sort((a, b) => a - b); o.maxV.sort((a, b) => a - b);
    sum[f] = { episodes: o.n, fineEpisodes: o.fine, execOnMidPlusHalfSpread: o.execHs, durSec: { p50: q(o.dur, 0.5), p90: q(o.dur, 0.9), p99: q(o.dur, 0.99) }, maxViolation: { p50: q(o.maxV, 0.5), p90: q(o.maxV, 0.9), p99: q(o.maxV, 0.99) } }; }
  writeJSON(`hist/episode_summary${suffix}.json`, sum);
}
bestByRel.sort((a, b) => b.margin - a.margin);
writeLines(path.join(outDir, `best_by_relation${suffix}.jsonl`), bestByRel);
writeJSON(`hist/family_stats${suffix}.json`, famStats);
log('wrote', trades.length, 'trades,', episodes.length, 'episodes,', bestByRel.length, 'relations');
