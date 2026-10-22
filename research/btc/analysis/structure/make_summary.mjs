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
p('  L  live scan: real CLOB books (/books) for every open BTC market, ' + (live ? `${live.snapshots} snapshots ${live.from} .. ${live.to} (${live.hours} h)` : 'n/a') + ', buy every leg at the ask with depth.');
p('');
p('FAMILY TABLE  (M: episodes = runs of minutes with mid violation; exec = still positive after half-spread+fee on mids)');
p(pad('family', 27) + pad('M episodes', 11) + pad('M exec', 8) + pad('medDur s', 9) + pad('P sampled', 10) + pad('noPrintLeg', 11) + pad('pl60 chk', 9) + pad('pl60 arb', 9) + pad('pl60 medMargin', 15) + pad('L inst', 7) + pad('L maxTakerMargin', 17) + pad('L makerLegged+', 14));
const fams = new Set([...Object.keys(R.episodeSummary), ...Object.keys(live ? live.families : {})]);
for (const f of fams) {
  const e = R.episodeSummary[f] || {}, v = R.verifySummary[f] || {}, l = live && live.families[f] ? live.families[f] : {};
  p(pad(f, 27) + pad(e.episodes, 11) + pad(e.execOnMidPlusHalfSpread, 8) + pad(e.durSec && e.durSec.p50, 9) + pad(v.sampled, 10) + pad(v.legsWithNoPrints, 11) + pad(v.pl60Available, 9) + pad(v.pl60Arb, 9) + pad(v.medianPl60Margin, 15) + pad(l.instances, 7) + pad(l.maxMargin, 17) + pad(l.makerLegged ? `${l.makerLegged.instancesPositive}` : '-', 14));
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
p(`VARIANTS: ${R.variantsTested} tested, ${R.variantsWithP} with p-values (n>=5, >=2 days); BH q=0.10 significant ${R.bhSignificant} (M ${R.bhSignificantByGroup.M}, P ${R.bhSignificantByGroup.P}, I ${R.bhSignificantByGroup.I}).`);
p('  M and P significance for risk-free baskets is mechanical (every selected trade pays >= cost by construction); it shows that');
p('  violations EXISTED in the respective price series, not that they were capturable at scale. I significance is mid-only and disappears on prints.');
if (live) {
  p('');
  p('LIVE SCAN');
  for (const [f, o] of Object.entries(live.families)) p(`  ${pad(f, 27)} instances ${pad(o.instances, 5)} priced ${pad(o.priced, 6)} taker-violating snapshot-instances ${pad(o.violatingSnapshotInstances, 4)} maxMargin ${pad(o.maxMargin, 8)} p99 ${pad(o.marginQuantiles.p99, 8)} maxProfit$ ${pad(o.maxProfitUsd, 7)} $/day<= ${pad(o.usdPerDayUpperBound, 7)} maker-legged>0: ${o.makerLegged.snapshotInstancesPositive} snaps / ${o.makerLegged.instancesPositive} inst (max ${o.makerLegged.marginQuantiles ? o.makerLegged.marginQuantiles.max : '-'})`);
}
fs.writeFileSync(path.join(REPORT, 'summary.txt'), L.join('\n') + '\n');
console.log(L.join('\n'));
