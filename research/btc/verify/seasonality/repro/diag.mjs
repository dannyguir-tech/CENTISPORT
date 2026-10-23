// Robustness diagnostics for the seasonality study:
//  * makerFillCheck  : would a maker bid at (snapshot - 0.5c) actually have been filled (5m/15m tapes)? fill-conditional edge.
//  * tapeMakerByPhase: realized edge of the makers who WERE filled, by window phase and favourite/underdog (5m/15m tapes).
//  * repriceWithFills: re-price snapshot-based taker trades at the first real taker BUY fill of the same token after the
//                      decision (5m/15m tapes, or data/fills_probe.jsonl for 1h/4h/1d).
//  * weekendPooled   : post-hoc pooled weekend-vs-weekday test of the mid-window favourite residual (all timeframes).
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown, loadTrades, DATA, fees } from '/home/user/CENTISPORT/research/btc/lib/load.mjs';
import { readJSONL } from '/home/user/CENTISPORT/research/btc/lib/util.mjs';
import { clusterTest, bootCI, tCdf, normCdf, fmt, mean, costOf, COST_MODELS } from './lib.mjs';
import { candidates } from './features.mjs';

const clampP = (p) => Math.min(0.999, Math.max(0.001, p));
const comp = (o) => (o === 'U' ? 'D' : 'U');

// ---------------------------------------------------------------------------------------------
let tapeMaps = {};
export function tapeMap(tf) {
  if (tapeMaps[tf]) return tapeMaps[tf];
  const m = new Map(); if (tf === '5m' || tf === '15m') for (const tp of loadTrades(tf)) m.set(tp.conditionId, tp.trades);
  return (tapeMaps[tf] = m);
}
let probe = null;
function probeMap() {
  if (probe) return probe;
  probe = new Map();
  const f = path.join(DATA, 'fills_probe.jsonl');
  if (fs.existsSync(f)) for (const r of readJSONL(f)) if (r.ok) probe.set(`${r.conditionId}|${r.action}`, r);
  return probe;
}
export const probeAvailable = () => probeMap().size > 0;

/** trades sorted by t; first index with t > T */
function firstIdxAfter(tr, T) { let lo = 0, hi = tr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (tr[m].t > T) hi = m; else lo = m + 1; } return lo; }

// ---------------------------------------------------------------------------------------------
/** Maker fill check for MN trades on tape markets. A bid for token tok at b = q - 0.005 resting from the decision time for
 *  `life` seconds is FILLED-THROUGH if a taker SELL of tok prints below b or a taker BUY of the complement prints above 1 - b
 *  (price traded through our level, so we were filled regardless of queue position); TOUCH if a print reaches b. */
export function makerFillCheck(trades, tf, action) {
  // 5m/15m: full tapes (life 60 s / 120 s). 1h/4h/1d: fills_probe windows after the FAV50/FAV80 decision (life = probe window).
  const tapes = tf === '5m' || tf === '15m';
  const tm = tapes ? tapeMap(tf) : null;
  if (tapes ? !tm.size : !probeAvailable() || action === 'OPEN') return null;
  let n = 0; const through = [], touch = [];
  for (const x of trades) {
    let tr = null, life = tf === '5m' ? 60 : 120;
    if (tapes) tr = tm.get(x.conditionId);
    else { const pr = probeMap().get(`${x.conditionId}|${action}`); if (pr) { tr = pr.trades; life = pr.wait; } }
    if (!tr) continue;
    n++;
    const b = clampP(x.q - 0.005);
    const tEnd = action === 'OPEN' ? x.start + life : x.t + life;
    let thr = false, tch = false;
    for (let j = firstIdxAfter(tr, x.t); j < tr.length && tr[j].t <= tEnd; j++) {
      const f = tr[j];
      const pTok = f.o === x.tok ? f.p : 1 - f.p; // price of OUR token implied by the print
      const sellsOurTok = (f.o === x.tok && f.side === 'S') || (f.o === comp(x.tok) && f.side === 'B');
      if (!sellsOurTok) continue;
      if (pTok <= b + 1e-9) tch = true;
      if (pTok < b - 1e-9) { thr = true; break; }
    }
    const cost = b - fees.makerRebatePerShare(b, x.fee);
    const y = { day: x.day, y: (x.won ? 1 : 0) - cost, roi: (x.won ? 1 : 0) / cost - 1 };
    if (thr) through.push(y); if (tch) touch.push(y);
  }
  if (!n) return { n: 0 };
  const s = (a) => (a.length ? { n: a.length, edge: fmt(mean(a.map((z) => z.y))), roi: fmt(mean(a.map((z) => z.roi))) } : { n: 0 });
  return { tapeTrades: n, fillRateThrough: fmt(through.length / n, 3), fillRateTouch: fmt(touch.length / n, 3), filledThrough: s(through), filledTouch: s(touch) };
}

// ---------------------------------------------------------------------------------------------
/** Realized edge of filled makers by phase x role, share-weighted, day-clustered. One test per cell (H1: maker edge incl. rebate > 0). */
export function tapeMakerByPhase(tf) {
  const recs = new Map(loadUpDown(tf).map((r) => [r.conditionId, r]));
  const cells = new Map();
  for (const [cid, tr] of tapeMap(tf)) {
    const r = recs.get(cid); if (!r) continue; const L = r.windowEnd - r.windowStart;
    for (const f of tr) {
      const ph = (f.t - r.windowStart) / L;
      const phase = f.t < r.windowStart - 60 ? null : ph < 0 ? 'pre' : ph < 0.1 ? 'open' : ph < 0.6 ? 'mid' : ph < 0.9 ? 'late' : ph <= 1 ? 'end' : null;
      if (!phase) continue;
      const mTok = f.side === 'B' ? comp(f.o) : f.o; const mP = f.side === 'B' ? 1 - f.p : f.p;
      const won = (mTok === 'U') === !!r.upWon ? 1 : 0;
      const role = mP >= 0.5 ? 'fav' : 'dog';
      const reb = 0.2 * 0.07 * f.p * (1 - f.p);
      const k = `${phase}|${role}`;
      if (!cells.has(k)) cells.set(k, new Map());
      const dm = cells.get(k); const a = dm.get(r.day) || { y: 0, s: 0, n: 0 }; a.y += (won - mP + reb) * f.s; a.s += f.s; a.n++; dm.set(r.day, a);
    }
  }
  const rows = [], tests = [];
  for (const k of ['pre|fav', 'pre|dog', 'open|fav', 'open|dog', 'mid|fav', 'mid|dog', 'late|fav', 'late|dog', 'end|fav', 'end|dog']) {
    const dm = cells.get(k); if (!dm) continue;
    const vals = [...dm.values()]; const S = vals.reduce((s, a) => s + a.s, 0), Y = vals.reduce((s, a) => s + a.y, 0), D = vals.length;
    const mu = Y / S; const ss = vals.reduce((s, a) => s + (a.y - mu * a.s) ** 2, 0); const se = Math.sqrt(ss * D / (D - 1)) / S;
    const p = D > 2 ? 1 - tCdf(mu / se, D - 1) : 1;
    rows.push({ tf, cell: k, days: D, fills: vals.reduce((s, a) => s + a.n, 0), shares: fmt(S, 0), makerEdgeWithRebate: fmt(mu, 5), se: fmt(se, 5) });
    tests.push({ id: `${tf}|tapephase|${k}|MAKER_EDGE`, family: 'tape', tf, split: 'PHASE', metric: 'MAKER_EDGE_REBATE>0', stat: fmt(mu / se, 3), p, cells: `${k}: ${fmt(mu, 5)}±${fmt(se, 5)}/share, ${D} days` });
  }
  return { rows, tests };
}

// ---------------------------------------------------------------------------------------------
/** First real taker BUY fill of token tok in (t, t+wait]. */
function firstBuy(tr, tok, t, wait) {
  for (let j = firstIdxAfter(tr, t); j < tr.length && tr[j].t <= t + wait; j++) if (tr[j].side === 'B' && tr[j].o === tok) return tr[j];
  return null;
}
/** Re-price taker trades at real fill prices; cost = fill + fee docs_always (no extra haircut). */
export function repriceWithFills(trades, tf, action) {
  const items = []; let covered = 0;
  for (const x of trades) {
    let tr = null, wait = 20;
    if (tf === '5m' || tf === '15m') tr = tapeMap(tf).get(x.conditionId);
    else { const pr = probeMap().get(`${x.conditionId}|${action}`); if (pr) { tr = pr.trades; wait = pr.wait; } }
    if (!tr) continue; covered++;
    const f = firstBuy(tr, x.tok, x.t - 1, wait); if (!f) continue;
    const cost = clampP(f.p) + fees.takerFeePerShare(clampP(f.p), x.fee, 'docs_always');
    const snapCost = costOf(x.q, x.fee, COST_MODELS.headline, tf, action);
    items.push({ day: x.day, y: (x.won ? 1 : 0) / cost - 1, edge: (x.won ? 1 : 0) - cost, snapEdge: (x.won ? 1 : 0) - snapCost, slip: f.p - x.q, wait: f.t - x.t });
  }
  if (!items.length) return { covered, n: 0, pROI: 1 };
  const t = clusterTest(items);
  // pricing bias of the snapshot model on the SAME trades: (snapshot-priced headline edge) - (fill-priced edge), day-clustered SE
  const bias = clusterTest(items, (z) => z.snapEdge - z.edge);
  return {
    covered, n: items.length, days: t.days, fewClusters: t.days < 15, roiFill: fmt(t.mean), roiFillCI: bootCI(items).map((v) => fmt(v)), pROI: t.pOne,
    snapMinusFillEdge: fmt(bias.mean), snapMinusFillSE: fmt(bias.se),
    edgeFill: fmt(mean(items.map((z) => z.edge))), edgeSnapHeadline: fmt(mean(items.map((z) => z.snapEdge))),
    meanSlipVsSnapshot: fmt(mean(items.map((z) => z.slip))), medianWaitSec: fmt([...items.map((z) => z.wait)].sort((a, b) => a - b)[items.length >> 1], 0),
  };
}

// ---------------------------------------------------------------------------------------------
/** Post-hoc (chosen AFTER seeing the descriptive tables): weekend vs weekday mid-window favourite residual pooled over all
 *  timeframes (full sample, cluster = UTC day of the window midpoint), and the matching fixed rule
 *  "on weekends buy the favourite at 50% of the window" priced at headline taker cost over each timeframe's OOS period. */
export function weekendPooled(obsByTf, oosStartByTf) {
  const wk = [], wd = []; const trades = []; const perTf = {};
  for (const [tf, obs] of Object.entries(obsByTf)) {
    for (const o of obs) {
      const cs = candidates(o, 'FAV50'); if (!cs) continue;
      const dMid = new Date((o.start + o.len / 2) * 1000).toISOString().slice(0, 10);
      const it = { day: dMid, y: (cs.F.won ? 1 : 0) - cs.F.q };
      (o.weekend === 'WKND' ? wk : wd).push(it);
      if (o.weekend === 'WKND' && o.day >= oosStartByTf[tf]) {
        const cost = costOf(cs.F.q, o.fee, COST_MODELS.headline, tf, 'FAV50');
        trades.push({ tf, day: dMid, y: (cs.F.won ? 1 : 0) / cost - 1, edge: (cs.F.won ? 1 : 0) - cost, g: it.y, conditionId: o.conditionId, tok: cs.F.tok, q: cs.F.q, won: cs.F.won, t: cs.F.t, fee: o.fee });
      }
    }
  }
  const a = clusterTest(wk), b = clusterTest(wd);
  const diff = a.mean - b.mean, se = Math.sqrt(a.se ** 2 + b.se ** 2), z = diff / se;
  const het = { wkndMean: fmt(a.mean), wkndSE: fmt(a.se), wkndN: a.n, wkdyMean: fmt(b.mean), wkdySE: fmt(b.se), wkdyN: b.n, diff: fmt(diff), se: fmt(se), z: fmt(z, 3), pTwo: 2 * (1 - normCdf(Math.abs(z))) };
  for (const tf of Object.keys(obsByTf)) {
    const tt = trades.filter((x) => x.tf === tf); if (!tt.length) continue;
    perTf[tf] = { n: tt.length, gross: fmt(mean(tt.map((x) => x.g))), edge: fmt(mean(tt.map((x) => x.edge))), roi: fmt(mean(tt.map((x) => x.y))), oosStart: oosStartByTf[tf] };
  }
  const rt = clusterTest(trades);
  const rule = { n: trades.length, days: rt.days, roi: fmt(rt.mean), roiCI: bootCI(trades).map((v) => fmt(v)), pOne: rt.pOne, edge: fmt(mean(trades.map((x) => x.edge))), gross: fmt(mean(trades.map((x) => x.g))), perTf };
  // fill-priced version for timeframes with real fills
  const fillByTf = {};
  for (const tf of Object.keys(obsByTf)) { const tt = trades.filter((x) => x.tf === tf); if (tt.length) fillByTf[tf] = repriceWithFills(tt, tf, 'FAV50'); }
  return { het, rule, fillByTf };
}
