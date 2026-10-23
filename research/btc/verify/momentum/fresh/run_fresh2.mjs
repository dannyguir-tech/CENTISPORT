// Fresh-data holdout v2. Applies each lead at the threshold(s) the analyst's walk-forward chose (fixed, no re-tuning) to
// Up/Down windows the analyst never used (verify/momentum/data/updown_<tf>_ext.jsonl: 5m 2026-04-01..09-07, 15m 2025-09-13..
// 2026-06-24, 1h 2025-06..2025-10-22), with the analyst's own feature code (via load_shim) and execution conventions
// (LAG 16 s, LATENCY 5 s, taker = mid + 1c + 0.07 p(1-p), band [0.03, 0.95]).
// New vs run_fresh.mjs: 15m leads; A-last5-mom-1h (5m Chainlink boundaries now exist from 2026-04); resolution-regime split
// (plain Chainlink stream vs 30 s / 60 s TWAP); per-share edge with day-bootstrap CI next to flat-stake ROI; pooled
// 'clean' estimate = analyst OOS trades + fresh trades in the SAME resolution regime; TM upper bound (every maker bid filled).
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown } from './load_shim.mjs';
import * as base from '../../../lib/load.mjs';
import { featW, featA, featX, buildCL } from './features.mjs';
import { mkTrade, makerTrade, pnlOf, fmt } from '../mod/lib.mjs';
import { mulberry32 } from '../../../lib/util.mjs';
import { MODELS } from '../../../lib/fees.mjs';
// stress model applied to EVERY trade regardless of the record's fee era (the analyst's 'minp' is per-record, 0 for pre-fee markets)
MODELS.minp_always = (p) => 0.07 * Math.min(Math.min(1, Math.max(0, p)), 1 - Math.min(1, Math.max(0, p)));

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ATT = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'out', 'attack_LAG16_LAT5.json'), 'utf8')).candidates;
const CL = buildCL();
const firstOrig = {}; for (const tf of ['5m', '15m', '1h', '4h', '1d']) firstOrig[tf] = base.loadUpDown(tf)[0].windowStart;
const meta = new Map(); for (const tf of ['5m', '15m', '1h', '4h', '1d']) for (const r of loadUpDown(tf)) meta.set(r.slug, r);
const regimeOf = (slug) => { const r = meta.get(slug); const s = (r && r.resolutionSource) || ''; return /twap-60/.test(s) ? 'twap60' : /twap-30/.test(s) ? 'twap30' : /binance/i.test(s) ? 'binance' : 'plain'; };

// day-clustered bootstrap of flat-stake ROI and per-share edge (headline cost), one-sided p for H0 <= 0 (centred)
function evalT(tr, { model = 'docs_always', haircut = 0.01, B = 2000, seed = 777 } = {}) {
  const days = [...new Set(tr.map((t) => t.day))].sort();
  if (!days.length) return { n: 0 };
  const di = new Map(days.map((d, i) => [d, i])); const D = days.length;
  const N = new Float64Array(D), P = new Float64Array(D), E = new Float64Array(D), W = new Float64Array(D), C = new Float64Array(D);
  for (const t of tr) { const i = di.get(t.day); const r = pnlOf(t, model, haircut); N[i]++; P[i] += r.pnl; E[i] += r.edge; W[i] += t.win; C[i] += r.cost; }
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const n = sum(N), roi = sum(P) / n, edge = sum(E) / n;
  const rnd = mulberry32(seed); const rs = [], es = [];
  for (let b = 0; b < B; b++) { let nn = 0, pp = 0, ee = 0; for (let k = 0; k < D; k++) { const i = Math.floor(rnd() * D); nn += N[i]; pp += P[i]; ee += E[i]; } if (nn) { rs.push(pp / nn); es.push(ee / nn); } }
  rs.sort((a, b) => a - b); es.sort((a, b) => a - b);
  const qq = (a, x) => a[Math.min(a.length - 1, Math.max(0, Math.floor(x * (a.length - 1))))];
  const pv = (arr, est) => { if (!(est > 0)) return 1; let c = 0; for (const v of arr) if (v - est >= est) c++; return (1 + c) / (arr.length + 1); };
  return { n, days: D, range: `${days[0]}..${days[D - 1]}`, win: fmt(sum(W) / n), cost: fmt(sum(C) / n), edge: fmt(edge), edgeCi: [fmt(qq(es, 0.025)), fmt(qq(es, 0.975))], pEdge: fmt(pv(es, edge), 4), roi: fmt(roi), roiCi: [fmt(qq(rs, 0.025)), fmt(qq(rs, 0.975))], pRoi: fmt(pv(rs, roi), 4) };
}
const full = (tr) => {
  const o = evalT(tr);
  if (!o.n) return o;
  o.minp = evalT(tr, { model: 'minp_always', B: 1 }).roi; o.hc2c = evalT(tr, { haircut: 0.02, B: 1 }).roi; o.zeroFee = evalT(tr, { model: 'zero', B: 1 }).roi;
  const days = [...new Set(tr.map((t) => t.day))].sort(); const h = new Set(days.slice(0, Math.floor(days.length / 2)));
  o.firstHalf = evalT(tr.filter((t) => h.has(t.day)), { B: 1 }); o.secondHalf = evalT(tr.filter((t) => !h.has(t.day)), { B: 1 });
  o.firstHalf = { n: o.firstHalf.n, roi: o.firstHalf.roi, edge: o.firstHalf.edge }; o.secondHalf = { n: o.secondHalf.n, roi: o.secondHalf.roi, edge: o.secondHalf.edge };
  const byReg = {}; for (const t of tr) (byReg[regimeOf(t.id)] ||= []).push(t);
  o.byRegime = Object.fromEntries(Object.entries(byReg).map(([k, a]) => { const e = evalT(a, { B: 1000 }); return [k, { n: e.n, days: e.days, range: e.range, roi: e.roi, roiCi: e.roiCi, edge: e.edge, edgeCi: e.edgeCi }]; }));
  return o;
};
const out = {};
const add = (key, tr, extra = {}) => { out[key] = { ...extra, ...full(tr) }; const o = out[key]; console.log(key.padEnd(44), 'n', String(o.n).padStart(6), 'd', String(o.days ?? 0).padStart(3), 'roi', o.roi, JSON.stringify(o.roiCi), 'p', o.pRoi, '| edge', o.edge, JSON.stringify(o.edgeCi), '| minp', o.minp, '2c', o.hc2c, '| H1', o.firstHalf?.roi, 'H2', o.secondHalf?.roi, '|', JSON.stringify(Object.fromEntries(Object.entries(o.byRegime || {}).map(([k, v]) => [k, [v.n, v.roi, v.edge]])))); };
const trA = (rows, sig, th, dir, maker = false) => {
  const tr = [];
  for (const r of rows) {
    const s = sig(r); if (s == null) continue;
    let up; if (s >= th && s > 0) up = dir === 'mom'; else if (s <= -th && s < 0) up = dir !== 'mom'; else continue;
    const b = mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id });
    const t = maker ? makerTrade(b, r.ep, r.t, r.end) : b; if (t) tr.push(t);
  }
  return tr;
};
const trW = (rows, kind, dir, th) => {
  const tr = [];
  for (const r of rows) {
    const s = kind === 'lvl' ? r.p - r.pOpen : r.p - r.pPrev;
    let up; if (s > th) up = dir === 'mom'; else if (s < -th) up = dir !== 'mom'; else continue;
    const b = mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id }); if (b) tr.push(b);
  }
  return tr;
};
const analystOOS = (id) => (ATT[id]?.trades || []).map((t) => ({ ...t }));

// ---------------- 5m: A-mag-rev, W-lvl-mom (f0.2, f0.4), TM upper bound ----------------
{
  const rows = featA('5m', CL).filter((r) => r.t + 16 < firstOrig['5m']);
  for (const th of [2.5, 2.0, 1.5, 3.0]) add(`A-mag-rev-5m fresh th=${th}`, trA(rows, (r) => r.zMag, th, 'rev'));
  const fr = trA(rows, (r) => r.zMag, 2.5, 'rev');
  add('A-mag-rev-5m fresh th=2.5 TWAP60 only', fr.filter((t) => regimeOf(t.id) === 'twap60'));
  add('A-mag-rev-5m POOLED analystOOS + fresh TWAP60 (th=2.5)', [...analystOOS('A-mag-rev-5m'), ...fr.filter((t) => regimeOf(t.id) === 'twap60')]);
  // |z| profile on fresh TWAP60 to see whether the effect is monotone
  for (const [lo, hi] of [[1.5, 2], [2, 2.5], [2.5, 3], [3, 99]]) add(`A-mag-rev-5m fresh TWAP60 |z| in [${lo},${hi})`, trA(rows.filter((r) => r.zMag != null && Math.abs(r.zMag) < hi), (r) => r.zMag, lo, 'rev').filter((t) => regimeOf(t.id) === 'twap60'));
  // TM upper bound: prev-rev-5m, every bid at mid - 0.5c fills, zero fee (no adverse selection). Real fills can only be worse.
  const ub = trA(rows, (r) => r.prev, 1, 'rev').map((t) => ({ ...t, pRef: Math.round((t.pRef - 0.005) * 1000) / 1000, mk: true }));
  add('TM-prev-rev-5m UPPER BOUND (all bids fill, fresh)', ub);
  add('TM-prev-rev-5m UPPER BOUND (all bids fill, fresh TWAP60)', ub.filter((t) => regimeOf(t.id) === 'twap60'));
  for (const [f, ths] of [[0.2, [0.35]], [0.4, [0.35, 0.3]]]) {
    const rw = featW('5m', f).filter((r) => r.t + 16 < firstOrig['5m']);
    for (const th of ths) {
      const tr = trW(rw, 'lvl', 'mom', th);
      add(`W-lvl-mom-5m-f${f} fresh th=${th}`, tr);
      add(`W-lvl-mom-5m-f${f} fresh th=${th} TWAP60 only`, tr.filter((t) => regimeOf(t.id) === 'twap60'));
    }
  }
}
// ---------------- 15m ----------------
{
  for (const [f, ths] of [[0.2, [0.4, 0.35]]]) {
    const rw = featW('15m', f).filter((r) => r.t + 16 < firstOrig['15m']);
    for (const th of ths) add(`W-lvl-mom-15m-f${f} fresh th=${th}`, trW(rw, 'lvl', 'mom', th));
  }
  const rows = featA('15m', CL).filter((r) => r.t + 16 < firstOrig['15m']);
  add('A-prev-rev-15m fresh', trA(rows, (r) => r.prev, 1, 'rev'));
  add('A-mag-rev-15m fresh th=2.5', trA(rows, (r) => r.zMag, 2.5, 'rev'));
}
// ---------------- 1h: A-streak-rev, A-last5-mom, X-cnt-mom-1h-from-15m ----------------
{
  const rows = featA('1h', CL);
  const fr = rows.filter((r) => r.t + 16 < firstOrig['1h']);
  for (const th of [6, 5]) add(`A-streak-rev-1h fresh th=${th}`, trA(fr, (r) => r.streak, th, 'rev'));
  add('MA-streak-rev-1h fresh th=6', trA(fr, (r) => r.streak, 6, 'rev', true));
  // the analyst could compute z5 only from 2026-09-07 (first 5m window); earlier z5 values come from the fresh 5m boundaries
  const r5 = rows.filter((r) => r.z5 != null && r.t + 16 < firstOrig['5m']);
  for (const th of [1, 2.5]) add(`A-last5-mom-1h fresh th=${th}`, trA(r5, (r) => r.z5, th, 'mom'));
  const xr = featX('1h', '15m', CL).filter((r) => { const m = meta.get(r.id); return m && m.windowStart < firstOrig['15m']; });
  for (const th of [3, 2]) {
    const tr = [];
    for (const r of xr) for (const d of r.dec) {
      const up = d.c >= th ? true : d.c <= -th ? false : null; if (up == null) continue;
      const b = mkTrade({ day: r.day, t: d.t, side: up ? 'U' : 'D', pUp: d.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id });
      if (!b) continue; tr.push(b); break;
    }
    add(`X-cnt-mom-1h-from-15m fresh th=${th}`, tr);
  }
}
// ---------------- 4h: no fresh data exists (series starts 2025-10-15) -> regime split of the analyst's OOS trades ----------------
for (const id of ['A-prev-rev-4h', 'MA-prev-rev-4h', 'A-streak-rev-1h', 'X-cnt-mom-1h-from-15m', 'W-vel-mom-1d-f0.4', 'A-last5-mom-1h', 'A-mag-rev-5m', 'W-lvl-mom-5m-f0.2', 'W-lvl-mom-15m-f0.2', 'TM-prev-rev-5m-at']) {
  const tr = analystOOS(id);
  add(`${id} ANALYST OOS (recomputed)`, tr);
  // calendar-month breakdown
  const bm = {}; for (const t of tr) (bm[t.day.slice(0, 7)] ||= []).push(t);
  out[`${id} ANALYST OOS (recomputed)`].byMonth = Object.fromEntries(Object.entries(bm).sort().map(([m, a]) => { const e = evalT(a, { B: 1 }); return [m, { n: e.n, roi: e.roi, edge: e.edge }]; }));
  console.log('   months', JSON.stringify(out[`${id} ANALYST OOS (recomputed)`].byMonth));
}
const ext = {}; for (const tf of ['5m', '15m', '1h']) { const a = loadUpDown(tf).filter((r) => r.ext); ext[tf] = a.length ? { n: a.length, from: a[0].day, to: a[a.length - 1].day, analystFirst: new Date(firstOrig[tf] * 1000).toISOString() } : null; }
fs.writeFileSync(path.join(HERE, '..', 'out', 'fresh2.json'), JSON.stringify({ ext, results: out }, null, 1));
console.log(JSON.stringify(ext));
