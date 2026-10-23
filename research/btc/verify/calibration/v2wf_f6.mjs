// Verifier (calibration family): within-regime walk-forward of the F6 4h f75->f90 reaction rule.
// The analyst's F6 walk-forward trained on the pre-fee era and never traded. Here the same procedure (pick direction
// mom/fade and threshold in {0.05,0.1,0.15,0.2,0.3} by max training tSel, trade only if tSel>=1.5 and ROI>0) is run on
// crypto_fees_v2-era days only: first 40% of v2 days = training only, then expanding folds of 10% of v2 days.
//   node v2wf_f6.mjs -> out/v2wf_f6.json
import fs from 'node:fs';
import path from 'node:path';
import * as fees from '../../lib/fees.mjs';
import { clusterMeanTest, poissonBinomialTails } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'repro', 'out', 'cand_legs.json'), 'utf8')).variants;
const cost = (l, h = 0.01) => { const ref = l.tok === 'U' ? l.pInterp : 1 - l.pInterp; const ex = Math.min(0.999, Math.max(0.001, ref + h)); return ex + fees.takerFeePerShare(ex, undefined, 'docs_always'); };
function m(legs, h = 0.01) {
  if (!legs.length) return { n: 0 };
  const tr = legs.map((l) => { const c = cost(l, h); return { day: l.day, c, w: l.win, y: l.win / c - 1 }; });
  const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y); const w = tr.reduce((s, x) => s + x.w, 0);
  const zb = tr.reduce((s, x) => s + x.w - x.c, 0) / Math.sqrt(Math.max(1e-12, tr.reduce((s, x) => s + Math.min(1, x.c) * (1 - Math.min(1, x.c)), 0)));
  return { n: tr.length, days: ct.days, win: r4(w / tr.length), cost: r4(tr.reduce((s, x) => s + x.c, 0) / tr.length), roi: r4(ct.mean), t: r4(ct.t), tSel: Math.min(ct.t, zb), p: r4(Math.max(ct.pOne, poissonBinomialTails(tr.map((x) => Math.min(1, x.c)), w).upper)) };
}
const cands = [];
for (const dir of ['mom', 'fade']) for (const thr of [0.05, 0.1, 0.15, 0.2, 0.3]) {
  const id = `F6_reaction_taker|4h|f90|${dir}|{"from":"f75","to":"f90","thr":${thr}}`; const v = D[id]; if (!v) continue;
  cands.push({ dir, thr, legs: v.legs.filter((l) => l.feeType === 'crypto_fees_v2') });
}
const days = [...new Set(cands.flatMap((c) => c.legs.map((l) => l.day)))].sort();
const n0 = Math.ceil(0.4 * days.length), fs_ = Math.max(5, Math.round(0.1 * days.length));
const oos = [], info = [];
for (let s = n0; s < days.length; s += fs_) {
  const train = new Set(days.slice(0, s)), test = new Set(days.slice(s, s + fs_));
  let best = null; for (const c of cands) { const mm = m(c.legs.filter((l) => train.has(l.day))); if (mm.n >= 40 && mm.days >= 10 && (!best || mm.tSel > best.t)) best = { dir: c.dir, thr: c.thr, t: r4(mm.tSel), roi: mm.roi, n: mm.n }; }
  const use = best && best.t >= 1.5 && best.roi > 0; info.push({ testFrom: days[s], best, traded: !!use });
  if (use) { const c = cands.find((x) => x.dir === best.dir && x.thr === best.thr); for (const l of c.legs) if (test.has(l.day)) oos.push(l); }
}
const res = { v2Days: days.length, firstV2Day: days[0], oosFrom: days[n0], folds: info, oos: m(oos), oos_h2c: m(oos, 0.02), fixed_thr03_mom_v2OOSdaysOnly: m(cands.find((c) => c.dir === 'mom' && c.thr === 0.3).legs.filter((l) => l.day >= days[n0])) };
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(path.join(HERE, 'out', 'v2wf_f6.json'), JSON.stringify(res, null, 1));
