#!/usr/bin/env node
// Live coherence scan on real order books (executable prices, full depth).
// Inputs: the collector snapshots data/live/snapshot_*.json and this analysis' polls data/live_structure/poll_*.json.gz.
// For every snapshot and every relation instance we BUY each leg at the visible asks (taker), add the verified
// taker fee 0.07 p (1-p) per share at each fill price, and report baskets whose cost is below the guaranteed payoff,
// with the max-profit size from walking the books. Also near-miss statistics (how far from an arb each family sits).
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../../lib/util.mjs';
import { REPORT, readGz, r4, writeCSV, writeJSON } from './common.mjs';

const fee = (p) => 0.07 * p * (1 - p);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function hitCoverage(kind, slug, endTs) {
  if (kind === 'hit_daily') return [endTs - 86400, endTs];
  if (kind === 'hit_weekly') return [endTs - 7 * 86400, endTs];
  const m = /in-([a-z]+)-(\d{4})/.exec(slug);
  if (m) { const mi = MONTHS.indexOf(m[1]); const y = Number(m[2]); const days = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate(); return [endTs - days * 86400, endTs]; }
  return null;
}

// ------------------------------------------------------------------ load + normalise snapshots
function fromCollector(s) {
  const books = {};
  const events = s.events.map((e) => ({ ...e, markets: e.markets.filter((m) => !m.closed || e.kind.startsWith('updown')).map((m) => {
    for (const t of m.tokens || []) if (t.book) books[t.tokenId] = { bids: t.book.bids || [], asks: t.book.asks || [] };
    return { conditionId: m.conditionId, outcomes: m.outcomes, tokenIds: m.tokenIds, strike: m.strike, closed: m.closed, title: m.title };
  }) }));
  return { fetchedTs: s.booksFetchedTs || s.fetchedTs, events, books, recentClosed: null, source: 'collector' };
}
const ptbFillFile = path.join(DATA, 'live_structure', 'ptb.json');
const PTB_FILL = fs.existsSync(ptbFillFile) ? JSON.parse(fs.readFileSync(ptbFillFile, 'utf8')) : {};
const snaps = [];
for (const f of fs.readdirSync(path.join(DATA, 'live')).filter((x) => x.startsWith('snapshot_')).sort()) snaps.push(fromCollector(JSON.parse(fs.readFileSync(path.join(DATA, 'live', f), 'utf8'))));
const pdir = path.join(DATA, 'live_structure');
for (const f of (fs.existsSync(pdir) ? fs.readdirSync(pdir) : []).filter((x) => x.startsWith('poll_')).sort()) { const s = readGz(path.join(pdir, f)); s.source = 'poll'; snaps.push(s); }
console.log('snapshots', snaps.length, snaps.filter((s) => s.source === 'poll').length, 'polls');

// ------------------------------------------------------------------ basket economics on books
function basket(legs, books, minPay) {
  const L = legs.map((l) => (books[l.token] && books[l.token].asks ? books[l.token].asks : []));
  if (L.some((a) => !a.length)) return null;
  const best = L.reduce((s, a) => s + a[0][0] + fee(a[0][0]), 0);
  // maker-legged variant: rest a bid on one leg at its best bid (maker: no fee), take the other legs at their asks.
  // Only meaningful conditional on getting filled (fill probability / adverse selection unobservable here).
  let makerCost = Infinity;
  for (let i = 0; i < legs.length; i++) {
    const bb = books[legs[i].token] && books[legs[i].token].bids && books[legs[i].token].bids[0];
    if (!bb) continue;
    const c = bb[0] + L.reduce((s, a, j) => (j === i ? s : s + a[0][0] + fee(a[0][0])), 0);
    makerCost = Math.min(makerCost, c);
  }
  const res = { bestCost: r4(best), margin: r4(minPay - best), makerMargin: Number.isFinite(makerCost) ? r4(minPay - makerCost) : null, shares: 0, profit: 0, usd: 0 };
  if (minPay - best <= 0) return res;
  const idx = L.map(() => 0), rem = L.map((a) => a[0][1]);
  for (let guard = 0; guard < 500; guard++) {
    const marg = L.reduce((s, a, i) => s + a[idx[i]][0] + fee(a[idx[i]][0]), 0);
    if (marg >= minPay) break;
    const q = Math.min(...rem);
    res.shares += q; res.profit += q * (minPay - marg); res.usd += q * marg;
    let end = false;
    for (let i = 0; i < L.length; i++) { rem[i] -= q; if (rem[i] <= 1e-9) { idx[i]++; if (idx[i] >= L[i].length) end = true; else rem[i] = L[i][idx[i]][1]; } }
    if (end) break;
  }
  res.shares = r4(res.shares); res.profit = r4(res.profit); res.usd = r4(res.usd);
  return res;
}

// ------------------------------------------------------------------ relation builders on a snapshot
function relations(s) {
  const T = s.fetchedTs;
  const ev = (k) => s.events.filter((e) => e.kind === k);
  const rels = [];
  const tok = (m, side) => (side === 'Y' ? m.tokenIds[0] : m.tokenIds[1]); // outcomes[0] = Yes / Up
  const add = (family, id, legs, minPay, extra = {}) => rels.push({ family, id, legs, minPay, ...extra });
  const above = (e) => e.markets.filter((m) => m.strike && m.strike.type === 'above').sort((a, b) => a.strike.k - b.strike.k);
  // ladders monotone
  for (const [k, fam] of [['above_daily', 'above_daily_mono'], ['above_hourly', 'above_hourly_mono']]) for (const e of ev(k)) {
    const ms = above(e);
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) add(fam, `${e.slug}|${ms[i].strike.k}<${ms[j].strike.k}`, [{ token: tok(ms[i], 'Y') }, { token: tok(ms[j], 'N') }], 1);
  }
  for (const k of ['hit_daily', 'hit_weekly', 'hit_monthly']) for (const e of ev(k)) {
    const up = e.markets.filter((m) => m.strike && m.strike.type === 'hit_up').sort((a, b) => a.strike.k - b.strike.k);
    const dn = e.markets.filter((m) => m.strike && m.strike.type === 'hit_down').sort((a, b) => b.strike.k - a.strike.k);
    for (const ms of [up, dn]) for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) add(`${k}_mono`, `${e.slug}|${ms[i].strike.type}${ms[i].strike.k}/${ms[j].strike.k}`, [{ token: tok(ms[i], 'Y') }, { token: tok(ms[j], 'N') }], 1);
  }
  // buckets
  const rangeBuckets = (e) => {
    const bs = e.markets.filter((m) => m.strike && ['below', 'between', 'above_bucket'].includes(m.strike.type)).map((m) => ({ m, lo: m.strike.type === 'below' ? -Infinity : m.strike.lo, hi: m.strike.type === 'above_bucket' ? Infinity : m.strike.hi })).sort((a, b) => a.lo - b.lo);
    if (bs.length < 3 || bs[0].lo !== -Infinity || bs[bs.length - 1].hi !== Infinity) return null;
    for (let i = 1; i < bs.length; i++) if (bs[i].lo !== bs[i - 1].hi) return null;
    return bs;
  };
  for (const e of ev('range_daily')) {
    const bs = rangeBuckets(e); if (!bs) continue;
    add('range_allyes', e.slug, bs.map((b) => ({ token: tok(b.m, 'Y') })), 1);
    add('range_allno', e.slug, bs.map((b) => ({ token: tok(b.m, 'N') })), bs.length - 1);
    const a = ev('above_daily').find((x) => x.endTs === e.endTs);
    if (a) for (const am of above(a)) {
      const K = am.strike.k; const lo = bs.filter((b) => b.hi <= K), hi = bs.filter((b) => b.lo >= K);
      if (lo.length + hi.length !== bs.length) continue;
      add('above_vs_range', `${a.slug}|lo|${K}`, [{ token: tok(am, 'Y') }, ...lo.map((b) => ({ token: tok(b.m, 'Y') }))], 1);
      add('above_vs_range', `${a.slug}|hi|${K}`, [{ token: tok(am, 'N') }, ...hi.map((b) => ({ token: tok(b.m, 'Y') }))], 1);
    }
  }
  // hit vs above, hit nesting
  const hits = ['hit_daily', 'hit_weekly', 'hit_monthly'].flatMap((k) => ev(k).map((e) => ({ e, k, cov: hitCoverage(k, e.slug, e.endTs) }))).filter((x) => x.cov);
  for (const a of ev('above_daily')) {
    const noon = a.endTs, ks = above(a);
    for (const { e: h, k, cov } of hits) {
      if (!(cov[0] <= noon - 3600 && noon <= cov[1])) continue;
      for (const m of h.markets) {
        if (!m.strike) continue;
        if (m.strike.type === 'hit_up') { const am = ks.find((x) => x.strike.k >= m.strike.k); if (am) add(`hit_vs_above_${k.slice(4)}`, `${h.slug}|up${m.strike.k}|${a.slug}|${am.strike.k}`, [{ token: tok(m, 'Y') }, { token: tok(am, 'N') }], 1); }
        if (m.strike.type === 'hit_down') { const am = [...ks].reverse().find((x) => x.strike.k <= m.strike.k); if (am) add(`hit_vs_above_${k.slice(4)}`, `${h.slug}|dn${m.strike.k}|${a.slug}|${am.strike.k}`, [{ token: tok(m, 'Y') }, { token: tok(am, 'Y') }], 1); }
      }
    }
  }
  for (const o of hits) for (const i of hits) {
    if (o === i) continue;
    const fam = o.k === 'hit_weekly' && i.k === 'hit_daily' ? 'hit_nest_wd' : o.k === 'hit_monthly' && i.k === 'hit_daily' ? 'hit_nest_md' : o.k === 'hit_monthly' && i.k === 'hit_weekly' ? 'hit_nest_mw' : null;
    if (!fam || !(o.cov[0] <= i.cov[0] + 3600 && i.cov[1] <= o.cov[1] + 3600)) continue;
    for (const om of o.e.markets) {
      if (!om.strike) continue;
      let im = null;
      if (om.strike.type === 'hit_up') im = i.e.markets.filter((x) => x.strike && x.strike.type === 'hit_up' && x.strike.k >= om.strike.k).sort((a, b) => a.strike.k - b.strike.k)[0];
      if (om.strike.type === 'hit_down') im = i.e.markets.filter((x) => x.strike && x.strike.type === 'hit_down' && x.strike.k <= om.strike.k).sort((a, b) => b.strike.k - a.strike.k)[0];
      if (im) add(fam, `${o.e.slug}|${om.strike.type}${om.strike.k}|${i.e.slug}|${im.strike.k}`, [{ token: tok(om, 'Y') }, { token: tok(im, 'N') }], 1);
    }
  }
  // Up/Down in play
  const inplay = (k) => ev(k).filter((e) => e.windowStart && e.windowStart <= T && T < e.endTs);
  const closedFinal = new Map();
  if (s.recentClosed) for (const arr of Object.values(s.recentClosed)) for (const c of arr) if (c.eventMetadata && c.eventMetadata.finalPrice != null) closedFinal.set(c.endTs, c.eventMetadata.finalPrice);
  const ptbOf = (e) => (e.eventMetadata && e.eventMetadata.priceToBeat != null ? e.eventMetadata.priceToBeat : (PTB_FILL[e.slug] ?? closedFinal.get(e.windowStart) ?? null));
  for (const [udK, ladK, fam] of [['updown_1d', 'above_daily', 'daily_ud_vs_above'], ['updown_1h', 'above_hourly', 'hourly_ud_vs_above_hourly']]) for (const u of inplay(udK)) {
    const ptb = ptbOf(u); if (ptb == null) continue;
    const a = ev(ladK).find((x) => x.endTs === u.endTs); if (!a) continue;
    const ks = above(a), um = u.markets[0];
    const hi = ks.find((m) => m.strike.k > ptb), lo = [...ks].reverse().find((m) => m.strike.k < ptb);
    if (hi) add(fam, `${u.slug}|UP+NO>${hi.strike.k}`, [{ token: tok(um, 'Y') }, { token: tok(hi, 'N') }], 1, { ptb });
    if (lo) add(fam, `${u.slug}|DOWN+YES>${lo.strike.k}`, [{ token: tok(um, 'N') }, { token: tok(lo, 'Y') }], 1, { ptb });
  }
  for (const [oK, iK, fam] of [['updown_15m', 'updown_5m', 'nest_cl_15m_5m'], ['updown_4h', 'updown_15m', 'nest_cl_4h_15m'], ['updown_4h', 'updown_5m', 'nest_cl_4h_5m'], ['updown_1h', 'updown_15m', 'nest_basis_1h_15m'], ['updown_1h', 'updown_5m', 'nest_basis_1h_5m']]) {
    for (const o of inplay(oK)) {
      const i = inplay(iK).find((x) => x.endTs === o.endTs && x.windowStart > o.windowStart); if (!i) continue;
      const po = ptbOf(o), pi = ptbOf(i); if (po == null || pi == null) continue;
      const om = o.markets[0], im = i.markets[0];
      const legs = pi >= po ? [{ token: tok(om, 'Y') }, { token: tok(im, 'N') }] : [{ token: tok(om, 'N') }, { token: tok(im, 'Y') }];
      add(fam, `${o.slug}|${i.slug}|d=${(pi - po).toFixed(2)}`, legs, 1, { d: pi - po });
    }
  }
  return rels;
}

// ------------------------------------------------------------------ run
const viol = [], fam = {}, persist = new Map();
let tMin = Infinity, tMax = -Infinity;
for (const s of snaps) {
  tMin = Math.min(tMin, s.fetchedTs); tMax = Math.max(tMax, s.fetchedTs);
  for (const r of relations(s)) {
    const b = basket(r.legs, s.books, r.minPay);
    const o = fam[r.family] ||= { evaluated: 0, priced: 0, margins: [], violSnapInstances: 0, instances: new Set(), violInstances: new Set(), maxMargin: -Infinity, maxProfit: 0 };
    o.evaluated++; o.instances.add(r.id);
    if (!b) continue;
    o.priced++; o.margins.push(b.margin);
    if (b.makerMargin != null) { (o.makerMargins ||= []).push(b.makerMargin); if (b.makerMargin > 0) { o.makerPos = (o.makerPos || 0) + 1; (o.makerPosInst ||= new Set()).add(r.id); } }
    o.maxMargin = Math.max(o.maxMargin, b.margin);
    if (b.margin > 0) {
      o.violSnapInstances++; o.violInstances.add(r.id); o.maxProfit = Math.max(o.maxProfit, b.profit);
      viol.push({ ts: s.fetchedTs, iso: new Date(s.fetchedTs * 1000).toISOString(), source: s.source, family: r.family, id: r.id, legs: r.legs.length, minPay: r.minPay, bestCost: b.bestCost, margin: b.margin, shares: b.shares, profitUsd: b.profit, costUsd: b.usd, d: r.d ?? null, ptb: r.ptb ?? null });
      const p = persist.get(r.id) || { family: r.family, first: s.fetchedTs, last: s.fetchedTs, n: 0, maxProfit: 0, firstProfit: b.profit };
      p.last = s.fetchedTs; p.n++; p.maxProfit = Math.max(p.maxProfit, b.profit); persist.set(r.id, p);
    }
  }
}
const q = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return r4(s[Math.min(s.length - 1, Math.floor(f * s.length))]); };
const hours = (tMax - tMin) / 3600;
const summary = { snapshots: snaps.length, polls: snaps.filter((s) => s.source === 'poll').length, from: new Date(tMin * 1000).toISOString(), to: new Date(tMax * 1000).toISOString(), hours: r4(hours), families: {} };
for (const [f, o] of Object.entries(fam)) {
  const eps = [...persist.values()].filter((p) => p.family === f);
  summary.families[f] = {
    instances: o.instances.size, snapshotEvaluations: o.evaluated, priced: o.priced, violatingSnapshotInstances: o.violSnapInstances, violatingInstances: o.violInstances.size,
    maxMargin: r4(o.maxMargin), marginQuantiles: { p50: q(o.margins, 0.5), p90: q(o.margins, 0.9), p99: q(o.margins, 0.99), max: q(o.margins, 1) },
    maxProfitUsd: r4(o.maxProfit), episodeFirstProfitUsdSum: r4(eps.reduce((s, p) => s + p.firstProfit, 0)), episodeMaxProfitUsdSum: r4(eps.reduce((s, p) => s + p.maxProfit, 0)),
    medianEpisodeSnapshots: eps.length ? q(eps.map((p) => p.n), 0.5) : null,
    usdPerDayUpperBound: hours > 0 ? r4(eps.reduce((s, p) => s + p.maxProfit, 0) / hours * 24) : null,
    makerLegged: { snapshotInstancesPositive: o.makerPos || 0, instancesPositive: o.makerPosInst ? o.makerPosInst.size : 0, marginQuantiles: o.makerMargins ? { p50: q(o.makerMargins, 0.5), p90: q(o.makerMargins, 0.9), p99: q(o.makerMargins, 0.99), max: q(o.makerMargins, 1) } : null },
  };
}
fs.mkdirSync(path.join(REPORT, 'live'), { recursive: true });
writeJSON('live/live_summary.json', summary);
writeCSV('live/live_violations.csv', viol);
// latest snapshot: current executable violations
const latest = Math.max(...snaps.map((s) => s.fetchedTs));
const cur = viol.filter((v) => v.ts === latest);
writeCSV('live/current_violations.csv', cur);
console.log(JSON.stringify(summary, null, 1));
console.log('violations in latest snapshot', new Date(latest * 1000).toISOString(), cur.length);
for (const v of cur.sort((a, b) => b.profitUsd - a.profitUsd).slice(0, 20)) console.log(v.family, v.id, 'cost', v.bestCost, 'margin', v.margin, 'shares', v.shares, 'profit$', v.profitUsd);
