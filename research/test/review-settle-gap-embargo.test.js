// Review DI-5 (permanent): no label look-ahead in parameter selection for slow-settling markets.
// The walk-forward embargo assumed every outcome is known within 24h of startTs, but collect/build
// accept any closedTime - gameStartTime gap (multi-day events such as Test cricket, golf, a stale
// gameStartTime) and dataset rows carried no settlement time. Rows now carry a label-only settleTs
// (parsed closedTime) and a training row must also have settled by the test fold's first decision.
// SYNTHETIC values only. Run: node --test research/test/review-settle-gap-embargo.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarket } from '../collect.js';
import { buildMarketRows } from '../build-dataset.js';
import { DEFAULTS, LABEL_FIELDS, assignFolds, prepareRow, walkForward } from '../backtest.js';

const HOUR = 3600;
const gs = Date.UTC(2025, 2, 1, 10, 0) / 1000;
const settle = gs + 5 * 24 * HOUR; // five-day match

function longMarketRows() {
  const gamma = {
    conditionId: '0xlong', question: '[SYNTHETIC] India vs. Australia (Test)', slug: 'cricket-ind-aus-2025-03-01',
    outcomes: '["India","Australia"]', clobTokenIds: '["111","222"]', outcomePrices: '["1","0"]', closed: true,
    gameStartTime: new Date(gs * 1000).toISOString(), closedTime: new Date(settle * 1000).toISOString(),
  };
  const n = normalizeMarket(gamma, { slug: 'cricket-ind-aus-2025-03-01', title: '[SYNTHETIC] IND v AUS', tags: [{ slug: 'cricket' }] });
  assert.equal(n.skip, undefined, 'the collector accepts a multi-day event');
  const pts = (p) => Array.from({ length: 40 }, (_, k) => ({ t: gs - 39 * HOUR + k * HOUR, p }));
  return buildMarketRows(n.record, n.startTs, { 111: pts(0.55), 222: pts(0.45) }, null, {});
}

test('dataset rows carry settleTs, and it is a label the hypotheses never see', () => {
  const rows = longMarketRows();
  assert.ok(rows.length >= 8);
  for (const r of rows) assert.equal(r.settleTs, settle);
  assert.ok(LABEL_FIELDS.includes('settleTs'));
  const p = prepareRow(rows[0]);
  assert.ok(!('settleTs' in p.f));
  assert.equal(p.settleTs, settle);
});

// The long match (fold 0), markets starting a day later (fold 1, before it settled) and markets
// after it settled (fold 2). Returns the conditionIds each fold's parameter search saw.
function trainedOn({ dropSettle = false } = {}) {
  const long = longMarketRows();
  const all = long.map((r) => prepareRow(dropSettle ? { ...r, settleTs: null } : r));
  const later = (prefix, startAt, n) => {
    for (let i = 1; i <= n; i++) {
      const s = startAt + i * 8 * HOUR;
      all.push(prepareRow({ ...long[0], id: `${prefix}${i}|0|1`, conditionId: `${prefix}${i}`, eventKey: `${prefix}e${i}`, startTs: s, decisionTs: s - HOUR, settleTs: s + 3 * HOUR }));
    }
  };
  later('mid', gs + 24 * HOUR, long.length);
  later('late', settle + 48 * HOUR, long.length);
  const folds = assignFolds(all, 3);
  assert.ok(folds[0].rows.every((r) => r.f.conditionId === '0xlong'), 'fixture: fold 0 is the long match');
  assert.ok(folds[1].decisionMin < settle && folds[2].decisionMin > settle, 'fixture: fold 1 starts before settlement, fold 2 after');
  assert.ok(gs + DEFAULTS.embargoH * HOUR <= folds[1].decisionMin, 'fixture: the start-based embargo alone would allow it in fold 1');
  let phase = null, k = -1;
  const seen = { 1: new Set(), 2: new Set() };
  const spy = { id: 'spy', offsets: [1, 3, 12, 24], paramGrid: [{}], select: (f) => { if (phase === 'train') seen[k].add(f.conditionId); return true; } };
  walkForward(spy, folds, { ...DEFAULTS, minN: 1 }, { onPhase: (ph, fold) => { phase = ph; k = fold; } });
  return seen;
}

test('walk-forward trains on a market only once it has settled', () => {
  const seen = trainedOn();
  assert.ok(!seen[1].has('0xlong'), 'fold 1 chose parameters with an outcome not yet known');
  assert.ok(seen[2].has('0xlong'), 'fold 2 may use it: it had settled');
});

test('rows without a settlement time fall back to the start-based embargo', () => {
  const seen = trainedOn({ dropSettle: true });
  assert.ok(seen[1].has('0xlong'), 'with no closedTime only the start-based embargo applies');
});
