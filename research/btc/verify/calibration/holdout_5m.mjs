// Verifier (calibration family): INDEPENDENT HOLDOUT replication of the 5m calibration findings.
// Holdout = 45,897 settled 5m Up/Down markets 2026-04-01 .. 2026-09-07 (all crypto_fees_v2), collected by the momentum
// verifier (verify/momentum/data/updown_5m_ext.jsonl, same endpoints/fields as collect.mjs). The analyst's 5m sample
// starts 2026-09-07, so none of these windows were used to pick any rule.
//   node holdout_5m.mjs -> out/holdout_5m.json
// Replicates every fixed 5m taker rule family of calib.mjs (F1 bands x sides x decision times, F7 always-side,
// F6 reaction mom/fade, F9 streaks) with the analyst's headline costs, plus the specific candidate cells, the
// favourite-longshot logit slopes and the 5m pre-window logit model fitted on the analyst's own 5m data.
import fs from 'node:fs';
import path from 'node:path';
import * as fees from '../../lib/fees.mjs';
import { loadUpDown } from '../../lib/load.mjs';
import { decisionAt, FRACS, buildObs } from './repro/obs.mjs';
import { clusterMeanTest, poissonBinomialTails, benjaminiHochberg, logisticFit, logit, sigmoid, wilson } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const EXT = path.join(HERE, '..', 'momentum', 'data', 'updown_5m_ext.jsonl');
const recs = fs.readFileSync(EXT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.path && r.path.length && (r.winner === 'Up' || r.winner === 'Down')).sort((a, b) => a.windowStart - b.windowStart);
const out = { holdout: { n: recs.length, firstDay: recs[0].day, lastDay: recs.at(-1).day, days: new Set(recs.map((r) => r.day)).size } };
// integrity
let both = 0, agree = 0; for (const r of recs) if (r.priceToBeat != null && r.finalPrice != null) { both++; if ((r.finalPrice >= r.priceToBeat) === !!r.upWon) agree++; }
const analystSlugs = new Set(loadUpDown('5m').map((r) => r.slug)); const overlap = recs.filter((r) => analystSlugs.has(r.slug)).length;
out.holdout.integrity = { withChainlinkBoth: both, labelAgrees: agree, overlapWithAnalystSample: overlap, upRate: r4(recs.reduce((s, r) => s + (r.upWon ? 1 : 0), 0) / recs.length) };
console.log(JSON.stringify(out.holdout));

// observations (same construction as obs.mjs buildObs)
const obs = []; let prev = null; const hist = [];
for (const r of recs) {
  if (!prev || prev.windowEnd !== r.windowStart) hist.length = 0;
  const W = r.windowEnd - r.windowStart; const o = { day: r.day, upWon: r.upWon ? 1 : 0, prev1: hist.length ? hist[hist.length - 1] : null, prev3same: hist.length >= 3 && hist.slice(-3).every((x) => x === hist[hist.length - 1]) ? hist[hist.length - 1] : null, d: {} };
  for (const fr of FRACS) { const dd = decisionAt(r, Math.floor(r.windowStart + fr.f * W), 75); if (dd) o.d[fr.key] = dd; }
  obs.push(o); hist.push(r.upWon ? 1 : 0); if (hist.length > 5) hist.shift(); prev = r;
}
const cost = (d, tok, h = 0.01, fee = 'docs_always') => { const ref = tok === 'U' ? d.pInterp : 1 - d.pInterp; const ex = Math.min(0.999, Math.max(0.001, ref + h)); return ex + fees.takerFeePerShare(ex, undefined, fee); };
const leg = (o, d, tok) => ({ day: o.day, q: tok === 'U' ? d.pSnap : 1 - d.pSnap, win: tok === 'U' ? o.upWon : 1 - o.upWon, c: cost(d, tok), c0: cost(d, tok, 0.002), d, tok });
function M(legs, key = 'c') {
  if (!legs.length) return { n: 0 };
  const tr = legs.map((l) => ({ day: l.day, w: l.win, c: l[key], y: l.win / l[key] - 1 }));
  const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y); const w = tr.reduce((s, x) => s + x.w, 0);
  const pb = poissonBinomialTails(tr.map((x) => Math.min(1, x.c)), w).upper; const avgC = tr.reduce((s, x) => s + x.c, 0) / tr.length; const [wl, wh] = wilson(w, tr.length);
  return { n: tr.length, days: ct.days, win: r4(w / tr.length), cost: r4(avgC), edge: r4(w / tr.length - avgC), roi: r4(ct.mean), t: r4(ct.t), p: Math.max(ct.pOne, pb), roiCI_wilson: [r4((wl - avgC) / avgC), r4((wh - avgC) / avgC)] };
}
const BANDS = [[0.02, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 0.98], [0.98, 0.999]];
const V = [];
const legsFor = (dk, side) => { const a = []; for (const o of obs) { const d = o.d[dk]; if (!d) continue; for (const tok of side === 'tok' ? ['U', 'D'] : side === 'up' ? ['U'] : ['D']) a.push(leg(o, d, tok)); } return a; };
for (const fr of FRACS) {
  for (const side of ['tok', 'up', 'down']) { const L = legsFor(fr.key, side); for (const [lo, hi] of BANDS) V.push({ id: `F1_band_taker|5m|${fr.key}|${side}|[${lo},${hi})`, m: M(L.filter((l) => l.q >= lo && l.q < hi)) }); }
  for (const side of ['up', 'down']) V.push({ id: `F7_always_side|5m|${fr.key}|${side}`, m: M(legsFor(fr.key, side).filter((l) => l.q >= 0.02 && l.q < 0.98)) });
}
for (const [e, l] of [['s0', 'f50'], ['f50', 'f75'], ['f75', 'f90']]) for (const dir of ['mom', 'fade']) for (const thr of [0.05, 0.1, 0.15, 0.2, 0.3]) {
  const L = obs.filter((o) => o.d[e] && o.d[l] && Math.abs(o.d[l].pSnap - o.d[e].pSnap) >= thr).map((o) => leg(o, o.d[l], ((o.d[l].pSnap - o.d[e].pSnap > 0) === (dir === 'mom')) ? 'U' : 'D')).filter((x) => x.q >= 0.02 && x.q < 0.98);
  V.push({ id: `F6_reaction_taker|5m|${l}|${dir}|${e}->${l}|thr${thr}`, m: M(L) });
}
for (const [name, key, same] of [['mom1', 'prev1', true], ['rev1', 'prev1', false], ['mom3', 'prev3same', true], ['rev3', 'prev3same', false]]) V.push({ id: `F9_streak_taker|5m|s0|${name}`, m: M(obs.filter((o) => o[key] != null && o.d.s0).map((o) => leg(o, o.d.s0, (o[key] === 1) === same ? 'U' : 'D')).filter((x) => x.q >= 0.02 && x.q < 0.98)) });
const T = V.filter((v) => v.m.n >= 20 && v.m.days >= 5); const bh = benjaminiHochberg(T.map((v) => v.m.p), 0.10);
out.family = { all: V.map((v) => ({ id: v.id, n: v.m.n, win: v.m.win, cost: v.m.cost, roi: v.m.roi, p: v.m.p != null ? r4(v.m.p) : null })), variants: V.length, tested: T.length, bhSig: bh.nSig, positiveRoi: T.filter((v) => v.m.roi > 0).length, pBelow01: T.filter((v) => v.m.p < 0.01).length, top: T.slice().sort((a, b) => a.m.p - b.m.p).slice(0, 10).map((v) => ({ id: v.id, ...v.m })) };
console.log('family', JSON.stringify({ ...out.family, all: undefined, top: out.family.top.slice(0, 6) }));

// specific candidate cells
const preDown = legsFor('pre', 'down');
out.cells = {
  'pre|down|[0.55,0.60)': M(preDown.filter((l) => l.q >= 0.55 && l.q < 0.6)),
  'pre|up|[0.55,0.60)': M(legsFor('pre', 'up').filter((l) => l.q >= 0.55 && l.q < 0.6)),
  'pre|down|[0.5,0.6)': M(preDown.filter((l) => l.q >= 0.5 && l.q < 0.6)),
  'pre|tok|[0.55,0.65)': M(legsFor('pre', 'tok').filter((l) => l.q >= 0.55 && l.q < 0.65)),
  'f90|tok|[0.98,0.999)': M(legsFor('f90', 'tok').filter((l) => l.q >= 0.98 && l.q < 0.999)),
  'f90|tok|[0.98,0.999)_haircut0.2c': M(legsFor('f90', 'tok').filter((l) => l.q >= 0.98 && l.q < 0.999), 'c0'),
};
// calibration bin: 5m f90 folded [0.98,1)
{ const L = legsFor('f90', 'tok').filter((l) => l.q >= 0.98); const k = L.reduce((s, l) => s + l.win, 0); const pb = poissonBinomialTails(L.map((l) => l.q), k); out.cells['calibBin_f90_[0.98,1)'] = { n: L.length, meanPrice: r4(L.reduce((s, l) => s + l.q, 0) / L.length), winRate: r4(k / L.length), resid: r4(k / L.length - L.reduce((s, l) => s + l.q, 0) / L.length), pTwo: r4(2 * Math.min(pb.upper, pb.lower)) }; }
console.log('cells', JSON.stringify(out.cells));
// FLB logit slopes on the holdout
out.slopes = {};
for (const dk of ['pre', 's0', 'f25', 'f50', 'f75', 'f90']) {
  const rows = obs.filter((o) => o.d[dk] && o.d[dk].pSnap >= 0.02 && o.d[dk].pSnap <= 0.98); const X = rows.map((o) => [logit(o.d[dk].pSnap)]), Y = rows.map((o) => o.upWon); const b = logisticFit(X, Y);
  const byD = new Map(); rows.forEach((o, i) => { if (!byD.has(o.day)) byD.set(o.day, []); byD.get(o.day).push(i); }); const G = [...byD.values()]; const bs = []; let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let rep = 0; rep < 150; rep++) { const xs = [], ys = []; for (let g = 0; g < G.length; g++) for (const i of G[(rnd() * G.length) | 0]) { xs.push(X[i]); ys.push(Y[i]); } const bb = logisticFit(xs, ys, { iters: 12 }); if (bb) bs.push(bb[1]); }
  bs.sort((a, c) => a - c); out.slopes[dk] = { n: rows.length, slope: r4(b[1]), ci: [r4(bs[Math.floor(0.025 * bs.length)]), r4(bs[Math.floor(0.975 * bs.length)])] };
}
console.log('slopes', JSON.stringify(out.slopes));
// F4-style model fitted on the analyst's 5m sample (pre), applied to the holdout (out-of-time, backwards)
{
  const A = buildObs('5m').filter((o) => o.d.pre); const b = logisticFit(A.map((o) => [logit(o.d.pre.pSnap)]), A.map((o) => o.upWon));
  const L = []; for (const o of obs) { const d = o.d.pre; if (!d) continue; const pi = sigmoid(b[0] + b[1] * logit(d.pSnap)); if (pi - cost({ pInterp: d.pSnap }, 'U') >= 0.01 && d.pSnap >= 0.02 && d.pSnap < 0.98) L.push(leg(o, d, 'U')); else if (1 - pi - cost({ pInterp: d.pSnap }, 'D') >= 0.01 && d.pSnap > 0.02 && d.pSnap <= 0.98) L.push(leg(o, d, 'D')); }
  out.preLogitModelFromAnalystSample = { beta: b.map(r4), holdout: M(L) }; console.log('preLogitModel', JSON.stringify(out.preLogitModelFromAnalystSample));
}
fs.writeFileSync(path.join(HERE, 'out', 'holdout_5m.json'), JSON.stringify(out, null, 1));
