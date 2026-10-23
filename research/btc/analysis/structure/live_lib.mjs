// Shared live-book helpers for the structure analysis (used by live_scan.mjs and maker_sim.mjs).
// Relation definitions are identical to hist_relations.mjs (same payoff bounds), but priced on real CLOB books.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../../lib/util.mjs';
import { readGz, r4 } from './common.mjs';

export const fee = (p) => 0.07 * p * (1 - p);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function hitCoverage(kind, slug, endTs) {
  if (kind === 'hit_daily') return [endTs - 86400, endTs];
  if (kind === 'hit_weekly') return [endTs - 7 * 86400, endTs];
  const m = /in-([a-z]+)-(\d{4})/.exec(slug);
  if (m) { const mi = MONTHS.indexOf(m[1]); const y = Number(m[2]); const days = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate(); return [endTs - days * 86400, endTs]; }
  return null;
}

// ------------------------------------------------------------------ snapshots
function fromCollector(s) {
  const books = {};
  const events = s.events.map((e) => ({ ...e, markets: e.markets.filter((m) => !m.closed || e.kind.startsWith('updown')).map((m) => {
    for (const t of m.tokens || []) if (t.book) books[t.tokenId] = { bids: t.book.bids || [], asks: t.book.asks || [], tick: t.book.tickSize ? Number(t.book.tickSize) : null };
    return { conditionId: m.conditionId, outcomes: m.outcomes, tokenIds: m.tokenIds, strike: m.strike, closed: m.closed, title: m.title };
  }) }));
  return { fetchedTs: s.booksFetchedTs || s.fetchedTs, events, books, recentClosed: null, source: 'collector' };
}
export const PTB_FILL_FILE = path.join(DATA, 'live_structure', 'ptb.json');
export function loadPtbFill() { return fs.existsSync(PTB_FILL_FILE) ? JSON.parse(fs.readFileSync(PTB_FILL_FILE, 'utf8')) : {}; }

/** Session label: consecutive snapshots less than 30 min apart form one session. */
export function sessionize(snaps) {
  snaps.sort((a, b) => a.fetchedTs - b.fetchedTs);
  let sid = 0;
  for (let i = 0; i < snaps.length; i++) { if (i && snaps[i].fetchedTs - snaps[i - 1].fetchedTs > 1800) sid++; snaps[i].session = sid; }
  return snaps;
}
/** Load collector snapshots + poll snapshots (lazily decoded if lazy=true: returns {fetchedTs,file,source} stubs). */
export function listSnapshots({ collector = true, polls = true } = {}) {
  const out = [];
  if (collector) for (const f of fs.readdirSync(path.join(DATA, 'live')).filter((x) => x.startsWith('snapshot_')).sort()) {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, 'live', f), 'utf8'));
    out.push({ fetchedTs: s.booksFetchedTs || s.fetchedTs, file: path.join(DATA, 'live', f), source: 'collector' });
  }
  const pdir = path.join(DATA, 'live_structure');
  if (polls) for (const f of (fs.existsSync(pdir) ? fs.readdirSync(pdir) : []).filter((x) => x.startsWith('poll_')).sort()) out.push({ fetchedTs: Number(/poll_(\d+)/.exec(f)[1]), file: path.join(pdir, f), source: 'poll' });
  return sessionize(out);
}
export function loadSnapshot(stub) {
  const s = stub.source === 'collector' ? fromCollector(JSON.parse(fs.readFileSync(stub.file, 'utf8'))) : readGz(stub.file);
  s.source = stub.source; s.session = stub.session;
  return s;
}

// ------------------------------------------------------------------ basket economics on books
/** Buy every leg at the asks (taker), fee per fill level; returns best-level cost, margin and max-profit size walking depth. */
export function basket(legs, books, minPay) {
  const L = legs.map((l) => (books[l.token] && books[l.token].asks ? books[l.token].asks : []));
  if (L.some((a) => !a.length)) return null;
  const best = L.reduce((s, a) => s + a[0][0] + fee(a[0][0]), 0);
  // maker-legged (naive): rest a bid on one leg AT its best bid (no fee), take the others. Assumes a fill; see maker_sim.mjs.
  let makerCost = Infinity, makerLeg = null;
  for (let i = 0; i < legs.length; i++) {
    const bb = books[legs[i].token] && books[legs[i].token].bids && books[legs[i].token].bids[0];
    if (!bb) continue;
    const c = bb[0] + L.reduce((s, a, j) => (j === i ? s : s + a[0][0] + fee(a[0][0])), 0);
    if (c < makerCost) { makerCost = c; makerLeg = i; }
  }
  const res = { bestCost: r4(best), margin: r4(minPay - best), makerMargin: Number.isFinite(makerCost) ? r4(minPay - makerCost) : null, makerLeg, shares: 0, profit: 0, usd: 0 };
  if (minPay - best <= 0) return res;
  const idx = L.map(() => 0), rem = L.map((a) => a[0][1]);
  for (let guard = 0; guard < 500; guard++) {
    const marg = L.reduce((s, a, i) => s + a[idx[i]][0] + fee(a[idx[i]][0]), 0);
    if (marg >= minPay) break;
    const q = Math.min(...rem);
    res.shares += q; res.profit += q * (minPay - marg); res.usd += q * marg;
    let end = false;
    for (let i = 0; i < L.length; i++) { rem[i] -= q; if (rem[i] <= 1e-9) { idx[i]++; if (idx[i] >= L[i].length) end = true; else rem[i] = L[i][idx[i]][1]; } }
    if (end) break;
  }
  res.shares = r4(res.shares); res.profit = r4(res.profit); res.usd = r4(res.usd);
  return res;
}

/** Walk an ask book for q shares: returns {filled, cost (incl. fee)} without mutating the book. */
export function walkAsks(asks, q) {
  let left = q, cost = 0;
  for (const [p, s] of asks || []) { if (left <= 1e-9) break; const take = Math.min(left, s); cost += take * (p + fee(p)); left -= take; }
  return { filled: q - left, cost };
}

// ------------------------------------------------------------------ relation builders on a snapshot
// Each relation: {family, id, legs:[{token, cid, comp}], minPay, meta}. Tokens: outcomes[0] = Yes / Up.
export function relations(s, PTB_FILL = {}) {
  const T = s.fetchedTs;
  const ev = (k) => s.events.filter((e) => e.kind === k);
  const rels = [];
  const leg = (m, side) => ({ token: side === 'Y' ? m.tokenIds[0] : m.tokenIds[1], comp: side === 'Y' ? m.tokenIds[1] : m.tokenIds[0], cid: m.conditionId, side });
  const add = (family, id, legs, minPay, extra = {}) => rels.push({ family, id, legs, minPay, ...extra });
  const above = (e) => e.markets.filter((m) => m.strike && m.strike.type === 'above').sort((a, b) => a.strike.k - b.strike.k);
  // within-market complement (sanity: unified CLOB should make Yes ask + No ask >= 1)
  for (const e of s.events) for (const m of e.markets) {
    if (!m.tokenIds || m.tokenIds.length !== 2 || m.closed) continue;
    if (e.kind.startsWith('updown') && !(e.windowStart && e.windowStart <= T && T < e.endTs)) continue;
    add('complement_sum', `${e.slug}|${m.conditionId.slice(0, 10)}`, [leg(m, 'Y'), leg(m, 'N')], 1, { event: e.slug });
  }
  // ladders monotone
  for (const [k, fam] of [['above_daily', 'above_daily_mono'], ['above_hourly', 'above_hourly_mono']]) for (const e of ev(k)) {
    const ms = above(e);
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) add(fam, `${e.slug}|${ms[i].strike.k}<${ms[j].strike.k}`, [leg(ms[i], 'Y'), leg(ms[j], 'N')], 1, { event: e.slug });
  }
  for (const k of ['hit_daily', 'hit_weekly', 'hit_monthly']) for (const e of ev(k)) {
    const up = e.markets.filter((m) => m.strike && m.strike.type === 'hit_up').sort((a, b) => a.strike.k - b.strike.k);
    const dn = e.markets.filter((m) => m.strike && m.strike.type === 'hit_down').sort((a, b) => b.strike.k - a.strike.k);
    for (const ms of [up, dn]) for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) add(`${k}_mono`, `${e.slug}|${ms[i].strike.type}${ms[i].strike.k}/${ms[j].strike.k}`, [leg(ms[i], 'Y'), leg(ms[j], 'N')], 1, { event: e.slug });
  }
  // buckets
  const rangeBuckets = (e) => {
    const bs = e.markets.filter((m) => m.strike && ['below', 'between', 'above_bucket'].includes(m.strike.type)).map((m) => ({ m, lo: m.strike.type === 'below' ? -Infinity : m.strike.lo, hi: m.strike.type === 'above_bucket' ? Infinity : m.strike.hi })).sort((a, b) => a.lo - b.lo);
    if (bs.length < 3 || bs[0].lo !== -Infinity || bs[bs.length - 1].hi !== Infinity) return null;
    for (let i = 1; i < bs.length; i++) if (bs[i].lo !== bs[i - 1].hi) return null;
    return bs;
  };
  for (const e of ev('range_daily')) {
    const bs = rangeBuckets(e); if (!bs) continue;
    add('range_allyes', e.slug, bs.map((b) => leg(b.m, 'Y')), 1, { event: e.slug });
    add('range_allno', e.slug, bs.map((b) => leg(b.m, 'N')), bs.length - 1, { event: e.slug });
    const a = ev('above_daily').find((x) => x.endTs === e.endTs);
    if (a) for (const am of above(a)) {
      const K = am.strike.k; const lo = bs.filter((b) => b.hi <= K), hi = bs.filter((b) => b.lo >= K);
      if (lo.length + hi.length !== bs.length) continue;
      add('above_vs_range', `${a.slug}|lo|${K}`, [leg(am, 'Y'), ...lo.map((b) => leg(b.m, 'Y'))], 1, { event: a.slug });
      add('above_vs_range', `${a.slug}|hi|${K}`, [leg(am, 'N'), ...hi.map((b) => leg(b.m, 'Y'))], 1, { event: a.slug });
    }
  }
  // hit vs above, hit nesting
  const hits = ['hit_daily', 'hit_weekly', 'hit_monthly'].flatMap((k) => ev(k).map((e) => ({ e, k, cov: hitCoverage(k, e.slug, e.endTs) }))).filter((x) => x.cov);
  for (const a of ev('above_daily')) {
    const noon = a.endTs, ks = above(a);
    for (const { e: h, k, cov } of hits) {
      if (!(cov[0] <= noon - 3600 && noon <= cov[1])) continue;
      for (const m of h.markets) {
        if (!m.strike) continue;
        if (m.strike.type === 'hit_up') { const am = ks.find((x) => x.strike.k >= m.strike.k); if (am) add(`hit_vs_above_${k.slice(4)}`, `${h.slug}|up${m.strike.k}|${a.slug}|${am.strike.k}`, [leg(m, 'Y'), leg(am, 'N')], 1, { event: h.slug }); }
        if (m.strike.type === 'hit_down') { const am = [...ks].reverse().find((x) => x.strike.k <= m.strike.k); if (am) add(`hit_vs_above_${k.slice(4)}`, `${h.slug}|dn${m.strike.k}|${a.slug}|${am.strike.k}`, [leg(m, 'Y'), leg(am, 'Y')], 1, { event: h.slug }); }
      }
    }
  }
  for (const o of hits) for (const i of hits) {
    if (o === i) continue;
    const fam = o.k === 'hit_weekly' && i.k === 'hit_daily' ? 'hit_nest_wd' : o.k === 'hit_monthly' && i.k === 'hit_daily' ? 'hit_nest_md' : o.k === 'hit_monthly' && i.k === 'hit_weekly' ? 'hit_nest_mw' : null;
    if (!fam || !(o.cov[0] <= i.cov[0] + 3600 && i.cov[1] <= o.cov[1] + 3600)) continue;
    for (const om of o.e.markets) {
      if (!om.strike) continue;
      let im = null;
      if (om.strike.type === 'hit_up') im = i.e.markets.filter((x) => x.strike && x.strike.type === 'hit_up' && x.strike.k >= om.strike.k).sort((a, b) => a.strike.k - b.strike.k)[0];
      if (om.strike.type === 'hit_down') im = i.e.markets.filter((x) => x.strike && x.strike.type === 'hit_down' && x.strike.k <= om.strike.k).sort((a, b) => b.strike.k - a.strike.k)[0];
      if (im) add(fam, `${o.e.slug}|${om.strike.type}${om.strike.k}|${i.e.slug}|${im.strike.k}`, [leg(om, 'Y'), leg(im, 'N')], 1, { event: o.e.slug });
    }
  }
  // Up/Down in play
  const inplay = (k) => ev(k).filter((e) => e.windowStart && e.windowStart <= T && T < e.endTs);
  const closedFinal = new Map();
  if (s.recentClosed) for (const arr of Object.values(s.recentClosed)) for (const c of arr) if (c.eventMetadata && c.eventMetadata.finalPrice != null) closedFinal.set(c.endTs, c.eventMetadata.finalPrice);
  const ptbOf = (e) => (e.eventMetadata && e.eventMetadata.priceToBeat != null ? e.eventMetadata.priceToBeat : (PTB_FILL[e.slug] ?? closedFinal.get(e.windowStart) ?? null));
  for (const [udK, ladK, fam] of [['updown_1d', 'above_daily', 'daily_ud_vs_above'], ['updown_1h', 'above_hourly', 'hourly_ud_vs_above_hourly']]) for (const u of inplay(udK)) {
    const ptb = ptbOf(u); if (ptb == null) continue;
    const a = ev(ladK).find((x) => x.endTs === u.endTs); if (!a) continue;
    const ks = above(a), um = u.markets[0];
    const hi = ks.find((m) => m.strike.k > ptb), lo = [...ks].reverse().find((m) => m.strike.k < ptb);
    if (hi) add(fam, `${u.slug}|UP+NO>${hi.strike.k}`, [leg(um, 'Y'), leg(hi, 'N')], 1, { ptb, event: u.slug });
    if (lo) add(fam, `${u.slug}|DOWN+YES>${lo.strike.k}`, [leg(um, 'N'), leg(lo, 'Y')], 1, { ptb, event: u.slug });
  }
  for (const [oK, iK, fam] of [['updown_15m', 'updown_5m', 'nest_cl_15m_5m'], ['updown_4h', 'updown_15m', 'nest_cl_4h_15m'], ['updown_4h', 'updown_5m', 'nest_cl_4h_5m'], ['updown_1h', 'updown_15m', 'nest_basis_1h_15m'], ['updown_1h', 'updown_5m', 'nest_basis_1h_5m']]) {
    for (const o of inplay(oK)) {
      const i = inplay(iK).find((x) => x.endTs === o.endTs && x.windowStart > o.windowStart); if (!i) continue;
      const po = ptbOf(o), pi = ptbOf(i); if (po == null || pi == null) continue;
      const om = o.markets[0], im = i.markets[0];
      const legs = pi >= po ? [leg(om, 'Y'), leg(im, 'N')] : [leg(om, 'N'), leg(im, 'Y')];
      add(fam, `${o.slug}|${i.slug}|d=${(pi - po).toFixed(2)}`, legs, 1, { d: pi - po, event: o.slug, riskFree: fam.startsWith('nest_cl') });
    }
  }
  return rels;
}
