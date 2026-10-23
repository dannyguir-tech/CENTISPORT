#!/usr/bin/env node
// Maker-legged coherence arbitrage, simulated on recorded live books + the real taker tape.
//
// Rule (decision at poll time T, using only the book snapshot at T):
//   For every risk-free relation instance (same families as live_scan, excluding the oracle-basis nest_basis_*),
//   pick the leg i that, if bought with a resting BID instead of at the ask, gives the largest planned margin
//       m = minPay - b_i - sum_{j != i} (ask_j + 0.07 ask_j (1 - ask_j))
//   where b_i = bestBid_i + tick ('improve', we are first in the queue) or bestBid_i ('join', queue ahead = size at
//   bestBid_i). If m > theta: rest a bid for Q = min(QMAX, min_j bestAskSize_j) shares for at most H seconds.
//   At every later poll T' the order is cancelled if the basket would no longer be profitable at that poll's asks
//   (minPay - b_i - hedge cost < 0). One live order per relation instance at a time.
// Fill model (pessimistic-ish, uses the REAL taker tape from data-api /trades, takerOnly):
//   our bid on token X at b is hit by a taker SELL of X at price <= b, or a taker BUY of the complement at >= 1-b
//   (CTF mint matching). With 'join' the first `queue` shares of such flow go to the orders ahead of us.
//   Only trades strictly after T and before cancel/expiry count.
// Hedge: each fill is hedged by BUYING every other leg at the asks of the first recorded poll at or after the fill
//   time (0-20 s latency), walking depth (top 8 levels) and paying the taker fee per level; shares that cannot be
//   hedged are dumped at the maker leg's best bid minus the taker fee in that poll.
// P&L per hedged share-set = minPay - b - hedgeCost (minPay is the guaranteed payoff, a lower bound).
// Variant grid: placement {improve, join} x theta {0, 0.005, 0.01} x H {60, 300}; optional maker rebate
//   (20% of the taker fee at b, paid pro-rata in reality -> optimistic) reported as a separate column.
// Walk-forward: parameters chosen on polling session 0 (2026-10-22 morning), evaluated OOS on session 1 (evening).
// Uncertainty: cluster bootstrap by event (all data are from a single UTC day, so a day bootstrap is impossible).
//
// Usage: BTC_RPS=4 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node maker_sim.mjs
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, pool, stats } from '../../lib/http.mjs';
import { mulberry32 } from '../../lib/util.mjs';
import { REPORT, r4, writeCSV, writeJSON, bh } from './common.mjs';
import { listSnapshots, loadSnapshot, loadPtbFill, relations, fee } from './live_lib.mjs';

const QMAX = 100, LEVELS = 8;
const PLACEMENTS = ['improve', 'join'], THETAS = [0, 0.005, 0.01], HS = [60, 300];
const PTB_FILL = loadPtbFill();
const stubs = listSnapshots({ collector: false, polls: true });
const sessions = [...new Set(stubs.map((s) => s.session))];
const sessEnd = new Map(sessions.map((k) => [k, Math.max(...stubs.filter((s) => s.session === k).map((s) => s.fetchedTs))]));
const sessStart = new Map(sessions.map((k) => [k, Math.min(...stubs.filter((s) => s.session === k).map((s) => s.fetchedTs))]));
console.log('polls', stubs.length, 'sessions', sessions.map((k) => `${k}: ${new Date(sessStart.get(k) * 1000).toISOString()}..${new Date(sessEnd.get(k) * 1000).toISOString()}`).join(' | '));

// ------------------------------------------------------------------ pass 1: books store + order lifecycle
const pack = (lv) => { const a = new Float64Array(LEVELS * 2); for (let i = 0; i < Math.min(LEVELS, (lv || []).length); i++) { a[2 * i] = lv[i][0]; a[2 * i + 1] = lv[i][1]; } return a; };
const pollTs = []; const pollSess = [];
const asksStore = []; // per poll: Map(token -> packed asks)
const bidStore = [];  // per poll: Map(token -> best bid)
const orders = [];
const active = new Map(); // variantKey|relId -> order
const variants = [];
for (const pl of PLACEMENTS) for (const th of THETAS) for (const H of HS) variants.push({ pl, th, H, key: `${pl}|${th}|${H}` });

for (let pi = 0; pi < stubs.length; pi++) {
  const s = loadSnapshot(stubs[pi]);
  const T = s.fetchedTs;
  pollTs.push(T); pollSess.push(s.session);
  const am = new Map(), bm = new Map();
  for (const [tok, b] of Object.entries(s.books)) { am.set(tok, pack(b.asks)); bm.set(tok, b.bids && b.bids[0] ? b.bids[0][0] : null); }
  asksStore.push(am); bidStore.push(bm);
  const rels = relations(s, PTB_FILL).filter((r) => !r.family.startsWith('nest_basis'));
  const bestAsk = (tok) => { const b = s.books[tok]; return b && b.asks && b.asks.length ? b.asks[0] : null; };
  for (const r of rels) {
    const asks = r.legs.map((l) => bestAsk(l.token));
    // cancel / expire checks for live orders of this relation
    for (const v of variants) {
      const k = v.key + '|' + r.id, o = active.get(k);
      if (!o) continue;
      if (T >= o.expiry) { o.end = o.expiry; o.endReason = 'expired'; active.delete(k); continue; }
      const hedgeNow = asks.every((a, j) => j === o.leg || a) ? asks.reduce((acc, a, j) => (j === o.leg ? acc : acc + a[0] + fee(a[0])), 0) : Infinity;
      if (r.minPay - o.b - hedgeNow < 0) { o.end = T; o.endReason = 'cancelled'; active.delete(k); }
    }
    // candidate maker legs
    let best = null;
    for (let i = 0; i < r.legs.length; i++) {
      const bk = s.books[r.legs[i].token];
      if (!bk || !bk.bids || !bk.bids.length) continue;
      if (asks.some((a, j) => j !== i && !a)) continue;
      const hedge = asks.reduce((acc, a, j) => (j === i ? acc : acc + a[0] + fee(a[0])), 0);
      const tick = bk.tick || 0.01;
      const bb = bk.bids[0][0], ba = bk.asks && bk.asks.length ? bk.asks[0][0] : 1;
      for (const pl of PLACEMENTS) {
        let b, queue;
        if (pl === 'improve') { b = Math.round((bb + tick) * 1e6) / 1e6; if (b >= ba - 1e-9) { b = bb; queue = bk.bids[0][1]; } else queue = 0; }
        else { b = bb; queue = bk.bids[0][1]; }
        const m = r.minPay - b - hedge;
        const Q = Math.min(QMAX, ...asks.filter((a, j) => j !== i).map((a) => a[1]));
        const c = { i, pl, b, queue, m, Q, tick, hedge };
        if (!best || !best[pl] || m > best[pl].m) (best ||= {})[pl] = c;
      }
    }
    if (!best) continue;
    for (const v of variants) {
      const c = best[v.pl]; if (!c || !(c.m > v.th)) continue;
      const k = v.key + '|' + r.id;
      if (active.has(k)) continue;
      if (T + v.H > sessEnd.get(s.session)) continue; // need recorded books after any fill for the hedge
      const L = r.legs[c.i];
      const o = { variant: v.key, pl: v.pl, theta: v.th, H: v.H, family: r.family, id: r.id, event: r.event || r.id, session: s.session, T, expiry: T + v.H, end: null, endReason: null,
        leg: c.i, token: L.token, comp: L.comp, cid: L.cid, b: c.b, queue: c.queue, Q: c.Q, plannedMargin: r4(c.m), minPay: r.minPay, hedgeTokens: r.legs.filter((_, j) => j !== c.i).map((l) => l.token), nLegs: r.legs.length };
      active.set(k, o); orders.push(o);
    }
  }
  if (pi % 50 === 0) console.log('poll', pi, new Date(T * 1000).toISOString(), 'orders so far', orders.length);
}
for (const o of active.values()) { o.end = Math.min(o.expiry, sessEnd.get(o.session)); o.endReason = 'session_end'; }
console.log('orders', orders.length, 'by family', JSON.stringify(orders.reduce((m, o) => { m[o.family] = (m[o.family] || 0) + 1; return m; }, {})));

// ------------------------------------------------------------------ pass 2: tape
const BLOCK = 600;
const nowS = Math.floor(Date.now() / 1000);
const blockCache = new Map();
async function fetchBlock(cid, B) {
  const key = cid + '|' + B;
  if (blockCache.has(key)) return blockCache.get(key);
  const p = (async () => {
    const out = [];
    for (let off = 0; off <= 5000; off += 500) {
      const page = await getJSON(`https://data-api.polymarket.com/trades?market=${cid}&start=${B}&end=${B + BLOCK - 1}&limit=500&offset=${off}`, { allowStatus: [400, 404], cache: B + BLOCK < nowS - 180 });
      if (!Array.isArray(page)) break;
      for (const x of page) out.push({ t: x.timestamp, side: x.side, asset: String(x.asset), p: Number(x.price), s: Number(x.size) });
      if (page.length < 500) break;
    }
    return out;
  })();
  blockCache.set(key, p);
  return p;
}
const needed = new Map();
for (const o of orders) for (let B = Math.floor(o.T / BLOCK) * BLOCK; B <= o.end; B += BLOCK) needed.set(o.cid + '|' + B, [o.cid, B]);
console.log('tape blocks needed', needed.size);
await pool([...needed.values()], 4, ([cid, B]) => fetchBlock(cid, B));
console.log('tape fetched; requests', stats.requests, 'cacheHits', stats.cacheHits, 'failures', stats.failures);

// ------------------------------------------------------------------ pass 3: fills + hedge
function firstPollAtOrAfter(t, sess) { let lo = 0, hi = pollTs.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (pollTs[m] >= t) { ans = m; hi = m - 1; } else lo = m + 1; } return ans >= 0 && pollSess[ans] === sess ? ans : -1; }
function walkPacked(a, q, used) { // used: shares already consumed at this poll from this book (cumulative)
  let skip = used, left = q, cost = 0;
  for (let i = 0; i < LEVELS && left > 1e-9; i++) { const p = a[2 * i], s = a[2 * i + 1]; if (!s) break; let avail = s; if (skip > 0) { const d = Math.min(skip, avail); skip -= d; avail -= d; } if (avail <= 0) continue; const take = Math.min(avail, left); cost += take * (p + fee(p)); left -= take; }
  return { filled: q - left, cost };
}
const consumed = new Map(); // variant|pollIdx|token -> shares (hedges of the same variant compete for the same book)
const results = [];
for (const o of orders) {
  const tape = (await Promise.all([...Array(Math.floor(o.end / BLOCK) - Math.floor(o.T / BLOCK) + 1).keys()].map((k) => fetchBlock(o.cid, (Math.floor(o.T / BLOCK) + k) * BLOCK)))).flat()
    .filter((x) => x.t > o.T && x.t <= o.end).sort((a, b) => a.t - b.t);
  let queue = o.queue, filled = 0;
  const fills = [];
  for (const x of tape) {
    const hits = (x.asset === String(o.token) && x.side === 'SELL' && x.p <= o.b + 1e-9) || (x.asset === String(o.comp) && x.side === 'BUY' && x.p >= 1 - o.b - 1e-9);
    if (!hits) continue;
    let sz = x.s;
    if (queue > 0) { const d = Math.min(queue, sz); queue -= d; sz -= d; }
    if (sz <= 0) continue;
    const q = Math.min(sz, o.Q - filled);
    if (q <= 0) break;
    fills.push({ t: x.t, q }); filled += q;
    if (filled >= o.Q - 1e-9) break;
  }
  let pnl = 0, capital = 0, hedged = 0, unhedged = 0, rebate = 0, hedgeLat = [];
  for (const f of fills) {
    const pi = firstPollAtOrAfter(f.t, o.session);
    if (pi < 0) { unhedged += f.q; capital += f.q * o.b; pnl += -f.q * o.b * 0.0; continue; }
    hedgeLat.push(pollTs[pi] - f.t);
    let qh = f.q, cost = 0;
    const parts = [];
    for (const tok of o.hedgeTokens) {
      const a = asksStore[pi].get(String(tok));
      const key = o.variant + '|' + pi + '|' + tok;
      const used = consumed.get(key) || 0;
      const w = a ? walkPacked(a, f.q, used) : { filled: 0, cost: 0 };
      parts.push({ tok, key, w, used });
      qh = Math.min(qh, w.filled);
    }
    // hedge qh share-sets on every leg (pro-rata cost of the walk), dump the rest of the maker fill at the bid
    for (const pt of parts) { const unit = pt.w.filled > 0 ? pt.w.cost / pt.w.filled : 0; cost += unit * qh; consumed.set(pt.key, pt.used + qh); }
    const setCost = qh * o.b + cost;
    pnl += qh * o.minPay - setCost; capital += setCost; hedged += qh;
    const rest = f.q - qh;
    if (rest > 1e-9) {
      const bid = bidStore[pi].get(String(o.token));
      const exitP = bid != null ? bid : 0;
      pnl += rest * (exitP - fee(exitP) - o.b); capital += rest * o.b; unhedged += rest;
    }
    rebate += f.q * 0.2 * fee(o.b);
  }
  results.push({ ...o, hedgeTokens: undefined, nTape: tape.length, filled: r4(filled), fillRate: r4(filled / o.Q), hedged: r4(hedged), unhedged: r4(unhedged), pnl: r4(pnl), capital: r4(capital), rebate: r4(rebate), pnlPerSet: hedged > 0 ? r4(pnl / (hedged + unhedged)) : null, medHedgeLatSec: hedgeLat.length ? hedgeLat.sort((a, b) => a - b)[hedgeLat.length >> 1] : null });
}

// ------------------------------------------------------------------ stats
function clusterBoot(rows, key = 'event', B = 2000, seed = 11) {
  const g = new Map(); for (const r of rows) { const k = r[key]; if (!g.has(k)) g.set(k, { p: 0, c: 0 }); const o = g.get(k); o.p += r.pnl; o.c += r.capital; }
  const cl = [...g.values()]; const P = cl.reduce((a, x) => a + x.p, 0), C = cl.reduce((a, x) => a + x.c, 0);
  if (cl.length < 2 || C <= 0) return { roi: C > 0 ? P / C : null, ci: [null, null], p: null, clusters: cl.length };
  const rng = mulberry32(seed); const rs = []; let le0 = 0;
  for (let b = 0; b < B; b++) { let p = 0, c = 0; for (let i = 0; i < cl.length; i++) { const x = cl[Math.floor(rng() * cl.length)]; p += x.p; c += x.c; } const r = c > 0 ? p / c : 0; rs.push(r); if (r <= 0) le0++; }
  rs.sort((a, b) => a - b);
  return { roi: P / C, ci: [rs[Math.floor(0.025 * B)], rs[Math.floor(0.975 * B)]], p: (le0 + 1) / (B + 1), clusters: cl.length };
}
function agg(rows, hours, withRebate = false) {
  const f = rows.filter((r) => r.filled > 0);
  const rr = withRebate ? f.map((r) => ({ ...r, pnl: r.pnl + r.rebate })) : f;
  const bs = clusterBoot(rr);
  const P = rr.reduce((a, r) => a + r.pnl, 0);
  return { orders: rows.length, filledOrders: f.length, fillRateOrders: rows.length ? r4(f.length / rows.length) : null, sharesFilled: r4(f.reduce((a, r) => a + r.filled, 0)), unhedgedShares: r4(f.reduce((a, r) => a + r.unhedged, 0)),
    winRate: f.length ? r4(rr.filter((r) => r.pnl > 0).length / f.length) : null, avgCostPerSet: f.length ? r4(f.reduce((a, r) => a + r.capital, 0) / Math.max(1e-9, f.reduce((a, r) => a + r.filled, 0))) : null,
    pnlUsd: r4(P), capitalUsd: r4(rr.reduce((a, r) => a + r.capital, 0)), roi: bs.roi == null ? null : r4(bs.roi), ci: bs.ci.map((x) => (x == null ? null : r4(x))), p: bs.p, clusters: bs.clusters, usdPerDay: hours > 0 ? r4(P / hours * 24) : null };
}
const hoursOf = (sess) => (sessEnd.get(sess) - sessStart.get(sess)) / 3600;
const out = { generatedAt: new Date().toISOString(), sessions: sessions.map((k) => ({ session: k, from: new Date(sessStart.get(k) * 1000).toISOString(), to: new Date(sessEnd.get(k) * 1000).toISOString(), hours: r4(hoursOf(k)) })), grid: [], walkForward: null };
const fams = [...new Set(results.map((r) => r.family))];
for (const v of variants) for (const sess of sessions) {
  const rows = results.filter((r) => r.variant === v.key && r.session === sess);
  out.grid.push({ variant: v.key, placement: v.pl, theta: v.th, H: v.H, session: sess, family: 'ALL', ...agg(rows, hoursOf(sess)), withRebate: agg(rows, hoursOf(sess), true) });
  for (const f of fams) { const fr = rows.filter((r) => r.family === f); if (fr.length) out.grid.push({ variant: v.key, placement: v.pl, theta: v.th, H: v.H, session: sess, family: f, ...agg(fr, hoursOf(sess)), withRebate: agg(fr, hoursOf(sess), true) }); }
}
// walk-forward: choose the variant with the highest pooled session-0 P&L (ties -> more filled orders), test on later sessions
if (sessions.length >= 2) {
  const s0 = sessions[0];
  const cand = out.grid.filter((g) => g.session === s0 && g.family === 'ALL').sort((a, b) => (b.pnlUsd - a.pnlUsd) || (b.filledOrders - a.filledOrders));
  const pick = cand[0];
  const oosSess = sessions.slice(1);
  const oosRows = results.filter((r) => r.variant === pick.variant && oosSess.includes(r.session));
  const hrs = oosSess.reduce((a, k) => a + hoursOf(k), 0);
  out.walkForward = { chosenOn: s0, chosen: pick.variant, inSample: { pnlUsd: pick.pnlUsd, filledOrders: pick.filledOrders, roi: pick.roi }, oosSessions: oosSess, oos: agg(oosRows, hrs), oosWithRebate: agg(oosRows, hrs, true),
    oosByFamily: Object.fromEntries(fams.map((f) => [f, agg(oosRows.filter((r) => r.family === f), hrs)]).filter(([, a]) => a.orders > 0)) };
}
// BH across grid rows with p
const ps = out.grid.map((g) => (g.p != null && g.filledOrders >= 5 ? g.p : NaN));
const sig = bh(ps, 0.1); out.grid.forEach((g, i) => { g.bh = sig[i]; });
out.variantsTested = out.grid.length;
fs.mkdirSync(path.join(REPORT, 'maker'), { recursive: true });
writeJSON('maker/maker_sim.json', out);
writeCSV('maker/maker_orders.csv', results.map((r) => ({ ...r, hedgeTokens: undefined })));
writeCSV('maker/maker_grid.csv', out.grid.map((g) => ({ ...g, ci: `[${g.ci.join(';')}]`, withRebate: `pnl ${g.withRebate.pnlUsd} roi ${g.withRebate.roi}` })));
for (const g of out.grid.filter((g) => g.family === 'ALL')) console.log(g.variant.padEnd(16), 'sess', g.session, 'orders', String(g.orders).padEnd(5), 'filled', String(g.filledOrders).padEnd(4), 'shares', String(g.sharesFilled).padEnd(8), 'unhedged', String(g.unhedgedShares).padEnd(7), 'pnl$', String(g.pnlUsd).padEnd(8), 'roi', g.roi, 'ci', JSON.stringify(g.ci), '$/day', g.usdPerDay, '| +rebate pnl$', g.withRebate.pnlUsd);
console.log('walk-forward', JSON.stringify(out.walkForward, null, 1));
console.log('requests', stats.requests, 'failures', stats.failures);
