// Verifier (calibration family): direction / drift attack and the 4h reaction regression by regime.
//   node drift_check.mjs -> out/drift_check.json
// (a) Up-only rules can win from BTC's drift over the sample rather than from mispricing: compare Up vs Down legs of the
//     same rule and the drift-neutral pooled (tok) version; report BTC's move over IS/OOS from the Chainlink reference.
// (b) 4h f75->f90 reaction regression (logit upWon ~ logit p90 + (logit p90 - logit p75)) separately pre-fee vs v2.
import fs from 'node:fs';
import path from 'node:path';
import { buildObs } from './repro/obs.mjs';
import { chainlinkRefSeries } from '../../lib/load.mjs';
import { logisticFit, logit, clusterMeanTest } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'repro', 'out', 'cand_legs.json'), 'utf8'));
const out = {};
const ev = (legs) => { const n = legs.length; if (!n) return { n: 0 }; const w = legs.reduce((s, l) => s + l.win, 0); const ct = clusterMeanTest(legs, (l) => l.day, (l) => l.win / l.cost - 1); return { n, losses: n - w, win: r4(w / n), cost: r4(legs.reduce((s, l) => s + l.cost, 0) / n), roi: r4(ct.mean), t: r4(ct.t) }; };
for (const id of ['F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.3}', 'F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.2}', 'F1_band_taker|1h|f75|tok|{"lo":0.95,"hi":0.98}', 'F1_band_taker|15m|f25|tok|{"lo":0.9,"hi":0.95}', 'F1_band_taker|4h|f90|tok|{"lo":0.8,"hi":0.9}']) {
  const legs = D.variants[id].legs; const o = {};
  for (const sc of ['IS', 'OOS']) for (const tok of ['U', 'D']) o[`${sc}_${tok}`] = ev(legs.filter((l) => l.oos === (sc === 'OOS') && l.tok === tok));
  out[id] = o; console.log(id, JSON.stringify(o));
}
// BTC move over each tf's IS and OOS period (Chainlink reference, first/last value)
const ref = chainlinkRefSeries();
const at = (ts) => { let best = null; for (const [t, p] of ref) { if (t <= ts) best = p; else break; } return best; };
out.btcMove = {};
for (const tf of ['15m', '1h', '4h']) {
  const f = D.folds[tf]; const oosFrom = Date.parse(f.oosFrom + 'T00:00:00Z') / 1000;
  const first = ref.find(([t]) => t >= 0); const last = ref[ref.length - 1];
  const pOOS = at(oosFrom);
  out.btcMove[tf] = { oosFrom: f.oosFrom, refFirst: first && [new Date(first[0] * 1000).toISOString().slice(0, 10), Math.round(first[1])], refAtOosStart: pOOS && Math.round(pOOS), refLast: [new Date(last[0] * 1000).toISOString().slice(0, 10), Math.round(last[1])], oosReturn: pOOS ? r4(last[1] / pOOS - 1) : null };
}
console.log('btcMove', JSON.stringify(out.btcMove));
// (b) reaction regression by regime (4h, 1h)
out.reaction = {};
for (const tf of ['4h', '1h']) {
  const obs = buildObs(tf);
  for (const [rg, pred] of [['preFee', (o) => o.feeType == null], ['v2', (o) => o.feeType === 'crypto_fees_v2'], ['all', () => true]]) {
    const rows = obs.filter((o) => pred(o) && o.d.f75 && o.d.f90);
    const X = rows.map((o) => { const a = logit(o.d.f90.pSnap), b = logit(o.d.f75.pSnap); return [a, a - b]; }); const Y = rows.map((o) => o.upWon);
    const beta = logisticFit(X, Y);
    const byD = new Map(); rows.forEach((o, i) => { if (!byD.has(o.day)) byD.set(o.day, []); byD.get(o.day).push(i); }); const G = [...byD.values()];
    const bs = []; let s = 1; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    for (let rep = 0; rep < 300; rep++) { const xs = [], ys = []; for (let g = 0; g < G.length; g++) for (const i of G[(rnd() * G.length) | 0]) { xs.push(X[i]); ys.push(Y[i]); } const b = logisticFit(xs, ys, { iters: 12 }); if (b) bs.push(b[2]); }
    bs.sort((a, b) => a - b);
    out.reaction[`${tf}_${rg}`] = { n: rows.length, slopeLate: r4(beta[1]), changeCoef: r4(beta[2]), ci: [r4(bs[Math.floor(0.025 * bs.length)]), r4(bs[Math.floor(0.975 * bs.length)])] };
  }
}
console.log('reaction', JSON.stringify(out.reaction));
fs.writeFileSync(path.join(HERE, 'out', 'drift_check.json'), JSON.stringify(out, null, 1));
