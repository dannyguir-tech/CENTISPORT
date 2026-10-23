#!/usr/bin/env node
// Assemble the per-rule headline table (reports/structure/rules_final.json) from the analysis outputs:
//   P  print-verified walk-forward OOS (pl60: last ask-side taker print of every leg within 60 s before T) -> HEADLINE for arbs
//   M  mid-screen walk-forward OOS (price-history mid + max(1c, half-spread) + fee) -> context only (not executable)
//   L  live books (taker), per session
//   I  implied-state statistical rules: mid WF OOS and print re-pricing
//   K  maker-legged simulation (walk-forward session0 -> session1)
import fs from 'node:fs';
import path from 'node:path';
import { REPORT, r4, writeJSON } from './common.mjs';

const R = JSON.parse(fs.readFileSync(path.join(REPORT, 'results.json'), 'utf8'));
const csv = fs.readFileSync(path.join(REPORT, 'variants.csv'), 'utf8').trim().split('\n');
const cols = csv[0].split(',');
const parseLine = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return Object.fromEntries(cols.map((c, i) => [c, out[i]])); };
const V = csv.slice(1).map(parseLine);
const num = (x) => (x === '' || x == null || x === 'NaN' ? null : Number(x));
const find = (pred) => V.find(pred) || null;
const IP = JSON.parse(fs.readFileSync(path.join(REPORT, 'implied', 'print_check.json'), 'utf8'));
const MK = JSON.parse(fs.readFileSync(path.join(REPORT, 'maker', 'maker_sim.json'), 'utf8'));
const LIVE = R.live;
const PS = fs.existsSync(path.join(REPORT, 'printscan', 'summary.json')) ? JSON.parse(fs.readFileSync(path.join(REPORT, 'printscan', 'summary.json'), 'utf8')) : null;
const SCRIPT = '/home/user/CENTISPORT/research/btc/analysis/structure/';

const FAM = {
  above_daily_mono: ['P(BTC noon-ET close > K) must fall as K rises (bitcoin-above-on-<date> ladder)', 'daily ladder (~7-day life)', 'buy YES(K1)+NO(K2), K1<K2 (<=3 strikes apart hist; all pairs live), pays >=1'],
  above_hourly_mono: ['P(1h close > K) must fall as K rises (bitcoin-multi-strikes-hourly)', 'hourly ladder (~80 min life)', 'buy YES(K1)+NO(K2), K1<K2, pays >=1'],
  hit_daily_mono: ['P(hit K) must fall as K moves away from spot (what-price-will-bitcoin-hit-on-<date>)', 'daily barrier', 'buy YES(easier barrier)+NO(harder barrier), same direction, pays >=1'],
  hit_weekly_mono: ['P(hit K) monotone in K (weekly barrier ladder)', 'weekly barrier', 'buy YES(easier)+NO(harder), pays >=1'],
  hit_monthly_mono: ['P(hit K) monotone in K (monthly barrier ladder)', 'monthly barrier', 'buy YES(easier)+NO(harder), pays >=1'],
  range_allyes: ['neg-risk price buckets (bitcoin-price-on-<date>) sum to 1', 'daily buckets', 'buy YES of every bucket, pays exactly 1'],
  range_allno: ['neg-risk buckets: NO side sums to n-1', 'daily buckets', 'buy NO of every bucket, pays exactly n-1'],
  above_vs_range: ['P(close > K) on the above ladder = sum of buckets above K (same Binance noon candle)', 'daily ladder vs buckets', 'YES(>K)+YES(buckets<K) or NO(>K)+YES(buckets>=K), pays >=1'],
  hit_vs_above_daily: ['P(hit_up K in day) >= P(noon close > K\') for K\' >= K (and mirror for hit_down)', 'daily barrier vs daily ladder', 'YES(hit_up K)+NO(above K\'>=K) or YES(hit_dn K)+YES(above K\'\'<=K), pays >=1'],
  hit_vs_above_weekly: ['P(hit K in week) >= P(noon close inside week > K\')', 'weekly barrier vs daily ladder', 'same basket as hit_vs_above_daily'],
  hit_vs_above_monthly: ['P(hit K in month) >= P(noon close inside month > K\')', 'monthly barrier vs daily ladder', 'same basket as hit_vs_above_daily'],
  hit_nest_wd: ['hit in a day inside the week => hit in the week', 'weekly vs daily barrier', 'YES(weekly K)+NO(daily K\' at least as far), pays >=1'],
  hit_nest_md: ['hit in a day inside the month => hit in the month', 'monthly vs daily barrier', 'YES(monthly K)+NO(daily K\'), pays >=1'],
  hit_nest_mw: ['hit in a week inside the month => hit in the month', 'monthly vs weekly barrier', 'YES(monthly K)+NO(weekly K\'), pays >=1'],
  daily_ud_vs_above: ['daily Up/Down and the above ladder settle on the same Binance noon-ET close; Up <=> close >= priceToBeat', 'daily (in-play window)', 'UP+NO(above K_hi>ptb) or DOWN+YES(above K_lo<ptb), pays >=1'],
  hourly_ud_vs_above_hourly: ['hourly Up/Down and the hourly ladder settle on the same Binance 1h candle', 'hourly', 'UP+NO(above K_hi>open) or DOWN+YES(above K_lo<open), pays >=1'],
  nest_cl_15m_5m: ['15m and its last 5m window share the Chainlink final print: if ptb_5m >= ptb_15m then Up_5m => Up_15m', '15m vs 5m (last 5 min)', 'UP(15m)+DOWN(5m) if ptb_5m>=ptb_15m else DOWN(15m)+UP(5m), pays >=1'],
  nest_cl_4h_15m: ['4h and its last 15m window share the Chainlink final print', '4h vs 15m (last 15 min)', 'UP(4h)+DOWN(15m) or mirror, pays >=1'],
  nest_cl_4h_5m: ['4h and its last 5m window share the Chainlink final print', '4h vs 5m (last 5 min)', 'UP(4h)+DOWN(5m) or mirror, pays >=1'],
  complement_sum: ['within one market Yes ask + No ask >= 1 (unified CLOB)', 'all open BTC markets', 'buy Yes+No at the asks, pays 1 (live only)'],
  nest_basis_1h_15m: ['hourly (Binance) vs its last 15m (Chainlink) window: same logic as nest_cl but across oracles (NOT risk-free)', '1h vs 15m', 'nested basket, oracle basis risk'],
  nest_basis_1h_5m: ['hourly (Binance) vs its last 5m (Chainlink) window (NOT risk-free)', '1h vs 5m', 'nested basket, oracle basis risk'],
  nest_basis_1d_4h: ['daily (Binance) vs its last 4h (Chainlink) window (NOT risk-free)', '1d vs 4h', 'nested basket, oracle basis risk'],
  nest_basis_1h_15m_b100: ['as nest_basis_1h_15m but only when |ptb_inner - ptb_outer| >= $100 (basis buffer)', '1h vs 15m', 'nested basket, |d|>=100'],
  nest_basis_1h_5m_b100: ['as nest_basis_1h_5m with $100 buffer', '1h vs 5m', 'nested basket, |d|>=100'],
  nest_basis_1d_4h_b100: ['as nest_basis_1d_4h with $100 buffer', '1d vs 4h', 'nested basket, |d|>=100'],
};
const rows = [];
const liveFam = (f) => Object.entries(LIVE.scopes).filter(([k]) => k !== 'all').map(([k, sc]) => [k, sc.families[f]]).filter(([, o]) => o);
for (const [f, [hyp, tf, basket]] of Object.entries(FAM)) {
  const p = (fee) => find((v) => v.group === 'P' && v.family === f && v.scenario === 'pl60' && v.fee === fee && v.mode === 'walk-forward');
  const m = find((v) => v.group === 'M' && v.family === f && v.scenario === 'hc1' && v.fee === 'docs_always' && v.mode === 'walk-forward');
  const mFlat = find((v) => v.group === 'M' && v.family === f && v.scenario === 'hc1' && v.fee === 'flat2' && v.mode === 'walk-forward');
  const P0 = p('docs_always'), Pd = p('docs'), Pf = p('flat2');
  const ep = R.episodeSummary[f], vs = R.verifySummary[f];
  const lv = liveFam(f);
  const lvAll = LIVE.scopes.all.families[f];
  const riskFree = !f.startsWith('nest_basis');
  const liveTxt = lv.length ? lv.map(([k, o]) => `${k}: ${o.instances} inst / ${o.priced} priced, ${o.violatingSnapshotInstances} taker-violating, max margin ${o.maxMargin}, max profit $${o.maxProfitUsd}`).join('; ') : 'no live instances';
  const roiTxt = [
    P0 ? `PRINT pl60 WF OOS: docs_always ${num(P0.roi)}, docs ${Pd ? num(Pd.roi) : '-'}, flat2 ${Pf ? num(Pf.roi) : '-'}, zero n/a` : 'PRINT pl60 WF OOS: no trades (no leg had a qualifying ask-side print within 60 s)',
    m ? `MID-screen WF OOS (NOT executable): docs_always ${num(m.roi)} n=${m.n}, flat2 ${mFlat ? num(mFlat.roi) : '-'}` : 'MID-screen: none',
    `LIVE books (taker, fee docs${riskFree ? '' : '; NOT risk-free: margin assumes Binance = Chainlink, which is false'}): ${liveTxt}`,
  ].join(' | ');
  const capP = P0 ? num(P0.capacityUsdPerDay) : 0;
  // live capacity upper bound over POLLED hours only (sum of per-session episode max profits / polled hours * 24)
  const sessL = Object.entries(LIVE.scopes).filter(([k]) => k !== 'all');
  const polledH = sessL.reduce((a, [, sc]) => a + sc.hours, 0);
  const capL = lvAll ? r4(sessL.reduce((a, [, sc]) => a + (sc.families[f] ? sc.families[f].episodeMaxProfitUsdSum : 0), 0) / polledH * 24) : null;
  const notes = [
    ep ? `mid violation episodes ${ep.episodes} (exec on mid+half-spread+fee ${ep.execOnMidPlusHalfSpread}), duration p50 ${ep.durSec.p50}s p90 ${ep.durSec.p90}s, max mid violation p50 ${ep.maxViolation.p50} p90 ${ep.maxViolation.p90}` : 'no historical episodes (live-only family)',
    vs ? `print check of ${vs.sampled} sampled exec-episodes: ${vs.legsWithNoPrints} had a leg with no ask-side print in the window, pl60 available ${vs.pl60Available}, pl60 arb ${vs.pl60Arb} (median margin ${vs.medianPl60Margin})` : '',
    riskFree ? 'risk-free payoff bound (oracle alignment verified on settled data)' : 'NOT risk-free: Binance vs Chainlink oracle basis (median |diff| $39-51)',
  ].filter(Boolean).join('; ');
  let verdict = 'no-edge';
  const cw = PS ? PS.variants.find((v) => v.family === f && v.mode === 'walk-forward') : null;
  if (cw) {
    const fsx = PS.families[f];
    const byW = Object.entries(fsx.byW).map(([W, o]) => `W${W}s: ${o.pairsWithViolation}/${fsx.pairs} pairs violated (dur p50 ${o.violSecP50}s p90 ${o.violSecP90}s, max-margin p50 ${o.maxMarginP50})`).join('; ');
    const cwRow = V.find((v) => v.group === 'C' && v.family === f && v.mode === 'walk-forward' && v.scenario.startsWith('lastPrint'));
    const cfRow = V.find((v) => v.group === 'C' && v.family === f && v.mode === 'walk-forward' && v.scenario.startsWith('followThrough'));
    rows.push({ id: f + '_printcensus', hypothesis: hyp + ' -- print-first census (every taker print, not mid-preselected)', timeframe: tf,
      rule: `${basket}. At each taker print time T (only prints <= T): latest ask-side print of each leg no older than W s; enter once per pair when 1 - sum(p + 0.07p(1-p)) > theta. (W, theta) in {10,30,60}s x {0,1,2}c chosen on the first 40% of days (chosen W=${cw.W}, theta=${cw.theta}); OOS ${cw.oosFrom}..${cw.oosTo}.`,
      makerOrTaker: 'taker', oosN: cw.n, winRate: cw.winRate, avgCost: cw.avgCost,
      roiAfterFees: `docs_always (= docs: all v2): last-print ${cw.roi} CI [${cw.ci.join(', ')}]; follow-through (first ask print of each leg after T, <=15 s) ${cw.folRoi} n=${cw.folN} CI ${cw.folCi ? '[' + cw.folCi.join(', ') + ']' : 'n/a'}; zero-fee would add ~1.75c/leg at p=0.5`,
      ci95: `[${cw.ci.join(', ')}]`, bhSignificant: cwRow ? cwRow.bh === 'true' : false,
      capacityPerDay: `last-print $${cw.usdPerDay}/day, follow-through $${cw.usdPerDayFollow}/day (sizes = min print size of the legs, median ${cw.medSize} sh${f === 'nest_cl_15m_5m' ? '; scaled from the 600-pair sample to all pairs' : ''})`,
      verdict: 'no-edge', notes: `${fsx.pairs} pairs ${fsx.from}..${fsx.to}; ${byW}. follow-through BH ${cfRow ? cfRow.bh : 'n/a'}.`, scriptPath: SCRIPT + 'print_scan.mjs' });
  }
  const pRoi = P0 ? num(P0.roi) : null;
  rows.push({ id: f, hypothesis: hyp, timeframe: tf, rule: `${basket}. Decision each minute (hist) / each poll (live) at T using only data <= T: enter one share-set when taker basket cost (ask + 0.07p(1-p) per leg) < minPay - theta; theta in {0,0.5,1,2,4}c chosen walk-forward on earlier days; 10-min cooldown per relation.`,
    makerOrTaker: 'taker', oosN: P0 ? num(P0.n) : 0, winRate: P0 ? num(P0.winRate) : null, avgCost: P0 ? num(P0.avgCost) : null, roiAfterFees: roiTxt, ci95: P0 ? P0.ci.replace(/;/g, ', ') : 'n/a', bhSignificant: P0 ? P0.bh === 'true' : false,
    capacityPerDay: riskFree ? `print-verified ~$${capP ?? 0}/day; live taker upper bound $${capL ?? 0}/day (over ${r4(polledH)} polled hours)` : `print-verified ~$${capP ?? 0}/day at a NEGATIVE or unproven edge; live 'violations' here are Binance-vs-Chainlink basis disagreements (the basket has a losing state), so they are NOT arbitrage capacity`, verdict, notes, scriptPath: SCRIPT + 'hist_relations.mjs + verify_prints.mjs + live_scan.mjs', _pRoi: pRoi });
}
// implied-state rules
for (const rule of ['implied_15m_5m_outer', 'implied_15m_5m_inner', 'implied_4h_15m_outer', 'implied_4h_15m_inner', 'implied_4h_5m_outer', 'implied_4h_5m_inner']) {
  const mid = find((v) => v.group === 'I' && v.family === rule && v.scenario === 'hc1' && v.mode === 'walk-forward');
  const hs = find((v) => v.group === 'I' && v.family === rule && v.scenario === 'hs' && v.mode === 'walk-forward');
  const pl = find((v) => v.group === 'I' && v.family === rule && v.scenario === 'print_pl');
  const pn = find((v) => v.group === 'I' && v.family === rule && v.scenario === 'print_pn');
  const head = pl || mid;
  const [o, i, dir] = rule.split('_').slice(1);
  rows.push({ id: rule, hypothesis: `nested Chainlink windows (${o} outer, last ${i} inner): the inner price implies BTC's position vs ptb_inner; a driftless Gaussian with trailing 24h Chainlink vol maps it to a fair price for the ${dir === 'outer' ? 'outer' : 'inner'} market`,
    timeframe: `${o} vs ${i}`, rule: `From inner window start+30s, each path minute T: fair = Phi(Phi^-1(p_${dir === 'outer' ? 'inner' : 'outer'}) +/- d/(sigma*sqrt(E-T))); buy the ${dir} side whose ask+fee is below fair by > theta (theta in {1,2,3,5,8}c, walk-forward expanding by day, 40% burn-in); one trade per pair.`,
    makerOrTaker: 'taker', oosN: head ? num(head.n) : 0, winRate: head ? num(head.winRate) : null, avgCost: head ? num(head.avgCost) : null,
    roiAfterFees: `mid WF OOS docs_always: hc1 ${mid ? num(mid.roi) : '-'} (n ${mid ? mid.n : 0}), hs ${hs ? num(hs.roi) : '-'}; re-priced on real prints (fee docs): last ask print before T ${pl ? num(pl.roi) : 'n/a'}${pl ? ` (n ${pl.n})` : ''}, first ask print after T ${pn ? num(pn.roi) : 'n/a'}${pn ? ` (n ${pn.n})` : ''}`,
    ci95: pl ? pl.ci.replace(/;/g, ', ') : mid ? mid.ci.replace(/;/g, ', ') : 'n/a', bhSignificant: pl ? pl.bh === 'true' : mid ? mid.bh === 'true' : false,
    capacityPerDay: '<$5/day (median taker fill $4-5; entries are one-per-window)', verdict: pl && pn && num(pl.roi) > 0 && num(pn.roi) > 0 ? 'inconclusive' : 'no-edge',
    notes: pl ? `mid-based OOS ROI ${num(mid.roi)} disappears on real prints (avg slippage vs assumed cost ${num(pl.slipVsAssumed)}/share): the gap between the mid path and executable asks is the whole 'edge'` : `mid-based only (no tape for this direction): OOS ROI ${mid ? num(mid.roi) : '-'} CI ${mid ? mid.ci : '-'}`,
    scriptPath: SCRIPT + 'implied_state.mjs + implied_verify.mjs' });
}
// maker-legged simulation
{
  const w = MK.walkForward;
  const s0 = MK.grid.filter((g) => g.session === 0 && g.family === 'ALL');
  rows.push({ id: 'maker_legged_arb', hypothesis: 'coherence baskets that are not executable as taker can be built by resting a bid on one leg and hedging the others as taker when it fills (maker pays 0 fee)',
    timeframe: 'all live BTC families (risk-free relations)', rule: `At poll T: for each risk-free relation choose the leg with the largest planned margin m = minPay - bid - sum(other asks + fee); if m > theta rest a bid (join best bid or improve 1 tick) for H s; cancel at any later poll where the basket is no longer profitable; fills from the real taker tape after T; hedge at the next recorded book. Grid placement x theta {0,0.5,1}c x H {60,300}s; chosen on session0 = ${w ? w.chosen : '-'}`,
    makerOrTaker: 'maker (one leg) + taker hedge', oosN: w ? w.oos.filledOrders : 0, winRate: w ? w.oos.winRate : null, avgCost: w ? w.oos.avgCostPerSet : null,
    roiAfterFees: w ? `OOS sessions ${w.oosSessions}: orders ${w.oos.orders}, filled ${w.oos.filledOrders}, P&L $${w.oos.pnlUsd}, ROI ${w.oos.roi} (with optimistic 20% rebate ${w.oosWithRebate.roi}); in-sample session0 P&L $${w.inSample.pnlUsd} from ${w.inSample.filledOrders} fills. Session0 grid: ` + s0.map((g) => `${g.variant} ${g.filledOrders}/${g.orders} fills $${g.pnlUsd}`).join('; ') : 'n/a',
    ci95: w && w.oos.ci ? `[${w.oos.ci.join(', ')}]` : 'n/a', bhSignificant: false,
    capacityPerDay: w ? `OOS $${w.oos.usdPerDay}/day (extrapolated from ${MK.sessions.slice(1).map((s) => s.hours).join('+')} h)` : 'n/a', verdict: 'no-edge',
    notes: 'queue position and fills are approximated from the takerOnly tape (a resting bid at b is hit by taker SELLs of the token at <= b or taker BUYs of the complement at >= 1-b); hedges at the next poll (0-20 s latency); all data from one UTC day so bootstrap clusters are events, not days. Fill uncertainty remains large; adverse selection is visible (filled orders are the ones where the market moved through the bid).',
    scriptPath: SCRIPT + 'maker_sim.mjs' });
}
for (const r of rows) { delete r._pRoi; }
writeJSON('rules_final.json', { generatedAt: new Date().toISOString(), variantsTested: R.variantsTested, variantsByGroup: R.variantsByGroup, bhSignificant: R.bhSignificant, bhSignificantByGroup: R.bhSignificantByGroup, rows });
for (const r of rows) console.log(r.id.padEnd(27), 'oosN', String(r.oosN).padEnd(5), 'win', String(r.winRate).padEnd(6), 'cost', String(r.avgCost).padEnd(7), 'bh', String(r.bhSignificant).padEnd(5), r.verdict, '|', r.roiAfterFees.slice(0, 260));
console.log('variantsTested', R.variantsTested, JSON.stringify(R.variantsByGroup), 'BH', R.bhSignificant, JSON.stringify(R.bhSignificantByGroup));
