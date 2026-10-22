# Polymarket sports edge research kit

This kit checks, honestly, whether a repeatable betting edge exists in Polymarket sports markets. It has three stages:

1. **collect** (`collect.js`) downloads settled sports markets, their price history around game start and, optionally, their trades.
2. **build** (`build-dataset.js`) turns them into a point-in-time dataset. Every feature uses only data available at the decision time.
3. **backtest** (`backtest.js`) tests a fixed library of candidate edges (`hypotheses.js`). It uses a walk-forward backtest, out-of-sample only, after costs, with cluster-bootstrap uncertainty and Benjamini-Hochberg control for testing many hypotheses at once.

**"No hypothesis survived" is a normal, expected result.** The kit is built to say that when it is true. It does not search until something looks good.

> **Synthetic results validate the tooling only.** The self-test, the unit tests and the local mock server all use generated data. None of their numbers say anything about real Polymarket markets. The kit was built in a sandbox that cannot reach Polymarket, so **nothing in this repository is real-market evidence yet**. Real evidence starts only when you run the commands under [Running against real Polymarket](#running-against-real-polymarket).

Requirements: Node 22. No npm packages are needed; the kit uses only Node built-ins.

## Layout

| Path | What it is |
|---|---|
| `collect.js` | Collector (gamma for discovery, clob for prices-history, data-api for trades). Can resume. |
| `build-dataset.js` | Builds `dataset.jsonl` plus `dataset.summary.json` (drop reasons, provenance). |
| `backtest.js` | Walk-forward backtest. Writes `reports/<name>.md` and `reports/<name>.json`. |
| `hypotheses.js` | The hypothesis library, fixed in advance. |
| `selftest.js` | Synthetic end-to-end self-test: planted edges must be found, and calibrated data must yield nothing. |
| `lib/http.js` | Fetch with retries and backoff, concurrency and rate limits, and a disk cache. |
| `lib/market-type.js` | Market and side classifier, ported from `vendor/pm-sports-dashboard.user.js`. |
| `lib/stats.js` | Seeded PRNG, cluster bootstrap, BH-FDR, Wilson intervals, normal functions. |
| `lib/synthetic.js` | Generator for synthetic worlds with known ground truth (used by the self-test). |
| `test/*.test.js` | Unit and integration tests. `test/mock-server.js` is a local fake of the three APIs. |
| `data/` | Default data directory. Git-ignored. |
| `reports/` | Default report directory. Git-ignored. |

## Quick start (offline, synthetic)

```sh
npm run research:test         # 59 unit/integration tests, ~10 s
npm run research:selftest     # synthetic end-to-end self-test, ~5-6 min, exit 0 = PASS
```

To run the whole pipeline against the local mock API, in a second terminal:

```sh
npm run research:mock -- --port 8787 --events 120 --no-faults   # prints the three exports below
export GAMMA_BASE=http://127.0.0.1:8787/gamma CLOB_BASE=http://127.0.0.1:8787/clob DATA_BASE=http://127.0.0.1:8787/data
npm run research:collect -- --data-dir /tmp/mock-data --trades --rps 200 --concurrency 8 --since 2025-01-01
npm run research:build -- --data-dir /tmp/mock-data
npm run research:backtest -- --data /tmp/mock-data/dataset.jsonl --source-label "SYNTHETIC mock API" --out /tmp/mock-reports
```

Every number this produces is synthetic. The mock prefixes every question and title with `[SYNTHETIC]`, the collector records the non-default API bases, and the report is stamped SYNTHETIC even if the label claims otherwise (see [Provenance](#provenance)).

## Running against real Polymarket

The collector needs HTTPS access to three hosts:

- `gamma-api.polymarket.com` (market and event discovery)
- `clob.polymarket.com` (`/prices-history`)
- `data-api.polymarket.com` (`/trades`, only with `--trades`)

**In this Claude Code cloud environment:** open the cloud environment menu in the session's title bar, choose Edit, and under Network access add the three hosts to Allowed domains (or choose a broader access level). Leave "Allow package managers" ticked. Steps: https://code.claude.com/docs/en/cloud-environments#network-access. Then start a new session in that environment.

**On your own machine:** clone the repo and make sure `node --version` is 22 or later. `npm install` is not needed for the kit. Leave `GAMMA_BASE`, `CLOB_BASE` and `DATA_BASE` unset so the real defaults are used.

Then run, from the repo root:

```sh
# 0. Check the tooling first (offline).
npm run research:test
npm run research:selftest

# 1. Smoke test: about 50 markets, a few minutes. Read the JSON summary on the last line:
#    "kept" should be > 0, "synthetic" should be null, and "skipped" shows why markets were dropped.
npm run research:collect -- --max-markets 50 --since 2025-09-01

# 2. Full collection. It resumes: re-running the same command continues where it stopped,
#    and --max-markets is a TOTAL for markets.jsonl, so raise it to collect more.
npm run research:collect -- --trades --since 2024-01-01 --max-markets 20000

# 3. Build the point-in-time dataset. Check the drop reasons and "provenance: polymarket-api".
npm run research:build

# 4. Backtest. Say exactly what the data is; the label is printed in every report.
npm run research:backtest -- --source-label "real: Polymarket gamma/clob/data-api, collected $(date -u +%F)"
```

The report lands in `research/reports/backtest-<UTC timestamp>.md` (with a matching `.json`).

**If discovery finds nothing.** The gamma filter parameters could not be checked from the sandbox, so the collector fails loudly with hints instead of returning an empty dataset. Strategies to try, in order:

```sh
npm run research:collect -- --tag nba,nfl,mlb,nhl,soccer,tennis --max-markets 50   # per-league tag slugs
npm run research:collect -- --tag 745 --max-markets 50                                # numeric tag id (sent as tag_id)
npm run research:collect -- --strategy events-series --series 10345 --max-markets 50  # gamma series ids
npm run research:collect -- --strategy markets --tag 745 --max-markets 50             # /markets listing
npm run research:collect -- --strategy event-slugs --event-slugs slugs.txt            # one slug or polymarket.com/event/... URL per line
```

The tag and series ids shown here are examples taken from the mock fixture. Look up the real ids on gamma before relying on them. See `node research/collect.js --help` for every flag (rate limits, fidelity, window, retries, cache).

**After a real run, confirm:**

- `research/data/collect-runs.jsonl` has `"synthetic":null` and the polymarket.com bases.
- `research/data/dataset.summary.json` shows `"provenance": {"status": "polymarket-api", ...}`.
- The report's provenance line says `polymarket-api`.

Do not mix mock and real collections in one data directory. One mock run marks the whole directory synthetic. Use `--data-dir` to keep them apart.

### Runtime and size

These figures are estimates from the request pattern and the mock data. They have not been measured against the live API.

| Stage | Expectation |
|---|---|
| Requests per market | about 2 to 3 without trades (one prices-history call per token, plus an `interval=max` retry when a window is empty). If clob rejects the 80 h window at 15-minute fidelity, the collector learns the accepted span and splits windows, which can mean about 8 per market. `--trades` adds 1 to 30 pages of 500 trades each. |
| Collection time | At the default `--rps 4`, 3,000 markets take roughly 20 to 40 minutes without trades and 1 to 3 hours with them. 20,000 markets take several hours, so run it in the background; it resumes. Raise `--rps` only if the API tolerates it (429s are retried and pause every worker). |
| Disk | Prices are about 8 KB per token (about 16 KB per market). Trades are about 150 B per trade, capped at `--max-trades-per-market 3000` (at most about 450 KB per market; most markets are far smaller). 20,000 markets is roughly 0.3 GB of prices plus up to a few GB of trades. `dataset.jsonl` is about 0.7 KB per row and 8 rows per binary market. |
| Build | Streams markets one at a time. About 2 s for 1,700 markets with trades, so roughly 10 to 15 s per 10k markets. |
| Backtest | Holds the dataset in memory. About 24 s for 320k rows at `--boot 2000`. |
| Self-test | About 5 to 6 minutes at the defaults (3 seeds x 2 worlds x about 27k markets). |

**Statistical power matters more than speed.** The report's `MDE80` column is the smallest true ROI that each hypothesis's out-of-sample sample could detect with 80% power. As a rule of thumb, each bet's P&L has a standard deviation of about 0.5 to 1, so MDE80 is about 2.8 / sqrt(bets). That works out to about 9% at 1,000 bets and about 3% at 10,000. Within-event correlation and the multiple-testing correction push it higher. A few thousand markets can therefore only reveal large edges. Edges of 2 to 5% need tens of thousands of markets. The self-test detects planted 3 to 6% edges only at about 2,500 events (about 27,000 markets) per world. When nothing survives, read the MDE80 column before concluding "no edge": the absence of evidence at MDE80 = 12% says nothing about a 3% edge.

## No-lookahead rules

These rules are enforced in code and covered by tests (`test/build-dataset.test.js` injects data one second after each decision and checks that no feature changes).

- **Game start** is `gameStartTime` (taken from `market.gameStartTime`, `market.eventStartTime` or `event.startTime`). Failing that, `eventStartDate` is used only when it has a time of day and settlement follows within 24 h. A gap larger than that suggests a listing date. Otherwise the market is dropped. **endDate and closedTime are never used as the start**: they are settlement times and would put decisions in-game. A market that closed at or before its start is dropped (`closed_before_start`).
- **Decision times** are `startTs - offset` for offsets 1, 3, 12 and 24 h (`--offsets`).
- **Every feature** (price, price_m6h/m24h, momentum, complement price, overround, and all trade-flow features) uses only points and trades with `t <= decisionTs`. Trade features use the window (decisionTs - 24 h, decisionTs]. A row is dropped if its last price point is older than `--max-price-age-h` (default 6 h).
- **Labels** (`won`, `closePrice` = last point at or before start, `clv` = closePrice - price) are written to the dataset but stripped before any hypothesis sees a row. Hypotheses receive a frozen copy without them. **Lifetime `volume`** includes trading after the decision, so it is never a feature. The builder never reads it and the backtester strips it too.
- **Walk-forward**: folds are time-ordered and built from whole events. Parameters for fold k are chosen only on folds before k, and only on training rows whose game started at least `--embargo-h` (24 h) before fold k's first decision, so their outcomes were already known. Fold 0 is training-only. Only out-of-sample bets are reported.

## Cost model and statistics

- **Entry cost per share** = `min(0.999, (price + spread) x (1 + fee))`, with defaults spread 0.01 and fee 0.01. Rows with cost >= 0.99 are skipped. The stake is a flat $1: P&L = `1/cost - 1` if the outcome won, `-1` otherwise.
- **Sensitivity**: the same out-of-sample picks are re-costed at spreads 0, 0.01 and 0.02.
- **Parameter choice**: in each fold, the grid point x offset with the best training ROI among those with n >= `--min-n` (50). Each candidate trades a single offset, so one outcome is never bet several times.
- **Uncertainty**: a cluster bootstrap over `eventKey` (markets in one event are correlated), B = 2000. It gives 95% CIs for OOS ROI, edge captured (win rate - average cost) and mean CLV, plus a one-sided p-value for ROI > 0.
- **Multiple testing**: Benjamini-Hochberg at q = 0.10 across every hypothesis tested in the run, including per-sport variants. Variants exist for sports with >= 300 markets, for a base list fixed in advance (favorite-longshot, under-totals, momentum-follow-6h, momentum-fade-6h, cheap-favorite). They are not chosen after seeing results, which would leak.
- **SURVIVES** only if all of these hold: OOS n >= min-n, BH-significant, the 95% CI lower bound of ROI is > 0, and ROI is still > 0 at a 0.02 spread. Everything else is reported with a label (`no edge`, `no edge (positive but not reliable)`, `too few bets`, `skipped`).
- **Trade-based hypotheses** (large-flow-*, wallet-surge) are skipped automatically when trades were not collected. Rows with null features never match.

## How to read the report

`reports/<name>.md` contains:

1. **Header and provenance.** The header carries `--source-label`, then the provenance check: `polymarket-api`, `synthetic` or `unknown`. A synthetic or unknown dataset carries a banner saying it is not real-market evidence.
2. **Verdict.** It either lists the survivors or says "No hypothesis survived". The **sanity line** compares `baseline-all` (buy everything) with the cost hurdle. Buying everything must lose about the cost drag. If it is profitable, suspect leakage or bad labels before reading anything else.
3. **Setup.** The data period, rows, markets, events, sports, trade coverage, costs and folds.
4. **Results table (out-of-sample only).** Columns:
   - Bets (events)
   - ROI with its 95% CI
   - p
   - BH-adjusted q
   - CLV: the closing price minus the entry price. Positive means the market later moved toward the bet. It is a less noisy check than ROI.
   - Hurdle: the ROI the same bets would earn if prices were perfectly calibrated, i.e. the cost drag.
   - MDE80
   - ROI at each spread
   - Verdict

   Controls (`longshot-buy`, `over-control`) are mirror images of candidates. A control that survives points to a data problem.
5. **Survivors.** For each survivor: per-fold parameter choices, training n and ROI, test ROI, edge captured and CLV. A survivor whose CLV is negative gets a warning, because the market did not move its way.
6. **Calibration.** Per market type at the closest offset: price bucket, n, average price, win rate, Wilson CI and gap. This table is in-sample and descriptive, not a test.
7. **Warnings and caveats.** These include small samples, hypotheses that never reached min-n, a narrowed BH family (`--only`) and provenance problems.

The JSON report has the same content plus all offsets' calibration tables and every fold's details.

A survivor is **a candidate for forward paper-trading at real order-book fills, not proof of an edge.** Price-history points are not executable quotes, order-book depth and slippage are not modelled, and fees vary by market.

## Provenance

`collect.js` appends one line per run to `<data-dir>/collect-runs.jsonl`, including the API bases it used. `lib/synthetic.js` writes a line to the same file. `build-dataset.js` turns that file, plus any `[SYNTHETIC]` question or title prefixes, into `dataset.summary.json -> provenance.status`:

- `synthetic`: any mock or generator run, or any `[SYNTHETIC]` market. The report is stamped SYNTHETIC even if `--source-label` says "real".
- `polymarket-api`: only collector runs against the default Polymarket bases.
- `unknown`: no provenance file. The report says PROVENANCE UNVERIFIED.

## Self-test (synthetic)

`npm run research:selftest` builds two paired worlds per seed. It runs build-dataset and backtest on each as child processes, then replays every hypothesis's out-of-sample bets at the generator's true probabilities.

- **Null world.** Prices are calibrated martingales, so after costs no rule has positive true ROI. No hypothesis may survive, and the generator's own check confirms that no rule has positive true ROI.
- **Planted world.** It hides four edges:
  - favorite-longshot: longshots priced 0.05 to 0.25 win 5 pp less often than priced;
  - under-totals and under-props: unders win 5 pp more often than priced;
  - large-flow-follow: an informed wallet buys the winner 68% of the time without moving the price.

  All four must survive every seed. Their mirror images must not. Survivors whose true ROI is <= 0 must make up at most q of all survivors.
- It also checks that the dataset has all five market types, that game starts match the truth on every row, that markets with broken start times are dropped, that the classifier matches the generator, and that the audit reproduces the backtest's bet counts.

Options: `--events 2500 --seeds 1,2,3 --jobs 2 --boot 2000 --fdr 0.10 --keep --json FILE`. Fewer than about 2,000 events per world lack the power for the planted checks; the script says so. Exit code 0 = PASS, 1 = FAIL, 2 = tooling error.

## Known limitations

- **The live API is unverified.** It was not reachable from where this was built. The gamma filter parameters (`tag_slug`, `tag_id`, `series_id`, `end_date_min/max`, `order`), the clob range and fidelity limits, and the data-api paging caps are inferred from the userscript and are not confirmed. The collector adapts to page caps and "interval too long" errors, and stops with hints when discovery returns nothing. Markets whose game time sits in another field are dropped as `no_game_start`; check the skip counts.
- **Trades can be truncated.** `/trades` has no time filter and is paged newest-first, so very busy markets can hit `--max-trades-per-market` or `--max-trade-pages` before reaching the start of the window. `tradesInfo.truncated` in markets.jsonl flags this. Truncation makes early-window flow features look thinner for busy markets.
- **Classification is regex-based** (ported from the userscript). For example, "over 220.5 points" without "O/U" is classified as a prop rather than a total.
- **Statistics.** Percentile-bootstrap p-values can be slightly optimistic for small, very skewed samples such as longshots. The CI lower bound and the 2c-spread check partly compensate. BH assumes independent or positively dependent tests; per-sport variants are positively correlated with their base hypotheses. Choosing parameters by best training ROI (as specified) favours small, noisy grid points, which costs power.
- **Execution.** Book depth, fill size, slippage, fee schedules and the timing of real fills are not modelled.
- **Survivorship.** Only resolved markets with usable price history are included. Voided, 50-50 and ambiguous markets are dropped.
