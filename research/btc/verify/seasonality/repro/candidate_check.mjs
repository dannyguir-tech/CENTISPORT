// Stability breakdown of the strongest taker lead: 4h Up/Down, weekend, buy the favourite at 50% of the window.
// (Walk-forward selected WKND:F in all 6 folds, never a weekday cell, so the OOS trade set equals this fixed rule.)
// Point estimates + day-clustered SE only; these slices are diagnostics of one variant, not new hypotheses.
import fs from 'node:fs';
import { buildObs, candidates } from './features.mjs';
import { costOf, COST_MODELS, clusterTest, makeFolds, fmt, mean } from './lib.mjs';
import { repriceWithFills } from './diag.mjs';
const tf = '4h';
const obs = buildObs(tf);
const days = [...new Set(obs.map((o) => o.day))].sort();
const { oosStart, folds } = makeFolds(days);
const rows = [];
for (const o of obs) {
  if (o.weekend !== 'WKND' || o.day < oosStart) continue;
  const cs = candidates(o, 'FAV50'); if (!cs) continue; const c = cs.F;
  const cost = costOf(c.q, o.fee, COST_MODELS.headline, tf, 'FAV50');
  const fold = folds.find((f) => f.days.has(o.day))?.k;
  rows.push({ day: o.day, fold, hour: o.hour, dow: o.dow, feeType: o.fee?.feeType || 'none', q: c.q, won: c.won, tok: c.tok, t: c.t, fee: o.fee, conditionId: o.conditionId, roi: (c.won ? 1 : 0) / cost - 1, edge: (c.won ? 1 : 0) - cost, g: (c.won ? 1 : 0) - c.q, vol: o.volume });
}
const summ = (rs) => { const t = clusterTest(rs.map((r) => ({ day: r.day, y: r.roi }))); const f = repriceWithFills(rs, tf, 'FAV50'); return { n: rs.length, days: t.days, win: fmt(mean(rs.map((r) => (r.won ? 1 : 0))), 3), avgPrice: fmt(mean(rs.map((r) => r.q)), 3), gross: fmt(mean(rs.map((r) => r.g))), edge: fmt(mean(rs.map((r) => r.edge))), roi: fmt(t.mean), roiSE: fmt(t.se), fillN: f.n, fillRoi: f.roiFill }; };
const out = { all: summ(rows) };
const by = (key, fn) => { const m = {}; for (const r of rows) (m[fn(r)] ||= []).push(r); out[key] = Object.fromEntries(Object.entries(m).sort().map(([k, v]) => [k, summ(v)])); };
by('fold', (r) => 'fold' + r.fold);
by('feeEra', (r) => r.feeType);
by('dow', (r) => ({ 0: 'Sun', 6: 'Sat', 5: 'Fri', 1: 'Mon' }[r.dow] || r.dow));
by('startHourUTC', (r) => 'h' + String(r.hour).padStart(2, '0'));
by('favPrice', (r) => (r.q < 0.65 ? '0.55-0.65' : r.q < 0.75 ? '0.65-0.75' : r.q < 0.85 ? '0.75-0.85' : '0.85-0.95'));
by('volume', (r) => (r.vol < 10000 ? '<10k' : r.vol < 25000 ? '10-25k' : '>=25k'));
fs.writeFileSync('/home/user/CENTISPORT/research/btc/verify/seasonality/repro/out/candidate_4h_weekend_fav50.json', JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) { if (k === 'all') { console.log('ALL', JSON.stringify(v)); continue; } console.log(k); for (const [c, s] of Object.entries(v)) console.log('  ', c.padEnd(12), JSON.stringify(s)); }
