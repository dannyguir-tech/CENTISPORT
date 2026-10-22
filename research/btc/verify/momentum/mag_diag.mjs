// A-mag-rev mechanism check: by |z| bin and sign, the reversal side's mid, win rate, pre-cost edge, after-cost ROI (docs 0.07p(1-p), 1c and 2c)
import { featA, buildCL } from './mod/features.mjs';
import { fmt } from './mod/lib.mjs';
const CL = buildCL();
const fee = (p) => 0.07 * p * (1 - p);
for (const tf of ['5m', '15m', '1h', '4h']) {
  const rows = featA(tf, CL).filter((r) => r.zMag != null);
  const days = [...new Set(rows.map((r) => r.day))].sort(); const half = new Set(days.slice(0, Math.floor(days.length / 2)));
  const bins = [[0, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, 3], [3, 4], [4, 99]];
  console.log(`\n${tf}: rows ${rows.length}, days ${days[0]}..${days[days.length - 1]}`);
  for (const [lo, hi] of bins) for (const sg of ['all', 'up', 'down']) {
    const c = rows.filter((r) => Math.abs(r.zMag) >= lo && Math.abs(r.zMag) < hi && (sg === 'all' || (sg === 'up' ? r.zMag > 0 : r.zMag < 0)));
    if (c.length < 5) continue;
    const ag = (cc) => { let n = 0, w = 0, sp = 0, r1 = 0, r2 = 0; for (const r of cc) { const up = r.zMag < 0; const pr = up ? r.p : 1 - r.p; if (pr < 0.03 || pr > 0.95) continue; const win = up ? r.win : !r.win; n++; w += win; sp += pr; const c1 = pr + 0.01 + fee(pr + 0.01), c2 = pr + 0.02 + fee(pr + 0.02); r1 += win / c1 - 1; r2 += win / c2 - 1; } return { n, win: fmt(w / n, 3), mid: fmt(sp / n, 3), edgePre: fmt((w - sp) / n, 3), roi1c: fmt(r1 / n, 3), roi2c: fmt(r2 / n, 3) }; };
    const A = ag(c), H1 = ag(c.filter((r) => half.has(r.day))), H2 = ag(c.filter((r) => !half.has(r.day)));
    console.log(`  |z| ${lo}-${hi} ${sg.padEnd(4)} n ${String(A.n).padStart(5)} mid ${A.mid} win ${A.win} edgePre ${A.edgePre} roi1c ${A.roi1c} roi2c ${A.roi2c} | H1 n${H1.n} roi1c ${H1.roi1c} | H2 n${H2.n} roi1c ${H2.roi1c}`);
  }
}
