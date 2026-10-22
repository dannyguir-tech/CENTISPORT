#!/usr/bin/env node
// Walk-forward backtest of the hypothesis library on dataset.jsonl (see build-dataset.js).
// Parameters are chosen on past folds only and judged on the next fold; only out-of-sample bets
// are reported. Hypotheses never see labels: won/closePrice/clv are stripped before select().
// "No hypothesis survived" is a normal, expected outcome.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { benjaminiHochberg, clusterBootstrapSums, mean, normalCdf, normalQuantile, wilson } from './lib/stats.js';
import { BASE_HYPOTHESES, TRADE_FIELDS, buildHypotheses } from './hypotheses.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3600;

export const DEFAULTS = Object.freeze({
  data: path.join(HERE, 'data', 'dataset.jsonl'),
  out: path.join(HERE, 'reports'),
  name: null,
  sourceLabel: null,
  fee: 0.01,
  spread: 0.01,
  stressSpread: 0.02,
  sensitivitySpreads: [0, 0.01, 0.02],
  maxCost: 0.99,
  folds: 5,
  // Train rows must start this long before the test fold's first decision, so their outcomes
  // were actually known (settled) when the parameters would have been chosen.
  embargoH: 24,
  minN: 50,
  fdr: 0.10,
  boot: 2000,
  seed: 1,
  alpha: 0.05,
  minSportMarkets: 300,
  only: null,
});

export const LABEL_FIELDS = Object.freeze(['won', 'closePrice', 'clv']);
// Word-bounded so real labels like "latest" or "soccer fixtures" are not flagged.
const SYNTHETIC_RE = /\b(synth\w*|mock\w*|fake\w*|simulat\w*|dummy|test|demo|toy)\b/i;

const fin = Number.isFinite;
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };
const iso = (t) => (fin(t) ? new Date(t * 1000).toISOString().replace('.000Z', 'Z') : null);

// ---------- cost model ----------

export const entryCost = (price, spread, fee) => Math.min(0.999, (price + spread) * (1 + fee));
export const betPnl = (won, cost) => (won ? 1 / cost - 1 : -1);

// ---------- loading ----------

function rowProblem(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'not_object';
  if (typeof x.id !== 'string' || !x.id) return 'no_id';
  if (!fin(x.startTs) || !fin(x.decisionTs) || !fin(x.offsetH)) return 'bad_times';
  if (x.decisionTs >= x.startTs) return 'decision_not_before_start';
  if (!fin(x.price) || x.price <= 0 || x.price >= 1) return 'bad_price';
  if (fin(x.priceAgeSec) && x.priceAgeSec < 0) return 'price_after_decision';
  if (x.won !== 0 && x.won !== 1 && x.won !== true && x.won !== false) return 'bad_label';
  return null;
}

// -> { f, won, closePrice, clv, fold }. f is a frozen copy WITHOUT the labels (LABEL_FIELDS) and
// without lifetime gamma volume (it includes trading after the decision); f is the only object
// hypotheses ever receive.
export function prepareRow(x) {
  // Rest-destructuring rather than `delete`: deleted keys push V8 objects into slow dictionary
  // mode, and select() reads these properties millions of times.
  const { won, closePrice, clv, volume, ...f } = x;
  f.eventKey = String(f.eventKey == null || f.eventKey === '' ? f.conditionId || f.id : f.eventKey);
  return {
    f: Object.freeze(f),
    won: won === true || won === 1 ? 1 : 0,
    closePrice: fin(closePrice) ? closePrice : null,
    clv: fin(clv) ? clv : null,
    fold: -1,
  };
}

export async function loadDataset(file) {
  if (!fs.existsSync(file)) throw new Error(`dataset not found: ${file} — run research/build-dataset.js first or pass --data`);
  const rows = [], drops = {}, seen = new Set();
  let read = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    read++;
    let x;
    try { x = JSON.parse(line); } catch { bump(drops, 'bad_json'); continue; }
    const why = rowProblem(x);
    if (why) { bump(drops, why); continue; }
    if (seen.has(x.id)) { bump(drops, 'duplicate_id'); continue; }
    seen.add(x.id);
    rows.push(prepareRow(x));
  }
  return { rows, read, drops };
}

// ---------- folds & walk-forward ----------

// Time-ordered folds of ~equal row counts. A whole event goes to one fold (its markets are
// correlated), placed by the event's earliest start.
export function assignFolds(rows, k) {
  if (!Number.isInteger(k) || k < 2) throw new Error('--folds must be an integer >= 2');
  const events = new Map();
  for (const r of rows) {
    let e = events.get(r.f.eventKey);
    if (!e) events.set(r.f.eventKey, (e = { key: r.f.eventKey, t: r.f.startTs, rows: [] }));
    e.rows.push(r);
    if (r.f.startTs < e.t) e.t = r.f.startTs;
  }
  const list = [...events.values()].sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const folds = Array.from({ length: k }, (_, fold) => ({ fold, rows: [], nEvents: 0, startMin: Infinity, startMax: -Infinity, decisionMin: Infinity }));
  let before = 0;
  for (const e of list) {
    const f = folds[Math.min(k - 1, Math.floor((before * k) / rows.length))];
    before += e.rows.length;
    f.nEvents++;
    for (const r of e.rows) {
      r.fold = f.fold;
      f.rows.push(r);
      f.startMin = Math.min(f.startMin, r.f.startTs);
      f.startMax = Math.max(f.startMax, r.f.startTs);
      f.decisionMin = Math.min(f.decisionMin, r.f.decisionTs);
    }
  }
  if (folds.some((f) => !f.rows.length)) throw new Error(`cannot form ${k} non-empty time folds from ${list.length} events — lower --folds or add data`);
  return folds;
}

// Best train ROI among candidates with n >= minN (ties: larger n, then grid order); null if none.
export function chooseParams(hyp, cands, train, o) {
  const byOffset = new Map();
  for (const r of train) {
    let a = byOffset.get(r.f.offsetH);
    if (!a) byOffset.set(r.f.offsetH, (a = []));
    a.push(r);
  }
  let best = null;
  for (const { offsetH, params } of cands) {
    let n = 0, pnl = 0;
    for (const r of byOffset.get(offsetH) || []) {
      if (!hyp.select(r.f, params)) continue;
      const cost = entryCost(r.f.price, o.spread, o.fee);
      if (cost >= o.maxCost) continue;
      n++;
      pnl += betPnl(r.won, cost);
    }
    if (n < o.minN) continue;
    const roi = pnl / n;
    if (!best || roi > best.trainRoi || (roi === best.trainRoi && n > best.trainN)) best = { offsetH, params, trainN: n, trainRoi: roi };
  }
  return best;
}

// Expanding window: for fold k >= 1, train on folds < k (minus the embargo), test on fold k.
// hooks.onPhase(phase, k) lets tests audit exactly which rows each phase touches.
export function walkForward(hyp, folds, o, hooks = {}) {
  const offsets = new Set(hyp.offsets);
  const cands = hyp.offsets.flatMap((offsetH) => hyp.paramGrid.map((params) => ({ offsetH, params })));
  const embargoSec = o.embargoH * HOUR;
  const perFold = [], picks = [];
  for (let k = 1; k < folds.length; k++) {
    const cutoff = folds[k].decisionMin;
    const train = [];
    for (let j = 0; j < k; j++) {
      for (const r of folds[j].rows) if (offsets.has(r.f.offsetH) && r.f.startTs + embargoSec <= cutoff) train.push(r);
    }
    hooks.onPhase?.('train', k);
    const chosen = chooseParams(hyp, cands, train, o);
    hooks.onPhase?.('test', k);
    const foldPicks = [];
    if (chosen) for (const r of folds[k].rows) if (r.f.offsetH === chosen.offsetH && hyp.select(r.f, chosen.params)) foldPicks.push(r);
    picks.push(...foldPicks);
    perFold.push({ fold: k, nTrainRows: train.length, chosen, picks: foldPicks });
  }
  hooks.onPhase?.(null, -1);
  return { perFold, picks };
}

// ---------- evaluation ----------

function betsAt(picks, spread, o) {
  const bets = [];
  for (const r of picks) {
    const cost = entryCost(r.f.price, spread, o.fee);
    if (cost >= o.maxCost) continue;
    bets.push({ eventKey: r.f.eventKey, price: r.f.price, cost, won: r.won, pnl: betPnl(r.won, cost), clv: r.clv });
  }
  return bets;
}

const meanPnl = (bets) => (bets.length ? mean(bets.map((b) => b.pnl)) : null);
const EMPTY_CI = Object.freeze({ estimate: null, lo: null, hi: null, se: null, p: 1 });

function summarizeBets(bets, o, id) {
  if (!bets.length) {
    return { n: 0, nEvents: 0, winRate: null, avgPrice: null, avgCost: null, roi: { ...EMPTY_CI }, pNormal: null, edgeCaptured: { ...EMPTY_CI }, clv: { ...EMPTY_CI, n: 0 }, hurdleRoi: null, mde80: null };
  }
  const boot = clusterBootstrapSums(
    bets,
    (b) => b.eventKey,
    (b) => [1, b.pnl, b.won, b.cost, b.clv ?? 0, b.clv == null ? 0 : 1],
    { roi: (s) => s[1] / s[0], edgeCaptured: (s) => (s[2] - s[3]) / s[0], clv: (s) => (s[5] > 0 ? s[4] / s[5] : NaN) },
    { B: o.boot, seed: [o.seed, id], alpha: o.alpha },
  );
  const pick = ({ estimate, lo, hi, se, p }) => ({ estimate, lo, hi, se, p });
  const roi = pick(boot.stats.roi);
  const zSum = normalQuantile(1 - o.alpha / 2) + normalQuantile(0.8);
  return {
    n: bets.length,
    nEvents: boot.nClusters,
    winRate: mean(bets.map((b) => b.won)),
    avgPrice: mean(bets.map((b) => b.price)),
    avgCost: mean(bets.map((b) => b.cost)),
    roi,
    pNormal: roi.se > 0 ? 1 - normalCdf(roi.estimate / roi.se) : null,
    edgeCaptured: pick(boot.stats.edgeCaptured),
    clv: { ...pick(boot.stats.clv), n: bets.filter((b) => b.clv != null).length },
    // ROI these exact bets would earn if every price were perfectly calibrated: the cost hurdle.
    hurdleRoi: mean(bets.map((b) => b.price / b.cost - 1)),
    // Smallest true ROI this sample could detect (two-sided alpha, 80% power).
    mde80: roi.se != null ? zSum * roi.se : null,
  };
}

function effectiveOffsets(h, datasetOffsets) {
  if (h.maxOffsetH != null) return datasetOffsets.filter((x) => x <= h.maxOffsetH);
  return h.anyOffset ? datasetOffsets : datasetOffsets.filter((x) => h.offsets.includes(x));
}

const hasAll = (r, fields) => fields.every((k) => fin(r.f[k]));

function countEligible(hyp, rows) {
  const offsets = new Set(hyp.offsets);
  let n = 0;
  for (const r of rows) {
    if (!offsets.has(r.f.offsetH) || !hasAll(r, hyp.requires)) continue;
    if (hyp.paramGrid.some((p) => hyp.select(r.f, p))) n++;
  }
  return n;
}

function evaluateHypothesis(h0, ctx, o) {
  const offsets = effectiveOffsets(h0, ctx.offsets);
  const hyp = { ...h0, offsets };
  const info = {
    id: h0.id, name: h0.name, baseId: h0.baseId, sport: h0.sport, role: h0.role, rationale: h0.rationale,
    offsets, paramGrid: h0.paramGrid, nCandidates: offsets.length * h0.paramGrid.length,
  };
  const skip = (reason) => ({ ...info, status: 'skipped', skipReason: reason });
  if (h0.trades && !ctx.hasTrades) return skip('trade features not collected (collect with --trades and rebuild the dataset)');
  if (!offsets.length) return skip(`dataset has none of this hypothesis's decision offsets (${h0.offsets.join(', ')}h)`);
  const nEligible = countEligible(hyp, ctx.rows);
  if (!nEligible) return skip('no dataset rows match any parameter setting');

  const wf = walkForward(hyp, ctx.folds, o);
  const bets = betsAt(wf.picks, o.spread, o);
  const spreads = [...new Set([...o.sensitivitySpreads, o.spread, o.stressSpread])].sort((a, b) => a - b);
  const sensitivity = spreads.map((s) => { const b = betsAt(wf.picks, s, o); return { spread: s, n: b.length, roi: meanPnl(b) }; });
  const stressBets = betsAt(wf.picks, o.stressSpread, o);
  const folds = wf.perFold.map(({ fold, nTrainRows, chosen, picks }) => {
    const fb = betsAt(picks, o.spread, o);
    return { fold, nTrainRows, chosen, nBets: fb.length, roi: meanPnl(fb) };
  });
  const chosenKeys = new Set(folds.filter((f) => f.chosen).map((f) => JSON.stringify([f.chosen.offsetH, f.chosen.params])));
  return {
    ...info,
    status: 'tested',
    nEligible,
    foldsWithParams: folds.filter((f) => f.chosen).length,
    distinctChoices: chosenKeys.size,
    oos: summarizeBets(bets, o, h0.id),
    sensitivity,
    stress: { spread: o.stressSpread, n: stressBets.length, roi: meanPnl(stressBets) },
    folds,
  };
}

function judge(r, o) {
  const fails = [];
  if (r.oos.n < o.minN) fails.push(`OOS n ${r.oos.n} < ${o.minN}`);
  if (!r.bh.significant) fails.push(`not significant after BH-FDR (q-adj ${fmtP(r.bh.pAdj)})`);
  if (!(r.oos.roi.lo > 0)) fails.push('95% CI of ROI reaches 0 or below');
  if (!(r.stress.roi > 0)) fails.push(`ROI not positive at ${r.stress.spread} spread`);
  const survives = fails.length === 0;
  let label = 'SURVIVES';
  if (!survives) label = r.oos.n < o.minN ? 'too few bets' : r.oos.roi.estimate > 0 ? 'no edge (positive but not reliable)' : 'no edge';
  return { survives, label, fails };
}

// ---------- descriptive tables ----------

export function calibration(rows, nBuckets = 10) {
  const acc = {};
  for (const r of rows) {
    const mt = r.f.marketType || 'other';
    const byOff = (acc[mt] ||= {});
    const buckets = (byOff[r.f.offsetH] ||= Array.from({ length: nBuckets }, () => ({ n: 0, sumPrice: 0, wins: 0 })));
    const b = buckets[Math.min(nBuckets - 1, Math.floor(r.f.price * nBuckets))];
    b.n++;
    b.sumPrice += r.f.price;
    b.wins += r.won;
  }
  const out = {};
  for (const [mt, byOff] of Object.entries(acc)) {
    out[mt] = {};
    for (const [off, buckets] of Object.entries(byOff)) {
      out[mt][off] = buckets.flatMap((b, i) => {
        if (!b.n) return [];
        const w = wilson(b.wins, b.n);
        const avgPrice = b.sumPrice / b.n;
        return [{ bucket: `${(i / nBuckets).toFixed(1)}-${((i + 1) / nBuckets).toFixed(1)}`, n: b.n, avgPrice, winRate: w.p, lo: w.lo, hi: w.hi, gap: w.p - avgPrice }];
      });
    }
  }
  return out;
}

function summarizeData(file, rows, read, drops, folds) {
  const markets = new Set(), events = new Set(), offsets = {}, sports = {}, marketTypes = {}, wonByMarketOffset = new Map();
  let withTrades = 0, startMin = Infinity, startMax = -Infinity;
  for (const r of rows) {
    const f = r.f;
    markets.add(f.conditionId || f.id);
    events.add(f.eventKey);
    bump(offsets, f.offsetH);
    bump(sports, f.sport || 'unknown');
    bump(marketTypes, f.marketType || 'other');
    if (fin(f.nTrades24h)) withTrades++;
    startMin = Math.min(startMin, f.startTs);
    startMax = Math.max(startMax, f.startTs);
    const k = `${f.conditionId}|${f.offsetH}`;
    wonByMarketOffset.set(k, (wonByMarketOffset.get(k) || 0) + r.won);
  }
  let labelAnomalies = 0;
  for (const v of wonByMarketOffset.values()) if (v > 1) labelAnomalies++;
  return {
    file, rowsRead: read, rowsUsed: rows.length, drops,
    markets: markets.size, events: events.size,
    startFrom: iso(startMin), startTo: iso(startMax),
    offsets, sports, marketTypes,
    tradeCoverage: rows.length ? withTrades / rows.length : 0,
    labelAnomalies,
    folds: folds.map((f) => ({ fold: f.fold, role: f.fold === 0 ? 'train only' : 'test (OOS)', nRows: f.rows.length, nEvents: f.nEvents, startFrom: iso(f.startMin), startTo: iso(f.startMax), firstDecision: iso(f.decisionMin) })),
  };
}

function eligibleSports(rows, minMarkets) {
  const bySport = new Map();
  for (const r of rows) {
    if (!r.f.sport) continue;
    let s = bySport.get(r.f.sport);
    if (!s) bySport.set(r.f.sport, (s = new Set()));
    s.add(r.f.conditionId || r.f.id);
  }
  // With a single sport every variant would duplicate its generic hypothesis.
  if (bySport.size < 2) return [];
  return [...bySport.entries()].filter(([, s]) => s.size >= minMarkets).map(([k]) => k).sort();
}

function filterOnly(hyps, only) {
  const want = new Set(only);
  const unknown = only.filter((id) => !hyps.some((h) => h.id === id || h.baseId === id));
  if (unknown.length) throw new Error(`unknown hypothesis id(s): ${unknown.join(', ')}. Available: ${hyps.map((h) => h.id).join(', ')}`);
  return hyps.filter((h) => want.has(h.id) || want.has(h.baseId));
}

// ---------- driver ----------

const SOURCE_LABEL_HELP = '--source-label is required: say where the data came from, e.g. --source-label "SYNTHETIC mock data" or --source-label "real: Polymarket gamma/clob, collected 2026-10-20". Every report repeats it.';

export async function runBacktest(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!o.sourceLabel || !String(o.sourceLabel).trim()) throw new Error(SOURCE_LABEL_HELP);
  o.sourceLabel = String(o.sourceLabel).trim();
  const dataFile = path.resolve(o.data);
  const { rows, read, drops } = await loadDataset(dataFile);
  if (!rows.length) throw new Error(`no usable rows in ${dataFile} (read ${read}, drops ${JSON.stringify(drops)})`);
  const folds = assignFolds(rows, o.folds);
  const ctx = {
    rows, folds,
    offsets: [...new Set(rows.map((r) => r.f.offsetH))].sort((a, b) => a - b),
    hasTrades: rows.some((r) => TRADE_FIELDS.some((k) => fin(r.f[k]))),
  };
  const sports = eligibleSports(rows, o.minSportMarkets);
  let hyps = buildHypotheses({ sports });
  if (o.only && o.only.length) hyps = filterOnly(hyps, o.only);

  const results = hyps.map((h) => evaluateHypothesis(h, ctx, o));
  const tested = results.filter((r) => r.status === 'tested');
  const bh = benjaminiHochberg(tested.map((r) => r.oos.roi.p), o.fdr);
  tested.forEach((r, i) => {
    r.bh = { pAdj: bh.adjusted[i], significant: bh.rejected[i] };
    r.verdict = judge(r, o);
  });
  for (const r of results) if (r.status === 'skipped') r.verdict = { survives: false, label: 'skipped', fails: [r.skipReason] };

  const data = summarizeData(dataFile, rows, read, drops, folds);
  const survivors = tested.filter((r) => r.verdict.survives);
  const report = {
    tool: 'research/backtest.js',
    generatedAt: new Date().toISOString(),
    source: { label: o.sourceLabel, looksSynthetic: SYNTHETIC_RE.test(o.sourceLabel), note: 'Label supplied by the caller via --source-label; the backtester cannot verify it.' },
    verdict: null,
    config: {
      data: dataFile, fee: o.fee, spread: o.spread, stressSpread: o.stressSpread, sensitivitySpreads: o.sensitivitySpreads,
      maxCost: o.maxCost, folds: o.folds, embargoH: o.embargoH, minN: o.minN, fdr: o.fdr, boot: o.boot, seed: o.seed,
      alpha: o.alpha, minSportMarkets: o.minSportMarkets, only: o.only || null, sportVariantsFor: sports,
      costModel: 'cost = min(0.999, (price + spread) * (1 + fee)); skip if cost >= maxCost; flat $1 stake; pnl = won ? 1/cost - 1 : -1',
      survivalRule: `OOS n >= ${o.minN} AND BH-significant at q=${o.fdr} AND 95% cluster-bootstrap CI lower bound of ROI > 0 AND ROI > 0 at spread ${o.stressSpread}`,
    },
    data,
    bh: { m: bh.m, q: o.fdr, nRejected: bh.nRejected, minAttainableP: 1 / (o.boot + 1) },
    hypotheses: results,
    calibration: calibration(rows),
    warnings: [],
    caveats: CAVEATS,
  };
  report.warnings = buildWarnings(report, o);
  report.verdict = buildVerdict(report, survivors, o);

  const name = o.name || `backtest-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`;
  const outDir = path.resolve(o.out);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${name}.json`);
  const mdPath = path.join(outDir, `${name}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, (k, v) => (typeof v === 'number' && !fin(v) ? null : v), 2) + '\n');
  fs.writeFileSync(mdPath, toMarkdown(report));
  return { report, jsonPath, mdPath };
}

const CAVEATS = Object.freeze([
  'Price-history points are trade/mid snapshots, not executable asks. The spread haircut only approximates crossing the book; order size, depth and slippage are not modelled.',
  'Only resolved markets with usable price history are included; voided or unresolvable markets were dropped upstream (survivorship).',
  'Fees vary by market and over time; rerun with the fee and spread you would actually pay.',
  'A survivor is a candidate for forward paper-trading at real fills, not proof of an edge. Results describe this dataset\'s period only.',
  'Calibration tables are in-sample and descriptive; they are not a backtest.',
]);

function buildWarnings(rep, o) {
  const w = [];
  const tested = rep.hypotheses.filter((r) => r.status === 'tested');
  if (rep.source.looksSynthetic) w.push('Data source is labelled synthetic/mock: results validate the tooling only.');
  if (tested.length && 1 / (o.boot + 1) > o.fdr / tested.length) {
    w.push(`With --boot ${o.boot} the smallest attainable p (${fmtP(1 / (o.boot + 1))}) exceeds the first BH threshold (${fmtP(o.fdr / tested.length)}), so nothing can pass. Use --boot >= ${Math.ceil(tested.length / o.fdr)}.`);
  }
  if (rep.data.events < 300) w.push(`Only ${rep.data.events} events: far too few to detect realistic edges of a few percent ROI.`);
  if (rep.data.labelAnomalies) w.push(`${rep.data.labelAnomalies} (market, offset) groups have more than one winning outcome — check winnerIndex/labels upstream.`);
  if (o.only && o.only.length) w.push('--only narrowed the BH family. That is only valid if the subset was fixed before looking at any results.');
  const base = tested.find((r) => r.id === 'baseline-all');
  if (base && base.oos.roi.estimate > 0) w.push(`baseline-all is profitable out-of-sample (${pct(base.oos.roi.estimate)}). Buying everything after costs should lose; suspect leakage, bad labels or stale prices before trusting anything else.`);
  for (const r of tested) {
    if (r.verdict.survives && r.role !== 'candidate') w.push(`${r.role} hypothesis ${r.id} survived — this usually means a data problem rather than an edge.`);
    if (r.verdict.survives && r.oos.clv.estimate != null && r.oos.clv.estimate < 0) w.push(`${r.id} survived on ROI but its mean CLV is negative (${num(r.oos.clv.estimate, 4)}): the closing price did not move toward these bets, so CLV does not corroborate the ROI.`);
  }
  const testFolds = o.folds - 1;
  const never = tested.filter((r) => r.foldsWithParams === 0).map((r) => r.id);
  const partial = tested.filter((r) => r.foldsWithParams > 0 && r.foldsWithParams < testFolds).map((r) => `${r.id} (${r.foldsWithParams}/${testFolds})`);
  if (never.length) w.push(`No parameter setting ever reached n >= ${o.minN} in training, so these placed no OOS bets (counted with p = 1): ${never.join(', ')}.`);
  if (partial.length) w.push(`Traded in only some test folds (training n < ${o.minN} in the others): ${partial.join(', ')}.`);
  const skipped = rep.hypotheses.filter((r) => r.status === 'skipped');
  if (skipped.length) w.push(`${skipped.length} hypotheses skipped for missing data (not counted in the BH family): ${skipped.map((r) => r.id).join(', ')}.`);
  return w;
}

function buildVerdict(rep, survivors, o) {
  const tested = rep.hypotheses.filter((r) => r.status === 'tested');
  const sanityFailed = survivors.some((r) => r.role === 'sanity');
  const costs = `fee ${o.fee}, spread haircut ${o.spread}`;
  let text;
  if (!tested.length) {
    text = '**Nothing could be tested.** Every hypothesis was skipped for missing data, so this run says nothing about an edge.';
  } else if (sanityFailed) {
    text = '**Results are not trustworthy.** The sanity baseline (buy every outcome) came out profitable after costs, which should be impossible on correctly built data. Find the leakage or label problem before reading anything else.';
  } else if (!survivors.length) {
    text = `**No hypothesis survived.** ${tested.length} hypotheses were tested out-of-sample after costs (${costs}); none passed all of: n >= ${o.minN}, Benjamini-Hochberg significance at q = ${o.fdr}, a 95% cluster-bootstrap CI for ROI entirely above 0, and positive ROI at a ${o.stressSpread} spread. On this data there is no evidence of a repeatable edge. That is a legitimate result, not a tooling failure.`;
  } else {
    text = `**${survivors.length} of ${tested.length} hypotheses survived every check: ${survivors.map((r) => r.id).join(', ')}.** This is evidence from this dataset only. Before risking money, paper-trade each survivor forward at real order-book fills and confirm the edge persists.`;
  }
  if (rep.source.looksSynthetic) text = `Synthetic data: this run validates the tooling only. ${text}`;
  const base = tested.find((r) => r.id === 'baseline-all');
  const sanity = base && base.oos.n
    ? `Sanity check: baseline-all OOS ROI ${pct(base.oos.roi.estimate)} (95% CI ${ci(base.oos.roi)}); with perfectly calibrated prices the cost drag alone would give ${pct(base.oos.hurdleRoi)}.`
    : null;
  return { text, sanity, survivors: survivors.map((r) => r.id), nTested: tested.length, nSkipped: rep.hypotheses.length - tested.length, sanityFailed };
}

// ---------- markdown ----------

function pct(x, d = 1) {
  if (x == null || !fin(x)) return 'n/a';
  const v = x * 100;
  if (Math.abs(v) < 0.5 * 10 ** -d) return `${(0).toFixed(d)}%`;
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}
function fmtP(p) {
  if (p == null || !fin(p)) return 'n/a';
  return p < 0.001 ? p.toExponential(1) : p.toFixed(3);
}
function num(x, d = 3) {
  if (x == null || !fin(x)) return 'n/a';
  return (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toFixed(d);
}
const ci = (s) => (s && s.lo != null ? `${pct(s.lo)} to ${pct(s.hi)}` : 'n/a');
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const paramStr = (c) => (c ? `${c.offsetH}h ${JSON.stringify(c.params)}` : 'none (no setting reached min n)');

function toMarkdown(rep) {
  const c = rep.config, d = rep.data, L = [];
  const label = esc(rep.source.label);
  L.push(`# Sports edge backtest | data source: ${label}`, '');
  L.push(`**Data source: ${label}** (from \`--source-label\`; the backtester cannot verify it)`, '');
  L.push(rep.source.looksSynthetic
    ? '> **SYNTHETIC / MOCK DATA.** These numbers only validate the tooling. They are not evidence about real Polymarket markets.'
    : '> Results are only as real as the data source above. Confirm it before acting on anything here.');
  L.push('', '## Verdict', '', rep.verdict.text);
  if (rep.verdict.sanity) L.push('', rep.verdict.sanity);

  L.push('', '## Setup', '');
  const sports = Object.entries(d.sports).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  L.push(`- Dataset: \`${d.file}\`. ${d.rowsUsed} rows (${d.rowsRead - d.rowsUsed} dropped), ${d.markets} markets, ${d.events} events, game starts ${d.startFrom} to ${d.startTo}.`);
  L.push(`- Rows by sport: ${sports}. Trade features on ${pct(d.tradeCoverage, 0).replace('+', '')} of rows.`);
  L.push(`- Costs: entry cost = min(0.999, (price + ${c.spread}) x (1 + ${c.fee})); rows with cost >= ${c.maxCost} skipped; flat $1 stake.`);
  L.push(`- Walk-forward: ${c.folds} time-ordered folds, whole events per fold; fold 0 is train-only. For each later fold, parameters (grid x decision offset) are chosen on earlier folds only (best train ROI with n >= ${c.minN}), with a ${c.embargoH}h embargo before the fold's first decision. Only out-of-sample bets are reported.`);
  L.push(`- Statistics: 95% CIs by cluster bootstrap over eventKey (B = ${c.boot}, seed ${c.seed}); one-sided p for ROI > 0 (floor 1/(B+1) = ${fmtP(rep.bh.minAttainableP)}); Benjamini-Hochberg FDR q = ${c.fdr} across the ${rep.bh.m} hypotheses tested in this run.`);
  L.push(`- SURVIVES requires: ${c.survivalRule}.`);
  L.push(`- Per-sport variants: ${c.sportVariantsFor.length ? c.sportVariantsFor.join(', ') : 'none'} (sports with >= ${c.minSportMarkets} markets).`);

  L.push('', '## Results (out-of-sample only)', '');
  L.push('ROI is profit per $1 staked. CLV = close price minus entry price (positive means the market moved your way). Hurdle = ROI these bets would earn if prices were perfectly calibrated. The spread columns re-cost the same out-of-sample picks at each haircut.', '');
  const spreads = rep.hypotheses.find((r) => r.sensitivity)?.sensitivity.map((s) => s.spread) || [];
  L.push(`| Hypothesis | Bets (events) | ROI | 95% CI | p | BH q-adj | CLV | Hurdle | ROI at spread ${spreads.join(' / ')} | Verdict |`);
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  const tested = rep.hypotheses.filter((r) => r.status === 'tested').sort((a, b) =>
    (b.verdict.survives - a.verdict.survives) || (a.oos.roi.p - b.oos.roi.p) || a.id.localeCompare(b.id));
  for (const r of tested) {
    const tag = r.role === 'candidate' ? '' : ` (${r.role})`;
    const verdict = r.verdict.survives ? '**SURVIVES**' : r.verdict.label;
    L.push(`| ${esc(r.id)}${tag} | ${r.oos.n} (${r.oos.nEvents}) | ${pct(r.oos.roi.estimate)} | ${ci(r.oos.roi)} | ${fmtP(r.oos.roi.p)} | ${fmtP(r.bh.pAdj)} | ${num(r.oos.clv.estimate, 4)} | ${pct(r.oos.hurdleRoi)} | ${r.sensitivity.map((s) => pct(s.roi)).join(' / ')} | ${verdict} |`);
  }

  const survivors = tested.filter((r) => r.verdict.survives);
  if (survivors.length) {
    L.push('', '## Survivors', '');
    for (const r of survivors) {
      L.push(`### ${esc(r.id)}: ${esc(r.name)}`, '', esc(r.rationale), '');
      L.push(`- OOS: ${r.oos.n} bets on ${r.oos.nEvents} events, win rate ${num(r.oos.winRate)} vs avg cost ${num(r.oos.avgCost)}; edge captured ${num(r.oos.edgeCaptured.estimate)} (CI ${num(r.oos.edgeCaptured.lo)} to ${num(r.oos.edgeCaptured.hi)}); mean CLV ${num(r.oos.clv.estimate, 4)} (CI ${num(r.oos.clv.lo, 4)} to ${num(r.oos.clv.hi, 4)}, n ${r.oos.clv.n}).`);
      L.push(`- Minimum detectable ROI at this sample size (80% power): ${pct(r.oos.mde80)}. Distinct parameter choices across folds: ${r.distinctChoices}.`);
      for (const f of r.folds) L.push(`- Fold ${f.fold}: ${paramStr(f.chosen)}${f.chosen ? ` (train n ${f.chosen.trainN}, ROI ${pct(f.chosen.trainRoi)})` : ''}; test ${f.nBets} bets, ROI ${pct(f.roi)}.`);
      L.push('');
    }
  }

  const skipped = rep.hypotheses.filter((r) => r.status === 'skipped');
  if (skipped.length) {
    L.push('', '## Skipped (no data; not in the BH family)', '');
    for (const r of skipped) L.push(`- ${esc(r.id)}: ${esc(r.skipReason)}`);
  }

  L.push('', '## Calibration (in-sample, descriptive)', '');
  const firstOffset = Object.keys(d.offsets).map(Number).sort((a, b) => a - b)[0];
  L.push(`Rows at the ${firstOffset}h offset (closest to start); other offsets are in the JSON report. Gap = win rate minus average price. The Wilson CIs are per bucket, ignore within-event correlation and are not corrected for looking at many buckets, so an isolated gap is not an edge; only the walk-forward results above test that.`);
  const types = Object.keys(rep.calibration).sort((a, b) => (d.marketTypes[b] || 0) - (d.marketTypes[a] || 0));
  for (const mt of types) {
    const buckets = rep.calibration[mt][firstOffset];
    if (!buckets || !buckets.length) continue;
    L.push('', `**${esc(mt)}**`, '', '| Price | n | Avg price | Win rate | 95% CI | Gap |', '|---|---|---|---|---|---|');
    for (const b of buckets) L.push(`| ${b.bucket} | ${b.n} | ${num(b.avgPrice)} | ${num(b.winRate)} | ${num(b.lo)}-${num(b.hi)} | ${b.gap >= 0 ? '+' : ''}${num(b.gap)} |`);
  }

  if (rep.warnings.length) {
    L.push('', '## Warnings', '');
    for (const w of rep.warnings) L.push(`- ${esc(w)}`);
  }
  L.push('', '## Caveats', '');
  for (const cv of rep.caveats) L.push(`- ${cv}`);
  L.push('', `_Generated ${rep.generatedAt} by research/backtest.js. Full numbers, per-fold choices and all calibration tables are in the JSON report._`, '');
  return L.join('\n');
}

// ---------- CLI ----------

const USAGE = `Usage: node research/backtest.js --source-label "<where the data came from>" [options]
  --source-label <text>    REQUIRED, e.g. "SYNTHETIC mock data" or "real: Polymarket gamma/clob, collected 2026-10-20"
  --data <file>            dataset.jsonl (default research/data/dataset.jsonl)
  --fee 0.01               proportional fee on entry
  --spread 0.01            spread haircut added to the entry price
  --stress-spread 0.02     spread at which a survivor must still be profitable
  --folds 5                time-ordered walk-forward folds (fold 0 is train-only)
  --embargo-h 24           train rows must start this many hours before the test fold's first decision
  --min-n 50               min bets for a train parameter choice and for an OOS survivor
  --fdr 0.10               Benjamini-Hochberg false discovery rate
  --boot 2000              bootstrap replicates
  --seed 1                 RNG seed
  --min-sport-markets 300  markets a sport needs before its per-sport variants are tested
  --only <ids>             comma-separated hypothesis ids (a base id also selects its @sport variants)
  --out <dir>              report directory (default research/reports)
  --name <base>            report file base name (default backtest-<UTC timestamp>)
  --list                   print the base hypothesis ids and exit`;

const VALUE_OPTS = new Set(['data', 'source-label', 'fee', 'spread', 'stress-spread', 'folds', 'embargo-h', 'min-n', 'fdr', 'boot', 'seed', 'min-sport-markets', 'only', 'out', 'name']);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') { a.help = true; continue; }
    if (tok === '--list') { a.list = true; continue; }
    if (!tok.startsWith('--')) throw new Error(`unexpected argument "${tok}"`);
    const eq = tok.indexOf('=');
    const key = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
    if (!VALUE_OPTS.has(key)) throw new Error(`unknown option --${key} (see --help)`);
    const val = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (val == null) throw new Error(`missing value for --${key}`);
    a[key] = val;
  }
  return a;
}

function numArg(name, v, { min = 0, max = Infinity, int = false, exclusiveMin = false } = {}) {
  const n = Number(v);
  const ok = fin(n) && (exclusiveMin ? n > min : n >= min) && n <= max && (!int || Number.isInteger(n));
  if (!ok) throw new Error(`--${name} must be ${int ? 'an integer' : 'a number'} ${exclusiveMin ? '>' : '>='} ${min}${max < Infinity ? ` and <= ${max}` : ''}, got "${v}"`);
  return n;
}

export function optsFromArgs(argv) {
  const a = parseArgs(argv);
  if (a.help || a.list) return { help: !!a.help, list: !!a.list };
  const o = {};
  if (a.data) o.data = a.data;
  if (a.out) o.out = a.out;
  if (a.name) {
    if (/[\/\\]|\.\./.test(a.name)) throw new Error('--name must be a plain file base name');
    o.name = a.name;
  }
  if (a['source-label'] != null) o.sourceLabel = a['source-label'];
  if (a.fee != null) o.fee = numArg('fee', a.fee, { max: 1 });
  if (a.spread != null) o.spread = numArg('spread', a.spread, { max: 1 });
  if (a['stress-spread'] != null) o.stressSpread = numArg('stress-spread', a['stress-spread'], { max: 1 });
  if (a.folds != null) o.folds = numArg('folds', a.folds, { min: 2, int: true });
  if (a['embargo-h'] != null) o.embargoH = numArg('embargo-h', a['embargo-h']);
  if (a['min-n'] != null) o.minN = numArg('min-n', a['min-n'], { min: 1, int: true });
  if (a.fdr != null) o.fdr = numArg('fdr', a.fdr, { min: 0, max: 1, exclusiveMin: true });
  if (a.boot != null) o.boot = numArg('boot', a.boot, { min: 1, int: true });
  if (a.seed != null) o.seed = numArg('seed', a.seed, { min: -Infinity });
  if (a['min-sport-markets'] != null) o.minSportMarkets = numArg('min-sport-markets', a['min-sport-markets'], { min: 1, int: true });
  if (a.only != null) {
    o.only = a.only.split(',').map((s) => s.trim()).filter(Boolean);
    if (!o.only.length) throw new Error('--only is empty');
  }
  return o;
}

async function main() {
  const o = optsFromArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return; }
  if (o.list) {
    for (const h of BASE_HYPOTHESES) console.log(`${h.id.padEnd(22)} ${h.role.padEnd(9)} ${h.name}`);
    console.log('(per-sport variants <id>@<sport> are added for sports with enough markets)');
    return;
  }
  if (!o.sourceLabel) throw new Error(SOURCE_LABEL_HELP);
  const { report, jsonPath, mdPath } = await runBacktest(o);
  console.log(`data source: ${report.source.label}`);
  console.log(report.verdict.text.replace(/\*\*/g, ''));
  if (report.verdict.sanity) console.log(report.verdict.sanity);
  for (const w of report.warnings) console.log(`warning: ${w}`);
  console.log(`report: ${mdPath}\njson:   ${jsonPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
}
