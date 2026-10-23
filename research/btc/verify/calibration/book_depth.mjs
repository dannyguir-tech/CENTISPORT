// Verifier (calibration family): live order-book spread/depth at the candidates' decision phases, from the
// read-only book polls in data/live_structure (another job's ~20 s polls of all open BTC markets, 2026-10-22).
//   node book_depth.mjs -> out/book_depth.json
// For every in-play Up/Down market in every poll: phase = (ts - windowStart)/W; per token: best bid/ask, spread,
// USDC ask depth within 1c / 2c / 3c of the best ask. Aggregated by tf x phase bucket x token-price band.
// Also checks whether a token's asks are the mirror of the complement's bids (same orders) or additive.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIR = path.join(HERE, '..', '..', 'data', 'live_structure');
const W = { updown_5m: 300, updown_15m: 900, updown_1h: 3600, updown_4h: 14400, updown_1d: 86400 };
const PH = [[-0.3, 0, 'pre'], [0, 0.1, 's0'], [0.15, 0.35, 'f25'], [0.4, 0.6, 'f50'], [0.65, 0.85, 'f75'], [0.85, 0.97, 'f90'], [0.97, 1, 'end']];
const BANDS = [[0.4, 0.6], [0.6, 0.8], [0.8, 0.9], [0.9, 0.95], [0.95, 0.98], [0.98, 1.0]];
const acc = new Map(); let mirrorChecks = 0, mirrored = 0; const seen = new Set();
const files = fs.readdirSync(DIR).filter((f) => f.startsWith('poll_')).sort();
for (const f of files) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString('utf8'));
  const ts = d.fetchedTs;
  for (const e of d.events) {
    if (!W[e.kind]) continue; const ph = (ts - e.windowStart) / W[e.kind]; const P = PH.find(([a, b]) => ph >= a && ph < b); if (!P) continue;
    for (const m of e.markets) {
      const [tu, td] = m.tokenIds; const bu = d.books[tu], bd = d.books[td]; if (!bu || !bd) continue;
      if (bu.asks?.length && bd.bids?.length) { mirrorChecks++; if (Math.abs(bu.asks[0][0] - (1 - bd.bids[0][0])) < 1e-9 && Math.abs(bu.asks[0][1] - bd.bids[0][1]) < 1e-6) mirrored++; }
      for (const [b, other] of [[bu, bd], [bd, bu]]) {
        if (!b.asks?.length || !b.bids?.length) continue;
        const ask = b.asks[0][0], bid = b.bids[0][0], mid = (ask + bid) / 2;
        const B = BANDS.find(([lo, hi]) => mid >= lo && mid < hi); if (!B) continue;
        const dep = (c) => b.asks.filter(([p]) => p <= ask + c + 1e-9).reduce((s, [p, q]) => s + p * q, 0);
        const key = `${e.kind.slice(7)}|${P[2]}|${B[0]}-${B[1]}`;
        if (!acc.has(key)) acc.set(key, { spread: [], d1: [], d2: [], d3: [], mk: new Set() });
        const a = acc.get(key); a.spread.push(ask - bid); a.d1.push(dep(0.01)); a.d2.push(dep(0.02)); a.d3.push(dep(0.03)); a.mk.add(m.conditionId);
      }
    }
  }
}
const q = (arr, f) => { const s = [...arr].sort((x, y) => x - y); return s.length ? +s[Math.floor(f * (s.length - 1))].toFixed(4) : null; };
const out = { polls: files.length, firstTs: files[0], lastTs: files.at(-1), mirrorCheck: { checks: mirrorChecks, upAskEqualsMirroredDownBid: mirrored }, cells: {} };
for (const [k, a] of [...acc.entries()].sort()) out.cells[k] = { obs: a.spread.length, markets: a.mk.size, spreadMed: q(a.spread, 0.5), spreadP75: q(a.spread, 0.75), askDepth1cUSD_med: q(a.d1, 0.5), askDepth1cUSD_p25: q(a.d1, 0.25), askDepth2cUSD_med: q(a.d2, 0.5), askDepth3cUSD_med: q(a.d3, 0.5) };
fs.writeFileSync(path.join(HERE, 'out', 'book_depth.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ polls: out.polls, mirrorCheck: out.mirrorCheck }));
for (const [k, c] of Object.entries(out.cells)) if (/^(4h\|f90|4h\|f75|1h\|f75|15m\|f25|5m\|f90|5m\|pre|4h\|s0|1d\|f50|1d\|f25)/.test(k)) console.log(k.padEnd(22), JSON.stringify(c));
