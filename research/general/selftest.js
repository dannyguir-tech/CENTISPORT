#!/usr/bin/env node
// SYNTHETIC self-test of the NON-SPORTS ("general") track: research/general/build-dataset.js +
// research/backtest.js --hypotheses research/general/hypotheses.js on worlds with known ground truth
// (research/general/synthetic.js). It says NOTHING about real Polymarket markets.
//
//   null    - calibrated martingale prices (deadline hazards, thresholds, negRisk "who wins" groups):
//             after costs no rule has positive expected ROI, so every SURVIVES is a false discovery.
//   planted - displayed Yes longshots (~0.02-0.15) win 5 pp less often than priced: longshot-fade
//             must SURVIVE every seed, its mirrors (longshot-buy, baseline-all) must not.
// The builder and backtester run as child processes, exactly as a user runs them. Every tested
// hypothesis is then re-traded in-process with the per-fold choices the backtest makes and priced at
// the generator's true probabilities, which tells a real discovery from a lucky one and doubles as a
// look-ahead detector (a rule that saw information newer than its fill price shows +EV in the null).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIRTY_DROP_REASON, PLANTED_EDGES, PLANTED_MIRRORS, WORLDS, generateWorld } from './synthetic.js';
import { ALL_OFFSETS_H, MAX_PRICE, MIN_PRICE, maxPriceAgeSec, offsetLabel } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD = path.join(HERE, 'build-dataset.js');
const BACKTEST = path.join(HERE, '..', 'backtest.js');
const HYPOTHESES = path.join(HERE, 'hypotheses.js');
const HOUR = 3600;
const TAG = '[SYNTHETIC general]';
const NULL_LIKE = new Set(['null']);

const DEFAULTS = Object.freeze({ events: 10000, seeds: [1, 2, 3], worlds: WORLDS, jobs: 2, boot: 2000, fdr: 0.1, keep: false, workDir: null, json: null });

const log = (s = '') => { for (const line of String(s).split('\n')) console.log(`${TAG} ${line}`); };
const fin = Number.isFinite;
const pct = (x, d = 1) => (x == null || !fin(x) ? 'n/a' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const fmtP = (p) => (p == null || !fin(p) ? 'n/a' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));
const tail = (s, n = 600) => String(s || '').trim().slice(-n).replace(/\s+/g, ' ');

const USAGE = `Usage: node research/general/selftest.js [options]
SYNTHETIC self-test of the general (non-sports) track. Output is about the tooling only.
  --events 10000    events per world
  --seeds 1,2,3     one world of each kind per seed
  --worlds null,planted
  --jobs 2          worlds processed concurrently
  --boot 2000       bootstrap replicates passed to backtest.js
  --fdr 0.10        BH false discovery rate passed to backtest.js
  --work-dir <dir>  where worlds are written (default: a new temp dir)
  --keep            keep generated data, datasets and reports
  --json <file>     also write a machine-readable summary
Exit code: 0 PASS, 1 FAIL, 2 tooling error.`;

class UsageError extends Error {}

export function optsFromArgs(argv) {
  const o = { ...DEFAULTS };
  const num = (k, v, { int = false, min = 0, max = Infinity, exclusiveMin = false } = {}) => {
    const n = Number(v);
    if (!fin(n) || (exclusiveMin ? n <= min : n < min) || n > max || (int && !Number.isInteger(n))) throw new UsageError(`--${k} must be ${int ? 'an integer' : 'a number'} >= ${min}, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') return { help: true };
    if (tok === '--keep') { o.keep = true; continue; }
    if (!tok.startsWith('--')) throw new UsageError(`unexpected argument "${tok}"`);
    const eq = tok.indexOf('=');
    const key = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
    const val = eq > 0 ? tok.slice(eq + 1) : argv[++i];
    if (val == null) throw new UsageError(`missing value for --${key}`);
    if (key === 'events') o.events = num(key, val, { int: true, min: 1 });
    else if (key === 'seeds') {
      o.seeds = [...new Set(val.split(',').map((s) => s.trim()).filter(Boolean).map((s) => num('seeds', s, { int: true, min: -Infinity })))];
      if (!o.seeds.length) throw new UsageError('--seeds is empty');
    } else if (key === 'worlds') {
      o.worlds = [...new Set(val.split(',').map((s) => s.trim()).filter(Boolean))];
      if (!o.worlds.length || o.worlds.some((w) => !WORLDS.includes(w))) throw new UsageError(`--worlds takes a comma-separated subset of ${WORLDS.join(', ')}`);
    } else if (key === 'jobs') o.jobs = num(key, val, { int: true, min: 1 });
    else if (key === 'boot') o.boot = num(key, val, { int: true, min: 1 });
    else if (key === 'fdr') o.fdr = num(key, val, { min: 0, max: 1, exclusiveMin: true });
    else if (key === 'work-dir') o.workDir = val;
    else if (key === 'json') o.json = val;
    else throw new UsageError(`unknown option --${key} (see --help)`);
  }
  return o;
}

function runNode(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, ms: Date.now() - t0 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? -1 : code, stdout, stderr: timedOut ? `${stderr}\ntimed out after ${timeoutMs / 1000}s` : stderr, ms: Date.now() - t0 }); });
  });
}

async function loadTruth(file) {
  const truth = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) { const t = JSON.parse(line); truth.set(t.conditionId, t); }
  return truth;
}

// True probability that a row's side wins, with the information of its price point T (a point
// stamped hourTs + s, s < 1 h, shows the information as of hourTs).
export function trueProb(truth, f) {
  const t = truth.get(f.conditionId);
  if (!t) return null;
  const T = f.decisionTs - f.priceAgeSec;
  const q = t.q[T - (T % HOUR)];
  if (q == null) return null;
  return f.side === 'yes' ? q : 1 - q;
}

// Streams dataset.jsonl and checks every row against the generator's truth and the row rules.
async function scanDataset(file, truth, gen) {
  const mustDrop = new Map();
  for (const [kind, reason] of Object.entries(DIRTY_DROP_REASON)) for (const cid of gen.dirty[kind] || []) mustDrop.set(cid, reason);
  const out = { rows: 0, byOffset: {}, problems: {}, examples: [], leaked: 0, unknown: 0, negRiskRows: 0, withSum: 0, over: 0, under: 0, flags: { isDeadline: 0, isWin: 0, isThreshold: 0 }, keptDirty: { event_end_only: 0, late_close: 0 } };
  const keepDirty = new Map([...(gen.dirty.event_end_only || []).map((c) => [c, 'event_end_only']), ...(gen.dirty.late_close || []).map((c) => [c, 'late_close'])]);
  const seenKept = new Set();
  const bad = (k, r) => { out.problems[k] = (out.problems[k] || 0) + 1; if (out.examples.length < 5) out.examples.push(`${k}: ${r.id}`); };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    out.rows++;
    out.byOffset[r.offsetLabel] = (out.byOffset[r.offsetLabel] || 0) + 1;
    if (mustDrop.has(r.conditionId)) out.leaked++;
    if (keepDirty.has(r.conditionId) && !seenKept.has(r.conditionId)) { seenKept.add(r.conditionId); out.keptDirty[keepDirty.get(r.conditionId)]++; }
    const t = truth.get(r.conditionId);
    if (!t) { out.unknown++; continue; }
    if (r.startTs !== t.anchorTs) bad('anchor_mismatch', r);
    if (r.settleTs !== t.closedTs) bad('settle_mismatch', r);
    if (!(r.decisionTs < t.closedTs)) bad('decision_after_close', r);
    if (!(r.decisionTs >= t.listingTs)) bad('decision_before_listing', r);
    if (!(r.decisionTs < r.startTs)) bad('decision_not_before_anchor', r);
    if (!(r.priceAgeSec >= 0 && r.priceAgeSec <= maxPriceAgeSec(r.offsetH))) bad('stale_or_future_price', r);
    if (!(r.yesPrice >= MIN_PRICE && r.yesPrice <= MAX_PRICE)) bad('price_out_of_range', r);
    if (r.won !== (r.side === 'yes' ? t.yesWon : 1 - t.yesWon)) bad('label_mismatch', r);
    if (r.category !== t.category || r.sport !== r.category) bad('category_mismatch', r);
    if (trueProb(truth, r) == null) bad('no_truth_for_price_point', r);
    if (r.side === 'yes') {
      for (const k of Object.keys(out.flags)) if (r[k]) out.flags[k]++;
      if (r.negRisk) {
        out.negRiskRows++;
        if (r.groupYesSum != null) {
          out.withSum++;
          if (r.groupYesSum >= 1.03) out.over++;
          if (r.groupYesSum <= 0.97) out.under++;
        }
      }
    }
  }
  return out;
}

async function loadAuditApi() {
  try {
    const bt = await import(pathToFileURL(BACKTEST).href);
    const hy = await import(pathToFileURL(HYPOTHESES).href);
    const api = { loadDataset: bt.loadDataset, assignFolds: bt.assignFolds, walkForward: bt.walkForward, entryCost: bt.entryCost, buildHypotheses: hy.buildHypotheses, settings: hy.BACKTEST || {} };
    const missing = ['loadDataset', 'assignFolds', 'walkForward', 'entryCost', 'buildHypotheses'].filter((k) => typeof api[k] !== 'function');
    return missing.length ? { unavailable: `backtest.js/hypotheses.js do not export ${missing.join(', ')}` } : api;
  } catch (e) {
    return { unavailable: `cannot import backtest.js/hypotheses.js: ${e.message}` };
  }
}

// Re-runs each tested hypothesis's walk-forward with the report's settings and prices its OOS bets
// at the true probability: trueRoi = mean(q / cost - 1). n must equal the report's OOS n.
async function auditWithTruth(api, report, datasetFile, truth) {
  const c = report.config;
  const { rows } = await api.loadDataset(datasetFile, { metaFields: c.metaFields || [] });
  const folds = api.assignFolds(rows, c.folds, { foldBy: c.foldBy });
  const hyps = new Map(api.buildHypotheses({ sports: c.sportVariantsFor || [] }).map((h) => [h.id, h]));
  const o = { spread: c.spread, fee: c.fee, maxCost: c.maxCost, minN: c.minN, embargoH: c.embargoH, embargoFrom: c.embargoFrom, cutoffScope: c.cutoffScope };
  const byId = {};
  for (const r of report.hypotheses) {
    if (r.status !== 'tested') continue;
    const h0 = hyps.get(r.id);
    if (!h0) { byId[r.id] = { error: 'id not in hypotheses.js' }; continue; }
    const wf = api.walkForward({ ...h0, offsets: r.offsets }, folds, o);
    let n = 0, priced = 0, ev = 0;
    for (const row of wf.picks) {
      const cost = api.entryCost(row.f.price, o.spread, o.fee);
      if (cost >= o.maxCost) continue;
      n++;
      const q = trueProb(truth, row.f);
      if (q == null) continue;
      priced++;
      ev += q / cost - 1;
    }
    byId[r.id] = { n, priced, trueRoi: priced ? ev / priced : null, matches: n === r.oos.n };
  }
  return { byId };
}

async function runWorld(seed, world, o, root, api) {
  const dir = path.join(root, `seed-${seed}-${world}`);
  const dataDir = path.join(dir, 'data');
  const truthFile = path.join(dir, 'truth.jsonl');
  const reportDir = path.join(dir, 'reports');
  const datasetFile = path.join(dataDir, 'dataset.jsonl');
  const res = { seed, world, dir, checks: [], survivors: [], tested: 0, error: null, ms: 0 };
  const t0 = Date.now();
  const fail = (msg) => { res.error = msg; res.ms = Date.now() - t0; return res; };
  let gen;
  try {
    gen = await generateWorld({ world, seed, events: o.events, dataDir, truthFile });
  } catch (e) {
    return fail(`generator failed: ${e.stack || e.message}`);
  }
  res.gen = { markets: gen.marketsKept, generated: gen.marketsGenerated, byKind: gen.byKind, skipped: gen.skipped };
  const b = await runNode(BUILD, ['--data-dir', dataDir], 15 * 60e3);
  if (b.code !== 0) return fail(`build-dataset.js exited with code ${b.code}: ${tail(b.stderr || b.stdout)}`);
  let summary;
  try { summary = JSON.parse(fs.readFileSync(path.join(dataDir, 'dataset.summary.json'), 'utf8')); } catch (e) { return fail(`cannot read dataset summary: ${e.message}`); }
  const label = `SYNTHETIC general selftest ${world} world, seed ${seed} (tooling validation only, not market data)`;
  const bt = await runNode(BACKTEST, ['--hypotheses', HYPOTHESES, '--data', datasetFile, '--source-label', label, '--out', reportDir, '--name', 'backtest', '--seed', String(seed), '--boot', String(o.boot), '--fdr', String(o.fdr)], 30 * 60e3);
  if (bt.code !== 0) return fail(`backtest.js exited with code ${bt.code}: ${tail(bt.stderr || bt.stdout)}`);
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(reportDir, 'backtest.json'), 'utf8')); } catch (e) { return fail(`cannot read backtest report: ${e.message}`); }
  if (!Array.isArray(report.hypotheses) || !report.config || !report.data) return fail('backtest report lacks hypotheses/config/data');
  const truth = await loadTruth(truthFile);
  const ds = await scanDataset(datasetFile, truth, gen);
  let audit;
  if (api.unavailable) audit = { unavailable: api.unavailable };
  else {
    try { audit = await auditWithTruth(api, report, datasetFile, truth); } catch (e) { audit = { unavailable: `audit failed: ${e.message}` }; }
  }
  evaluateWorld(res, report, ds, gen, summary, audit, o);
  res.ms = Date.now() - t0;
  return res;
}

function evaluateWorld(res, report, ds, gen, summary, audit, o) {
  const check = (name, status, detail) => res.checks.push({ name, status, detail });
  const hyps = new Map(report.hypotheses.map((h) => [h.id, h]));
  const tested = report.hypotheses.filter((h) => h.status === 'tested');
  const truthOf = (id) => (audit.byId && audit.byId[id] ? audit.byId[id] : null);
  const trueStr = (id) => { const a = truthOf(id); return a && a.trueRoi != null ? `true ${pct(a.trueRoi)}` : 'true n/a'; };
  const summ = (h) => {
    if (!h) return 'not in report';
    if (h.status !== 'tested') return `skipped: ${h.skipReason || 'unknown'}`;
    const r = h.oos.roi;
    return `ROI ${pct(r.estimate)} (CI ${pct(r.lo)} to ${pct(r.hi)}), p ${fmtP(r.p)}, BH q ${fmtP(h.bh?.pAdj)}, @${h.stress?.spread} ${pct(h.stress?.roi)}, n ${h.oos.n}/${h.oos.nEvents} ev, ${trueStr(h.id)}`;
  };
  res.tested = tested.length;
  res.survivors = tested.filter((h) => h.verdict?.survives).map((h) => ({ id: h.id, trueRoi: truthOf(h.id)?.trueRoi ?? null }));
  res.auditAvailable = !audit.unavailable;

  // Dataset construction.
  const wantOffsets = ALL_OFFSETS_H.map(offsetLabel);
  const missingOffsets = wantOffsets.filter((k) => !ds.byOffset[k]);
  const problems = Object.entries(ds.problems);
  check('dataset: row rules + truth (anchor, settle, open, listing, staleness, labels)', !ds.rows || problems.length || ds.unknown || missingOffsets.length ? 'FAIL' : 'PASS',
    `${ds.rows} rows (${wantOffsets.map((k) => `${k} ${ds.byOffset[k] || 0}`).join(', ')})${problems.length ? `; PROBLEMS ${problems.map(([k, v]) => `${k}:${v}`).join(' ')} e.g. ${ds.examples.join('; ')}` : ''}${ds.unknown ? `; ${ds.unknown} rows of unknown markets` : ''}${missingOffsets.length ? `; MISSING offsets ${missingOffsets.join(', ')}` : ''}`);
  const dropReasons = Object.values(DIRTY_DROP_REASON);
  const notSeen = dropReasons.filter((k) => !gen.skipped[k]);
  const exclOk = gen.skipped.event_sports > 0 && gen.skipped.event_crypto_up_or_down > 0;
  check('collector rules: dirty markets dropped, sports/Up-or-Down excluded', ds.leaked || notSeen.length || !exclOk ? 'FAIL' : 'PASS',
    `${ds.leaked} rows from must-drop markets; skip counts ${dropReasons.map((k) => `${k} ${gen.skipped[k] || 0}`).join(', ')}; excluded events sports ${gen.skipped.event_sports || 0}, up-or-down ${gen.skipped.event_crypto_up_or_down || 0}`);
  const av = summary.anchorVsClose || {};
  const keptOk = av.anchorFromEventEndDate > 0 && av.endMoreThan30dBeforeClose > 0 && ds.keptDirty.event_end_only > 0 && ds.keptDirty.late_close > 0;
  check('dataset: event-endDate fallback and late closes kept', keptOk ? 'PASS' : 'FAIL',
    `anchor from event endDate ${av.anchorFromEventEndDate}, endDate > 30 d before close ${av.endMoreThan30dBeforeClose}, after close ${av.endMoreThan30dAfterClose}; rows kept from event_end_only ${ds.keptDirty.event_end_only}, late_close ${ds.keptDirty.late_close} markets`);
  const flagsOk = ds.flags.isDeadline > 0 && ds.flags.isWin > 0 && ds.flags.isThreshold > 0;
  // A calibrated group can only sum below 1 (hidden outcomes): a null world has no overround by
  // construction (anything that lifts a calibrated group above 1 underprices some No). The planted
  // longshot bias lifts sums above 1, so the planted world exercises the overround side.
  const groupOk = ds.withSum > 0.3 * ds.negRiskRows && ds.withSum < ds.negRiskRows && (NULL_LIKE.has(res.world) ? ds.under > 0 : ds.over > 0);
  check('dataset: question flags + synchronized negRisk Yes-sums', flagsOk && groupOk ? 'PASS' : 'FAIL',
    `Yes rows flagged deadline ${ds.flags.isDeadline}, win ${ds.flags.isWin}, threshold ${ds.flags.isThreshold}; negRisk Yes rows ${ds.negRiskRows}, with a synchronized sum ${ds.withSum} (>= 1.03: ${ds.over}, <= 0.97: ${ds.under}), nulled ${ds.negRiskRows - ds.withSum}`);

  const base = hyps.get('baseline-all');
  const baseOk = base && base.status === 'tested' && !base.verdict?.survives && base.oos.roi.estimate < 0;
  check('baseline-all loses after costs (sanity)', baseOk ? 'PASS' : 'FAIL', base ? `${summ(base)}; hurdle ${pct(base.oos?.hurdleRoi)}` : 'baseline-all missing');

  if (audit.unavailable) check('truth audit', 'WARN', `unavailable (${audit.unavailable})`);
  else {
    const mism = Object.entries(audit.byId).filter(([, a]) => !a.matches || a.error || a.priced !== a.n);
    check('truth audit reproduces backtest OOS bets', mism.length ? 'FAIL' : 'PASS',
      mism.length ? `${mism.length} differ (e.g. ${mism[0][0]}: audit n ${mism[0][1].n}, priced ${mism[0][1].priced}, report n ${hyps.get(mism[0][0])?.oos?.n})` : `bet counts match and every bet is priced for all ${tested.length} tested hypotheses`);
    if (NULL_LIKE.has(res.world)) {
      let worst = null;
      for (const [id, a] of Object.entries(audit.byId)) if (a.trueRoi != null && (!worst || a.trueRoi > worst.v)) worst = { id, v: a.trueRoi };
      check('truth: no tested rule has +EV at its fill price (no look-ahead)', worst && worst.v < 0 ? 'PASS' : 'FAIL', worst ? `highest true OOS ROI ${pct(worst.v)} (${worst.id})` : 'no priced bets');
    } else {
      const weak = Object.keys(PLANTED_EDGES).filter((id) => !(truthOf(id)?.trueRoi > 0));
      check('truth: planted rule has +EV (generator sanity)', weak.length ? 'FAIL' : 'PASS', Object.keys(PLANTED_EDGES).map((id) => `${id} ${pct(truthOf(id)?.trueRoi)}`).join(', '));
    }
  }

  if (NULL_LIKE.has(res.world)) {
    const s = res.survivors;
    check('no hypothesis SURVIVES', s.length ? 'COUNT' : 'PASS', s.length ? `${s.length} false survivor(s): ${s.map((x) => x.id).join(', ')}` : `0 of ${tested.length} tested`);
    return;
  }
  for (const id of Object.keys(PLANTED_EDGES)) {
    const h = hyps.get(id);
    check(`planted ${id} SURVIVES`, h?.verdict?.survives ? 'PASS' : 'FAIL', summ(h));
  }
  for (const id of PLANTED_MIRRORS) {
    const h = hyps.get(id);
    check(`mirror ${id} does not survive`, h && !h.verdict?.survives ? 'PASS' : 'FAIL', h && h.status === 'tested' ? `ROI ${pct(h.oos.roi.estimate)}, ${trueStr(id)}` : summ(h));
  }
  const others = res.survivors.filter((s) => !(s.id in PLANTED_EDGES));
  check('other survivors (truth-audited)', 'INFO', others.length
    ? others.map((s) => `${s.id} ${s.trueRoi == null ? '(true n/a)' : s.trueRoi > 0 ? `(true ${pct(s.trueRoi)})` : `(FALSE: true ${pct(s.trueRoi)})`}`).join(', ')
    : 'none');
}

function aggregate(results, o) {
  const agg = [];
  const nulls = results.filter((r) => NULL_LIKE.has(r.world) && !r.error);
  const planted = results.filter((r) => r.world === 'planted' && !r.error);
  if (nulls.length) {
    const withSurv = nulls.filter((r) => r.survivors.length).length;
    const allowed = Math.floor(o.fdr * nulls.length);
    agg.push({ name: 'null worlds: false-survival rate', status: withSurv <= allowed ? 'PASS' : 'FAIL',
      detail: `${withSurv} of ${nulls.length} null worlds had a survivor (${nulls.reduce((s, r) => s + r.survivors.length, 0)} of ${nulls.reduce((s, r) => s + r.tested, 0)} tests); allowed <= ${allowed} = floor(q ${o.fdr} x ${nulls.length})` });
  }
  if (planted.length) {
    const parts = Object.keys(PLANTED_EDGES).map((id) => ({ id, k: planted.filter((r) => r.checks.some((c) => c.name === `planted ${id} SURVIVES` && c.status === 'PASS')).length }));
    agg.push({ name: 'planted worlds: detection rate', status: parts.every((p) => p.k === planted.length) ? 'PASS' : 'FAIL', detail: parts.map((p) => `${p.id} ${p.k}/${planted.length}`).join(', ') });
    const audited = planted.filter((r) => r.auditAvailable);
    const known = audited.flatMap((r) => r.survivors).filter((s) => s.trueRoi != null);
    const falseOnes = known.filter((s) => s.trueRoi <= 0);
    const fdp = known.length ? falseOnes.length / known.length : 0;
    agg.push({ name: 'planted worlds: false-discovery proportion', status: audited.length ? (fdp <= o.fdr ? 'PASS' : 'FAIL') : 'WARN',
      detail: audited.length ? `${falseOnes.length} of ${known.length} survivors have true OOS ROI <= 0 (limit q ${o.fdr})${falseOnes.length ? `: ${[...new Set(falseOnes.map((s) => s.id))].join(', ')}` : ''}` : 'truth audit unavailable' });
  }
  return agg;
}

function printTable(results, agg) {
  const row = (seed, world, name, status, detail) => log(`${String(seed).padStart(4)}  ${String(world).padEnd(7)}  ${String(name).padEnd(74)}  ${String(status).padEnd(6)}  ${detail}`);
  log('');
  log('RESULTS (SYNTHETIC data; tooling validation only)');
  for (const r of results) {
    if (r.error) { row(r.seed, r.world, 'run', 'ERROR', r.error); continue; }
    for (const c of r.checks) row(r.seed, r.world, c.name, c.status, c.detail);
  }
  log('');
  log('AGGREGATE (SYNTHETIC)');
  for (const a of agg) row('all', '', a.name, a.status, a.detail);
  log('');
  log('Null worlds: every SURVIVES is false (COUNT rows feed the aggregate rule); a +EV rule at its fill price would mean look-ahead.');
  log('Planted worlds: longshot-fade must survive every seed, its mirrors never; survivors are priced at the true probabilities.');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function main() {
  const o = optsFromArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return 0; }
  log('SYNTHETIC SELF-TEST of research/general/build-dataset.js + research/backtest.js --hypotheses research/general/hypotheses.js');
  log('Generated data with known ground truth: validates the TOOLING ONLY, never evidence about real Polymarket markets.');
  const root = o.workDir ? path.resolve(o.workDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'centisport-general-selftest-'));
  fs.mkdirSync(root, { recursive: true });
  log(`events/world ${o.events}, seeds ${o.seeds.join(',')}, worlds ${o.worlds.join(',')}, B ${o.boot}, q ${o.fdr}, jobs ${o.jobs}; work dir ${root}${o.keep ? ' (kept)' : ''}`);
  const api = await loadAuditApi();
  if (api.unavailable) log(`warning: truth audit disabled: ${api.unavailable}`);
  const tasks = o.seeds.flatMap((seed) => o.worlds.map((world) => ({ seed, world })));
  const t0 = Date.now();
  const results = await pool(tasks, o.jobs, async ({ seed, world }) => {
    const r = await runWorld(seed, world, o, root, api);
    log(r.error ? `seed ${seed} ${world}: ERROR ${r.error}` : `seed ${seed} ${world}: ${r.gen.markets} markets, ${r.tested} hypotheses tested, survivors: ${r.survivors.map((s) => s.id).join(', ') || 'none'} (${(r.ms / 1000).toFixed(0)}s)`);
    if (!o.keep) fs.rmSync(r.dir, { recursive: true, force: true });
    return r;
  });
  if (!o.keep && !o.workDir) fs.rmSync(root, { recursive: true, force: true });
  const agg = aggregate(results, o);
  printTable(results, agg);
  const errors = results.filter((r) => r.error).length;
  const failed = [...results.flatMap((r) => r.checks), ...agg].filter((c) => c.status === 'FAIL').length;
  const overall = errors ? 'ERROR' : failed ? 'FAIL' : 'PASS';
  log(`OVERALL (SYNTHETIC): ${overall}${failed ? ` (${failed} failed checks)` : ''}${errors ? ` (${errors} worlds errored)` : ''} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (o.json) {
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify({ synthetic: true, note: 'SYNTHETIC self-test of the general-track tooling; not market evidence.', options: o, overall, aggregate: agg, worlds: results.map(({ dir, ...r }) => r) }, null, 2) + '\n');
    log(`summary written to ${path.resolve(o.json)}`);
  }
  return errors ? 2 : failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`${TAG} ERROR: ${e instanceof UsageError ? e.message : e.stack || e.message}`);
    process.exitCode = 2;
  });
}
