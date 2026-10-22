// Compact per-rule summary from reports/calibration/results.json (for hand-off): best OOS variant per
// (family, tf), all walk-forward procedures, and sensitivity / tape columns. Writes rule_summary.json and prints a table.
import fs from 'node:fs';
const DIR = '/home/user/CENTISPORT/research/btc/reports/calibration';
const R = JSON.parse(fs.readFileSync(`${DIR}/results.json`, 'utf8'));
const csv = fs.readFileSync(`${DIR}/variants.csv`, 'utf8').trim().split('\n');
const head = csv[0].split(',');
const parse = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const rows = csv.slice(1).map((l) => Object.fromEntries(parse(l).map((v, i) => [head[i], v])));
const tested = rows.filter((r) => r.tested === 'true');
console.log('defined', rows.length, 'tested', tested.length, 'BH sig', tested.filter((r) => r.bh_sig === 'true').length);
const fam = {};
for (const r of tested) { const k = `${r.family}|${r.tf}`; if (!fam[k] || +r.oos_p < +fam[k].oos_p || (+r.oos_p === +fam[k].oos_p && +r.oos_t > +fam[k].oos_t)) fam[k] = r; }
console.log('\nBest OOS variant (smallest p) per family x tf (headline costs):');
for (const [k, r] of Object.entries(fam).sort()) console.log(`${k.padEnd(28)} ${r.decision.padEnd(4)} ${r.side.padEnd(5)} ${r.params.padEnd(42)} IS roi=${(r.is_roi || '-').padEnd(7)} OOS n=${r.oos_n.padEnd(5)} win=${r.oos_winRate.padEnd(6)} cost=${r.oos_avgCost.padEnd(6)} edge=${r.oos_edge.padEnd(7)} roi=${r.oos_roi.padEnd(7)} [${r.oos_roi_lo},${r.oos_roi_hi}] t=${r.oos_t} p=${r.oos_p} q=${r.bh_q}`);
const famStats = {};
for (const r of tested) { const k = r.family; famStats[k] ??= { tested: 0, posEdge: 0, p05: 0, sumN: 0 }; const f = famStats[k]; f.tested++; if (+r.oos_edge > 0) f.posEdge++; if (+r.oos_p < 0.05) f.p05++; f.sumN += +r.oos_n; }
console.log('\nPer family: tested, share with positive OOS edge, # with p<0.05 (expected by chance ~5%)');
for (const [k, f] of Object.entries(famStats)) console.log(`${k.padEnd(28)} tested=${f.tested} posEdge=${(f.posEdge / f.tested).toFixed(2)} p<0.05: ${f.p05} (chance ${(0.05 * f.tested).toFixed(1)})`);
const pick = (v) => ({ id: v.id, rule: v.rule, tf: v.tf, kind: v.kind, family: v.family, is: v.is && { n: v.is.n, roi: v.is.roi, t: v.is.t }, oos: v.oos, bhQ: v.bhQ, bhSig: v.bhSig, tradesPerDay: v.tradesPerDay, capacityUSDperDay: v.capacityUSDperDay, sens: v.sens, tape: v.tape });
const all = [...R.walkForward, ...R.topByOosT];
const uniq = new Map(all.map((v) => [v.id, v]));
fs.writeFileSync(`${DIR}/rule_summary.json`, JSON.stringify({ variantCounts: R.variantCounts, familyStats: famStats, bestPerFamilyTf: fam, rules: [...uniq.values()].map(pick) }, null, 1));
