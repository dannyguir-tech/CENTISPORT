#!/usr/bin/env node
// Live coherence scan on real order books (executable prices, full depth).
// Inputs: the collector snapshots data/live/snapshot_*.json and this analysis' polls data/live_structure/poll_*.json.gz.
// For every snapshot and every relation instance we BUY each leg at the visible asks (taker), add the verified
// taker fee 0.07 p (1-p) per share at each fill price, and report baskets whose cost is below the guaranteed payoff,
// with the max-profit size from walking the books. Also near-miss statistics (how far from an arb each family sits).
// Reported overall and per polling session (sessions = runs of snapshots < 30 min apart).
// Output: reports/structure/live/{live_summary.json, live_violations.csv, current_violations.csv}
import fs from 'node:fs';
import path from 'node:path';
import { REPORT, r4, writeCSV, writeJSON } from './common.mjs';
import { listSnapshots, loadSnapshot, loadPtbFill, basket, relations } from './live_lib.mjs';

const PTB_FILL = loadPtbFill();
const stubs = listSnapshots();
console.log('snapshots', stubs.length, 'polls', stubs.filter((s) => s.source === 'poll').length, 'sessions', new Set(stubs.map((s) => s.session)).size);

const q = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return r4(s[Math.min(s.length - 1, Math.floor(f * s.length))]); };
const viol = [];
const scopes = {}; // 'all' | 'session<k>' -> {tMin,tMax,n, fam:{}}
const persist = {}; // scope -> Map(id -> episode)
function scopeOf(key) { return (scopes[key] ||= { tMin: Infinity, tMax: -Infinity, n: 0, fam: {} }); }

const sessStart = new Map(); for (const st of stubs) if (!sessStart.has(st.session) || st.fetchedTs < sessStart.get(st.session)) sessStart.set(st.session, st.fetchedTs);
const sessKey = (k) => `session${k}@${new Date(sessStart.get(k) * 1000).toISOString().slice(0, 16)}Z`;
for (const stub of stubs) {
  const s = loadSnapshot(stub);
  const keys = ['all', sessKey(s.session)];
  for (const k of keys) { const sc = scopeOf(k); sc.n++; sc.tMin = Math.min(sc.tMin, s.fetchedTs); sc.tMax = Math.max(sc.tMax, s.fetchedTs); }
  for (const r of relations(s, PTB_FILL)) {
    const b = basket(r.legs, s.books, r.minPay);
    for (const k of keys) {
      const o = scopeOf(k).fam[r.family] ||= { evaluated: 0, priced: 0, margins: [], makerMargins: [], makerPos: 0, makerPosInst: new Set(), violSnapInstances: 0, instances: new Set(), violInstances: new Set(), maxMargin: -Infinity, maxProfit: 0 };
      o.evaluated++; o.instances.add(r.id);
      if (!b) continue;
      o.priced++; o.margins.push(b.margin);
      if (b.makerMargin != null) { o.makerMargins.push(b.makerMargin); if (b.makerMargin > 0) { o.makerPos++; o.makerPosInst.add(r.id); } }
      o.maxMargin = Math.max(o.maxMargin, b.margin);
      if (b.margin > 0) {
        o.violSnapInstances++; o.violInstances.add(r.id); o.maxProfit = Math.max(o.maxProfit, b.profit);
        const P = (persist[k] ||= new Map());
        const p = P.get(r.id) || { family: r.family, first: s.fetchedTs, last: s.fetchedTs, n: 0, maxProfit: 0, firstProfit: b.profit };
        p.last = s.fetchedTs; p.n++; p.maxProfit = Math.max(p.maxProfit, b.profit); P.set(r.id, p);
      }
    }
    if (b && b.margin > 0) viol.push({ ts: s.fetchedTs, iso: new Date(s.fetchedTs * 1000).toISOString(), session: s.session, source: s.source, family: r.family, id: r.id, legs: r.legs.length, minPay: r.minPay, bestCost: b.bestCost, margin: b.margin, shares: b.shares, profitUsd: b.profit, costUsd: b.usd, d: r.d ?? null, ptb: r.ptb ?? null, riskFree: r.family.startsWith('nest_basis') ? false : true });
  }
}

const summary = { snapshots: stubs.length, polls: stubs.filter((s) => s.source === 'poll').length, scopes: {} };
for (const [k, sc] of Object.entries(scopes)) {
  const hours = (sc.tMax - sc.tMin) / 3600;
  const out = summary.scopes[k] = { snapshots: sc.n, from: new Date(sc.tMin * 1000).toISOString(), to: new Date(sc.tMax * 1000).toISOString(), hours: r4(hours), families: {} };
  const P = persist[k] || new Map();
  for (const [f, o] of Object.entries(sc.fam)) {
    const eps = [...P.values()].filter((p) => p.family === f);
    out.families[f] = {
      instances: o.instances.size, snapshotEvaluations: o.evaluated, priced: o.priced, violatingSnapshotInstances: o.violSnapInstances, violatingInstances: o.violInstances.size,
      maxMargin: r4(o.maxMargin), marginQuantiles: { p50: q(o.margins, 0.5), p90: q(o.margins, 0.9), p99: q(o.margins, 0.99), max: q(o.margins, 1) },
      maxProfitUsd: r4(o.maxProfit), episodes: eps.length, episodeMaxProfitUsdSum: r4(eps.reduce((s, p) => s + p.maxProfit, 0)),
      medianEpisodeSnapshots: eps.length ? q(eps.map((p) => p.n), 0.5) : null, medianEpisodeSec: eps.length ? q(eps.map((p) => p.last - p.first), 0.5) : null,
      // upper bound: every episode captured once at its best visible size, scaled from the observed hours to 24h
      usdPerDayUpperBound: hours > 0 ? r4(eps.reduce((s, p) => s + p.maxProfit, 0) / hours * 24) : null,
      makerLeggedNaive: { snapshotInstancesPositive: o.makerPos, instancesPositive: o.makerPosInst.size, marginQuantiles: o.makerMargins.length ? { p50: q(o.makerMargins, 0.5), p90: q(o.makerMargins, 0.9), p99: q(o.makerMargins, 0.99), max: q(o.makerMargins, 1) } : null },
    };
  }
}
fs.mkdirSync(path.join(REPORT, 'live'), { recursive: true });
writeJSON('live/live_summary.json', summary);
writeCSV('live/live_violations.csv', viol);
const latest = Math.max(...stubs.map((s) => s.fetchedTs));
const cur = viol.filter((v) => v.ts === latest);
writeCSV('live/current_violations.csv', cur);
for (const [k, sc] of Object.entries(summary.scopes)) {
  console.log(`\n== ${k}: ${sc.snapshots} snapshots ${sc.from} .. ${sc.to} (${sc.hours} h)`);
  for (const [f, o] of Object.entries(sc.families)) console.log(' ', f.padEnd(26), 'inst', String(o.instances).padEnd(5), 'priced', String(o.priced).padEnd(6), 'viol', String(o.violatingSnapshotInstances).padEnd(4), 'maxMargin', String(o.maxMargin).padEnd(8), 'p99', String(o.marginQuantiles.p99).padEnd(8), 'maxProfit$', String(o.maxProfitUsd).padEnd(7), '$/day<=', o.usdPerDayUpperBound, 'naiveMaker+', o.makerLeggedNaive.instancesPositive);
}
console.log('\nviolations in latest snapshot', new Date(latest * 1000).toISOString(), cur.length);
for (const v of cur.sort((a, b) => b.profitUsd - a.profitUsd).slice(0, 20)) console.log(v.family, v.id, 'cost', v.bestCost, 'margin', v.margin, 'shares', v.shares, 'profit$', v.profitUsd);
