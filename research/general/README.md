# General track: all non-sports Polymarket markets

This track runs the research kit (`research/README.md`: no-lookahead rules, cost model, walk-forward, cluster bootstrap, Benjamini-Hochberg, SURVIVES rule, MDE80, provenance) on every closed, cleanly resolved **non-sports** Yes/No market, except the recurring crypto "Up or Down" series, which are studied separately. It reuses `research/backtest.js` through `--hypotheses research/general/hypotheses.js` and `research/lib/*.js`. It brings its own collector, builder, hypotheses, synthetic generator and self-test.

**"No hypothesis survived" is a normal, acceptable answer.** The hypothesis list, the headline costs and the rules below were fixed before any real result was seen. Any other run is a labelled sensitivity analysis. A sensitivity run never declares survival.

## Files

| Path | What it does |
|---|---|
| `lib.js` | Shared rules: categories, exclusions, question flags, decision plan, price windows, fee formula, sampling order. |
| `collect.js` | Collector: event index, then events in a fixed random order, then Yes price histories and negRisk group files. Resumable. |
| `build-dataset.js` | Point-in-time builder. Writes `dataset.jsonl` and `dataset.summary.json` in the format `backtest.js` reads. |
| `hypotheses.js` | Pre-registered hypotheses, plus the `BACKTEST` settings that `backtest.js` picks up. |
| `synthetic.js` | SYNTHETIC generator. It runs the collector's own `processEvent` with a fake price source. |
| `selftest.js` | SYNTHETIC self-test with null and planted worlds. |
| `../test/general-*.test.js` | Unit and integration tests, including a local fake of the three endpoints. They run under `npm run research:test`. |

## Commands (full real run)

Every command that touches the network needs the proxy env in this cloud environment. A foreground command is killed at 10 minutes, so collect in 570-second chunks and re-run the same command. It resumes where it stopped.

```sh
# 0. Tooling (offline).
npm run research:test
node research/general/selftest.js              # SYNTHETIC; about 3-5 min; exit 0 = PASS

# 1. Collect. The first chunk builds the event index (about 1 min, 126 pages). Repeat the same
#    command until the JSON summary on the last stdout line shows "nothingLeft": true, or the
#    time budget is used. Watch "share429": above 0.01, halve --rps and --concurrency.
timeout 570 env NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt \
  node research/general/collect.js --data-dir research/data-general --balance category \
  --rps 14 --concurrency 14 --event-workers 10 --quiet
#    (optional) --index-from research/data-general-smoke reuses the smoke run's complete index.
#    --balance category (used for the first real run, chosen before any result): categories are
#    interleaved so every prefix holds about the same number of listed markets per category, uniform
#    random within each; without it a time-limited prefix is ~44% weather markets. The salt and
#    balance are stored in <data-dir>/sample.json and a resumed run with other values is refused.
#    --event-workers N processes N events at once (default min(4, ceil(concurrency / 3))); small
#    events (one or two markets) otherwise leave the rate limit unused.

# 2. Build. Check the drop reasons and "provenance: polymarket-api".
node research/general/build-dataset.js --data-dir research/data-general

# 3. Backtest. The headline costs are the defaults (--fee 0.01 --spread 0.01).
node --max-old-space-size=6144 research/backtest.js --hypotheses research/general/hypotheses.js \
  --data research/data-general/dataset.jsonl \
  --source-label "real: Polymarket gamma/clob non-sports, collected $(date -u +%F)" \
  --out research/reports --name general-$(date -u +%Y%m%d)
```

The report also re-costs the same out-of-sample picks at each market's actual taker fee schedule. That section is a sensitivity only; survival is judged at the headline costs.

A full sensitivity run with the actual fee schedules in training and out-of-sample alike (the flat `--fee` is then unused) adds `--cost-model actual-fees --name general-actualfees`. Such a report is marked "Sensitivity run, not a headline result" and declares no survivors; anything that would pass is labelled `passes all checks (sensitivity only)`.

**Size and time, measured on the smoke run.** One request per Yes token, plus one `/events` request per 10 events and one index page per 500 events. The smoke run took 287 requests for 30 events and 277 markets, in 37 s at 7.7 req/s, with no 429s. Price files average about 7 KB per token.

The universe holds 43,700 events with about 404k markets, counted before the market-level filters. Collecting all of it takes about 15 h at 8 req/s, or 7 h at 16 req/s. A 3-hour budget therefore yields a uniform random sample of about 9k to 15k events.

The builder reads about 4.6 rows per market. The backtest used 531 MB and 14 s for 271k rows.

The collector refuses `--rps` above 20 against the real hosts. The limit is global, so each host stays at or below it.

## Live API facts (probed 2026-10-22 with curl and the smoke run)

- **Discovery.** Gamma `/events/keyset?closed=true&order=id&ascending=false&limit=500&market_projection=status&exclude_tag_id=1&exclude_tag_id=102127` pages with `next_cursor`.
  - Each page is about 3.5 MB.
  - The status projection reduces markets to `{id, conditionId, closed, feeType}`, but keeps event `createdAt`, `startDate`, `endDate`, `closedTime`, `negRisk`, tags and series (with `recurrence`).
  - The full listing is 62,877 closed events, which yields 43,700 universe events. Client-side exclusions: 2,807 further sports or esports events (league or esports tags), 450 Up or Down, 4,289 closed before 2024, and 11,631 with a lifetime under 1 day.
  - `/events?id=..&id=..` returns full events in any order.
  - `/markets?exclude_tag_id=1` still returned an NBA game, so discovery goes through `/events`.
- **Tag ids.** sports 1, up-or-down 102127, politics 2, elections 144, geopolitics 100265, world 101970, crypto 21, economy 100328, finance 120, business 107, tech 1401, ai 439, pop-culture 596, science 74, weather 84.
- **Market fields.**
  - `endDate`, `startDate`, `createdAt`, `acceptingOrdersTimestamp` and `closedTime`. The last has the format `"YYYY-MM-DD HH:MM:SS+00"`.
  - `umaResolutionStatus` was `"resolved"` on all 277 smoke markets. `umaResolutionStatuses` is a history.
  - `outcomePrices` is a string such as `'["1", "0"]'`. `negRisk`, `negRiskMarketID` and `negRiskOther` are present, and inactive placeholders carry `active: false`.
  - `feeType`, `feesEnabled` and `feeSchedule {exponent, rate, takerOnly, rebateRate}`.
  - Older markets often set `endDate` to 12:00 UTC on the resolution day, while closing hours or days later. Example: a London temperature market had `endDate` 2025-03-17 and closed on 2025-03-28.
- **Fees.** Recent non-sports markets carry these taker schedules:

  | Fee type | Rate | Exponent |
  |---|---|---|
  | `politics_fees` | 0.04 | 1 |
  | `finance_prices_fees` | 0.04 | 1 |
  | `tech_fees` | 0.04 | 1 |
  | `weather_fees` | 0.05 | 1 |
  | `economics_fees` | 0.05 | 1 |
  | `culture_fees` | 0.05 | 1 |
  | `crypto_fees_v2` | 0.07 | 1 |
  | `crypto_fees` | 0.25 | 2 |

  176 of the 232 smoke markets had a schedule. The fee per share is price x rate x (price x (1 - price))^exponent. For `crypto_fees` (rate 0.25, exponent 2) it peaks at 1.56% of the price, at a price of 0.5.
- **Price history.** clob `/prices-history`:
  - `startTs`+`endTs` spans are limited to 15 days. 360 h works; 16 and 30 days get HTTP 400 "'startTs' and 'endTs' interval is too long" at fidelity 60, 720 and 1440 alike.
  - `startTs` alone returns the whole rest of the history. That was 1,870 hourly points for a 78-day market and 7,357 for 10 months of the 2024 election; even fidelity 1 returned 441k points.
  - `interval=max&fidelity=60` returned 0 points. Fidelity 1440 works.
  - Yes and No series are exact complements at identical timestamps, so only the Yes token is fetched.
  - Hourly points are stamped within the first 60 s of each hour (all 45,237 smoke points checked).

## Pre-registered design (as implemented)

- **Universe.** Closed, cleanly resolved Yes/No markets created on or after 2024-01-01.
  - Each negRisk member counts as a market.
  - Every category except sports and crypto Up or Down. Sports means a sports or esports tag, a league tag with no other category tag, or a sports fee type. Up or Down means the `up-or-down` tag, or "Up or Down" in the title, slug or series of a crypto event.
  - Events whose whole life is under 1 day are left out; none of their markets could have a decision row.
  - Events are processed in sha1(`general-v1`:eventId) order, so any prefix is a uniform random sample.
- **Categories.** Event tags map to politics, elections, geopolitics, crypto, economics-finance, tech-ai, culture-entertainment, science-weather or other. The first match wins, in that order. Explicit slugs are checked before slug regexes (`lib.js` `categoryOf`).
- **Anchor.** The anchor is the market `endDate`, the scheduled end.
  - If the market has none, the event `endDate` is used (`anchorSource: event.endDate`, counted in the summary).
  - With neither, the market is dropped (`no_end_date`).
  - An `endDate` more than 30 days before or after `closedTime` is **kept** and counted (`anchorVsClose`). Dropping it would condition on information from after the decision; for example, a deadline market that resolved Yes early has its `endDate` long after its close. For such markets the row rule simply removes decisions after the close.
- **Decisions.** `offsetH` 24, 72, 168, 336 and 720 are the anchor minus 1, 3, 7, 14 and 30 days. `offsetH` -24 is listing + 1 day; listing is `acceptingOrdersTimestamp`, else `startDate`, else `createdAt`. A row exists only if all of these hold:
  - listing <= decisionTs < closedTime;
  - the early decision is before the anchor;
  - the last Yes point at or before decisionTs is at most 12 h old (24 h for offsets of 7 days or more);
  - the Yes price is in [0.01, 0.99].
  - closedTime is used only to ask "was the market still open?". Resolution status, lifetime volume and fee metadata are never features.
- **Labels.** `won` comes from the final `outcomePrices`, which must have exactly one "1". Voided 50-50, ambiguous and non-final (`umaResolutionStatus` not `resolved`) markets are skipped. `settleTs` is closedTime. `eventKey` is the event id, so all members of a negRisk event form one cluster.
- **Features.** All are taken as of the row's own price point T:
  - price and Yes price;
  - prices 1 day and 7 days earlier, with the row's staleness limit, and their momentum;
  - days to anchor and days since listing;
  - category;
  - flags `isDeadline` ("by/before <date>", "by..."), `isWin` and `isThreshold` (above/below/over/under/reach followed by a number);
  - negRisk `groupSize`, `groupYesSum` and `groupTop`.
- **negRisk group features.** Every active member of the negRisk group counts once listed. A member already closed by T counts at its resolution, which was public at T; one that resolved Yes is the group's top.
  - An open member needs a last quote at or before min(decisionTs, T + 120 s) that is at most 30 min older than T. Otherwise the sum is null.
  - The 120 s absorbs clob's per-token stamp jitter: points from different tokens land up to about 60 s apart within the same hourly print.
  - Nothing after the decision is ever used. The test injects a point 1 s after each decision and checks that no feature changes.
- **Walk-forward.** These settings come from `BACKTEST` in `hypotheses.js`:
  - Events are ordered into folds by their earliest decision.
  - Training rows must have **settled** (closedTime) at least `--embargo-h` (24 h) before the test fold's first decision at the hypothesis's own offsets.
  - The walk-forward chooses only the offset; there is no parameter grid.
  - Candidates 1-8 use the anchor offsets, `early-listing-fade` only listing + 1 d, and `baseline-all` all offsets.
- **Hypotheses.** These ids are fixed:
  - `longshot-fade`: buy No when Yes is in [0.02, 0.15].
  - `longshot-fade-wide`: buy No when Yes is in [0.15, 0.35].
  - `deadline-no`: on deadline markets, buy No when Yes is in [0.05, 0.50].
  - `near-certain`: buy the side priced in [0.90, 0.98].
  - `negrisk-overround-no`: when the synchronized sum is >= 1.03, buy No on members with Yes in [0.05, 0.40].
  - `negrisk-underround-yes`: when the sum is <= 0.97, buy Yes on the group's top member.
  - `momentum-follow-7d` and `momentum-fade-7d`: a 7-day move of at least 0.10 on the side.
  - `early-listing-fade`: at listing + 1 d, buy No when Yes is in [0.10, 0.40].
  - Controls: `longshot-buy` and `baseline-all`.
  - Per-category variants of `longshot-fade`, `deadline-no` and `near-certain` are added for categories with at least 300 markets.
- **Costs.** The headline uses the kit model with `--fee 0.01 --spread 0.01`, and the 0.02 stress spread must also be positive. Fee metadata (`feeRate`, `feeExponent`, `feeType`) is stripped from rows before `select()` and used only for the actual-fee re-costing. The report also says how many markets carry taker fees.
- **p-value floor for skewed bets** (`BACKTEST.lossFloor`, fixed before any real run).
  - The bootstrap p is also floored at an exact, outcome-blind test. One representative bet per event is picked by row-id hash. The floor is P(no more losing representatives than observed) if every bet won exactly as often as its cost implies (Poisson-binomial). See `backtest.js` `losingEventsFloor`.
  - Why it exists: in the first synthetic null world, two per-category variants with 62 bets on 40 events that all won "survived" with a degenerate bootstrap (CI +4.0% to +6.4%).
  - The floor is opt-in in `backtest.js`; the sports defaults are unchanged.
- **Provenance.** `collect-runs.jsonl` follows the kit convention: `started` and `completed`/`interrupted`/`failed` lines carry the API bases. The generator writes a `synthetic` line, so reports are stamped `polymarket-api` or `synthetic` by `research/build-dataset.js` `readProvenance`.

## Self-test (SYNTHETIC)

`node research/general/selftest.js` uses `--events 10000 --seeds 1,2,3 --worlds null,planted` by default. It runs the builder and backtest as child processes and re-prices every out-of-sample bet at the generator's true probabilities.

**Worlds.**

- **Null world.** Prices are exact martingales: deadline hazards with an unknown rate (early Yes closes), Brownian thresholds, and Bayesian "who wins" posteriors for negRisk groups and binaries.
  - Some negRisk fields have hidden outcomes, so calibrated sums fall below 1.
  - Members get a small logit bounce. A larger one is not null, because given the group sum a member's bounce becomes partly predictable.
  - There is also stamp jitter, gaps, dirty markets, and sports and Up-or-Down events to exclude.
- **Planted world.** Displayed Yes longshots in about 0.02-0.15 win 5 pp less often than priced.

**Checks.**

- The collector rules drop the dirty markets.
- Event-endDate fallbacks and late closes are kept.
- Every row obeys the rules and matches the truth (anchor, settle, open, listing, staleness, labels).
- Question flags work, and synchronized sums exist.
- `baseline-all` loses.
- In the null world, no tested rule has positive true ROI, which would mean look-ahead, and nothing survives.
- In the planted world, `longshot-fade` survives every seed, `longshot-buy` and `baseline-all` never survive, and at most q of the survivors have true ROI <= 0.
- `negrisk-overround-no` cannot be exercised in a null world, since anything that lifts a calibrated group above 1 makes some No cheap. The planted world exercises it.

**Last run (2026-10-23, default options: 10,000 events per world, 3 seeds, jobs 2, 211 s): PASS.**

- Null worlds: 0 survivors in 99 tests; the highest true out-of-sample ROI was -2.0%.
- Planted worlds: longshot-fade survived 3/3, with ROI +3.4%, +2.6% and +3.4% against a true +3.2% (p 5e-4, BH q <= 0.006).
- 0 of 47 planted-world survivors had true ROI <= 0.

## Known limitations

- **endDate edits.** gamma `endDate` is the final value. If a market's end was edited after creation (for example, a postponed event), its decision times use the later value. Deadline questions usually fix the date in the text.
- **Not executable quotes.** Price points are clob's hourly samples, not executable quotes. Early negRisk sums are often far from 1: a weather group summed to 1.57 at listing + 1 d. The overround and underround rules fill at those prices, and spread and depth are only approximated.
- **Fee schedules.** They are recorded as of collection, not decision time. Fees were introduced over 2025-2026, so the actual-fee sensitivity treats a market as fee-paying for its whole life.
- **Weather dominance.** The universe is dominated by recurring markets: science-weather is 38% of events, and about 11 members each by count. The per-category variants and the event-level clustering account for that; the pooled hypotheses do not.
- **Regex-based classification.** Categories and question flags are tag and regex based. "other" holds only 144 universe events.
