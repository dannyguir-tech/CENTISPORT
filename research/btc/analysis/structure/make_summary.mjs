#!/usr/bin/env node
// Human-readable digest of the structure analysis -> reports/structure/summary.txt
import fs from 'node:fs';
import path from 'node:path';
import { REPORT } from './common.mjs';

const R = JSON.parse(fs.readFileSync(path.join(REPORT, 'results.json'), 'utf8'));
const IP = JSON.parse(fs.readFileSync(path.join(REPORT, 'implied', 'print_check.json'), 'utf8'));
const live = R.live;
const L = [];
const p = (...a) => L.push(a.join(' '));
const pad = (s, n) => String(s ?? '-').padEnd(n);
p('BTC Polymarket cross-market structure / arbitrage study  (generated', new Date().toISOString() + ')');
p('');
p('ORACLE MAP (verified on settled data)');
p('  above_daily ladder, range_daily buckets, daily Up/Down: same Binance BTC/USDT 1m close at 12:00 ET (0 mismatches over 1,223 above + 1,199 bucket outcomes)');
p('  above_hourly ladder, hourly Up/Down: same Binance 1h candle close (5,000/5,000 outcomes consistent)');
p('  hit daily/weekly/monthly: Binance 1m highs/lows over the ET day/week/month (consistent with the noon close in 1,312/1,312 checks)');
p('  5m / 15m / 4h Up/Down: Chainlink BTC/USD 60s TWAP stream; priceToBeat identical at shared timestamps (4,318 5m-15m, 700 15m-4h, 269 5m-4h)');
p('  1h Up/Down is Binance, so 1h vs 5m/15m nesting carries oracle basis (|Binance open - Chainlink| median $39-51)');
p('');
p('METHOD');
p('  M  mid-screen: price-history mids (~1/min last 48h, ~1/10min before) + half-spread haircut (hc1 = max(1c, book half-spread)) + taker fee 0.07p(1-p) per leg.');
p('     Risk-free baskets are profitable BY CONSTRUCTION whenever the mids say so, so M "wins" are not evidence.');
p('  P  print verification: a seeded sample of M episodes re-priced from real taker fills (data-api /trades) on every leg;');
p('     pl60 = last ask-side print of every leg within 60 s before the decision time (no look-ahead).');
p('  L  live scan: real CLOB books (/books) for every open BTC market, ' + (live ? Object.entries(live.scopes).filter(([k]) => k !== 'all').map(([k, sc]) => `${k}: ${sc.snapshots} snapshots ${sc.from} .. ${sc.to} (${sc.hours} h)`).join('; ') : 'n/a') + ', buy every leg at the ask with depth.');
p('  K  maker-legged simulation: rest a bid on one leg (join or improve by a tick), fills only from the REAL taker tape after the decision, hedge the other legs at the next recorded book; tuned on session0, OOS on later sessions.');
p('');
p('FAMILY TABLE  (M: episodes = runs of minutes with mid violation; exec = still positive after half-spread+fee on mids)');
p(pad('family', 27) + pad('M episodes', 11) + pad('M exec', 8) + pad('medDur s', 9) + pad('P sampled', 10) + pad('noPrintLeg', 11) + pad('pl60 chk', 9) + pad('pl60 arb', 9) + pad('pl60 medMargin', 15) + pad('L inst', 7) + pad('L maxTakerMargin', 17) + pad('L makerLegged+', 14));
const LA = live ? live.scopes.all : null;
const fams = new Set([...Object.keys(R.episodeSummary), ...Object.keys(LA ? LA.families : {})]);
for (const f of fams) {
  const e = R.episodeSummary[f] || {}, v = R.verifySummary[f] || {}, l = LA && LA.families[f] ? LA.families[f] : {};
  p(pad(f, 27) + pad(e.episodes, 11) + pad(e.execOnMidPlusHalfSpread, 8) + pad(e.durSec && e.durSec.p50, 9) + pad(v.sampled, 10) + pad(v.legsWithNoPrints, 11) + pad(v.pl60Available, 9) + pad(v.pl60Arb, 9) + pad(v.medianPl60Margin, 15) + pad(l.instances, 7) + pad(l.maxMargin, 17) + pad(l.makerLeggedNaive ? `${l.makerLeggedNaive.instancesPositive}` : '-', 14));
}
p('');
p('PRINT-VERIFIED EXAMPLES (pl60, fee docs_always)');
for (const [f, v] of Object.entries(R.verifySummary)) for (const x of v.examples || []) p(`  ${f}: ${x.id} @ ${x.t} prices ${JSON.stringify(x.prices)} margin ${x.margin}/share-set, print size ${x.sizeShares} sh, payoff ${x.payoff}`);
p('');
p('HEADLINE WALK-FORWARD ROWS');
for (const v of R.headline) p(`  ${v.group} ${pad(v.family, 26)} ${pad(v.scenario, 9)} n ${pad(v.n, 5)} days ${pad(v.days, 4)} win ${pad(v.winRate, 6)} cost ${pad(v.avgCost, 7)} roi ${pad(v.roi, 7)} ci ${JSON.stringify(v.ci)} p ${Number.isFinite(v.p) ? v.p.toFixed(4) : '-'} BH ${v.bh}${v.capacityUsdPerDay != null ? ' cap$/day ' + v.capacityUsdPerDay : ''}`);
p('');
p('IMPLIED-STATE (statistical) ON REAL PRINTS (WF OOS hc1 trades re-priced from taker fills)');
for (const r of IP) p(`  ${pad(r.rule, 22)} mid-ROI ${r.mid.roi} ${JSON.stringify(r.mid.ci)} | pl n=${r.pl.n} ROI ${r.pl.roi} ${JSON.stringify(r.pl.ci)} slip ${r.pl.slipVsAssumed} | pn n=${r.pn.n} ROI ${r.pn.roi} ${JSON.stringify(r.pn.ci)} slip ${r.pn.slipVsAssumed}`);
p('');
p(`VARIANTS: ${R.variantsTested} tested ${JSON.stringify(R.variantsByGroup)}, ${R.variantsWithP} with p-values (n>=5); BH q=0.10 significant ${R.bhSignificant} ${JSON.stringify(R.bhSignificantByGroup)}.`);
p('  M and P significance for risk-free baskets is mechanical (every selected trade pays >= cost by construction); it shows that');
p('  violations EXISTED in the respective price series, not that they were capturable at scale. I significance is mid-only and disappears on prints.');
if (live) {
  for (const [k, sc] of Object.entries(live.scopes)) {
    p('');
    p(`LIVE SCAN ${k}  (${sc.snapshots} snapshots, ${sc.from} .. ${sc.to}, ${sc.hours} h; taker = buy every leg at the asks + fee 0.07p(1-p))`);
    for (const [f, o] of Object.entries(sc.families)) p(`  ${pad(f, 27)} instances ${pad(o.instances, 5)} priced ${pad(o.priced, 6)} taker-violating snapshot-instances ${pad(o.violatingSnapshotInstances, 4)} maxMargin ${pad(o.maxMargin, 8)} p99 ${pad(o.marginQuantiles.p99, 8)} maxProfit$ ${pad(o.maxProfitUsd, 7)} medEpisodeSec ${pad(o.medianEpisodeSec, 5)} $/day<= ${pad(o.usdPerDayUpperBound, 7)} naive-maker>0 inst ${o.makerLeggedNaive.instancesPositive}`);
  }
}
if (live) p('  NOTE: nest_basis_* live "violations" assume Binance (1h/1d) = Chainlink (5m/15m/4h); the ~$40-100 oracle gap gives the basket a losing state, so they are NOT arbitrage (historical print-verified ROI of these baskets is negative).');
const MK = R.maker;
if (MK) {
  p('');
  p('MAKER-LEGGED SIMULATION (real tape fills, hedge at next recorded book; P&L uses the guaranteed payoff)');
  const G = JSON.parse(fs.readFileSync(path.join(REPORT, 'maker', 'maker_sim.json'), 'utf8')).grid;
  for (const g of G.filter((x) => x.family === 'ALL')) p(`  ${pad(g.variant, 17)} session ${g.session} orders ${pad(g.orders, 6)} filled ${pad(g.filledOrders, 4)} shares ${pad(g.sharesFilled, 8)} unhedged ${pad(g.unhedgedShares, 6)} pnl$ ${pad(g.pnlUsd, 8)} roi ${pad(g.roi, 7)} ci ${JSON.stringify(g.ci)} $/day ${pad(g.usdPerDay, 7)} (+rebate pnl$ ${g.withRebate.pnlUsd})`);
  for (const g of G.filter((x) => x.family !== 'ALL' && x.filledOrders > 0)) p(`    by family: ${pad(g.variant, 17)} s${g.session} ${pad(g.family, 26)} orders ${pad(g.orders, 6)} filled ${pad(g.filledOrders, 4)} pnl$ ${pad(g.pnlUsd, 8)} roi ${g.roi}`);
  if (MK.walkForward) { const w = MK.walkForward; p(`  WALK-FORWARD: chosen on session ${w.chosenOn} = ${w.chosen} (IS pnl $${w.inSample.pnlUsd}, ${w.inSample.filledOrders} fills) -> OOS sessions ${w.oosSessions}: orders ${w.oos.orders} filled ${w.oos.filledOrders} pnl $${w.oos.pnlUsd} roi ${w.oos.roi} ci ${JSON.stringify(w.oos.ci)} $/day ${w.oos.usdPerDay} (+rebate $${w.oosWithRebate.pnlUsd})`); }
}
const PSf = path.join(REPORT, 'printscan', 'summary.json');
if (fs.existsSync(PSf)) {
  const PS = JSON.parse(fs.readFileSync(PSf, 'utf8'));
  p('');
  p('PRINT-FIRST CENSUS OF NESTED CHAINLINK PAIRS (every taker print; last ask-side print per leg <= W s old; follow-through = first ask print after T within 15 s)');
  for (const [f, o] of Object.entries(PS.families)) p(`  ${pad(f, 16)} pairs ${o.pairs} days ${o.days} (${o.from}..${o.to}) medAskEvents ${o.medAskEvents} | ` + Object.entries(o.byW).map(([W, b]) => `W${W}: viol ${b.pairsWithViolation} (${b.share}) dur p50 ${b.violSecP50}s p90 ${b.violSecP90}s maxMargin p50 ${b.maxMarginP50}`).join(' | '));
  for (const v of PS.variants) p(`  ${pad(v.family, 16)} ${pad(v.mode, 12)} W ${pad(v.W, 3)} th ${pad(v.theta, 5)} n ${pad(v.n, 4)} win ${pad(v.winRate, 6)} cost ${pad(v.avgCost, 7)} roi ${pad(v.roi, 7)} ci ${JSON.stringify(v.ci)} | follow n ${pad(v.folN, 4)} roi ${pad(v.folRoi, 7)} ci ${JSON.stringify(v.folCi)} | medSize ${pad(v.medSize, 6)} $/day ${pad(v.usdPerDay, 7)} follow $/day ${v.usdPerDayFollow}`);
}
fs.writeFileSync(path.join(REPORT, 'summary.txt'), L.join('\n') + '\n');
console.log(L.join('\n'));
