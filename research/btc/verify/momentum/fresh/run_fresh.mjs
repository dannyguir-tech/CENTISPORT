// Fresh-data test: apply each lead at the threshold the analyst's walk-forward actually chose (modal choice, fixed,
// no re-tuning) to OLDER Up/Down windows the analyst never loaded (verify/momentum/data/updown_<tf>_ext.jsonl).
// Same feature code (analyst features.mjs via a loader shim), same execution/fee conventions (mid + 1c + 0.07p(1-p),
// LAG 16s, LATENCY 5s), day-clustered bootstrap. Only trades in windows that start before the analyst's first window
// (for every timeframe the rule touches) count as fresh.
import fs from 'node:fs';
import path from 'node:path';
import { loadUpDown, WINDOW_SEC } from './load_shim.mjs';
import * as base from '../../../lib/load.mjs';
import { featW, featA, featX, buildCL } from './features.mjs';
import { mkTrade, makerTrade, summarize, bootstrap, fmt } from '../mod/lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CL = buildCL();
const firstOrig = {}; for (const tf of ['5m', '15m', '1h', '4h', '1d']) firstOrig[tf] = base.loadUpDown(tf)[0].windowStart;
const meta = new Map(); for (const tf of ['5m', '15m', '1h']) for (const r of loadUpDown(tf)) meta.set(r.slug, r);

function evalTrades(tr, label) {
  const days = [...new Set(tr.map((t) => t.day))].sort();
  const s = summarize(tr), sm = summarize(tr, 'minp'), s2 = summarize(tr, 'docs_always', 0.02);
  const b = bootstrap(tr, days, { B: 2000 });
  const half = new Set(days.slice(0, Math.floor(days.length / 2)));
  const h1 = summarize(tr.filter((t) => half.has(t.day))), h2 = summarize(tr.filter((t) => !half.has(t.day)));
  // split by resolution source of the traded market (5m/15m switched from the plain Chainlink stream to a 60s TWAP)
  const bySrc = {};
  for (const t of tr) { const r = meta.get(t.id); const k = r ? (r.cryptoMarketConfigId || (r.resolutionSource || '').replace('https://', '').slice(0, 40)) : '?'; (bySrc[k] ||= []).push(t); }
  return {
    label, n: s.n, days: days.length, range: days.length ? `${days[0]}..${days[days.length - 1]}` : null,
    win: fmt(s.winRate), avgRef: fmt(s.avgRef), cost: fmt(s.avgCost), edge: fmt(s.edge), roi: fmt(s.roi), roiMinp: fmt(sm.roi), roi2c: fmt(s2.roi),
    ci95: [fmt(b.ci[0]), fmt(b.ci[1])], edgeCi95: [fmt(b.edgeCi[0]), fmt(b.edgeCi[1])], pOneSided: fmt(b.p, 4),
    firstHalfRoi: fmt(h1.roi), firstHalfN: h1.n, secondHalfRoi: fmt(h2.roi), secondHalfN: h2.n,
    bySource: Object.fromEntries(Object.entries(bySrc).map(([k, a]) => { const x = summarize(a); return [k, { n: x.n, roi: fmt(x.roi), edge: fmt(x.edge) }]; })),
  };
}
const out = [];
const fresh = (tfs) => (t, ws) => tfs.every((tf) => ws < firstOrig[tf]);

// ---- within-window
const W = [
  ['W-lvl-mom-5m-f0.2', '5m', 0.2, 'lvl', 'mom', [0.35, 0.3, 0.4], false],
  ['W-lvl-mom-5m-f0.4', '5m', 0.4, 'lvl', 'mom', [0.35, 0.3], false],
  ['W-lvl-mom-15m-f0.2', '15m', 0.2, 'lvl', 'mom', [0.4, 0.35], false],
  ['W-lvl-mom-1h-f0.4', '1h', 0.4, 'lvl', 'mom', [0.35, 0.4], false],
  ['W-vel-rev-1h-f0.4', '1h', 0.4, 'vel', 'rev', [0.06], false],
  ['MW-lvl-mom-1h-f0.4', '1h', 0.4, 'lvl', 'mom', [0.35], true],
];
for (const [id, tf, f, kind, dir, ths, maker] of W) {
  const rows = featW(tf, f).filter((r) => r.t + 16 < firstOrig[tf]);
  for (const th of ths) {
    const tr = [];
    for (const r of rows) {
      const s = kind === 'lvl' ? r.p - r.pOpen : r.p - r.pPrev;
      let up; if (s > th) up = dir === 'mom'; else if (s < -th) up = dir !== 'mom'; else continue;
      const b = mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id });
      const t = maker ? makerTrade(b, r.ep, r.t, r.end) : b; if (t) tr.push(t);
    }
    out.push({ id, theta: th, ...evalTrades(tr, `${id} theta=${th}`) });
  }
}
// ---- across windows
const Aset = [
  ['A-mag-rev-5m', '5m', 'mag', 'rev', [2.5, 2.0, 1.5], false],
  ['A-prev-rev-5m', '5m', 'prev', 'rev', [1], false],
  ['A-prev-mom-5m', '5m', 'prev', 'mom', [1], false],
  ['A-lastmin-rev-5m', '5m', 'lastmin', 'rev', [3, 2], false],
  ['MA-prev-rev-5m', '5m', 'prev', 'rev', [1], true],
  ['A-prev-rev-15m', '15m', 'prev', 'rev', [1], false],
  ['A-mag-rev-15m', '15m', 'mag', 'rev', [2.5], false],
  ['A-streak-rev-1h', '1h', 'streak', 'rev', [6, 5, 4], false],
  ['MA-streak-rev-1h', '1h', 'streak', 'rev', [6], true],
  ['A-prev-rev-1h', '1h', 'prev', 'rev', [1], false],
];
const sigOf = { prev: (r) => r.prev, streak: (r) => r.streak, mag: (r) => r.zMag, lastmin: (r) => r.lastMin };
for (const [id, tf, kind, dir, ths, maker] of Aset) {
  const rows = featA(tf, CL).filter((r) => meta.get(r.id)?.ext || (r.t + 16 < firstOrig[tf]));
  for (const th of ths) {
    const tr = [];
    for (const r of rows) {
      const s = sigOf[kind](r); if (s == null) continue;
      let up; if (s >= th && s > 0) up = dir === 'mom'; else if (s <= -th && s < 0) up = dir !== 'mom'; else continue;
      const b = mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id });
      const t = maker ? makerTrade(b, r.ep, r.t, r.end) : b; if (t) tr.push(t);
    }
    out.push({ id, theta: th, ...evalTrades(tr, `${id} theta=${th}`) });
  }
}
// ---- cross timeframe (fresh = long window starts before the analyst's first window of BOTH timeframes it uses)
const Xset = [
  ['X-cnt-mom-15m-from-5m', '15m', '5m', 'cnt', [1]],
  ['X-gap-15m-from-5m', '15m', '5m', 'gap', [0.1]],
  ['X-cnt-mom-1h-from-15m', '1h', '15m', 'cnt', [3, 2]],
  ['X-gap-1h-from-5m', '1h', '5m', 'gap', [0.02, 0.08]],
];
for (const [id, lt, st, kind, ths] of Xset) {
  const rows0 = featX(lt, st, CL);
  const rows = (kind === 'gap' ? rows0.map((r) => ({ ...r, dec: r.dec.filter((d) => d.P != null) })).filter((r) => r.dec.length) : rows0)
    .filter((r) => { const m = meta.get(r.id); return m && m.windowStart < firstOrig[lt] || (m && m.windowStart < firstOrig[st]); });
  for (const th of ths) {
    const tr = [];
    for (const r of rows) {
      const m = meta.get(r.id);
      // the analyst's X rows for this pair start where BOTH series overlap; a window is fresh if the analyst could not have built it
      if (!(m.windowStart < Math.max(firstOrig[lt], firstOrig[st]))) continue;
      for (const d of r.dec) {
        const up = kind === 'cnt' ? (d.c >= th ? true : d.c <= -th ? false : null) : (d.P - d.p > th ? true : d.p - d.P > th ? false : null);
        if (up == null) continue;
        const b = mkTrade({ day: r.day, t: d.t, side: up ? 'U' : 'D', pUp: d.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id });
        if (!b) continue; tr.push(b); break;
      }
    }
    out.push({ id, theta: th, ...evalTrades(tr, `${id} theta=${th}`) });
  }
}
const ext = {}; for (const tf of ['5m', '15m', '1h']) { const a = loadUpDown(tf).filter((r) => r.ext); ext[tf] = a.length ? { n: a.length, from: a[0].day, to: a[a.length - 1].day, analystFirst: new Date(firstOrig[tf] * 1000).toISOString() } : null; }
fs.writeFileSync(path.join(HERE, '..', 'out', 'fresh.json'), JSON.stringify({ ext, results: out }, null, 1));
console.log(JSON.stringify(ext));
for (const r of out) console.log(r.label.padEnd(34), 'n', String(r.n).padStart(5), 'd', String(r.days).padStart(3), 'win', r.win, 'cost', r.cost, 'edge', r.edge, 'roi', r.roi, 'CI', JSON.stringify(r.ci95), 'p', r.pOneSided, '| minp', r.roiMinp, '2c', r.roi2c, '| H1', r.firstHalfRoi, 'H2', r.secondHalfRoi, '|', JSON.stringify(r.bySource));
