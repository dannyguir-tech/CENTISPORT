// Verifier (calibration family): adversarial re-evaluation of the analyst's candidates from the re-run's leg dump.
//   node attack.mjs  -> out/attack.json (+ console summary)
// For every candidate: reproduce the OOS headline; cost grid (fee model x spread haircut x execution latency);
// period splits (IS vs OOS, OOS 1st vs 2nd half, by fee regime, by quarter); day-bootstrap CI; exact Poisson-binomial
// p vs break-even; BH over ALL 2046 variants (untested p=1) and over the 1324 tested; capacity in $/day.
import fs from 'node:fs';
import path from 'node:path';
import * as fees from '../../lib/fees.mjs';
import { clusterMeanTest, bootstrapDays, poissonBinomialTails, benjaminiHochberg, wilson } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'repro', 'out', 'cand_legs.json'), 'utf8'));
const ALL = JSON.parse(fs.readFileSync(path.join(HERE, 'repro', 'out', 'all_variants_p.json'), 'utf8'));
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const STAKE_CAP = { '5m': 300, '15m': 300, '1h': 250, '4h': 125, '1d': 250 };

const CANDS = [
  ['F4_wf_logit_model|1h|f75', 'F4_wf_logit_model|1h|f75|model|{"margin":0.01}'],
  ['F6_reaction_taker|4h|f90|mom|thr0.3', 'F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.3}'],
  ['F6_reaction_taker|4h|f90|mom|thr0.2', 'F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.2}'],
  ['F1_band_taker|15m|f25|up|[0.90,0.95)', 'F1_band_taker|15m|f25|up|{"lo":0.9,"hi":0.95}'],
  ['F1_band_taker|15m|f25|down|[0.90,0.95)', 'F1_band_taker|15m|f25|down|{"lo":0.9,"hi":0.95}'],
  ['F1_band_taker|15m|f25|tok|[0.90,0.95)', 'F1_band_taker|15m|f25|tok|{"lo":0.9,"hi":0.95}'],
  ['F3_wf_band_taker|15m|f25|up', 'F3_wf_band_taker|15m|f25|up|{"select":"max train cluster-t over contiguous bands, trade if t>=1.5"}'],
  ['F1_band_taker|1h|f75|up|[0.95,0.98)', 'F1_band_taker|1h|f75|up|{"lo":0.95,"hi":0.98}'],
  ['F1_band_taker|1h|f75|down|[0.95,0.98)', 'F1_band_taker|1h|f75|down|{"lo":0.95,"hi":0.98}'],
  ['F1_band_taker|1h|f75|tok|[0.95,0.98)', 'F1_band_taker|1h|f75|tok|{"lo":0.95,"hi":0.98}'],
  ['F1_band_taker|5m|f90|tok|[0.98,0.999)', 'F1_band_taker|5m|f90|tok|{"lo":0.98,"hi":0.999}'],
  ['F9_streak_taker|4h|s0|rev1', 'F9_streak_taker|4h|s0|rev1|{}'],
  ['F9_streak_maker|4h|s0|rev1', 'F9_streak_maker|4h|s0|rev1|{"delta":0.01}'],
  ['F9_streak_taker|1h|s0|rev1', 'F9_streak_taker|1h|s0|rev1|{}'],
  ['F2_band_maker|1d|f25|tok|[0.6,0.7)', 'F2_band_maker|1d|f25|tok|{"lo":0.6,"hi":0.7,"delta":0.01}'],
  ['F8_wf_chainlink_model|4h|f90', 'F8_wf_chainlink_model|4h|f90|model|{"margin":0.01}'],
  ['F3_wf_band_taker|5m|pre|down', 'F3_wf_band_taker|5m|pre|down|{"select":"max train cluster-t over contiguous bands, trade if t>=1.5"}'],
  ['F1_band_taker|5m|pre|down|[0.5,0.6)', 'F1_band_taker|5m|pre|down|{"lo":0.5,"hi":0.6}'],
  ['F4_wf_logit_model|5m|pre', 'F4_wf_logit_model|5m|pre|model|{"margin":0.01}'],
  ['F3_wf_band_taker|1d|f50|up', 'F3_wf_band_taker|1d|f50|up|{"select":"max train cluster-t over contiguous bands, trade if t>=1.5"}'],
  ['F7_always_side|5m|s0|up', 'F7_always_side|5m|s0|up|{}'],
  ['F7_always_side|15m|pre|down', 'F7_always_side|15m|pre|down|{}'],
];

// ---- cost model (same as calib.mjs, but parameterised) ----
const refOf = (l, mode) => { const p = mode === 'snap' ? l.pSnap : mode === 'next' ? l.pNext : l.pInterp; return l.tok === 'U' ? p : 1 - p; };
function legRes(l, cfg) {
  if (l.kind === 'maker') { if (!l.filled) return null; const reb = cfg.rebate ? fees.makerRebatePerShare(l.L, { fee: { feesEnabled: true, feeSchedule: fees.CURRENT_SCHEDULE } }) : 0; return { c: l.L, y: (l.win + reb) / l.L - 1, w: l.win }; }
  const ex = Math.min(0.999, Math.max(0.001, refOf(l, cfg.exec) + cfg.h));
  const c = ex + fees.takerFeePerShare(ex, { fee: { feesEnabled: l.feeType != null, feeType: l.feeType, feeSchedule: l.feeType === 'crypto_fees_v2' ? fees.CURRENT_SCHEDULE : l.feeType === 'crypto_fees' ? { rate: 0.25, exponent: 2 } : null } }, cfg.fee);
  return { c, y: l.win / c - 1, w: l.win };
}
function evalLegs(legs, cfg, { boot = false, seed = 1 } = {}) {
  const tr = []; for (const l of legs) { const r = legRes(l, cfg); if (r) tr.push({ day: l.day, ...r }); }
  const n = tr.length; if (!n) return { n: 0 };
  const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y);
  const wins = tr.reduce((s, x) => s + x.w, 0), avgC = tr.reduce((s, x) => s + x.c, 0) / n;
  const pb = poissonBinomialTails(tr.map((x) => Math.min(x.c, 1)), wins).upper;
  const o = { n, days: ct.days, win: r4(wins / n), cost: r4(avgC), edge: r4(wins / n - avgC), roi: r4(ct.mean), t: r4(ct.t), pClusterOne: r4(ct.pOne), pBinom: r4(pb), p: r4(Math.max(ct.pOne, pb)) };
  if (boot && ct.days >= 3) {
    const agg = new Map(); for (const x of tr) { const a = agg.get(x.day) || { sy: 0, n: 0 }; a.sy += x.y; a.n++; agg.set(x.day, a); }
    const ci = bootstrapDays([...agg.values()], (s) => { let sy = 0, nn = 0; for (const a of s) { sy += a.sy; nn += a.n; } return sy / nn; }, { reps: 2000, seed });
    const [wl, wh] = wilson(wins, n); o.roiCI_boot = ci.map(r4); o.roiCI_wilson = [r4((wl - avgC) / avgC), r4((wh - avgC) / avgC)];
  }
  return o;
}
const HEAD = { fee: 'docs_always', exec: 'interp', h: 0.01 };

// ---- BH over all variants ----
const pAll = ALL.map((v) => (v.tested ? v.p : 1));
const bhAll = benjaminiHochberg(pAll, 0.10);
const testedIdx = ALL.map((v, i) => [v, i]).filter(([v]) => v.tested);
const bhTested = benjaminiHochberg(testedIdx.map(([v]) => v.p), 0.10);
const pRawAll = ALL.map((v) => (v.n > 0 && v.p != null ? v.p : 1));
const bhRaw = benjaminiHochberg(pRawAll, 0.10);
const qOf = (id) => { const i = ALL.findIndex((v) => v.id === id); const j = testedIdx.findIndex(([v]) => v.id === id); return { qAll2046_untestedP1: i >= 0 ? r4(bhAll.adj[i]) : null, qAll2046_rawP: i >= 0 ? r4(bhRaw.adj[i]) : null, qTested1324: j >= 0 ? r4(bhTested.adj[j]) : null, rankAmongTested: j >= 0 ? 1 + testedIdx.filter(([v]) => v.p < ALL[i].p).length : null }; };
const sortedP = testedIdx.map(([v]) => v.p).sort((a, b) => a - b);
const pSummary = { m2046: ALL.length, mTested: testedIdx.length, smallestP: sortedP.slice(0, 8).map(r4), bhThresholdForRank1_m2046: r4(0.1 / 2046), bhThresholdForRank1_m1324: r4(0.1 / 1324), expectedBelow0_01_underNull: r4(0.01 * testedIdx.length), observedBelow0_01: sortedP.filter((p) => p < 0.01).length, observedBelow0_05: sortedP.filter((p) => p < 0.05).length, expectedBelow0_05: r4(0.05 * testedIdx.length), bhSigAll: bhAll.nSig, bhSigTested: bhTested.nSig, bhSigRaw: bhRaw.nSig };

// ---- period splits ----
function splits(legs) {
  const oos = legs.filter((l) => l.oos), is = legs.filter((l) => !l.oos);
  const days = [...new Set(oos.map((l) => l.day))].sort(); const mid = days[Math.floor(days.length / 2)];
  const out = { IS: evalLegs(is, HEAD), OOS: evalLegs(oos, HEAD), OOS_firstHalf: evalLegs(oos.filter((l) => l.day < mid), HEAD), OOS_secondHalf: evalLegs(oos.filter((l) => l.day >= mid), HEAD), FULL: evalLegs(legs, HEAD, { boot: true, seed: 5 }) };
  const regimes = [...new Set(legs.map((l) => l.feeType ?? 'null'))];
  if (regimes.length > 1) for (const g of regimes) out['feeRegime_' + g] = evalLegs(legs.filter((l) => (l.feeType ?? 'null') === g), HEAD);
  const quarters = [...new Set(legs.map((l) => l.day.slice(0, 4) + 'Q' + (1 + Math.floor((+l.day.slice(5, 7) - 1) / 3))))].sort();
  if (quarters.length > 1) out.byQuarter = Object.fromEntries(quarters.map((qq) => [qq, evalLegs(legs.filter((l) => l.day.slice(0, 4) + 'Q' + (1 + Math.floor((+l.day.slice(5, 7) - 1) / 3)) === qq), HEAD)]).map(([k, v]) => [k, { n: v.n, win: v.win, cost: v.cost, roi: v.roi }]));
  return out;
}

const res = { pSummary, candidates: {} };
for (const [name, id] of CANDS) {
  const v = D.variants[id]; if (!v) { res.candidates[name] = { missing: true }; continue; }
  const legs = v.legs; const oos = legs.filter((l) => l.oos);
  const tf = id.split('|')[1];
  const grid = {};
  for (const fee of ['zero', 'docs_always', 'docs', 'minp', 'flat2']) for (const h of [0, 0.005, 0.01, 0.02, 0.03]) for (const exec of ['snap', 'interp', 'next']) {
    if (exec !== 'interp' && !(fee === 'docs_always' && (h === 0.01 || h === 0.02))) continue;
    const m = evalLegs(oos, { fee, exec, h }); grid[`${fee}|h${h}|${exec}`] = { n: m.n, cost: m.cost, edge: m.edge, roi: m.roi, p: m.p };
  }
  if (oos[0]?.kind === 'maker') { const m = evalLegs(oos, { ...HEAD, rebate: true }); grid['maker+rebate'] = { n: m.n, roi: m.roi, p: m.p }; }
  const head = evalLegs(oos, HEAD, { boot: true, seed: 11 });
  const oosDays = new Set(); const fo = D.folds[tf];
  const calDays = fo.days - Math.ceil(0.4 * fo.days);
  const perDay = head.n / Math.max(1, id.startsWith('F8') ? Math.round(0.6 * 46) : calDays);
  // break-even haircut: largest extra cents over the headline 1c at which OOS ROI stays > 0 (docs_always, interp)
  let beH = null; for (let h = 0; h <= 0.06; h += 0.0025) { const m = evalLegs(oos, { fee: 'docs_always', exec: 'interp', h }); if (m.roi > 0) beH = r4(h); }
  // stale-snapshot attack: drop legs whose snapshot is > 60 s older than the nominal decision time
  const fresh = evalLegs(oos.filter((l) => l.stale <= 60), HEAD);
  res.candidates[name] = {
    id, tested: v.tested, analystOOS: { n: v.oos.n, win: v.oos.winRate, cost: v.oos.avgCost, roi: v.oos.roi, p: v.oos.p }, reproOOS: head, bh: qOf(id),
    costGrid: grid, breakEvenHaircut_docsAlways: beH, freshSnapshotOnly_stale_le60s: fresh, splits: splits(legs),
    staleSec: { p50: r4(oos.map((l) => l.stale).sort((a, b) => a - b)[oos.length >> 1]), max: Math.max(...oos.map((l) => l.stale)) },
    tradesPerDay: r4(perDay), capacityUSDperDay_analystStake: r4(Math.max(0, head.roi ?? 0) * perDay * STAKE_CAP[tf]),
    medianVolumeUSD: r4(oos.map((l) => l.volume || 0).sort((a, b) => a - b)[oos.length >> 1]),
  };
  const c = res.candidates[name];
  console.log(`\n${name}  [${id}] tested=${v.tested}`);
  console.log(`  analyst OOS n=${v.oos.n} win=${v.oos.winRate} cost=${v.oos.avgCost} roi=${v.oos.roi} p=${v.oos.p?.toExponential?.(2)} | repro n=${head.n} win=${head.win} cost=${head.cost} roi=${head.roi} p=${head.p} CIboot=${head.roiCI_boot} CIwil=${head.roiCI_wilson}`);
  console.log(`  BH: ${JSON.stringify(c.bh)}  breakEvenHaircut=${beH}  fresh(stale<=60s): n=${fresh.n} roi=${fresh.roi}`);
  const sp = c.splits; console.log(`  IS n=${sp.IS.n} roi=${sp.IS.roi} | OOS1 n=${sp.OOS_firstHalf.n} roi=${sp.OOS_firstHalf.roi} | OOS2 n=${sp.OOS_secondHalf.n} roi=${sp.OOS_secondHalf.roi} | FULL n=${sp.FULL.n} roi=${sp.FULL.roi} p=${sp.FULL.p} CI=${sp.FULL.roiCI_boot}`);
  for (const k of Object.keys(sp).filter((k) => k.startsWith('feeRegime_'))) console.log(`  ${k}: n=${sp[k].n} roi=${sp[k].roi}`);
  if (sp.byQuarter) console.log('  byQuarter', JSON.stringify(sp.byQuarter));
  console.log('  grid', Object.entries(grid).map(([k, m]) => `${k}:${m.roi}`).join(' '));
}
fs.writeFileSync(path.join(HERE, 'out', 'attack.json'), JSON.stringify(res, null, 1));
console.log('\npSummary', JSON.stringify(pSummary));
