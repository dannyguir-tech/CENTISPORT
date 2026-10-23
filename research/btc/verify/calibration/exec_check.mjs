// Verifier (calibration family): execution realism from REAL taker fills (data/exec_fills.jsonl from fetch_exec.mjs,
// plus the analyst's 5m/15m tapes as a fallback).
//   node exec_check.mjs -> out/exec_check.json
// For each candidate leg (token tok bought at the leg's snapshot time tDec):
//   ask_first  = first print that BUYS tok (taker BUY tok, or taker SELL of the complement at 1-p) in [tDec+LAT, tDec+LAT+30]
//   ask_med    = median of those prints;  bid_med = median of prints that SELL tok in the same 30 s
//   cost_tape  = ask + taker fee(ask)  (v2 formula 0.07 p(1-p), applied to every market = conservative)
//   cost_head  = the analyst's headline cost for the same leg (pInterp + 1c + docs_always fee)
//   depth_1c   = USDC notional of tok-buy prints at <= ask_first + 1c within 60 s (what other takers actually got)
// Legs with no tok-buy print within the 30 s window are reported as 'noFillEvidence' (cannot be costed from the tape).
import fs from 'node:fs';
import path from 'node:path';
import * as fees from '../../lib/fees.mjs';
import { tradesByCondition } from '../../lib/load.mjs';
import { clusterMeanTest, poissonBinomialTails, wilson } from './repro/stats.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'repro', 'out', 'cand_legs.json'), 'utf8')).variants;
// all fetched windows per market, merged (a leg is costed only if some fetched window covers [tDec-60, tDec+60])
const fillsByCid = new Map();
for (const line of fs.readFileSync(path.join(HERE, 'data', 'exec_fills.jsonl'), 'utf8').split('\n')) { if (!line) continue; const r = JSON.parse(line); if (!r.ok) continue; if (!fillsByCid.has(r.cid)) fillsByCid.set(r.cid, []); fillsByCid.get(r.cid).push(r); }
const tapes5 = tradesByCondition('5m'), tapes15 = tradesByCondition('15m');
const fee = (p) => fees.takerFeePerShare(p, undefined, 'docs_always');
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

function tradesFor(l) {
  const recs = (fillsByCid.get(l.cid) || []).filter((r) => r.t - 60 <= l.tDec - 30 && r.t + 120 >= l.tDec + 60);
  if (recs.length) { const m = new Map(); for (const r of recs) for (const x of r.trades) m.set(`${x.t}|${x.side}|${x.o}|${x.p}|${x.s}`, x); return { src: 'fetched', trades: [...m.values()].sort((a, b) => a.t - b.t) }; }
  const tp = (tapes5.get(l.cid) || tapes15.get(l.cid)); if (tp) return { src: 'tape', trades: tp.trades.filter((x) => x.t >= l.tDec - 60 && x.t <= l.tDec + 120) };
  return null;
}
function legExec(l, LAT) {
  const T = tradesFor(l); if (!T) return null;
  const u = l.tDec + LAT; const buys = [], sells = [], buysAll = []; let lastBefore = null;
  for (const x of T.trades) {
    const tokPx = x.o === l.tok ? x.p : 1 - x.p; const buysTok = (x.o === l.tok) === (x.side === 'B');
    if (x.t <= l.tDec) lastBefore = tokPx;
    if (x.t >= u && x.t <= u + 30) (buysTok ? buys : sells).push(tokPx);
    if (x.t >= u && x.t <= u + 60 && buysTok) buysAll.push([tokPx, x.s * tokPx]);
  }
  const askFirst = buys.length ? buys[0] : null; const bidMax = sells.length ? Math.max(...sells) : null; const askMed = med(buys); const bidMed = med(sells);
  const depth = askFirst == null ? 0 : buysAll.filter(([p]) => p <= askFirst + 0.01 + 1e-9).reduce((s, [, n]) => s + n, 0);
  return { src: T.src, askFirst, askMed, bidMed, bidMax, lastBefore, depth1c: depth, nBuys: buys.length };
}
function summarize(legs, LAT, which) {
  const rows = []; let noEv = 0, total = 0; const spreads = [], snapGap = [], depths = [];
  for (const l of legs) {
    if (l.kind !== 'taker') continue; const e = legExec(l, LAT); if (!e) continue; total++;
    if (e.lastBefore != null) snapGap.push(e.lastBefore - l.q);
    if (e.askMed != null && e.bidMed != null) spreads.push(e.askMed - e.bidMed);
    const ask = which === 'first' ? e.askFirst : which === 'bidPlusTick' ? (e.bidMax != null ? Math.min(0.999, e.bidMax + 0.001) : (e.askFirst ?? null)) : e.askMed; if (ask == null) { noEv++; continue; }
    depths.push(e.depth1c);
    const cT = Math.min(1, ask + fee(ask)); const cH = l.cost;
    rows.push({ day: l.day, win: l.win, cT, cH, yT: l.win / cT - 1, yH: l.win / cH - 1 });
  }
  if (!rows.length) return { legsWithTrades: total, noFillEvidence: noEv, n: 0 };
  const ctT = clusterMeanTest(rows, (x) => x.day, (x) => x.yT), ctH = clusterMeanTest(rows, (x) => x.day, (x) => x.yH);
  const wins = rows.reduce((s, x) => s + x.win, 0); const pT = Math.max(ctT.pOne, poissonBinomialTails(rows.map((x) => x.cT), wins).upper);
  const avgCT = rows.reduce((s, x) => s + x.cT, 0) / rows.length; const [wl, wh] = wilson(wins, rows.length);
  return { legsWithTrades: total, noFillEvidence: noEv, n: rows.length, days: ctT.days, win: r4(wins / rows.length), costTape: r4(avgCT), costHeadSameLegs: r4(rows.reduce((s, x) => s + x.cH, 0) / rows.length), roiTape: r4(ctT.mean), roiHeadSameLegs: r4(ctH.mean), pTape: r4(pT), roiTapeCI_wilson: [r4((wl - avgCT) / avgCT), r4((wh - avgCT) / avgCT)], medSpreadAskMinusBid: r4(med(spreads)), medLastTradeMinusSnapshot: r4(med(snapGap)), medDepth1cUSD: r4(med(depths)), p25Depth1cUSD: r4(med(depths.filter((d) => d <= med(depths)))) };
}
const NAMES = {
  'F6 4h f90 mom thr0.3': 'F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.3}',
  'F6 4h f90 mom thr0.2': 'F6_reaction_taker|4h|f90|mom|{"from":"f75","to":"f90","thr":0.2}',
  'F1 15m f25 up [0.90,0.95)': 'F1_band_taker|15m|f25|up|{"lo":0.9,"hi":0.95}',
  'F1 15m f25 down [0.90,0.95)': 'F1_band_taker|15m|f25|down|{"lo":0.9,"hi":0.95}',
  'F3 15m f25 up (wf)': 'F3_wf_band_taker|15m|f25|up|{"select":"max train cluster-t over contiguous bands, trade if t>=1.5"}',
  'F1 1h f75 up [0.95,0.98)': 'F1_band_taker|1h|f75|up|{"lo":0.95,"hi":0.98}',
  'F1 1h f75 tok [0.95,0.98)': 'F1_band_taker|1h|f75|tok|{"lo":0.95,"hi":0.98}',
  'F4 1h f75 logit (wf)': 'F4_wf_logit_model|1h|f75|model|{"margin":0.01}',
  'F8 4h f90 chainlink (wf)': 'F8_wf_chainlink_model|4h|f90|model|{"margin":0.01}',
  'F3 5m pre down (wf)': 'F3_wf_band_taker|5m|pre|down|{"select":"max train cluster-t over contiguous bands, trade if t>=1.5"}',
  'F1 5m pre down [0.55,0.60)': 'F1_band_taker|5m|pre|down|{"lo":0.5,"hi":0.6}',
  'F3 1d f50 up (wf)': 'F3_wf_band_taker|1d|f50|up|{"select":"max train cluster-t over contiguous bands, trade if t>=1.5"}',
  'F9 4h s0 rev1 taker': 'F9_streak_taker|4h|s0|rev1|{}',
  'F1 5m f90 tok [0.98,0.999)': 'F1_band_taker|5m|f90|tok|{"lo":0.98,"hi":0.999}',
};
const res = {};
for (const [name, id] of Object.entries(NAMES)) {
  const v = D[id]; if (!v) continue;
  let legs = v.legs; if (name.includes('[0.55,0.60)')) legs = legs.filter((l) => l.q >= 0.55);
  const withData = legs.filter((l) => tradesFor(l));
  res[name] = { id, legsTotal: legs.length, legsWithTradeData: withData.length };
  for (const [scope, sel] of [['ALL', withData], ['OOS', withData.filter((l) => l.oos)]]) {
    res[name][scope] = { lat2_first: summarize(sel, 2, 'first'), lat2_median30s: summarize(sel, 2, 'med'), lat15_first: summarize(sel, 15, 'first') };
    if (name.includes('0.98,0.999')) res[name][scope].lat2_bidPlusTick_optimistic = summarize(sel, 2, 'bidPlusTick');
  }
  const o = res[name].OOS.lat2_first, a = res[name].ALL.lat2_first, am = res[name].ALL.lat2_median30s;
  console.log(`\n${name}: legs ${legs.length}, with trades ${withData.length}`);
  console.log(`  ALL first-print @+2s: n=${a.n} (noFillEvidence ${a.noFillEvidence}) win=${a.win} costTape=${a.costTape} vs head ${a.costHeadSameLegs}  roiTape=${a.roiTape} vs head ${a.roiHeadSameLegs} p=${a.pTape} CI=${a.roiTapeCI_wilson} spread=${a.medSpreadAskMinusBid} lastTrade-snap=${a.medLastTradeMinusSnapshot} depth1c med=$${a.medDepth1cUSD}`);
  console.log(`  ALL median-30s @+2s: n=${am.n} costTape=${am.costTape} roiTape=${am.roiTape} p=${am.pTape}`);
  console.log(`  OOS first-print @+2s: n=${o.n} (noFillEvidence ${o.noFillEvidence}) win=${o.win} costTape=${o.costTape} vs head ${o.costHeadSameLegs} roiTape=${o.roiTape} vs head ${o.roiHeadSameLegs} p=${o.pTape}`);
  const l15 = res[name].ALL.lat15_first; console.log(`  ALL first-print @+15s: n=${l15.n} costTape=${l15.costTape} roiTape=${l15.roiTape}`);
  const bt = res[name].ALL.lat2_bidPlusTick_optimistic; if (bt) console.log(`  ALL bid+1tick (optimistic ask for extremes): n=${bt.n} (noEvidence ${bt.noFillEvidence}) win=${bt.win} cost=${bt.costTape} vs head ${bt.costHeadSameLegs} roi=${bt.roiTape} vs head ${bt.roiHeadSameLegs} p=${bt.pTape}`);
}
fs.writeFileSync(path.join(HERE, 'out', 'exec_check.json'), JSON.stringify(res, null, 1));
