// Momentum / reversal study on Polymarket BTC Up/Down markets.
//   NODE_OPTIONS=--max-old-space-size=6144 node /home/user/CENTISPORT/research/btc/analysis/momentum/run.mjs
// Writes /home/user/CENTISPORT/research/btc/reports/momentum/{results.json,results.csv,diagnostics.json,
//   calibration_within_window.csv, calibration_across_window.csv, calibration_cross_tf.csv, base_rates.json}
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown, loadTrades, loadLive, WINDOW_SEC } from '../../../lib/load.mjs';
import {
  mkTrade, summarize, walkForward, bootstrap, benjaminiHochberg, logisticBoot, logit, fmt, median, mean,
  HEADLINE, HAIRCUT, FEE_MODELS, LAG, LATENCY, BAND, pnlOf, makerTrade, MAKER_OFFSET, MAKER_THROUGH,
} from './lib.mjs';
import { buildCL, featW, featA, featX, featTape, featTapeOpen, MAX_WAIT, VEL_LOOK } from './features.mjs';

const OUT = '/home/user/CENTISPORT/research/btc/verify/momentum/out/build_tmp';
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const SCRIPT = '/home/user/CENTISPORT/research/btc/analysis/momentum/run.mjs';

// ---------------------------------------------------------------------------------------------
// Capacity inputs: live ask depth (USDC) within 2c of the best ask on in-play Up/Down tokens,
// pooled over the saved live snapshots; and tape-based taker flow for 5m/15m.
// ---------------------------------------------------------------------------------------------
function liveDepth() {
  const dir = '/home/user/CENTISPORT/research/btc/data/live';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  const seen = new Set(); const by = {};
  for (const f of files) {
    let L; try { L = loadLive(f); } catch { continue; }
    const FT = L.booksFetchedTs ? (L.booksFetchedTs > 1e11 ? L.booksFetchedTs / 1000 : L.booksFetchedTs) : L.fetchedTs;
    for (const ev of L.events || []) {
      if (!String(ev.kind).startsWith('updown_')) continue;
      const tf = ev.kind.slice(7); const ws = ev.windowStart ?? ev.startTs;
      if (!(ws <= FT && ev.endTs > FT)) continue;
      for (const m of ev.markets || []) for (const tk of m.tokens || []) {
        const b = tk.book; if (!b || !b.asks || !b.asks.length) continue;
        const key = tk.tokenId + ':' + (b.bookTs || FT); if (seen.has(key)) continue; seen.add(key);
        const ba = b.asks[0][0];
        const d2 = b.asks.filter(([p]) => p <= ba + 0.02 + 1e-9).reduce((s, [p, sz]) => s + p * sz, 0);
        (by[tf] ||= []).push({ ba, d2 });
      }
    }
  }
  const out = {};
  for (const [tf, a] of Object.entries(by)) {
    const mid = a.filter((x) => x.ba > 0.1 && x.ba < 0.9);
    const use = mid.length ? mid : a;
    out[tf] = { nTokens: a.length, medDepth2c: fmt(median(use.map((x) => x.d2)), 0) };
  }
  return out;
}
function tapeFlow(tf) {
  // median taker notional per side per minute inside the window (USDC), from the subsample tapes
  const tapes = loadTrades(tf); const L = WINDOW_SEC[tf];
  const per = tapes.map((tp) => { let usd = 0; for (const x of tp.trades) if (x.t >= tp.windowStart && x.t <= tp.windowEnd) usd += x.p * x.s; return usd / (L / 60) / 2; });
  return fmt(median(per), 0);
}

// ---------------------------------------------------------------------------------------------
const CL = buildCL();
log('Chainlink reference points', CL.n, new Date(CL.first * 1000).toISOString(), '->', new Date(CL.last * 1000).toISOString());
const depth = liveDepth();
const flow = { '5m': tapeFlow('5m'), '15m': tapeFlow('15m') };
log('live depth', JSON.stringify(depth), 'tape flow $/min/side', JSON.stringify(flow));
// capacity per trade (USDC notional you could take within ~2c of the touch): live depth, 1d falls back to 1h
const CAP = {};
for (const tf of ['5m', '15m', '1h', '4h', '1d']) CAP[tf] = depth[tf]?.medDepth2c || depth['1h']?.medDepth2c || 100;
if (depth['1d'] && (depth['1d'].nTokens || 0) < 2) CAP['1d'] = depth['1h']?.medDepth2c || 100;

const TFS = ['5m', '15m', '1h', '4h', '1d'];
const variants = [];
const diagnostics = { within: [], across: [], cross: [], tape: [] };
const calibW = [], calibA = [], calibX = [];
const baseRates = [];

const daysOf = (rows) => [...new Set(rows.map((r) => r.day))].sort();
const countByDay = (rows) => { const m = new Map(); for (const r of rows) m.set(r.day, (m.get(r.day) || 0) + 1); return m; };
const MAKER_TXT = `MAKER: instead of taking, post a resting bid for that side at mid-${MAKER_OFFSET} at the decision time; counted as filled only if a later snapshot (before end-10s) shows that side's mid <= limit-${MAKER_THROUGH}; fill at the limit, no fee, maker rebate ignored. Fill model is approximate (1/min snapshots, queue position unknown).`;
const binOf = (p) => Math.min(9, Math.max(0, Math.floor(p * 10)));

function addVariant(v) { variants.push(v); }

// =============================================================================================
// FAMILY W: within-window momentum / reversal
// =============================================================================================
const W_F = [0.2, 0.4, 0.6, 0.8];
const TH_LVL = [0.03, 0.06, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
const TH_VEL = [0.01, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16, 0.20];
for (const tf of TFS) {
  for (const f of W_F) {
    const rows = featW(tf, f);
    log(`W ${tf} f=${f}: ${rows.length} windows`);
    if (rows.length < 100) continue;
    // diagnostic: calibration slope and recent-velocity coefficient beyond the current price
    const dr = rows.map((r) => ({ day: r.day, y: r.win ? 1 : 0, lp: logit(r.p), dlp: logit(r.p) - logit(r.pPrev), dOpen: logit(r.p) - logit(r.pOpen) }));
    const d1 = logisticBoot(dr, (r) => [1, r.lp, r.dlp], ['const', 'logit_p', 'dlogit_recent'], { B: 200 });
    diagnostics.within.push({ tf, f, decision: `last path point with real time <= start+${f * WINDOW_SEC[tf]}s`, velLookbackSec: VEL_LOOK[tf], ...d1, note: 'logit_p coef > 1 => market under-reacts to its own move since the open (momentum); < 1 => over-reacts (reversal). dlogit_recent > 0 => recent move continues beyond the current price.' });
    // calibration table: p bins x recent-velocity sign
    const cells = new Map();
    for (const r of rows) {
      const v = r.p - r.pPrev; const vs = v > 0.02 ? 'up' : v < -0.02 ? 'down' : 'flat';
      const k = `${binOf(r.p)}|${vs}`; const c = cells.get(k) || { n: 0, sp: 0, sw: 0 }; c.n++; c.sp += r.p; c.sw += r.win ? 1 : 0; cells.set(k, c);
    }
    for (const [k, c] of [...cells.entries()].sort()) { const [b, vs] = k.split('|'); calibW.push([tf, f, `${(b / 10).toFixed(1)}-${((+b + 1) / 10).toFixed(1)}`, vs, c.n, (c.sp / c.n).toFixed(4), (c.sw / c.n).toFixed(4), (c.sw / c.n - c.sp / c.n).toFixed(4)]); }

    const days = daysOf(rows), nWin = countByDay(rows);
    for (const maker of [false, true]) for (const kind of ['lvl', 'vel']) for (const dir of ['mom', 'rev']) {
      if (maker && dir === 'rev') continue;
      const thetas = kind === 'lvl' ? TH_LVL : TH_VEL;
      const tradesFor = (th) => {
        const out = [];
        for (const r of rows) {
          const s = kind === 'lvl' ? r.p - r.pOpen : r.p - r.pPrev;
          let up; if (s > th) up = dir === 'mom'; else if (s < -th) up = dir !== 'mom'; else continue;
          const side = up ? 'U' : 'D';
          const base = mkTrade({ day: r.day, t: r.t, side, pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id, extra: { pRefNext: r.pNext == null ? null : (up ? r.pNext : 1 - r.pNext), feeType: r.feeType } });
          const t = maker ? makerTrade(base, r.ep, r.t, r.end) : base;
          if (t) out.push(t);
        }
        return out;
      };
      const sig = kind === 'lvl' ? `Up mid moved > theta from the pre-window quote (p - pOpen)` : `Up mid moved > theta over the last ${VEL_LOOK[tf]}s (p - p[t-${VEL_LOOK[tf]}s])`;
      addVariant({
        id: `${maker ? 'M' : ''}W-${kind}-${dir}-${tf}-f${f}`, family: maker ? 'MW' : 'W', tf, thetas, tradesFor, days, nWin, maker,
        hypothesis: `${maker ? '[maker] ' : ''}Within-window ${dir === 'mom' ? 'momentum' : 'reversal'}: ${kind === 'lvl' ? 'the Up move since the open' : 'the recent Up-price move'} ${dir === 'mom' ? 'continues' : 'reverts'} beyond the current price (${tf}, decision at ${Math.round(f * 100)}% of window).`,
        rule: `At the last price snapshot with real time <= windowStart+${f * WINDOW_SEC[tf]}s (staleness <= ${Math.max(90, 0.05 * WINDOW_SEC[tf])}s): if ${sig} > +theta buy ${dir === 'mom' ? 'UP' : 'DOWN'}; if < -theta buy ${dir === 'mom' ? 'DOWN' : 'UP'}; ${maker ? MAKER_TXT : `taker at mid+${HAIRCUT}`}, token mid in [${BAND}]; hold to resolution. theta from {${thetas.join(',')}} chosen walk-forward.`,
      });
    }
  }
}

// =============================================================================================
// FAMILY A: across consecutive windows
// =============================================================================================
const TH_STREAK = [2, 3, 4, 5, 6];
const TH_Z = [0, 0.5, 1.0, 1.5, 2.0, 2.5];
const TH_LM = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0];
for (const tf of TFS) {
  const rows = featA(tf, CL);
  log(`A ${tf}: ${rows.length} window pairs, zMag on ${rows.filter((r) => r.zMag != null).length}, z5 on ${rows.filter((r) => r.z5 != null).length}, median exec wait ${median(rows.map((r) => r.wait))}s`);
  // base rates
  const same = rows.filter((r) => (r.prev > 0) === r.win).length;
  baseRates.push({ tf, pairs: rows.length, pSameAsPrev: fmt(same / rows.length), se: fmt(Math.sqrt(0.25 / rows.length)), upRate: fmt(rows.filter((r) => r.win).length / rows.length), meanOpenPUpAfterUp: fmt(mean(rows.filter((r) => r.prev > 0).map((r) => r.p))), meanOpenPUpAfterDown: fmt(mean(rows.filter((r) => r.prev < 0).map((r) => r.p))), medianExecWaitSec: median(rows.map((r) => r.wait)) });
  // diagnostics
  const dr = rows.map((r) => ({ day: r.day, y: r.win ? 1 : 0, lp: logit(r.p), prev: r.prev, z: r.zMag, z5: r.z5 }));
  diagnostics.across.push({ tf, model: 'win_b ~ logit(p_open_b) + prevResult_a(+-1)', ...logisticBoot(dr, (r) => [1, r.lp, r.prev], ['const', 'logit_p_open', 'prev'], { B: 200 }) });
  const drz = dr.filter((r) => r.z != null);
  if (drz.length > 150) diagnostics.across.push({ tf, model: 'win_b ~ logit(p_open_b) + zMag_a', ...logisticBoot(drz, (r) => [1, r.lp, r.z], ['const', 'logit_p_open', 'zMag_prev'], { B: 200 }) });
  const drl = rows.filter((r) => r.lastMin != null).map((r) => ({ day: r.day, y: r.win ? 1 : 0, lp: logit(r.p), lm: r.lastMin }));
  if (drl.length > 150 && (tf === '5m' || tf === '15m')) diagnostics.across.push({ tf, model: 'win_b ~ logit(p_open_b) + lastMinute dlogit of window a', ...logisticBoot(drl, (r) => [1, r.lp, r.lm], ['const', 'logit_p_open', 'lastMin_prev'], { B: 200 }) });
  const dr5 = dr.filter((r) => r.z5 != null);
  if (dr5.length > 150 && tf !== '5m') diagnostics.across.push({ tf, model: 'win_b ~ logit(p_open_b) + z5 (Chainlink 5-min return into b start)', ...logisticBoot(dr5, (r) => [1, r.lp, r.z5], ['const', 'logit_p_open', 'z5'], { B: 200 }) });
  for (const pv of [1, -1]) for (let b = 0; b < 10; b++) {
    const c = rows.filter((r) => r.prev === pv && binOf(r.p) === b); if (!c.length) continue;
    const mp = mean(c.map((r) => r.p)), wr = c.filter((r) => r.win).length / c.length;
    calibA.push([tf, pv > 0 ? 'prevUp' : 'prevDown', `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`, c.length, mp.toFixed(4), wr.toFixed(4), (wr - mp).toFixed(4)]);
  }

  const mk = (rowsK, sigFn, thetas, kindName, dir, hyp, ruleTxt) => {
    const days = daysOf(rowsK), nWin = countByDay(rowsK);
    for (const maker of [false, true]) {
      const tradesFor = (th) => {
        const out = [];
        for (const r of rowsK) {
          const s = sigFn(r); if (s == null) continue;
          let up; if (s >= th && s > 0) up = dir === 'mom'; else if (s <= -th && s < 0) up = dir !== 'mom'; else continue;
          const base = mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id, extra: { feeType: r.feeType } });
          const t = maker ? makerTrade(base, r.ep, r.t, r.end) : base;
          if (t) out.push(t);
        }
        return out;
      };
      addVariant({ id: `${maker ? 'M' : ''}A-${kindName}-${dir}-${tf}`, family: maker ? 'MA' : 'A', tf, thetas, tradesFor, days, nWin, maker,
        hypothesis: (maker ? '[maker] ' : '') + hyp, rule: maker ? ruleTxt.replace(`taker at mid+${HAIRCUT}`, MAKER_TXT) : ruleTxt });
    }
  };
  const execTxt = `at the first price snapshot of the new window with real time >= windowStart+${LATENCY}s (<= +${MAX_WAIT[tf]}s), taker at mid+${HAIRCUT}, token mid in [${BAND}], hold to resolution`;
  for (const dir of ['mom', 'rev']) {
    const word = dir === 'mom' ? 'same' : 'opposite';
    mk(rows, (r) => r.prev, [1], 'prev', dir, `Previous ${tf} window's result predicts the next window's result beyond its opening price (${dir === 'mom' ? 'continuation' : 'reversal'}).`, `Buy the ${word} side as the previous ${tf} window's result, ${execTxt}. No parameters.`);
    mk(rows, (r) => r.streak, TH_STREAK, 'streak', dir, `After a run of identical ${tf} results, the next window ${dir === 'mom' ? 'continues' : 'reverses'} beyond its opening price.`, `If the last n >= theta ${tf} results were identical, buy the ${word} side, ${execTxt}. theta from {${TH_STREAK}} walk-forward.`);
    const rz = rows.filter((r) => r.zMag != null);
    if (rz.length > 150) mk(rz, (r) => r.zMag, TH_Z, 'mag', dir, `A large previous-window BTC move (resolution-source return / sigma) predicts ${dir === 'mom' ? 'continuation' : 'reversal'} in the next ${tf} window beyond its opening price.`, `z = ln(finalPrice/priceToBeat of previous ${tf} window) / (trailing 3-day realized sigma * sqrt(${WINDOW_SEC[tf]}s)); if |z| >= theta buy the ${word} side to sign(z), ${execTxt}. theta from {${TH_Z}} walk-forward.`);
    const rl = rows.filter((r) => r.lastMin != null);
    if ((tf === '5m' || tf === '15m') && rl.length > 150) mk(rl, (r) => r.lastMin, TH_LM, 'lastmin', dir, `The previous ${tf} window's last-minute Up-price move (proxy for late BTC drift into the new strike) predicts ${dir === 'mom' ? 'continuation' : 'reversal'} beyond the opening price.`, `d = logit(pUp_prev at its last snapshot <= end) - logit(pUp_prev 60s earlier); if |d| >= theta buy the ${word} side to sign(d), ${execTxt}. theta from {${TH_LM}} walk-forward.`);
    const r5 = rows.filter((r) => r.z5 != null);
    if (tf !== '5m' && r5.length > 150) mk(r5, (r) => r.z5, TH_Z, 'last5', dir, `The last 5 minutes of Chainlink BTC move before a ${tf} window opens predicts ${dir === 'mom' ? 'continuation' : 'reversal'} beyond the opening price.`, `z5 = ln(CL(start)/CL(start-300s)) / (sigma*sqrt(300)); if |z5| >= theta buy the ${word} side to sign(z5), ${execTxt}. theta from {${TH_Z}} walk-forward.`);
  }
}

// =============================================================================================
// FAMILY X: cross-timeframe (sub-window results inside a longer window)
// =============================================================================================
const PAIRS = [['15m', '5m'], ['1h', '5m'], ['1h', '15m'], ['4h', '1h'], ['1d', '4h']];
const TH_GAP = [0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20];
const TH_ZL = [0.5, 1.0, 1.5, 2.0, 2.5];
for (const [lt, st] of PAIRS) {
  const rows = featX(lt, st, CL);
  const m = Math.round(WINDOW_SEC[lt] / WINDOW_SEC[st]);
  log(`X ${lt}<-${st}: ${rows.length} long windows, ${rows.reduce((s, r) => s + r.dec.length, 0)} decision points, gap-model points ${rows.reduce((s, r) => s + r.dec.filter((d) => d.P != null).length, 0)}`);
  if (rows.length < 100) continue;
  // diagnostics pooled over decision points
  const pts = []; for (const r of rows) for (const d of r.dec) pts.push({ day: r.day, y: r.win ? 1 : 0, lp: logit(d.p), c: d.c, zc: d.zc, zl: d.zLast, j: d.j });
  diagnostics.cross.push({ pair: `${lt}<-${st}`, model: 'win ~ logit(p_long) + count(sub Up - sub Down)', ...logisticBoot(pts, (r) => [1, r.lp, r.c], ['const', 'logit_p_long', 'subCount'], { B: 200 }) });
  const pz = pts.filter((r) => r.zc != null);
  if (pz.length > 150) diagnostics.cross.push({ pair: `${lt}<-${st}`, model: 'win ~ logit(p_long) + zc (Chainlink move since start / sigma*sqrt(remaining))', ...logisticBoot(pz, (r) => [1, r.lp, r.zc], ['const', 'logit_p_long', 'zc'], { B: 200 }) });
  const pl = pts.filter((r) => r.zl != null && r.zc != null);
  if (pl.length > 150) diagnostics.cross.push({ pair: `${lt}<-${st}`, model: 'win ~ logit(p_long) + zc + zLast5m', ...logisticBoot(pl, (r) => [1, r.lp, r.zc, r.zl], ['const', 'logit_p_long', 'zc', 'zLast5m'], { B: 200 }) });
  for (const cs of ['neg', 'zero', 'pos']) for (let b = 0; b < 10; b++) {
    const c = pts.filter((r) => (r.c < 0 ? 'neg' : r.c > 0 ? 'pos' : 'zero') === cs && binOf(Math.exp(r.lp) / (1 + Math.exp(r.lp))) === b); if (!c.length) continue;
    const mp = mean(c.map((r) => 1 / (1 + Math.exp(-r.lp)))), wr = mean(c.map((r) => r.y));
    calibX.push([`${lt}<-${st}`, `subCount_${cs}`, `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`, c.length, mp.toFixed(4), wr.toFixed(4), (wr - mp).toFixed(4)]);
  }

  const execTxt = `at the first ${lt} price snapshot with real time >= boundary+${LATENCY}s (<= +${MAX_WAIT[lt]}s), taker at mid+${HAIRCUT}, token mid in [${BAND}], at most one entry per ${lt} window (first trigger), hold to resolution`;
  const mkX = (rowsK, pick, thetas, kindName, hyp, ruleTxt, makerToo = false) => {
    const days = daysOf(rowsK), nWin = countByDay(rowsK);
    for (const maker of makerToo ? [false, true] : [false]) {
      const tradesFor = (th) => {
        const out = [];
        for (const r of rowsK) {
          for (const d of r.dec) {
            const up = pick(d, th); if (up == null) continue;
            const base = mkTrade({ day: r.day, t: d.t, side: up ? 'U' : 'D', pUp: d.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id, extra: { feeType: r.feeType, j: d.j } });
            if (!base) continue;
            // maker: one resting order per long window, placed at the first trigger
            const t = maker ? makerTrade(base, r.ep, d.t, r.end) : base;
            if (t) out.push(t);
            break;
          }
        }
        return out;
      };
      addVariant({ id: `${maker ? 'M' : ''}X-${kindName}-${lt}-from-${st}`, family: maker ? 'MX' : 'X', tf: lt, thetas, tradesFor, days, nWin, maker,
        hypothesis: (maker ? '[maker] ' : '') + hyp, rule: maker ? ruleTxt.replace(`taker at mid+${HAIRCUT}`, MAKER_TXT) : ruleTxt });
    }
  };
  const thC = [1, 2, 3, 4, 6, 8].filter((x) => x <= m - 1);
  mkX(rows, (d, th) => (d.c >= th ? true : d.c <= -th ? false : null), thC, 'cnt-mom', `Finished ${st} results inside a ${lt} window predict the ${lt} outcome beyond its current price (follow the sub-windows).`, `At each ${st} boundary inside the ${lt} window, c = #Up - #Down of finished ${st} windows; if c >= theta buy UP, if c <= -theta buy DOWN, ${execTxt}. theta from {${thC}} walk-forward.`, true);
  mkX(rows, (d, th) => (d.c >= th ? false : d.c <= -th ? true : null), thC, 'cnt-rev', `Finished ${st} results inside a ${lt} window are over-priced in the ${lt} market (fade the sub-windows).`, `At each ${st} boundary, if c >= theta buy DOWN, if c <= -theta buy UP, ${execTxt}. theta from {${thC}} walk-forward.`, true);
  const rg = rows.map((r) => ({ ...r, dec: r.dec.filter((d) => d.P != null) })).filter((r) => r.dec.length);
  if (rg.length > 100) mkX(rg, (d, th) => (d.P - d.p > th ? true : d.p - d.P > th ? false : null), TH_GAP, 'gap', `The ${lt} market lags the Chainlink BTC move measured at ${st} boundaries (driftless random-walk fair value vs market).`, `At each ${st} boundary Tj: P = Phi(ln(CL(Tj)/CL(start)) / (sigma3d*sqrt(end - t_exec - 20s))); if P - p_mid > theta buy UP, if p_mid - P > theta buy DOWN, ${execTxt}. theta from {${TH_GAP}} walk-forward.`);
  if (st === '5m') {
    const rl = rows.map((r) => ({ ...r, dec: r.dec.filter((d) => d.zLast != null) })).filter((r) => r.dec.length);
    for (const dir of ['mom', 'rev']) mkX(rl, (d, th) => (d.zLast >= th ? dir === 'mom' : d.zLast <= -th ? dir !== 'mom' : null), TH_ZL, `btc5-${dir}`, `The last 5-minute Chainlink BTC move inside a ${lt} window ${dir === 'mom' ? 'continues' : 'reverts'} beyond the ${lt} market price.`, `At each 5m boundary inside the ${lt} window, zLast = ln(CL(Tj)/CL(Tj-300)) / (sigma*sqrt(300)); if zLast >= theta buy ${dir === 'mom' ? 'UP' : 'DOWN'}, if <= -theta buy ${dir === 'mom' ? 'DOWN' : 'UP'}, ${execTxt}. theta from {${TH_ZL}} walk-forward.`);
  }
}

// =============================================================================================
// FAMILY T: order-flow momentum on the tape subsample (exploratory, small n)
// =============================================================================================
const TH_OFI = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5];
for (const tf of ['5m', '15m']) {
  const rows = featTape(tf, 0.5);
  log(`T ${tf}: ${rows.length} tape windows`);
  const dr = rows.map((r) => ({ day: r.day, y: r.win ? 1 : 0, lp: logit(r.p), ofi: r.ofi }));
  diagnostics.tape.push({ tf, model: 'win ~ logit(p_exec) + OFI(start..mid-window)', ...logisticBoot(dr, (r) => [1, r.lp, r.ofi], ['const', 'logit_p', 'ofi'], { B: 200 }) });
  const days = daysOf(rows), nWin = countByDay(rows);
  for (const dir of ['mom', 'rev']) {
    const tradesFor = (th) => rows.map((r) => {
      let up; if (r.ofi > th) up = dir === 'mom'; else if (r.ofi < -th) up = dir !== 'mom'; else return null;
      return mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id, extra: { feeType: r.feeType } });
    }).filter(Boolean);
    addVariant({ id: `T-ofi-${dir}-${tf}`, family: 'T', tf, thetas: TH_OFI, tradesFor, days, nWin, minAbs: 8,
      hypothesis: `Taker order-flow imbalance in the first half of a ${tf} window ${dir === 'mom' ? 'continues' : 'reverts'} beyond the price (tape subsample only).`,
      rule: `OFI = (Up-equivalent taker buy notional - sell notional)/total over [start, start+${WINDOW_SEC[tf] / 2}s]; if OFI > theta buy ${dir === 'mom' ? 'UP' : 'DOWN'}, if < -theta buy ${dir === 'mom' ? 'DOWN' : 'UP'}, at first price snapshot with real time >= mid-window+${LATENCY}s; taker at mid+${HAIRCUT}. theta from {${TH_OFI}} walk-forward.` });
  }
}

// FAMILY TA: across-window rules executed at the very open on real tape fills (subsample)
for (const tf of ['5m', '15m']) {
  const rows = featTapeOpen(tf, CL);
  log(`TA ${tf}: ${rows.length} tape windows, with an early Up fill ${rows.filter((r) => r.fU).length}, Down fill ${rows.filter((r) => r.fD).length}`);
  const days = daysOf(rows), nWin = countByDay(rows);
  for (const kind of ['prev', 'mag']) for (const dir of ['mom', 'rev']) {
    const thetas = kind === 'prev' ? [1] : TH_Z;
    const tradesFor = (th) => {
      const out = [];
      for (const r of rows) {
        const s = kind === 'prev' ? r.prev : r.zMag; if (s == null) continue;
        let up; if (s >= th && s > 0) up = dir === 'mom'; else if (s <= -th && s < 0) up = dir !== 'mom'; else continue;
        const f = up ? r.fU : r.fD; if (!f) continue;
        if (!(f.p >= BAND[0] && f.p <= BAND[1])) continue;
        out.push({ day: r.day, t: f.t, side: up ? 'U' : 'D', pRef: f.p, ex: f.p, win: (up ? r.win : !r.win) ? 1 : 0, fee: r.fee, id: r.id, feeType: r.feeType });
      }
      return out;
    };
    addVariant({ id: `TA-${kind}-${dir}-${tf}`, family: 'TA', tf, thetas, tradesFor, days, nWin, minAbs: 8,
      hypothesis: `Previous ${tf} window ${kind === 'prev' ? 'result' : 'move size'} predicts ${dir === 'mom' ? 'continuation' : 'reversal'} when entering in the first seconds of the next window (tape subsample).`,
      rule: `${kind === 'prev' ? 'Side = previous result' : 'If |zMag of previous window| >= theta, side = sign(zMag)'}${dir === 'rev' ? ' reversed' : ''}; entry = the first real taker BUY fill of that side with on-chain time in [start+3s, start+20s] (+0.2c slippage + taker fee); hold to resolution.${kind === 'mag' ? ` theta from {${TH_Z}} walk-forward.` : ''}` });
  }
}

// FAMILY TM: maker fills checked against the real taker tape (subsample), across-window prev rule.
// Post a bid for the side at (first in-window snapshot mid - 0.5c) at that snapshot's real time; filled if a
// later taker fill would have crossed it: a taker SELL of that side at <= limit, or a taker BUY of the
// other side at >= 1 - limit ('at' = reaches our level, optimistic about queue; 'thru' = 1c through, pessimistic).
{
  const aRows = { '5m': featA('5m', CL), '15m': featA('15m', CL) };
  for (const tf of ['5m', '15m']) {
    const tapes = new Map(loadTrades(tf).map((tp) => [tp.slug, tp]));
    const rows = aRows[tf].filter((r) => tapes.has(r.id));
    log(`TM ${tf}: ${rows.length} windows with tape`);
    const days = daysOf(rows), nWin = countByDay(rows);
    for (const fillMode of ['at', 'thru']) for (const dir of ['mom', 'rev']) {
      const tradesFor = () => {
        const out = [];
        for (const r of rows) {
          const up = (r.prev > 0) === (dir === 'mom');
          const base = mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id, extra: { feeType: r.feeType } });
          if (!base) continue;
          const L = Math.round((base.pRef - MAKER_OFFSET) * 1000) / 1000;
          const tol = fillMode === 'at' ? 1e-9 : -0.01 + 1e-9;
          const S = base.side;
          let filled = null;
          for (const x of tapes.get(r.id).trades) {
            if (x.t < r.t + 2) continue; if (x.t > r.end - 10) break;
            const hit = (x.o === S && x.side === 'S' && x.p <= L + tol) || (x.o !== S && x.side === 'B' && 1 - x.p <= L + tol);
            if (hit) { filled = x; break; }
          }
          if (filled) out.push({ ...base, pRef: L, mk: true, fillDelay: filled.t - r.t });
        }
        return out;
      };
      addVariant({ id: `TM-prev-${dir}-${tf}-${fillMode}`, family: 'TM', tf, thetas: [1], tradesFor, days, nWin, maker: true, minAbs: 8,
        hypothesis: `[maker, tape-checked fills] Previous ${tf} result predicts ${dir === 'mom' ? 'continuation' : 'reversal'}; capture it with a resting bid instead of crossing the spread.`,
        rule: `At the first snapshot of the new ${tf} window with real time >= start+${LATENCY}s, post a bid for the ${dir === 'mom' ? 'same' : 'opposite'} side as the previous result at mid-${MAKER_OFFSET}; filled if a later real taker fill (before end-10s) ${fillMode === 'at' ? 'reaches' : 'trades 1c through'} that price (taker SELL of the side, or taker BUY of the complement at >= 1-limit); no fee, rebate ignored; hold to resolution.` });
    }
  }
}

export { variants, CAP, depth, CL };
