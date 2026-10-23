#!/usr/bin/env node
// Collects every variant tested by the structure analysis, applies day-clustered bootstrap + walk-forward + BH(q=0.10),
// and writes reports/structure/{variants.csv, results.json, summary.txt}.
//
// Variant groups:
//  M  mid-screen (hist_relations): basket cost from price-history mids + half-spread haircut + fee.  NOT executable
//     evidence: risk-free baskets are profitable by construction whenever the (stale / wide-book) mids say so.
//  P  print-verified (verify_prints): same episodes re-priced from actual taker ask-side fills.        HEADLINE for arbs
//  I  implied-state statistical (implied_state + implied_verify).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { REPORT, bootstrapByDay, bh, r4, writeCSV, writeJSON } from './common.mjs';

const HIST = path.join(REPORT, 'hist');
const THETAS = [0, 0.005, 0.01, 0.02, 0.04];
const FEES = ['docs_always', 'docs', 'flat2'];
const variants = [];

function stats(tr) {
  if (!tr.length) return null;
  const b = bootstrapByDay(tr);
  const n = tr.length;
  return { n, days: b.nDays, winRate: r4(tr.filter((x) => x.profit > 0).length / n), avgCost: r4(tr.reduce((a, x) => a + x.cost, 0) / n), avgPayoff: r4(tr.reduce((a, x) => a + x.payoff, 0) / n),
    edgePerTrade: r4(tr.reduce((a, x) => a + x.profit, 0) / n), roi: r4(b.roi), ci: b.ci.map(r4), p: b.nDays >= 2 ? b.pOneSided : NaN,
    failRate: r4(tr.filter((x) => x.payoff < (x.minPay ?? 1)).length / n) };
}
function walkForward(rowsByTheta, allDays, { minTrain = 5, defTheta = 0.01 } = {}) {
  const days = [...allDays].sort();
  if (days.length < 6) return null;
  const nTrain = Math.max(3, Math.floor(days.length * 0.4));
  const rest = days.slice(nTrain), nF = Math.min(5, rest.length), per = Math.ceil(rest.length / nF);
  const oos = [], folds = [];
  for (let f = 0; f < nF; f++) {
    const fd = rest.slice(f * per, (f + 1) * per); if (!fd.length) continue;
    const fdS = new Set(fd);
    let best = null;
    for (const th of THETAS) {
      const tr = (rowsByTheta.get(th) || []).filter((r) => r.day < fd[0]);
      if (tr.length < minTrain) continue;
      const roi = tr.reduce((a, r) => a + r.profit, 0) / tr.reduce((a, r) => a + r.cost, 0);
      if (!best || roi > best.roi) best = { th, roi };
    }
    const th = best ? best.th : defTheta;
    folds.push({ from: fd[0], to: fd[fd.length - 1], theta: th });
    oos.push(...(rowsByTheta.get(th) || []).filter((r) => fdS.has(r.day)));
  }
  return { oos, folds, oosDays: rest.length, oosFrom: rest[0], oosTo: rest[rest.length - 1] };
}

// ------------------------------------------------------------------ M: mid-screen
const M = new Map(); // family|s|fm -> Map(theta -> rows)
const famDays = new Map();
import zlib from 'node:zlib';
const tradesFile = fs.existsSync(path.join(HIST, 'trades.jsonl')) ? path.join(HIST, 'trades.jsonl') : path.join(HIST, 'trades.jsonl.gz');
const rl = readline.createInterface({ input: tradesFile.endsWith('.gz') ? fs.createReadStream(tradesFile).pipe(zlib.createGunzip()) : fs.createReadStream(tradesFile) });
for await (const line of rl) {
  if (!line) continue;
  const x = JSON.parse(line);
  if (x.fm === 'zero') continue;
  const k = `${x.family}|${x.s}|${x.fm}`;
  if (!M.has(k)) M.set(k, new Map());
  const m = M.get(k); if (!m.has(x.theta)) m.set(x.theta, []);
  m.get(x.theta).push({ day: x.day, cost: x.cost, payoff: x.payoff, profit: x.profit, capShares: x.capShares, minPay: x.nLegs && x.family === 'range_allno' ? null : 1 });
  if (!famDays.has(x.family)) famDays.set(x.family, new Set());
  famDays.get(x.family).add(x.day);
}
for (const [k, byTh] of M) {
  const [family, s, fm] = k.split('|');
  for (const th of THETAS) { const st = stats(byTh.get(th) || []); if (st) variants.push({ group: 'M', family, scenario: s, fee: fm, theta: th, mode: 'fixed', ...st }); }
  const wf = walkForward(byTh, famDays.get(family));
  if (wf && wf.oos.length) { const st = stats(wf.oos); variants.push({ group: 'M', family, scenario: s, fee: fm, theta: 'WF', mode: 'walk-forward', folds: wf.folds, oosFrom: wf.oosFrom, oosTo: wf.oosTo, oosDays: wf.oosDays, ...st }); }
}

// ------------------------------------------------------------------ P: print-verified
const P = fs.existsSync(path.join(HIST, 'verified_prints.jsonl')) ? fs.readFileSync(path.join(HIST, 'verified_prints.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const pop = fs.existsSync(path.join(HIST, 'verified_population.json')) ? JSON.parse(fs.readFileSync(path.join(HIST, 'verified_population.json'), 'utf8')).population : {};
const fee = { docs_always: (p) => 0.07 * p * (1 - p), flat2: (p) => 0.02 * p };
const verifySummary = {};
for (const fam of [...new Set(P.map((r) => r.family))]) {
  const rows = P.filter((r) => r.family === fam);
  const vs = verifySummary[fam] = { sampled: rows.length, populationExecOnMidScreen: pop[fam]?.execEpisodes ?? null, legsWithNoPrints: 0, plAvailable: 0, pl60Available: 0, pl60Arb: 0, plArb: 0, pmArb: 0, medianPl60Margin: null, examples: [] };
  const ms = [];
  for (const r of rows) {
    if (r.legs.some((l) => !l.nAsk)) vs.legsWithNoPrints++;
    if (r.pl) { vs.plAvailable++; if (r.pl.docs_always.margin > 0) vs.plArb++; }
    if (r.pm && r.pm.docs_always.margin > 0) vs.pmArb++;
  }
  // scenarios: pl60 (all legs' last ask print within 60s before t), pl (within the family window), pm (window min, optimistic)
  for (const sc of ['pl60', 'pl', 'pm']) for (const fm of FEES) {
    const byTh = new Map(THETAS.map((th) => [th, []]));
    const days = new Set();
    for (const r of rows) {
      days.add(r.day);
      const base = sc === 'pm' ? r.pm : r.pl;
      if (!base) continue;
      if (sc === 'pl60' && r.legs.some((l) => !l.last || r.t - l.last.t > 60)) continue;
      if (sc === 'pl60' && fm === 'docs_always') { vs.pl60Available++; ms.push(base.docs_always.margin); }
      let cost;
      if (fm === 'docs') cost = base.docs.cost; else cost = base.prices.reduce((a, p) => a + p + fee[fm](p), 0);
      const margin = r.minPay - cost, profit = r.payoff - cost;
      if (sc === 'pl60' && fm === 'docs_always' && margin > 0) { vs.pl60Arb++; if (vs.examples.length < 5) vs.examples.push({ id: r.id, t: new Date(r.t * 1000).toISOString(), prices: base.prices, margin: r4(margin), sizeShares: base.sizeShares, payoff: r.payoff }); }
      for (const th of THETAS) if (margin > th) byTh.get(th).push({ day: r.day, cost, payoff: r.payoff, profit, minPay: r.minPay, sizeShares: base.sizeShares });
    }
    const scale = (pop[fam]?.execEpisodes || rows.length) / rows.length;
    const spanDays = days.size ? (Math.max(...[...days].map((d) => Date.parse(d))) - Math.min(...[...days].map((d) => Date.parse(d)))) / 86400000 + 1 : 1;
    const capOf = (tr) => r4((tr.reduce((a, x) => a + Math.max(0, x.profit) * Math.min(x.sizeShares || 0, 1e6), 0) * scale) / spanDays);
    for (const th of THETAS) { const tr = byTh.get(th); const st = stats(tr); if (st) variants.push({ group: 'P', family: fam, scenario: sc, fee: fm, theta: th, mode: 'fixed', ...st, capacityUsdPerDay: capOf(tr), sampleScale: r4(scale) }); }
    const wf = walkForward(byTh, days, { minTrain: 3, defTheta: 0 });
    if (wf && wf.oos.length) { const st = stats(wf.oos); variants.push({ group: 'P', family: fam, scenario: sc, fee: fm, theta: 'WF', mode: 'walk-forward', folds: wf.folds, oosFrom: wf.oosFrom, oosTo: wf.oosTo, ...st, capacityUsdPerDay: capOf(wf.oos), sampleScale: r4(scale) }); }
  }
  ms.sort((a, b) => a - b);
  vs.medianPl60Margin = ms.length ? ms[Math.floor(ms.length / 2)] : null;
  vs.p90Pl60Margin = ms.length ? ms[Math.floor(ms.length * 0.9)] : null;
}

// ------------------------------------------------------------------ I: implied-state
const IS = fs.existsSync(path.join(REPORT, 'implied', 'summary.json')) ? JSON.parse(fs.readFileSync(path.join(REPORT, 'implied', 'summary.json'), 'utf8')) : [];
for (const r of IS) variants.push({ group: 'I', family: r.rule, scenario: r.s, fee: 'docs_always', theta: r.theta, mode: r.mode === 'walk-forward-OOS' ? 'walk-forward' : 'fixed', n: r.n, days: r.days, winRate: r.winRate, avgCost: r.avgCost, roi: r.roi, ci: r.ci, p: r.p, folds: r.folds, printChecked: r.printChecked, printRoi: r.printRoi });
const IP = fs.existsSync(path.join(REPORT, 'implied', 'print_check.json')) ? JSON.parse(fs.readFileSync(path.join(REPORT, 'implied', 'print_check.json'), 'utf8')) : [];
for (const r of IP) for (const k of ['pl', 'pn']) if (r[k] && r[k].n) variants.push({ group: 'I', family: r.rule, scenario: `print_${k}`, fee: 'docs_always', theta: 'WF', mode: 'walk-forward', n: r[k].n, days: r[k].days, winRate: r[k].winRate, avgCost: r[k].avgCost, roi: r[k].roi, ci: r[k].ci, p: r[k].p, slipVsAssumed: r[k].slipVsAssumed, midRoiSameSubset: r[k].midRoiSameSubset });

// ------------------------------------------------------------------ K: maker-legged simulation on live books + real tape
const MK = fs.existsSync(path.join(REPORT, 'maker', 'maker_sim.json')) ? JSON.parse(fs.readFileSync(path.join(REPORT, 'maker', 'maker_sim.json'), 'utf8')) : null;
if (MK) for (const g of MK.grid) variants.push({ group: 'K', family: `maker_${g.family}`, scenario: `${g.placement}|H${g.H}|session${g.session}`, fee: 'maker0+takerHedge', theta: g.theta, mode: 'fixed',
  n: g.filledOrders, ordersPlaced: g.orders, days: 1, winRate: g.winRate, avgCost: g.avgCostPerSet, roi: g.roi, ci: g.ci, p: g.p ?? NaN, pnlUsd: g.pnlUsd, capacityUsdPerDay: g.usdPerDay, roiWithRebate: g.withRebate.roi });
if (MK && MK.walkForward) { const w = MK.walkForward; variants.push({ group: 'K', family: 'maker_ALL', scenario: `WF ${w.chosen} -> sessions ${w.oosSessions.join(',')}`, fee: 'maker0+takerHedge', theta: 'WF', mode: 'walk-forward',
  n: w.oos.filledOrders, ordersPlaced: w.oos.orders, days: 1, winRate: w.oos.winRate, avgCost: w.oos.avgCostPerSet, roi: w.oos.roi, ci: w.oos.ci, p: w.oos.p ?? NaN, pnlUsd: w.oos.pnlUsd, capacityUsdPerDay: w.oos.usdPerDay, roiWithRebate: w.oosWithRebate.roi }); }

// ------------------------------------------------------------------ C: print-first census of nested Chainlink pairs (print_scan.mjs)
const PS = fs.existsSync(path.join(REPORT, 'printscan', 'summary.json')) ? JSON.parse(fs.readFileSync(path.join(REPORT, 'printscan', 'summary.json'), 'utf8')) : null;
if (PS) for (const v of PS.variants) {
  variants.push({ group: 'C', family: v.family, scenario: `lastPrint_W${v.W}`, fee: 'docs_always', theta: v.theta, mode: v.mode, n: v.n, days: v.days, winRate: v.winRate, avgCost: v.avgCost, roi: v.roi, ci: v.ci, p: v.days >= 2 ? v.p : NaN, capacityUsdPerDay: v.usdPerDay, oosFrom: v.oosFrom, oosTo: v.oosTo });
  if (v.folN) variants.push({ group: 'C', family: v.family, scenario: `followThrough_W${v.W}`, fee: 'docs_always', theta: v.theta, mode: v.mode, n: v.folN, days: v.days, winRate: v.folWin, roi: v.folRoi, ci: v.folCi, p: v.mode === 'walk-forward' && v.folP != null ? v.folP : NaN, capacityUsdPerDay: v.usdPerDayFollow, oosFrom: v.oosFrom, oosTo: v.oosTo });
}

// ------------------------------------------------------------------ L: live taker screen on real books (no p-values: a pass/fail existence screen)
const LIVE = fs.existsSync(path.join(REPORT, 'live', 'live_summary.json')) ? JSON.parse(fs.readFileSync(path.join(REPORT, 'live', 'live_summary.json'), 'utf8')) : null;
if (LIVE && LIVE.scopes) for (const [scope, sc] of Object.entries(LIVE.scopes)) if (scope !== 'all') for (const [f, o] of Object.entries(sc.families)) variants.push({ group: 'L', family: f, scenario: `taker_books_${scope}`, fee: 'docs', theta: 0, mode: 'live',
  n: o.violatingSnapshotInstances, ordersPlaced: o.priced, days: 1, roi: null, p: NaN, maxMargin: o.maxMargin, capacityUsdPerDay: o.usdPerDayUpperBound });

// ------------------------------------------------------------------ BH across every variant with a p-value
const sig = bh(variants.map((v) => (Number.isFinite(v.p) && v.n >= 5 ? v.p : NaN)), 0.1);
variants.forEach((v, i) => { v.bh = sig[i]; });
writeCSV('variants.csv', variants.map((v) => ({ ...v, ci: v.ci ? `[${v.ci.join(';')}]` : '', folds: v.folds ? v.folds.map((f) => `${f.from}:${f.theta}`).join(';') : '' })));
const live = fs.existsSync(path.join(REPORT, 'live', 'live_summary.json')) ? JSON.parse(fs.readFileSync(path.join(REPORT, 'live', 'live_summary.json'), 'utf8')) : null;
const episodeSummary = JSON.parse(fs.readFileSync(path.join(HIST, 'episode_summary.json'), 'utf8'));
const famStats = JSON.parse(fs.readFileSync(path.join(HIST, 'family_stats.json'), 'utf8'));
writeJSON('results.json', { variantsTested: variants.length, variantsWithP: variants.filter((v) => Number.isFinite(v.p) && v.n >= 5).length, bhSignificant: variants.filter((v) => v.bh).length,
  bhSignificantByGroup: Object.fromEntries(['M', 'P', 'I', 'C', 'K', 'L'].map((g) => [g, variants.filter((v) => v.bh && v.group === g).length])), variantsByGroup: Object.fromEntries(['M', 'P', 'I', 'C', 'K', 'L'].map((g) => [g, variants.filter((v) => v.group === g).length])), maker: MK ? { sessions: MK.sessions, walkForward: MK.walkForward } : null,
  verifySummary, episodeSummary, famStats, live, headline: variants.filter((v) => (v.group === 'P' && v.scenario === 'pl60' && v.fee === 'docs_always' && v.mode === 'walk-forward') || (v.group === 'M' && v.scenario === 'hc1' && v.fee === 'docs_always' && v.mode === 'walk-forward') || (v.group === 'I' && v.mode === 'walk-forward') || (v.group === 'K' && v.mode === 'walk-forward') || (v.group === 'C' && v.mode === 'walk-forward')) });
// console digest
console.log('variants', variants.length, 'with p', variants.filter((v) => Number.isFinite(v.p) && v.n >= 5).length, 'BH sig', variants.filter((v) => v.bh).length, JSON.stringify(Object.fromEntries(['M', 'P', 'I', 'C', 'K', 'L'].map((g) => [g, [variants.filter((v) => v.group === g).length, variants.filter((v) => v.bh && v.group === g).length]]))));
console.log('\n== print verification by family (sampled episodes that looked executable on mid+half-spread)');
for (const [f, v] of Object.entries(verifySummary)) console.log(f.padEnd(26), 'pop', String(v.populationExecOnMidScreen).padEnd(5), 'sampled', String(v.sampled).padEnd(4), 'noPrintLeg', String(v.legsWithNoPrints).padEnd(4), 'pl60avail', String(v.pl60Available).padEnd(4), 'pl60arb', String(v.pl60Arb).padEnd(3), 'plArb', String(v.plArb).padEnd(3), 'pmArb', String(v.pmArb).padEnd(3), 'medMargin', v.medianPl60Margin, 'p90', v.p90Pl60Margin);
console.log('\n== headline rows');
for (const v of variants.filter((v) => v.mode === 'walk-forward' && ((v.group === 'P' && v.scenario === 'pl60' && v.fee === 'docs_always') || (v.group === 'M' && v.scenario === 'hc1' && v.fee === 'docs_always') || v.group === 'I')))
  console.log(v.group, v.family.padEnd(26), v.scenario.padEnd(9), 'n', String(v.n).padEnd(5), 'days', String(v.days).padEnd(4), 'win', v.winRate, 'cost', v.avgCost, 'roi', v.roi, 'ci', JSON.stringify(v.ci), 'p', Number.isFinite(v.p) ? v.p.toFixed(4) : '-', 'bh', v.bh, v.capacityUsdPerDay != null ? `cap$/d ${v.capacityUsdPerDay}` : '');
