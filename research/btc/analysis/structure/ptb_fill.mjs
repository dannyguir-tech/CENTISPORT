#!/usr/bin/env node
// Post-hoc priceToBeat fill for the live polls. Gamma does not expose an in-play 5m/15m window's Chainlink
// priceToBeat (eventMetadata appears only after the window ends), so the live scan cannot price the nested Chainlink
// relations in real time from gamma alone (a real trader would read the Chainlink stream directly). The books we
// recorded are real; the priceToBeat values were fixed at window start, before each snapshot. We fetch them afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { getJSON } from '../../lib/http.mjs';
import { DATA } from '../../lib/util.mjs';
import { readGz } from './common.mjs';

const dir = path.join(DATA, 'live_structure');
const polls = fs.readdirSync(dir).filter((f) => f.startsWith('poll_')).sort();
const ts = polls.map((f) => Number(/poll_(\d+)/.exec(f)[1]));
const lo = Math.min(...ts), hi = Math.max(...ts);
const out = {};
const f = path.join(dir, 'ptb.json');
if (fs.existsSync(f)) Object.assign(out, JSON.parse(fs.readFileSync(f, 'utf8')));
for (const [tf, len, pre] of [['5m', 300, 'btc-updown-5m-'], ['15m', 900, 'btc-updown-15m-'], ['4h', 14400, 'btc-updown-4h-']]) {
  for (let w = Math.floor((lo - len) / len) * len; w <= hi; w += len) {
    const slug = pre + w;
    if (out[slug] != null) continue;
    const a = await getJSON(`https://gamma-api.polymarket.com/events?slug=${slug}`, { cache: false });
    const e = Array.isArray(a) && a[0];
    if (e && e.eventMetadata && e.eventMetadata.priceToBeat != null) out[slug] = e.eventMetadata.priceToBeat;
  }
}
fs.writeFileSync(f, JSON.stringify(out, null, 1));
console.log('ptb filled for', Object.keys(out).length, 'windows', new Date(lo * 1000).toISOString(), '..', new Date(hi * 1000).toISOString());
