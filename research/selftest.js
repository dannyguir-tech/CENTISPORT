#!/usr/bin/env node
// SYNTHETIC self-test of the research tooling. It validates build-dataset.js + backtest.js on data
// with known ground truth (lib/synthetic.js) and says NOTHING about real Polymarket markets.
//
// For each seed it generates two paired worlds:
//   null    - prices are calibrated martingales; after costs no rule has positive expected ROI,
//             so every SURVIVES is a false discovery.
//   planted - known edges (see PLANTED_EDGES); those hypotheses must SURVIVE and their mirror
//             images must not.
// The builder and backtester run as child processes exactly as a user would run them. Every tested
// hypothesis is then re-traded in-process with the parameters the backtest chose per fold and priced
// with the generator's true probabilities, which tells a real discovery from a lucky one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLANTED_EDGES, PLANTED_MIRRORS, generateWorld } from './lib/synthetic.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, 'build-dataset.js');
const BACKTEST = path.join(HERE, 'backtest.js');
const HYPOTHESES = path.join(HERE, 'hypotheses.js');
const HOUR = 3600;
const TAG = '[SYNTHETIC]';
const REQUIRED_TYPES = ['moneyline', 'spread', 'total', 'prop', 'map'];
// Markets the builder must drop: their only start information is missing, a bare date, or after settlement.
const MUST_DROP = ['no_game_start', 'event_start_date_only', 'closed_before_start'];

const DEFAULTS = Object.freeze({ events: 2500, seeds: [1, 2, 3], jobs: 2, boot: 2000, fdr: 0.1, keep: false, workDir: null, json: null });

const log = (s = '') => { for (const line of String(s).split('\n')) console.log(`${TAG} ${line}`); };
const fin = Number.isFinite;
const pct = (x, d = 1) => (x == null || !fin(x) ? 'n/a' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const fmtP = (p) => (p == null || !fin(p) ? 'n/a' : p < 0.001 ? p.toExponential(1) : p.toFixed(3));
const tail = (s, n = 600) => String(s || '').trim().slice(-n).replace(/\s+/g, ' ');

// ---------- CLI ----------

const USAGE = `Usage: node research/selftest.js [options]
SYNTHETIC self-test: checks that the tooling finds planted edges and finds nothing in calibrated
data. Output is about the tooling only, never about real markets.
  --events 2500     events per world (planted-edge power needs ~2500; fewer may miss them)
  --seeds 1,2,3     one null + one planted world per seed
  --jobs 2          worlds processed concurrently
  --boot 2000       bootstrap replicates passed to backtest.js
  --fdr 0.10        BH false discovery rate passed to backtest.js (also sets the allowed null rate)
  --work-dir <dir>  where worlds are written (default: a new temp dir)
  --keep            keep generated data, datasets and reports
  --json <file>     also write a machine-readable summary
Exit code: 0 PASS, 1 FAIL, 2 tooling error (missing script, crash, unreadable report).`;

class UsageError extends Error {}

export function optsFromArgs(argv) {
  const o = { ...DEFAULTS };
  const num = (k, v, { int = false, min = 0, max = Infinity, exclusiveMin = false } = {}) => {
    const n = Number(v);
    if (!fin(n) || (exclusiveMin ? n <= min : n < min) || n > max || (int && !Number.isInteger(n))) throw new UsageError(`--${k} must be ${int ? 'an integer' : 'a number'} ${exclusiveMin ? '>' : '>='} ${min}${max < Infinity ? ` and <= ${max}` : ''}, got "${v}"`);
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
    } else if (key === 'jobs') o.jobs = num(key, val, { int: true, min: 1 });
    else if (key === 'boot') o.boot = num(key, val, { int: true, min: 1 });
    else if (key === 'fdr') o.fdr = num(key, val, { min: 0, max: 1, exclusiveMin: true });
    else if (key === 'work-dir') o.workDir = val;
    else if (key === 'json') o.json = val;
    else throw new UsageError(`unknown option --${key} (see --help)`);
  }
  return o;
}

// ---------- child processes ----------

function runNode(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script, ...args], { cwd: path.dirname(HERE), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, ms: Date.now() - t0 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? -1 : code, stdout, stderr: timedOut ? `${stderr}\ntimed out after ${timeoutMs / 1000}s` : stderr, ms: Date.now() - t0 }); });
  });
}

// ---------- ground truth ----------

async function loadTruth(file) {
  const truth = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const t = JSON.parse(line);
    truth.set(t.conditionId, t);
  }
  return truth;
}

// True win probability of a row's outcome at its decision time (k = whole hours before start,
// rounded toward the earlier grid point the information set is taken from).
function trueProb(truth, f) {
  const t = truth.get(f.conditionId);
  if (!t) return null;
  const k = Math.ceil((t.startTs - f.decisionTs) / HOUR - 1e-9);
  if (k < 0 || k >= t.q0.length) return null;
  return f.outcomeIndex === 0 ? t.q0[k] : 1 - t.q0[k];
}

// Streams dataset.jsonl to check game-start handling and market-type classification against the generator.
async function scanDataset(file, truth, gen) {
  const dropSet = new Map();
  for (const d of MUST_DROP) for (const cid of gen.dirty[d] || []) dropSet.set(cid, d);
  const fallback = new Set(gen.fallbackStart);
  const out = { rows: 0, types: {}, startMismatch: 0, leaked: {}, fallbackRows: 0, classMismatch: new Set(), unknownMarkets: 0 };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    out.rows++;
    out.types[r.marketType] = (out.types[r.marketType] || 0) + 1;
    const t = truth.get(r.conditionId);
    if (!t) { out.unknownMarkets++; continue; }
    if (r.startTs !== t.startTs) out.startMismatch++;
    if (dropSet.has(r.conditionId)) out.leaked[dropSet.get(r.conditionId)] = (out.leaked[dropSet.get(r.conditionId)] || 0) + 1;
    if (fallback.has(r.conditionId)) out.fallbackRows++;
    if (gen.classOf[r.conditionId] && gen.classOf[r.conditionId] !== r.marketType) out.classMismatch.add(r.conditionId);
  }
  return out;
}

async function loadAuditApi() {
  try {
    const bt = await import(pathToFileURL(BACKTEST).href);
    const hy = await import(pathToFileURL(HYPOTHESES).href);
    const api = { loadDataset: bt.loadDataset, assignFolds: bt.assignFolds, walkForward: bt.walkForward, entryCost: bt.entryCost, buildHypotheses: hy.buildHypotheses };
    const missing = Object.entries(api).filter(([, f]) => typeof f !== 'function').map(([k]) => k);
    return missing.length ? { unavailable: `backtest.js/hypotheses.js do not export ${missing.join(', ')}` } : api;
  } catch (e) {
    return { unavailable: `cannot import backtest.js/hypotheses.js: ${e.message}` };
  }
}

// Re-runs each tested hypothesis's walk-forward with the report's settings and prices its OOS bets
// at the true probability: trueRoi = mean(q / cost - 1). n must equal the report's OOS n.
async function auditWithTruth(api, report, datasetFile, truth) {
  const c = report.config;
  const { rows } = await api.loadDataset(datasetFile);
  const folds = api.assignFolds(rows, c.folds);
  const hyps = new Map(api.buildHypotheses({ sports: c.sportVariantsFor || [] }).map((h) => [h.id, h]));
  const o = { spread: c.spread, fee: c.fee, maxCost: c.maxCost, minN: c.minN, embargoH: c.embargoH };
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

// ---------- one world ----------

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
    gen = generateWorld({ world, seed, events: o.events, dataDir, truthFile });
  } catch (e) {
    return fail(`generator failed: ${e.message}`);
  }
  res.gen = { markets: gen.markets, priceFiles: gen.priceFiles, tradeFiles: gen.tradeFiles, informedMarkets: gen.informedMarkets, bySport: gen.bySport };

  const b = await runNode(BUILD, ['--data-dir', dataDir], 15 * 60e3);
  if (b.code !== 0) return fail(`build-dataset.js exited with code ${b.code}: ${tail(b.stderr || b.stdout)}`);
  const label = `SYNTHETIC selftest ${world} world, seed ${seed} (tooling validation only, not market data)`;
  const bt = await runNode(BACKTEST, ['--data', datasetFile, '--source-label', label, '--out', reportDir, '--name', 'backtest', '--seed', String(seed), '--boot', String(o.boot), '--fdr', String(o.fdr)], 30 * 60e3);
  if (bt.code !== 0) return fail(`backtest.js exited with code ${bt.code}: ${tail(bt.stderr || bt.stdout)}`);

  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(reportDir, 'backtest.json'), 'utf8'));
  } catch (e) {
    return fail(`cannot read backtest report: ${e.message}`);
  }
  if (!Array.isArray(report.hypotheses) || !report.config || !report.data) return fail('backtest report lacks hypotheses/config/data; the report format changed');

  const truth = await loadTruth(truthFile);
  const ds = await scanDataset(datasetFile, truth, gen);
  let audit;
  if (api.unavailable) audit = { unavailable: api.unavailable };
  else {
    try { audit = await auditWithTruth(api, report, datasetFile, truth); } catch (e) { audit = { unavailable: `audit failed: ${e.message}` }; }
  }
  evaluateWorld(res, report, ds, gen, audit, o);
  res.ms = Date.now() - t0;
  return res;
}

function evaluateWorld(res, report, ds, gen, audit, o) {
  const check = (name, status, detail) => res.checks.push({ name, status, detail });
  const hyps = new Map(report.hypotheses.map((h) => [h.id, h]));
  const tested = report.hypotheses.filter((h) => h.status === 'tested');
  const truthOf = (id) => (audit.byId && audit.byId[id] ? audit.byId[id] : null);
  const trueStr = (id) => { const a = truthOf(id); return a && a.trueRoi != null ? `true ${pct(a.trueRoi)}` : 'true n/a'; };
  const summary = (h) => {
    if (!h) return 'not in report';
    if (h.status !== 'tested') return `skipped: ${h.skipReason || h.verdict?.label || 'unknown'}`;
    const r = h.oos.roi;
    return `ROI ${pct(r.estimate)} (CI ${pct(r.lo)} to ${pct(r.hi)}), BH q ${fmtP(h.bh?.pAdj)}, @${h.stress?.spread} ${pct(h.stress?.roi)}, n ${h.oos.n}/${h.oos.nEvents} ev, ${trueStr(h.id)}`;
  };
  res.tested = tested.length;
  res.survivors = tested.filter((h) => h.verdict?.survives).map((h) => ({ id: h.id, trueRoi: truthOf(h.id)?.trueRoi ?? null }));
  res.auditAvailable = !audit.unavailable;

  // Dataset construction.
  const missingTypes = REQUIRED_TYPES.filter((t) => !ds.types[t]);
  const cov = report.data.tradeCoverage;
  const typeStr = Object.entries(ds.types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  check('dataset: market types + trade features', !ds.rows || missingTypes.length || !(cov > 0.5) ? 'FAIL' : 'PASS',
    `${ds.rows} rows (${typeStr}); trade features on ${pct(cov, 0).replace('+', '')} of rows${missingTypes.length ? `; MISSING ${missingTypes.join(', ')}` : ''}`);
  check('dataset: classifier matches generator', ds.classMismatch.size ? 'WARN' : 'PASS',
    ds.classMismatch.size ? `${ds.classMismatch.size} markets classified differently than generated (e.g. ${[...ds.classMismatch][0]})` : `all ${Object.keys(gen.classOf).length} market types as generated`);
  const leaked = Object.entries(ds.leaked);
  const dropped = MUST_DROP.reduce((s, d) => s + gen.dirty[d].length, 0);
  const startOk = !ds.startMismatch && !leaked.length && !ds.unknownMarkets && (gen.fallbackStart.length === 0 || ds.fallbackRows > 0);
  check('dataset: game start (no settlement fallback)', startOk ? 'PASS' : 'FAIL',
    startOk ? `startTs matches truth on every row; ${dropped} markets without a usable start dropped; eventStartDate fallback kept ${ds.fallbackRows} rows`
      : `start mismatches ${ds.startMismatch}, rows from markets that must be dropped ${leaked.map(([k, v]) => `${k}:${v}`).join(' ') || 0}, fallback rows ${ds.fallbackRows}, unknown markets ${ds.unknownMarkets}`);

  const base = hyps.get('baseline-all');
  const baseOk = base && base.status === 'tested' && !base.verdict?.survives && base.oos.roi.estimate < 0;
  check('baseline-all loses after costs (sanity)', baseOk ? 'PASS' : 'FAIL', base ? `${summary(base)}; hurdle ${pct(base.oos?.hurdleRoi)}` : 'baseline-all missing from report');

  // Ground-truth audit.
  if (audit.unavailable) {
    check('truth audit', 'WARN', `unavailable (${audit.unavailable}); survivor truth classification skipped`);
  } else {
    const mism = Object.entries(audit.byId).filter(([, a]) => !a.matches || a.error);
    check('truth audit reproduces backtest OOS bets', mism.length ? 'WARN' : 'PASS',
      mism.length ? `${mism.length} hypotheses differ (e.g. ${mism[0][0]}: audit n ${mism[0][1].n}, report n ${hyps.get(mism[0][0])?.oos?.n}); true ROI figures may be off` : `bet counts match for all ${tested.length} tested hypotheses`);
    if (res.world === 'null') {
      let worst = null;
      for (const [id, a] of Object.entries(audit.byId)) if (a.trueRoi != null && (!worst || a.trueRoi > worst.v)) worst = { id, v: a.trueRoi };
      check('truth: no tested rule has +EV (generator sanity)', worst && worst.v < 0 ? 'PASS' : 'FAIL', worst ? `highest true OOS ROI ${pct(worst.v)} (${worst.id})` : 'no priced bets');
    } else {
      const weak = Object.keys(PLANTED_EDGES).filter((id) => !(truthOf(id)?.trueRoi > 0));
      check('truth: planted rules have +EV (generator sanity)', weak.length ? 'FAIL' : 'PASS',
        Object.keys(PLANTED_EDGES).map((id) => `${id} ${pct(truthOf(id)?.trueRoi)}`).join(', '));
    }
  }

  if (res.world === 'null') {
    const s = res.survivors;
    check('no hypothesis SURVIVES', s.length ? 'COUNT' : 'PASS',
      s.length ? `${s.length} false survivor(s): ${s.map((x) => x.id).join(', ')} (counted toward the false-survival rate)` : `0 of ${tested.length} tested`);
    return;
  }
  for (const id of Object.keys(PLANTED_EDGES)) {
    const h = hyps.get(id);
    check(`planted ${id} SURVIVES`, h?.verdict?.survives ? 'PASS' : 'FAIL', summary(h));
  }
  for (const id of PLANTED_MIRRORS) {
    const h = hyps.get(id);
    check(`mirror ${id} does not survive`, h && !h.verdict?.survives ? 'PASS' : 'FAIL', h && h.status === 'tested' ? `ROI ${pct(h.oos.roi.estimate)}, ${trueStr(id)}` : summary(h));
  }
  const others = res.survivors.filter((s) => !(s.id in PLANTED_EDGES));
  check('other survivors (truth-audited)', 'INFO', others.length
    ? others.map((s) => `${s.id} ${s.trueRoi == null ? '(true n/a)' : s.trueRoi > 0 ? `(true ${pct(s.trueRoi)})` : `(FALSE: true ${pct(s.trueRoi)})`}`).join(', ')
    : 'none');
}

// ---------- aggregate & output ----------

function aggregate(results, o) {
  const agg = [];
  const nulls = results.filter((r) => r.world === 'null' && !r.error);
  const planted = results.filter((r) => r.world === 'planted' && !r.error);
  if (nulls.length) {
    const withSurv = nulls.filter((r) => r.survivors.length).length;
    const nFalse = nulls.reduce((s, r) => s + r.survivors.length, 0);
    const nTests = nulls.reduce((s, r) => s + r.tested, 0);
    const allowed = Math.floor(o.fdr * nulls.length);
    agg.push({ name: 'null worlds: false-survival rate', status: withSurv <= allowed ? 'PASS' : 'FAIL',
      detail: `${withSurv} of ${nulls.length} null worlds had a survivor (${nFalse} of ${nTests} hypothesis tests); allowed <= ${allowed} = floor(q ${o.fdr} x ${nulls.length} worlds)` });
  }
  if (planted.length) {
    const parts = Object.keys(PLANTED_EDGES).map((id) => {
      const k = planted.filter((r) => r.checks.some((c) => c.name === `planted ${id} SURVIVES` && c.status === 'PASS')).length;
      return { id, k };
    });
    agg.push({ name: 'planted worlds: detection rate', status: parts.every((p) => p.k === planted.length) ? 'PASS' : 'FAIL',
      detail: parts.map((p) => `${p.id} ${p.k}/${planted.length}`).join(', ') });
    const audited = planted.filter((r) => r.auditAvailable);
    if (audited.length) {
      const surv = audited.flatMap((r) => r.survivors);
      const known = surv.filter((s) => s.trueRoi != null);
      const falseOnes = known.filter((s) => s.trueRoi <= 0);
      const fdp = known.length ? falseOnes.length / known.length : 0;
      agg.push({ name: 'planted worlds: false-discovery proportion', status: fdp <= o.fdr ? 'PASS' : 'FAIL',
        detail: `${falseOnes.length} of ${known.length} survivors have true OOS ROI <= 0 (${pct(fdp).replace('+', '')}, limit q ${o.fdr})${falseOnes.length ? `: ${[...new Set(falseOnes.map((s) => s.id))].join(', ')}` : ''}` });
    } else {
      agg.push({ name: 'planted worlds: false-discovery proportion', status: 'WARN', detail: 'truth audit unavailable' });
    }
  }
  return agg;
}

const EXPLAIN = [
  'How to read this (SYNTHETIC):',
  '- Results: PASS/FAIL are hard checks; WARN does not fail the run; INFO is context; COUNT marks null-world survivors,',
  '  which are judged by the aggregate false-survival rule below.',
  '- Null worlds have calibrated prices, so every hypothesis has negative true ROI after costs and every SURVIVES is a',
  '  false discovery. When all hypotheses are null, Benjamini-Hochberg FDR control means P(any BH rejection) <= q per',
  '  world. The survival rule adds a bootstrap CI above 0 and profit at the stress spread, and true ROI is below 0',
  '  (the cost drag), not at 0, so the realistic rate is far below q. At most floor(q x worlds) null worlds may have a',
  '  survivor: 0 for fewer than 10 seeds. Any null survivor with few seeds points to leakage or a miscalibrated test.',
  '- Planted worlds hide edges of known size. Their hypotheses must survive every seed, and their mirror images must not.',
  '  The generator\'s true probabilities price every OOS bet: a survivor whose true ROI is <= 0 is a false discovery,',
  '  and the share of those must stay within q. Missing planted edges at small --events usually means too few bets.',
];

function printTable(results, agg, o) {
  const W = { seed: 4, world: 7, name: 44, status: 6 };
  const row = (seed, world, name, status, detail) =>
    log(`${String(seed).padStart(W.seed)}  ${String(world).padEnd(W.world)}  ${String(name).padEnd(W.name)}  ${String(status).padEnd(W.status)}  ${detail}`);
  log('');
  log('RESULTS (SYNTHETIC data; tooling validation only)');
  row('seed', 'world', 'check', 'result', 'detail');
  row('----', '-------', '-'.repeat(W.name), '------', '------');
  for (const r of results) {
    if (r.error) { row(r.seed, r.world, 'run', 'ERROR', r.error); continue; }
    for (const c of r.checks) row(r.seed, r.world, c.name, c.status, c.detail);
  }
  log('');
  log('AGGREGATE (SYNTHETIC)');
  for (const a of agg) row('all', '', a.name, a.status, a.detail);
  log('');
  log(EXPLAIN.join('\n'));
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
  log('================================================================================');
  log('SYNTHETIC SELF-TEST of research/build-dataset.js + research/backtest.js');
  log('Generated data with known ground truth. This validates the TOOLING ONLY and is not');
  log('evidence of any edge (or lack of one) in real Polymarket markets.');
  log('================================================================================');
  const missing = [BUILD, BACKTEST].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    log(`ERROR: ${missing.map((f) => path.relative(path.dirname(HERE), f)).join(', ')} not found; the self-test runs them as child processes.`);
    return 2;
  }
  const root = o.workDir ? path.resolve(o.workDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'centisport-selftest-'));
  fs.mkdirSync(root, { recursive: true });
  log(`events/world ${o.events}, seeds ${o.seeds.join(',')}, bootstrap B ${o.boot}, FDR q ${o.fdr}, jobs ${o.jobs}`);
  log(`work dir ${root}${o.keep ? ' (kept)' : ' (deleted at the end; pass --keep to inspect)'}`);
  if (o.events < 2000) log(`note: ${o.events} events per world is below the ~2500 the planted-edge checks are sized for; missed planted edges may be low power.`);

  const api = await loadAuditApi();
  if (api.unavailable) log(`warning: truth audit disabled: ${api.unavailable}`);
  const tasks = o.seeds.flatMap((seed) => ['null', 'planted'].map((world) => ({ seed, world })));
  const t0 = Date.now();
  const results = await pool(tasks, o.jobs, async ({ seed, world }) => {
    const r = await runWorld(seed, world, o, root, api);
    const surv = r.survivors.map((s) => s.id).join(', ') || 'none';
    log(r.error ? `seed ${seed} ${world}: ERROR ${r.error}` : `seed ${seed} ${world}: ${r.gen.markets} markets, ${r.tested} hypotheses tested, survivors: ${surv} (${(r.ms / 1000).toFixed(0)}s)`);
    if (!o.keep) fs.rmSync(r.dir, { recursive: true, force: true });
    return r;
  });
  if (!o.keep && !o.workDir) fs.rmSync(root, { recursive: true, force: true });

  const agg = aggregate(results, o);
  printTable(results, agg, o);
  const errors = results.filter((r) => r.error).length;
  const failed = [...results.flatMap((r) => r.checks), ...agg].filter((c) => c.status === 'FAIL').length;
  const overall = errors ? 'ERROR' : failed ? 'FAIL' : 'PASS';
  log('');
  log(`OVERALL (SYNTHETIC): ${overall}${failed ? ` (${failed} failed checks)` : ''}${errors ? ` (${errors} worlds errored)` : ''} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (o.json) {
    const out = { synthetic: true, note: 'SYNTHETIC self-test of the research tooling; not market evidence.', options: o, overall, aggregate: agg,
      worlds: results.map(({ dir, ...r }) => r) };
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify(out, null, 2) + '\n');
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
