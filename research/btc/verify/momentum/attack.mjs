// Adversarial re-evaluation of the momentum family candidates.
//   LAG=16 LATENCY=5 node --max-old-space-size=6144 attack.mjs   (defaults = analyst conventions)
// Rebuilds the analyst's 249 variants from mod/build.mjs (byte-identical logic, LAG/LATENCY from env),
// re-runs the walk-forward, and for each candidate computes: fee / haircut stress, OOS first vs second half,
// train vs OOS, fixed-theta profile by half of the full sample, day-bootstrap CIs and p, BH over all 249.
// Saves OOS trades of the candidates for the fill-realism check (fills.mjs / exec.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { variants, CAP } from './mod/build.mjs';
import { walkForward, bootstrap, summarize, benjaminiHochberg, fmt, pnlOf, HEADLINE, LAG, LATENCY } from './mod/lib.mjs';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.mkdirSync(OUT, { recursive: true });
const TAG = `LAG${LAG}_LAT${LATENCY}`;

export const CANDIDATES = [
  'A-mag-rev-5m', 'A-streak-rev-1h', 'W-lvl-mom-5m-f0.2', 'MA-streak-rev-1h', 'TM-prev-rev-5m-at', 'W-lvl-mom-15m-f0.2',
  'X-cnt-mom-1h-from-15m', 'A-last5-mom-1h', 'A-prev-rev-4h', 'MA-prev-rev-4h', 'W-vel-mom-1d-f0.4', 'W-lvl-mom-5m-f0.4',
  'A-prev-mom-5m', 'A-prev-rev-5m', 'A-prev-rev-15m', 'A-prev-rev-1h', 'A-prev-mom-1d', 'A-lastmin-rev-5m', 'W-lvl-mom-1h-f0.4',
  'W-vel-rev-1h-f0.4', 'X-cnt-mom-15m-from-5m', 'X-gap-1h-from-5m', 'X-gap-15m-from-5m', 'X-cnt-mom-4h-from-1h', 'T-ofi-mom-5m',
  'MA-prev-rev-5m', 'MW-lvl-mom-1h-f0.4', 'TM-prev-rev-5m-thru',
  // positive-point-estimate variants the analyst did not list (checked so nothing is hiding there)
  'W-lvl-rev-1d-f0.2', 'TA-mag-mom-15m', 'MW-vel-mom-1d-f0.8', 'W-vel-mom-1d-f0.8', 'MX-cnt-mom-1d-from-4h', 'X-cnt-mom-1d-from-4h', 'MA-mag-mom-1d',
];

const bs = (tr, days, opt = {}) => { const b = bootstrap(tr, days, { B: 2000, ...opt }); return { roi: fmt(b.roi), ci: [fmt(b.ci[0]), fmt(b.ci[1])], p: fmt(b.p, 4) }; };
const summ = (tr, model = HEADLINE, hc = 0.01) => { const s = summarize(tr, model, hc); return { n: s.n, win: fmt(s.winRate), cost: fmt(s.avgCost), edge: fmt(s.edge), roi: fmt(s.roi) }; };

const all = [];
const cand = {};
for (const v of variants) {
  const wf = walkForward({ days: v.days, nWinByDay: v.nWin, thetas: v.thetas, tradesFor: v.tradesFor, minAbs: v.minAbs ?? 15 });
  const b = bootstrap(wf.oos, wf.oosDays, { B: 2000 });
  all.push({ id: v.id, p: b.p, roi: b.roi, n: wf.oos.length });
  if (!CANDIDATES.includes(v.id)) continue;
  const oos = wf.oos, D = wf.oosDays;
  const half = Math.floor(D.length / 2);
  const D1 = D.slice(0, half), D2 = D.slice(half);
  const s1 = new Set(D1), s2 = new Set(D2);
  const o1 = oos.filter((t) => s1.has(t.day)), o2 = oos.filter((t) => s2.has(t.day));
  // training-period performance of the thresholds actually chosen (each block's theta on its own training days)
  const trainDays = wf.trainDays;
  // fixed-theta profile over the FULL sample (in-sample by construction), split into halves of all days
  const H = Math.floor(v.days.length / 2), F1 = new Set(v.days.slice(0, H));
  const profile = v.thetas.map((th) => {
    const tr = v.tradesFor(th);
    const a = tr.filter((t) => F1.has(t.day)), c = tr.filter((t) => !F1.has(t.day));
    return { theta: th, n: tr.length, roi: fmt(summarize(tr).roi), roiH1: fmt(summarize(a).roi), nH1: a.length, roiH2: fmt(summarize(c).roi), nH2: c.length };
  });
  const thetaCounts = {}; for (const c of wf.choices) thetaCounts[c.theta] = (thetaCounts[c.theta] || 0) + 1;
  const modal = Number(Object.entries(thetaCounts).sort((a, b) => b[1] - a[1])[0][0]);
  const trainTr = v.tradesFor(modal).filter((t) => t.day < D[0]);
  cand[v.id] = {
    id: v.id, tf: v.tf, maker: !!v.maker, nOosDays: D.length, oosRange: `${D[0]}..${D[D.length - 1]}`, choices: wf.choices.map((c) => c.theta),
    headline: { ...summ(oos), ...bs(oos, D) },
    fee: { docs: summ(oos, 'docs'), minp: { ...summ(oos, 'minp'), ...bs(oos, D, { model: 'minp' }) }, flat2: summ(oos, 'flat2'), zero: summ(oos, 'zero') },
    haircut: { h2c: { ...summ(oos, HEADLINE, 0.02), ...bs(oos, D, { haircut: 0.02 }) }, h3c: summ(oos, HEADLINE, 0.03) },
    split: { firstHalf: { range: `${D1[0]}..${D1[D1.length - 1]}`, ...summ(o1), ...bs(o1, D1) }, secondHalf: { range: `${D2[0]}..${D2[D2.length - 1]}`, ...summ(o2), ...bs(o2, D2) } },
    trainModalTheta: { theta: modal, ...summ(trainTr) },
    profile,
    tradesPerDay: fmt(oos.length / D.length, 2), capPerTrade: CAP[v.tf],
    trades: oos.map((t) => ({ day: t.day, t: t.t, side: t.side, pRef: t.pRef, win: t.win, id: t.id, feeType: t.feeType ?? null, mk: !!t.mk, ex: t.ex ?? null, pRefNext: t.pRefNext ?? null })),
  };
}
const bh = benjaminiHochberg(all.map((r) => r.p ?? 1), 0.10);
all.forEach((r, i) => { r.bhAdj = fmt(bh.adj[i], 4); r.bhSig = bh.sig[i]; });
for (const r of all) if (cand[r.id]) { cand[r.id].bhAdj = r.bhAdj; cand[r.id].bhSig = r.bhSig; }
const sortedP = all.map((r) => r.p).sort((a, b) => a - b);
fs.writeFileSync(path.join(OUT, `attack_${TAG}.json`), JSON.stringify({ tag: TAG, nVariants: all.length, nBHsig: all.filter((r) => r.bhSig).length, smallestP: sortedP.slice(0, 5), bhThresholdRank1: 0.1 / all.length, candidates: cand }, null, 1));
console.log(TAG, 'variants', all.length, 'BH-sig', all.filter((r) => r.bhSig).length, 'smallest p', sortedP.slice(0, 5).map((x) => fmt(x, 4)).join(' '));
for (const c of Object.values(cand)) {
  console.log(c.id.padEnd(24), 'n', String(c.headline.n).padStart(5), 'roi', c.headline.roi, 'CI', JSON.stringify(c.headline.ci), 'p', c.headline.p,
    '| minp', c.fee.minp.roi, '| 2c', c.haircut.h2c.roi, '| H1', c.split.firstHalf.roi, `(n${c.split.firstHalf.n})`, 'H2', c.split.secondHalf.roi, `(n${c.split.secondHalf.n})`, '| train', c.trainModalTheta.roi, `(n${c.trainModalTheta.n})`);
}
