// REVIEW REPRO (winner determination): resolveWinner maps outcomePrices with Number(), which turns
// "", " ", null and false into 0 and true into 1, so a malformed or partly missing price array is
// accepted as a clean resolution instead of being skipped as ambiguous.
// Run: node research/test/review-resolve-winner-coercion.mjs   Exit 1 = bug reproduced, 0 = fixed.
import { resolveWinner } from '../collect.js';

const cases = [['["1",""]', 2], ['["1"," "]', 2], [[1, null], 2], [[true, false], 2], ['["", "1"]', 2]];
let bug = false;
for (const [prices, n] of cases) {
  const r = resolveWinner(prices, n);
  console.log(`${JSON.stringify(prices)} -> ${JSON.stringify(r)}`);
  if (r.winnerIndex != null) bug = true;
}
if (bug) {
  console.log('BUG REPRODUCED: non-numeric outcomePrices entries are coerced to 0/1 and yield a winner');
  process.exitCode = 1;
} else console.log('OK: malformed price arrays are skipped');
