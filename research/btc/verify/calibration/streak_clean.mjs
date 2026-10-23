// Verifier (calibration family): look-ahead-clean re-test of the F9 streak (previous-window reversal) rules.
// The analyst decides at the last snapshot <= windowStart (up to 120 s BEFORE the previous window has resolved) yet
// conditions on the previous window's final result. Clean version: decide at the first snapshot with t >= S + 15 s
// (the previous result is final at S), execute at the analyst's 'interp' price + 1c + v2 fee (docs_always).
//   node streak_clean.mjs -> out/streak_clean.json
import fs from 'node:fs';
import path from 'node:path';
import * as fees from '../../lib/fees.mjs';
import { loadUpDown } from '../../lib/load.mjs';
import { decisionAt } from './repro/obs.mjs';
import { clusterMeanTest, poissonBinomialTails } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const out = {};
for (const tf of ['15m', '1h', '4h']) {
  const recs = loadUpDown(tf).filter((r) => r.path && r.path.length && (r.winner === 'Up' || r.winner === 'Down'));
  const days = [...new Set(recs.map((r) => r.day))].sort(); const oosFrom = days[Math.ceil(0.4 * days.length)];
  const legs = { orig: [], clean: [] };
  for (let i = 1; i < recs.length; i++) {
    const r = recs[i], p = recs[i - 1]; if (p.windowEnd !== r.windowStart) continue;
    const tok = p.upWon ? 'D' : 'U'; // reversal side
    const win = (tok === 'U') === !!r.upWon ? 1 : 0;
    const dO = decisionAt(r, r.windowStart, 120);
    const k = r.path.findIndex(([t]) => t >= r.windowStart + 15);
    const dC = k >= 0 && r.path[k][0] - r.windowStart <= 135 ? decisionAt(r, r.path[k][0], 0) : null;
    for (const [key, d] of [['orig', dO], ['clean', dC]]) {
      if (!d) continue; const q = tok === 'U' ? d.pSnap : 1 - d.pSnap; if (q < 0.02 || q >= 0.98) continue;
      const ref = tok === 'U' ? d.pInterp : 1 - d.pInterp; const ex = Math.min(0.999, Math.max(0.001, ref + 0.01)); const c = ex + fees.takerFeePerShare(ex, undefined, 'docs_always');
      legs[key].push({ day: r.day, oos: r.day >= oosFrom, v2: r.fee?.feeType === 'crypto_fees_v2', q, c, win, y: win / c - 1, lead: r.windowStart - d.tDec });
    }
  }
  out[tf] = {};
  for (const key of ['orig', 'clean']) for (const [sc, f] of [['OOS', (l) => l.oos], ['v2', (l) => l.v2], ['ALL', () => true]]) {
    const L = legs[key].filter(f); if (!L.length) continue;
    const ct = clusterMeanTest(L, (l) => l.day, (l) => l.y); const w = L.reduce((s, l) => s + l.win, 0);
    out[tf][`${key}_${sc}`] = { n: L.length, win: r4(w / L.length), avgTokPrice: r4(L.reduce((s, l) => s + l.q, 0) / L.length), cost: r4(L.reduce((s, l) => s + l.c, 0) / L.length), roi: r4(ct.mean), t: r4(ct.t), p: r4(Math.max(ct.pOne, poissonBinomialTails(L.map((l) => l.c), w).upper)), medianDecisionLeadSec: L.map((l) => l.lead).sort((a, b) => a - b)[L.length >> 1] };
  }
  console.log(tf, JSON.stringify(out[tf]));
}
fs.writeFileSync(path.join(HERE, 'out', 'streak_clean.json'), JSON.stringify(out, null, 1));
