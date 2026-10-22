#!/usr/bin/env node
// Nested Up/Down "implied state" relative-value test (statistical, NOT risk-free).
// Chainlink windows that share the same end E (15m outer + its last 5m; 4h outer + its last 15m / last 5m):
// the inner market price p_I = P(X_E >= ptb_I) pins down where BTC is relative to ptb_I in volatility units.
// With a driftless Gaussian model and trailing realized vol (Chainlink ref series, 24h strictly before the inner
// window start), the implied fair price of the outer is
//     fair_O = Phi( Phi^-1(p_I) + (ptb_I - ptb_O) / (sigma * sqrt(E - t)) ).
// We buy the outer side whose ask (+ taker fee) is below fair by more than theta (direction 'outer'), or the inner
// side priced from the outer (direction 'inner'). One trade per pair (first signal). theta is chosen walk-forward
// (expanding window by UTC day), OOS = later folds. Executable price = mid + haircut (hc1: max(1c, book half-spread);
// hs: book half-spread), fee 0.07 p (1-p). Where a 10% trade tape exists we also report the print-based fill.
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown, chainlinkRefSeries, tradesByCondition } from '../../lib/load.mjs';
import { askFromMid, feePS, dayKey, r4, writeJSON, REPORT, loadSpreadModel, bootstrapByDay } from './common.mjs';
loadSpreadModel();

// standard normal
const erf = (x) => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function PhiInv(p) { // Acklam
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const ref = chainlinkRefSeries(['5m', '15m', '4h']);
const refT = ref.map((x) => x[0]), refP = ref.map((x) => x[1]);
function sigmaBefore(T, lookback = 86400) { // per-sqrt-second relative vol from ref points in (T - lookback, T]
  let hi = refT.length - 1; while (hi >= 0 && refT[hi] > T) hi--;
  let s2 = 0, n = 0;
  for (let i = hi; i > 0 && refT[i - 1] >= T - lookback; i--) { const dt = refT[i] - refT[i - 1]; if (dt <= 0 || dt > 1800) continue; const r = Math.log(refP[i] / refP[i - 1]); s2 += (r * r) / dt; n++; }
  return n >= 30 ? Math.sqrt(s2 / n) : null;
}
const at = (pathArr, T, stale) => { let v = null; for (const [t, p] of pathArr) { if (t > T) break; if (T - t <= stale) v = p; else v = null; } return v; };

const PAIRS = [['15m', '5m'], ['4h', '15m'], ['4h', '5m']];
const THETAS = [0.01, 0.02, 0.03, 0.05, 0.08];
const SCEN = ['hc1', 'hs'];
const tapes = { '5m': tradesByCondition('5m'), '15m': tradesByCondition('15m') };
const cand = []; // per pair x direction x scenario: list of signals {t, day, theta-independent edge, cost, won}
for (const [oTf, iTf] of PAIRS) {
  const inner = new Map(loadUpDown(iTf).map((r) => [r.windowEnd, r]));
  for (const o of loadUpDown(oTf)) {
    const i = inner.get(o.windowEnd);
    if (!i || o.priceToBeat == null || i.priceToBeat == null || !(i.windowStart > o.windowStart)) continue;
    const sig = sigmaBefore(i.windowStart);
    if (!sig) continue;
    const E = o.windowEnd;
    const ts = (i.path || []).map((x) => x[0]).filter((t) => t >= i.windowStart + 30 && t <= E - 30);
    for (const dir of ['outer', 'inner']) for (const s of SCEN) {
      // first time the edge exceeds the smallest theta; record the max edge observed up to then for each theta separately
      const sigs = [];
      for (const t of ts) {
        const pI = at(i.path, t, 60), pO = at(o.path, t, 60);
        if (pI == null || pO == null) continue;
        const sd = sig * Math.sqrt(E - t) * i.priceToBeat;
        const d = i.priceToBeat - o.priceToBeat;
        let fair, mkt, rec, kind, upWon;
        if (dir === 'outer') { fair = Phi(PhiInv(Math.min(0.995, Math.max(0.005, pI))) + d / sd); mkt = pO; rec = o; kind = `updown_${oTf}`; upWon = o.upWon; }
        else { fair = Phi(PhiInv(Math.min(0.995, Math.max(0.005, pO))) - d / sd); mkt = pI; rec = i; kind = `updown_${iTf}`; upWon = i.upWon; }
        const aUp = askFromMid(mkt, kind, s), aDn = askFromMid(1 - mkt, kind, s);
        const eUp = fair - aUp - feePS(aUp, rec, 'docs_always'), eDn = (1 - fair) - aDn - feePS(aDn, rec, 'docs_always');
        const side = eUp >= eDn ? 'Up' : 'Down';
        const edge = Math.max(eUp, eDn);
        const a = side === 'Up' ? aUp : aDn;
        sigs.push({ t, edge, side, cost: a + feePS(a, rec, 'docs_always'), costZeroFee: a, won: side === 'Up' ? upWon : !upWon, fair, mkt, cid: rec.conditionId, tf: rec.tf, tok: side === 'Up' ? rec.upToken : rec.downToken, comp: side === 'Up' ? rec.downToken : rec.upToken });
      }
      for (const th of THETAS) {
        const hit = sigs.find((x) => x.edge > th);
        if (!hit) continue;
        // print check where a tape exists: last ask-side taker print within 30s before t
        let printCost = null;
        const tape = tapes[hit.tf] && tapes[hit.tf].get(hit.cid);
        if (tape) {
          const tokU = hit.tok === tape.upToken ? 'U' : 'D';
          const ask = tape.trades.filter((x) => x.t <= hit.t && x.t >= hit.t - 30 && ((x.o === tokU && x.side === 'B') || (x.o !== tokU && x.side === 'S'))).map((x) => (x.o === tokU ? x.p : 1 - x.p));
          if (ask.length) { const p = ask[ask.length - 1]; printCost = p + 0.07 * p * (1 - p); }
        }
        cand.push({ rule: `implied_${oTf}_${iTf}_${dir}`, s, theta: th, id: `${o.slug}|${i.slug}`, t: hit.t, day: dayKey(hit.t), side: hit.side, edge: r4(hit.edge), fair: r4(hit.fair), mkt: r4(hit.mkt), cost: r4(hit.cost), payoff: hit.won ? 1 : 0, profit: r4((hit.won ? 1 : 0) - hit.cost), printCost: printCost == null ? null : r4(printCost), cid: hit.cid, tf: hit.tf, tok: hit.tok, comp: hit.comp });
      }
    }
  }
}
fs.mkdirSync(path.join(REPORT, 'implied'), { recursive: true });
fs.writeFileSync(path.join(REPORT, 'implied', 'signals.jsonl'), cand.map((x) => JSON.stringify(x)).join('\n') + '\n');

// walk-forward theta selection per (rule, scenario)
function walkForward(rows) {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  if (days.length < 10) return { oos: [], folds: [] };
  const nTrain = Math.floor(days.length * 0.4);
  const rest = days.slice(nTrain);
  const nF = 5, per = Math.ceil(rest.length / nF);
  const oos = [], folds = [];
  for (let f = 0; f < nF; f++) {
    const fd = new Set(rest.slice(f * per, (f + 1) * per)); if (!fd.size) continue;
    const firstDay = [...fd][0];
    const train = rows.filter((r) => r.day < firstDay);
    let best = null;
    for (const th of THETAS) { const tr = train.filter((r) => r.theta === th); if (tr.length < 20) continue; const p = tr.reduce((s, r) => s + r.profit, 0) / tr.reduce((s, r) => s + r.cost, 0); if (!best || p > best.roi) best = { th, roi: p, n: tr.length }; }
    const th = best ? best.th : 0.03;
    folds.push({ from: firstDay, theta: th, trainRoi: best ? r4(best.roi) : null });
    oos.push(...rows.filter((r) => fd.has(r.day) && r.theta === th));
  }
  return { oos, folds };
}
const summary = [];
const wfRows = [];
const rules = [...new Set(cand.map((c) => c.rule))];
for (const rule of rules) for (const s of SCEN) {
  const rows = cand.filter((c) => c.rule === rule && c.s === s);
  for (const th of THETAS) {
    const tr = rows.filter((r) => r.theta === th);
    if (!tr.length) continue;
    const bs = bootstrapByDay(tr);
    summary.push({ rule, s, theta: th, mode: 'fixed-full-sample', n: tr.length, winRate: r4(tr.filter((r) => r.payoff).length / tr.length), avgCost: r4(tr.reduce((a, r) => a + r.cost, 0) / tr.length), roi: r4(bs.roi), ci: bs.ci.map(r4), p: bs.pOneSided, days: bs.nDays });
  }
  const wf = walkForward(rows);
  wfRows.push(...wf.oos.map((r) => ({ ...r, s })));
  if (wf.oos.length) {
    const bs = bootstrapByDay(wf.oos);
    const pr = wf.oos.filter((r) => r.printCost != null);
    summary.push({ rule, s, theta: 'WF', mode: 'walk-forward-OOS', folds: wf.folds, n: wf.oos.length, winRate: r4(wf.oos.filter((r) => r.payoff).length / wf.oos.length), avgCost: r4(wf.oos.reduce((a, r) => a + r.cost, 0) / wf.oos.length), roi: r4(bs.roi), ci: bs.ci.map(r4), p: bs.pOneSided, days: bs.nDays,
      printChecked: pr.length, printRoi: pr.length ? r4(pr.reduce((a, r) => a + r.payoff - r.printCost, 0) / pr.reduce((a, r) => a + r.printCost, 0)) : null,
      printMinusAssumedCost: pr.length ? r4(pr.reduce((a, r) => a + r.printCost - r.cost, 0) / pr.length) : null });
  }
}
writeJSON('implied/summary.json', summary);
fs.writeFileSync(path.join(REPORT, 'implied', 'wf_oos.jsonl'), wfRows.map((x) => JSON.stringify(x)).join('\n') + '\n');
for (const r of summary.filter((x) => x.mode !== 'fixed-full-sample' || x.s === 'hc1')) console.log(r.rule.padEnd(24), r.s, String(r.theta).padEnd(5), 'n', String(r.n).padEnd(5), 'win', r.winRate, 'cost', r.avgCost, 'roi', r.roi, 'ci', JSON.stringify(r.ci), 'p', r.p?.toFixed?.(3), r.printChecked != null ? `print n=${r.printChecked} roi=${r.printRoi} slip=${r.printMinusAssumedCost}` : '');
