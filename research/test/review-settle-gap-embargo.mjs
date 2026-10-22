// REVIEW REPRO (look-ahead in parameter selection): the backtest's 24h embargo assumes every
// outcome is known within 24h of startTs, but collect/build accept any closedTime - gameStartTime
// gap (multi-day events: Test cricket, golf rounds, a stale gameStartTime) and the dataset row
// carries no settlement time, so such a market trains a fold whose decisions precede its result.
// SYNTHETIC values only. Run: node research/test/review-settle-gap-embargo.mjs
// Exit 1 = bug reproduced, 0 = fixed.
import { normalizeMarket } from '../collect.js';
import { buildMarketRows } from '../build-dataset.js';
import { DEFAULTS, assignFolds, prepareRow, walkForward } from '../backtest.js';

const HOUR = 3600;
const gs = Date.UTC(2025, 2, 1, 10, 0) / 1000;
const settle = gs + 5 * 24 * HOUR; // five-day match
const gamma = {
  conditionId: '0xlong', question: '[SYNTHETIC] India vs. Australia (Test)', slug: 'cricket-ind-aus-2025-03-01',
  outcomes: '["India","Australia"]', clobTokenIds: '["111","222"]', outcomePrices: '["1","0"]', closed: true,
  gameStartTime: new Date(gs * 1000).toISOString(), closedTime: new Date(settle * 1000).toISOString(),
};
const n = normalizeMarket(gamma, { slug: 'cricket-ind-aus-2025-03-01', title: '[SYNTHETIC] IND v AUS', tags: [{ slug: 'cricket' }] });
console.log(`collector: ${n.skip ? `skipped (${n.skip})` : `accepted, start->settle gap ${(settle - n.startTs) / 3600}h`}`);
if (n.skip) process.exit(0);

const pts = (p) => Array.from({ length: 40 }, (_, k) => ({ t: gs - 39 * HOUR + k * HOUR, p }));
const rows = buildMarketRows(n.record, n.startTs, { 111: pts(0.55), 222: pts(0.45) }, null, {});
const settleFields = Object.keys(rows[0]).filter((k) => /settle|closed|resolv|end/i.test(k));
console.log(`dataset row settlement field(s): ${settleFields.length ? settleFields.join(', ') : 'none'}`);

// Ten ordinary markets: the long one plus later games 2-4 days after it.
const all = rows.map(prepareRow);
for (let i = 1; i <= 9; i++) {
  const s = gs + (24 + i * 8) * HOUR;
  all.push(prepareRow({ ...rows[0], id: `m${i}|0|1`, conditionId: `m${i}`, eventKey: `e${i}`, startTs: s, decisionTs: s - HOUR }));
}
const folds = assignFolds(all, 2);
let leak = false;
walkForward({ id: 'x', offsets: [1, 3, 12, 24], paramGrid: [{}], select: () => true }, folds, { ...DEFAULTS, minN: 1 }, {
  onPhase: (phase, k) => {
    if (phase !== 'train') return;
    const cutoff = folds[k].decisionMin;
    const used = folds.slice(0, k).flatMap((f) => f.rows).filter((r) => r.f.conditionId === '0xlong' && r.f.startTs + DEFAULTS.embargoH * HOUR <= cutoff);
    if (used.length && settle > cutoff) {
      leak = true;
      console.log(`fold ${k}: trains on ${used.length} rows of 0xlong although it settles ${((settle - cutoff) / 3600).toFixed(0)}h after the fold's first decision`);
    }
  },
});
if (leak) {
  console.log('BUG REPRODUCED: the embargo is start-based, so an outcome not yet known at test time is used to choose parameters');
  process.exitCode = 1;
} else console.log('OK');
