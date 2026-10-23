// Fill-realism attack v2 (resumes the interrupted fetch_fills.mjs: same URLs -> same disk cache).
// For every OOS trade of the positive-ROI TAKER leads (analyst conventions, out/attack_LAG16_LAT5.json), fetch the real
// taker fills of that market in [t_dec - 2s, t_dec + 60s] (t_dec = decision real time = snapshot label - 16s) and derive
// the price a buyer of side S actually faced:
//   taker BUY of S at p            -> an S ask existed at p
//   taker SELL of the complement at q -> a complement bid (or an S ask via merge) existed, i.e. an S ask at 1-q
// Metrics per lead: share of trades with any S-equivalent fill in (t, t+60]; first fill - pRef; min fill in the first 20s - pRef;
// and the lead's ROI re-priced at  exec = first observed S fill (no extra haircut) + 0.07 p(1-p) fee, and at
// exec = max(pRef + 1c, first fill) (the analyst's haircut can only get worse, never better), with trades that saw no fill in
// 60s either kept at pRef+1c ('keep') or dropped ('drop').
//   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt BTC_RPS=2.5 BTC_CONC=3 node fills2.mjs
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { loadUpDown } from '../../lib/load.mjs';
import { mulberry32 } from '../../lib/util.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = process.env.SRC || path.join(HERE, 'out', 'attack_LAG16_LAT5.json');
const A = JSON.parse(fs.readFileSync(SRC, 'utf8')).candidates;
const IDS = ['A-mag-rev-5m', 'A-streak-rev-1h', 'W-lvl-mom-5m-f0.2', 'W-lvl-mom-15m-f0.2', 'X-cnt-mom-1h-from-15m', 'A-last5-mom-1h', 'A-prev-rev-4h', 'W-vel-mom-1d-f0.4', 'W-lvl-mom-5m-f0.4', 'X-cnt-mom-1d-from-4h', 'W-lvl-rev-1d-f0.2', 'W-vel-mom-1d-f0.8'];
const bySlug = new Map();
for (const tf of ['5m', '15m', '1h', '4h', '1d']) for (const r of loadUpDown(tf)) bySlug.set(r.slug, r);
const plan = new Map();
for (const id of IDS) for (const t of A[id].trades) {
  const r = bySlug.get(t.id); if (!r) continue;
  const key = `${r.conditionId}|${t.t}`;
  if (!plan.has(key)) plan.set(key, { conditionId: r.conditionId, up: r.upToken, dn: r.downToken, t: t.t });
}
const items = [...plan.values()];
console.log('planned', items.length);
const got = new Map(); let done = 0;
await pool(items, 3, async (p) => {
  const page = await getJSON(`https://data-api.polymarket.com/trades?market=${p.conditionId}&limit=500&start=${p.t - 2}&end=${p.t + 60}`, { allowStatus: [400, 404] });
  const trades = Array.isArray(page) ? page.map((x) => ({ t: x.timestamp, side: x.side === 'BUY' ? 'B' : 'S', o: x.asset === p.up ? 'U' : x.asset === p.dn ? 'D' : '?', p: +x.price, s: +x.size })).sort((a, b) => a.t - b.t) : null;
  got.set(`${p.conditionId}|${p.t}`, trades);
  if (++done % 250 === 0) console.log(`${done}/${items.length} req=${stats.requests} hits=${stats.cacheHits} fail=${stats.failures}`);
});
console.log('fetched', JSON.stringify({ requests: stats.requests, cacheHits: stats.cacheHits, retries: stats.retries, failures: stats.failures }));

const fee = (p) => 0.07 * p * (1 - p);
const costAt = (x) => { const e = Math.min(0.995, Math.max(0.005, x)); return e + fee(e); };
const q = (a, x) => { const s = [...a].sort((u, v) => u - v); return s.length ? s[Math.min(s.length - 1, Math.floor(x * (s.length - 1)))] : null; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const f4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
function boot(tr, costFn, B = 2000, seed = 4242) {
  const days = [...new Set(tr.map((t) => t.day))].sort(); const by = new Map(days.map((d) => [d, []])); for (const t of tr) by.get(t.day).push(t);
  const P = days.map((d) => by.get(d).reduce((s, t) => s + t.win / costFn(t) - 1, 0)), N = days.map((d) => by.get(d).length);
  const roi = P.reduce((a, b) => a + b, 0) / N.reduce((a, b) => a + b, 0);
  const rnd = mulberry32(seed); const v = [];
  for (let b = 0; b < B; b++) { let n = 0, p = 0; for (let k = 0; k < days.length; k++) { const i = Math.floor(rnd() * days.length); n += N[i]; p += P[i]; } if (n) v.push(p / n); }
  v.sort((a, b) => a - b);
  let cnt = 0; for (const r of v) if (r - roi >= roi) cnt++;
  return { roi: f4(roi), ci: [f4(v[Math.floor(0.025 * (v.length - 1))]), f4(v[Math.floor(0.975 * (v.length - 1))])], p: roi > 0 ? f4((1 + cnt) / (v.length + 1)) : 1 };
}
const out = {};
for (const id of IDS) {
  const rows = [];
  for (const t of A[id].trades) {
    const r = bySlug.get(t.id); if (!r) continue;
    const tr = got.get(`${r.conditionId}|${t.t}`);
    const S = t.side;
    const eq = (tr || []).filter((x) => x.t > t.t && x.t <= t.t + 60).map((x) => (x.o === S && x.side === 'B' ? { t: x.t, p: x.p, s: x.s } : x.o !== S && x.o !== '?' && x.side === 'S' ? { t: x.t, p: 1 - x.p, s: x.s } : null)).filter(Boolean);
    const first = eq.length ? eq[0].p : null;
    const in20 = eq.filter((x) => x.t <= t.t + 20);
    const min20 = in20.length ? Math.min(...in20.map((x) => x.p)) : null;
    const usd60 = eq.reduce((s, x) => s + x.p * x.s, 0);
    rows.push({ ...t, fetched: tr != null, first, min20, usd60 });
  }
  const ok = rows.filter((r) => r.fetched);
  const withFill = ok.filter((r) => r.first != null);
  const dFirst = withFill.map((r) => r.first - r.pRef), dMin = ok.filter((r) => r.min20 != null).map((r) => r.min20 - r.pRef);
  const base = (t) => costAt(t.pRef + 0.01);
  const keepFirst = (t) => (t.first != null ? costAt(t.first) : base(t));
  const keepMax = (t) => (t.first != null ? costAt(Math.max(t.pRef + 0.01, t.first)) : base(t));
  out[id] = {
    nTrades: rows.length, nFetched: ok.length, fracWithSFillIn60s: f4(withFill.length / (ok.length || 1)),
    firstMinusRef: { mean: f4(mean(dFirst)), median: f4(q(dFirst, 0.5)), p75: f4(q(dFirst, 0.75)), p90: f4(q(dFirst, 0.9)), fracAbove1c: f4(dFirst.filter((x) => x > 0.01 + 1e-9).length / (dFirst.length || 1)), fracAbove2c: f4(dFirst.filter((x) => x > 0.02 + 1e-9).length / (dFirst.length || 1)) },
    min20MinusRef: { n: dMin.length, mean: f4(mean(dMin)), median: f4(q(dMin, 0.5)) },
    medianSUsdIn60s: f4(q(ok.map((r) => r.usd60), 0.5)),
    roi_analyst_mid_plus_1c: boot(ok, base),
    roi_exec_firstFill_keepNoFill: boot(ok, keepFirst),
    roi_exec_max_ref1c_firstFill_keepNoFill: boot(ok, keepMax),
    roi_exec_firstFill_dropNoFill: withFill.length ? { n: withFill.length, ...boot(withFill, (t) => costAt(t.first)) } : null,
  };
  console.log(id.padEnd(24), JSON.stringify(out[id]));
}
fs.writeFileSync(path.join(HERE, 'out', 'fills2.json'), JSON.stringify(out, null, 1));
