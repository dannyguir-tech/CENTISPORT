// Concentration / longshot / sizing attack on the candidates' OOS trades (from out/attack_LAG16_LAT5.json).
// Headline cost = mid + 1c + 0.07p(1-p) (verified v2 curve applied to every era).
//  - per-share edge with day-clustered CI (equal shares per trade instead of equal dollars)
//  - flat-stake ROI after dropping the best 1 / 3 OOS days
//  - ROI without cheap longshots (pRef < 0.25), where flat-$ staking turns a few wins into large returns
//  - share of total PnL from the top 5% of trades
import fs from 'node:fs';
import path from 'node:path';
import { mulberry32 } from '../../lib/util.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const A = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'attack_LAG16_LAT5.json'), 'utf8')).candidates;
const fee = (p) => 0.07 * p * (1 - p);
const cost = (t, hc = 0.01) => (t.mk ? t.pRef : t.ex != null ? Math.min(0.995, t.ex + 0.002) + fee(Math.min(0.995, t.ex + 0.002)) : Math.min(0.995, t.pRef + hc) + fee(Math.min(0.995, t.pRef + hc)));
const f4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
function dayBoot(tr, stat, B = 2000, seed = 99) {
  const days = [...new Set(tr.map((t) => t.day))].sort(); const by = new Map(days.map((d) => [d, []])); for (const t of tr) by.get(t.day).push(t);
  const rnd = mulberry32(seed); const v = [];
  for (let b = 0; b < B; b++) { const s = []; for (let k = 0; k < days.length; k++) s.push(...by.get(days[Math.floor(rnd() * days.length)])); if (s.length) v.push(stat(s)); }
  v.sort((a, b) => a - b); return [f4(v[Math.floor(0.025 * (v.length - 1))]), f4(v[Math.floor(0.975 * (v.length - 1))])];
}
const roi = (tr, hc) => tr.reduce((s, t) => s + t.win / cost(t, hc) - 1, 0) / (tr.length || 1);
const edge = (tr, hc) => tr.reduce((s, t) => s + t.win - cost(t, hc), 0) / (tr.length || 1);
const shareRoi = (tr, hc) => tr.reduce((s, t) => s + t.win - cost(t, hc), 0) / tr.reduce((s, t) => s + cost(t, hc), 0);
const out = {};
for (const [id, c] of Object.entries(A)) {
  const tr = c.trades; if (!tr.length) continue;
  const byDay = new Map(); for (const t of tr) byDay.set(t.day, (byDay.get(t.day) || 0) + t.win / cost(t) - 1);
  const best = [...byDay.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const drop = (k) => { const s = new Set(best.slice(0, k)); const r = tr.filter((t) => !s.has(t.day)); return f4(roi(r)); };
  const pn = tr.map((t) => t.win / cost(t) - 1).sort((a, b) => b - a); const tot = pn.reduce((s, x) => s + x, 0); const top = pn.slice(0, Math.max(1, Math.ceil(0.05 * pn.length))).reduce((s, x) => s + x, 0);
  const noLong = tr.filter((t) => t.pRef >= 0.25);
  out[id] = {
    n: tr.length, roi: f4(roi(tr)), edgePerShare: f4(edge(tr)), edgeCi: dayBoot(tr, (s) => edge(s)), shareWeightedRoi: f4(shareRoi(tr)), shareWeightedRoiCi: dayBoot(tr, (s) => shareRoi(s)),
    roiDropBest1Day: drop(1), roiDropBest3Days: drop(3), roiNoLongshots: f4(roi(noLong)), nNoLongshots: noLong.length, fracLongshot: f4(1 - noLong.length / tr.length),
    top5pctTradesShareOfPnl: tot > 0 ? f4(top / tot) : null,
  };
}
fs.writeFileSync(path.join(HERE, 'out', 'deep.json'), JSON.stringify(out, null, 1));
for (const [id, o] of Object.entries(out)) if (o.roi > 0) console.log(id.padEnd(24), JSON.stringify(o));
