// Verifier (calibration family): fetch the real taker fills around each candidate leg's decision time, so the
// snapshot-based execution cost can be replaced by prices that actually traded.
//   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt BTC_RPS=4 BTC_CONC=4 node fetch_exec.mjs
// Input : repro/out/cand_legs.json (dumped by the re-run of the analyst's calib.mjs)
// Output: data/exec_fills.jsonl  one row per (conditionId, center time): trades in [center-60, center+120]
// Uses lib/http.mjs (<= 8 req/s global, retries with backoff, gzip disk cache under data/raw/cache -> re-runs resume).
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { loadUpDown } from '../../lib/load.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const C = JSON.parse(fs.readFileSync(path.join(HERE, 'repro', 'out', 'cand_legs.json'), 'utf8')).variants;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// which variants' legs to fetch, and how many at most (seeded subsample when capped)
const PLAN = [
  [/^F6_reaction_taker\|4h\|f90\|mom\|.*"thr":0\.(2|3)\}/, Infinity, ['f75', 'f90', 'dec']],
  [/^F1_band_taker\|15m\|f25\|(up|down|tok)\|\{"lo":0\.9,"hi":0\.95\}/, Infinity, ['dec']],
  [/^F1_band_taker\|1h\|f75\|tok\|\{"lo":0\.95,"hi":0\.98\}/, Infinity, ['dec']],
  [/^F4_wf_logit_model\|1h\|f75\|/, Infinity, ['dec']],
  [/^F8_wf_chainlink_model\|4h\|f90\|/, Infinity, ['dec']],
  [/^F3_wf_band_taker\|5m\|pre\|down\|/, Infinity, ['dec']],
  [/^F1_band_taker\|5m\|pre\|down\|\{"lo":0\.5,"hi":0\.6\}/, Infinity, ['dec'], (l) => l.q >= 0.55],
  [/^F3_wf_band_taker\|1d\|f50\|up\|/, Infinity, ['dec']],
  [/^F9_streak_taker\|4h\|s0\|rev1\|/, 400, ['dec']],
  [/^F1_band_taker\|5m\|f90\|tok\|\{"lo":0\.98,"hi":0\.999\}/, 400, ['dec']],
];
const recByCid = new Map();
for (const tf of ['5m', '15m', '1h', '4h', '1d']) for (const r of loadUpDown(tf)) recByCid.set(r.conditionId, r);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const items = new Map();
for (const [re, cap, centers, keep] of PLAN) {
  for (const [id, v] of Object.entries(C)) {
    if (!re.test(id)) continue;
    let legs = v.legs.filter((l) => !keep || keep(l));
    if (legs.length > cap) { const r = rng(42); legs = legs.map((l) => [r(), l]).sort((a, b) => a[0] - b[0]).slice(0, cap).map((x) => x[1]); }
    for (const l of legs) {
      const rec = recByCid.get(l.cid); if (!rec) continue;
      const W = rec.windowEnd - rec.windowStart;
      for (const c of centers) {
        // 'dec' = the leg's own snapshot time; 'f75'/'f90' = nominal fractions (F6 signal points; nearest snapshot <= T is within 120 s)
        const t = c === 'dec' ? l.tDec : Math.floor(rec.windowStart + (c === 'f75' ? 0.75 : 0.9) * W);
        const key = `${l.cid}|${t}`;
        if (!items.has(key)) items.set(key, { cid: l.cid, slug: rec.slug, up: rec.upToken, dn: rec.downToken, t, S: rec.windowStart, E: rec.windowEnd });
      }
    }
  }
}
const list = [...items.values()];
log('planned requests (centers)', list.length);
const out = []; let done = 0;
await pool(list, 4, async (p) => {
  const seen = new Map(); let end = p.t + 120; let pages = 0; let ok = true;
  while (pages < 4) {
    const page = await getJSON(`https://data-api.polymarket.com/trades?market=${p.cid}&limit=500&start=${p.t - 60}&end=${end}`, { allowStatus: [400, 404] });
    pages++;
    if (!Array.isArray(page)) { ok = false; break; }
    for (const x of page) seen.set(`${x.transactionHash}|${x.asset}|${x.size}|${x.price}|${x.side}|${x.timestamp}`, x);
    if (page.length < 500) break;
    const minTs = Math.min(...page.map((x) => x.timestamp)); if (minTs <= p.t - 60 || minTs >= end) break; end = minTs;
  }
  const trades = [...seen.values()].map((x) => ({ t: x.timestamp, side: x.side === 'BUY' ? 'B' : 'S', o: x.asset === p.up ? 'U' : x.asset === p.dn ? 'D' : '?', p: +x.price, s: +x.size })).sort((a, b) => a.t - b.t);
  out.push({ ...p, ok, pages, n: trades.length, trades });
  if (++done % 200 === 0) log(`${done}/${list.length} req=${stats.requests} hits=${stats.cacheHits} retries=${stats.retries} fail=${stats.failures}`);
});
fs.mkdirSync(path.join(HERE, 'data'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'data', 'exec_fills.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
log('done', out.length, JSON.stringify({ requests: stats.requests, cacheHits: stats.cacheHits, retries: stats.retries, failures: stats.failures, failureSamples: stats.failureSamples.slice(0, 3) }));
