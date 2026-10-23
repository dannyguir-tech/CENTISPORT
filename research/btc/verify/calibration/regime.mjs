// Verifier (calibration family): fee-regime attack.
// For 1h/4h/1d the analyst's IS period (first 40% of days) is almost entirely the pre-fee era (feeType null,
// <= 2026-03-10) and OOS is mostly the crypto_fees_v2 era (>= 2026-03-30). "IS negative, OOS positive" can therefore
// be a regime change rather than noise. Here: (1) logit favourite/longshot slope by regime; (2) every dumped variant
// re-evaluated on v2-era legs only, with the v2 era split in halves (a within-regime out-of-sample check).
//   node regime.mjs -> out/regime.json
import fs from 'node:fs';
import path from 'node:path';
import * as fees from '../../lib/fees.mjs';
import { buildObs } from './repro/obs.mjs';
import { clusterMeanTest, poissonBinomialTails, logisticFit, logit, benjaminiHochberg } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const quant = (a, q) => { const s = a.slice().sort((x, y) => x - y); const pos = q * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
const out = { slopes: {}, v2Variants: [] };

// (1) slope by regime
for (const tf of ['1h', '4h', '1d']) {
  const obs = buildObs(tf); out.slopes[tf] = {};
  for (const dk of ['f25', 'f50', 'f75', 'f90']) {
    out.slopes[tf][dk] = {};
    for (const [rg, pred] of [['preFee(null)', (o) => o.feeType == null], ['v2', (o) => o.feeType === 'crypto_fees_v2']]) {
      const rows = obs.filter((o) => pred(o) && o.d[dk] && o.d[dk].pSnap >= 0.02 && o.d[dk].pSnap <= 0.98);
      if (rows.length < 100) continue;
      const X = rows.map((o) => [logit(o.d[dk].pSnap)]), Y = rows.map((o) => o.upWon); const b = logisticFit(X, Y);
      const byD = new Map(); rows.forEach((o, i) => { if (!byD.has(o.day)) byD.set(o.day, []); byD.get(o.day).push(i); }); const G = [...byD.values()];
      const bs = []; for (let rep = 0; rep < 200; rep++) { const rnd = mulberry(1000 + rep); const xs = [], ys = []; for (let g = 0; g < G.length; g++) for (const i of G[(rnd() * G.length) | 0]) { xs.push(X[i]); ys.push(Y[i]); } const bb = logisticFit(xs, ys, { iters: 12 }); if (bb) bs.push(bb[1]); }
      out.slopes[tf][dk][rg] = { n: rows.length, days: G.length, slope: r4(b[1]), ci: [r4(quant(bs, 0.025)), r4(quant(bs, 0.975))] };
    }
  }
}
console.log(JSON.stringify(out.slopes));

// (2) v2-era-only evaluation of every dumped variant (headline costs)
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'repro', 'out', 'cand_legs.json'), 'utf8')).variants;
const V2 = { fee: { feesEnabled: true, feeType: 'crypto_fees_v2', feeSchedule: fees.CURRENT_SCHEDULE } };
function ev(legs) {
  const tr = [];
  for (const l of legs) {
    if (l.kind === 'maker') { if (!l.filled) continue; tr.push({ day: l.day, c: l.L, y: l.win / l.L - 1, w: l.win }); continue; }
    const ref = l.tok === 'U' ? l.pInterp : 1 - l.pInterp; const ex = Math.min(0.999, Math.max(0.001, ref + 0.01)); const c = ex + fees.takerFeePerShare(ex, V2, 'docs');
    tr.push({ day: l.day, c, y: l.win / c - 1, w: l.win });
  }
  if (!tr.length) return { n: 0 };
  const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y); const wins = tr.reduce((s, x) => s + x.w, 0);
  const pb = poissonBinomialTails(tr.map((x) => Math.min(1, x.c)), wins).upper;
  return { n: tr.length, days: ct.days, win: r4(wins / tr.length), cost: r4(tr.reduce((s, x) => s + x.c, 0) / tr.length), roi: r4(ct.mean), t: r4(ct.t), p: Math.max(ct.pOne, pb) };
}
for (const [id, v] of Object.entries(D)) {
  const tf = id.split('|')[1]; if (!['1h', '4h', '1d'].includes(tf)) continue;
  if (/^F[34]_wf|^F8/.test(id)) continue; // walk-forward procedures have no IS legs; v2-era fold selection would need a refit
  const legs = v.legs.filter((l) => l.feeType === 'crypto_fees_v2'); if (legs.length < 40) continue;
  const days = [...new Set(legs.map((l) => l.day))].sort(); const mid = days[Math.floor(days.length / 2)];
  const a = ev(legs.filter((l) => l.day < mid)), b = ev(legs.filter((l) => l.day >= mid)), all = ev(legs);
  out.v2Variants.push({ id, v2_all: all, v2_firstHalf: a, v2_secondHalf: b });
}
// BH over the v2 second-half p-values of variants whose first-half ROI was positive (a within-regime "select then test")
const sel = out.v2Variants.filter((x) => x.v2_firstHalf.n >= 20 && x.v2_firstHalf.roi > 0 && x.v2_secondHalf.n >= 20);
const bh = benjaminiHochberg(sel.map((x) => x.v2_secondHalf.p), 0.10);
sel.forEach((x, i) => { x.q_selectedOnFirstHalf = r4(bh.adj[i]); });
out.v2SelectThenTest = { mVariantsWithV2Data: out.v2Variants.length, selectedOnFirstHalf: sel.length, secondHalfPositive: sel.filter((x) => x.v2_secondHalf.roi > 0).length, bhSig: bh.nSig, top: sel.sort((a, b) => a.v2_secondHalf.p - b.v2_secondHalf.p).slice(0, 12).map((x) => ({ id: x.id, first: x.v2_firstHalf, second: x.v2_secondHalf, q: x.q_selectedOnFirstHalf })) };
const allV2 = out.v2Variants.filter((x) => x.v2_all.n >= 20); const bhAll = benjaminiHochberg(allV2.map((x) => x.v2_all.p), 0.10);
out.v2AllSummary = { m: allV2.length, bhSig: bhAll.nSig, smallestP: allV2.map((x) => [x.v2_all.p, x.id, x.v2_all.n, x.v2_all.roi]).sort((a, b) => a[0] - b[0]).slice(0, 10) };
for (const want of ['F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.3}', 'F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.2}', 'F1_band_taker|1h|f75|up|{"lo":0.95,"hi":0.98}', 'F9_streak_taker|4h|s0|rev1|{}', 'F9_streak_maker|4h|s0|rev1|{"delta":0.01}', 'F1_band_taker|4h|f90|tok|{"lo":0.8,"hi":0.9}', 'F1_band_taker|4h|f90|tok|{"lo":0.9,"hi":0.95}', 'F1_band_taker|4h|f90|tok|{"lo":0.95,"hi":0.98}']) {
  const x = out.v2Variants.find((y) => y.id === want); if (x) console.log(want, JSON.stringify({ all: x.v2_all, h1: x.v2_firstHalf, h2: x.v2_secondHalf }));
}
console.log('v2SelectThenTest', JSON.stringify({ ...out.v2SelectThenTest, top: out.v2SelectThenTest.top.slice(0, 6) }));
console.log('v2AllSummary', JSON.stringify(out.v2AllSummary));
fs.writeFileSync(path.join(HERE, 'out', 'regime.json'), JSON.stringify(out, null, 1));
