#!/usr/bin/env node
// Post-hoc priceToBeat fill for the live polls. Gamma does not expose an in-play 5m/15m/4h window's Chainlink
// priceToBeat (eventMetadata appears only after the window ends), so the live scan cannot price the nested Chainlink
// relations in real time from gamma alone (a real trader would read the Chainlink stream directly). The books we
// recorded are real; the priceToBeat values were fixed at window start, before each snapshot. We fetch them afterwards.
// Only windows that were in play at some poll timestamp are fetched.
import fs from 'node:fs';
import path from 'node:path';
import { getJSON } from '../../lib/http.mjs';
import { DATA } from '../../lib/util.mjs';

const dir = path.join(DATA, 'live_structure');
const ts = fs.readdirSync(dir).filter((f) => f.startsWith('poll_')).map((f) => Number(/poll_(\d+)/.exec(f)[1])).sort((a, b) => a - b);
const out = {};
const f = path.join(dir, 'ptb.json');
if (fs.existsSync(f)) Object.assign(out, JSON.parse(fs.readFileSync(f, 'utf8')));
let fetched = 0;
for (const [len, pre] of [[300, 'btc-updown-5m-'], [900, 'btc-updown-15m-'], [14400, 'btc-updown-4h-']]) {
  const wins = [...new Set(ts.map((t) => Math.floor(t / len) * len))];
  for (const w of wins) {
    const slug = pre + w;
    if (out[slug] != null) continue;
    const a = await getJSON(`https://gamma-api.polymarket.com/events?slug=${slug}`, { cache: false });
    fetched++;
    const e = Array.isArray(a) && a[0];
    if (e && e.eventMetadata && e.eventMetadata.priceToBeat != null) out[slug] = e.eventMetadata.priceToBeat;
  }
}
fs.writeFileSync(f, JSON.stringify(out, null, 1));
console.log('fetched', fetched, '; ptb known for', Object.keys(out).length, 'windows', new Date(ts[0] * 1000).toISOString(), '..', new Date(ts[ts.length - 1] * 1000).toISOString());
