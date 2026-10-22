#!/usr/bin/env node
// Half-spread and top-of-book depth model by market family x price band, from every live book snapshot we have:
// the collector's data/live/snapshot_*.json and this analysis' data/live_structure/poll_*.json.gz.
// Output: reports/structure/spread_model.json  (used by common.halfSpread for historical executable-cost estimates).
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../../lib/util.mjs';
import { BANDS, bandOf, writeJSON, readGz, r4 } from './common.mjs';

const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const q = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

const acc = {}; // kind -> band -> {hs:[], depth1c:[], depthUsd1c:[]}
function add(kind, bids, asks) {
  if (!bids.length || !asks.length) return;
  const b = bids[0][0], a = asks[0][0];
  if (!(a > b) || a - b > 0.5) return;
  const mid = (a + b) / 2, band = bandOf(mid);
  const d1 = asks.filter(([p]) => p <= a + 0.01 + 1e-9).reduce((s, [, sz]) => s + sz, 0);
  const du = asks.filter(([p]) => p <= a + 0.01 + 1e-9).reduce((s, [p, sz]) => s + p * sz, 0);
  for (const key of [band, 'all']) {
    acc[kind] ||= {}; acc[kind][key] ||= { hs: [], depth1c: [], depthUsd1c: [], topSize: [] };
    const o = acc[kind][key];
    o.hs.push((a - b) / 2); o.depth1c.push(d1); o.depthUsd1c.push(du); o.topSize.push(asks[0][1]);
  }
}
let nSnaps = 0;
// collector snapshots
for (const f of fs.readdirSync(path.join(DATA, 'live')).filter((x) => x.startsWith('snapshot_'))) {
  const s = JSON.parse(fs.readFileSync(path.join(DATA, 'live', f), 'utf8'));
  nSnaps++;
  for (const e of s.events) for (const m of e.markets) for (const t of m.tokens || []) if (t.book && !m.closed) add(e.kind, t.book.bids || [], t.book.asks || []);
}
// our polls (subsample every 3rd poll to limit autocorrelation weight)
const pdir = path.join(DATA, 'live_structure');
const polls = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter((x) => x.startsWith('poll_')).sort() : [];
polls.forEach((f, i) => {
  if (i % 3) return;
  const s = readGz(path.join(pdir, f));
  nSnaps++;
  for (const e of s.events) for (const m of e.markets) {
    if (m.closed) continue;
    if (e.kind.startsWith('updown') && e.windowStart && e.windowStart > s.fetchedTs) continue; // in-play windows only for Up/Down
    for (const tid of m.tokenIds) { const b = s.books[tid]; if (b) add(e.kind, b.bids, b.asks); }
  }
});
const out = { builtAt: new Date().toISOString(), nSnapshots: nSnaps, bands: BANDS.map((b, i) => `${i ? BANDS[i - 1] : 0}-${b} (folded min(p,1-p))`), byKind: {} };
for (const [kind, bands] of Object.entries(acc)) {
  out.byKind[kind] = {};
  for (const [band, o] of Object.entries(bands)) out.byKind[kind][band] = { n: o.hs.length, median: r4(med(o.hs)), p75: r4(q(o.hs, 0.75)), medDepthShares1c: r4(med(o.depth1c)), medDepthUsd1c: r4(med(o.depthUsd1c)), medTopSize: r4(med(o.topSize)) };
}
writeJSON(process.argv[2] || 'spread_model.json', out);
for (const [k, v] of Object.entries(out.byKind)) console.log(k.padEnd(14), Object.entries(v).map(([b, o]) => `${b}:${o.median}(${o.n}) $${Math.round(o.medDepthUsd1c)}`).join('  '));
