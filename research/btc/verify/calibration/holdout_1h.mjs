// Verifier (calibration family): older independent holdout for the 1h candidates.
// Holdout = 3,151 hourly Up/Down markets 2025-05-23 .. 2025-10-22 (pre-fee era, feeType null) from the momentum
// verifier's verify/momentum/data/updown_1h_ext.jsonl; the analyst's 1h sample starts 2025-10-22. Costs: the current
// v2 fee applied anyway (docs_always) + 1c haircut, interp execution (same as the analyst's headline).
//   node holdout_1h.mjs -> out/holdout_1h.json
import fs from 'node:fs';
import path from 'node:path';
import * as fees from '../../lib/fees.mjs';
import { decisionAt, FRACS, buildObs } from './repro/obs.mjs';
import { clusterMeanTest, poissonBinomialTails, logisticFit, logit, sigmoid } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const recs = fs.readFileSync(path.join(HERE, '..', 'momentum', 'data', 'updown_1h_ext.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.path && r.path.length && (r.winner === 'Up' || r.winner === 'Down')).sort((a, b) => a.windowStart - b.windowStart);
const obs = []; let prev = null;
for (const r of recs) {
  const o = { day: r.day, upWon: r.upWon ? 1 : 0, prev1: prev && prev.windowEnd === r.windowStart ? (prev.upWon ? 1 : 0) : null, d: {} };
  for (const fr of FRACS) { const dd = decisionAt(r, Math.floor(r.windowStart + fr.f * 3600), 120); if (dd) o.d[fr.key] = dd; }
  obs.push(o); prev = r;
}
const cost = (p, tok) => { const ref = tok === 'U' ? p : 1 - p; const ex = Math.min(0.999, Math.max(0.001, ref + 0.01)); return ex + fees.takerFeePerShare(ex, undefined, 'docs_always'); };
const leg = (o, d, tok) => ({ day: o.day, q: tok === 'U' ? d.pSnap : 1 - d.pSnap, win: tok === 'U' ? o.upWon : 1 - o.upWon, c: cost(d.pInterp, tok) });
function M(L) { if (!L.length) return { n: 0 }; const tr = L.map((l) => ({ day: l.day, w: l.win, c: l.c, y: l.win / l.c - 1 })); const ct = clusterMeanTest(tr, (x) => x.day, (x) => x.y); const w = tr.reduce((s, x) => s + x.w, 0); return { n: tr.length, days: ct.days, win: r4(w / tr.length), cost: r4(tr.reduce((s, x) => s + x.c, 0) / tr.length), roi: r4(ct.mean), t: r4(ct.t), p: r4(Math.max(ct.pOne, poissonBinomialTails(tr.map((x) => Math.min(1, x.c)), w).upper)) }; }
const out = { holdout: { n: recs.length, first: recs[0].day, last: recs.at(-1).day } };
const up = []; const dn = [];
for (const o of obs) { const d = o.d.f75; if (!d) continue; up.push(leg(o, d, 'U')); dn.push(leg(o, d, 'D')); }
out.F1_1h_f75_up_095_098 = M(up.filter((l) => l.q >= 0.95 && l.q < 0.98));
out.F1_1h_f75_down_095_098 = M(dn.filter((l) => l.q >= 0.95 && l.q < 0.98));
out.F1_1h_f75_tok_095_098 = M(up.concat(dn).filter((l) => l.q >= 0.95 && l.q < 0.98));
// F4-style 1h f75 logit model fitted on the analyst's full 1h sample, applied to the holdout
const A = buildObs('1h').filter((o) => o.d.f75); const b = logisticFit(A.map((o) => [logit(o.d.f75.pSnap)]), A.map((o) => o.upWon));
const L = []; for (const o of obs) { const d = o.d.f75; if (!d) continue; const pi = sigmoid(b[0] + b[1] * logit(d.pSnap)); if (pi - cost(d.pSnap, 'U') >= 0.01 && d.pSnap >= 0.02 && d.pSnap < 0.98) L.push(leg(o, d, 'U')); else if (1 - pi - cost(d.pSnap, 'D') >= 0.01 && d.pSnap > 0.02 && d.pSnap <= 0.98) L.push(leg(o, d, 'D')); }
out.F4_1h_f75_modelFromAnalystSample = { beta: b.map(r4), holdout: M(L) };
// streak on holdout
const S = obs.filter((o) => o.prev1 != null); const same = S.filter((o) => o.upWon === o.prev1).length;
out.streak = { n: S.length, pSame: r4(same / S.length), rev1Taker: M(S.filter((o) => o.d.s0).map((o) => leg(o, o.d.s0, o.prev1 === 1 ? 'D' : 'U')).filter((l) => l.q >= 0.02 && l.q < 0.98)) };
// slope at f75 on holdout
{ const rows = obs.filter((o) => o.d.f75 && o.d.f75.pSnap >= 0.02 && o.d.f75.pSnap <= 0.98); const bb = logisticFit(rows.map((o) => [logit(o.d.f75.pSnap)]), rows.map((o) => o.upWon)); out.slope_f75 = { n: rows.length, slope: r4(bb[1]) }; }
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(HERE, 'out', 'holdout_1h.json'), JSON.stringify(out, null, 1));
