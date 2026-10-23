// Seasonality / regime study for Polymarket BTC Up/Down markets.
//
// PRE-REGISTERED design (written before looking at any split results):
//   Splits (cells defined at window start, no look-ahead):
//     ALL      unconditional baseline
//     SESSION  UTC hour of window start: ASIA [0,8) EU [8,13) US [13,20) LATE [20,24)
//     WEEKEND  window midpoint on Sat/Sun UTC vs Mon-Fri
//     VOL      trailing-24h realized BTC vol (hourly Chainlink marks strictly before start), terciles fit on TRAINING days
//     VOLU     trailing-24h mean market volume / trailing-7d mean (closed windows only), terciles fit on TRAINING days
//              (1d series: 3d / 14d)
//   Descriptive-only omnibus splits: HOUR24 (24 UTC hours), DOW7 (day of week).
//   Actions:
//     OPEN   buy Up or Down at the pre-window quote (direction / outcome skew)
//     FAV50  at 50% of the window, buy the favourite or the underdog (favourite price in [0.55, 0.95])
//     FAV80  same at 80% of the window
//   Selection modes (walk-forward, expanding window, 40% initial training, 6 OOS folds by calendar day):
//     TG  taker, per cell trade the side with the higher TRAINING gross edge (always trades)  -> test headline ROI > 0
//     SIG same trades as TG                                                                 -> test gross edge (won - price) > 0
//     TN  taker, per cell trade only if TRAINING net edge (headline costs) > 0, n_train >= 50 -> test headline ROI > 0
//     MN  maker (hypothetical fill), same rule with maker costs                              -> test maker ROI > 0
//   Headline cost: taker, fee docs_always = 0.07 p (1-p) per share on every market, haircut EMP_HAIRCUT (>= 1c).
//   Inference: day-clustered t-test (one-sided), day-cluster bootstrap 95% CI, BH q = 0.10 over EVERY test run here.
import fs from 'node:fs';
import path from 'node:path';
import { loadTrades, loadLive, loadUpDown } from '/home/user/CENTISPORT/research/btc/lib/load.mjs';
import { fees } from '/home/user/CENTISPORT/research/btc/lib/load.mjs';
import { buildObs, candidates, SESSIONS } from './features.mjs';
import { makerFillCheck, tapeMakerByPhase, repriceWithFills, weekendPooled, probeAvailable } from './diag.mjs';
import {
  costOf, COST_MODELS, EMP_HAIRCUT, clusterTest, bootCI, benjaminiHochberg, chi2Sf, terciles, makeFolds,
  mean, median, quantile, fmt, tCdf,
} from './lib.mjs';

const OUT = '/home/user/CENTISPORT/research/btc/verify/seasonality/repro/out';
fs.mkdirSync(OUT, { recursive: true });
const TFS = ['5m', '15m', '1h', '4h', '1d'];
const RULE_SPLITS = ['ALL', 'SESSION', 'WEEKEND', 'VOL', 'VOLU'];
const DESC_SPLITS = ['SESSION', 'WEEKEND', 'VOL', 'VOLU', 'HOUR24', 'DOW7'];
const ACTIONS = ['OPEN', 'FAV50', 'FAV80'];
const MIN_TRAIN_GROSS = 30, MIN_TRAIN_NET = 50, MIN_FIT = 150;
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(path.join(OUT, 'run.log'), s + '\n'); };
fs.writeFileSync(path.join(OUT, 'run.log'), `run ${new Date().toISOString()}\n`);

const splitApplies = (tf, split) => !((split === 'SESSION' || split === 'HOUR24') && tf === '1d');

function fitSplit(split, train) {
  switch (split) {
    case 'ALL': return () => 'ALL';
    case 'SESSION': return (o) => o.session;
    case 'WEEKEND': return (o) => o.weekend;
    case 'HOUR24': return (o) => 'h' + String(o.hour).padStart(2, '0');
    case 'DOW7': return (o) => 'd' + o.dow;
    case 'VOL': case 'VOLU': {
      const key = split === 'VOL' ? 'vol24' : 'volRatio';
      const vals = train.map((o) => o[key]).filter((v) => v != null);
      if (vals.length < MIN_FIT) return null;
      const t = terciles(vals);
      return (o) => (o[key] == null ? null : o[key] < t[0] ? 'lo' : o[key] < t[1] ? 'mid' : 'hi');
    }
  }
  throw new Error(split);
}

// ------------------------------------------------------------------------------------------
// 1) Walk-forward rule variants
// ------------------------------------------------------------------------------------------
function runRule(obs, tf, split, action, mode) {
  const days = [...new Set(obs.map((o) => o.day))].sort();
  const { folds, oosStart } = makeFolds(days);
  const selCM = mode === 'MN' ? COST_MODELS.maker : COST_MODELS.headline;
  const trades = []; const foldLog = [];
  for (const f of folds) {
    const train = obs.filter((o) => o.day < f.start);
    const test = obs.filter((o) => f.days.has(o.day));
    const cellFn = fitSplit(split, train);
    if (!cellFn) { foldLog.push({ k: f.k, start: f.start, skipped: 'cannot fit split' }); continue; }
    const acc = new Map();
    for (const o of train) {
      const c = cellFn(o); if (c == null) continue;
      const cs = candidates(o, action); if (!cs) continue;
      if (!acc.has(c)) acc.set(c, {});
      const a = acc.get(c);
      for (const [k, cd] of Object.entries(cs)) {
        const s = (a[k] ||= { n: 0, g: 0, net: 0 });
        s.n++; s.g += cd.won - cd.q; s.net += cd.won - costOf(cd.q, o.fee, selCM, tf, action);
      }
    }
    const choice = {};
    for (const [c, a] of acc) {
      let best = null;
      for (const [k, s] of Object.entries(a)) {
        const score = mode === 'TG' ? s.g / s.n : s.net / s.n;
        if (!best || score > best.score) best = { k, score, n: s.n };
      }
      if (!best) continue;
      if (mode === 'TG' ? best.n >= MIN_TRAIN_GROSS : best.n >= MIN_TRAIN_NET && best.score > 0) choice[c] = best;
    }
    let nT = 0;
    for (const o of test) {
      const c = cellFn(o); if (c == null || !choice[c]) continue;
      const cs = candidates(o, action); if (!cs) continue;
      const cd = cs[choice[c].k];
      trades.push({ day: o.day, cell: c, key: choice[c].k, tok: cd.tok, q: cd.q, won: cd.won, t: cd.t, fee: o.fee, conditionId: o.conditionId, start: o.start, len: o.len });
      nT++;
    }
    foldLog.push({ k: f.k, start: f.start, end: f.end, nTrain: train.length, nTest: test.length, nTrades: nT, choice: Object.fromEntries(Object.entries(choice).map(([c, b]) => [c, `${b.k}:${fmt(b.score, 4)}:n${b.n}`])) });
  }
  return { trades, foldLog, oosStart, oosDays: folds.reduce((s, f) => s + f.days.size, 0) };
}

function metrics(trades, cm, tf, action, { boot = false } = {}) {
  if (!trades.length) return { n: 0 };
  const it = trades.map((tr) => { const cost = costOf(tr.q, tr.fee, cm, tf, action); return { day: tr.day, roi: tr.won / cost - 1, edge: tr.won - cost, cost, won: tr.won ? 1 : 0, g: (tr.won ? 1 : 0) - tr.q }; });
  const roiT = clusterTest(it, (x) => x.roi), edgeT = clusterTest(it, (x) => x.edge);
  const out = {
    n: it.length, days: roiT.days, winRate: fmt(mean(it.map((x) => x.won))), avgCost: fmt(mean(it.map((x) => x.cost))),
    edge: fmt(edgeT.mean), roi: fmt(roiT.mean), roiSE: fmt(roiT.se), roiT: fmt(roiT.t, 3), pROI: roiT.pOne, pEdge: edgeT.pOne,
  };
  if (boot) { out.roiCI = bootCI(it, (x) => x.roi).map((v) => fmt(v)); out.edgeCI = bootCI(it, (x) => x.edge).map((v) => fmt(v)); }
  return out;
}
function grossSignal(trades) {
  if (!trades.length) return { n: 0, pOne: 1 };
  const it = trades.map((tr) => ({ day: tr.day, y: (tr.won ? 1 : 0) - tr.q }));
  const t = clusterTest(it); return { n: t.n, mean: fmt(t.mean), se: fmt(t.se), t: fmt(t.t, 3), pOne: t.pOne, ci: bootCI(it).map((v) => fmt(v)) };
}

// ------------------------------------------------------------------------------------------
// Tapes: liquidity around decision times (capacity) and fill-price cross-check of rule trades
// ------------------------------------------------------------------------------------------
const tapeIdx = {};
function tapeIndex(tf) {
  if (tapeIdx[tf]) return tapeIdx[tf];
  const m = new Map();
  if (tf === '5m' || tf === '15m') for (const tp of loadTrades(tf)) m.set(tp.conditionId, tp);
  return (tapeIdx[tf] = m);
}
// liquidity per decision: taker notional within +-30 s of the decision time on the 5m/15m tapes
function tapeLiquidity(tf) {
  const res = {};
  const idx = tapeIndex(tf); if (!idx.size) return null;
  for (const action of ACTIONS) {
    const v = [];
    for (const tp of idx.values()) {
      const L = tp.windowEnd - tp.windowStart; const T = action === 'OPEN' ? tp.windowStart : tp.windowStart + (action === 'FAV50' ? 0.5 : 0.8) * L;
      let s = 0; for (const x of tp.trades) if (x.t >= T - 30 && x.t <= T + 30) s += x.p * x.s;
      v.push(s);
    }
    res[action] = { markets: v.length, medianTakerNotional60s: fmt(median(v), 2), p25: fmt(quantile(v, 0.25), 2) };
  }
  return res;
}
function liveDepth() {
  // median $ ask depth within 2c of best ask for in-play tokens priced 0.05-0.95, by kind
  let L; try { L = loadLive(); } catch { return {}; }
  const out = {};
  for (const e of L.events) {
    if (!e.kind?.startsWith('updown')) continue;
    const ws = e.windowStart ?? e.startTs; if (ws != null && ws > L.fetchedTs) continue;
    for (const m of e.markets) for (const t of m.tokens || []) {
      const b = t.book; if (!b || b.bestAsk == null || b.bestAsk < 0.05 || b.bestAsk > 0.95) continue;
      const d = (b.asks || []).filter(([p]) => p <= b.bestAsk + 0.02).reduce((s, [p, sz]) => s + p * sz, 0);
      (out[e.kind] ||= []).push(d);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { tokens: v.length, medianAskDepth2c: fmt(median(v), 1) }]));
}

// ------------------------------------------------------------------------------------------
// 2) Descriptive heterogeneity (full sample; cells for VOL / VOLU use full-sample terciles)
// ------------------------------------------------------------------------------------------
function describe(obs, tf) {
  const tables = [], tests = [];
  for (const split of DESC_SPLITS) {
    if (!splitApplies(tf, split)) continue;
    const cellFn = fitSplit(split, obs); if (!cellFn) continue;
    const cells = new Map();
    for (const o of obs) { const c = cellFn(o); if (c == null) continue; if (!cells.has(c)) cells.set(c, []); cells.get(c).push(o); }
    const keys = [...cells.keys()].sort();
    const rows = [];
    for (const c of keys) {
      const os = cells.get(c);
      const up = os.filter((o) => o.upWon).length;
      const res = {};
      for (const a of ['FAV50', 'FAV80']) {
        const it = []; for (const o of os) { const cs = candidates(o, a); if (cs) it.push({ day: o.day, y: (cs.F.won ? 1 : 0) - cs.F.q }); }
        res[a] = clusterTest(it);
      }
      rows.push({ tf, split, cell: c, n: os.length, upRate: up / os.length, q0: mean(os.map((o) => o.q0).filter((x) => x != null)),
        res50: res.FAV50.mean, se50: res.FAV50.se, n50: res.FAV50.n, res80: res.FAV80.mean, se80: res.FAV80.se, n80: res.FAV80.n,
        medVolume: median(os.map((o) => o.volume)), medVol24: median(os.map((o) => o.vol24).filter((x) => x != null)) });
    }
    tables.push(...rows);
    // Up-rate homogeneity chi-square (k x 2)
    {
      const N = rows.reduce((s, r) => s + r.n, 0), U = rows.reduce((s, r) => s + r.upRate * r.n, 0), pbar = U / N;
      let x2 = 0; for (const r of rows) { const e1 = r.n * pbar, e0 = r.n * (1 - pbar); x2 += (r.upRate * r.n - e1) ** 2 / e1 + ((1 - r.upRate) * r.n - e0) ** 2 / e0; }
      tests.push({ id: `${tf}|${split}|UPRATE_HET`, family: 'descriptive', tf, split, metric: 'UPRATE', stat: fmt(x2, 3), df: rows.length - 1, p: chi2Sf(x2, rows.length - 1),
        cells: rows.map((r) => `${r.cell}:${fmt(r.upRate, 3)}(n${r.n})`).join(' ') });
    }
    for (const [m, mk, sk, nk] of [['RES50', 'res50', 'se50', 'n50'], ['RES80', 'res80', 'se80', 'n80']]) {
      const rr = rows.filter((r) => r[nk] >= 30 && r[sk] > 0);
      if (rr.length < 2) continue;
      const w = rr.map((r) => 1 / r[sk] ** 2), mw = rr.reduce((s, r, i) => s + w[i] * r[mk], 0) / w.reduce((a, b) => a + b, 0);
      const x2 = rr.reduce((s, r, i) => s + w[i] * (r[mk] - mw) ** 2, 0);
      tests.push({ id: `${tf}|${split}|${m}_HET`, family: 'descriptive', tf, split, metric: m, stat: fmt(x2, 3), df: rr.length - 1, p: chi2Sf(x2, rr.length - 1),
        cells: rr.map((r) => `${r.cell}:${fmt(r[mk], 4)}±${fmt(r[sk], 4)}(n${r[nk]})`).join(' ') });
    }
  }
  return { tables, tests };
}

// ------------------------------------------------------------------------------------------
// 3) Tape: realized taker / maker edge by session and weekend (5m, 15m; descriptive)
// ------------------------------------------------------------------------------------------
function tapeMaker(tf) {
  const recs = new Map(loadUpDown(tf).map((r) => [r.conditionId, r]));
  const tests = [], rows = [];
  const cellOf = {
    ALL: () => 'ALL',
    SESSION: (r) => SESSIONS.find(([, a, b]) => { const h = new Date(r.windowStart * 1000).getUTCHours(); return h >= a && h < b; })[0],
    WEEKEND: (r) => { const d = new Date((r.windowStart + (r.windowEnd - r.windowStart) / 2) * 1000).getUTCDay(); return d === 0 || d === 6 ? 'WKND' : 'WKDY'; },
  };
  for (const [split, fn] of Object.entries(cellOf)) {
    const cells = new Map();
    for (const tp of tapeIndex(tf).values()) {
      const r = recs.get(tp.conditionId); if (!r) continue;
      const c = fn(r); const day = r.day;
      for (const x of tp.trades) {
        if (x.t < r.windowStart - 60 || x.t > r.windowEnd) continue; // pre-open minute + in-window fills
        const wonTok = (x.o === 'U') === !!r.upWon ? 1 : 0;
        const g = x.side === 'B' ? wonTok - x.p : x.p - wonTok; // taker gross edge per share
        const fee = 0.07 * x.p * (1 - x.p);
        if (!cells.has(c)) cells.set(c, { items: [], sh: 0, notional: 0, markets: new Set() });
        const o = cells.get(c); o.items.push({ day, s: x.s, mk: -g * x.s, mkR: (-g + 0.2 * fee) * x.s, tk: (g - fee) * x.s }); o.sh += x.s; o.notional += x.s * x.p; o.markets.add(tp.conditionId);
      }
    }
    const crow = [];
    for (const [c, o] of [...cells.entries()].sort()) {
      // share-weighted per-share maker edge: ratio of sums, clustered by day
      const agg = new Map();
      for (const it of o.items) { const a = agg.get(it.day) || { mk: 0, mkR: 0, tk: 0, s: 0 }; a.mk += it.mk; a.mkR += it.mkR; a.tk += it.tk; a.s += it.s; agg.set(it.day, a); }
      const D = agg.size, S = o.sh; const vals = [...agg.values()];
      const mu = (k) => vals.reduce((s, a) => s + a[k], 0) / S;
      const se = (k) => { const m = mu(k); const ss = vals.reduce((s, a) => s + (a[k] - m * a.s) ** 2, 0); return Math.sqrt(ss * D / (D - 1)) / S; };
      const mR = mu('mkR'), sR = se('mkR'); const tt = mR / sR;
      const p = D > 2 ? 1 - tCdf(tt, D - 1) : 1;
      const row = { tf, split, cell: c, markets: o.markets.size, days: D, fills: o.items.length, shares: fmt(S, 0), notional: fmt(o.notional, 0),
        makerEdgePerShare: fmt(mu('mk'), 5), makerEdgeWithRebate: fmt(mR, 5), se: fmt(sR, 5), takerNetPerShare: fmt(mu('tk'), 5), notionalPerDay: fmt(o.notional / D, 0) };
      rows.push(row); crow.push(row);
      tests.push({ id: `${tf}|tape|${split}|${c}|MAKER_EDGE`, family: 'tape', tf, split, metric: 'MAKER_EDGE_REBATE>0', stat: fmt(tt, 3), p, cells: `${c}: ${fmt(mR, 5)}±${fmt(sR, 5)} per share, ${D} days` });
    }
    if (crow.length >= 2) {
      const w = crow.map((r) => 1 / r.se ** 2), mw = crow.reduce((s, r, i) => s + w[i] * r.makerEdgeWithRebate, 0) / w.reduce((a, b) => a + b, 0);
      const x2 = crow.reduce((s, r, i) => s + w[i] * (r.makerEdgeWithRebate - mw) ** 2, 0);
      tests.push({ id: `${tf}|tape|${split}|MAKER_HET`, family: 'tape', tf, split, metric: 'MAKER_EDGE_HET', stat: fmt(x2, 3), df: crow.length - 1, p: chi2Sf(x2, crow.length - 1), cells: crow.map((r) => `${r.cell}:${r.makerEdgeWithRebate}`).join(' ') });
    }
  }
  return { rows, tests };
}

// ------------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------------
const t0 = Date.now();
const allTests = []; const variants = []; const descTables = []; const tapeRows = [];
const liq = {}; const depth = liveDepth(); const obsByTf = {}; const oosStartByTf = {}; const extra = {};
const medVolume = {};
log('fills_probe available:', probeAvailable());
log('live in-play depth', JSON.stringify(depth));
for (const tf of TFS) {
  const obs = buildObs(tf); obsByTf[tf] = obs;
  const days = [...new Set(obs.map((o) => o.day))].sort(); oosStartByTf[tf] = makeFolds(days).oosStart;
  medVolume[tf] = median(obs.map((o) => o.volume).filter((x) => x != null));
  log(`\n=== ${tf}: ${obs.length} windows, ${days.length} days ${days[0]}..${days.at(-1)}`);
  // descriptive
  const d = describe(obs, tf); descTables.push(...d.tables); allTests.push(...d.tests);
  for (const t of d.tests) log(`  desc ${t.id} x2=${t.stat} df=${t.df} p=${fmt(t.p, 4)} | ${t.cells}`);
  liq[tf] = tapeLiquidity(tf);
  // rules
  for (const split of RULE_SPLITS) {
    if (!splitApplies(tf, split)) continue;
    for (const action of ACTIONS) {
      for (const mode of ['TG', 'TN', 'MN']) {
        const r = runRule(obs, tf, split, action, mode);
        const tr = r.trades;
        const perDay = r.oosDays ? tr.length / r.oosDays : 0;
        const head = metrics(tr, mode === 'MN' ? COST_MODELS.maker : COST_MODELS.headline, tf, action, { boot: true });
        const sens = {};
        for (const [k, cm] of Object.entries(COST_MODELS)) { if (k === 'headline') continue; const m = metrics(tr, cm, tf, action); sens[k] = m.n ? { edge: m.edge, roi: m.roi, p: fmt(m.pROI, 4) } : null; }
        const cells = {};
        for (const x of tr) { const k = `${x.cell}:${x.key}`; const c = (cells[k] ||= { n: 0, w: 0, q: 0 }); c.n++; c.w += x.won ? 1 : 0; c.q += x.q; }
        const v = {
          id: `${tf}|${split}|${action}|${mode}`, tf, split, action, mode, exec: mode === 'MN' ? 'maker(hypothetical fill)' : 'taker',
          oosStart: r.oosStart, oosDays: r.oosDays, tradesPerDay: fmt(perDay, 2), ...head, sens,
          cellsTraded: Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, { n: c.n, winRate: fmt(c.w / c.n, 3), avgPrice: fmt(c.q / c.n, 3) }])),
          fill: mode !== 'MN' && tr.length ? repriceWithFills(tr, tf, action) : null,
          makerFill: mode === 'MN' && tr.length ? makerFillCheck(tr, tf, action) : null, folds: r.foldLog,
        };
        if (mode === 'TG') v.signal = grossSignal(tr);
        // capacity: $ per trade we could plausibly take
        let size = null;
        if (liq[tf]) size = 0.25 * liq[tf][action].medianTakerNotional60s;
        else { const dk = depth['updown_' + tf]; const volCap = 0.05 * 0.53 * medVolume[tf]; size = dk ? Math.min(dk.medianAskDepth2c, volCap) : volCap; }
        v.sizePerTrade = fmt(size, 1);
        v.capacityNotionalPerDay = size != null ? fmt(size * perDay, 0) : null;
        v.expProfitPerDay = size != null && head.roi != null ? fmt(Math.max(0, head.roi) * size * perDay, 1) : 0;
        variants.push(v);
        allTests.push({ id: v.id, family: mode === 'MN' ? 'rule-maker' : 'rule-taker', tf, split, metric: mode === 'MN' ? 'MAKER_ROI>0' : 'HEADLINE_ROI>0', p: head.n ? head.pROI : 1, n: head.n, days: head.days, fewClusters: head.n ? head.days < 15 : null });
        if (mode === 'TG') allTests.push({ id: v.id.replace('|TG', '|SIG'), family: 'rule-signal', tf, split, metric: 'GROSS_EDGE>0', p: v.signal.n ? v.signal.pOne : 1, n: v.signal.n });
        if (v.fill && v.fill.n >= 20) allTests.push({ id: v.id + '|FILL', family: 'fill-robustness', tf, split, metric: 'FILL_PRICED_ROI>0', p: v.fill.pROI, n: v.fill.n, days: v.fill.days, fewClusters: v.fill.fewClusters, cells: `roiFill=${v.fill.roiFill} CI=${JSON.stringify(v.fill.roiFillCI)} edgeFill=${v.fill.edgeFill} vs snap ${v.fill.edgeSnapHeadline}; snap-fill bias ${v.fill.snapMinusFillEdge}±${v.fill.snapMinusFillSE}; ${v.fill.days} days` });
        log(`  ${v.id.padEnd(26)} n=${String(head.n).padStart(5)} tpd=${v.tradesPerDay} win=${head.winRate} cost=${head.avgCost} edge=${head.edge} roi=${head.roi} CI=${JSON.stringify(head.roiCI)} p=${fmt(head.pROI, 4)}` +
          (v.signal ? ` | gross=${v.signal.mean} p=${fmt(v.signal.pOne, 4)}` : '') + (v.fill && v.fill.n ? ` | FILL n=${v.fill.n}/${v.fill.days}d roiFill=${v.fill.roiFill} edgeFill=${v.fill.edgeFill} (snap ${v.fill.edgeSnapHeadline}, bias ${v.fill.snapMinusFillEdge}±${v.fill.snapMinusFillSE}) p=${fmt(v.fill.pROI, 4)}` : '') +
          (v.makerFill && v.makerFill.tapeTrades ? ` | MAKERFILL tapeN=${v.makerFill.tapeTrades} fillThr=${v.makerFill.fillRateThrough} edge|thr=${v.makerFill.filledThrough.edge} fillTouch=${v.makerFill.fillRateTouch} edge|touch=${v.makerFill.filledTouch.edge}` : ''));
      }
    }
  }
  if (tf === '5m' || tf === '15m') {
    const tm = tapeMaker(tf); tapeRows.push(...tm.rows); allTests.push(...tm.tests);
    for (const r of tm.rows) log(`  tape ${tf} ${r.split}/${r.cell}: mk=${r.makerEdgePerShare} mk+reb=${r.makerEdgeWithRebate}±${r.se} takerNet=${r.takerNetPerShare} days=${r.days} fills=${r.fills} notional/day=$${r.notionalPerDay}`);
    const tp = tapeMakerByPhase(tf); extra['tapePhase_' + tf] = tp.rows; allTests.push(...tp.tests);
    for (const r of tp.rows) log(`  tapephase ${tf} ${r.cell}: makerEdge+reb=${r.makerEdgeWithRebate}±${r.se} days=${r.days} fills=${r.fills}`);
  }
}

// ------------------------------------------------------------------------------------------
// Post-hoc exploratory: pooled weekend effect on the mid-window favourite (chosen after seeing the descriptive tables)
// ------------------------------------------------------------------------------------------
{
  const w = weekendPooled(obsByTf, oosStartByTf); extra.weekendPooled = w;
  log(`\n=== POST-HOC weekend pooled: het ${JSON.stringify(w.het)}`);
  log(`    rule (weekend: buy favourite at 50%, headline taker, each tf's OOS period): ${JSON.stringify({ ...w.rule, perTf: undefined })}`);
  log(`    per tf: ${JSON.stringify(w.rule.perTf)}`);
  log(`    fill-priced: ${JSON.stringify(w.fillByTf)}`);
  allTests.push({ id: 'ALLTF|WEEKEND|FAV50|POSTHOC_HET', family: 'post-hoc', tf: 'all', split: 'WEEKEND', metric: 'RES50_WKND-WKDY!=0', stat: w.het.z, p: w.het.pTwo, cells: `diff=${w.het.diff}±${w.het.se}` });
  allTests.push({ id: 'ALLTF|WEEKEND|FAV50|POSTHOC_RULE', family: 'post-hoc', tf: 'all', split: 'WEEKEND', metric: 'HEADLINE_ROI>0', p: w.rule.pOne, n: w.rule.n, cells: `roi=${w.rule.roi} CI=${JSON.stringify(w.rule.roiCI)}` });
  for (const [tf, f] of Object.entries(w.fillByTf)) if (f.n >= 20) allTests.push({ id: `${tf}|WEEKEND|FAV50|POSTHOC_RULE|FILL`, family: 'post-hoc', tf, split: 'WEEKEND', metric: 'FILL_PRICED_ROI>0', p: f.pROI, n: f.n, days: f.days, fewClusters: f.fewClusters, cells: `roiFill=${f.roiFill} CI=${JSON.stringify(f.roiFillCI)} snap-fill bias ${f.snapMinusFillEdge}±${f.snapMinusFillSE}; ${f.days} days` });
}

// ------------------------------------------------------------------------------------------
// Benjamini-Hochberg over every test
// ------------------------------------------------------------------------------------------
const bh = benjaminiHochberg(allTests.map((t) => t.p), 0.10);
allTests.forEach((t, i) => { t.q = bh.qvals[i]; t.bhSig = bh.rejected[i]; });
const fam = {};
for (const f of [...new Set(allTests.map((t) => t.family))]) {
  const ts = allTests.filter((t) => t.family === f); const b = benjaminiHochberg(ts.map((t) => t.p), 0.10);
  ts.forEach((t, i) => { t.qFamily = b.qvals[i]; t.bhSigFamily = b.rejected[i]; });
  fam[f] = { tests: ts.length, rejected: b.nRejected };
}
for (const v of variants) { const t = allTests.find((x) => x.id === v.id); v.q = t.q; v.bhSig = t.bhSig; v.qFamily = t.qFamily; v.bhSigFamily = t.bhSigFamily; if (v.signal) { const s = allTests.find((x) => x.id === v.id.replace('|TG', '|SIG')); v.signal.q = s.q; v.signal.bhSig = s.bhSig; v.signal.qFamily = s.qFamily; } }

log(`\n=== BH q=0.10 over ALL ${allTests.length} tests: ${bh.nRejected} rejected. By family: ${JSON.stringify(fam)}`);
const sorted = [...allTests].sort((a, b) => a.p - b.p);
log('Smallest 25 p-values:');
for (const t of sorted.slice(0, 25)) log(`  ${t.id.padEnd(34)} ${t.metric.padEnd(20)} p=${t.p.toExponential(2)} q=${fmt(t.q, 4)} qFam=${fmt(t.qFamily, 4)} ${t.bhSig ? 'BH-SIG' : ''} ${t.cells || ''}${t.n != null ? ' n=' + t.n : ''}`);

// ------------------------------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------------------------------
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ generated: new Date().toISOString(), design: fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n'), empHaircut: EMP_HAIRCUT, liveDepth: depth, tapeLiquidity: liq, medVolume, extra, bh: { total: allTests.length, rejected: bh.nRejected, byFamily: fam }, variants, tests: allTests, tape: tapeRows }, null, 1));
const csvEsc = (x) => (x == null ? '' : typeof x === 'string' && /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
const vcols = ['id', 'tf', 'split', 'action', 'mode', 'exec', 'oosStart', 'oosDays', 'n', 'days', 'tradesPerDay', 'winRate', 'avgCost', 'edge', 'roi', 'roiCI', 'edgeCI', 'pROI', 'q', 'bhSig', 'qFamily', 'sigGross', 'sigP', 'sigQ', 'roi_docs_h1', 'roi_h2', 'roi_h3', 'roi_minp', 'roi_flat2', 'roi_gross', 'roi_makerHyp', 'fillN', 'fillDays', 'fillRoi', 'fillEdge', 'fillEdgeSnap', 'fillBias', 'fillP', 'makerFillRateThrough', 'makerEdgeIfFilledThrough', 'makerFillRateTouch', 'makerEdgeIfTouched', 'sizePerTrade', 'capacityNotionalPerDay', 'expProfitPerDay'];
const vrows = variants.map((v) => ({
  ...v, roiCI: v.roiCI ? v.roiCI.join(' to ') : '', edgeCI: v.edgeCI ? v.edgeCI.join(' to ') : '', pROI: fmt(v.pROI, 5), q: fmt(v.q, 4), qFamily: fmt(v.qFamily, 4),
  sigGross: v.signal?.mean, sigP: fmt(v.signal?.pOne, 5), sigQ: fmt(v.signal?.q, 4),
  roi_docs_h1: v.sens.docsA_h1?.roi, roi_h2: v.sens.docsA_h2?.roi, roi_h3: v.sens.docsA_h3?.roi, roi_minp: v.sens.minp_emp?.roi, roi_flat2: v.sens.flat2_emp?.roi, roi_gross: v.sens.gross?.roi, roi_makerHyp: v.sens.maker?.roi,
  fillN: v.fill?.n, fillDays: v.fill?.days, fillBias: v.fill?.snapMinusFillEdge, fillRoi: v.fill?.roiFill, fillEdge: v.fill?.edgeFill, fillEdgeSnap: v.fill?.edgeSnapHeadline, fillP: v.fill ? fmt(v.fill.pROI, 5) : null,
  makerFillRateThrough: v.makerFill?.fillRateThrough, makerEdgeIfFilledThrough: v.makerFill?.filledThrough?.edge, makerFillRateTouch: v.makerFill?.fillRateTouch, makerEdgeIfTouched: v.makerFill?.filledTouch?.edge,
}));
fs.writeFileSync(path.join(OUT, 'variants.csv'), [vcols.join(','), ...vrows.map((r) => vcols.map((c) => csvEsc(r[c])).join(','))].join('\n') + '\n');
const tcols = ['id', 'family', 'tf', 'split', 'metric', 'stat', 'df', 'n', 'days', 'fewClusters', 'p', 'q', 'bhSig', 'qFamily', 'bhSigFamily', 'cells'];
fs.writeFileSync(path.join(OUT, 'tests.csv'), [tcols.join(','), ...allTests.map((t) => tcols.map((c) => csvEsc(typeof t[c] === 'number' ? fmt(t[c], 6) : t[c])).join(','))].join('\n') + '\n');
const dcols = ['tf', 'split', 'cell', 'n', 'upRate', 'q0', 'res50', 'se50', 'n50', 'res80', 'se80', 'n80', 'medVolume', 'medVol24'];
fs.writeFileSync(path.join(OUT, 'cells.csv'), [dcols.join(','), ...descTables.map((r) => dcols.map((c) => csvEsc(typeof r[c] === 'number' ? fmt(r[c], 5) : r[c])).join(','))].join('\n') + '\n');
const pcols = Object.keys(tapeRows[0] || {});
fs.writeFileSync(path.join(OUT, 'tape_maker.csv'), [pcols.join(','), ...tapeRows.map((r) => pcols.map((c) => csvEsc(r[c])).join(','))].join('\n') + '\n');
log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s; variants=${variants.length} tests=${allTests.length}`);
