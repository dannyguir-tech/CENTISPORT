// Fresh-tape test of TM-prev-rev-5m ('at' and 'thru' maker fills), the analyst's tape-checked maker rule, on 5m windows the
// analyst never used (fresh 2026-08-14..09-07 = same 60 s-TWAP resolution regime as the analyst's sample).
// Rule (copied from run.mjs FAMILY TM): at the first snapshot of window b with real time >= start+5s, post a bid for the side
// OPPOSITE to window a's result at L = round(mid - 0.5c, 3); filled if a later real taker fill (t >= t_dec + 2, <= end - 10)
// reaches L ('at': taker SELL of the side at <= L, or taker BUY of the complement at >= 1 - L) or trades 1c through it ('thru').
// No fee, rebate ignored, hold to resolution. Tape = data-api /trades?market=&start=&end= (takerOnly), paginated by time.
//   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt BTC_RPS=3 BTC_CONC=3 node tm_fresh.mjs --n=700
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from '../../../lib/http.mjs';
import { loadUpDown } from './load_shim.mjs';
import * as base from '../../../lib/load.mjs';
import { featA, buildCL } from './features.mjs';
import { mkTrade, fmt } from '../mod/lib.mjs';
import { mulberry32 } from '../../../lib/util.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const NS = Number(args.n || 700);
const CL = buildCL();
const first5 = base.loadUpDown('5m')[0].windowStart;
const meta = new Map(loadUpDown('5m').map((r) => [r.slug, r]));
const rows = featA('5m', CL).filter((r) => r.t + 16 < first5 && /twap-60/.test(meta.get(r.id)?.resolutionSource || ''));
// stratified sample: equal number per day
const byDay = new Map(); for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
const rnd = mulberry32(2026); const per = Math.ceil(NS / byDay.size); const sample = [];
for (const [, a] of byDay) { const c = [...a]; for (let k = 0; k < per && c.length; k++) sample.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); }
console.log('fresh TWAP60 rows', rows.length, 'days', byDay.size, 'sampled', sample.length);

async function tape(r) {
  const m = meta.get(r.id); const t0 = Math.floor(r.t + 2), t1 = r.end - 10; const all = [];
  // offset pagination over the fixed [t0, t1] filter (settled market: the result set is static); bisection fallback past 4500
  const seg = async (a, b, depth = 0) => {
    for (let off = 0; off <= 4500; off += 500) {
      const page = await getJSON(`https://data-api.polymarket.com/trades?market=${m.conditionId}&limit=500&offset=${off}&start=${a}&end=${b}`, { allowStatus: [400, 404] });
      if (!Array.isArray(page)) return false;
      for (const x of page) all.push({ t: x.timestamp, side: x.side === 'BUY' ? 'B' : 'S', o: x.asset === m.upToken ? 'U' : x.asset === m.downToken ? 'D' : '?', p: +x.price, s: +x.size, tx: x.transactionHash });
      if (page.length < 500) return true;
    }
    if (depth < 4 && b - a > 1) { const mid = Math.floor((a + b) / 2); const o1 = await seg(a, mid, depth + 1); const o2 = await seg(mid + 1, b, depth + 1); return o1 && o2; }
    return false;
  };
  const complete = await seg(t0, t1);
  const seen = new Set(); const tr = all.filter((x) => { const k = x.tx + x.o + x.side + x.p + x.s; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t);
  return { complete, trades: tr };
}
const res = [];
let done = 0;
await pool(sample, 3, async (r) => {
  const tp = await tape(r);
  const up = r.prev < 0; // reversal side
  const b = mkTrade({ day: r.day, t: r.t, side: up ? 'U' : 'D', pUp: r.p, win: up ? r.win : !r.win, fee: r.fee, id: r.id });
  if (!b) return;
  const L = Math.round((b.pRef - 0.005) * 1000) / 1000; const S = b.side;
  const fill = (tol) => { for (const x of tp.trades) { if (x.t < r.t + 2) continue; if (x.t > r.end - 10) break; if ((x.o === S && x.side === 'S' && x.p <= L + tol) || (x.o !== S && x.o !== '?' && x.side === 'B' && 1 - x.p <= L + tol)) return x; } return null; };
  const fa = fill(1e-9), ft = fill(-0.01 + 1e-9);
  res.push({ day: r.day, id: r.id, pRef: b.pRef, L, win: b.win, complete: tp.complete, nTape: tp.trades.length, at: !!fa, thru: !!ft, atDelay: fa ? fa.t - r.t : null });
  if (++done % 100 === 0) console.log(`${done}/${sample.length} req=${stats.requests} hits=${stats.cacheHits} fail=${stats.failures}`);
});
const f4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
function boot(tr, B = 2000) {
  const days = [...new Set(tr.map((t) => t.day))].sort(); const by = new Map(days.map((d) => [d, []])); for (const t of tr) by.get(t.day).push(t);
  const P = days.map((d) => by.get(d).reduce((s, t) => s + t.win / t.L - 1, 0)), E = days.map((d) => by.get(d).reduce((s, t) => s + t.win - t.L, 0)), N = days.map((d) => by.get(d).length);
  const n = N.reduce((a, b) => a + b, 0); const roi = P.reduce((a, b) => a + b, 0) / n, edge = E.reduce((a, b) => a + b, 0) / n;
  const rr = mulberry32(5); const v = [], e = [];
  for (let b = 0; b < B; b++) { let nn = 0, pp = 0, ee = 0; for (let k = 0; k < days.length; k++) { const i = Math.floor(rr() * days.length); nn += N[i]; pp += P[i]; ee += E[i]; } if (nn) { v.push(pp / nn); e.push(ee / nn); } }
  v.sort((a, b) => a - b); e.sort((a, b) => a - b); const q = (a, x) => a[Math.floor(x * (a.length - 1))];
  return { n, days: days.length, win: f4(tr.reduce((s, t) => s + t.win, 0) / n), avgL: f4(tr.reduce((s, t) => s + t.L, 0) / n), edge: f4(edge), edgeCi: [f4(q(e, 0.025)), f4(q(e, 0.975))], roi: f4(roi), roiCi: [f4(q(v, 0.025)), f4(q(v, 0.975))] };
}
const out = { sampled: sample.length, evaluated: res.length, incompleteTapes: res.filter((r) => !r.complete).length, http: { requests: stats.requests, cacheHits: stats.cacheHits, retries: stats.retries, failures: stats.failures },
  allBids_noAdverseSelection: boot(res), at: { fillRate: f4(res.filter((r) => r.at).length / res.length), ...boot(res.filter((r) => r.at)) }, thru: { fillRate: f4(res.filter((r) => r.thru).length / res.length), ...boot(res.filter((r) => r.thru)) },
  unfilledAt: boot(res.filter((r) => !r.at)) };
fs.writeFileSync(path.join(HERE, '..', 'out', 'tm_fresh.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
