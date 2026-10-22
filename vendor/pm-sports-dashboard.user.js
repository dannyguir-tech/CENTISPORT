// ==UserScript==
// @name         Polymarket Sports Money Dashboard (2.35.0)
// @namespace    pm-sports-dashboard
// @match        https://polymarket.com/*
// @grant        none
// @run-at       document-idle
// @version      2.35.0
// ==/UserScript==
// >>> KEEP IN SYNC: bump SCRIPT_VERSION (~line 528 in the IIFE) whenever @version above changes.
// >>> SCRIPT_VERSION drives the button label, dashboard header, and loading caption — Tampermonkey
// >>> reads @version, but the in-page UI reads SCRIPT_VERSION. Drifting these two confuses the user.
// Changelog
// v2.30.0 — Scan-speed optimization layer. Display + transport only. NO prediction math,
//        weights, modelProb, p.probability, p.confidence, p.score, Top Picks ranking, Tail
//        Winners, alert thresholds, action logic, tokenId, or conditionId changes. NO new
//        endpoints. NO auto-betting. Same prediction-math safety filter as v2.21–v2.29
//        (zero matches).
//
//        Existing infrastructure mapped before designing this patch (KEPT, not changed):
//          - In-run promise cache: inflightFetches Map (URL-level, line ~3225), inflightHolders
//            Map (conditionId-level, line ~3716), walletPromises Map (wallet-address-level,
//            line ~3854). Same-URL / same-cid / same-wallet in-flight calls join one promise.
//          - Event-level wallet dedupe: walletSet=new Set() at line ~3791 builds the union
//            of all holders across all markets/sides ONCE; no per-side re-fetching.
//          - Split TTLs already exist: WALLET_HOT_TTL=4h, WALLET_COLD_TTL=45min, HOLDER_TTL_OK=
//            10min, HOLDER_TTL_NO_DATA=3min, EVENT_TTL=3min.
//          - Wave-based concurrency throttle: 429 storms drop currentBatch; calm waves ramp up.
//          - Holder no-data caching at 3min TTL.
//
//        Gaps closed by this version:
//        1. Subfetch short-TTL caches (NEW). Trades / books / prices-history / OI / comments
//           previously re-fetched every run with zero cache. The prediction components that
//           consume them (Flow24h, bookTilt, CLV, oiFactor) accept that on a rapid re-scan
//           within the TTL the snapshot is reused — formulas unchanged, modelProb computed
//           from a slightly older input. TTLs chosen sub-minute to keep drift minimal:
//             - TRADES_TTL    = 60s   (Flow24h: 24h-window sum; 60s drift is negligible)
//             - BOOKS_TTL     = 30s   (bookTilt: order-book top-5 levels)
//             - PRICES_TTL    = 60s   (CLV: reference price hours before game start)
//             - OI_TTL        = 30s   (oiFactor: open interest scalar)
//             - COMMENTS_TTL  = 5min  (news-mention badge, display-only)
//           Each cache only writes on a successful (non-null) fetch — failed calls do not
//           pollute the cache with empty data.
//        2. Per-wallet fail cooldown (NEW). When _loadWalletRaw\'s 8 parallel calls all return
//           null (typically because the wallet was dropped by data-api or hit a transient
//           outage), mark the wallet in localStorage under pmsports_walletfail_<addr> with a
//           15min TTL. Subsequent loadWallet calls for the same wallet within the window
//           fast-return an empty-state payload (zeros for all derived stats, empty positions/
//           activity arrays) without firing any of the 8 fetches. The prediction layer then
//           sees the wallet as "no data" (same outcome it would have seen after the failed
//           refetch, just 8 calls cheaper). Tracked as mon.walletFailSkips.
//        3. Per-endpoint 429 cooldown (NEW). When safeFetch / safePost exhaust all retries
//           because of a 429, mark the endpoint\'s host+path in a session-only Map with
//           cooldownUntil = now + 60s. Subsequent safeFetch / safePost calls to URLs matching
//           that host+path fast-return null until the cooldown expires. Saves the full
//           3×exponential-backoff penalty when an endpoint is genuinely throttled. Tracked
//           as mon.endpoint429Skips.
//        4. Diagnostics (NEW + EXPANDED). End-of-run console now logs:
//             - v2.30 subfetch cache: { trades, books, prices, oi, comments } hit counts
//             - v2.30 fail cooldowns: { walletFailSkips, endpoint429Skips, endpoints429Cooled }
//             - v2.30 top-5 slowest requests: ranked by ms with URL
//           The existing timings(ms) / v2.13 perf / v2.15 cache / fail breakdown logs are
//           preserved unchanged.
//        5. TopN 200 (Deep) stays exactly as-is. No raw matching changed. No tokenId /
//           conditionId logic touched. No alert dedup change. No DOM click handler change.
//           Bot export shape unchanged.
//
//        v2.30.1 — Phase 2 transport tuning. Same prediction-math safety filter (zero
//        matches). No prediction math, weights, modelProb, p.probability, p.confidence,
//        p.score, Top Picks ranking, Tail Winners, alert thresholds, action logic, tokenId,
//        or conditionId changes. TopN 200 (Deep) unchanged. Four small transport-layer
//        cuts on top of v2.30.0, targeting the bottlenecks the v2.30 top-5 slowest +
//        timings(ms) logs surfaced on Top 200 cold + warm scans:
//        a. Inter-batch sleep: 200ms → 100ms in both the main wallet loop (line ~4347)
//           and the exit-PnL backfill loop (line ~4410). The original 200ms was set
//           pre-v2.30 when there was no per-endpoint 429 cooldown safety net. v2.30's
//           60s endpoint cooldown + wave throttle (reactive ±2) absorb transient 429s
//           well before the inter-batch sleep would have. Saves ~5s at batch=4 floor on
//           a 200-wallet event (50 waves × 100ms cut).
//        b. Concurrency floor: TUNING.HOLDER_FETCH_BATCH 4 → 6. Both holders phase and
//           wallet phase ramp through this floor before endWave() pushes them toward
//           MAX_DYNAMIC_BATCH=12. Starting at 6 cuts ~33% off the floor-bound portion of
//           cold start. Wave throttle still drops back to 6 on 429 storms; the 60s
//           endpoint cooldown handles individual endpoint thrashing.
//        c. /closed-positions gate: skip the per-wallet call entirely when no market in
//           the event is yet resolved. /closed-positions is only consumed at the
//           "closedArr.length > 0 → winRate override" branch (lines ~4059–4065); on
//           live-only events the response is guaranteed-empty and the call is wasted.
//           A new closure-scoped flag eventHasResolved = markets.some(r => isResolved(r.m))
//           gates the fetch. Tracked as mon.closedPositionsSkips. Saves 1 call × walletList
//           on ~15% of scans (early-day events with no settled markets).
//        d. Subfetch TTL extensions: TRADES_TTL 60s→120s, BOOKS_TTL 30s→60s, PRICES_TTL
//           60s→120s, OI_TTL 30s→60s, COMMENTS_TTL 5min→15min. v2.30.0 picked sub-minute
//           TTLs assuming re-scans happen within seconds; real usage is closer to
//           minutes. Every doubling cuts warm-scan subfetch cost in half for the same
//           re-scan cadence. Flow24h / bookTilt / CLV / oiFactor formulas unchanged;
//           the longer windows just keep the snapshot in play across typical re-scan
//           intervals. Drift bounds remain conservative (TRADES at 120s = 0.14% of the
//           24h Flow24h sum window).
//        Diagnostics: closedPositionsSkips added to the v2.30 fail-cooldowns end-of-run
//        console line. All other v2.30 logs (timings(ms), v2.13 perf, v2.15 cache,
//        v2.30 subfetch cache, v2.30 top-5 slowest, fail breakdown) preserved unchanged.
// v2.29.0 — Side Normalization Layer. Display-only. NO prediction math changed. NO weights,
//        modelProb, p.probability, p.confidence, p.score, Top Picks ranking, Tail Winners,
//        alert thresholds, tokenId, or conditionId touched. NO new network fetches. NO new
//        signal logic. Verified via the same prediction-math safety filter as v2.21–v2.28
//        (zero matches).
//
//        Polymarket exposes Over/Under markets with Yes/No outcomes. A side labeled "No" on
//        "Stephon Castle: Rebounds O/U 4.5" actually means "Under 4.5", which is unreadable
//        in alerts, the prediction table, Top Picks cards, holder panels, cluster blocks, and
//        the click-to-bet CTA. This commit adds a thin normalization layer so humans see
//        "Under 4.5" while every internal match (DOM-button text, conditionId joins, settlement
//        winner equality, alert dedup, outcomeIndex, sideKey identity) still keys on the raw
//        Yes/No string Polymarket gives us.
//
//        1. New pure helper normalizeDisplaySide(marketQuestion, sideLabel) defined right after
//           VERSION_HISTORY. Returns {rawSide, displaySide, line, sideType}:
//             - O/U markets ("O/U", "Over/Under", or directional word + number in the question):
//               "Yes"/"Over"  → displaySide "Over <line>",  sideType "over"
//               "No"/"Under"  → displaySide "Under <line>", sideType "under"
//             - Pure Yes/No markets: displaySide pass-through, sideType "yes"/"no".
//             - Team / moneyline: displaySide pass-through, sideType "team".
//           Line is parsed from the question (or the side label itself if it encodes one).
//        2. sides[sideKey] gets {rawSide, displaySide, line, sideType} attached once, right
//           after construction. s.displayLabel (the raw Polymarket outcome) stays untouched —
//           it remains the canonical internal key for outcomes[].indexOf, winner equality,
//           and the DOM-button lookup in focusPolymarketBetTarget.
//        3. Display sinks now route through s.displaySide (with displayLabel fallback):
//           renderAlertCard title + CTA, buildAlert message + payload, rollupTable prediction
//           row + PnL rollup row, Top Picks card header, renderPanel holder title + settlement
//           note, clusterPanel block header, decisionSummary near-miss line. Color classes stay
//           derived from rawSide so "Yes" still renders green and "No" still renders red on
//           pure Yes/No markets — the underlying sideType for O/U markets ("over"/"under") is
//           intentionally left uncolored.
//        4. Bot export (window.pmSportsBotExport) gains rawSide + displaySide + line +
//           sideType on every topPicks[] and sides[] entry. The legacy `side` field stays
//           populated with the raw Polymarket outcome for back-compat. schemaVersion stays 1
//           because the change is purely additive.
//        5. Internal matchers NOT touched (these MUST keep using raw): alert dedup key at
//           ~2562 (cid + raw side + type), focusPolymarketBetTarget DOM matching, settlement
//           winner equality at ~4151 and ~5615, holder panel settlement note at ~5576,
//           outcomeIndex computation at ~6052, sideKey identity at ~4129. CLV / Spec /
//           Accumulation logs continue to use the raw sideLabel for tracking continuity.
//
//        v2.29.1 — Spread market normalization patch. Display-only. NO prediction math,
//        weights, modelProb, p.probability, p.confidence, p.score, Top Picks ranking, Tail
//        Winners, alert thresholds, action logic, tokenId, or conditionId changes. Same
//        prediction-math safety filter (zero matches). No new fetches.
//
//        v2.29.0 fixed O/U Yes/No display into Over/Under <line>, but spread markets were
//        still confusing. Example from a real export: market "Spread: Cincinnati Reds (-1.5)",
//        side "Philadelphia Phillies" rendered as bare "Philadelphia Phillies" — looked like
//        a moneyline call but was actually Phillies +1.5. Dangerous for alerts and manual
//        execution. This patch extends normalizeDisplaySide() to detect spread markets and
//        emit the side line.
//
//        1. Two small private helpers added next to normalizeDisplaySide:
//             - normalizeName(s): lowercase / collapse whitespace / strip punctuation, for
//               loose team-name comparison ("St. Louis Cardinals" vs "St Louis Cardinals").
//             - formatSignedLine(n): "+2.5" / "-1.5" / "0" — keeps the minus as a real minus
//               sign and adds a "+" in front of positive lines.
//        2. normalizeDisplaySide() now matches /spread:\s*(.+?)\s*\(([+\-]?\d+(?:\.\d+)?)\)/i
//           on the marketQuestion. When that hits AND the side label is non-empty:
//             - favoriteTeam / favoriteLine come from the regex.
//             - If rawSide matches favoriteTeam (under normalizeName), sideLine = favoriteLine.
//             - Otherwise sideLine = -favoriteLine.
//             - displaySide = "<rawSide> <signed line>" (e.g. "Philadelphia Phillies +1.5").
//             - sideType = "spread_favorite" when sideLine < 0, "spread_underdog" when > 0,
//               "spread_pickem" on the (theoretical) 0 edge case.
//           Spread detection runs BEFORE the O/U branch so a market that happens to mention
//           "over" in the team name (unlikely but possible) still classifies as spread first.
//           O/U + Yes/No + team behavior from v2.29.0 is untouched.
//        3. Bot export (window.pmSportsBotExport) automatically reflects the new displaySide /
//           line / sideType on every topPicks[] and sides[] entry — those fields are read off
//           s.displaySide / s.line / s.sideType which now come from the updated helper. No
//           additional changes needed in the export builder. Schema version stays 1.
//        4. All v2.29.0 display sinks (alert card title + CTA, buildAlert message, prediction
//           table row, Top Picks card header, holder panel title, cluster block header,
//           decision-summary near-miss line) automatically pick up the spread-adjusted label
//           through s.displaySide / alert.displaySide. No changes needed in any renderer.
//        5. Internal matchers still untouched: rawSide / side / sideLabel / displayLabel
//           continue to hold the raw Polymarket outcome text. Alert dedup, DOM click matching,
//           settlement winner equality, outcomeIndex, and sideKey identity all unchanged.
// v2.28 — Bot Export Layer. Export-only. NO prediction math changed. NO weights, modelProb,
//        p.probability, p.confidence, p.score, Top Picks, Tail Winners, alerts, or action
//        labels touched. NO new network fetches. NO new signal logic. Verified via the same
//        prediction-math safety filter as v2.21–v2.27 (zero matches).
//
//        Exposes a single structured `window.pmSportsBotExport` object after run() finishes
//        computing predictions, CLV, specialization, entry/exit pressure, tail, and clusters.
//        Built so a future headless/VPS scanner can read it without scraping the popup DOM.
//
//        1. New pure helper buildBotExport(ctx). Reads existing pass-level variables only
//           (sides, predictions, sideRaw, topPicks, clvBySide, specializationBySide,
//           accumulationBySide, tailBySide, clustersBySide, mon + DataQuality, walletList,
//           topN, mon counters, near-miss / decision-summary fields). Returns a plain
//           JSON-safe object — no DOM nodes, no functions, no circular refs. Wrapped in
//           try/catch; serialization failure logs to console.warn and emits a stub object
//           with `error:'export_build_failed'` rather than throwing.
//        2. Export shape (schemaVersion 1):
//           { schemaVersion, scriptVersion, exportedAt, slug, url,
//             event, decisionSummary,
//             topPicks[], sides[], clusters (compact by side),
//             diagnostics }
//           Cluster blocks include count, best-quality, recurring score/count, total notional,
//           wallet count, archetype counts, sharp/public counts, timing span — no per-wallet
//           objects, so the JSON stays small.
//        3. After all computations, window.pmSportsBotExport is set on the parent page and
//           also mirrored to the popup window so the in-popup Copy button works. A getter
//           window.pmSportsGetExport() returns the latest export. A single console line
//           [PM Sports bot export] is emitted at build time.
//        4. Research-Mode summary now opens with a "📦 Bot export ready · window.pmSportsBotExport"
//           banner plus a "Copy Bot Export JSON" button. Clipboard write uses navigator.clipboard
//           when available, falls back to a hidden-textarea / document.execCommand path, and
//           silently console.warns on failure — never blocks dashboard render.
//        5. Stops after v2.28. The VPS scanner / bot is deferred — this commit only exposes
//           the data surface it will read.
//
//        v2.28.1 (hotfix) — four bug fixes on top of v2.28. NO prediction math, weights,
//        modelProb, Top Picks, Tail Winners, alerts, or export schemaVersion changed.
//        a. Entry / Exit Pressure (v2.27) now runs for sides where refPriceByToken[tokenId]
//           is null. The side-loop early-return `if (referencePrice == null) return` was
//           moved to gate ONLY the CLV + specialization branch (which genuinely need the
//           closing-line proxy); the pressure block was relocated below the CLV log push so
//           it runs unconditionally. Sides with no proxy line previously dropped out of
//           accumulationBySide entirely.
//        b. Negative bucket Nets now render as "-$1,500" instead of "$-1,500" in BOTH the
//           computeSidePressure pressureReason MIXED string AND the Research Mode pressureDetails
//           Smart/Elite/Sharp/Public Net rows. round$ / fmt$ rebuilt to emit sign in front of $.
//        c. hiddenAccumulation no longer fires when referencePrice === modelProb. Added a
//           Math.abs(referencePrice - modelProb) > 0.005 (≥0.5¢) non-trivial-gap guard before
//           the half-gap-not-closed comparison. Sharp markets with smartNet > 0 previously
//           false-positived.
//        d. updateLiveEdge gains a re-entrancy guard (st.tickInFlight flag with try/finally).
//           Manual-refresh-button clicks, install-time immediate kicks, and setInterval ticks
//           can no longer overlap on slow networks. Prevents racing writes to st.bookSnapshot
//           / st.lastSnapshot and spurious alerts from interleaved prev/cur pairs.
// v2.27 — Phase 2 Part 3: Entry / Exit Pressure tracking. Display/log only. No prediction
//        math changed. NO weights, modelProb, p.probability, p.confidence, p.score, Top
//        Picks, Tail Winners, or alert logic touched. NO new network fetches — reuses the
//        existing tradesByToken closure (populated upstream alongside books / oi / prices
//        history). Verified via the same safety filter as v2.21–v2.26 (zero matches).
//
//        1. Two new pure helpers next to classifyMarketType: classifyWalletBucket(r) picks
//           one of 'elite' | 'sharp' | 'public' | 'other' (elite takes precedence over
//           archetype, matching v2.25 CLV bucket priority); computeSidePressure(ctx) does
//           a single pass over the 24h trade slice (after building a wallet→bucket map
//           from ctx.rows) and returns the full pressure shape: per-bucket buy/sell/net
//           notionals, smart aggregates, ratios, five boolean flags, plus pressureLabel +
//           pressureReason. Both helpers are side-effect-free.
//        2. Four new TUNING keys (ACCUMULATION_LOG_KEY/MAX/LOOKBACK_HOURS/MIN_NOTIONAL).
//           Rolling localStorage log at pmsports_accumulation_log_v1 capped at 500 rows;
//           24h lookback; $500 minimum smart-net for "still adding" / "dumping" flags.
//        3. Pressure label priority: UNKNOWN (no smart trades) > DISTRIBUTING (dumping) >
//           ACCUMULATING (still adding) > MIXED (smart and public moving opposite ways
//           with both |net| >= minNotional/2) > HOLDING (everything else).
//        4. distributionPressure additionally requires currentPrice > smartBuyVWAP (the
//           24h volume-weighted avg of smart buys, falling back to referencePrice when
//           the smart bucket has no recent buys) — captures "selling into strength"
//           explicitly. hiddenAccumulation triggers when smart-net positive but the
//           current price has closed less than half the gap from referencePrice toward
//           modelProb (the v2.0 fair-value proxy).
//        5. Off-roster wallets (trades from wallets not in the side's top-N s.rows)
//           bucket as 'other' — counted in totals but excluded from smart/public rollups.
//           Verified no global archetypeByWallet map exists, so "do not guess" is honored.
//        6. v2.25/v2.26 side-loop extended in place: pass-level accumulationBySide /
//           accumulationLogRows / accumulationConsoleSummary state added next to the v2.26
//           specialization rollups; pressure block inserted after specializationBySide is
//           finalized and before the existing clvLogRows push. round3 / round4 hoisted to
//           the top of the side-loop so the new console summary can reuse them. Single new
//           per-side console line `[PM Sports accumulation pressure]` + localStorage write
//           after the loop.
//        7. Research Mode tableHtml gains a fourth sibling <details class=pressureDetails>
//           block (Pressure Label color-coded + 10 comp rows + Reason line). Stops after
//           Part 3; bot export layer deferred.
// v2.26 — Phase 2 Part 2: Wallet market-type specialization + CLV quality rollups. Display/log
//        only. No prediction math changed. NO weights, modelProb, p.probability, p.confidence,
//        p.score, Top Picks, Tail Winners, or alert logic touched. NO new network fetches —
//        reuses the data the v2.25 CLV pass already iterates. Verified via the same safety
//        filter as v2.21–v2.25 (zero matches).
//
//        1. New helper classifyMarketType(question, sportKey) next to getMarketProfile.
//           Returns a per-sport bucket like 'nba_moneyline', 'nba_spread', 'nba_total',
//           'nba_prop', 'esports_match'/'_map'/'_total', or a sportKey-prefixed fallback for
//           non-listed sports (e.g. 'nhl_total', 'mls_spread'). Returns 'unknown' only when
//           sportKey is null/empty. Detection order is prop > total > spread > moneyline.
//        2. New TUNING keys SPECIALIZATION_KEY/MAX/DECAY_MS/MIN_SAMPLES added. Rolling per-
//           (wallet, marketType) memory persisted to localStorage at
//           pmsports_wallet_specialization_v1 in the same JSON envelope as recurring-groups,
//           with a 30-day lastUpdated decay and a 10000-entry cap (oldest-by-lastUpdated
//           evicted at load). Three helpers (load/save/walletSpecializationScore) sit next
//           to loadRecurringGroups.
//        3. v2.25 CLV pass extended in place: classifyMarketType hoisted to the side-loop top
//           (replaces the v2.25 binary/multi fallback), side-local specialization
//           accumulators added, per-row dedup-gated entry update + PRE-update side rollup
//           runs inside the existing s.rows.forEach. No second iteration over rows.
//        4. Score formula (display only):
//           score = clamp01(
//             0.50 · clamp01((avgCLV + 0.03) / 0.08)
//           + 0.30 · positiveCLVRate
//           + 0.20 · clamp01(log10(totalNotional + 1) / 5)
//           ) * 100
//           Labels: ≥75 strong, 55–75 useful, <55 weak, null = low sample (< MIN_SAMPLES).
//        5. New per-page-load console line `[PM Sports wallet specialization]` (one entry
//           per side) carries market, side, sport, marketType, side/elite/public spec
//           scores, scored/low-sample counts, and the top-5 specialized wallets per side
//           (short addr + score + label + samples + avgCLV + +CLV rate).
//        6. Research Mode tableHtml gains a third sibling <details class=specializationDetails>
//           block after the v2.25 clvDetails. Compact rollup: Side/Elite/Public spec score
//           rows + a top-5 specialized-wallets list. Null buckets render as "—".
//        7. NO mutation of any predictions[*].* field, sideRaw[*], trueClvSide,
//           refPriceByToken, or any v2.0/v2.25 CLV input. The new score is read-only by the
//           renderer and console.log. Stops after Part 2; entry/exit pressure deferred.
// v2.25 — Phase 2 Part 1: CLV tracking display/log only. No prediction math changed. NO
//        TUNING.WEIGHTS, modelProb, Top Picks, Tail Winners, or alert logic touched. Reuses the
//        existing refPriceByToken[tokenId] reference (the v2.0 closing-line proxy that already
//        feeds the prediction model's `clv` component) — no new network fetches. Verified via
//        the same prediction-math safety filter as v2.21–v2.24.1 (zero matches).
//
//        1. Per-side CLV aggregates computed in a new pass after the cluster-enrichment block.
//           For each side: walletCLV = referencePrice − walletAvgEntry per wallet, weighted by
//           entry notional (amount × avg) — matches the cluster.avgEntry weighting. Bucketed
//           three ways: sideWeightedCLV (all wallets), eliteWeightedCLV (isEliteFn true),
//           publicWeightedCLV (isEliteFn false). clvSpread = elite − public.
//        2. Console summary on every page load: `[PM Sports CLV tracking]` — array of one
//           entry per side with market, side label, modelProb, referencePrice, the four CLV
//           aggregates, and walletCount. modelProb is logged for context only, NEVER mutated.
//        3. Append-only rolling log to localStorage at `pmsports_clv_log_v1` (cap 500 newest
//           rows, oldest evicted at write). Each row records timestamp, slug, market question,
//           conditionId, side label, sport, marketType (binary vs multi), modelProb,
//           effectiveCost (via marketEdgeFor — pure read), referencePrice, all four CLV
//           aggregates, and per-bucket wallet counts. Mirrors the existing PLOG ring-buffer
//           pattern (concat + slice(-N) at write time).
//        4. Research Mode "Score breakdown" pane gains a sibling `<details class=clvDetails>`
//           block right below predDetails per side: Side CLV, Elite CLV (with count), Public
//           CLV (with count), CLV Spread. Null buckets render as "—" (no data). Display-only —
//           does NOT participate in any scoring computation.
//        5. NO mutation of predictions[label].probability / .components / .score / .confidence,
//           sideRaw[*], trueClvSide/trueClvWeightedSum (the v2.0 prediction-model CLV
//           component is fully separate from v2.25's aggregate metric). Two new TUNING keys
//           (CLV_LOG_KEY, CLV_LOG_MAX) added; no existing TUNING value altered.
//        Stops after Part 1. Wallet specialization and accumulation deferred.
// v2.24.1 — Diagnostics-only patch on top of v2.24 Phase 2A. NO scoring/math changes. NO prediction
//         math, weights, modelProb, Top Picks, Tail Winners, or alert logic touched. Added so the
//         recurring-group memory's behavior is observable in production before Phase 2B work begins.
//
//         1. loadRecurringGroups() now returns { mem, loaded, active, decayed, capped } instead
//            of the bare mem object. The enrichment pass destructures these counts and accumulates
//            two more per-run counters (touched: unique groupKeys recorded this page load,
//            penalizedClusters: clusters where recurringGroupScore > 0, maxPenalty: max applied
//            recur deduction observed). All eight fields are emitted in a single new console line
//            `[PM Sports v2.24 recurring groups] { loaded, active, touched, decayed, capped,
//            penalizedClusters, maxPenalty, storageKey }` immediately after persistence.
//         2. Cluster Intel panel: the `− recur N%·0.10` term in the breakdown line is now
//            suppressed when recurringGroupScore === 0, so clusters with no recurrence don't
//            show the noisy "− recur 0%·0.10" segment. The "⟲ seen together in N events" note
//            keeps its existing ≥2-event gate — the fact is still surfaced even when the score
//            hasn't moved (which only happens at ≥3 events).
//         3. No memory-format change, no TUNING change, no penalty-formula change. VERSION_HISTORY
//            keeps the v2.24 row in place rather than adding a new row — the diagnostic note is
//            folded into v2.24's tuningSummary + notes.
// v2.24 — Cluster Intel Phase 2A: recurring-group detection. Tracks top-wallet coalitions across
//        events and applies a small display-only Cluster qualityScore penalty when the same group
//        appears together repeatedly. NO prediction math, weights, modelProb, Top Picks, Tail
//        Winners, or alert logic changed. Verified via the same diff filter as v2.21–v2.23.
//
//        1. New rolling localStorage cache (pmsports_recurring_groups_v1) stores top-5
//           wallet coalitions keyed by sorted-lowercase address join. Each entry tracks
//           appearances count, unique event slugs (Set semantics via dedupe-on-insert), and
//           lastSeen timestamp. Loaded once per page render; decayed (drop entries unseen for
//           12h) and size-capped (5000 max, oldest-first eviction by lastSeen) at load time.
//        2. detectClustersForSide() unchanged — recurring-group lookup happens in the
//           post-prediction enrichment pass alongside fairValueScore so it runs once per
//           page load (not once per side) and after all clusters are assembled.
//        3. Per-cluster recurringGroupScore = clamp01((uniqueEventCount - 2) / 8) — 1-2
//           events together = no penalty (organic / coincidence allowed); 3+ events = small
//           ramp; 10+ events = saturated 1.0. Subtracted from blended qualityScore at 10%
//           weight, matching the v2.23 exitPenalty pattern. At max recurrence the score
//           drops 10pp — meaningful but does not crush.
//        4. Cluster panel breakdown gains "− recur Y%·0.10" and a conditional ⟲ "seen
//           together in N events" note when recurringEventCount ≥ 2 (the spec's no-penalty
//           threshold so users see context before the score moves).
//        5. Safety: skip clusters with < 3 wallets (no key, no penalty), skip when slug is
//           empty (page in transition), localStorage disabled / quota full silently no-ops
//           the persist (in-memory state still works for this session).
//        6. Phase 2B (adversarial coordination filter) and Phase 3 (niche multiplier,
//           alignment column, threshold recalibration) explicitly deferred.
// v2.23 — Cluster Intel quality-score rebalance (Phase 1). DISPLAY-ONLY: NO prediction math,
//        weights, modelProb, components, p.confidence, top picks, bet thresholds, table edges,
//        or wallet/holder field semantics changed. The Cluster Intel panel's qualityScore is
//        recomputed by blending the existing 6-factor base score (50%) with four new sub-scores
//        that reuse signals already in scope: elite share (10%), fair-value edge vs modelProb
//        (15%), log-scaled lifetime PnL magnitude (15%), and an exit-quality anti-correlation
//        penalty (-10%). Phase 2 (cross-event recurring groups, adversarial coordination) and
//        Phase 3 (niche multiplier, alignment column, threshold recalibration) are deferred
//        until live data on the post-rebalance score distribution is reviewed.
//
//        1. detectClustersForSide() now accepts {tokenId, exitQualityByToken} via opts and
//           computes three of the four new sub-scores inline: eliteShareScore (clamp01(eliteShare/0.30),
//           where eliteShare is fraction of cluster wallets passing isEliteFn), pnlMagnitudeScore
//           (mean of clamp01(log10(max(pnlAll,1))/6) per wallet — saturates at $1M lifetime
//           PnL, ignores negative-PnL wallets), and exitPenalty (clamp01 of the per-token
//           exitQualityByToken score already computed at line 3146 — penalty when smart money
//           is simultaneously exiting). The legacy 6-factor formula is preserved verbatim and
//           stored as baseQualityScore for the enrichment pass to read.
//        2. Per-wallet cluster entries gain pnlAll + elite fields (sourced from r.u and
//           isEliteFn(r.u) at the existing call site). Backward-compat: wallets without a
//           userStats entry get elite=false / pnlAll=0, contributing zero to either sub-score.
//        3. Post-prediction enrichment pass (immediately after the existing predictions loop
//           closes — read-only on predictions[*]) computes the fourth sub-score, fairValueScore =
//           clamp01((modelProb − clusterAvgEntry + 0.05) / 0.15), then assembles the blended
//           qualityScore = base*0.50 + elite*0.10 + fair*0.15 + pnl*0.15 − exit*0.10, clamped
//           to [0,1]. Re-derives the strong/medium/weak label and re-sorts clustersBySide.
//        4. Cluster panel renders the per-cluster Phase-1 breakdown line (base/elite/fair/pnl/exit
//           contributions and final score) so the rebalance is auditable in-panel without console.
//        5. CLUSTER_STRONG_SCORE = 0.70 and the 0.40 medium gate are kept as-is — recalibration
//           is Phase 3 work after observing the live score-distribution shift.
// v2.22 — Load-time speedup. NO prediction math, weights, modelProb, components, topN, or
//        wallet/holder field semantics changed. Verified via diff filter.
//
//        1. Cache TTLs split. Single LIFETIME_TTL=30min replaced with per-bucket constants:
//           WALLET_HOT_TTL=4h (derived wallet stats — value/pnlAll/pnl30d/pnl7d/volume/winRate/
//           leagueFocus/entryQuality/tradeCount/etc.) and WALLET_COLD_TTL=45min (positions/
//           activity arrays). HOLDER_TTL_OK (10m) / HOLDER_TTL_NO_DATA (3m) / EVENT_TTL (3m)
//           kept as-is per spec. Books / price-history / live loop already cache-free; no
//           change. cacheGet returns positions/activity as null when COLD is stale; HOT path
//           still fires when the 4h window holds, so warm reloads inside 4h skip the wallet
//           phase entirely. Cached field semantics unchanged — only TTL gates moved.
//        2. fetchHoldersCached gains in-flight dedupe via inflightHolders Map. Concurrent
//           callers for the same conditionId now share a single network call (matching the
//           existing walletPromises / inflightFetches patterns). New holderDedupeHits counter
//           in mon{} surfaces hits in the end-of-run log. v2.18-era audit confirmed wallet
//           in-flight dedupe (walletPromises line 2722) and GET URL dedupe (inflightFetches
//           line 2114) already work as intended; only the holder gap needed closing.
//        3. Market-only sub-fetches (trade tapes, open interest, order books, price history,
//           comments) lifted out of the post-loadWallets serial chain. They now kick off in
//           parallel with the wallet phase via subfetchPromises[] and are awaited via
//           Promise.allSettled() right after loadWallets ends. Closure variables (tradesByToken,
//           oiByCid, bookByToken, refPriceByToken, latestPriceByToken, alertsByCid) are
//           write-once so overlap is safe. Exits stays AFTER loadWallets — its backfill reads
//           userStats. Expected savings ~4-8s on fresh-event renderUI network tail.
//        4. MAX_DYNAMIC_BATCH bumped 10 → 12. endWave() auto-throttle keeps currentBatch in
//           [HOLDER_FETCH_BATCH=4, MAX_DYNAMIC_BATCH=12] so the wallet-phase scaler can ramp
//           higher when 429 rate stays under 5%. Worst case (429 spike >20%) drops back to
//           floor 4, identical to v2.21.
//        5. v2.22 deliberately STOPS at 12. Bumping past 12 deferred until live data confirms
//           429 rate stays safe — fail429 counter in the end-of-run log is the gate.
// v2.21 — Alert UX upgrades — NO prediction math, weights, modelProb, components, topN, or
//        wallet/holder field changes. Verified via diff filter.
//
//        1. Sound alerts. Two-tone beep on ORANGE (BET); single beep on GREEN (LEAN/watch);
//           YELLOW/RED silent. Toggle via 🔔/🔕 button on the status overlay; persisted in
//           localStorage. Audio failures never block alert rendering.
//        2. Alerts sorted by |edge| desc on fire — toast stack and history default both
//           reflect best-edge-first. History panel gains a Sort: Edge ↓ ↔ Sort: Recent ↓
//           toggle so the user can flip back to chronological without losing the live order.
//        3. Dynamic CTA per color: ORANGE → "BET <side> at X¢ — click to open"; GREEN →
//           "WATCH <side> at X¢"; YELLOW → "CAUTION — edge fading on <side>"; RED → "SKIP".
//           Falls back to the legacy "Click to open bet" when currentPrice is null.
//        4. Stale alert dimming. Alerts older than STALE_ALERT_LIVE_MS (3 min, toasts) /
//           STALE_ALERT_MS (5 min, history) render at 0.4 opacity with a "· stale" tag.
//        5. Prediction-table sort toggle. New "Sort: Score ↓ / Sort: Edge ↓" button next to
//           the table title — Edge mode sorts by mktEdge desc with nulls/PASS at the bottom.
//        6. BET-alert flash. When an ORANGE alert fires and the popup is open, the matching
//           Top Picks .pickCard outlines orange for 3s. Closed-popup case is silent.
//        7. Version history surfaced. New 📜 Version history collapsible inside the 📊 Grade
//           modal — shows v2.18 / v2.19 / v2.20 with one-line tuning summaries.
//        8. Click-to-bet matchers strengthened. findMarketCard now requires a clickable
//           descendant + bounded textContent, so it no longer matches the body wrapper.
//           selectOutcomeSide widened to include [role=button] / [tabindex] elements (Polymarket's
//           outcome controls are often <div role=button>) and a synthetic mousedown→mouseup→click
//           is dispatched alongside .click(). Diagnostic console.warn lines fire on miss + a
//           window.pmsportsTestClick(question, side) helper for manual testing.
// v2.20 — Color hierarchy update — UI/action-color only. No prediction math, weights, modelProb,
//        components, topN, or wallet/holder field changes. Verified via diff filter.
//
//        New 4-tier action color system applied uniformly to alerts, Top Picks cards, and
//        prediction-table action rows:
//          ORANGE = BET NOW / actionable           (#ff8c42)
//          GREEN  = good edge but watch / LEAN     (#5fd17a)
//          YELLOW = fading edge / caution           (#e6c26a)
//          RED    = pass / no longer actionable    (#f08a8a)
//
//        Alert type → color remap:
//          BET_OPENING / EDGE_IMPROVED / BETTER_PRICE_STILL_BET   → ORANGE  (was green)
//          TAIL_SCORE_IMPROVED                                    → GREEN   (kept — watch)
//          BETTER_PRICE_BUT_WEAK / EDGE_FADING                    → YELLOW  (kept)
//          NO_LONGER_ACTIONABLE / PRICE_TOO_EXTENDED /
//          BETTER_PRICE_BUT_PASS                                  → RED     (kept)
//
//        Headline rename: BETTER_PRICE_STILL_GOOD → "BETTER PRICE, STILL BET" (the alert key
//        stays BETTER_PRICE_STILL_GOOD for back-compat with stored alertHistory).
//
//        Action-badge inside each alert card and the prediction-table row colors:
//          BET  → orange (was green)
//          LEAN → green  (was yellow)
//          PASS → red    (was implicit grey)
//          FADE → red    (was grey/dark-red)
//        Action-color is now dominant — edge value in the alert stats row no longer carries
//        green/red coloring (kept neutral text per "edge is secondary" rule).
//
//        Top Picks card: BET pick header now ORANGE (was green); marginal picks now YELLOW
//        (was orange) since "marginal" is closer to fading-caution than to bet-now.
// v2.19 — Click-to-navigate alerts + decision-aware language. NO prediction math, weights,
//        modelProb, or data-field changes. Verified via diff filter.
//
//        1. Decision-aware alert types — replace generic PRICE_IMPROVED with three branches
//           that classify the move based on edge / tail / action context:
//             BETTER_PRICE_STILL_GOOD  — price down + edge>0 + tail OK         (green)
//             BETTER_PRICE_BUT_WEAK    — price down + tailScore < TAIL_MIN     (yellow)
//             BETTER_PRICE_BUT_PASS    — price down + edge ≤ 0                  (red)
//           Existing types kept: BET_OPENING, EDGE_IMPROVED, EDGE_FADING,
//           NO_LONGER_ACTIONABLE, PRICE_TOO_EXTENDED, TAIL_SCORE_IMPROVED.
//
//        2. Alert payload enriched. Each alert now carries: slug, conditionId, tokenId,
//           sideLabel, marketQuestion, outcomeIndex, currentPrice, fairValue, edge,
//           confidence, tailScore, action, reason. Used by both the rich card UI and
//           the click-to-navigate flow.
//
//        3. Click an alert → focusPolymarketBetTarget(alert) navigates to the event URL
//           if needed, finds the matching market card by question text, scrolls + highlights
//           it for 5s, and opens the matching outcome side. Safety: never clicks any
//           button matching /confirm|place\s+order|submit|approve/i — outcome buttons
//           open the trade panel, the user always confirms manually.
//
//        4. Dedup updated: same (cid, side, type) within 60s now UPDATES the existing
//           alert in place when price/edge moved another ≥0.5¢ / ≥0.5pp. No more spammy
//           duplicate toasts when the same trigger keeps firing on small drift.
//
//        5. Rich card UI — toasts and history rows now show: type label header, market
//           short title + side, current/fair/edge/confidence row, action badge, reason
//           line, and a "Click to open bet" CTA. Wired to focusPolymarketBetTarget on click.
// v2.18.1 — Hotfix: v2.18 bumped @version 2.18 but I forgot to bump the SCRIPT_VERSION JS const,
//          so the installed userscript said 2.18 in Tampermonkey but the floating button +
//          dashboard header + loading caption all kept showing v2.17. SCRIPT_VERSION is now
//          synced to '2.18.1' and a console.log fires on page load echoing the version so the
//          user can confirm without clicking. Sync-reminder comments added at both sources.
//          NO model / weights / topN / data-field changes.
// v2.18 — Concurrency cap raised 6 → 10. Wallet phase is the dominant cost (~16s on
//        a fresh 100-wallet event at cap 6); raising the upper bound lets the adaptive
//        scaler in endWave() ramp higher when 429 rate is below 5%. Expected savings
//        ~6s per fresh event (~10s wallet phase instead of ~16s). The auto-throttle
//        still drops back to HOLDER_FETCH_BATCH (4) on rate-limit spikes, so worst case
//        is the same as today. NO prediction math, weights, modelProb, components,
//        topN, or wallet field changes — pure tuning constant. Verified via diff.
// v2.17 — UX polish: layout no longer blocks Polymarket nav/search/buy panel + clearer
//        loading + version surfaces. NO prediction math, weights, modelProb, or data
//        field changes. Verified via diff filter.
//
//        1. Status overlay moved bottom-left (was top-right blocking nav). Collapsible
//           via a small minimize button so it can shrink to a pill.
//        2. Alert toaster moved bottom-left, stacked ABOVE the status overlay (was
//           top-right blocking the buy/sell panel). Capped to 3 visible toasts. After
//           6s with no new alerts, the stack auto-collapses into a "SPORTGPT Alerts (N)"
//           pill; clicking the pill expands the recent-alerts history view.
//        3. Floating button now shows version: "Sports Money v2.17" or, when an
//           external SPORTGPT layer exposes window.SPORTGPT_VERSION (or window.SPORTGPT.
//           version), "SPORTGPT v<x> · Sports Money v2.17".
//        4. Dashboard header sub-line shows: userscript version, SPORTGPT version (if
//           present), last scan time, and unique-wallet count.
//        5. Loading messages now carry step labels and live counters (cache hits/misses,
//           real fails, 429 fails, expected no-data) so the user can see what's slow.
//        6. Failed-market messaging: noDataMarkets counted but never described as
//           "failed". Failed-market warn banner only surfaces 429/5xx/network. Counts
//           rendered explicitly: "X loaded · Y no holder data · Z rate-limited · W
//           server/network".
//        7. Concurrency safety: HOLDER_FETCH_BATCH bumped 3→4, MAX_DYNAMIC_BATCH stays 6,
//           HOLDER_FETCH_SPACING_MS stays 400. currentBatch initializes from
//           HOLDER_FETCH_BATCH (already true since v2.13) and never exceeds the cap.
//        8. Wallet + URL dedupe verified intact from v2.13 — same in-flight Map pattern.
//        9. Wallet cache TTL set to 1800000 (30 min), down from v2.15's 4h. Predictions
//           on a stale event get re-fetched within a session window without aging holder
//           data into next-day territory.
// v2.16 — Live auto-update + on-page alert system. Wallets/holders/components/weights/
//        topN/modelProb all UNCHANGED. Verified via diff.
//
//        After run() completes, the script exports a live-state snapshot to
//        window.pmSportsLiveState and starts a 20s setInterval on the MAIN Polymarket
//        page (not the popup — closing the popup keeps the loop alive). Each tick:
//          1. POSTs /books for the unique tokens scanned.
//          2. Recomputes ONLY price-dependent quantities per side: edge, effectiveCost,
//             tail score, extension ratio, action label (BET/LEAN/PASS/FADE).
//             modelProb, components, sampleFactor, oiFactor, sideRaw values stay locked.
//          3. Diffs against the previous snapshot and fires alerts on transitions.
//
//        Seven alert types per spec (60s dedup window per cid|side|type, max 10 stored,
//        max 5 visible toasts, auto-fade after 12s):
//          BET_OPENING / EDGE_IMPROVED / PRICE_IMPROVED  (green)
//          EDGE_FADING                                    (yellow)
//          NO_LONGER_ACTIONABLE / PRICE_TOO_EXTENDED      (red)
//          TAIL_SCORE_IMPROVED                            (green)
//
//        Status panel + alert toaster pinned top-right of main page (top:24px). Status
//        line shows "Live · N wallets locked · Last full scan: Xm ago · Last price:
//        Ys ago". Buttons: Pause/Resume, Refresh prices now, Full rescan. Pause toggle
//        persists in localStorage[pmsports_live_alerts_enabled].
//
//        Slug navigation auto-terminates the loop (state.slug !== current pathname);
//        re-running the scan on the new event installs a fresh loop.
// v2.15 — Caching layer expansion. Same data, same prediction math, same topN, same
//        TUNING.WEIGHTS, same wallet field shape. Just fewer repeated API calls.
//
//        1. Wallet cache TTL bumped 30min → 4h (LIFETIME_TTL: 1800000 → 14400000).
//           Wallet pnl/winRate/positions don't churn meaningfully on a 30-min vs
//           4-hour scale during a betting session. The /value, /profit, /volume,
//           /positions, /activity, /closed-positions Promise.all is the heaviest
//           per-wallet block; this avoids re-firing it for hours after the first
//           hit on each wallet.
//
//        2. NEW per-conditionId holder cache. Key: pmsports_holders_<cid>.
//           - 10 min TTL on successful non-empty holder arrays.
//           -  3 min TTL on expected no-data (4xx silent, empty array).
//           - 5xx / 429 / network errors are NOT cached (transient — let retry win).
//           Callers go through fetchHoldersCached(cid, limit). Internal retries on
//           fetchHolders bypass the cache wrapper so they don't re-hit storage.
//
//        3. NEW per-slug event cache. Key: pmsports_event_<slug>. 3 min TTL.
//           Only successful fetchEvent responses are cached. Failed responses
//           (returning null) are not. Lets the user reload an event tab quickly
//           without re-pinging gamma's three slug endpoints.
//
//        4. Diagnostics. mon now tracks walletCacheHits (existing), holderCacheHits,
//           eventCacheHits, plus a derived "freshApiCallsAvoided" total. End-of-run
//           [PM Sports] v2.15 cache: log line surfaces all four numbers per run.
//
//        Estimated impact: dashboard refresh on the SAME event within 3 minutes
//        becomes near-instant (event + most holders cached). Reload across multiple
//        events sharing wallets cuts ~50-80% of wallet API calls when run on a fresh
//        topN=100 event.
// v2.14 — Holder retry no longer panics over expected no-data. Bug: the holder fetch
//        loop was treating ANY non-success response (including silent 4xx like 404 and
//        markets with literally zero holders) as a failure. The retry pass then ran
//        with a 5s delay + 600ms pacing for markets that had no data to begin with —
//        producing the scary "Retrying 28 failed markets" message users were seeing.
//
//        Now categorized into three buckets at the consumer (not in fetchHolders;
//        fetchHolders' return shape unchanged):
//          markets         = 200 + non-empty holders array → render normally
//          failedMarkets   = 429 / 5xx / network → retry-eligible
//          noDataMarkets   = silent 4xx (400/403/404/422) OR empty holder array → skip
//
//        Retry pass only fires when failedMarkets is non-empty. Loading message updated
//        to: "Retrying X rate-limited/server-failed · Y no-data · Z loaded after 5s…".
//        Retry results are categorized the same way — a retry that returns no-data is
//        moved to noDataMarkets, not kept in stillFailed.
//
//        No prediction math touched. No topN reduction. No TUNING.WEIGHTS changes.
//        Verified via diff filter.
// v2.13 — Performance hotfix. NO data removed. NO topN reduction. NO TUNING.WEIGHTS,
//        modelProb, component, or prediction-logic changes. Verified via diff.
//
//        Symptoms: dashboard ramping currentBatch to 32, avg latency ~500ms, 100+ fails
//        per load. Cause: over-aggressive concurrency scaling triggered Polymarket rate
//        limits, retries exploded, average latency dragged with retry waits.
//
//        1. Concurrency scaling clamped. New TUNING.MAX_DYNAMIC_BATCH (default 6).
//           currentBatch initializes from TUNING.HOLDER_FETCH_BATCH (3) instead of 24,
//           and the endWave() scaling rules now widen by +1 only when failure rate
//           drops below 5%, narrow by −2 when failure rate exceeds 20%, and never
//           leave [HOLDER_FETCH_BATCH, MAX_DYNAMIC_BATCH] = [3, 6].
//
//        2. Address-level wallet dedupe. New walletPromises Map. If two callers ask
//           to load the same wallet concurrently (different markets sharing holders),
//           the second now joins the in-flight promise instead of duplicating the
//           8-call Promise.all.
//
//        3. URL-level fetch dedupe. New inflightFetches Map. Two sites asking for the
//           same URL concurrently share a single underlying request. Internal retries
//           still use the raw fetcher so they don't recursively dedupe themselves.
//
//        4. Cache TTL extended from 10 min → 30 min (LIFETIME_TTL: 600000 → 1800000).
//           Wallet stats don't churn that fast inside a betting session; reusing them
//           across reloads avoids re-fetching the same 8 endpoints per wallet.
//
//        5. Failure breakdown. mon.fails was a single counter. Now split into:
//             expectedNoData (silent 400/403/404/422 — not real failures)
//             fail429        (rate limit after retries exhausted)
//             realFails      (5xx / network / unknown after retries)
//           Logged at end-of-run. The "N fails" badge stays as totalFails for legacy.
//
//        6. Timing + dedupe diagnostics. New console.time markers around fetchEvent /
//           fetchHolders / loadWallets / renderUI. End-of-run log adds totalHolderRows,
//           uniqueWallets, fetchDedupeHits, walletDedupeHits.
//
//        Estimated impact: 30–60% fewer API calls on multi-market events (fewer retries,
//        wallet/URL dedupe), much lower 429 rate, similar or better wall-clock load time
//        despite lower parallelism (because retries no longer dominate).
// v2.12 — Tail Winners Score (EXECUTION-LAYER ONLY — does NOT touch model math).
//        TUNING.WEIGHTS unchanged. modelProb / eliteEdge / walletEdge / holderProfit /
//        sharpEdge math untouched. The model still picks WHICH side has edge; tail
//        score gates and ranks WHEN to bet on that pick at the current price.
//
//        Per surviving Top-Pick candidate, computes:
//          rangeToFair    = modelProb − eliteAvgEntry
//          extensionRatio = (currentPrice − eliteAvgEntry) / rangeToFair
//          tailScore (0–100) = weighted sum of:
//            35% remaining edge (modelProb − effectiveCost)
//            25% extension quality (penalize as price approaches fair value)
//            20% holder profitability (eliteAvgRoi + holderProfit)
//            10% elite vs public dominance
//            10% exit safety (no smart-money flight)
//          stillTailPrice ∈ {YES, MAYBE, NO}
//
//        Hard zeros: edge≤0, rangeToFair≤0, extensionRatio≥1.
//        Filtering (Top Picks): hide if edge≤0, tailScore<50, extensionRatio≥1,
//        strong negative exit, or notional below the existing TOP_PICKS_MIN_NOTIONAL.
//        Ranking: rankScore = edge × confidence × liqFactor × (0.5 + tailScore/200).
//          tailScore=0 → 0.5×, 50 → 0.75×, 100 → 1.0×.
//        Tail-null sides (no elite cohort) pass through with neutral 1.0× and "Tail: n/a".
//
//        UI:
//        - Top Picks card adds Tail Winners line + Elite Entry → Current + Fair Value + Still tail-able.
//        - Prediction table adds Tail / Entry / Current / Fair / Extension / Reason columns.
//        - Small share-count cards now show market question + short conditionId on multi-market
//          events so repeated YES/NO panels are no longer ambiguous.
//        - Zero-signal cards (no elite, no sharp, no holderProfit, posPnl=0) hidden by default;
//          toggle button reveals them. New TUNING.SHOW_ZERO_SIGNAL_CARDS controls default.
//
//        New TUNING constants: TAIL_MIN_SCORE (50), TAIL_MAX_EXIT_PENALTY (-0.4),
//        SHOW_ZERO_SIGNAL_CARDS (false).
// v2.11.2 — Polishes the v2.11.1 hotfix: also guards NaN values in the score-breakdown
//           formatter (was only guarding null) and renders diagnostic-only rows with a
//           clean "(diag)" tag instead of a fake "× 0.00" multiplier.
// v2.11.1 — Hotfix: predDetails formatter crashed when rendering publicTrap because
//           the diagnostic isn't in TUNING.WEIGHTS (zero weight by design) and the
//           formatter called .toFixed() on the undefined weight. Now guards w → '0.00 (diag)'.
// v2.11 — Grading + safer eliteEdge + diagnostics. v2.10 weights frozen. Adds:
//        1. Niche multiplier on eliteEdge accumulation. NBA-focused elite
//           wallets now count 1.0× on NBA markets, 0.35× on different sports,
//           0.65× when either the wallet leagueFocus or the event league is
//           unknown. eventLeague is detected from slug + ev.title via the
//           existing LEAGUE_REGEX. Goal: a generic profitable trader with no
//           NBA history shouldn't dominate eliteEdge on an NBA prop.
//        2. Min-sample gate on eliteEdge. Returns null unless eliteWalletCount
//           >= 2 OR eliteNotional >= $7500. Stops a single small elite wallet
//           from producing a full +0.7 signal on a thin side.
//        3. eliteEdge diagnostics: per-side eliteAvgPnlAll, eliteAvgWinRate,
//           eliteAvgRoi, eliteShareNiche surfaced via rawMetrics return and
//           saved into predLog rows.
//        4. publicTrap diagnostic component (ZERO WEIGHT — not in
//           TUNING.WEIGHTS). Formula: -tanh((publicShare - eliteShare) * 2).
//           Displayed in predDetails + prediction table for grading correlation.
//           If grader confirms it predicts losses, we add weight in v2.12.
//        5. Closing price + CLV in predLog. The prices-history fetch already
//           pulls full series per token; now also stashes the last point as
//           latestPriceByToken[tokenId]. predLog rows get closingPrice + clv
//           (closingPrice - entryMarketPrice). Lets the grader compute true
//           closing-line-value across resolved markets.
//        6. gradePredictions() upgraded: edgeCaptured, calibrationGap,
//           avgConfidence, and per-component winner-vs-loser averages for
//           eliteEdge/walletEdge/holderProfit. The grading question is "do
//           v2.10 positive-edge picks beat market-implied probability."
//           No v2.9 comparison logic anywhere.
// v2.10 — PnL-first reweighting. Every component is ultimately a proxy for "this
//        wallet/group is making money." The cleanest version of the model
//        weights PnL-direct signals harder and PnL-indirect signals lighter.
//        Adds new `eliteEdge` component: tanh of (eliteNotional share differential
//        between this side and the others). Elite is already gated by isEliteFn
//        — pnlAll>$25k, volume>$100k, pnl/vol>15%, pnl30d≥0, pnl7d≥0, winRate>55%
//        — so it's the most direct PnL-validated wallet filter on the data.
//        Rebalanced WEIGHTS: PnL-direct components (eliteEdge, walletEdge,
//        holderProfit, consistency, exit) totaling ~0.66 (was 0.46). PnL-indirect
//        components (bookTilt, flow24h, insiderTiming, contrarian) trimmed to
//        ~0.15 total (was 0.29). sharpEdge dropped from 0.25 to 0.12 — still
//        useful as a PnL-gated archetype but the signal it adds beyond eliteEdge
//        is incremental. Total still ≈ 1.0; active-weight renorm handles drift.
//        ALL components retained — let SLOG grader tell us which to drop later
//        rather than guessing now.
// v2.9 — Cluster Intel (Phase 1: detect + display only, NO scoring impact).
//        Groups wallets that appear coordinated on the same market side based on
//        entry-price proximity, entry-timing proximity, archetype mix, and notional.
//        Per cluster: walletCount, totalNotional, avgEntry, currentPrice, unrealizedRoi,
//        archetype counts, timingSpan, qualityScore (weak/medium/strong). Displayed in
//        Research Mode as a "Cluster Intel" panel; logged to console as
//        [PM Sports clusters]. Uses existing data only (no new fetches).
//        Phase 2 (model weight): only after visual validation across 20–50 markets.
//        Phase 3 (cross-market memory): backend territory, requires storage.
// v2.8 — New `holderProfit` component. Captures whether sharp holders on
//        a side are sitting on better unrealized entry quality than public
//        holders on the same side — a dimension the existing 9 components
//        don't isolate (sharpEdge measures current notional, walletEdge
//        measures realized edge, CLV measures entry vs reference price).
//        Per side: weighted avg unrealized ROI for sharp bucket and
//        public+public_chase bucket (weighted by entryNotional). Score:
//        tanh((sharpAvgRoi − publicAvgRoi) × HOLDER_PROFIT_K). Skips when
//        either bucket is empty. No new fetches. Weight 0.05 starts modest
//        and is A/B-able by setting WEIGHTS.holderProfit = 0. Per side
//        only — the existing softmax handles side-vs-opponent comparison,
//        so doing it inside the component would double-count.
// v2.7.3 — Three small audit-cleanup fixes:
//          1. SLOG migration. v2.7.1 only wrote settled rows from THIS run
//             into pmsports_settled_v1. Historical resolved rows already in
//             PLOG would ring-evict before getting to SLOG. Now the SLOG
//             write scans the full merged buffer (this run + prior PLOG)
//             for resolved rows, so existing graded data migrates on the
//             first v2.7.3 run.
//          2. takerBaseFee parser boundary tightened. The v2.5 heuristic
//             treats anything >1 as basis-points, but gamma sometimes
//             returns 1.5 or 2.0 as percent encoding (1.5 = 1.5%). Now:
//             >5 is basis-points, 0.05–5 is percent, ≤0.05 is decimal.
//             Standard 1% fee unaffected; non-standard fees no longer
//             quietly mis-parsed to ~0% (which inflated edge).
//          3. Kelly comment corrected. v2.7.1 said "actionability gate
//             has a ≥0.50 confidence floor" — wrong. The actual gate is
//             edge × confidence ≥ TUNING.TOP_PICKS_MIN_EDGE_CONF (0.08).
//             The 0.50 floor only exists in the BET/LEAN row classifier.
// v2.7.2 — Default TUNING.DERIVE_WINDOW_PNL to FALSE.
//          Going 2/10 after a prior 8/8 streak under the v2.7 derivation
//          path is suspicious enough to roll back: activity.realizedPnl
//          and lb-api /profit?window=30d|7d are not the same number
//          (lb-api includes mark-to-market on still-open positions; the
//          activity sum doesn't). That bias propagated into the
//          consistency + walletEdge components and shifted picks. v2.7.1
//          only fixed the cap-bug — this rolls back the broader divergence
//          by reverting to the lb-api 8-call path everyone was using
//          through v2.6 (when the model was winning). 25% more wallet
//          requests, but pick logic matches what was working. Flip
//          DERIVE_WINDOW_PNL back to true if/when we restructure the
//          derivation to mirror lb-api's mark-to-market math.
// v2.7.1 — Correctness hotfix on top of v2.7:
//          1. Activity-cap fallback. When activity payload returns 500 rows,
//             the v2.7 derived 30d/7d PnL undercounts (capped to whatever
//             window 500 trades fits in). Now: when capped, fall back to
//             /profit?window=30d + /profit?window=7d for that wallet only.
//             Restores correctness on heavy-trader wallets at the cost of
//             ~10-15% of v2.7's saved API calls.
//          2. Settled-row persistence. PLOG ring-buffers at 500; settled
//             rows could evict before grading. New pmsports_settled_v1
//             localStorage key keyed by (cid,label) with a 5000-row cap
//             holds the canonical settled set. gradePredictions() reads
//             both logs, prefers SLOG. Also dedupes pre-settlement PLOG
//             duplicates so Brier doesn't inflate.
//          3. Comment near Kelly noting that confidence is intentionally
//             applied at both the actionability gate AND the stake size
//             — gate filters, Kelly multiplier sizes survivors. Don't merge.
// v2.7 — Tier 1 calibration + correctness pack (5 items from reviewer consensus):
//        1. gradePredictions() — PLOG_KEY was write-only; now the prediction log
//           can be scored (Brier, win-rate vs market, calibration, component
//           correlations). Exposed as window.pmsportsGrade() and as a "📊 Grade"
//           button on the Decision Summary.
//        2. 429 retry double-dip fixed in fetchHolders. Old path: up to ~4s of
//           exp backoff inside + another 5s outer re-queue = 9+s per rate-
//           limited market. New: 429 skips the inner retry (outer loop owns
//           it); 5xx/network still get fast local retry where they belong.
//        3. Profit-window calls collapsed. Dropped p30/p7 from the 8-wide
//           Promise.all per wallet; 30d/7d PnL derived from activity rows'
//           realizedPnl filtered by timestamp. Keeps window=all as ground
//           truth. TUNING.DERIVE_WINDOW_PNL gates the derivation for rollback.
//        4. Kelly variance haircut: f = confidence × edge / (1 − cost) instead
//           of edge / (1 − cost). Confidence already gates actionability and
//           ranks picks; now it scales stake too. Stakes on low-confidence
//           edges drop proportionally; high-confidence picks unchanged.
//        5. outcomePrices parsed via memoized WeakMap helper. Was parsed 4×
//           per market across isResolved/winnerOf/checkConsistency/parsedMarkets.
// v2.6 — Fail-counter cleanup + diagnostics. Previous fix (v2.5) only silenced
//        404s in safeFetch; safePost and fetchHolders still counted them, and
//        neither silenced 400/403/422 (also expected "no data" on some market/
//        wallet combinations — especially POST /books with an unverified body
//        shape). Now `isExpectedNoData(status)` shared across all three fetchers
//        returns a silent null for 400/403/404/422. After each load, a per-
//        endpoint + per-status fail breakdown is logged to console so any real
//        failures are visible ("[PM Sports] fail breakdown"). DataQuality
//        already stays at ~95% even with a few fails; this pack just reduces
//        the scary-looking badge.
// v2.5 — Hotfixes for three bugs visible in user screenshot:
//        1. COST pinned at 100¢ / EDGE deeply negative on every row. Root
//           cause: gamma's takerBaseFee is returned as a raw percentage (e.g.
//           1 → 1%) on some shapes, not a decimal (0.01). Treating it as
//           decimal gave `bestAsk × (1 + 1) = 2.0` → clamped to 1.00. Now
//           sanity-parsed: values > 1 treated as basis points (÷10000), > 0.1
//           as percent (÷100), fallback to 0.01 if anything above 5%.
//        2. Confidence pinned at 35% (CONFIDENCE_FLOOR) on most rows. The v1.9
//           sample-size multiplier tanh(n/8) × tanh(notional/$100k) collapsed
//           to near-zero on realistic prop markets. Now 0.5 + 0.5×tanh(n/3):
//           0.5 floor (non-sharp signals still produce confidence), saturates
//           near 1.0 at sharpCount ≥ 5.
//        3. "185 fails" badge from expected 404s on /prices-history,
//           /comments, /closed-positions, /oi for data-missing markets/wallets.
//           safeFetch now treats 404 as a silent null return, not a failure.
// v2.4 — Hotfix for v2.3 rate-limit trip. Parallel holder-fetch batch of 6
//        + 200ms spacing exceeded Polymarket /holders RPS limit on events
//        with 20+ sub-markets — screenshot showed "Retrying 21 failed
//        markets" on Knicks vs Hawks scale. fetchHolders' internal retry
//        couldn't drain cleanly because all 6 kept retrying simultaneously.
//        Reduced to 3 parallel + 400ms spacing (safe per observed RPS of
//        the retry pass). Still ~2× faster than pre-v2.3 serial loop.
//        Batch size and spacing now in TUNING so user can lower further
//        without a code edit: HOLDER_FETCH_BATCH, HOLDER_FETCH_SPACING_MS.
// v2.3 — Prop-aware classifier + speedup + thin-event gate + OI conviction.
//        Reviewer follow-up. Four targeted fixes:
//        - getMarketProfile(question, sportKey): per-market sharp gates so
//          props (Brunson Rebounds O/U 3.5) aren't held to the same $25k
//          lifetime PnL bar as moneylines. Props: $3k / 58% winrate / 15-min
//          insider window. Derivatives (1H/quarter): $5k / 56%. Was the root
//          cause of "0 sharp · 0 insider · 0 late-edge" on prop panels — the
//          classifier was filtering everyone out by construction.
//        - Holder fetches now parallel-batched (6 markets at a time) instead
//          of serial. ~Halves load time on multi-market events.
//        - Event-volume quality gate (TUNING.MIN_EVENT_VOLUME = 50000):
//          skip events with < $50k total volume early; render a clear
//          "too thinly traded" card instead of running noisy predictions.
//          Bypassed for resolved events (retrospective view should still work).
//        - /oi (open interest) wired into confidence as a soft conviction
//          multiplier. heldRatio = min(1, observedNotional / oi); confidence
//          × (OI_CONVICTION_FLOOR + (1 − floor) × heldRatio). Floor 0.85,
//          so worst case is a 15% confidence haircut when most money is
//          trading through rather than held.
//        New TUNING constants: MIN_EVENT_VOLUME, OI_CONVICTION_FLOOR.
// v2.2 — Decision-engine UX. No math changes. Restructures the dashboard
//        around the question "should I bet on this event?" so absence-of-
//        edge no longer looks identical to abundance-of-data:
//        - New "Decision Summary" card as the first element on the page.
//          Green border + "N actionable bets" when picks exist. Grey border
//          + "No actionable bets" + near-miss line when nothing qualifies.
//          Explains the decision at a glance.
//        - Research mode: warn banner, consistency panel, streak, share-
//          count cards, toolbar, prediction table, rollup, holder grid, and
//          exits are all wrapped in a single <details> element, collapsed
//          by default. Click to expand when you want to dig in.
//        - Prediction table rows now color-coded by actionability (not by
//          Yes/No side): BET (green) / LEAN (amber) / PASS (dim red) /
//          FADE (grey) / SETTLED (blue). PASS and FADE hidden by default;
//          footer button expands them.
//        New TUNING constants: TABLE_BET_EDGE (0.02), TABLE_LEAN_EDGE
//        (0.01), TABLE_FADE_EDGE (−0.02).
// v2.1 — New features + polish. Three additions:
//        - NEW `contrarian` component (weight 0.05): fade-the-public signal.
//          contrarian = −tanh((publicShare − oppMean(publicShare)) × 2). Negative
//          when public + public_chase archetypes dominate this side vs opponent.
//          Taken 0.03 from flow24h (most correlated) and 0.02 from insiderTiming.
//          Sum of 9 component weights still 1.00.
//        - Fractional Kelly on Top Picks cards: f* = edge / (1 − effectiveCost);
//          display is quarter-Kelly (TOP_PICKS_KELLY_MULT = 0.25), capped at 10%
//          of bankroll for sanity. Answers "how much should I bet" directly.
//        - Comments API scan per market (gamma /comments?market=<cid>). Keyword
//          scan for injury/lineup/weather/scratch terms; hits surface as a news
//          alert badge on Top Picks cards. Display-only, not a scoring component
//          (too noisy to weight without calibration).
//        New TUNING constant: TOP_PICKS_KELLY_MULT.
// v2.0 — Scale & time adaptivity + API expansions. Reviewer follow-through:
//        - K2 (flow24h $ scale) now adaptive per side notional — mirrors K1's
//          approach. TUNING.K2_BASE + K2_SIDE_FRACTION replace static K2.
//        - Time decay on flow24h and insiderTiming — 6h half-life multiplier
//          using market.startDate. Game-day signals dominate; week-out flow
//          contributes less.
//        - Exit signal reworked: was a wallet count above $5k pnl threshold
//          with a 72h window. Now quality-weighted sum: walletQuality (tanh of
//          pnl/\$50k × winRate) × netSold × timeWeight (1.0 ≤24h, 0.5 24–72h).
//          K3 rescaled 10 → 5000 to match new magnitude.
//        - New `clv` component (weight 0.10): TRUE closing-line-value from
//          /prices-history. Reference price = N hours before game start (or
//          now−24h if start unknown). Per-wallet CLV = refPrice − avgPrice,
//          notional-weighted to side level. Weights rebalanced across 8
//          components: sharpEdge 0.25, walletEdge 0.20, flow24h 0.15, clv 0.10,
//          consistency 0.08, exit 0.08, bookTilt 0.08, insiderTiming 0.06.
//        - /oi endpoint integration (data-api): single call returning market-
//          wide open interest. Stored per conditionId for display and future
//          conviction filtering.
//        - /closed-positions per wallet added to Promise.all in loadWallet.
//          When populated, provides unbiased win-rate (replaces activity-cap-
//          derived winRate). Falls back to activity-derived if empty.
//        - POST /books batch: one roundtrip for all tokens instead of N
//          parallel GETs. Graceful fallback to per-token GETs if the batch
//          response shape isn't what we expect.
//        New TUNING constants: K2_BASE, K2_SIDE_FRACTION (replace K2),
//        TIME_DECAY_HALF_LIFE_HRS, CLV_REF_HOURS_BEFORE_START.
// v1.9 — Edge-bug fix pack. External review uncovered that Top Picks ranked by
//        2×|prob−0.5| (distance from coin-flip), not abs(prob−marketPrice)
//        (actual disagreement with market). Fixed: edge is now SIGNED, measured
//        against the side's bestAsk with fallback to lastTradePrice and
//        outcomePrices, and factored through takerBaseFee (default 1%) to use
//        the true fillable cost. Picks with edge ≤ 0 are skipped (market already
//        agrees or disagrees stronger than our model). Also:
//        - Renamed `clv` predictor component to `walletEdge` (truth in labeling:
//          we measure capital-weighted realized ROI, not closing-line-value).
//          Weight unchanged at 0.22.
//        - sharpEdge now counts only `archetype === 'sharp'` (was sharp +
//          insider_like + late_edge), making insiderTiming genuinely orthogonal.
//        - Confidence now multiplied by tanh(sharpCount/8)×tanh(sharpNotional/$100k);
//          thin-sample predictions are no longer as confident as deep-sample ones.
//        - Added book bestBid/bestAsk to bookByToken (previously only tilt/depth).
//        - Predictions logged per render to console as `[PM_PRED_LOG]` and to
//          localStorage ring buffer (last 500) for offline calibration of ALPHA.
// v1.8 — Actionable prediction UI. Top Picks strip at the top of the dashboard
//        ranks favored-side-per-market by edge × confidence × liquidity and
//        surfaces the 2-3 plays worth acting on, each card showing pick, prob,
//        conf, edge in pp, liquidity, and top-2 contributing components. Prediction
//        table now sorted by score descending with favored side only on live markets
//        (both sides retained on settled markets for retrospective comparison).
//        Push rows (edge × conf below TOP_PICKS_MIN_EDGE_CONF) faded to 45% opacity
//        to deemphasize non-actionable rows. New TUNING.TOP_PICKS_COUNT/MIN_EDGE_CONF/
//        MIN_NOTIONAL constants control surfacing behavior. No model/weight/fetch changes.
// v1.7 — IC-weighted recalibration (no structural changes, pure reweighting).
//        Audit found CLV (entry-quality) carried 0.15 despite being the highest-IC
//        long-run signal in sports-betting literature; insiderTiming (0.09) is a
//        subset of sharpEdge's archetype union (sharp + insider_like + late_edge)
//        and partly double-counted. Reallocation: clv 0.15→0.22, insiderTiming
//        0.09→0.06, sharpEdge 0.30→0.28, flow24h 0.18→0.17, consistency 0.11→0.09,
//        bookTilt 0.08→0.09, exit unchanged. Sum still 1.00. No formula or
//        component changes; score/softmax/renorm logic untouched.
// v1.6 — Prompt B: book imbalance → bookTilt predictor component.
//        One clob.polymarket.com/book?token_id=<tok> call per unique token in the event.
//        Computes top-5-level CLOB imbalance tilt = (bidVol$ − askVol$)/total ∈ [−1,+1].
//        New component weight 0.08; existing weights redistributed to keep sum = 1.00
//        (sharpEdge 0.32→0.30, flow24h 0.20→0.18, clv 0.16→0.15, consistency 0.12→0.11,
//        exit 0.10→0.09, insiderTiming 0.10→0.09). Component skipped when book is null
//        (settled markets, closed books) — renorm handles gracefully. Prediction rollup
//        gains a Book column; panel score-breakdown adds a BookTilt row.
// v1.5 — Prompt C: trades endpoint for Flow24h.
//        One /trades?market=<cid>&limit=500 call per market; builds tradesByToken map
//        of {side, size, price, timestamp, wallet} records. Flow24h component in the
//        predictor now sums Σ ±size×price over trades in last 24h (BUY +, SELL −),
//        captured from the entire tape rather than top-N holders only. Closes the
//        coverage gap where wallets outside the top holders contributed flow
//        invisibly. Also exposes trades24hCount per side for future use.
// v1.4 — Live-market hotfix from Rockets vs Lakers screenshot:
//        - Holders fetch now has per-market status tracking + automatic retry pass after 5s
//          delay (helps with 429 rate-limit bursts on 10+ market events). Failed markets'
//          status codes (429 / 404 / etc) surfaced directly in the warn banner.
//        - Sharp classifier relaxed: entryQuality > -0.15 (was > 0) tolerates wallets in a
//          current drawdown, and a veteran-sharp fallback (pnlAll > 4×gate AND winRate > 0.50
//          regardless of CLV) catches proven long-run edge holders. Addresses "0 sharp on
//          680 NBA traders" diagnostic.
//        - Analytical settlement PnL fallback: when /positions drops settled rows AND the
//          activity cache doesn't contain the redeem entry (COLD_CACHE_SLICE=100 too small),
//          compute posPnl = size × (isWinner ? 1 : 0) - size × avgPrice analytically from the
//          still-visible position metadata. No more $0 on winning/losing settled holders.
// v1.3 — Two bug fixes surfaced by Valorant settled-event screenshot:
//        (1) Side-key collision on multi-market events: sides now keyed by conditionId|label
//            (was: label only). Multi-market events (team-vs-team + map-by-map + totals etc.)
//            where all sub-markets share outcome names (NAVI Junior / Team Liquid Academy etc.)
//            no longer silently drop 5 of 6 markets. Rollup and grid show per-(market,side) rows
//            with market question subtitle in panel header and a Market column in the rollup.
//        (2) Resolved-market awareness: isResolved() + winnerOf() helpers detect settlement via
//            market.closed or outcomePrices ∈ {[1,0],[0,1]}. Settlement banner above consistency
//            panel with per-market winner list. Predictor table header shows '(retrospective)'.
//            Holder-side panels get ✓won/lost badges and post-settlement holder-count note. Per-
//            market posPnl backfilled from cached activity.realizedPnl when /positions drops
//            settled rows (= $0 was the symptom).
// v1.2 — Cross-market consistency panel (Prompt A). Scans ev.markets for implied-probability
//        violations: handicap exceeding moneyline (impossible), totals sum ≠ 100¢. Zero new
//        fetches — uses outcomePrices already on the gamma event payload. Renders above cards,
//        auto-opens when any violation detected.
// v1.1 — Prediction engine: 6-component score (SharpEdge/Flow24h/CLV/Consistency/Exit/InsiderTiming)
//        with softmax within conditionId, DataQuality-weighted confidence. Archetype classifier
//        expanded to 7 labels. Hot/cold cache split with quota eviction. Holders fetch goes through
//        safeFetch with per-market failure warnings. Exits moved pre-render for per-side
//        attribution. Streak now uses archetype-based wallet selection. TUNING constants block.
// v1.0 — Initial sports fork: sharp/MM/bot/public archetypes, entryQuality, inventoryRatio,
//        leagueFocus, sports-mode config.

(function(){
  const BTN_ID = 'pm-sports-money-btn';
  // >>> KEEP IN SYNC with @version in the userscript header at the top of this file.
  // >>> SCRIPT_VERSION drives the button label, dashboard header sub-line, and loading caption.
  // >>> Tampermonkey reads @version; the in-page UI reads SCRIPT_VERSION. They MUST match,
  // >>> otherwise Tampermonkey says "v2.18" while the page shows "v2.17" (this is what
  // >>> caused v2.18.1's hotfix). SPORTGPT detection looks for an external layer that may
  // >>> attach window.SPORTGPT_VERSION / window.sportGPTVersion / window.SPORTGPT.version.
  const SCRIPT_VERSION = '2.35.0';
  // v2.18.1: confirm version in devtools immediately on page load — independent of UI render.
  try { console.log('[PM Sports] script loaded · v' + SCRIPT_VERSION + ' on ' + location.href); } catch(_){}
  // v2.21: surfaced inside the 📊 Grade modal under a "📜 Version history" collapsible.
  // Dates intentionally stay short labels — git-log dates aren't reliably available at runtime
  // and embedding them here would rot. Rolling 3-row window per spec.
  const VERSION_HISTORY = [
    { version: '2.35.0', date: 'recent', weightDeltas: 'none', tuningSummary: 'Scan-speed phase 6: adaptive turbo concurrency 48 with fail429 auto-rollback. Transport-only, no math/decision changes.', notes: 'Pure transport-layer change. (1) MAX_DYNAMIC_BATCH 32→48 (TURBO_MAX_DYNAMIC_BATCH); SAFE_MAX_DYNAMIC_BATCH=32 (known-good v2.33.0 ceiling); TURBO_FAIL429_ROLLBACK=true (master switch). HOLDER_FETCH_SPACING_MS stays 0; HOLDER_FETCH_BATCH floor stays 6. (2) endWave ramp accelerated when network is quiet: rate===0 AND mon.fail429===0 → currentBatch += 6 (was +3); rate<0.02 → +3 (was +2); rate<0.05 → +1 (unchanged). Drop deepened: rate>0.20 → -4 (was -2), floored at HOLDER_FETCH_BATCH. (3) One-shot fail429 auto-rollback: as soon as mon.fail429>0 during a scan, the effective ceiling collapses to SAFE_MAX_DYNAMIC_BATCH=32 for the rest of that scan, currentBatch is clamped immediately if above, and a single "[PM Sports] Turbo rollback: fail429 detected, capping batch to 32" line is logged. Per-endpoint 429 cooldown (v2.30.0) remains the independent secondary safety net. (4) New diagnostics in end-of-run log: maxBatchReached, turboRollbackTriggered, fail429, realFails, totalScanMs. Surfaced both in the [PM Sports] timings line and the [PM Sports] v2.13 perf object. No changes to: prediction math, modelProb, p.probability, p.confidence, p.score, TUNING.WEIGHTS, TUNING.ALPHA, K1/K2/K3, softmax, gradeSide thresholds, GRADE_* knobs, classifyAction, classifyMarketType, marketEdgeFor, Top Picks selection, Top Picks ranking, alert types, alert dedup keys, alert thresholds, buildBotExport schema, schemaVersion (stays 1), tokenId, conditionId, sideKey, wallet scoring, archetype classification, elite detection, fetch URL construction, request bodies, cache keys/TTLs/semantics, DERIVE_WINDOW_PNL (stays false), TopN (stays 200 for Deep), wallet-notional filtering (not introduced). Single-line revert path: MAX_DYNAMIC_BATCH 48→32 + endWave deltas back to +3/+2/+1 / -2 if turboRollback fires routinely.' },
    { version: '2.34.1', date: 'recent', weightDeltas: 'none', tuningSummary: 'classifyMarketType bug fix: dota-2 sportKey + Game-N esports_map detection', notes: 'Two targeted classifier fixes inside classifyMarketType() only. (1) Add "dota-2" (Polymarket slug format) to the ESPORTS set alongside existing "dota" and "dota2". (2) Extend the esports_map regex to catch per-game series sub-units — "\\bgame\\s*[1-5]\\b", "\\bgame\\s*(one|two|three|four|five)\\b", and "game\\s*\\d\\s+winner" — so "Game 1 Winner" / "Game 2 Winner" / "Game 3 Winner" markets in LoL / CS2 / Dota2 series classify as esports_map (and inherit the v2.34.0 GRADE_CAP_MAP = B cap) instead of being miscategorized as esports_match (which could earn A+/A). Pure classifier-string fix; no impact on modelProb, p.probability, p.confidence, p.score, components, weights, ALPHA, K1/K2/K3, softmax, Top Picks ranking, alert thresholds, alert dedup keys, action logic, gradeSide thresholds, schemaVersion (stays 1), or any fetch/cache/wallet-scoring/transport behavior.' },
    { version: '2.34.0', date: 'recent', weightDeltas: 'none', tuningSummary: 'Decision Grades: scan-time letter grade (A+/A/B/C/PASS) layered on top of the v2.2 BET/LEAN/PASS/FADE action classifier', notes: 'New execution-layer dimension that complements (does not replace) the existing classifyAction. Pure display + bot-export field; does NOT touch modelProb, p.probability, p.confidence, p.score, components, weights, Top Picks ranking formula, Tail Winners scoring, alert thresholds, alert dedup keys, action logic, tokenId, conditionId, sideKey, or schemaVersion (stays 1; grade/gradeReasons are additive). New gradeSide({...}) function consumes already-computed per-side signals — action, edge, confidence, modelProb, totalNotional, holderCount, marketType, tailScore, extensionRatio, exitSignal, smartMoneyDumping — and emits a letter grade plus a reasons[] array explaining downgrades. Grade is scan-time only (uses the full liquidity / holder / market-type context); live-tick grade deferred to a future minor to keep dashboard and live-state consistent. New TUNING knobs (all execution-layer, no prediction-math impact): GRADE_NOTIONAL_A_PLUS (75k), GRADE_NOTIONAL_A (40k), GRADE_NOTIONAL_B (20k), GRADE_HOLDERS_A_PLUS (40), GRADE_HOLDERS_A (25), GRADE_HOLDERS_B (12), GRADE_TAIL_A_PLUS (65), GRADE_TAIL_A (50; matches TAIL_MIN_SCORE), GRADE_PROB_FLOOR (0.10), GRADE_PROB_CEIL (0.92), GRADE_PROB_A_PLUS_FLOOR (0.20), GRADE_PROB_A_PLUS_CEIL (0.85), GRADE_CAP_PROP (B), GRADE_CAP_MAP (B), GRADE_CONFLICT_BLOCKS_A_PLUS (true). EVENT DECISION banner in the dashboard header now highlights only A+/A picks (the previous "N actionable bets" pill counted every LEAN spot, which over-spotlighted thin-liquidity LEANs). LEAN action always caps at grade B regardless of other signals. FADE / PASS / weird-price (modelProb outside [0.10, 0.92]) auto-grade PASS. Rollup table rows gain a small grade badge in the Side cell. Bot export topPicks[].grade, topPicks[].gradeReasons, sides[].grade, sides[].gradeReasons added; decisionSummary gains aPlusCount, aCount, bCount, cCount, passCount aggregates. No changes to: classifyAction, gradePredictions (backtest grader, separate concern), Top Picks selection gates (still edge×conf ≥ 0.08, notional ≥ 25k, tail ≥ 50), alert types, alert dedup keys, modelProb math, weights, ALPHA, or schemaVersion (stays 1).' },
    { version: '2.33.0', date: 'recent', weightDeltas: 'none', tuningSummary: 'Scan-speed phase 5: concurrency 32 / 0ms spacing', notes: 'v2.32.0 shipped with no 429s observed in production, so the wallet/holders phases get pushed further. MAX_DYNAMIC_BATCH 24→32; HOLDER_FETCH_SPACING_MS 50→0ms; wallet-phase and exit-backfill inter-batch sleeps 50→0ms (effectively yields the event loop only). Floor (HOLDER_FETCH_BATCH=6) and endWave ramp (+3/+2/+1 at 0%/2%/5% failure) unchanged — the failsafe still drops -2 per wave on >20% failure rate and bottoms at the floor. Per-endpoint 429 cooldown remains the primary rate-limit safety net. Single-line revert to 24/50 on each knob if fail429 climbs. No prediction math, weights, modelProb, p.probability, p.confidence, p.score, Top Picks ranking, Tail Winners scoring, alert thresholds, action logic, tokenId, conditionId, sideKey, schemaVersion, or alert dedup keys changes. DERIVE_WINDOW_PNL stays false. No wallet-notional threshold.' },
    { version: '2.32.0', date: 'recent', weightDeltas: 'none', tuningSummary: 'Scan-speed phase 4: concurrency 24/50ms, /comments deferred off critical path, AbortController on re-scan', notes: 'Three transport-layer cuts, zero math changes. (1) MAX_DYNAMIC_BATCH 16→24 + HOLDER_FETCH_SPACING_MS 150→50ms + wallet-phase and exit-backfill inter-batch sleeps 100→50ms — per-endpoint 429 cooldown is the primary rate-limit safety net; reactive -2 throttle and fast-ramp endWave() handle spikes. (2) /comments IIFE removed from subfetchPromises[] await — comments populate display-only alertsByCid (no prediction component reads it); on slow comments scans, predictions/render no longer wait, badges miss this scan but reappear next scan via cache. (3) AbortController per-scan: re-clicking Scan now aborts in-flight fetches from the stale scan instead of running two scans in parallel — exposed via scanAbortsTotal counter in end-of-run log. DERIVE_WINDOW_PNL stays false (v2.7.2 rollback documented picks shifted for the worse — mark-to-market on open positions missing from derivation). No wallet-notional threshold. No prediction math, weights, modelProb, p.probability, p.confidence, p.score, Top Picks ranking, Tail Winners scoring, alert thresholds, action logic, tokenId, conditionId, sideKey, schemaVersion, or alert dedup keys changes.' },
    { version: '2.31.0', date: 'recent', weightDeltas: 'none', tuningSummary: 'Scan-speed phase 3: parallel market-activity fetch, session L1 cache, faster concurrency ramp, higher concurrency ceiling', notes: 'Six transport-layer optimizations. (1) Market-activity fetches for exit detection moved from a serial for...of loop to Promise.all inside subfetchPromises[], running in parallel with the wallet phase and backed by a 2-min short-TTL cache (MARKET_ACTIVITY_PREFIX). On a 15-market event this removes up to 15 sequential round-trips from the critical path. (2) In-memory L1 session Map (sessionShortCache) added in front of localStorage for all cacheGetShort/cacheSetShort calls — eliminates hundreds of synchronous JSON.parse/stringify ops per run on large events. (3) HOLDER_FETCH_SPACING_MS reduced 400ms→150ms; v2.30 per-endpoint 429 cooldown is now the primary rate-limit safety net. (4) endWave() concurrency ramp gains two faster branches: +3 at 0% failure rate, +2 below 2% failure rate (was flat +1 below 5%). (5) MAX_DYNAMIC_BATCH ceiling raised 12→16. (6) New diagnostic counters: marketActivityCacheHits, sessionCacheHits. No prediction math, weights, modelProb, p.probability, p.confidence, p.score, Top Picks ranking, Tail Winners, alert thresholds, action logic, tokenId, conditionId, or sideKey changes. Same prediction-math safety filter as v2.21–v2.30 (zero matches). TopN 200 (Deep) unchanged.' }
  ];
  try { if (typeof window !== 'undefined') window.pmsportsVersionHistory = VERSION_HISTORY; } catch(_){}

  // v2.29.0 / v2.29.1: side normalization layer. Pure helpers — no state, no DOM, safe to
  // call anywhere. Polymarket exposes O/U markets with Yes/No outcomes (humans read them as
  // Over/Under <line>) and spread markets where one side is the bare opposing team name
  // (humans read those as "<team> ± <line>"). Every internal matcher (alert dedup, DOM click
  // lookup, settlement winner equality, outcomeIndex, sideKey identity) MUST keep using
  // rawSide. Only thread displaySide through human-facing UI sinks.

  // v2.29.1: loose team-name comparator. Lowercases, strips punctuation, collapses
  // whitespace. Lets "St. Louis Cardinals" match "St Louis Cardinals" or any stray Polymarket
  // quoting/spacing oddity.
  function normalizeName(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // v2.29.1: signed-line formatter. "+1.5" / "-1.5" / "0". Keeps the real minus sign.
  function formatSignedLine(n) {
    if (n > 0) return '+' + n;
    if (n < 0) return String(n);
    return '0';
  }

  function normalizeDisplaySide(marketQuestion, sideLabel) {
    const raw = String(sideLabel == null ? '' : sideLabel).trim();
    const q   = String(marketQuestion == null ? '' : marketQuestion);
    const ql  = q.toLowerCase();
    const rl  = raw.toLowerCase();

    // v2.29.1: Spread market branch. Detected first so a team name that happens to contain
    // "over"/"under" can't accidentally fall through to the O/U branch. Pattern:
    //   "Spread: <team> (<sign><number>)" → favoriteTeam + favoriteLine.
    // The other outcome gets -favoriteLine. sideType: "spread_favorite" when sideLine < 0,
    // "spread_underdog" when > 0, "spread_pickem" on the (theoretical) 0 edge case.
    const spreadMatch = q.match(/spread:\s*(.+?)\s*\(([+\-]?\d+(?:\.\d+)?)\)/i);
    if (spreadMatch && raw) {
      const favoriteTeam = spreadMatch[1].trim();
      const favoriteLine = parseFloat(spreadMatch[2]);
      if (!isNaN(favoriteLine)) {
        const sideLine = (normalizeName(raw) === normalizeName(favoriteTeam))
          ? favoriteLine
          : -favoriteLine;
        let sideType;
        if (sideLine < 0) sideType = 'spread_favorite';
        else if (sideLine > 0) sideType = 'spread_underdog';
        else sideType = 'spread_pickem';
        const displaySide = sideLine === 0 ? raw : (raw + ' ' + formatSignedLine(sideLine));
        return { rawSide: raw, displaySide: displaySide, line: sideLine, sideType: sideType };
      }
    }

    const isOU = /\b(o\/u|over\/under)\b/.test(ql)
              || /\bover\s+[+\-]?\d/.test(ql)
              || /\bunder\s+[+\-]?\d/.test(ql);
    let line = null;
    if (isOU) {
      let m = ql.match(/(?:o\/u|over\/under)\s*([+\-]?\d+(?:\.\d+)?)/);
      if (!m) m = ql.match(/(?:over|under)\s*([+\-]?\d+(?:\.\d+)?)/);
      if (m) line = parseFloat(m[1]);
      const lm = raw.match(/^(over|under)\s*([+\-]?\d+(?:\.\d+)?)/i);
      if (lm) line = parseFloat(lm[2]);
    }
    let sideType, displaySide;
    if (isOU) {
      if (rl === 'yes' || rl === 'over' || /^over\b/.test(rl)) {
        sideType = 'over';
        displaySide = (line != null) ? ('Over ' + line) : 'Over';
      } else if (rl === 'no' || rl === 'under' || /^under\b/.test(rl)) {
        sideType = 'under';
        displaySide = (line != null) ? ('Under ' + line) : 'Under';
      } else {
        sideType = 'other';
        displaySide = raw;
      }
    } else if (rl === 'yes') {
      sideType = 'yes';   displaySide = 'Yes';
    } else if (rl === 'no') {
      sideType = 'no';    displaySide = 'No';
    } else {
      sideType = 'team';  displaySide = raw;
    }
    return { rawSide: raw, displaySide: displaySide, line: line, sideType: sideType };
  }

  function getSportGPTVersion(){
    try {
      if (typeof window === 'undefined') return null;
      if (window.SPORTGPT_VERSION) return String(window.SPORTGPT_VERSION);
      if (window.sportGPTVersion) return String(window.sportGPTVersion);
      if (window.SPORTGPT && window.SPORTGPT.version) return String(window.SPORTGPT.version);
      return null;
    } catch(_) { return null; }
  }
  function buttonLabel(){
    const sgpt = getSportGPTVersion();
    return sgpt
      ? '🏟️ SPORTGPT v' + sgpt + ' · Sports Money v' + SCRIPT_VERSION
      : '🏟️ Sports Money v' + SCRIPT_VERSION;
  }
  console.log('[PM Sports] userscript loaded on', location.href);

  function shouldShow(){
    const segs = location.pathname.split('/').filter(Boolean);
    if (!segs.length) return false;
    const head = segs[0], last = segs[segs.length-1];
    if (!last.includes('-')) return false;
    if (head === 'sports'  && segs.length >= 3) return true;
    if (head === 'esports' && segs.length >= 3) return true;
    return false;
  }

  function inject(){
    if (!shouldShow()) {
      const e = document.getElementById(BTN_ID); if (e) e.remove(); return;
    }
    if (document.getElementById(BTN_ID)) return;
    if (!document.body) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = buttonLabel();   // v2.17: includes version + optional SPORTGPT prefix
    // v2.22: translucent button. Replaced solid orange→green gradient with a translucent
    // dark base + subtle orange brand outline + backdrop-filter blur so the text stays
    // legible over busy event pages while letting the page show through. Hover state
    // bumps opacity for clear interactivity feedback.
    btn.style.cssText = 'position:fixed!important;bottom:24px!important;right:84px!important;z-index:2147483647!important;padding:12px 18px!important;background:rgba(18,18,26,0.45)!important;color:#ffb380!important;border:1px solid rgba(255,140,66,0.55)!important;border-radius:10px!important;font-weight:700!important;font-size:14px!important;cursor:pointer!important;box-shadow:0 4px 14px rgba(0,0,0,.35)!important;font-family:system-ui,sans-serif!important;backdrop-filter:blur(8px)!important;-webkit-backdrop-filter:blur(8px)!important;transition:background 0.2s ease,border-color 0.2s ease!important';
    btn.onmouseenter = () => { btn.style.background = 'rgba(18,18,26,0.75)'; btn.style.borderColor = 'rgba(255,140,66,0.9)'; };
    btn.onmouseleave = () => { btn.style.background = 'rgba(18,18,26,0.45)'; btn.style.borderColor = 'rgba(255,140,66,0.55)'; };
    btn.onclick = run;
    document.body.appendChild(btn);
    console.log('[PM Sports] button injected');
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(inject, 300); }
    if (shouldShow() && !document.getElementById(BTN_ID)) inject();
  }).observe(document.documentElement, {childList:true, subtree:true});

  inject();
  setTimeout(inject, 500);
  setTimeout(inject, 2000);

  // v2.23: shared 0..1 clamp used by the Phase-1 cluster qualityScore sub-scores. Not a
  // refactor of existing ad-hoc Math.max(0,Math.min(1,…)) call sites — keeping the diff
  // surface area small so the prediction-math safety filter stays easy to read.
  const clamp01 = x => Math.max(0, Math.min(1, x));

  // v2.24 Phase 2A: cross-event recurring-group memory helpers. localStorage-backed,
  // display-only — never feed prediction math, modelProb, Top Picks, Tail Winners, or
  // alerts. Memory shape: { v:1, cachedAt, data: { [groupKey]: {appearances, events[], lastSeen} } }.
  // Decay (drop unseen for 12h) + size cap (5000 entries) applied at load time so the
  // returned mem object is already pruned.
  function loadRecurringGroups() {
    // v2.24.1: returns { mem, loaded, active, decayed, capped } so the enrichment pass
    // can log diagnostic counters. `loaded` is the raw count read from localStorage
    // before any pruning; `active` is what survives the 12h decay + 5000-cap and is
    // queryable this run. No behavior change — same decay + cap logic as v2.24.
    let mem = {};
    try {
      const raw = localStorage.getItem(TUNING.RECURRING_GROUPS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === 1 && parsed.data) mem = parsed.data;
      }
    } catch(_) { mem = {}; }
    const loaded = Object.keys(mem).length;
    let decayed = 0;
    const now = Date.now();
    Object.keys(mem).forEach(k => {
      if (!mem[k] || (now - (mem[k].lastSeen || 0)) > TUNING.RECURRING_GROUP_DECAY_MS) {
        delete mem[k];
        decayed += 1;
      }
    });
    let capped = 0;
    const keys = Object.keys(mem);
    if (keys.length > TUNING.RECURRING_GROUP_MAX) {
      keys.sort((a, b) => (mem[a].lastSeen || 0) - (mem[b].lastSeen || 0));
      const drop = keys.slice(0, keys.length - TUNING.RECURRING_GROUP_MAX);
      drop.forEach(k => { delete mem[k]; capped += 1; });
    }
    const active = Object.keys(mem).length;
    return { mem, loaded, active, decayed, capped };
  }

  function touchRecurringGroup(mem, key, eventSlug) {
    if (!key || !eventSlug) return null;
    let entry = mem[key];
    if (!entry) {
      entry = mem[key] = { appearances: 0, events: [], lastSeen: 0 };
    }
    entry.appearances += 1;
    if (entry.events.indexOf(eventSlug) < 0) entry.events.push(eventSlug);
    entry.lastSeen = Date.now();
    return entry;
  }

  function saveRecurringGroups(mem) {
    try {
      localStorage.setItem(TUNING.RECURRING_GROUPS_KEY, JSON.stringify({
        v: 1,
        cachedAt: Date.now(),
        data: mem
      }));
    } catch(_) {
      // localStorage disabled/quota full: ignore. Cluster recurrence is display-only,
      // so in-memory state for this session is sufficient — next page load will recompute.
    }
  }

  // v2.26 Phase 2 Part 2: per-(wallet, marketType) specialization memory. Display + log only —
  // never read by prediction math, modelProb, weights, Top Picks, Tail Winners, or alerts.
  // Same JSON envelope as recurring-groups; 30-day decay on lastUpdated; 10000-entry cap.
  function loadWalletSpecialization() {
    let mem = {};
    try {
      const raw = localStorage.getItem(TUNING.SPECIALIZATION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === 1 && parsed.data) mem = parsed.data;
      }
    } catch(_) { mem = {}; }
    const now = Date.now();
    Object.keys(mem).forEach(k => {
      if (!mem[k] || (now - (mem[k].lastUpdated || 0)) > TUNING.SPECIALIZATION_DECAY_MS) {
        delete mem[k];
      }
    });
    const keys = Object.keys(mem);
    if (keys.length > TUNING.SPECIALIZATION_MAX) {
      keys.sort((a, b) => (mem[a].lastUpdated || 0) - (mem[b].lastUpdated || 0));
      keys.slice(0, keys.length - TUNING.SPECIALIZATION_MAX).forEach(k => delete mem[k]);
    }
    return mem;
  }

  function saveWalletSpecialization(mem) {
    try {
      localStorage.setItem(TUNING.SPECIALIZATION_KEY, JSON.stringify({
        v: 1, cachedAt: Date.now(), data: mem
      }));
    } catch(_) {
      // localStorage disabled / quota full: ignore. In-memory state still works for this session.
    }
  }

  // v2.26: per-wallet specialization score. Display-only formula:
  //   score = clamp01(0.50·normalized_avgCLV + 0.30·positiveCLVRate + 0.20·notionalConfidence) * 100
  //   - normalized_avgCLV = clamp01((avgCLV + 0.03) / 0.08)
  //   - positiveCLVRate   = positiveClvCount / samples
  //   - notionalConfidence= clamp01(log10(totalNotional + 1) / 5)
  // Labels: ≥75 strong, 55–75 useful, <55 weak, null = low sample (samples < MIN_SAMPLES).
  // Returns all six fields on every call so callers can render partial info on low-sample entries.
  function walletSpecializationScore(entry) {
    if (!entry || (entry.samples || 0) < TUNING.SPECIALIZATION_MIN_SAMPLES) {
      return {
        score: null, label: 'low sample',
        avgCLV: null, positiveCLVRate: null,
        samples: entry ? (entry.samples || 0) : 0,
        totalNotional: entry ? (entry.totalNotional || 0) : 0
      };
    }
    const avgCLV = entry.clvWeight > 0 ? entry.clvSumWeighted / entry.clvWeight : 0;
    const positiveCLVRate = entry.positiveClvCount / entry.samples;
    const notionalConfidence = clamp01(Math.log10((entry.totalNotional || 0) + 1) / 5);
    const raw = 0.50 * clamp01((avgCLV + 0.03) / 0.08)
              + 0.30 * positiveCLVRate
              + 0.20 * notionalConfidence;
    const score = clamp01(raw) * 100;
    const label = score >= 75 ? 'strong' : score >= 55 ? 'useful' : 'weak';
    return { score, label, avgCLV, positiveCLVRate, samples: entry.samples, totalNotional: entry.totalNotional };
  }

  function computeClusterGroupKey(wallets) {
    if (!wallets || wallets.length < TUNING.RECURRING_GROUP_MIN_WALLETS) return null;
    const topWallets = wallets.slice()
      .sort((a, b) => ((b.amount || 0) * (b.avg || 0)) - ((a.amount || 0) * (a.avg || 0)))
      .slice(0, TUNING.RECURRING_GROUP_TOPN);
    const key = topWallets
      .map(w => (w.addr || '').toLowerCase())
      .filter(Boolean)
      .sort()
      .join('|');
    return key || null;
  }

  // Tuning constants — prediction formula weights, thresholds, archetype gates.
  // Weights sum to 1.0. Components normalized to [-1, +1] before weighting.
  const TUNING = {
    K1_BASE: 50000,           // SharpEdge: notional scale (auto-scaled by side size)
    K2_BASE: 25000,           // Flow24h: $ scale (adaptive w/ side size — v2.0)
    K2_SIDE_FRACTION: 0.15,   // v2.0: K2_eff = max(K2_BASE, totalSideNotional * this)
    K3: 5000,                 // v2.0: ExitSignal scale — now quality-weighted sum, not count
    ALPHA: 2.2,               // Score → probability logistic/softmax slope
    WEIGHTS: {                // v2.10: 11 components, PnL-first rebalance.
      eliteEdge:     0.20,    // NEW v2.10: PnL-validated wallet share — closest "winners only" signal
      walletEdge:    0.18,    // (was 0.20) entryQuality from positions cashPnl+realizedPnl per capital
      sharpEdge:     0.12,    // (was 0.25) PnL-gated archetype × notional — overlaps with eliteEdge
      consistency:   0.10,    // (was 0.08) winRate spread among sharps — direct PnL signal
      holderProfit:  0.10,    // (was 0.05) sharp vs public unrealized ROI on this side — direct PnL
      exit:          0.08,    // profitable-exit quality — direct PnL signal
      clv:           0.07,    // (was 0.10) entry vs reference price — proxy
      flow24h:       0.05,    // (was 0.12) recent volume — no PnL gate, weakest direct signal
      contrarian:    0.05,    // (kept) fade-the-public — proxy
      bookTilt:      0.03,    // (was 0.08) orderbook tilt — gameable, no PnL gate
      insiderTiming: 0.02     // (was 0.04) timing — no PnL on the action
                              // total ≈ 1.00; active-weight renorm handles drift if any component nulls.
                              // Set any weight to 0 to disable that component instantly.
    },
    CONFIDENCE_FLOOR: 0.35,
    CONFIDENCE_SCALE: 0.65,
    CONSISTENCY_AMP: 5,              // amplifier for winRate diff (sharps cluster at 0.55-0.65)
    SHARPEDGE_SIDE_FRACTION: 0.3,    // K1_eff = max(K1_BASE, totalSideNotional * this)
    TIME_DECAY_HALF_LIFE_HRS: 6,     // v2.0: flow24h + insiderTiming multiplier half-life
    CLV_REF_HOURS_BEFORE_START: 1,   // v2.0: for true CLV, use price this many hrs before game start
    COLD_CACHE_SLICE: 100,           // bound positions/activity arrays in cold cache
    TOP_PICKS_COUNT: 3,              // how many actionable bets to surface
    TOP_PICKS_MIN_EDGE_CONF: 0.08,   // edge × confidence floor for "actionable"
    TOP_PICKS_MIN_NOTIONAL: 25000,   // side-total $ floor — below this, not fillable at size
    TOP_PICKS_KELLY_MULT: 0.25,      // v2.1: fractional-Kelly multiplier (quarter-Kelly by default)
    TABLE_BET_EDGE: 0.02,            // v2.2: row classified BET at or above (edge + conf≥.50)
    TABLE_LEAN_EDGE: 0.01,           // v2.2: row classified LEAN in [0.01, 0.02)
    TABLE_FADE_EDGE: -0.02,          // v2.2: row classified FADE at or below (market stronger)
    MIN_EVENT_VOLUME: 50000,         // v2.3: skip event when total gamma volume below this
    OI_CONVICTION_FLOOR: 0.85,       // v2.3: confidence × this floor when held/oi ratio is poor
    ELITE_EDGE_K: 4,                 // v2.10: tanh scale for (eliteShare − oppMean(eliteShare)).
                                     //       K=4 maps a 10pp share gap to ~0.38 signal; 25pp to ~0.76.
    HOLDER_PROFIT_K: 10,             // v2.8: sharp/public avg-ROI gap × K → tanh. K=10 maps a 5pp ROI
                                     //       asymmetry to ~0.46 signal; 10pp to ~0.76; 20pp saturates.
    CLUSTER_MIN_WALLETS: 3,                  // v2.9: minimum wallet count for a cluster to qualify
    CLUSTER_MAX_ENTRY_PRICE_GAP: 0.04,       // v2.9: max avg-price spread within a cluster (4¢)
    CLUSTER_MAX_ENTRY_TIME_GAP_SEC: 1800,    // v2.9: max time span within a cluster (30 min)
    CLUSTER_MIN_NOTIONAL: 5000,              // v2.9: min total cluster notional ($) to surface
    CLUSTER_STRONG_SCORE: 0.70,              // v2.9: qualityScore threshold for "strong" label
    // v2.24 Phase 2A: cross-event recurring-group detection. localStorage-backed rolling memory
    // of top-N wallet coalitions; small qualityScore penalty when the same group recurs across
    // many unrelated events. Display-only — never read by prediction math.
    RECURRING_GROUPS_KEY: 'pmsports_recurring_groups_v1',
    RECURRING_GROUP_DECAY_MS: 12 * 60 * 60 * 1000,  // drop entries unseen for 12h
    RECURRING_GROUP_MAX: 5000,                       // hard cap on blob size; oldest evicted by lastSeen
    RECURRING_GROUP_TOPN: 5,                         // top-N wallets (by notional) compose the key
    RECURRING_GROUP_MIN_WALLETS: 3,                  // skip tiny clusters — no key, no penalty
    // v2.25 Phase 2 Part 1: CLV tracking. Per-side weighted closing-line value vs each wallet's
    // entry price, bucketed by Elite/Public. Display + log only — never read by prediction math.
    // Reuses refPriceByToken[tokenId] (the v2.0 closing-line proxy already populated for the
    // existing `clv` prediction component); no new fetches.
    CLV_LOG_KEY: 'pmsports_clv_log_v1',              // append-only ring buffer in localStorage
    CLV_LOG_MAX: 500,                                // newest-wins eviction at write time
    // v2.26 Phase 2 Part 2: per-(wallet, marketType) specialization memory. localStorage-backed.
    // Display + log only — never read by prediction math. Mirrors the recurring-group envelope
    // but with a 30-day decay (specialization should accumulate slowly) and a 10000-entry cap.
    SPECIALIZATION_KEY: 'pmsports_wallet_specialization_v1',
    SPECIALIZATION_MAX: 10000,
    SPECIALIZATION_DECAY_MS: 30 * 24 * 60 * 60 * 1000,  // drop entries unseen for 30 days
    SPECIALIZATION_MIN_SAMPLES: 5,                       // sample threshold for non-null score
    // v2.27 Phase 2 Part 3: per-side smart-money entry/exit pressure (display + log only).
    // Reuses tradesByToken closure already populated upstream — no new network fetches.
    ACCUMULATION_LOG_KEY:        'pmsports_accumulation_log_v1',
    ACCUMULATION_LOG_MAX:        500,
    ACCUMULATION_LOOKBACK_HOURS: 24,
    ACCUMULATION_MIN_NOTIONAL:   500,
    HOLDER_FETCH_BATCH: 6,           // v2.30.1: 4→6. Pre-v2.30 the "6 was 429-prone" note from v2.17
                                     //         held; v2.30 added per-endpoint 429 cooldown (60s) +
                                     //         wave throttle still reactive-drops on 429 rate > 20%,
                                     //         so the floor can safely start at 6 now. Both holders
                                     //         phase and wallet phase ramp through this before
                                     //         endWave() pushes them to MAX_DYNAMIC_BATCH=12.
    HOLDER_FETCH_SPACING_MS: 0,      // v2.33.0: 50→0ms. v2.32.0 ran clean with no 429s observed;
                                     //          spacing is now just an event-loop yield. Endpoint
                                     //          429 cooldown + endWave -2 throttle stay the safety nets.
                                     // v2.32.0: 150→50ms. Endpoint 429 cooldown is the primary safety net;
                                     //          single-line rollback to 150 if fail429 climbs.
                                     // v2.31.0: 400→150ms. v2.30 per-endpoint 429 cooldown (60s) + wave
                                     //          throttle are the primary rate-limit safety nets now;
                                     //          spacing is no longer the first line of defense.
                                     // v2.4: pause between holder-fetch groups
    MAX_DYNAMIC_BATCH: 48,           // v2.35.0: 32→48 turbo ceiling. Used only when fail429 stays 0 this scan;
                                     //          first 429 trips one-shot rollback to SAFE_MAX_DYNAMIC_BATCH=32
                                     //          for the rest of the run (see endWave). Single-line rollback to
                                     //          32 here if v2.35.0 logs show frequent turboRollback:YES.
                                     // v2.33.0: 24→32. v2.32.0 ran clean with no 429s observed.
                                     //          Single-line rollback to 24 if fail429 climbs.
    TURBO_MAX_DYNAMIC_BATCH: 48,     // v2.35.0: turbo ceiling (used when 0 fail429 so far this scan)
    SAFE_MAX_DYNAMIC_BATCH:  32,     // v2.35.0: known-good v2.33.0 ceiling — effective ceiling after first 429
    TURBO_FAIL429_ROLLBACK:  true,   // v2.35.0: master switch for the fail429 one-shot auto-rollback path
                                     // v2.32.0: 16→24. Per-endpoint 429 cooldown + reactive -2 throttle
                                     //          absorb spikes. Single-line rollback to 16 if fail429 climbs.
                                     // v2.31.0: 12→16. Fast-ramp endWave() + per-endpoint 429 cooldown
                                     //          provide sufficient protection. Watch fail429 counter in
                                     //          end-of-run log; roll back to 12 if rate spikes.
                                     // v2.22: 10 → 12. endWave() auto-throttle bounds currentBatch to
                                     //        [HOLDER_FETCH_BATCH=4, MAX_DYNAMIC_BATCH=16]; if 429 rate
                                     //        stays under 5% the scaler ramps to 16 for additional
                                     //        savings on the wallet phase. If 429s spike >20% the same
                                     //        auto-throttle drops back to floor 4, identical to v2.21
                                     //        worst case.
                                     // v2.18: 6 → 10. v2.13 (was 6, was 32): hard ceiling on dynamic scaling.
    DERIVE_WINDOW_PNL: false,        // v2.7.2: rolled back to false (was true in v2.7/v2.7.1).
                                     //       Activity-derived 30d/7d pnl visibly shifted picks for the
                                     //       worse vs lb-api's authoritative number (mark-to-market on
                                     //       open positions is missing from the derivation). Flag stays
                                     //       around as a kill-switch — flip to true if/when we restructure
                                     //       the derivation to match lb-api's math, and as a quick A/B.
    // v2.12: Tail Winners Score — execution-layer gates. Do NOT affect modelProb or component
    // weights; only filter/rank Top Picks and provide UI display.
    TAIL_MIN_SCORE: 50,              // v2.12: Top Picks hidden when computed tailScore < this.
                                     //        Tail-null sides (no elite cohort) bypass this gate.
    TAIL_MAX_EXIT_PENALTY: -0.4,     // v2.12: Top Picks hidden when exit component < this (smart money fleeing).
    SHOW_ZERO_SIGNAL_CARDS: false,   // v2.12: small share-count cards with no elite/sharp/holderProfit
                                     //        signal AND zero combined posPnl are hidden by default.
                                     //        Toggle button in UI reveals them.
    // v2.34.0: Decision Grades — execution-layer letter grade (A+/A/B/C/PASS) layered on
    // top of the v2.2 BET/LEAN/PASS/FADE action classifier. Pure display + bot-export
    // dimension; does NOT affect modelProb, p.probability, p.confidence, p.score,
    // components, weights, Top Picks ranking, Tail Winners scoring, or alert thresholds.
    // Knobs read by gradeSide() — see function near classifyAction.
    GRADE_NOTIONAL_A_PLUS:  75000,   // v2.34.0: side-total $ floor for A+ (well above TOP_PICKS_MIN_NOTIONAL=25k)
    GRADE_NOTIONAL_A:       40000,   // v2.34.0: A tier
    GRADE_NOTIONAL_B:       20000,   // v2.34.0: below this, even strong-edge LEAN grades C
    GRADE_HOLDERS_A_PLUS:   40,      // v2.34.0: holder-count floor for A+
    GRADE_HOLDERS_A:        25,
    GRADE_HOLDERS_B:        12,
    GRADE_TAIL_A_PLUS:      65,      // v2.34.0: tailScore floor for A+ (tail-null sides cannot earn A+)
    GRADE_TAIL_A:           50,      // v2.34.0: matches existing TAIL_MIN_SCORE
    GRADE_PROB_FLOOR:       0.10,    // v2.34.0: modelProb outside [floor, ceil] → grade PASS (weird-price guard)
    GRADE_PROB_CEIL:        0.92,
    GRADE_PROB_A_PLUS_FLOOR: 0.20,   // v2.34.0: A+ requires more meaningful uncertainty (not a near-lock)
    GRADE_PROB_A_PLUS_CEIL:  0.85,
    GRADE_CAP_PROP:         'B',     // v2.34.0: _prop markets capped at this grade ('A+' disables the cap)
    GRADE_CAP_MAP:          'B',     // v2.34.0: _esports_map capped at this grade
    GRADE_CONFLICT_BLOCKS_A_PLUS: true,  // v2.34.0: smartMoneyDumping=true on the picked side blocks A+ (caps at B)
    // v2.21: stale-alert dimming thresholds. Live toasts go stale faster than the history panel
    // because the toast is meant to drive immediate action; once it's been on screen for 3+ min
    // the price has almost certainly moved. History rows tolerate up to 5 min before dimming.
    STALE_ALERT_LIVE_MS: 3 * 60 * 1000,
    STALE_ALERT_MS:      5 * 60 * 1000
  };

  const SPORTS_PROFILES = {
    default: { insiderWindow:30*60, bigMove:0.10, botIntervalMs:12000, sharpMinPnl:25000, sharpMinWinRate:0.55, publicMinAvgEntry:0.60 },
    nba:     { insiderWindow:30*60, bigMove:0.08, botIntervalMs:12000, sharpMinPnl:25000, sharpMinWinRate:0.55, publicMinAvgEntry:0.60 },
    nfl:     { insiderWindow:60*60, bigMove:0.12, botIntervalMs:15000, sharpMinPnl:25000, sharpMinWinRate:0.55, publicMinAvgEntry:0.62 },
    mlb:     { insiderWindow:30*60, bigMove:0.08, botIntervalMs:10000, sharpMinPnl:20000, sharpMinWinRate:0.55, publicMinAvgEntry:0.58 },
    nhl:     { insiderWindow:30*60, bigMove:0.10, botIntervalMs:10000, sharpMinPnl:20000, sharpMinWinRate:0.55, publicMinAvgEntry:0.58 },
    soccer:  { insiderWindow:45*60, bigMove:0.10, botIntervalMs:10000, sharpMinPnl:20000, sharpMinWinRate:0.55, publicMinAvgEntry:0.58 },
    tennis:  { insiderWindow:15*60, bigMove:0.15, botIntervalMs:8000,  sharpMinPnl:15000, sharpMinWinRate:0.55, publicMinAvgEntry:0.55 },
    ufc:     { insiderWindow:60*60, bigMove:0.15, botIntervalMs:12000, sharpMinPnl:20000, sharpMinWinRate:0.55, publicMinAvgEntry:0.60 },
    cs2:     { insiderWindow:15*60, bigMove:0.15, botIntervalMs:6000,  sharpMinPnl:10000, sharpMinWinRate:0.55, publicMinAvgEntry:0.55 },
    lol:     { insiderWindow:15*60, bigMove:0.15, botIntervalMs:6000,  sharpMinPnl:10000, sharpMinWinRate:0.55, publicMinAvgEntry:0.55 },
    dota2:   { insiderWindow:15*60, bigMove:0.15, botIntervalMs:6000,  sharpMinPnl:10000, sharpMinWinRate:0.55, publicMinAvgEntry:0.55 },
    valorant:{ insiderWindow:15*60, bigMove:0.15, botIntervalMs:6000,  sharpMinPnl:10000, sharpMinWinRate:0.55, publicMinAvgEntry:0.55 }
  };
  // v2.3: per-market profile override. Player props and 1H/quarter derivatives have very different
  // wallet populations than main moneylines — almost no one makes $25k lifetime betting Brunson
  // rebound props. Loosen the gates so the classifier can find sharps where they actually exist.
  function getMarketProfile(question, sportKey){
    const base = SPORTS_PROFILES[sportKey] || SPORTS_PROFILES.default;
    const q = (question || '').toLowerCase();
    const isProp = /\b(points|rebounds|assists|threes|made\s*3|steals|blocks|turnovers|double[\s-]?double|triple[\s-]?double|first basket|to score|will score)\b/.test(q);
    const isDerivative = /\b(1h|first half|2h|second half|first quarter|1st quarter|2nd quarter|3rd quarter|4th quarter|q1|q2|q3|q4|period\s*\d|inning|set\b)\b/.test(q);
    if (isProp) return Object.assign({}, base, { sharpMinPnl: 3000, sharpMinWinRate: 0.58, insiderWindow: 15*60 });
    if (isDerivative) return Object.assign({}, base, { sharpMinPnl: 5000, sharpMinWinRate: 0.56 });
    return base;
  }
  // v2.26 Phase 2 Part 2: market-type classifier. Display + log only — output never feeds
  // prediction math, modelProb, weights, Top Picks, Tail Winners, alerts, or any scoring path.
  // Returns a bucket string like 'nba_moneyline'/'nba_spread'/'nba_total'/'nba_prop',
  // 'esports_match'/'esports_map'/'esports_total', a sportKey-prefixed fallback for sports
  // not in the listed buckets (e.g. 'nhl_total', 'mls_spread'), or 'unknown' when sportKey
  // is missing. Detection order is prop > total > spread > moneyline (prop wins because
  // player-stat questions can also contain "over X.X" patterns).
  function classifyMarketType(question, sportKey){
    if (!sportKey) return 'unknown';
    const sk = String(sportKey).toLowerCase();
    const q = (question || '').toLowerCase();
    const ESPORTS = new Set(['esports','lol','leagueoflegends','league-of-legends',
      'csgo','cs2','counterstrike','dota','dota2','dota-2','valorant','val',
      'rocketleague','r6','siege','overwatch','apex']);
    if (ESPORTS.has(sk)) {
      if (/\b(total|over|under|maps?\s+(played|won)|map\s*count)\b/.test(q)) return 'esports_total';
      if (/\bmap\s*\d|\b(first|second|third)\s+map\b|map\s+\d\s+winner|\bgame\s*[1-5]\b|\bgame\s*(one|two|three|four|five)\b|game\s*\d\s+winner/.test(q)) return 'esports_map';
      return 'esports_match';
    }
    const isProp = /\b(points|rebounds|assists|threes?|made\s*3|steals|blocks|turnovers|double[\s-]?double|triple[\s-]?double|first\s+basket|to\s+score|will\s+score|home\s+runs?|strikeouts?|hits|rbis?|passing|rushing|receiving|completions|touchdowns?|yards|sacks|receptions|tackles|interceptions)\b/.test(q);
    const isTotal = /\b(over|under|total)\s+(points|runs|goals|maps|games|kills|rounds|\d)/.test(q)
                 || /\b(o\/u|over\/under)\b/.test(q);
    const isSpread = /\b(spread|cover|handicap|favored)\b/.test(q)
                  || /\(\s*[+\-]\d+(\.\d+)?\s*\)/.test(q)
                  || /[+\-]\d+(\.\d+)?\s*(point|run|goal)/.test(q);
    const type = isProp ? 'prop' : isTotal ? 'total' : isSpread ? 'spread' : 'moneyline';
    return sk + '_' + type;
  }
  // v2.27 Phase 2 Part 3: pure helpers for Entry / Exit Pressure tracking. Display + log only.
  // Read-only over the row passed in; never mutate or feed back into predictions[*], modelProb,
  // p.probability, p.confidence, p.score, weights, Top Picks, Tail Winners, or alerts.
  //
  // classifyWalletBucket(r) — pick one of 'elite' | 'sharp' | 'public' | 'other' for a row r.
  // Elite takes precedence over archetype (matches the v2.25 CLV bucket priority — once a
  // wallet qualifies as elite via isEliteFn it's counted as elite regardless of archetype).
  function classifyWalletBucket(r){
    if (!r) return 'other';
    if (r.elite === true) return 'elite';
    const a = r.archetype;
    if (a === 'sharp' || a === 'insider_like' || a === 'late_edge') return 'sharp';
    if (a === 'public' || a === 'public_chase') return 'public';
    return 'other';
  }
  // computeSidePressure(ctx) — pure function. Single pass over ctx.trades after a wallet→bucket
  // map is built from ctx.rows. Off-roster wallets (sub-top-N or full-exit) bucket as 'other' —
  // counted in totals but excluded from smart (elite+sharp) and public rollups. Honors the
  // "do not guess" rule: no archetype lookup beyond ctx.rows. Returns the spec's pressure
  // shape plus a few internal-only fields (smartBuyVWAP, trades24hCount, walletsTradedCount)
  // useful to the renderer / log; numeric fields are raw — rounding happens at the call site.
  function computeSidePressure(ctx){
    const ctxRows         = (ctx && ctx.rows)         || [];
    const ctxTrades       = (ctx && ctx.trades)       || [];
    const currentPrice    = ctx && ctx.currentPrice    != null ? ctx.currentPrice    : null;
    const referencePrice  = ctx && ctx.referencePrice  != null ? ctx.referencePrice  : null;
    const modelProb       = ctx && ctx.modelProb       != null ? ctx.modelProb       : null;
    const lookbackSec     = (ctx && ctx.lookbackSec)   || (24 * 3600);
    const minNotional     = (ctx && ctx.minNotional)   || 500;
    const ratioHi         = (ctx && ctx.ratioHi)       || 1.25;
    const ratioLo         = (ctx && ctx.ratioLo)       || 0.80;
    const empty = {
      eliteBuyNotional:0,  eliteSellNotional:0,  eliteNetNotional:0,
      sharpBuyNotional:0,  sharpSellNotional:0,  sharpNetNotional:0,
      publicBuyNotional:0, publicSellNotional:0, publicNetNotional:0,
      smartNetNotional:0,  smartBuySellRatio:null, publicBuySellRatio:null,
      distributionPressure:false, accumulationPressure:false, hiddenAccumulation:false,
      smartMoneyStillAdding:false, smartMoneyDumping:false,
      pressureLabel:'UNKNOWN', pressureReason:'No reliable buy/sell activity available.',
      smartBuyVWAP:null, trades24hCount:0, walletsTradedCount:0
    };
    if (!ctxTrades.length) return empty;
    const bucketByWallet = new Map();
    ctxRows.forEach(r => {
      const w = r && r.h && r.h.proxyWallet;
      if (!w) return;
      bucketByWallet.set(String(w).toLowerCase(), classifyWalletBucket(r));
    });
    const acc = {
      elite:  { buy:0, sell:0, buyPriceSum:0, buySize:0 },
      sharp:  { buy:0, sell:0, buyPriceSum:0, buySize:0 },
      public: { buy:0, sell:0, buyPriceSum:0, buySize:0 },
      other:  { buy:0, sell:0, buyPriceSum:0, buySize:0 }
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const tradedWallets = new Set();
    let trades24hCount = 0;
    ctxTrades.forEach(t => {
      if (!t) return;
      const side = t.side === 'BUY' || t.side === 'SELL' ? t.side : null;
      if (!side) return;
      if (!t.size || !t.price) return;
      // v2.28.1: also drop future-stamped trades (clock skew). Old guard only checked the
      // upper bound; a trade with `t.timestamp > nowSec` would have negative age, pass the
      // `> lookbackSec` check trivially, and be included against intent.
      if (!t.timestamp) return;
      const age = nowSec - t.timestamp;
      if (age < 0 || age > lookbackSec) return;
      const bucket = bucketByWallet.get(String(t.wallet || '').toLowerCase()) || 'other';
      const notional = t.size * t.price;
      const a = acc[bucket];
      if (side === 'BUY') {
        a.buy         += notional;
        a.buyPriceSum += t.price * t.size;
        a.buySize     += t.size;
      } else {
        a.sell        += notional;
      }
      trades24hCount += 1;
      if (t.wallet) tradedWallets.add(String(t.wallet).toLowerCase());
    });
    const eliteBuyNotional   = acc.elite.buy,   eliteSellNotional   = acc.elite.sell;
    const sharpBuyNotional   = acc.sharp.buy,   sharpSellNotional   = acc.sharp.sell;
    const publicBuyNotional  = acc.public.buy,  publicSellNotional  = acc.public.sell;
    const eliteNetNotional   = eliteBuyNotional   - eliteSellNotional;
    const sharpNetNotional   = sharpBuyNotional   - sharpSellNotional;
    const publicNetNotional  = publicBuyNotional  - publicSellNotional;
    const smartBuy           = eliteBuyNotional  + sharpBuyNotional;
    const smartSell          = eliteSellNotional + sharpSellNotional;
    const smartNetNotional   = smartBuy - smartSell;
    const smartBuySellRatio  = smartBuy / Math.max(smartSell, 1);
    const publicBuySellRatio = publicBuyNotional / Math.max(publicSellNotional, 1);
    const smartBuySize       = acc.elite.buySize + acc.sharp.buySize;
    const smartBuyVWAP       = smartBuySize > 0
      ? (acc.elite.buyPriceSum + acc.sharp.buyPriceSum) / smartBuySize
      : referencePrice;
    const smartMoneyStillAdding = smartNetNotional >=  minNotional && smartBuySellRatio > ratioHi;
    const smartMoneyDumping     = smartNetNotional <= -minNotional && smartBuySellRatio < ratioLo;
    const accumulationPressure  = smartBuy > smartSell * ratioHi;
    const distributionPressure  = smartSell > smartBuy * ratioHi
                                 && currentPrice != null
                                 && smartBuyVWAP != null
                                 && currentPrice > smartBuyVWAP;
    const hiddenAccumulation = smartNetNotional > 0
                              && modelProb != null && currentPrice != null && referencePrice != null
                              // v2.28.1: require a non-trivial original gap (≥0.5¢) before
                              // we can claim "price hasn't moved toward fair value". Without
                              // this guard, refPrice === modelProb makes the RHS zero and
                              // the flag fires for any smart-net-positive side.
                              && Math.abs(referencePrice - modelProb) > 0.005
                              && Math.abs(currentPrice - modelProb) > 0.5 * Math.abs(referencePrice - modelProb);
    let pressureLabel, pressureReason;
    // v2.28.1: render the minus sign in front of the $ so MIXED reasons read "-$1,500"
    // instead of "$-1,500". Callers that hand-flip the sign (DISTRIBUTING / ACCUMULATING)
    // keep working identically since |round$(positive)| === '$X'.
    const round$ = v => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString();
    if (smartBuy + smartSell === 0) {
      pressureLabel = 'UNKNOWN';
      pressureReason = 'No reliable buy/sell activity available.';
    } else if (smartMoneyDumping) {
      pressureLabel = 'DISTRIBUTING';
      pressureReason = (currentPrice != null && smartBuyVWAP != null && currentPrice > smartBuyVWAP)
        ? 'Smart wallets selling into strength; current price ' + currentPrice.toFixed(2)
          + ' above ' + smartBuyVWAP.toFixed(2) + ' VWAP.'
        : 'Smart wallets net selling ' + round$(-smartNetNotional) + ' over last 24h.';
    } else if (smartMoneyStillAdding) {
      pressureLabel = 'ACCUMULATING';
      pressureReason = hiddenAccumulation
        ? 'Smart net positive but price barely moved toward fair value.'
        : 'Elite/sharp wallets net adding ' + round$(smartNetNotional) + ' over last 24h.';
    } else if (Math.sign(smartNetNotional) !== 0
               && Math.sign(publicNetNotional) === -Math.sign(smartNetNotional)
               && Math.abs(smartNetNotional)  >= minNotional / 2
               && Math.abs(publicNetNotional) >= minNotional / 2) {
      pressureLabel = 'MIXED';
      pressureReason = 'Mixed signals: smart ' + round$(smartNetNotional)
        + ' vs public ' + round$(publicNetNotional) + '.';
    } else {
      pressureLabel = 'HOLDING';
      pressureReason = 'Smart-money flow flat over last 24h.';
    }
    return {
      eliteBuyNotional, eliteSellNotional, eliteNetNotional,
      sharpBuyNotional, sharpSellNotional, sharpNetNotional,
      publicBuyNotional, publicSellNotional, publicNetNotional,
      smartNetNotional, smartBuySellRatio, publicBuySellRatio,
      distributionPressure, accumulationPressure, hiddenAccumulation,
      smartMoneyStillAdding, smartMoneyDumping,
      pressureLabel, pressureReason,
      smartBuyVWAP, trades24hCount, walletsTradedCount: tradedWallets.size
    };
  }
  // v2.28: Bot Export Layer. Pure read-only function — assembles a JSON-safe snapshot of
  // every pass-level signal already computed by run(). Bot/VPS scanner consumers read
  // window.pmSportsBotExport directly; this helper never mutates ctx, predictions[*],
  // sideRaw[*], or any other source. Wrapped in try/catch by the caller so a serialization
  // bug here can never break dashboard render. Output is plain JSON (no DOM nodes, no
  // functions, no circular references, no per-wallet cluster objects).
  function buildBotExport(ctx){
    try {
      ctx = ctx || {};
      const slug                 = ctx.slug || null;
      const sportKey             = ctx.sportKey || null;
      const ev                   = ctx.ev || null;
      const sides                = ctx.sides || {};
      const predictions          = ctx.predictions || {};
      const sideRaw              = ctx.sideRaw || {};
      const topPicks             = Array.isArray(ctx.topPicks) ? ctx.topPicks : [];
      const clvBySide            = ctx.clvBySide || {};
      const specializationBySide = ctx.specializationBySide || {};
      const accumulationBySide   = ctx.accumulationBySide || {};
      const tailBySide           = ctx.tailBySide || {};
      const gradesBySide         = ctx.gradesBySide || {};
      const clustersBySide       = ctx.clustersBySide || {};
      const marketEdgeFor        = typeof ctx.marketEdgeFor === 'function' ? ctx.marketEdgeFor : null;
      const classifyAction       = typeof ctx.classifyAction === 'function' ? ctx.classifyAction : null;
      const classifyMarketTypeFn = typeof ctx.classifyMarketType === 'function' ? ctx.classifyMarketType : null;
      const mon                  = ctx.mon || {};
      const dataQuality          = ctx.dataQuality != null ? ctx.dataQuality : null;
      const walletList           = Array.isArray(ctx.walletList) ? ctx.walletList : [];
      const walletCacheHits      = ctx.walletCacheHits || 0;
      const totalHolderRows      = ctx.totalHolderRows || 0;
      const ctxTopN              = ctx.topN != null ? ctx.topN : null;
      const decisionInfo         = ctx.decisionInfo || null;
      // Event-level facts.
      const eventTitle  = (ev && ev.title) || slug || null;
      const marketCount = (ev && Array.isArray(ev.markets)) ? ev.markets.length : 0;
      const startTime   = (ev && ev.markets && ev.markets[0] && ev.markets[0].startDate) || null;
      // topPicks — keep compact + reuse marketEdgeFor / classifyAction (read-only).
      const topPicksOut = topPicks.map(tp => {
        if (!tp) return null;
        const s = tp.s || null;
        const p = tp.p || null;
        const tail = tp.tail || null;
        const me = marketEdgeFor ? marketEdgeFor(tp.label) : null;
        const action = (classifyAction && me && p)
          ? classifyAction(me.edge, p.confidence)
          : null;
        // v2.34.0: grade is precomputed at scan time (gradesBySide) so all surfaces agree.
        // Falls back to tp.grade (carried inline on the topPicks entry) if the map lookup
        // misses for any reason. schemaVersion stays 1 — grade / gradeReasons are additive.
        const gradeEntry = (tp.label && gradesBySide[tp.label]) || null;
        const grade        = gradeEntry ? gradeEntry.grade : (tp.grade || null);
        const gradeReasons = gradeEntry ? gradeEntry.reasons : (tp.gradeReasons || []);
        return {
          market:         s && s.marketQuestion ? s.marketQuestion : (s && s.market && s.market.question ? s.market.question : null),
          conditionId:    s && s.market && s.market.conditionId || null,
          tokenId:        s && s.rows && s.rows[0] ? s.rows[0].tokenId : null,
          // v2.29.0: `side` keeps the raw Polymarket outcome for back-compat with any
          // consumer already reading this field. rawSide / displaySide / line / sideType
          // are additive — schemaVersion stays 1.
          side:           (s && s.displayLabel) || tp.label || null,
          rawSide:        (s && s.rawSide) || (s && s.displayLabel) || tp.label || null,
          displaySide:    (s && s.displaySide) || (s && s.displayLabel) || tp.label || null,
          line:           s && s.line != null ? s.line : null,
          sideType:       s && s.sideType || null,
          action:         action,
          grade:          grade,
          gradeReasons:   gradeReasons,
          modelProb:      p ? p.probability : null,
          effectiveCost:  me ? me.effectiveCost : null,
          edge:           tp.edge != null ? tp.edge : (me ? me.edge : null),
          confidence:     p ? p.confidence : null,
          score:          p ? p.score : null,
          liquidity:      tp.liq != null ? tp.liq : null,
          tailScore:      tail ? tail.tailScore : null,
          stillTailPrice: tail ? tail.stillTailPrice : null,
          reason:         tail ? tail.reason : null
        };
      }).filter(Boolean);
      // Per-side bundle — pulls each computed signal block into one row per side.
      const sidesOut = Object.keys(sides).map(label => {
        const s = sides[label];
        if (!s) return null;
        const p   = predictions[label] || null;
        const sr  = sideRaw[label] || {};
        const me  = marketEdgeFor ? marketEdgeFor(label) : null;
        const tokenId = s.rows && s.rows[0] ? s.rows[0].tokenId : null;
        const components = (p && p.components)
          ? Object.keys(p.components).reduce((o, k) => {
              const v = p.components[k];
              o[k] = (v == null || isNaN(v)) ? null : v;
              return o;
            }, {})
          : null;
        const activeW = p && p.activeWeights || {};
        const topComponents = components
          ? Object.keys(components)
              .filter(k => components[k] != null)
              .map(k => ({ key: k, value: components[k], contrib: Math.abs(components[k] * (activeW[k] || 0)) }))
              .sort((a, b) => b.contrib - a.contrib)
              .slice(0, 3)
          : [];
        const action = (classifyAction && me && p)
          ? classifyAction(me.edge, p.confidence)
          : null;
        const marketTypeStr = classifyMarketTypeFn
          ? classifyMarketTypeFn(s.marketQuestion || (s.market && s.market.question) || '', sportKey)
          : null;
        // v2.34.0: per-side grade is precomputed at scan time; additive (schemaVersion stays 1).
        const gradeEntry   = gradesBySide[label] || null;
        const grade        = gradeEntry ? gradeEntry.grade : null;
        const gradeReasons = gradeEntry ? gradeEntry.reasons : [];
        const clv   = clvBySide[label]            || null;
        const spec  = specializationBySide[label] || null;
        const accum = accumulationBySide[label]   || null;
        const tail  = tailBySide[label]           || null;
        const clusters = Array.isArray(clustersBySide[label]) ? clustersBySide[label] : [];
        const bestCluster = clusters.length ? clusters[0] : null;
        return {
          key:            label,
          market:         s.marketQuestion || (s.market && s.market.question) || null,
          conditionId:    s.market && s.market.conditionId || null,
          tokenId:        tokenId,
          // v2.29.0: `side` stays raw for back-compat; rawSide / displaySide / line /
          // sideType are additive (schemaVersion stays 1).
          side:           s.displayLabel || label,
          rawSide:        s.rawSide || s.displayLabel || label,
          displaySide:    s.displaySide || s.displayLabel || label,
          line:           s.line != null ? s.line : null,
          sideType:       s.sideType || null,
          marketType:     marketTypeStr,
          sport:          sportKey,
          modelProb:      p ? p.probability : null,
          effectiveCost:  me ? me.effectiveCost : null,
          edge:           me ? me.edge : null,
          confidence:     p ? p.confidence : null,
          score:          p ? p.score : null,
          action:         action,
          grade:          grade,
          gradeReasons:   gradeReasons,
          components:     components,
          topComponents:  topComponents,
          liquidity: {
            totalSideNotional: sr.totalNotional != null ? sr.totalNotional : null,
            holderCount:       s.rows ? s.rows.length : 0,
            topN:              ctxTopN
          },
          clv: clv ? {
            referencePrice:    clv.referencePrice    != null ? clv.referencePrice    : null,
            sideWeightedCLV:   clv.sideWeightedCLV   != null ? clv.sideWeightedCLV   : null,
            eliteWeightedCLV:  clv.eliteWeightedCLV  != null ? clv.eliteWeightedCLV  : null,
            publicWeightedCLV: clv.publicWeightedCLV != null ? clv.publicWeightedCLV : null,
            clvSpread:         clv.clvSpread         != null ? clv.clvSpread         : null,
            walletCount:       clv.walletCount       || 0,
            eliteWalletCount:  clv.eliteWalletCount  || 0,
            publicWalletCount: clv.publicWalletCount || 0
          } : null,
          specialization: spec ? {
            marketType:                spec.marketType                || null,
            sideSpecializationScore:   spec.sideSpecializationScore   != null ? spec.sideSpecializationScore   : null,
            eliteSpecializationScore:  spec.eliteSpecializationScore  != null ? spec.eliteSpecializationScore  : null,
            publicSpecializationScore: spec.publicSpecializationScore != null ? spec.publicSpecializationScore : null,
            scoredWallets:             spec.scoredWallets || 0,
            lowSampleWallets:          spec.lowSampleWallets || 0,
            topWallets: (spec.topWallets || []).map(w => ({
              wallet:          w.wallet || null,
              score:           w.score != null ? w.score : null,
              label:           w.label || null,
              samples:         w.samples || 0,
              avgCLV:          w.avgCLV != null ? w.avgCLV : null,
              positiveCLVRate: w.positiveCLVRate != null ? w.positiveCLVRate : null
            }))
          } : null,
          accumulation: accum ? {
            eliteBuyNotional:      accum.eliteBuyNotional      || 0,
            eliteSellNotional:     accum.eliteSellNotional     || 0,
            eliteNetNotional:      accum.eliteNetNotional      || 0,
            sharpBuyNotional:      accum.sharpBuyNotional      || 0,
            sharpSellNotional:     accum.sharpSellNotional     || 0,
            sharpNetNotional:      accum.sharpNetNotional      || 0,
            publicBuyNotional:     accum.publicBuyNotional     || 0,
            publicSellNotional:    accum.publicSellNotional    || 0,
            publicNetNotional:     accum.publicNetNotional     || 0,
            smartNetNotional:      accum.smartNetNotional      || 0,
            smartBuySellRatio:     accum.smartBuySellRatio  != null ? accum.smartBuySellRatio  : null,
            publicBuySellRatio:    accum.publicBuySellRatio != null ? accum.publicBuySellRatio : null,
            distributionPressure:  !!accum.distributionPressure,
            accumulationPressure:  !!accum.accumulationPressure,
            hiddenAccumulation:    !!accum.hiddenAccumulation,
            smartMoneyStillAdding: !!accum.smartMoneyStillAdding,
            smartMoneyDumping:     !!accum.smartMoneyDumping,
            pressureLabel:         accum.pressureLabel  || null,
            pressureReason:        accum.pressureReason || null
          } : null,
          tail: tail ? {
            tailScore:       tail.tailScore       != null ? tail.tailScore       : null,
            stillTailPrice:  tail.stillTailPrice  || null,
            eliteAvgEntry:   tail.eliteAvgEntry   != null ? tail.eliteAvgEntry   : null,
            currentPrice:    tail.currentPrice    != null ? tail.currentPrice    : null,
            fairValue:       tail.fairValue       != null ? tail.fairValue       : null,
            extensionRatio:  tail.extensionRatio  != null ? tail.extensionRatio  : null,
            reason:          tail.reason          || null
          } : null,
          cluster: {
            bestClusterQuality:  bestCluster ? (bestCluster.qualityScore != null ? bestCluster.qualityScore : null) : null,
            clusterCount:        clusters.length,
            recurringGroupScore: bestCluster ? (bestCluster.recurringGroupScore || 0) : null,
            recurringEventCount: bestCluster ? (bestCluster.recurringEventCount || 0) : null
          }
        };
      }).filter(Boolean);
      // Compact clustersBySide — strip per-wallet objects, keep just the aggregate scores
      // and counts. Per spec: "do not include all wallet objects unless already compacted".
      const compactClustersBySide = {};
      Object.keys(clustersBySide).forEach(label => {
        const arr = Array.isArray(clustersBySide[label]) ? clustersBySide[label] : [];
        compactClustersBySide[label] = arr.map(c => ({
          walletCount:         c.walletCount || 0,
          totalNotional:       c.totalNotional != null ? c.totalNotional : null,
          avgEntry:            c.avgEntry != null ? c.avgEntry : null,
          currentPrice:        c.currentPrice != null ? c.currentPrice : null,
          unrealizedRoi:       c.unrealizedRoi != null ? c.unrealizedRoi : null,
          qualityScore:        c.qualityScore != null ? c.qualityScore : null,
          baseQualityScore:    c.baseQualityScore != null ? c.baseQualityScore : null,
          eliteShareScore:     c.eliteShareScore != null ? c.eliteShareScore : null,
          fairValueScore:      c.fairValueScore != null ? c.fairValueScore : null,
          pnlMagnitudeScore:   c.pnlMagnitudeScore != null ? c.pnlMagnitudeScore : null,
          exitPenalty:         c.exitPenalty != null ? c.exitPenalty : null,
          recurringGroupScore: c.recurringGroupScore || 0,
          recurringEventCount: c.recurringEventCount || 0,
          label:               c.label || null,
          archetypeCounts:     c.archetypeCounts || {},
          sharpLikeCount:      c.sharpLikeCount || 0,
          publicLikeCount:     c.publicLikeCount || 0,
          timingSpanSec:       c.timingSpanSec != null ? c.timingSpanSec : null,
          timingConfidence:    c.timingConfidence != null ? c.timingConfidence : null
        }));
      });
      const walletCount = walletList.length;
      const cacheHits   = walletCacheHits + (mon.holderCacheHits || 0) + (mon.eventCacheHits || 0);
      const cacheMisses = walletCount > 0 ? Math.max(0, walletCount - walletCacheHits) : null;
      return {
        schemaVersion: 1,
        scriptVersion: SCRIPT_VERSION,
        exportedAt:    Date.now(),
        slug:          slug,
        url:           (typeof location !== 'undefined' && location.href) || null,
        event: {
          title:       eventTitle,
          slug:        slug,
          sportKey:    sportKey,
          startTime:   startTime,
          marketCount: marketCount,
          walletCount: walletCount,
          dataQuality: dataQuality
        },
        decisionSummary: decisionInfo || {
          hasActionableBets: topPicksOut.length > 0,
          actionableCount:   topPicksOut.length,
          closestMiss:       null,
          reason:            null
        },
        topPicks:  topPicksOut,
        sides:     sidesOut,
        clusters:  compactClustersBySide,
        diagnostics: {
          cacheHits:       cacheHits,
          cacheMisses:     cacheMisses,
          walletCacheHits: walletCacheHits,
          holderCacheHits: mon.holderCacheHits || 0,
          eventCacheHits:  mon.eventCacheHits  || 0,
          fail429:         mon.fail429         || 0,
          realFails:       mon.realFails       || 0,
          expectedNoData:  mon.expectedNoData  || 0,
          uniqueWallets:   walletCount,
          totalHolderRows: totalHolderRows,
          dataQuality:     dataQuality
        }
      };
    } catch (e) {
      // Per spec: do not throw, do not break dashboard render. Emit stub so the consumer
      // can still see schemaVersion + an error tag and recover gracefully.
      try { console.warn('[PM Sports bot export] build failed:', e && e.message); } catch (_) {}
      return {
        schemaVersion: 1,
        scriptVersion: SCRIPT_VERSION,
        exportedAt:    Date.now(),
        slug:          (ctx && ctx.slug) || null,
        url:           (typeof location !== 'undefined' && location.href) || null,
        error:         'export_build_failed',
        message:       (e && e.message) || String(e)
      };
    }
  }
  const LEAGUE_REGEX = /(?:^|[^a-z])(nba|nfl|mlb|nhl|ufc|cs2|soccer|tennis|lol|dota2|valorant|boxing|golf|f1)\b/i;

  // v2.7: parse outcomePrices at most once per market object (was 4× across helpers + parsedMarkets).
  const _opCache = new WeakMap();
  function parseOutcomePrices(m){
    if (!m || m.outcomePrices == null) return null;
    if (typeof m.outcomePrices !== 'string') return m.outcomePrices;
    if (_opCache.has(m)) return _opCache.get(m);
    try { const p = JSON.parse(m.outcomePrices); _opCache.set(m, p); return p; }
    catch { _opCache.set(m, null); return null; }
  }

  // v2.7: grade the prediction log (PLOG_KEY) written on every dashboard run.
  // PLOG_KEY rows include {modelProb, marketPrice, edge, confidence, components, resolved, winner, label}.
  // Returns a summary with Brier score, win-rate on positive-edge picks vs avg market price
  // (net edge captured), and per-component Pearson correlation with outcome. Exposed as
  // window.pmsportsGrade() and via the "📊 Grade" button on the Decision Summary.
  // Pure read-only: no fetches, no side effects outside a console.log/table.
  function gradePredictions(){
    // v2.7.1: read SLOG (canonical settled set, dedupes by cid+label across runs) PLUS
    // any resolved rows still in PLOG that haven't been promoted yet. PLOG-side dedupe
    // by cid+label keeps the latest snapshot per pick so pre-settlement duplicates
    // from many dashboard reruns don't inflate Brier.
    const PLOG_KEY = 'pmsports_predlog_v1';
    const SLOG_KEY = 'pmsports_settled_v1';
    let plog, slog;
    try { plog = JSON.parse(localStorage.getItem(PLOG_KEY) || '[]'); } catch { plog = []; }
    try { slog = JSON.parse(localStorage.getItem(SLOG_KEY) || '[]'); } catch { slog = []; }
    if (!Array.isArray(plog)) plog = [];
    if (!Array.isArray(slog)) slog = [];
    const merged = new Map();
    const isResolvedRow = r => r && r.resolved === true && r.winner != null && r.label != null && r.modelProb != null && r.cid != null;
    plog.filter(isResolvedRow).forEach(r => merged.set(r.cid+'|'+r.label, r));
    slog.filter(isResolvedRow).forEach(r => merged.set(r.cid+'|'+r.label, r));
    const settled = Array.from(merged.values());
    const n = settled.length;
    if (n === 0) return { n:0, ready:false, verdict:'No settled predictions in log yet.', components:[] };
    const out = settled.map(r => ({ r, outcome: (r.winner === r.label) ? 1 : 0 }));
    const brier = out.reduce((s, o) => s + Math.pow(o.r.modelProb - o.outcome, 2), 0) / n;
    const winRate = out.reduce((s, o) => s + o.outcome, 0) / n;
    const posEdge = out.filter(o => o.r.edge != null && o.r.edge > 0);
    const posEdgeN = posEdge.length;
    const posEdgeWinRate = posEdgeN ? posEdge.reduce((s,o)=>s+o.outcome,0)/posEdgeN : null;
    // v2.11: prefer the v2.11 entryMarketPrice field if present, fall back to legacy marketPrice for older rows.
    const entryPrice = o => (o.r.entryMarketPrice != null ? o.r.entryMarketPrice : (o.r.marketPrice != null ? o.r.marketPrice : 0));
    const posEdgeMarketAvg = posEdgeN ? posEdge.reduce((s,o)=>s+entryPrice(o),0)/posEdgeN : null;
    const posEdgeAvgEdge   = posEdgeN ? posEdge.reduce((s,o)=>s+(o.r.edge||0),0)/posEdgeN : null;
    const posEdgeAvgModelProb = posEdgeN ? posEdge.reduce((s,o)=>s+(o.r.modelProb||0),0)/posEdgeN : null;
    const posEdgeAvgConfidence = posEdgeN ? posEdge.reduce((s,o)=>s+(o.r.confidence||0),0)/posEdgeN : null;
    // v2.11: edgeCaptured = realized winRate − market-implied probability we paid into.
    //        Positive = our positive-edge picks beat the line; that's the only grading question.
    const edgeCaptured  = (posEdgeWinRate != null && posEdgeMarketAvg != null) ? (posEdgeWinRate - posEdgeMarketAvg) : null;
    // calibrationGap = winRate − model's claimed probability. Positive = model under-confident.
    const calibrationGap = (posEdgeWinRate != null && posEdgeAvgModelProb != null) ? (posEdgeWinRate - posEdgeAvgModelProb) : null;
    const modelClaimed = (posEdgeMarketAvg != null && posEdgeAvgEdge != null) ? posEdgeMarketAvg + posEdgeAvgEdge : null;
    // v2.11: per-component winners-vs-losers separation. Tells us whether eliteEdge/walletEdge/holderProfit
    // actually distinguish settled winners from losers (component value should be HIGHER on winners
    // if it's predicting correctly).
    function compMean(rows, getter){
      const xs = rows.map(getter).filter(v => v != null && !isNaN(v));
      return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
    }
    const winners = out.filter(o => o.outcome === 1);
    const losers  = out.filter(o => o.outcome === 0);
    const componentSeparation = {};
    ['eliteEdge','walletEdge','holderProfit','publicTrap','sharpEdge','consistency'].forEach(key => {
      const w = compMean(winners, o => o.r.components && o.r.components[key]);
      const l = compMean(losers,  o => o.r.components && o.r.components[key]);
      componentSeparation[key] = {
        winnerAvg: w != null ? Number(w.toFixed(3)) : null,
        loserAvg:  l != null ? Number(l.toFixed(3)) : null,
        delta:     (w != null && l != null) ? Number((w - l).toFixed(3)) : null
      };
    });
    let verdict;
    if (n < 10) verdict = 'Need more settled predictions ('+n+'/10 minimum for signal).';
    else if (posEdgeN < 10) verdict = 'Not enough positive-edge settled rows yet ('+posEdgeN+'/10). Overall winRate '+(winRate*100).toFixed(1)+'%, Brier '+brier.toFixed(3)+'.';
    else {
      const diff = posEdgeWinRate - posEdgeMarketAvg;
      if (diff > 0.03) verdict = 'Edge real: positive-edge picks win at '+(posEdgeWinRate*100).toFixed(1)+'% vs market-implied '+(posEdgeMarketAvg*100).toFixed(1)+'% (+' +(diff*100).toFixed(1)+'pp). Keep sizing.';
      else if (diff > 0) verdict = 'Marginal edge: +'+(diff*100).toFixed(1)+'pp above market. Noisy — watch calibration.';
      else verdict = 'No edge captured: winRate '+(posEdgeWinRate*100).toFixed(1)+'% ≤ market '+(posEdgeMarketAvg*100).toFixed(1)+'%. Model not beating the line on positive-edge picks.';
    }
    const compKeys = new Set();
    out.forEach(o => { if (o.r.components) Object.keys(o.r.components).forEach(k=>compKeys.add(k)); });
    function pearson(xs, ys){
      const m = xs.length;
      if (m < 3) return null;
      const mx = xs.reduce((s,v)=>s+v,0)/m;
      const my = ys.reduce((s,v)=>s+v,0)/m;
      let num=0, dx2=0, dy2=0;
      for (let i=0;i<m;i++){ const dx=xs[i]-mx, dy=ys[i]-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
      const den = Math.sqrt(dx2*dy2);
      return den > 0 ? num/den : null;
    }
    const components = [];
    compKeys.forEach(k => {
      const xs=[], ys=[];
      out.forEach(o => {
        const v = o.r.components && o.r.components[k];
        if (v != null && !isNaN(v)) { xs.push(Number(v)); ys.push(o.outcome); }
      });
      const corr = pearson(xs, ys);
      if (corr != null) components.push({ component:k, n:xs.length, corr:Number(corr.toFixed(3)) });
    });
    components.sort((a,b) => Math.abs(b.corr) - Math.abs(a.corr));
    const summary = {
      n,
      brier: Number(brier.toFixed(4)),
      winRate: Number(winRate.toFixed(3)),
      posEdgeN,
      posEdgeWinRate: posEdgeWinRate!=null ? Number(posEdgeWinRate.toFixed(3)) : null,
      avgEntryMarketPrice: posEdgeMarketAvg!=null ? Number(posEdgeMarketAvg.toFixed(3)) : null,  // v2.11
      posEdgeMarketAvg: posEdgeMarketAvg!=null ? Number(posEdgeMarketAvg.toFixed(3)) : null,    // legacy alias
      posEdgeAvgEdge: posEdgeAvgEdge!=null ? Number(posEdgeAvgEdge.toFixed(3)) : null,
      avgEdge: posEdgeAvgEdge!=null ? Number(posEdgeAvgEdge.toFixed(3)) : null,                 // alias
      avgModelProb: posEdgeAvgModelProb!=null ? Number(posEdgeAvgModelProb.toFixed(3)) : null,  // v2.11
      avgConfidence: posEdgeAvgConfidence!=null ? Number(posEdgeAvgConfidence.toFixed(3)) : null, // v2.11
      edgeCaptured: edgeCaptured!=null ? Number(edgeCaptured.toFixed(3)) : null,                // v2.11 — beat the line?
      calibrationGap: calibrationGap!=null ? Number(calibrationGap.toFixed(3)) : null,          // v2.11 — model self-honest?
      modelClaimedWinRate: modelClaimed!=null ? Number(modelClaimed.toFixed(3)) : null,
      componentSeparation,                                                                       // v2.11
      verdict,
      components
    };
    try { console.log('[PM Sports grade]', summary); if (components.length) console.table(components); } catch(_){}
    return summary;
  }
  try { if (typeof window !== 'undefined') window.pmsportsGrade = gradePredictions; } catch(_){}

  // Resolved-market helpers — detect settlement state and name the winner.
  function isResolved(m){
    if (m && m.closed === true) return true;
    try{
      const op = parseOutcomePrices(m);
      if (Array.isArray(op) && op.length>=2) {
        const prices = op.map(Number);
        return prices.some(p=>p===1) && prices.some(p=>p===0);
      }
    }catch{}
    return false;
  }
  function winnerOf(m, outcomes){
    try{
      const op = parseOutcomePrices(m);
      if (Array.isArray(op)) {
        for(let i=0;i<op.length;i++) if (Number(op[i])===1) return outcomes[i] || ('Outcome '+i);
      }
    }catch{}
    return null;
  }

  // Cross-market consistency checker — heuristic scan of ev.markets for implied-probability
  // violations across sub-markets in the same event. Pure math, no ML. Uses outcomePrices
  // already present in the gamma event payload — zero new fetches.
  // Detects:
  //   (1) handicap_exceeds_moneyline: P(Team wins handicap −X.5) > P(Team wins moneyline) + 2¢
  //   (2) totals_sum_violation: P(Over N.5) + P(Under N.5) ≠ 1.00 ± 2¢ on same line
  // Returns {markets, findings} where findings[] = {severity, kind, message, markets[]}.
  function checkConsistency(ev){
    const STOP = new Set(['Will','Does','Which','The','This','That','What','How','Do','Is','Are','Was']);
    const subs = (ev.markets||[]).map(m=>{
      let probs=null;
      try{
        const op = parseOutcomePrices(m);
        if(Array.isArray(op) && op.length>=2) probs = op.map(Number);
      }catch{}
      const q = m.question || '';
      // Spread/handicap: matches "-1.5", "−1.5", "minus 1.5"
      const spreadM = q.match(/(?:[-−]|\bminus\s+)(\d+(?:\.\d+)?)/i);
      const spreadVal = spreadM ? parseFloat(spreadM[1]) : null;
      // Totals
      const overM = q.match(/\bover\s+(\d+(?:\.\d+)?)/i);
      const underM = q.match(/\bunder\s+(\d+(?:\.\d+)?)/i);
      const totalKind = overM ? 'over' : (underM ? 'under' : null);
      const totalLine = overM ? parseFloat(overM[1]) : (underM ? parseFloat(underM[1]) : null);
      // First capitalized non-stopword token — crude team proxy
      let team=null;
      const words = q.match(/\b[A-Z][a-zA-Z0-9_]{1,}\b/g) || [];
      for(const w of words){ if(!STOP.has(w)){ team=w; break; } }
      return { m, q, probs, pYes: probs?probs[0]:null, pNo: probs&&probs.length>=2?probs[1]:null, spreadVal, totalKind, totalLine, team };
    });
    const findings=[];
    // (1) handicap ≤ moneyline
    subs.filter(x=>x.spreadVal!=null && x.team && x.pYes!=null).forEach(h=>{
      const moneyline = subs.find(x=>
        x!==h && x.team && x.team.toLowerCase()===h.team.toLowerCase()
        && x.spreadVal==null && x.totalKind==null && x.pYes!=null
      );
      if(moneyline){
        const gap = h.pYes - moneyline.pYes;
        if(gap > 0.02){
          findings.push({
            severity:'error', kind:'handicap_exceeds_moneyline',
            message:'P('+h.q+') = '+Math.round(h.pYes*100)+'¢ > P('+moneyline.q+') = '+Math.round(moneyline.pYes*100)+'¢ (impossible — violation by '+Math.round(gap*100)+'¢)',
            markets:[h.m.conditionId, moneyline.m.conditionId]
          });
        } else if(Math.abs(gap) < 0.02){
          findings.push({
            severity:'info', kind:'handicap_near_parity',
            message:'P('+h.q+') = '+Math.round(h.pYes*100)+'¢ ≈ P('+moneyline.q+') = '+Math.round(moneyline.pYes*100)+'¢ (gap '+Math.round(gap*100)+'¢, thin edge)',
            markets:[h.m.conditionId, moneyline.m.conditionId]
          });
        }
      }
    });
    // (2) totals sum
    const byLine={};
    subs.forEach(x=>{ if(x.totalKind && x.totalLine!=null && x.pYes!=null) (byLine[String(x.totalLine)] = byLine[String(x.totalLine)]||[]).push(x); });
    Object.entries(byLine).forEach(([line, arr])=>{
      if(arr.length>=2){
        const over = arr.find(x=>x.totalKind==='over');
        const under = arr.find(x=>x.totalKind==='under');
        if(over && under){
          const sum = over.pYes + under.pYes;
          const gap = sum - 1;
          if(Math.abs(gap) > 0.02){
            findings.push({
              severity:'error', kind:'totals_sum_violation',
              message:'Over '+line+' ('+Math.round(over.pYes*100)+'¢) + Under '+line+' ('+Math.round(under.pYes*100)+'¢) = '+Math.round(sum*100)+'¢ (should be 100¢, gap '+(gap>=0?'+':'')+Math.round(gap*100)+'¢)',
              markets:[over.m.conditionId, under.m.conditionId]
            });
          }
        }
      }
    });
    return { subs, findings };
  }

  // ────────────────────────────────────────────────────────────────────
  // v2.16 LIVE AUTO-UPDATE + ALERT SYSTEM (IIFE-scoped, runs on main page)
  // ────────────────────────────────────────────────────────────────────
  // Lives on https://polymarket.com/* — independent of the popup dashboard.
  // run() snapshots the locked model state to window.pmSportsLiveState at the end,
  // then installLiveLoop() starts a 20s setInterval. Each tick re-fetches book
  // prices, recomputes edge/action/tail, diffs vs last snapshot, fires alerts.
  // No prediction math runs in the loop — model values are locked from the scan.

  const LIVE_ALERT_ENABLED_KEY = 'pmsports_live_alerts_enabled';
  const LIVE_ALERT_CONTAINER_ID = 'pm-sports-alert-container';
  const LIVE_STATUS_PANEL_ID    = 'pm-sports-status-panel';
  const LIVE_STYLE_ID           = 'pm-sports-live-styles';
  const LIVE_TICK_MS            = 20000;
  const LIVE_DEDUP_MS           = 60000;
  const LIVE_TOAST_TTL_MS       = 12000;
  const LIVE_MAX_VISIBLE_TOASTS = 3;        // v2.17: was 5, now 3 (per spec)
  const LIVE_PILL_COLLAPSE_MS   = 6000;     // v2.17: collapse to "SPORTGPT Alerts (N)" pill after 6s of inactivity
  let   livePillTimerId         = null;
  const LIVE_MAX_STORED_ALERTS  = 10;
  // v2.20: 4-tier color hierarchy. ORANGE = BET NOW (immediate action). GREEN = good edge
  // but watch (LEAN, tail-improving). YELLOW = fading / caution. RED = pass.
  // Reserved 'green' for non-immediate watch signals only — DO NOT reuse green for "BET" types.
  const LIVE_ALERT_COLORS = {
    BET_OPENING:               'orange',  // v2.20: was green — BET NOW immediate action
    EDGE_IMPROVED:             'orange',  // v2.20: was green — edge moved into actionable zone
    BETTER_PRICE_STILL_GOOD:   'orange',  // v2.20: was green — better price AND still BET
    TAIL_SCORE_IMPROVED:       'green',   // watch — tail strengthening but not necessarily BET yet
    BETTER_PRICE_BUT_WEAK:     'yellow',  // caution — price improved but tail weak
    EDGE_FADING:               'yellow',  // caution — edge eroding
    NO_LONGER_ACTIONABLE:      'red',     // pass — action degraded out of BET/LEAN
    PRICE_TOO_EXTENDED:        'red',     // pass — past model fair value
    BETTER_PRICE_BUT_PASS:     'red'      // pass — price improved but no positive edge
  };
  const LIVE_ALERT_HEADERS = {
    BET_OPENING:               'BET NOW · BET OPENING',
    EDGE_IMPROVED:             'BET NOW · EDGE IMPROVED',
    BETTER_PRICE_STILL_GOOD:   'BET NOW · BETTER PRICE, STILL BET',  // v2.20: renamed STILL_GOOD → STILL_BET
    TAIL_SCORE_IMPROVED:       'WATCH · TAIL ENTRY IMPROVED',
    BETTER_PRICE_BUT_WEAK:     'CAUTION · BETTER PRICE, BUT WEAK',
    EDGE_FADING:               'FADING · EDGE FADING',
    NO_LONGER_ACTIONABLE:      'PASS · NO LONGER ACTIONABLE',
    PRICE_TOO_EXTENDED:        'PASS · PRICE TOO EXTENDED',
    BETTER_PRICE_BUT_PASS:     'PASS · BETTER PRICE, BUT PASS'
  };

  function liveEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // v2.21: sound alerts. Two-tone beep on ORANGE (BET NOW), single beep on GREEN (watch),
  // YELLOW/RED stay silent — fading/pass alerts are informational only and shouldn't
  // hijack attention. AudioContext is lazily created so we don't hit the
  // "user gesture required to start audio" warning until the first alert.
  // Every audio call is wrapped in try/catch — sound failure NEVER blocks alert rendering.
  const LIVE_SOUND_ENABLED_KEY = 'pmsports_sound_enabled';
  let _liveAudioCtx = null;
  function getAudioCtx(){
    if (_liveAudioCtx) return _liveAudioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _liveAudioCtx = new Ctx();
      return _liveAudioCtx;
    } catch(_){ return null; }
  }
  function playTone(freq, durMs){
    try {
      const ctx = getAudioCtx(); if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (durMs/1000));
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + (durMs/1000) + 0.02);
    } catch(_){}
  }
  function isSoundEnabled(){
    try {
      const v = localStorage.getItem(LIVE_SOUND_ENABLED_KEY);
      if (v === null || v === undefined) return true;  // default ON
      return v !== 'false';
    } catch(_){ return true; }
  }
  function setSoundEnabled(b){
    try { localStorage.setItem(LIVE_SOUND_ENABLED_KEY, String(!!b)); } catch(_){}
  }
  function playAlertSound(color){
    if (!isSoundEnabled()) return;
    try {
      if (color === 'orange') {
        playTone(880, 150);
        setTimeout(() => { try { playTone(1100, 150); } catch(_){} }, 160);
      } else if (color === 'green') {
        playTone(660, 200);
      }
      // yellow / red: silent by spec.
    } catch(_){}
  }

  // v2.21: flash matching Top Picks .pickCard when an ORANGE (BET-now) alert fires.
  // Looks up the dashboard popup via window.pmSportsLiveState.popupWindow. Closed-popup
  // case returns silently (popup.closed === true OR popup.document access throws — outer
  // try/catch absorbs it). Match heuristic: pickCard textContent contains the alert side
  // label, lower-cased. We intentionally accept first match — Top Picks shows ≤3 cards
  // and side labels are usually distinct ("Knicks" vs "Pistons", "Yes" vs "No").
  function flashPickCardForAlert(alert){
    if (!alert || alert.color !== 'orange') return;
    const sideLbl = String(alert.sideLabel || alert.side || '').toLowerCase().trim();
    if (!sideLbl) return;
    try {
      const popup = window.pmSportsLiveState && window.pmSportsLiveState.popupWindow;
      if (!popup || popup.closed) return;
      const cards = popup.document.querySelectorAll('.pickCard');
      for (const card of cards) {
        const txt = (card.textContent || '').toLowerCase();
        if (!txt.includes(sideLbl)) continue;
        const origOutline = card.style.outline;
        const origOffset  = card.style.outlineOffset;
        card.style.transition = 'outline 0.3s ease';
        card.style.outline = '3px solid #ff8c42';
        card.style.outlineOffset = '4px';
        setTimeout(() => {
          try { card.style.outline = origOutline || ''; card.style.outlineOffset = origOffset || ''; } catch(_){}
        }, 3000);
        break;
      }
    } catch(_){}
  }

  function injectLiveStyles(){
    if (document.getElementById(LIVE_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = LIVE_STYLE_ID;
    // v2.17: alert toaster + status panel both pinned BOTTOM-LEFT now (was top-right
    // blocking nav/buy panel). Alert container sits ABOVE the status overlay. Bottom
    // anchor on status panel is fixed at 16px; alert container's bottom anchor is
    // computed from the status panel's height via JS so they stack cleanly.
    s.textContent =
      '#'+LIVE_ALERT_CONTAINER_ID+'{position:fixed;left:16px;bottom:120px;z-index:2147483646;'
      +'display:flex;flex-direction:column;gap:8px;max-width:320px;max-height:60vh;overflow:hidden;'
      +'pointer-events:none;font-family:system-ui,sans-serif}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast{background:#12121a;color:#e8e8ee;border:1px solid #22222d;'
      +'border-left-width:4px;border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.4;'
      +'box-shadow:0 6px 20px rgba(0,0,0,.5);transition:opacity .5s ease;pointer-events:auto;'
      +'word-break:break-word}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast.orange{border-left-color:#ff8c42}'    // v2.20: BET NOW
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast.green{border-left-color:#5fd17a}'     // watch / LEAN
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast.yellow{border-left-color:#e6c26a}'    // fading / caution
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast.red{border-left-color:#f08a8a}'       // pass / not actionable
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast .ts{color:#888;font-size:10px;margin-bottom:3px;text-transform:uppercase;letter-spacing:0.5px}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast .msg{color:#e8e8ee;margin-bottom:4px}'
      // v2.19: rich decision card — stats row + action badge + reason + CTA.
      +'#'+LIVE_ALERT_CONTAINER_ID+' .alertStats{color:#aaa;font-size:11px;line-height:1.6;margin-bottom:4px;font-family:ui-monospace,monospace}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .alertStats b{color:#e8e8ee;font-weight:600}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .alertStats b.green{color:#5fd17a}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .alertStats b.red{color:#f08a8a}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .alertAction{margin:4px 0}'
      // v2.20: action-badge color is dominant; bumped padding/font-weight slightly so it draws the eye.
      +'#'+LIVE_ALERT_CONTAINER_ID+' .actionBadge{display:inline-block;font-size:11px;font-weight:800;padding:3px 10px;border-radius:4px;background:#2a2a32;color:#aaa;letter-spacing:0.6px}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .actionBadge.orange{background:#3a2818;color:#ff8c42}'   // BET NOW
      +'#'+LIVE_ALERT_CONTAINER_ID+' .actionBadge.green{background:#1f3a26;color:#5fd17a}'    // LEAN / WATCH
      +'#'+LIVE_ALERT_CONTAINER_ID+' .actionBadge.yellow{background:#3a3320;color:#e6c26a}'   // fading
      +'#'+LIVE_ALERT_CONTAINER_ID+' .actionBadge.red{background:#3a2326;color:#f08a8a}'      // pass / fade
      +'#'+LIVE_ALERT_CONTAINER_ID+' .alertReason{color:#cdd5e0;font-size:11.5px;line-height:1.5;margin-bottom:6px;font-style:italic}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .alertCta{color:#9dbaff;font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;border-top:1px dashed #2a2a3a;padding-top:5px;margin-top:4px}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-toast:hover,#'+LIVE_ALERT_CONTAINER_ID+' .hRow:hover{border-color:#2a7fff !important}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .hRow{cursor:pointer;border-left:3px solid #22222d;padding:8px 10px !important;margin-top:6px;border-radius:4px;background:#161620}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .hRow.green{border-left-color:#5fd17a}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .hRow.yellow{border-left-color:#e6c26a}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .hRow.red{border-left-color:#f08a8a}'
      // Pill mode: shown when toasts collapse after 6s of inactivity, or while history is hidden.
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-pill{background:#12121a;color:#e8e8ee;border:1px solid #22222d;'
      +'border-radius:999px;padding:6px 12px;font-size:11px;cursor:pointer;pointer-events:auto;'
      +'box-shadow:0 4px 12px rgba(0,0,0,.4);align-self:flex-start;display:inline-flex;align-items:center;gap:6px}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-pill .ct{background:#2a7fff;color:#fff;border-radius:999px;padding:1px 7px;font-size:10px;font-weight:700}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-pill:hover{border-color:#2a7fff}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history{background:#12121a;border:1px solid #22222d;border-radius:10px;'
      +'padding:8px 12px;max-height:50vh;overflow:auto;pointer-events:auto;width:320px}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hHdr{display:flex;justify-content:space-between;align-items:center;'
      +'margin-bottom:6px;font-size:11px;color:#aaa;font-weight:600}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hClose{background:none;border:none;color:#666;font-size:14px;cursor:pointer;padding:0 2px}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hClose:hover{color:#e8e8ee}'
      // v2.21: sort toggle inside history panel header.
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hSort{background:#1a1a24;border:1px solid #2f2f3a;color:#aaa;border-radius:4px;padding:2px 7px;font-size:10px;cursor:pointer;font-family:inherit}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hSort:hover{border-color:#2a7fff;color:#ddd}'
      // v2.21: stale-alert dim tag.
      +'#'+LIVE_ALERT_CONTAINER_ID+' .staleTag{color:#666;margin-left:4px;font-weight:400}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hRow{font-size:11px;line-height:1.4;padding:5px 0;border-top:1px solid #1d1d26;color:#cdd5e0}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hRow:first-child{border-top:none}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hRow .ts{color:#666;font-size:10px;margin-right:6px}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hRow.orange{color:#ffb380}'   // v2.20: BET NOW text
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hRow.green{color:#9de6b0}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hRow.yellow{color:#e6c26a}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hRow.red{color:#ff9d9d}'
      +'#'+LIVE_ALERT_CONTAINER_ID+' .pm-history .hEmpty{color:#666;font-style:italic;padding:8px 0}'
      // Status panel: bottom-left, max-width 360px, with collapse to mini-pill state.
      +'#'+LIVE_STATUS_PANEL_ID+'{position:fixed;left:16px;bottom:16px;z-index:2147483646;'
      +'background:#12121a;color:#e8e8ee;border:1px solid #22222d;border-radius:10px;padding:10px 14px;'
      +'font-family:system-ui,sans-serif;font-size:11px;box-shadow:0 6px 20px rgba(0,0,0,.5);'
      +'min-width:280px;max-width:360px}'
      +'#'+LIVE_STATUS_PANEL_ID+'.collapsed{padding:6px 12px;min-width:0;max-width:200px}'
      +'#'+LIVE_STATUS_PANEL_ID+'.collapsed .meta{display:none}'
      +'#'+LIVE_STATUS_PANEL_ID+'.collapsed .btnRow{display:none}'
      +'#'+LIVE_STATUS_PANEL_ID+' .topRow{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}'
      +'#'+LIVE_STATUS_PANEL_ID+' .hdr{font-weight:600;font-size:13px;color:#e8e8ee}'
      +'#'+LIVE_STATUS_PANEL_ID+' .hdr.paused{color:#888}'
      +'#'+LIVE_STATUS_PANEL_ID+' .minBtn{background:none;border:none;color:#666;font-size:14px;cursor:pointer;padding:0 4px;line-height:1}'
      +'#'+LIVE_STATUS_PANEL_ID+' .minBtn:hover{color:#e8e8ee}'
      +'#'+LIVE_STATUS_PANEL_ID+' .meta{color:#888;font-size:10.5px;margin-bottom:8px}'
      +'#'+LIVE_STATUS_PANEL_ID+' .btnRow{display:flex;gap:6px;flex-wrap:wrap}'
      +'#'+LIVE_STATUS_PANEL_ID+' button{background:#1a1a24;color:#e8e8ee;border:1px solid #2f2f3a;'
      +'border-radius:6px;padding:5px 10px;font-size:10.5px;cursor:pointer;font-family:inherit}'
      +'#'+LIVE_STATUS_PANEL_ID+' button:hover{border-color:#2a7fff}';
    document.head.appendChild(s);
  }

  function injectAlertContainer(){
    let c = document.getElementById(LIVE_ALERT_CONTAINER_ID);
    if (c) return c;
    c = document.createElement('div');
    c.id = LIVE_ALERT_CONTAINER_ID;
    document.body.appendChild(c);
    return c;
  }

  function injectStatusPanel(){
    let p = document.getElementById(LIVE_STATUS_PANEL_ID);
    if (p) return p;
    p = document.createElement('div');
    p.id = LIVE_STATUS_PANEL_ID;
    // v2.17: collapsible — minBtn shrinks the panel to a pill (header only); click again to restore.
    p.innerHTML = '<div class=topRow>'
      +'<div class=hdr id=pmsHdr></div>'
      +'<button class=minBtn id=pmsMinBtn title="Collapse">–</button>'
      +'</div>'
      +'<div class=meta id=pmsMeta></div>'
      +'<div class=btnRow>'
      +'<button id=pmsToggleBtn></button>'
      +'<button id=pmsSoundBtn></button>'
      +'<button id=pmsRefreshBtn>Refresh prices now</button>'
      +'<button id=pmsRescanBtn>Full rescan</button>'
      +'</div>';
    document.body.appendChild(p);
    p.querySelector('#pmsToggleBtn').addEventListener('click', () => {
      const st = window.pmSportsLiveState; if (!st) return;
      st.enabled = !st.enabled;
      try { localStorage.setItem(LIVE_ALERT_ENABLED_KEY, String(st.enabled)); } catch(_){}
      updateStatusPanel();
    });
    // v2.21: sound toggle. Persisted in localStorage; default ON. Failures wrapped in try/catch
    // upstream — sound never blocks alert render.
    const soundBtn = p.querySelector('#pmsSoundBtn');
    const refreshSoundLabel = () => { soundBtn.textContent = isSoundEnabled() ? '🔔 Sound' : '🔕 Mute'; };
    refreshSoundLabel();
    soundBtn.addEventListener('click', () => {
      setSoundEnabled(!isSoundEnabled());
      refreshSoundLabel();
    });
    p.querySelector('#pmsRefreshBtn').addEventListener('click', () => { updateLiveEdge(); });
    p.querySelector('#pmsRescanBtn').addEventListener('click', () => { try { run(); } catch(_){} });
    p.querySelector('#pmsMinBtn').addEventListener('click', () => {
      const collapsed = p.classList.toggle('collapsed');
      const btn = p.querySelector('#pmsMinBtn');
      btn.textContent = collapsed ? '+' : '–';
      btn.title = collapsed ? 'Expand' : 'Collapse';
    });
    return p;
  }

  function removeLiveUI(){
    [LIVE_ALERT_CONTAINER_ID, LIVE_STATUS_PANEL_ID].forEach(id => {
      const el = document.getElementById(id); if (el) el.remove();
    });
  }

  function updateStatusPanel(){
    const st = window.pmSportsLiveState;
    const p = document.getElementById(LIVE_STATUS_PANEL_ID);
    if (!st || !p) return;
    const hdr = p.querySelector('#pmsHdr');
    const meta = p.querySelector('#pmsMeta');
    const tog = p.querySelector('#pmsToggleBtn');
    const wallets = st.uniqueWallets || 0;
    if (st.enabled) {
      hdr.textContent = '🟢 Live · ' + wallets + ' wallets locked';
      hdr.className = 'hdr';
      tog.textContent = 'Pause alerts';
    } else {
      hdr.textContent = '⏸ Paused · ' + wallets + ' wallets locked';
      hdr.className = 'hdr paused';
      tog.textContent = 'Resume alerts';
    }
    const now = Date.now();
    const fmtAgo = ms => {
      if (ms < 0 || ms == null || isNaN(ms)) return 'never';
      if (ms < 60000) return Math.round(ms/1000) + 's ago';
      if (ms < 3600000) return Math.round(ms/60000) + 'm ago';
      return (ms/3600000).toFixed(1) + 'h ago';
    };
    const scanAgo  = st.lastFullScanAt     ? fmtAgo(now - st.lastFullScanAt)     : '—';
    const priceAgo = st.lastPriceRefreshAt ? fmtAgo(now - st.lastPriceRefreshAt) : '—';
    meta.textContent = 'Last full scan: ' + scanAgo + ' · Last price: ' + priceAgo;
  }

  // v2.19: decision-aware reasons. Compact, single-line — the rich card UI carries the
  // numbers; the reason text answers "should I bet?" not "what numbers moved?".
  function formatAlertReason(type, fmt){
    switch (type) {
      case 'BET_OPENING':
        return 'Newly qualifies as BET — model edge crossed the threshold.';
      case 'EDGE_IMPROVED':
        return 'Edge increased '+fmt.prevEdgePp+'pp → '+fmt.edgePp+'pp. Price '+fmt.prevPriceCents+'¢ → '+fmt.priceCents+'¢.';
      case 'BETTER_PRICE_STILL_GOOD':
        return 'Price improved and model edge remains positive.';
      case 'BETTER_PRICE_BUT_WEAK':
        return 'Price improved, but Tail Winners score is below threshold.';
      case 'BETTER_PRICE_BUT_PASS':
        return 'Price improved, but model edge is not positive.';
      case 'TAIL_SCORE_IMPROVED':
        return 'Tail score '+fmt.prevTailScore+' → '+fmt.tailScore+'. Extension '+fmt.extensionRatio+'.';
      case 'EDGE_FADING':
        return 'Edge fell '+fmt.prevEdgePp+'pp → '+fmt.edgePp+'pp. Watch closely.';
      case 'NO_LONGER_ACTIONABLE':
        return 'Action changed '+fmt.prevAction+' → '+fmt.action+'. Stop entering.';
      case 'PRICE_TOO_EXTENDED':
        return 'Current price already past model fair value. Skip.';
      default:
        return '';
    }
  }
  // Headline used at the top of each toast/history row.
  function alertHeadline(type){ return LIVE_ALERT_HEADERS[type] || type; }
  // Legacy single-line message kept for back-compat (logged to console).
  function formatAlertMessage(type, fmt){
    return alertHeadline(type) + ' · ' + (fmt.marketName||'') + ' · ' + (fmt.side||'') + ' — ' + formatAlertReason(type, fmt);
  }

  // v2.17: only the active toast STACK (newest 3) is rendered as full toasts.
  // After LIVE_PILL_COLLAPSE_MS of no new alerts, the stack auto-collapses to a
  // "SPORTGPT Alerts (N)" pill. Clicking the pill toggles the history view (last 10).
  // Each new fireAlert() resets the collapse timer.
  function renderToast(alert){
    if (!alert) return;
    const c = injectAlertContainer();
    // If a pill or history is showing, clear them first — fresh toast wins.
    const pill = c.querySelector('.pm-pill'); if (pill) pill.remove();
    const hist = c.querySelector('.pm-history'); if (hist) hist.remove();
    const t = renderAlertCard(alert, 'pm-toast');
    c.insertBefore(t, c.firstChild);
    // Keep only the toast nodes, cap at LIVE_MAX_VISIBLE_TOASTS = 3.
    const toasts = Array.from(c.querySelectorAll('.pm-toast'));
    for (let i = LIVE_MAX_VISIBLE_TOASTS; i < toasts.length; i++) toasts[i].remove();
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => { try { t.remove(); } catch(_){} }, 500); }, LIVE_TOAST_TTL_MS);
    // (Re)start the collapse timer.
    if (livePillTimerId) { try { clearTimeout(livePillTimerId); } catch(_){} }
    livePillTimerId = setTimeout(() => collapseAlertsToPill(), LIVE_PILL_COLLAPSE_MS);
  }

  function collapseAlertsToPill(){
    const c = document.getElementById(LIVE_ALERT_CONTAINER_ID);
    if (!c) return;
    // Remove stale toasts; keep history if open.
    Array.from(c.querySelectorAll('.pm-toast')).forEach(t => t.remove());
    if (c.querySelector('.pm-pill') || c.querySelector('.pm-history')) return;
    const st = window.pmSportsLiveState;
    const total = st && Array.isArray(st.alerts) ? st.alerts.length : 0;
    const pill = document.createElement('div');
    pill.className = 'pm-pill';
    pill.innerHTML = '🔔 SPORTGPT Alerts <span class=ct>'+total+'</span>';
    pill.title = 'Click to view recent alerts';
    pill.addEventListener('click', () => { renderHistoryPanel(); });
    c.appendChild(pill);
  }

  function renderHistoryPanel(){
    const c = document.getElementById(LIVE_ALERT_CONTAINER_ID);
    if (!c) return;
    Array.from(c.children).forEach(ch => ch.remove());
    const st = window.pmSportsLiveState;
    // v2.21: sort toggle. 'edge' (default) re-orders the snapshot by |edge| desc; 'recent'
    // re-orders by t desc. Underlying st.alerts is always edge-sorted by fireAlert; this
    // toggle only affects the history-panel render order.
    if (st && !st.alertHistorySort) st.alertHistorySort = 'edge';
    const sortMode = (st && st.alertHistorySort) || 'edge';
    const raw = (st && Array.isArray(st.alerts)) ? st.alerts.slice(0, LIVE_MAX_STORED_ALERTS) : [];
    const list = sortMode === 'recent'
      ? raw.slice().sort((a,b) => (b.t||0) - (a.t||0))
      : raw.slice().sort((a,b) => Math.abs(b.edge||0) - Math.abs(a.edge||0));
    const sortLabel = sortMode === 'recent' ? 'Sort: Recent ↓' : 'Sort: Edge ↓';
    const wrap = document.createElement('div');
    wrap.className = 'pm-history';
    wrap.innerHTML = '<div class=hHdr><span>Recent alerts ('+list.length+')</span>'
      +'<span style="display:inline-flex;align-items:center;gap:6px">'
      +'<button class=hSort title="Toggle sort order">'+sortLabel+'</button>'
      +'<button class=hClose title="Close">×</button>'
      +'</span></div>';
    if (list.length) {
      list.forEach(a => wrap.appendChild(renderAlertCard(a, 'hRow')));
    } else {
      const empty = document.createElement('div');
      empty.className = 'hEmpty';
      empty.textContent = 'No alerts yet — live loop is watching.';
      wrap.appendChild(empty);
    }
    c.appendChild(wrap);
    wrap.querySelector('.hClose').addEventListener('click', () => collapseAlertsToPill());
    wrap.querySelector('.hSort').addEventListener('click', (e) => {
      e.stopPropagation();
      if (st) st.alertHistorySort = (st.alertHistorySort === 'recent') ? 'edge' : 'recent';
      renderHistoryPanel();
    });
  }

  // v2.19: rich decision card used for both live toasts and history rows. Same shape, same
  // click handler. dataAlertId is the index into state.alerts at render time — re-render
  // (e.g. after dedup-update) replaces the existing node so pointer stays clean.
  function renderAlertCard(alert, cls){
    const wrap = document.createElement('div');
    wrap.className = (cls || 'pm-toast') + ' ' + (alert.color || 'green');
    wrap.style.cursor = 'pointer';
    wrap.title = 'Click to open this market on Polymarket and select the side';
    // v2.21: stale dimming. Live toasts go stale faster (3 min) than history rows (5 min)
    // because the toast is meant to drive immediate action.
    const isToast = cls === 'pm-toast' || !cls;
    const staleThreshold = isToast ? TUNING.STALE_ALERT_LIVE_MS : TUNING.STALE_ALERT_MS;
    const age = Date.now() - (alert.t || Date.now());
    const isStale = age > staleThreshold;
    if (isStale) wrap.style.opacity = '0.4';
    const ts = new Date(alert.t || Date.now()).toLocaleTimeString();
    const staleSuffix = isStale ? '<span class=staleTag>· stale</span>' : '';
    const head = '<div class=ts>'+ts+' · '+liveEsc(alertHeadline(alert.type))+staleSuffix+'</div>';
    const titleLine = '<div class=msg style="font-weight:600">'+liveEsc(alert.marketShortTitle || alert.marketQuestion || '')+' · '+liveEsc(alert.displaySide || alert.side || '')+'</div>';
    // Stats row.
    const fmtPct  = v => (v == null || isNaN(v)) ? '—' : (v*100).toFixed(0)+'%';
    const fmtCent = v => (v == null || isNaN(v)) ? '—' : Math.round(v*100)+'¢';
    const fmtPp   = v => (v == null || isNaN(v)) ? '—' : ((v>=0?'+':'')+(v*100).toFixed(1)+'pp');
    // v2.20: stats row is SECONDARY — no per-value color. Edge is plain text so it doesn't
    // compete with the dominant action-badge color. Keeps "edge color must not override
    // final action color" rule from the spec.
    const stats = '<div class=alertStats>'
      +'Current <b>'+fmtCent(alert.currentPrice)+'</b> · '
      +'Fair <b>'+fmtPct(alert.fairValue)+'</b> · '
      +'Edge <b>'+fmtPp(alert.edge)+'</b> · '
      +'Conf <b>'+fmtPct(alert.confidence)+'</b>'
      +(alert.tailScore != null ? ' · Tail <b>'+alert.tailScore+'/100</b>' : '')
    +'</div>';
    // Action badge — color hierarchy: BET=orange (NOW), LEAN=green (watch),
    // PASS=red, FADE=red. v2.20.
    const action = alert.action || '—';
    const actCls = action === 'BET'  ? 'orange'
                 : action === 'LEAN' ? 'green'
                 : (action === 'PASS' || action === 'FADE') ? 'red'
                 : '';
    const actionLine = '<div class=alertAction><span class="actionBadge '+actCls+'">Action: '+liveEsc(action)+'</span></div>';
    const reasonLine = '<div class=alertReason>'+liveEsc(alert.reason || alert.message || '')+'</div>';
    // v2.21: dynamic CTA per color. Falls back to the legacy line when currentPrice missing.
    // v2.29.0: CTA text shows displaySide (e.g. "Under 4.5"); the underlying click handler
    // still matches DOM-button text via alert.sideLabel / alert.side (raw Polymarket outcome).
    const sideTxt = liveEsc(alert.displaySide || alert.sideLabel || alert.side || '');
    const priceCents = (alert.currentPrice != null && !isNaN(alert.currentPrice))
      ? Math.round(alert.currentPrice * 100) + '¢'
      : null;
    let ctaText;
    if (priceCents == null) {
      ctaText = '👉 Click to open bet';
    } else if (alert.color === 'orange') {
      ctaText = '👉 BET ' + sideTxt + ' at ' + priceCents + ' — click to open';
    } else if (alert.color === 'green') {
      ctaText = '👀 WATCH ' + sideTxt + ' at ' + priceCents;
    } else if (alert.color === 'yellow') {
      ctaText = '⚠️ CAUTION — edge fading on ' + sideTxt;
    } else if (alert.color === 'red') {
      ctaText = '🚫 SKIP — price past fair value';
    } else {
      ctaText = '👉 Click to open bet';
    }
    const cta = '<div class=alertCta>'+ctaText+'</div>';
    wrap.innerHTML = head + titleLine + stats + actionLine + reasonLine + cta;
    wrap.addEventListener('click', () => { try { focusPolymarketBetTarget(alert); } catch(e) { console.warn('[PM Sports] alert click failed:', e); } });
    return wrap;
  }

  // v2.19: navigate to the event + scroll to the market card + open the matching outcome.
  // Safety: NEVER clicks any button matching /confirm|place\s+order|submit|approve/i.
  // The user always confirms manually. This just opens the trade panel pre-filled.
  function focusPolymarketBetTarget(alert){
    if (!alert) return;
    // 1. Navigate to event URL if not already there. Polymarket sport events live at
    //    /event/<slug> typically; fall back to keeping current path if slug is empty.
    const onSamePage = alert.slug && location.pathname.indexOf(alert.slug) >= 0;
    if (!onSamePage && alert.slug) {
      // Heuristic: if user is currently on /sports/<league>/<slug> form, keep it.
      // Otherwise navigate to /event/<slug>.
      const target = location.pathname.includes('/sports/') || location.pathname.includes('/esports/')
        ? location.pathname.replace(/[^/]+$/, alert.slug)
        : '/event/' + alert.slug;
      try { console.log('[PM Sports] navigating to', target); } catch(_){}
      location.href = target;
      return;
    }
    // 2. Find the matching market card on the page.
    const card = findMarketCard(alert.marketQuestion);
    if (!card) {
      console.warn('[PM Sports] could not find market card for:', alert.marketQuestion);
      return;
    }
    // 3. Scroll into view.
    try { card.scrollIntoView({behavior: 'smooth', block: 'center'}); } catch(_){}
    // 4. Highlight for 5 seconds.
    highlightTargetElement(card);
    // 5. Try to click the matching outcome side. Best-effort — Polymarket DOM is React.
    setTimeout(() => { try { selectOutcomeSide(card, alert.side); } catch(e) { console.warn('[PM Sports] selectOutcomeSide failed:', e); } }, 400);
  }

  function findMarketCard(question){
    if (!question || typeof question !== 'string') return null;
    const q = question.toLowerCase().trim();
    if (q.length < 5) return null;
    // v2.21: tighter card scoping. Snippet bumped 50→80 chars so partial-question matches
    // can't collide with adjacent markets ("Knicks vs Pistons - spread" vs "Knicks vs
    // Pistons - total"). STRICT pass requires a clickable descendant + bounded textContent
    // length so the body wrapper / main pane doesn't qualify; smallest candidate wins.
    // FALLBACK pass uses the v2.19 loose match so we never regress to "no match found".
    const snippet = q.slice(0, Math.min(80, q.length));
    const all = document.querySelectorAll('div, section, article, li, [role="listitem"], [role="article"]');
    const strictHits = [];
    const looseHits  = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const t = (el.textContent || '').toLowerCase();
      if (!t.includes(snippet)) continue;
      looseHits.push({el, len: t.length});
      // Strict gate: must have at least one clickable descendant AND bounded text length.
      const tlen = t.length;
      const minLen = snippet.length;
      const maxLen = snippet.length * 8;
      if (tlen < minLen || tlen > maxLen) continue;
      if (el.offsetParent === null) continue;  // hidden
      const hasClickable = el.querySelector('button, [role="button"], [tabindex]:not([tabindex="-1"])');
      if (!hasClickable) continue;
      strictHits.push({el, len: tlen});
    }
    if (strictHits.length) {
      strictHits.sort((a, b) => a.len - b.len);
      try { console.log('[PM Sports] findMarketCard match:', strictHits[0].el.tagName, '· text-len', strictHits[0].len); } catch(_){}
      return strictHits[0].el;
    }
    if (!looseHits.length) {
      try { console.warn('[PM Sports] findMarketCard: no match for snippet "'+snippet.slice(0,60)+'"'); } catch(_){}
      return null;
    }
    looseHits.sort((a, b) => a.len - b.len);
    try { console.log('[PM Sports] findMarketCard fallback match:', looseHits[0].el.tagName, '· text-len', looseHits[0].len); } catch(_){}
    return looseHits[0].el;
  }

  function highlightTargetElement(el){
    if (!el) return;
    try {
      const orig = el.style.outline;
      const origOffset = el.style.outlineOffset;
      el.style.outline = '3px solid #5fd17a';
      el.style.outlineOffset = '4px';
      el.style.borderRadius = el.style.borderRadius || '8px';
      el.style.transition = 'outline 0.3s ease';
      setTimeout(() => {
        try {
          el.style.outline = orig || '';
          el.style.outlineOffset = origOffset || '';
        } catch(_){}
      }, 5000);
    } catch(_){}
  }

  // Click an outcome button (Yes/No or team name) but NEVER click a confirm/submit button.
  // Polymarket's outcome buttons typically include both the label and a price (e.g. "Yes 53¢").
  // v2.21: widened to include [role=button] / [tabindex] (Polymarket's outcome controls are
  // often <div role="button">). Visibility filter (offsetParent) skips hidden offscreen
  // candidates; text-length cap (60) skips the wrapper that contains both buttons. Synthetic
  // mousedown→mouseup→click sequence dispatched alongside .click() — some React handlers
  // only listen on mousedown, so plain .click() doesn't open the buy panel.
  function selectOutcomeSide(card, sideLabel){
    if (!card || !sideLabel) return;
    const lbl = String(sideLabel).toLowerCase().trim();
    if (!lbl) return;
    const buttons = Array.from(card.querySelectorAll('button, [role="button"], [tabindex]:not([tabindex="-1"])'));
    for (const b of buttons) {
      if (b.offsetParent === null) continue;  // skip hidden
      const txt = (b.textContent || '').toLowerCase().trim();
      if (!txt) continue;
      if (txt.length > 60) continue;          // wrapper, not the actual button
      if (!txt.includes(lbl)) continue;
      // Safety: refuse anything that could submit / confirm / approve / place a trade.
      if (/confirm|place\s+(order|bet)|complete\s+order|submit|approve|sign|trade now|buy now/.test(txt)) continue;
      // Outcome buttons usually carry a price marker. Skip plain navigation tabs / links.
      if (!/¢|\d+%|\$\d/.test(txt)) continue;
      try {
        try { console.log('[PM Sports] click target:', b.tagName, b.textContent.slice(0,40)); } catch(_){}
        // Synthetic mousedown→mouseup→click first — React's outcome handlers usually listen on
        // mousedown. Plain .click() runs as a backup so plain DOM handlers still trigger.
        try {
          ['mousedown','mouseup','click'].forEach(type => {
            b.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window}));
          });
        } catch(_){}
        try { b.click(); } catch(_){}
        return;
      } catch(_){}
    }
    try { console.warn('[PM Sports] selectOutcomeSide: no outcome button in card for side "'+sideLabel+'"'); } catch(_){}
  }

  // v2.21: manual debug helper. Lets the user test the click-to-bet matcher from the
  // devtools console without waiting for an alert. Useful when Polymarket's DOM changes
  // and we need to iterate. Usage:
  //   window.pmsportsTestClick('Knicks vs Pistons - spread Pistons -3.5', 'Yes')
  try {
    if (typeof window !== 'undefined') {
      window.pmsportsTestClick = function(marketQuestion, sideLabel){
        const fakeAlert = {
          slug: (window.pmSportsLiveState && window.pmSportsLiveState.slug) || null,
          marketQuestion: marketQuestion,
          sideLabel: sideLabel,
          side: sideLabel,
          currentPrice: null
        };
        return focusPolymarketBetTarget(fakeAlert);
      };
    }
  } catch(_){}

  // v2.19: dedup with update-in-place. Within the 60s window, if same (cid|side|type) fires
  // again AND price moved ≥0.5¢ OR edge moved ≥0.5pp, REPLACE the existing alert in
  // state.alerts (mutate the entry) so the toast/history reflects the latest values
  // instead of spamming a duplicate. After 60s, fire fresh.
  // Builds the rich payload from `meta` + `cur` + `fmt`.
  function fireAlert(type, cid, side, fmt, meta, cur){
    const st = window.pmSportsLiveState; if (!st) return;
    const key = cid + '|' + side + '|' + type;
    const now = Date.now();
    const histEntry = st.alertHistory[key];
    const lastTs    = (histEntry && typeof histEntry === 'object') ? histEntry.t : (typeof histEntry === 'number' ? histEntry : 0);
    const lastPrice = (histEntry && typeof histEntry === 'object') ? histEntry.price : null;
    const lastEdge  = (histEntry && typeof histEntry === 'object') ? histEntry.edge  : null;
    const within60s = (now - lastTs) < LIVE_DEDUP_MS;
    if (within60s) {
      // Within dedup window. Allow UPDATE if price or edge moved materially.
      const priceMoved = (cur && cur.rawPrice != null && lastPrice != null && Math.abs(cur.rawPrice - lastPrice) >= 0.005);
      const edgeMoved  = (cur && cur.edge     != null && lastEdge  != null && Math.abs(cur.edge     - lastEdge)  >= 0.005);
      if (!priceMoved && !edgeMoved) return;  // nothing changed → suppress
      // Find the existing alert in state.alerts and update it.
      const idx = st.alerts.findIndex(a => a.cid === cid && a.side === side && a.type === type);
      if (idx >= 0) {
        const updated = buildAlert(type, cid, side, fmt, meta, cur, now);
        st.alerts[idx] = updated;
        // v2.21: re-sort alerts by |edge| desc so the toast stack reflects best-edge-first
        // order even after an in-place update.
        st.alerts.sort((a,b) => Math.abs(b.edge||0) - Math.abs(a.edge||0));
        st.alertHistory[key] = { t: now, price: cur ? cur.rawPrice : null, edge: cur ? cur.edge : null };
        if (st.enabled) {
          replaceVisibleToast(idx, updated);
          // v2.21: sound on update too — material price/edge moves are also signal.
          try { playAlertSound(updated.color); } catch(_){}
          // v2.21: flash matching Top Pick card on orange BET alert.
          try { flashPickCardForAlert(updated); } catch(_){}
        }
        return;
      }
      // Fall through if not found (e.g. evicted from buffer) → fire fresh.
    }
    const alert = buildAlert(type, cid, side, fmt, meta, cur, now);
    st.alertHistory[key] = { t: now, price: cur ? cur.rawPrice : null, edge: cur ? cur.edge : null };
    st.alerts.unshift(alert);
    // v2.21: sort by |edge| desc — toast stack and history default both reflect best-edge-first.
    // Stored alert ORDER changes; the underlying entries are unchanged.
    st.alerts.sort((a,b) => Math.abs(b.edge||0) - Math.abs(a.edge||0));
    if (st.alerts.length > LIVE_MAX_STORED_ALERTS) st.alerts.length = LIVE_MAX_STORED_ALERTS;
    if (st.enabled) {
      renderToast(alert);
      // v2.21: sound + popup flash. Both wrapped — never block render.
      try { playAlertSound(alert.color); } catch(_){}
      try { flashPickCardForAlert(alert); } catch(_){}
    }
    try { console.log('[PM Sports alert]', alert.type, '·', alert.marketShortTitle || alert.marketQuestion, '·', alert.displaySide || alert.side); } catch(_){}
  }

  // Pure helper that constructs the full alert payload (rich card UI + click navigation).
  function buildAlert(type, cid, side, fmt, meta, cur, ts){
    meta = meta || {};
    cur  = cur  || {};
    const reason = formatAlertReason(type, fmt);
    const marketQuestion = meta.marketQuestion || (fmt && fmt.marketName) || '';
    // v2.29.0: normalize once for the human-facing message + payload fields. `side` and
    // `sideLabel` stay as the raw Polymarket outcome — alert dedup at ~2562 and the DOM
    // click handler in focusPolymarketBetTarget rely on that.
    const _disp = normalizeDisplaySide(marketQuestion, side);
    const displaySide = _disp.displaySide;
    const message = alertHeadline(type) + ' · ' + (fmt && fmt.marketName ? fmt.marketName : '') + ' · ' + displaySide + ' — ' + reason;
    return {
      type, cid, side,
      message,
      t: ts || Date.now(),
      color: LIVE_ALERT_COLORS[type] || 'green',
      // Click-navigation fields:
      slug:           meta.slug || (window.pmSportsLiveState && window.pmSportsLiveState.slug) || null,
      tokenId:        meta.tokenId || null,
      sideLabel:      side,
      marketQuestion: marketQuestion,
      marketShortTitle: marketQuestion.length > 60 ? marketQuestion.slice(0, 60) + '…' : marketQuestion,
      outcomeIndex:   meta.outcomeIndex != null ? meta.outcomeIndex : null,
      // v2.29.0: display-only side fields. Renderers prefer displaySide; rawSide is here
      // for downstream bot consumers that want both shapes without re-deriving.
      rawSide:        _disp.rawSide,
      displaySide:    displaySide,
      line:           _disp.line,
      sideType:       _disp.sideType,
      // Decision card fields:
      currentPrice:   cur.rawPrice != null ? cur.rawPrice : null,
      fairValue:      cur.modelProb != null ? cur.modelProb : null,
      edge:           cur.edge != null ? cur.edge : null,
      confidence:     meta.confidence != null ? meta.confidence : null,
      tailScore:      cur.tailScore != null ? cur.tailScore : null,
      action:         cur.action || null,
      reason
    };
  }

  // Replace the visible DOM node for an alert that just got updated in place.
  function replaceVisibleToast(idx, alert){
    const c = document.getElementById(LIVE_ALERT_CONTAINER_ID);
    if (!c) return;
    // If a history view is open, re-render it with the updated entry.
    if (c.querySelector('.pm-history')) { renderHistoryPanel(); return; }
    // Otherwise re-render the visible toast stack (max 3 newest).
    Array.from(c.querySelectorAll('.pm-toast')).forEach(t => t.remove());
    const st = window.pmSportsLiveState;
    if (!st) return;
    const visible = st.alerts.slice(0, LIVE_MAX_VISIBLE_TOASTS);
    visible.reverse().forEach(a => c.insertBefore(renderAlertCard(a, 'pm-toast'), c.firstChild));
    if (livePillTimerId) { try { clearTimeout(livePillTimerId); } catch(_){} }
    livePillTimerId = setTimeout(() => collapseAlertsToPill(), LIVE_PILL_COLLAPSE_MS);
  }

  // BET / LEAN / PASS / FADE matches the prediction-table classifier semantics already
  // used at line ~2900 area (TABLE_BET_EDGE / TABLE_LEAN_EDGE / TABLE_FADE_EDGE thresholds).
  function classifyAction(edge, confidence){
    if (edge == null || isNaN(edge)) return 'PASS';
    if (edge >= TUNING.TABLE_BET_EDGE && (confidence||0) >= 0.50) return 'BET';
    if (edge >= TUNING.TABLE_LEAN_EDGE) return 'LEAN';
    if (edge <= TUNING.TABLE_FADE_EDGE) return 'FADE';
    return 'PASS';
  }

  // v2.34.0: gradeSide — execution-layer letter grade (A+/A/B/C/PASS) layered on top of
  // classifyAction. Pure read-only over its inputs; no global mutation, no I/O. Inputs are
  // all already computed per-side at scan time, so the grade is consistent with the
  // dashboard / bot-export view of that side. Returns {grade, reasons[]} where reasons
  // explain each downgrade that fired — surfaced in the EVENT DECISION banner and bot
  // export so users can see WHY a side missed A+.
  //
  // Starting tiers:
  //   action='BET'  starts at 'A+'  (downgrades cascade as gates fail)
  //   action='LEAN' starts at 'B'   (LEAN can never grade above B by design)
  //   action='PASS' / 'FADE'        → grade 'PASS', no downgrade chain
  //
  // Hard fails (return PASS immediately): edge ≤ 0, missing modelProb, weird price
  // (modelProb outside [GRADE_PROB_FLOOR, GRADE_PROB_CEIL]).
  function gradeSide(input){
    const action            = input.action;
    const edge              = input.edge;
    const modelProb         = input.modelProb;
    const totalNotional     = input.totalNotional;
    const holderCount       = input.holderCount;
    const marketType        = input.marketType;
    const tailScore         = input.tailScore;
    const extensionRatio    = input.extensionRatio;
    const exitSignal        = input.exitSignal;
    const smartMoneyDumping = input.smartMoneyDumping === true;
    const reasons = [];
    if (action === 'FADE') return { grade:'PASS', reasons:['action=FADE'] };
    if (action === 'PASS') return { grade:'PASS', reasons:['action=PASS'] };
    if (edge == null || isNaN(edge) || edge <= 0) return { grade:'PASS', reasons:['edge ≤ 0'] };
    if (modelProb != null && (modelProb < TUNING.GRADE_PROB_FLOOR || modelProb > TUNING.GRADE_PROB_CEIL)) {
      return { grade:'PASS', reasons:['weird price (modelProb '+(modelProb*100).toFixed(0)+'%)'] };
    }
    const ORDER = ['A+','A','B','C','PASS'];
    let grade = action === 'BET' ? 'A+' : 'B';   // LEAN starts at B
    function downgrade(toMin, reason){
      const cur = ORDER.indexOf(grade);
      const tgt = ORDER.indexOf(toMin);
      if (tgt > cur) { grade = toMin; reasons.push(reason); }
    }
    // Notional gates.
    if (totalNotional != null && !isNaN(totalNotional)) {
      if (totalNotional < TUNING.GRADE_NOTIONAL_B)            downgrade('C', 'thin liquidity ($'+Math.round(totalNotional/1000)+'k)');
      else if (totalNotional < TUNING.GRADE_NOTIONAL_A)       downgrade('B', 'modest liquidity ($'+Math.round(totalNotional/1000)+'k)');
      else if (totalNotional < TUNING.GRADE_NOTIONAL_A_PLUS)  downgrade('A', 'sub-A+ liquidity ($'+Math.round(totalNotional/1000)+'k)');
    }
    // Holder gates.
    if (holderCount != null && !isNaN(holderCount)) {
      if (holderCount < TUNING.GRADE_HOLDERS_B)             downgrade('C', 'few holders ('+holderCount+')');
      else if (holderCount < TUNING.GRADE_HOLDERS_A)        downgrade('B', 'modest holders ('+holderCount+')');
      else if (holderCount < TUNING.GRADE_HOLDERS_A_PLUS)   downgrade('A', 'sub-A+ holders ('+holderCount+')');
    }
    // Tail / price-extension gates.
    if (tailScore != null) {
      if (tailScore < TUNING.GRADE_TAIL_A)           downgrade('C', 'weak tail ('+tailScore+')');
      else if (tailScore < TUNING.GRADE_TAIL_A_PLUS) downgrade('A', 'sub-A+ tail ('+tailScore+')');
    } else if (action === 'BET') {
      // BET with no elite cohort — don't fail, but the lack of holder-backed confirmation caps at A.
      downgrade('A', 'no elite cohort (tail n/a)');
    }
    if (extensionRatio != null && extensionRatio >= 0.85) {
      downgrade('B', 'price extended ('+(extensionRatio*100).toFixed(0)+'% of fair)');
    }
    if (exitSignal != null && exitSignal < -0.2) {
      downgrade('B', 'smart-money exit signal ('+exitSignal.toFixed(2)+')');
    }
    // Probability window for A+ (a 90c near-lock is not a high-conviction BET — already mostly priced in).
    if (modelProb != null && (modelProb < TUNING.GRADE_PROB_A_PLUS_FLOOR || modelProb > TUNING.GRADE_PROB_A_PLUS_CEIL)) {
      downgrade('A', 'price '+Math.round(modelProb*100)+'% outside A+ band');
    }
    // Conflict signal (smart money is offloading the side our model favors).
    if (TUNING.GRADE_CONFLICT_BLOCKS_A_PLUS && smartMoneyDumping) {
      downgrade('B', 'smart money dumping this side');
    }
    // Market-type caps (prop / esports map markets are noisier — cap regardless of model edge).
    if (typeof marketType === 'string' && marketType) {
      if (/(_|^)prop$/.test(marketType) && TUNING.GRADE_CAP_PROP) {
        downgrade(TUNING.GRADE_CAP_PROP, 'prop-market cap ('+marketType+' → '+TUNING.GRADE_CAP_PROP+')');
      } else if (/esports_map$/.test(marketType) && TUNING.GRADE_CAP_MAP) {
        downgrade(TUNING.GRADE_CAP_MAP, 'esports-map cap ('+marketType+' → '+TUNING.GRADE_CAP_MAP+')');
      }
    }
    // LEAN action belt-and-suspenders cap at B (in case downgrades upgraded due to a no-op).
    if (action === 'LEAN' && ORDER.indexOf(grade) < ORDER.indexOf('B')) {
      grade = 'B'; reasons.push('action=LEAN caps at B');
    }
    return { grade, reasons };
  }
  try { if (typeof window !== 'undefined') window.pmsportsGradeSide = gradeSide; } catch(_){}

  // Mirrors v2.12 computeTailScore but uses meta values frozen at scan time. Only
  // currentPrice and edge change per tick — holderProfit / eliteShare / publicShare /
  // exitSignal / eliteAvgRoi all stay locked from the last full scan.
  function computeTailScoreLight(modelProb, currentPrice, edge, meta){
    if (modelProb == null || currentPrice == null || edge == null) return null;
    if (edge <= 0) {
      return { tailScore:0, stillTailPrice:'NO', extensionRatio:null, eliteAvgEntry:meta.eliteAvgEntry, currentPrice, fairValue:modelProb,
               edge, exitSignal:meta.exitSignal, eliteAvgRoi:meta.eliteAvgRoi,
               reason:'No remaining edge — model probability does not exceed market ask + fee.' };
    }
    if (meta.eliteAvgEntry == null || isNaN(meta.eliteAvgEntry)) return null;
    const rangeToFair = modelProb - meta.eliteAvgEntry;
    if (rangeToFair <= 0) {
      return { tailScore:0, stillTailPrice:'NO', extensionRatio:null, eliteAvgEntry:meta.eliteAvgEntry, currentPrice, fairValue:modelProb,
               edge, exitSignal:meta.exitSignal, eliteAvgRoi:meta.eliteAvgRoi,
               reason:'Bad tail: elite avg entry above model fair value.' };
    }
    const extensionRatio = (currentPrice - meta.eliteAvgEntry) / rangeToFair;
    const edgeScore = Math.max(0, Math.min(1, edge / 0.10));
    const extensionScore = extensionRatio >= 1 ? 0
                          : extensionRatio < 0 ? 1
                          : Math.max(0, 1 - extensionRatio);
    let holderScore = 0; let parts = 0;
    if (meta.eliteAvgRoi != null && !isNaN(meta.eliteAvgRoi)) {
      holderScore += Math.max(0, Math.min(1, 0.5 + meta.eliteAvgRoi / 0.6));
      parts++;
    }
    if (meta.holderProfit != null && !isNaN(meta.holderProfit)) {
      holderScore += Math.max(0, Math.min(1, (meta.holderProfit + 1) / 2));
      parts++;
    }
    holderScore = parts > 0 ? holderScore / parts : 0.5;
    const dominanceScore = Math.max(0, Math.min(1, 0.5 + ((meta.eliteShare||0) - (meta.publicShare||0)) * 2.5));
    const exitScore = (meta.exitSignal == null || isNaN(meta.exitSignal))
      ? 0.6
      : Math.max(0, Math.min(1, (meta.exitSignal + 1) / 2));
    const rawScore = 0.35*edgeScore + 0.25*extensionScore + 0.20*holderScore + 0.10*dominanceScore + 0.10*exitScore;
    let tailScore = Math.round(rawScore * 100);
    if (extensionRatio >= 1) tailScore = Math.min(tailScore, 25);
    let stillTailPrice;
    if (tailScore >= 70 && extensionRatio < 0.7 && edge >= 0.03) stillTailPrice = 'YES';
    else if (tailScore >= 50 && extensionRatio < 0.9)            stillTailPrice = 'MAYBE';
    else                                                          stillTailPrice = 'NO';
    return { tailScore, stillTailPrice, extensionRatio, eliteAvgEntry: meta.eliteAvgEntry,
             currentPrice, fairValue: modelProb, edge, exitSignal: meta.exitSignal,
             eliteAvgRoi: meta.eliteAvgRoi };
  }

  // Recompute the price-dependent quantities for one side from a fresh book.
  function recomputeSideLight(label, book, meta, modelProb, confidence){
    if (!meta) return null;
    const fee = meta.fee != null ? meta.fee : 0.01;
    const bestAsk = book && book.bestAsk != null ? book.bestAsk : null;
    const bestBid = book && book.bestBid != null ? book.bestBid : null;
    const rawPrice = bestAsk != null ? bestAsk
                   : bestBid != null ? Math.min(1, bestBid + 0.01)   // small spread buffer
                   : meta.fallbackPrice;
    if (rawPrice == null || isNaN(rawPrice)) return null;
    const effectiveCost = Math.min(1, rawPrice * (1 + fee));
    const edge = modelProb - effectiveCost;
    const tail = computeTailScoreLight(modelProb, rawPrice, edge, meta);
    return {
      edge, rawPrice, effectiveCost, modelProb,
      action: classifyAction(edge, confidence),
      tailScore: tail ? tail.tailScore : null,
      extensionRatio: tail && tail.extensionRatio != null ? tail.extensionRatio : null,
      t: Date.now()
    };
  }

  // Compare prev/cur snapshots; fire any alert types whose triggers fire.
  function checkAlerts(label, prev, cur, meta){
    if (!prev || !cur || !meta) return;
    const cid = meta.cid || '';
    const side = meta.displayLabel || label;
    const marketName = (meta.marketQuestion || '').slice(0, 60);
    const fmt = {
      marketName, side,
      action: cur.action, prevAction: prev.action,
      edgePp:        cur.edge != null ? (cur.edge*100).toFixed(1) : '—',
      prevEdgePp:    prev.edge != null ? (prev.edge*100).toFixed(1) : '—',
      priceCents:    cur.rawPrice != null ? Math.round(cur.rawPrice*100) : '—',
      prevPriceCents: prev.rawPrice != null ? Math.round(prev.rawPrice*100) : '—',
      modelProbPp:   cur.modelProb != null ? Math.round(cur.modelProb*100) : '—',
      tailScore:     cur.tailScore != null ? cur.tailScore : 'n/a',
      prevTailScore: prev.tailScore != null ? prev.tailScore : 'n/a',
      extensionRatio: cur.extensionRatio != null ? cur.extensionRatio.toFixed(2) : 'n/a'
    };
    const minTail = (TUNING && TUNING.TAIL_MIN_SCORE != null) ? TUNING.TAIL_MIN_SCORE : 50;
    // BET_OPENING: PASS|LEAN → BET
    if ((prev.action === 'PASS' || prev.action === 'LEAN') && cur.action === 'BET') {
      fireAlert('BET_OPENING', cid, side, fmt, meta, cur);
    }
    // EDGE_IMPROVED: edge up ≥ 2pp
    if (cur.edge != null && prev.edge != null && (cur.edge - prev.edge) >= 0.02) {
      fireAlert('EDGE_IMPROVED', cid, side, fmt, meta, cur);
    }
    // v2.19: price-improvement now branches into 3 decision-aware types.
    // Trigger: price down ≥ 2¢ AND modelProb unchanged.
    if (cur.rawPrice != null && prev.rawPrice != null
        && (prev.rawPrice - cur.rawPrice) >= 0.02
        && Math.abs((cur.modelProb||0) - (prev.modelProb||0)) < 0.001) {
      let priceType;
      if (cur.edge == null || cur.edge <= 0)                         priceType = 'BETTER_PRICE_BUT_PASS';
      else if (cur.tailScore != null && cur.tailScore < minTail)     priceType = 'BETTER_PRICE_BUT_WEAK';
      else                                                           priceType = 'BETTER_PRICE_STILL_GOOD';
      fireAlert(priceType, cid, side, fmt, meta, cur);
    }
    // EDGE_FADING: edge down ≥ 2pp AND still > 0
    if (cur.edge != null && prev.edge != null
        && (prev.edge - cur.edge) >= 0.02 && cur.edge > 0) {
      fireAlert('EDGE_FADING', cid, side, fmt, meta, cur);
    }
    // NO_LONGER_ACTIONABLE: BET|LEAN → PASS|FADE
    if ((prev.action === 'BET' || prev.action === 'LEAN')
        && (cur.action === 'PASS' || cur.action === 'FADE')) {
      fireAlert('NO_LONGER_ACTIONABLE', cid, side, fmt, meta, cur);
    }
    // TAIL_SCORE_IMPROVED: tailScore up ≥ 10
    if (cur.tailScore != null && prev.tailScore != null
        && (cur.tailScore - prev.tailScore) >= 10) {
      fireAlert('TAIL_SCORE_IMPROVED', cid, side, fmt, meta, cur);
    }
    // PRICE_TOO_EXTENDED: extensionRatio ≥ 1 OR tailScore < TAIL_MIN_SCORE
    if ((cur.extensionRatio != null && cur.extensionRatio >= 1)
        || (cur.tailScore != null && cur.tailScore < minTail)) {
      fireAlert('PRICE_TOO_EXTENDED', cid, side, fmt, meta, cur);
    }
  }

  // Lightweight POST /books (matches v2.0 batch shape) with simple inline retry.
  // Falls back to per-token GET on null. Returns { tokenId: { bestBid, bestAsk } }.
  async function fetchBooksLive(tokenIds){
    const out = {};
    if (!tokenIds || !tokenIds.length) return out;
    let arr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch('https://clob.polymarket.com/books', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ params: tokenIds.map(t => ({token_id: t})) })
        });
        if (!r.ok) throw new Error('books ' + r.status);
        const j = await r.json();
        if (Array.isArray(j) && j.length === tokenIds.length) { arr = j; break; }
        throw new Error('books shape mismatch');
      } catch(_) {
        if (attempt < 1) await new Promise(r => setTimeout(r, 600 + Math.random()*400));
      }
    }
    if (arr) {
      tokenIds.forEach((tid, i) => {
        const book = arr[i];
        if (!book) { out[tid] = null; return; }
        const bids = (book.bids||[]).map(l=>({price:Number(l.price), size:Number(l.size)})).filter(l=>l.size>0).sort((a,b)=>b.price-a.price);
        const asks = (book.asks||[]).map(l=>({price:Number(l.price), size:Number(l.size)})).filter(l=>l.size>0).sort((a,b)=>a.price-b.price);
        out[tid] = { bestBid: bids.length ? bids[0].price : null, bestAsk: asks.length ? asks[0].price : null };
      });
      return out;
    }
    // Per-token GET fallback (best-effort, no retry — keep tick fast)
    await Promise.all(tokenIds.map(async tid => {
      try {
        const r = await fetch('https://clob.polymarket.com/book?token_id=' + tid);
        if (!r.ok) { out[tid] = null; return; }
        const book = await r.json();
        const bids = (book.bids||[]).map(l=>({price:Number(l.price), size:Number(l.size)})).filter(l=>l.size>0).sort((a,b)=>b.price-a.price);
        const asks = (book.asks||[]).map(l=>({price:Number(l.price), size:Number(l.size)})).filter(l=>l.size>0).sort((a,b)=>a.price-b.price);
        out[tid] = { bestBid: bids.length ? bids[0].price : null, bestAsk: asks.length ? asks[0].price : null };
      } catch(_) { out[tid] = null; }
    }));
    return out;
  }

  async function updateLiveEdge(){
    const st = window.pmSportsLiveState;
    if (!st) return;
    // v2.28.1: re-entrancy guard. updateLiveEdge is reachable from THREE call sites
    // (manual refresh button click @ ~line 2151, install-time immediate kick via
    // Promise.resolve().then(...) @ ~line 2846, and setInterval @ ~line 2847). On slow
    // networks fetchBooksLive can outrun LIVE_TICK_MS, letting a second tick race the
    // first on st.bookSnapshot / st.lastSnapshot / checkAlerts(prev, cur, ...). The flag
    // lives on st (the singleton live-state object) and the try/finally guarantees it
    // clears even if fetchBooksLive throws or the slug-changed branch early-returns.
    if (st.tickInFlight) {
      try { console.log('[PM Sports live] tick: skipped (previous still running)'); } catch(_){}
      return;
    }
    st.tickInFlight = true;
    try {
      // Auto-terminate when navigation has moved off the scanned slug.
      const currentSlug = location.pathname.split('/').pop();
      if (st.slug && currentSlug !== st.slug) { teardownLiveLoop(); return; }
      // Collect unique tokenIds.
      const tokenIds = [];
      Object.values(st.sideMeta || {}).forEach(m => { if (m && m.tokenId && tokenIds.indexOf(m.tokenId) < 0) tokenIds.push(m.tokenId); });
      if (!tokenIds.length) return;
      const books = await fetchBooksLive(tokenIds);
      st.bookSnapshot = books;
      st.lastPriceRefreshAt = Date.now();
      let recomputed = 0;
      Object.keys(st.predictions || {}).forEach(label => {
        const meta = st.sideMeta[label]; if (!meta || !meta.tokenId) return;
        const book = books[meta.tokenId]; if (!book) return;
        const p = st.predictions[label];
        const cur = recomputeSideLight(label, book, meta, p.probability, p.confidence);
        if (!cur) return;
        const prev = st.lastSnapshot[label];
        if (prev) checkAlerts(label, prev, cur, meta);
        st.lastSnapshot[label] = cur;
        recomputed++;
      });
      try { console.log('[PM Sports live] tick: refreshed '+tokenIds.length+' tokens, '+recomputed+' sides'); } catch(_){}
      updateStatusPanel();
    } finally {
      st.tickInFlight = false;
    }
  }

  function installLiveLoop(){
    const st = window.pmSportsLiveState;
    if (!st) return;
    if (st.timerId) { try { clearInterval(st.timerId); } catch(_){} st.timerId = null; }
    injectLiveStyles();
    injectStatusPanel();
    injectAlertContainer();
    updateStatusPanel();
    // Kick one immediate tick, then schedule the interval.
    Promise.resolve().then(updateLiveEdge);
    st.timerId = setInterval(updateLiveEdge, LIVE_TICK_MS);
  }

  function teardownLiveLoop(){
    const st = window.pmSportsLiveState;
    if (st && st.timerId) { try { clearInterval(st.timerId); } catch(_){} st.timerId = null; }
    removeLiveUI();
    window.pmSportsLiveState = null;
  }

  // v2.32.0: per-scan AbortController. Re-clicking Scan aborts the previous in-flight scan
  // instead of running two scans in parallel (which doubled bandwidth + 429 budget pressure).
  // scanAbortsTotal survives across scans for diagnostics in the end-of-run subfetch log.
  let activeScanController = null;
  let scanAbortsTotal = 0;

  async function run(){
    if (activeScanController) {
      scanAbortsTotal++;
      try { activeScanController.abort(); console.log('[PM Sports] Aborted stale scan on re-click (#'+scanAbortsTotal+')'); } catch(_){}
    }
    const myAbortController = new AbortController();
    activeScanController = myAbortController;
    const slug = location.pathname.split('/').pop();
    const parts = location.pathname.split('/').filter(Boolean);
    const sportKey = (parts[1] || 'default').toLowerCase();
    const PROFILE = SPORTS_PROFILES[sportKey] || SPORTS_PROFILES.default;
    const TOPN_KEY = 'pmsports_v1_topn';
    const topN = parseInt(localStorage.getItem(TOPN_KEY) || '100', 10);
    // v2.22: split wallet-cache TTLs into HOT (derived stats — slow-aging) and COLD (positions/
    // activity arrays — faster-aging). v2.17 collapsed everything to 30min because predictions
    // ageing into next-day was the concern; the actual culprit was COLD positions/activity going
    // stale, not the derived HOT stats. Splitting lets warm reloads up to 4h short-circuit the
    // wallet phase while keeping flow data fresh enough for tail-score and exit-quality.
    const WALLET_HOT_TTL  = 4 * 60 * 60 * 1000;   // v2.22: 4h — derived wallet stats (HOT_PREFIX)
    const WALLET_COLD_TTL = 45 * 60 * 1000;       // v2.22: 45min — positions/activity (COLD_PREFIX)
    const LIFETIME_TTL    = WALLET_HOT_TTL;       // back-compat alias for any straggler reads
    const HOT_PREFIX  = 'pmsports_v1_hot_';   // derived stats only — small, always try to keep
    const COLD_PREFIX = 'pmsports_v1_cold_';  // bounded positions+activity slices — evict first
    // v2.15: NEW per-event and per-conditionId caches. Both stored under their own keys
    //        with explicit per-entry TTLs. Holder cache uses two TTLs: 10min for successful
    //        non-empty arrays, 3min for "expected no-data" responses (404 / empty array).
    //        Retryable failures (429 / 5xx / network) are NEVER cached — let the retry path win.
    const EVENT_PREFIX  = 'pmsports_event_';
    const HOLDER_PREFIX = 'pmsports_holders_';
    const EVENT_TTL          = 3 * 60 * 1000;   // 3 min
    const HOLDER_TTL_OK      = 10 * 60 * 1000;  // 10 min — non-empty holder array
    const HOLDER_TTL_NO_DATA = 3 * 60 * 1000;   // 3 min — 4xx silent or empty array
    // v2.30.0: subfetch short-TTL caches. Trades / books / prices-history / OI feed prediction
    // components (Flow24h, bookTilt, CLV, oiFactor); TTLs are sub-minute so rapid re-scans
    // reuse the snapshot and cold loads still re-fetch fresh. Comments are display-only.
    const TRADES_PREFIX   = 'pmsports_trades_';
    const BOOKS_PREFIX    = 'pmsports_books_';
    const PRICES_PREFIX   = 'pmsports_prices_';
    const OI_PREFIX       = 'pmsports_oi_';
    const COMMENTS_PREFIX = 'pmsports_comments_';
    const MARKET_ACTIVITY_PREFIX = 'pmsports_mktact_';   // v2.31.0: parallel market-activity fetch cache
    // v2.30.1: doubled (comments tripled) from v2.30.0. v2.30 picked sub-minute values
    // assuming re-scans happen within seconds; real cadence is closer to minutes. Formulas
    // unchanged — longer windows just keep the snapshot in play across typical re-scans.
    const TRADES_TTL   = 120 * 1000;       // v2.30.0: 60s
    const BOOKS_TTL    =  60 * 1000;       // v2.30.0: 30s
    const PRICES_TTL   = 120 * 1000;       // v2.30.0: 60s
    const OI_TTL       =  60 * 1000;       // v2.30.0: 30s
    const COMMENTS_TTL = 15 * 60 * 1000;   // v2.30.0: 5min
    const MARKET_ACTIVITY_TTL = 120 * 1000; // v2.31.0: 2 min
    // v2.30.0: per-wallet fail cooldown. When all 8 wallet calls return null we mark the
    // wallet failed; loadWallet skips it (returns empty-state shape) for 15min.
    const WALLET_FAIL_PREFIX = 'pmsports_walletfail_';
    const WALLET_FAIL_TTL    = 15 * 60 * 1000;
    // v2.30.0: per-endpoint 429 cooldown. Session-only Map (declared near safeFetch below)
    // marks host+path with cooldownUntil = now + 60s on retry exhaustion from 429.
    const ENDPOINT_429_COOLDOWN_MS = 60 * 1000;
    function evictOldest(prefix, fraction){
      const keys=[];
      for(let i=0;i<localStorage.length;i++){
        const k=localStorage.key(i);
        if(k && k.indexOf(prefix)===0){
          try{const v=JSON.parse(localStorage.getItem(k)); keys.push({k,ts:(v&&v.cachedAt)||0});}catch{}
        }
      }
      keys.sort((a,b)=>a.ts-b.ts);
      const remove=Math.max(1, Math.ceil(keys.length*fraction));
      for(let i=0;i<remove;i++) try{localStorage.removeItem(keys[i].k);}catch{}
    }
    function safeSet(key, value){
      try{ localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch(e){
        if(e && (e.name==='QuotaExceededError' || e.code===22)){
          console.log('[PM Sports] Cache full, evicting oldest 25%');
          evictOldest(COLD_PREFIX, 0.25);
          try{ localStorage.setItem(key, JSON.stringify(value)); return true; }
          catch(e2){
            evictOldest(HOT_PREFIX, 0.25);
            try{ localStorage.setItem(key, JSON.stringify(value)); return true; }catch{ return false; }
          }
        }
        return false;
      }
    }
    function cacheGet(addr){
      try{
        const h = JSON.parse(localStorage.getItem(HOT_PREFIX+addr));
        // v2.22: HOT gates the cache hit (4h). If HOT is stale, force the consumer to re-fetch
        // even if COLD is still fresh — derived stats are what the prediction layer reads, and
        // shipping a HOT/COLD age skew where COLD is newer would be confusing.
        if(!h || h.v!==1 || Date.now()-h.cachedAt >= WALLET_HOT_TTL) return null;
        let positions=null, activity=null;
        try{
          const c = JSON.parse(localStorage.getItem(COLD_PREFIX+addr));
          // v2.22: COLD has its own 45min TTL. When stale, return null arrays so any consumer
          // that revisits raw activity/positions sees "missing" rather than 4h-old data. The
          // prediction-critical path doesn't read positions/activity from the cache hit (audit
          // verified: lines 2737, 3029, 3063 only read HOT-bucket fields).
          if (c && c.v === 1 && Date.now() - (c.cachedAt || 0) < WALLET_COLD_TTL) {
            positions = c.positions; activity = c.activity;
          }
        }catch{}
        return {...h, positions, activity};
      }catch{ return null; }
    }
    function cacheSet(addr, derived, positions, activity){
      safeSet(HOT_PREFIX+addr, {...derived, v:1, cachedAt: Date.now()});
      const pos = Array.isArray(positions) ? positions.slice(0, TUNING.COLD_CACHE_SLICE) : [];
      const act = Array.isArray(activity) ? activity.slice(0, TUNING.COLD_CACHE_SLICE) : [];
      safeSet(COLD_PREFIX+addr, {positions: pos, activity: act, v:1, cachedAt: Date.now()});
    }
    // v2.30.0: generic short-TTL cache used by the subfetch wraps (trades / books / prices /
    // OI / comments). Stash is {data, v:1, cachedAt}; data is whatever the caller passes in
    // (raw response or parsed snapshot — caller's choice).
    // v2.31.0: L1 in-memory session cache in front of localStorage. Avoids the
    // synchronous JSON.parse/stringify round-trip on every short-TTL touch. The Map
    // is declared just below (after endpoint429Until); both functions are hoisted, so
    // forward reference is fine — they're only called from inside subfetchPromises[]
    // IIFEs which run well after `sessionShortCache` and `mon` are constructed.
    function cacheGetShort(prefix, key, ttl){
      const k = prefix + key;
      const mem = sessionShortCache.get(k);
      if (mem && Date.now() - mem.cachedAt < ttl) { mon.sessionCacheHits++; return mem.data; }
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (!v || v.v !== 1 || Date.now() - (v.cachedAt || 0) >= ttl) return null;
        sessionShortCache.set(k, { data: v.data, cachedAt: v.cachedAt });
        return v.data;
      } catch { return null; }
    }
    function cacheSetShort(prefix, key, data){
      const k = prefix + key;
      const now = Date.now();
      sessionShortCache.set(k, { data, cachedAt: now });
      safeSet(k, { data, v: 1, cachedAt: now });
    }
    // v2.30.0: per-wallet fail cooldown. Marker survives across runs (localStorage); read at
    // the top of _loadWalletRaw, written at the bottom when all 8 fetches return null.
    function walletFailCooldownActive(addr){
      try {
        const v = JSON.parse(localStorage.getItem(WALLET_FAIL_PREFIX + addr));
        if (!v || !v.cachedAt) return false;
        return Date.now() - v.cachedAt < WALLET_FAIL_TTL;
      } catch { return false; }
    }
    function markWalletFailed(addr){
      safeSet(WALLET_FAIL_PREFIX + addr, { cachedAt: Date.now(), v: 1 });
    }
    const BM_KEY = 'pmdash_v2_bookmarks';
    let bookmarks = {};
    try {
      const raw = JSON.parse(localStorage.getItem(BM_KEY) || '{}');
      if (Array.isArray(raw)) raw.forEach(a => { bookmarks[a] = { bookmarkedAt: Date.now(), firstSeenMarket: slug, note: '' }; });
      else if (raw && typeof raw === 'object') bookmarks = raw;
    } catch {}
    const saveBookmarks = () => { try { localStorage.setItem(BM_KEY, JSON.stringify(bookmarks)); } catch {} };
    let currentBatch = TUNING.HOLDER_FETCH_BATCH || 4;  // v2.13: was 24 (rate-limit storm); now bounded.
    // v2.13: extra counters — fails split by category, plus dedupe-hit tracking.
    //   fails           = total real failures (existing semantic)
    //   fail429         = subset of fails where retries exhausted on 429
    //   realFails       = subset of fails that are NOT 429 (5xx, network, unknown)
    //   expectedNoData  = silent 4xx (400/403/404/422) — NOT counted in fails
    //   fetchDedupeHits = safeFetch calls short-circuited by URL dedupe
    //   walletDedupeHits = loadWallet calls short-circuited by address dedupe
    // v2.15: added eventCacheHits + holderCacheHits. (walletCacheHits is already tracked
    // outside mon as the closure variable `walletCacheHits` defined further down — kept
    // for legacy compatibility; surfaced together in the end-of-run cache log.)
    // v2.30.0: extended mon with subfetch cache hits + fail cooldown skip counts + endpoint
    // 429 cooldown skip counts. Top-5 slowest requests tracked separately in `slowest` below.
    const mon = { calls: 0, totalMs: 0, fails: 0, fail429: 0, realFails: 0, expectedNoData: 0, fetchDedupeHits: 0, walletDedupeHits: 0, holderDedupeHits: 0, eventCacheHits: 0, holderCacheHits: 0, waveTotal: 0, waveFails: 0, failsByEndpoint: {}, failsByStatus: {}, tradesCacheHits: 0, booksCacheHits: 0, pricesCacheHits: 0, oiCacheHits: 0, commentsCacheHits: 0, walletFailSkips: 0, endpoint429Skips: 0, closedPositionsSkips: 0, marketActivityCacheHits: 0, sessionCacheHits: 0,
      // v2.35.0: turbo concurrency diagnostics. maxBatchReached = high-water mark of currentBatch
      // this scan; turboRollbackTriggered flips true on the first fail429 (one-shot, capped at
      // SAFE_MAX_DYNAMIC_BATCH for the rest of the run); turboRollbackAtCall records mon.calls at
      // the rollback moment so the end-of-run log can show how deep we got before backing off.
      maxBatchReached: TUNING.HOLDER_FETCH_BATCH || 6, turboRollbackTriggered: false, turboRollbackAtCall: null };
    // v2.30.0: per-endpoint 429 cooldown — session-only Map of host+path → expireMs. Populated
    // by safeFetch/safePost catch handlers when 429 retries exhaust; checked at the top of
    // those wrappers to fast-return null instead of paying another 3×exponential backoff.
    const endpoint429Until = new Map();
    // v2.31.0: L1 in-memory cache for cacheGetShort/cacheSetShort. Lives for this run only.
    // Skips the synchronous JSON.parse on repeat reads and JSON.stringify on writes that
    // would otherwise hit localStorage on every short-TTL touch.
    const sessionShortCache = new Map();
    // v2.30.0: top-5 slowest individual requests (sorted desc, capped). Populated on every
    // successful (non-cached, non-cooldown) fetch in _safeFetchRaw / safePost.
    const slowest = [];
    function recordSlowest(url, ms){
      if (slowest.length < 5 || ms > slowest[slowest.length - 1].ms) {
        slowest.push({ url, ms });
        slowest.sort((a, b) => b.ms - a.ms);
        if (slowest.length > 5) slowest.length = 5;
      }
    }
    // v2.6: extract a short endpoint family from a URL for fail-breakdown reporting.
    function endpointKey(url){
      try {
        const u = new URL(url);
        const path = u.pathname.replace(/\/+$/,'');
        return u.host + path;
      } catch { return 'unknown'; }
    }
    function bumpFail(url, status){
      mon.fails++; mon.waveFails++;
      const k = endpointKey(url);
      mon.failsByEndpoint[k] = (mon.failsByEndpoint[k] || 0) + 1;
      // v2.13: normalize the status key. safeFetch's catch block passes 'retryable 429' /
      // 'retryable 503' / a network message; tease the numeric code out for clean buckets.
      let s = String(status == null ? 'unknown' : status);
      const retryMatch = s.match(/^retryable\s+(\d+)/);
      if (retryMatch) s = retryMatch[1];
      mon.failsByStatus[s] = (mon.failsByStatus[s] || 0) + 1;
      // v2.13: split 429 from realFails so we can distinguish rate-limit storms from
      // genuine server errors / network issues.
      if (s === '429') mon.fail429++; else mon.realFails++;
      updateMon();
    }
    function updateMon(){
      const el = d && d.getElementById && d.getElementById('selfmon');
      if (!el) return;
      const avg = mon.calls ? Math.round(mon.totalMs/mon.calls) : 0;
      el.textContent = '⚙ '+currentBatch+' concurrent · avg '+avg+'ms · '+mon.fails+' fails';
    }
    // v2.5/v2.6: Which HTTP statuses count as "expected no-data" (silent null return vs real failure).
    // 404 = resource doesn't exist (common on prices-history, comments, closed-positions, oi).
    // 400/422 = wrong body/param shape for that specific market (book endpoints sometimes reject tokens).
    // 403 = endpoint-not-available-for-this-market; not a real error.
    function isExpectedNoData(status){ return status === 404 || status === 400 || status === 403 || status === 422; }
    // v2.13: URL-level dedupe. Map<url, Promise> — if two callers ask for the same URL while
    // a fetch is in-flight, the second joins the existing promise instead of spawning a duplicate.
    // Internal retries call _safeFetchRaw directly so they don't re-enter the wrapper.
    const inflightFetches = new Map();
    async function safeFetch(url, attempt = 0){
      // v2.30.0: endpoint 429 cooldown gate. If this URL's host+path was 429-throttled
      // recently we fast-return null instead of firing another request. Cooldown is checked
      // before the in-flight dedupe so we don't even join an in-flight call that's about to
      // fail. Internal retries (attempt > 0) bypass the gate so an in-flight retry can finish.
      if (attempt === 0) {
        const epKey = endpointKey(url);
        const cooldownUntil = endpoint429Until.get(epKey);
        if (cooldownUntil != null && Date.now() < cooldownUntil) {
          mon.endpoint429Skips++;
          return null;
        }
      }
      // Only dedupe on attempt 0 — internal retries should bypass the wrapper.
      if (attempt === 0 && inflightFetches.has(url)) {
        mon.fetchDedupeHits++;
        return inflightFetches.get(url);
      }
      if (attempt > 0) return _safeFetchRaw(url, attempt);
      const p = _safeFetchRaw(url, 0).finally(() => inflightFetches.delete(url));
      inflightFetches.set(url, p);
      return p;
    }
    async function _safeFetchRaw(url, attempt = 0){
      const t0 = Date.now();
      if (attempt === 0) mon.waveTotal++;
      try {
        const r = await fetch(url, { signal: myAbortController.signal });   // v2.32.0: cancellable on re-scan
        if (r.status === 429 || r.status >= 500) throw new Error('retryable '+r.status);
        const ms = Date.now() - t0;
        mon.calls++; mon.totalMs += ms;
        if (isExpectedNoData(r.status)) { mon.expectedNoData++; updateMon(); return null; }
        if (!r.ok) {
          console.log('[PM Dashboard] FAIL:', url, r.status);
          bumpFail(url, r.status);
          return null;
        }
        recordSlowest(url, ms);  // v2.30.0
        updateMon();
        return await r.json();
      } catch (e) {
        // v2.32.0: AbortError on re-scan — bail clean (no fail counter, no 429 cooldown, no retry).
        if (e && e.name === 'AbortError') return null;
        mon.calls++; mon.totalMs += Date.now()-t0;
        if (attempt < 3) {
          const wait = Math.min(500 * Math.pow(2, attempt), 10000) * (0.5 + Math.random());
          await new Promise(r => setTimeout(r, wait));
          return _safeFetchRaw(url, attempt + 1);  // v2.13: bypass dedupe for retries
        }
        // v2.30.0: on 429 exhaustion, mark the endpoint (host+path, no query) in cooldown
        // for ENDPOINT_429_COOLDOWN_MS (60s) so the next caller fast-fails instead of
        // paying another 3×exponential-backoff penalty.
        const msg = (e && e.message) || 'network';
        if (typeof msg === 'string' && msg.indexOf('retryable 429') === 0) {
          endpoint429Until.set(endpointKey(url), Date.now() + ENDPOINT_429_COOLDOWN_MS);
        }
        console.log('[PM Dashboard] FAIL:', url, msg);
        bumpFail(url, msg);
        return null;
      }
    }
    // v2.0: POST helper for batch endpoints (e.g. CLOB /books). Same retry logic, no fallback here —
    // callers handle null by reverting to per-item GETs.
    async function safePost(url, body, attempt = 0){
      // v2.30.0: endpoint 429 cooldown gate (mirrors safeFetch). attempt > 0 bypasses so
      // in-flight retries can finish.
      if (attempt === 0) {
        const epKey = endpointKey(url);
        const cooldownUntil = endpoint429Until.get(epKey);
        if (cooldownUntil != null && Date.now() < cooldownUntil) {
          mon.endpoint429Skips++;
          return null;
        }
      }
      const t0 = Date.now();
      if (attempt === 0) mon.waveTotal++;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body),
          signal: myAbortController.signal   // v2.32.0: cancellable on re-scan
        });
        if (r.status === 429 || r.status >= 500) throw new Error('retryable '+r.status);
        const ms = Date.now() - t0;
        mon.calls++; mon.totalMs += ms;
        // v2.6: expected-no-data statuses (400/403/404/422) silent; wrong body shape often returns 400.
        if (isExpectedNoData(r.status)) { mon.expectedNoData++; updateMon(); return null; }
        if (!r.ok) { bumpFail(url, r.status); return null; }
        recordSlowest(url, ms);  // v2.30.0
        updateMon();
        return await r.json();
      } catch (e) {
        // v2.32.0: AbortError on re-scan — bail clean (no fail counter, no 429 cooldown, no retry).
        if (e && e.name === 'AbortError') return null;
        mon.calls++; mon.totalMs += Date.now()-t0;
        if (attempt < 2) {
          const wait = Math.min(500 * Math.pow(2, attempt), 10000) * (0.5 + Math.random());
          await new Promise(r => setTimeout(r, wait));
          return safePost(url, body, attempt + 1);
        }
        // v2.30.0: 429-exhaustion cooldown (same as safeFetch).
        const msg = (e && e.message) || 'network';
        if (typeof msg === 'string' && msg.indexOf('retryable 429') === 0) {
          endpoint429Until.set(endpointKey(url), Date.now() + ENDPOINT_429_COOLDOWN_MS);
        }
        bumpFail(url, msg);
        return null;
      }
    }
    // v2.13: bounded scaling. v2.35.0 turbo: effective ceiling is TURBO_MAX_DYNAMIC_BATCH (48)
    // until the first fail429 of the scan; from then on it collapses to SAFE_MAX_DYNAMIC_BATCH
    // (32 — known-good v2.33.0 value) for the rest of the run. Floor stays HOLDER_FETCH_BATCH.
    function endWave(){
      // v2.35.0: one-shot fail429 auto-rollback. Runs unconditionally (not gated on waveTotal)
      // so the cap snaps on the very next wave-end after the first 429, not after we wait for
      // 5 more requests to accumulate. Per-endpoint 429 cooldown (v2.30.0) remains independent.
      if (TUNING.TURBO_FAIL429_ROLLBACK && mon.fail429 > 0 && !mon.turboRollbackTriggered) {
        mon.turboRollbackTriggered = true;
        mon.turboRollbackAtCall = mon.calls;
        const safeCap = TUNING.SAFE_MAX_DYNAMIC_BATCH || 32;
        console.log('[PM Sports] Turbo rollback: fail429 detected, capping batch to '+safeCap);
        if (currentBatch > safeCap) {
          currentBatch = safeCap;
          try { updateMon(); } catch(_){}
        }
      }
      if (mon.waveTotal >= 5) {
        const rate = mon.waveFails / mon.waveTotal;
        const floor = TUNING.HOLDER_FETCH_BATCH || 3;
        // v2.35.0: effective ceiling = SAFE after rollback fires; TURBO/MAX otherwise.
        const ceil = mon.turboRollbackTriggered
          ? (TUNING.SAFE_MAX_DYNAMIC_BATCH || 32)
          : (TUNING.MAX_DYNAMIC_BATCH || 6);
        if (rate > 0.20 && currentBatch > floor) {
          // v2.35.0: drop deepened -2 → -4 so we exit a spike faster.
          const next = Math.max(floor, currentBatch - 4);
          console.log('[PM Dashboard] Reducing concurrency '+currentBatch+'→'+next+' (failure rate '+(rate*100).toFixed(0)+'%)');
          currentBatch = next;
          updateMon();
        } else if (rate === 0 && mon.fail429 === 0 && currentBatch < ceil) {
          // v2.35.0: zero failures AND zero fail429 ever this scan → turbo ramp +6 (was +3).
          const next = Math.min(ceil, currentBatch + 6);
          console.log('[PM Dashboard] Turbo-ramping concurrency '+currentBatch+'→'+next+' (0% failure rate, 0 fail429)');
          currentBatch = next;
          updateMon();
        } else if (rate < 0.02 && currentBatch < ceil) {
          // v2.35.0: very low failures → +3 (was +2)
          const next = Math.min(ceil, currentBatch + 3);
          currentBatch = next;
          updateMon();
        } else if (rate < 0.05 && currentBatch < ceil) {
          const next = Math.min(ceil, currentBatch + 1);
          currentBatch = next;
          updateMon();
        }
      }
      // v2.35.0: high-water mark for end-of-run diagnostics.
      if (currentBatch > mon.maxBatchReached) mon.maxBatchReached = currentBatch;
      mon.waveTotal = 0; mon.waveFails = 0;
    }
    const withTimeout = (p, ms, label) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label+' timeout '+ms+'ms')), ms))
    ]);
    // v2.15: lightweight TTL'd JSON cache shared by event + holder caches. Each entry:
    //   { v:1, cachedAt:Date.now(), ttl:<ms>, data:<payload> }
    // Returns null on expiry, missing, or parse error. Same safeSet semantics — if the
    // localStorage write throws (quota), the existing evictOldest path is preserved.
    function ttlGet(key){
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const j = JSON.parse(raw);
        if (!j || j.v !== 1 || !j.cachedAt || !j.ttl) return null;
        if (Date.now() - j.cachedAt > j.ttl) return null;
        return j.data;
      } catch { return null; }
    }
    function ttlSet(key, data, ttl){
      try { localStorage.setItem(key, JSON.stringify({v:1, cachedAt: Date.now(), ttl, data})); }
      catch(e) {
        if (e && (e.name==='QuotaExceededError' || e.code===22)) {
          evictOldest(COLD_PREFIX, 0.25);
          try { localStorage.setItem(key, JSON.stringify({v:1, cachedAt: Date.now(), ttl, data})); } catch {}
        }
      }
    }
    // Event cache — keyed by slug. Cached only on success (a non-null event with markets).
    function cacheGetEvent(slug){ return ttlGet(EVENT_PREFIX + slug); }
    function cacheSetEvent(slug, ev){ if (ev && ev.markets && ev.markets.length) ttlSet(EVENT_PREFIX + slug, ev, EVENT_TTL); }
    // Holder cache — keyed by conditionId. Two TTLs based on result class. Retryable
    // failures (429 / 5xx / network) are never cached. Stored payload is the same shape
    // as fetchHolders' return: { holders: [...] | null, status: <number|string> }.
    function cacheGetHolder(cid){ return ttlGet(HOLDER_PREFIX + cid); }
    function cacheSetHolder(cid, res, ttl){ ttlSet(HOLDER_PREFIX + cid, res, ttl); }

    async function fetchEvent(slug){
      // v2.15: short-TTL cache so reloading the same event tab within 3 minutes skips
      // gamma's three slug fallback endpoints entirely.
      const cached = cacheGetEvent(slug);
      if (cached) { mon.eventCacheHits++; return cached; }
      let ev = null;
      try { const r = await fetch('https://gamma-api.polymarket.com/events/slug/'+slug); if (r.ok){ const j = await r.json(); if (j && j.markets && j.markets.length) ev = j; } } catch {}
      if (!ev) { try { const r = await fetch('https://gamma-api.polymarket.com/events?slug='+slug); if (r.ok){ const j = await r.json(); const e = Array.isArray(j) ? j[0] : j; if (e && e.markets && e.markets.length) ev = e; } } catch {} }
      if (!ev) { try { const r = await fetch('https://gamma-api.polymarket.com/markets?slug='+slug); if (r.ok){ const j = await r.json(); const m = Array.isArray(j) ? j[0] : j; if (m && m.conditionId) ev = { title: m.question || slug, markets: [m] }; } } catch {} }
      if (ev) cacheSetEvent(slug, ev);
      return ev;
    }
    const w = window.open('about:blank','_blank');
    if(!w){ alert('Popup blocked'); return; }
    const d = w.document;
    d.write(`<!doctype html><html><head><title>PM Dashboard · ${slug}</title><style>
*{box-sizing:border-box}body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0a0a0e;color:#e8e8ee;margin:0;padding:20px;min-width:1400px}
.hdr{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px;gap:20px;flex-wrap:wrap}
h1{margin:0;font-size:22px;font-weight:600}.sub{color:#7a7a85;font-size:12px;margin-top:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:20px}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.tabs{display:inline-flex;background:#15151e;border:1px solid #22222d;border-radius:8px;padding:3px;gap:2px}
.tab{background:transparent;color:#aaa;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.tab.active{background:linear-gradient(135deg,#2a7fff,#5fd17a);color:#fff}
.topn,.sidefilter{background:#15151e;color:#e8e8ee;border:1px solid #22222d;border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;cursor:pointer}
.badges{font-size:11px;font-weight:500;color:#aaa;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badges .ratio{color:#666}
.ptitle .right{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-weight:500;font-size:12px;color:#aaa}
.warn{color:#f5b942}
.star{cursor:pointer;color:#f5b942;user-select:none}
.starOff{opacity:0;cursor:pointer;color:#555;user-select:none}
tr:hover .starOff{opacity:1}
.streakPanel{background:linear-gradient(135deg,#16161d,#1a1a24);border:1px solid #26432c;border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:#cde7d1}
.streakPanel .pat{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.streakPanel .wl{font-weight:600;font-size:16px;margin-top:4px}
.exitsPanel{background:#12121a;border:1px solid #22222d;border-radius:10px;margin-bottom:16px;overflow:hidden}
.exitsPanel summary{padding:12px 16px;cursor:pointer;font-weight:600;font-size:14px;color:#f08a8a;list-style:none}
.exitsPanel summary::-webkit-details-marker{display:none}
.exitsPanel summary::before{content:"▸ ";font-size:12px;color:#888}
.exitsPanel[open] summary::before{content:"▾ "}
.exitsPanel .tblwrap{max-height:40vh;overflow:auto}
.mmIcon{color:#7ab8ff}
.arche{font-weight:600;font-size:11px;padding:2px 6px;border-radius:4px;display:inline-block;cursor:help}
.arche.sharp{background:#1a3a2a;color:#6fd890}
.arche.insiderlike{background:#3a1a3a;color:#e090e0}
.arche.lateedge{background:#2a3a1a;color:#9de690}
.arche.marketmaker,.arche.mm{background:#2a2a3a;color:#9dbaff}
.arche.bot{background:#3a2a2a;color:#ff9d9d}
.arche.publicchase,.arche.public{background:#3a2a1a;color:#e6c26a}
.arche.dash{color:#666;background:transparent;font-weight:400}
.predBox{display:inline-flex;flex-direction:column;align-items:flex-end;font-size:11px;font-weight:500;margin-left:8px;padding:2px 8px;background:#15151e;border:1px solid #22222d;border-radius:6px;line-height:1.2}
.predBox .big{font-size:14px;font-weight:700;color:#e8e8ee}
.predBox .conf{color:#888;font-size:10px}
.predDetails{background:#0d0d14;border:1px solid #22222d;border-radius:6px;margin-top:8px;padding:8px 12px;font-size:11px;color:#aaa;font-family:ui-monospace,monospace}
.predDetails summary{cursor:pointer;color:#888;font-weight:500}
.predDetails summary::-webkit-details-marker{display:none}
.predDetails .comp{display:flex;justify-content:space-between;padding:2px 0}
.predDetails .comp b{color:#ccc}
.warnBadge{background:#3a2a1a;color:#f5b942;padding:6px 12px;border-radius:6px;font-size:12px;margin-bottom:12px;display:inline-block}
.resolvedBanner{background:linear-gradient(135deg,#1a3a2a,#1a2a2a);border:1px solid #2a6a4a;border-radius:10px;padding:12px 16px;margin-bottom:16px;color:#9de6b0}
.resolvedBanner .title{font-weight:700;font-size:14px;color:#8be699}
.resolvedBanner .outcomes{font-size:12px;color:#b0d6b8;margin-top:4px}
.resolvedBanner .sub{font-size:11px;color:#7a9a85;margin-top:6px;font-style:italic}
.panelSubtitle{font-size:11px;color:#888;font-weight:400;margin-top:2px}
.settleNote{font-size:10px;color:#888;margin-left:6px;font-weight:400}
.clusterPanel{background:#101018;border:1px solid #2a2a3a;border-radius:10px;margin-bottom:16px;overflow:hidden;font-size:12px;color:#cdd5e0}
.clusterPanel summary{cursor:pointer;padding:12px 16px;font-weight:600;color:#d0a8ff;list-style:none}
.clusterPanel summary::-webkit-details-marker{display:none}
.clusterPanel summary::before{content:"▸ ";font-size:12px;color:#888}
.clusterPanel[open] summary::before{content:"▾ "}
.clusterPanel .body{padding:0 16px 14px}
.clusterPanel .group{margin-bottom:14px;padding:10px 12px;background:#15151e;border:1px solid #22222d;border-radius:8px}
.clusterPanel .group:last-child{margin-bottom:0}
.clusterPanel .ghdr{font-weight:600;color:#e8e8ee;margin-bottom:6px}
.clusterPanel .ghdr .badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:6px;text-transform:uppercase;letter-spacing:0.5px}
.clusterPanel .badge.strong{background:#1f3a26;color:#5fd17a}
.clusterPanel .badge.medium{background:#3a3320;color:#e6c26a}
.clusterPanel .badge.weak{background:#2a2a32;color:#888}
.clusterPanel .meta{display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:6px;color:#aaa;font-size:11px}
.clusterPanel .meta b{color:#e8e8ee;font-weight:500}
.clusterPanel .arch{color:#888;font-size:11px;margin-bottom:6px}
.clusterPanel .wallets{font-family:ui-monospace,monospace;font-size:10px;color:#888;line-height:1.6}
.clusterPanel .wallets a{color:#9dbaff;text-decoration:none}
.clusterPanel .wallets a:hover{text-decoration:underline}
.clusterPanel .empty{padding:12px 16px;color:#666;font-style:italic}
.clusterPanel .pos{color:#5fd17a}
.clusterPanel .neg{color:#ff7d7d}
.consistencyPanel{background:linear-gradient(135deg,#1a1a2a,#1a2420);border:1px solid #3a4a5a;border-radius:10px;margin-bottom:16px;overflow:hidden;font-size:13px;color:#cdd5e0}
.consistencyPanel summary{cursor:pointer;padding:12px 16px;font-weight:600;color:#a0c8ff;list-style:none}
.consistencyPanel summary::-webkit-details-marker{display:none}
.consistencyPanel summary::before{content:"▸ ";font-size:12px;color:#888}
.consistencyPanel[open] summary::before{content:"▾ "}
.consistencyPanel .findings{margin:0;padding:0 20px 12px 36px;list-style:disc}
.consistencyPanel .findings li{padding:3px 0;font-size:12px}
.consistencyPanel .findings li.err{color:#ff9d9d}
.consistencyPanel .findings li.info{color:#9dbaff}
.consistencyPanel .findings li.ok{color:#888}
.consistencyPanel .tblwrap{max-height:40vh;overflow:auto;padding:0 16px 12px}
.consistencyPanel table{font-size:11px}
.consistencyPanel table th{padding:4px 8px}
.consistencyPanel table td{padding:3px 8px}
.toolbarRight{display:flex;gap:10px;align-items:center}
.selfmon{font-size:11px;color:#888;font-family:ui-monospace,monospace;padding:4px 8px;background:#15151e;border:1px solid #22222d;border-radius:6px;white-space:nowrap}
.ioBtns{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
.ioBtn{background:#15151e;color:#e8e8ee;border:1px solid #22222d;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit}
.ioBtn:hover{border-color:#2a7fff}
.gradeBtn{float:right;background:#15151e;color:#e8e8ee;border:1px solid #22222d;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;margin-left:8px}
.gradeBtn:hover{border-color:#2a7fff}
.gradeBadge{display:inline-block;font-size:10px;font-weight:800;letter-spacing:0.4px;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle;cursor:help}
.gradeBadge.gradeAPlus{background:#3b1d12;color:#ff9a4d;border:1px solid #5a2c1a}
.gradeBadge.gradeA{background:#13321a;color:#67d287;border:1px solid #1f5430}
.gradeBadge.gradeB{background:#1a2538;color:#7ea7e0;border:1px solid #284065}
.gradeBadge.gradeC{background:#2a2618;color:#c9b06b;border:1px solid #4a4128}
.gradeBadge.gradePass{background:#2a1a1a;color:#a86a6a;border:1px solid #4a2a2a}
.decisionSummary.watch{background:linear-gradient(180deg,#161b24,#11151c);border:1px solid #2b3a55}
.decisionSummary.watch .heading{color:#7ea7e0}
.hcPicks{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.hcPick{font-size:12px;color:#d8d8e0;padding:4px 8px;background:rgba(0,0,0,0.18);border-radius:4px;border-left:3px solid #ff9a4d;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.hcPick .hcMkt{color:#888;font-size:11px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.gradeOverlay{position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:99999;display:flex;align-items:center;justify-content:center;padding:40px}
.gradeModal{background:#12121a;border:1px solid #22222d;border-radius:12px;max-width:720px;width:100%;max-height:90vh;overflow:auto;padding:24px 28px;color:#e8e8ee;font-family:inherit}
.gradeModal h2{margin:0 0 12px;font-size:18px}
.gradeModal .closeX{float:right;background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px;line-height:1}
.gradeModal .closeX:hover{color:#e8e8ee}
.gradeModal .verdict{background:#0d0d14;border:1px solid #22222d;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#ddd}
.gradeModal .statGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.gradeModal .statGrid .cell{background:#0d0d14;border:1px solid #22222d;border-radius:6px;padding:8px 12px}
.gradeModal .statGrid .cell span{display:block;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}
.gradeModal .statGrid .cell b{font-size:16px;color:#e8e8ee}
.gradeModal table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.gradeModal th,.gradeModal td{text-align:left;padding:4px 8px;border-bottom:1px solid #22222d}
.gradeModal th{color:#888;font-weight:500}
.gradeModal .empty{color:#888;text-align:center;padding:32px 16px}
.card{background:linear-gradient(135deg,#16161d,#1a1a24);border:1px solid #24242f;border-radius:10px;padding:14px}
.card .lbl{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px}.card .val{font-size:22px;font-weight:600;margin-top:4px}
.card.y{border-color:#26432c}.card.n{border-color:#4a2628}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:16px;margin-bottom:20px}
.panel{background:#12121a;border:1px solid #22222d;border-radius:10px;overflow:hidden}
.ptitle{padding:12px 16px;font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #22222d}
.ptitle.y{background:linear-gradient(90deg,#183722,#12121a);color:#8be699}
.ptitle.n{background:linear-gradient(90deg,#3a1a1d,#12121a);color:#f08a8a}
.tblwrap{max-height:75vh;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{padding:6px 8px;border-bottom:1px solid #1d1d26;text-align:right;white-space:nowrap}
th:nth-child(1),th:nth-child(2),td:nth-child(1),td:nth-child(2){text-align:left}
th{color:#888;font-weight:600;background:#15151e;position:sticky;top:0;z-index:1;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
tr:hover td{background:#16161f}a{color:#7ab8ff;text-decoration:none}a:hover{text-decoration:underline}
.pos{color:#5fd17a}.neg{color:#f07070}.mute{color:#666}.smart{color:#5fd17a;font-weight:600}.dumb{color:#f07070;font-weight:600}.meh{color:#888}
.rollup{background:#12121a;border:1px solid #22222d;border-radius:10px;padding:16px;margin-bottom:20px}
.rollup h2{margin:0 0 10px;font-size:14px;color:#aaa;font-weight:600}.rollup table{font-size:12px}.rollup th,.rollup td{padding:6px 14px}
/* v2.21: prediction-table sort toggle. Lives inside the rollup h2 next to the title. */
.rollup h2 .sortBtn{background:#1a1a24;color:#aaa;border:1px solid #2f2f3a;border-radius:4px;padding:3px 8px;font-size:10.5px;cursor:pointer;font-family:inherit;margin-left:8px;font-weight:500;vertical-align:middle}
.rollup h2 .sortBtn:hover{border-color:#2a7fff;color:#ddd}
.topPicks{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:20px}
/* v2.20: BET pick = ORANGE (action color, was green). Marginal pick = YELLOW (caution, was orange). */
.pickCard{background:#12121a;border:1px solid #22222d;border-left:3px solid #ff8c42;border-radius:10px;padding:14px 16px;font-size:13px}
.pickCard.marginal{border-left-color:#e6c26a}
.pickCard.empty{border-left-color:#444;color:#888;font-style:italic;text-align:center}
/* v2.20: pick headline ORANGE for BET-now picks; YELLOW for marginal/caution picks. */
.pickCard .pick{font-size:18px;font-weight:700;color:#ff8c42;margin-bottom:6px}
.pickCard.marginal .pick{color:#e6c26a}
.pickCard .mkt{color:#aaa;font-size:11px;margin-bottom:10px}
.pickCard .stats{display:flex;gap:14px;margin-bottom:8px}
.pickCard .stats b{color:#ddd;font-size:15px;font-weight:600;display:block}
.pickCard .stats span{color:#888;font-size:10px;text-transform:uppercase}
.pickCard .why{color:#777;font-size:11px;font-family:ui-monospace,monospace}
.pickCard .newsAlert{background:#2a1f10;border:1px solid #584020;border-radius:4px;padding:4px 8px;margin:6px 0;color:#d4a85f;font-size:11px}
.pickCard .tailBlock{background:#0d0d14;border:1px solid #2a2a3a;border-radius:6px;padding:6px 10px;margin:8px 0 6px;font-size:11px;color:#aaa}
.pickCard .tailBlock .tailHdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.pickCard .tailBlock .tailHdr b{color:#ddd;font-size:13px}
.pickCard .tailBlock .tailFlag{font-weight:700;font-size:10px;padding:2px 7px;border-radius:4px;letter-spacing:0.5px}
.pickCard .tailBlock .tailFlag.yes{background:#1f3a26;color:#5fd17a}
.pickCard .tailBlock .tailFlag.maybe{background:#3a3320;color:#e6c26a}
.pickCard .tailBlock .tailFlag.no{background:#3a2326;color:#f08a8a}
.pickCard .tailBlock .tailMeta{color:#888;font-size:10.5px;line-height:1.5}
.pickCard .tailBlock .tailMeta b{color:#cdd5e0;font-weight:500}
.pickCard .tailBlock .tailReason{color:#999;font-size:10.5px;margin-top:4px;font-style:italic}
.pickCard .tailNa{color:#666;font-size:10px;margin:6px 0;font-style:italic}
.zeroSignalCard{display:none}
.showZeroBtn{background:#15151e;color:#888;border:1px solid #22222d;border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer;font-family:inherit;margin-bottom:12px}
.showZeroBtn:hover{border-color:#2a7fff;color:#ccc}
body.showZero .zeroSignalCard{display:block}
.pushRow{opacity:.45}
.decisionSummary{background:#12121a;border:1px solid #22222d;border-left:6px solid #888;border-radius:10px;padding:18px 22px;margin-bottom:18px}
.decisionSummary.ok{border-left-color:#5fd17a}
.decisionSummary.pass{border-left-color:#888;background:#101015}
.decisionSummary .heading{font-size:18px;font-weight:600;color:#ddd;margin-bottom:6px}
.decisionSummary.ok .heading b{color:#5fd17a}
.decisionSummary.pass .heading b{color:#aaa}
.decisionSummary .subline{color:#888;font-size:12px;margin-bottom:8px}
.decisionSummary .nearMiss{color:#999;font-size:12px;padding-top:8px;border-top:1px dashed #22222d}
.researchMode{background:transparent;border-top:1px solid #22222d;margin-top:24px;padding-top:12px}
.researchMode > summary{color:#888;cursor:pointer;padding:10px 0;font-size:12px;list-style:none}
.researchMode > summary::-webkit-details-marker{display:none}
.researchMode > summary:hover{color:#ccc}
.researchMode[open] > summary{color:#aaa;margin-bottom:14px}
/* v2.20: prediction-table action row colors aligned to the 4-tier hierarchy.
   BET=orange (act now), LEAN=green (watch), PASS/FADE=red (skip). */
tr.rowBet{border-left:3px solid #ff8c42}
tr.rowLean{border-left:3px solid #5fd17a}
tr.rowPass{border-left:3px solid #f08a8a;opacity:.55}
tr.rowFade{border-left:3px solid #f08a8a;opacity:.45}
tr.rowSettled{border-left:3px solid #2a7fff}
tr.rowNoData{border-left:3px solid #333;opacity:.35}
tr.hiddenByDefault{display:none}
tr.rowToggle td{padding:10px 0}
tr.rowToggle button.showHidden{background:#1a1a24;border:1px solid #2f2f3a;color:#aaa;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:11px}
tr.rowToggle button.showHidden:hover{background:#22222d;color:#ddd}
.topPicksHdr{font-size:14px;color:#aaa;font-weight:600;margin:0 0 10px}
/* v2.28: bot export banner — shown at top of Research Mode. Indicates the structured export
   is ready on window.pmSportsBotExport, plus a Copy-JSON convenience button. */
.botExportBanner{background:#101018;border:1px solid #22222d;border-left:3px solid #9dbaff;border-radius:8px;padding:8px 14px;margin-bottom:12px;font-size:12px;color:#cdd5e0;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.botExportBanner code{background:#0a0a14;border:1px solid #22222d;border-radius:4px;padding:1px 6px;color:#9dbaff;font-family:ui-monospace,monospace;font-size:11px}
.botExportBanner .copyBotBtn{background:#1a1a24;color:#cdd5e0;border:1px solid #2f2f3a;border-radius:4px;padding:5px 12px;font-size:11px;cursor:pointer;font-family:inherit}
.botExportBanner .copyBotBtn:hover{border-color:#9dbaff;color:#fff}
.botExportBanner .copyBotBtn.copied{border-color:#5fd17a;color:#5fd17a}
#loading{position:fixed;inset:0;background:#0a0a0e;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:100}
#loading .b{width:360px;height:4px;background:#22222d;border-radius:2px;overflow:hidden;margin-top:16px}
#loading .b>div{height:100%;background:linear-gradient(90deg,#2a7fff,#5fd17a);width:5%;transition:width .3s}
</style></head><body>
<div id=loading><div style="font-size:15px;font-weight:500">Building dashboard… <span style="color:#888;font-weight:400;font-size:12px">v${SCRIPT_VERSION}</span></div><div class=sub id=stat>Fetching market</div><div class=b><div id=prog></div></div><div id=counts style="margin-top:14px;color:#888;font-size:11px;font-family:ui-monospace,monospace;line-height:1.6;text-align:left;max-width:520px"></div></div>
<div id=app style=display:none></div></body></html>`);
    d.close();
    const $s=d.getElementById('stat'),$p=d.getElementById('prog'),$counts=d.getElementById('counts');
    const setS=(t,p)=>{$s.textContent=t;if(p!=null)$p.style.width=p+'%'};
    // v2.17: step-prefixed loading message + live counts panel under the progress bar.
    // Steps: 1 Fetching event · 2 Loading markets · 3 Loading holders · 4 Loading wallets ·
    //        5 Building predictions · 6 Rendering dashboard
    function setStep(stepNum, label, pct){
      try { setS('[Step '+stepNum+'/6] '+label, pct); } catch(_){}
    }
    function updateCounts(){
      if (!$counts) return;
      const totalHolderRows = (typeof sides === 'object' && sides) ? Object.values(sides).reduce((s, sd) => s + (sd && sd.rows ? sd.rows.length : 0), 0) : null;
      const uniqueWallets = (typeof walletList === 'object' && walletList) ? walletList.length : null;
      const cacheHits = walletCacheHits || 0;
      const cacheMiss = uniqueWallets != null ? Math.max(0, uniqueWallets - cacheHits) : null;
      const realFails = mon.realFails || 0;
      const fail429   = mon.fail429   || 0;
      const expectedNoData = mon.expectedNoData || 0;
      const lines = [];
      if (totalHolderRows != null) lines.push('Total holder rows: ' + totalHolderRows);
      if (uniqueWallets   != null) lines.push('Unique wallets:    ' + uniqueWallets);
      lines.push('Wallet cache hits: ' + cacheHits + (cacheMiss != null ? ' · misses: ' + cacheMiss : ''));
      lines.push('Real fails:        ' + realFails + ' · 429: ' + fail429 + ' · expected no-data: ' + expectedNoData);
      $counts.textContent = lines.join('\n');
    }
    const fmt=n=>n==null||isNaN(n)?'-':(n>=0?'$':'-$')+Math.abs(Math.round(n)).toLocaleString();
    const fmtS=n=>{if(n==null||isNaN(n))return '-';const a=Math.abs(n),s=n<0?'-':'';if(a>=1e6)return s+'$'+(a/1e6).toFixed(2)+'M';if(a>=1e3)return s+'$'+(a/1e3).toFixed(1)+'K';return s+'$'+Math.round(a)};
    const pct=n=>n==null||isNaN(n)?'-':(n*100).toFixed(1)+'%';
    const dur=sec=>{if(!sec)return '-';if(sec<3600)return '<1h';const dd=Math.floor(sec/86400),h=Math.floor(sec%86400/3600);return dd>0?dd+'d '+h+'h':h+'h'};
    const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    // Phase timings: instrumentation to surface per-phase wall-clock. Logged once at end of render.
    const timings = {};
    const tStart = (typeof performance!=='undefined' && performance.now) ? performance.now() : Date.now();
    let tPhase = tStart;
    let walletCacheHits = 0;
    const markPhase = (name) => {
      const now = (typeof performance!=='undefined' && performance.now) ? performance.now() : Date.now();
      timings[name] = Math.round(now - tPhase);
      tPhase = now;
    };
    try{
      // v2.13: phase timing markers (in addition to existing markPhase) — gives the user
      // simple console.time output to scan for the slow phase. fetchEvent / fetchHolders /
      // loadWallets / renderUI bracket the four expensive sections.
      setStep(1, 'Fetching event…', 2);
      try { console.time('[PM Sports] fetchEvent'); } catch(_){}
      const ev=await fetchEvent(slug);
      try { console.timeEnd('[PM Sports] fetchEvent'); } catch(_){}
      if(!ev||!ev.markets||!ev.markets.length){d.body.innerHTML='<h1 style="color:#f88">Unsupported market type — please report this URL</h1><pre style="color:#f88">'+esc(location.href)+'</pre>';return;}
      setStep(2, 'Loading markets ('+ev.markets.length+')…', 5);
      // v2.3: event-volume quality gate. Thinly-traded events produce noise predictions because the
      // top-N holders barely have enough notional to differentiate the components. Skip early with a
      // clear message rather than waste cycles + give a false-confidence pick on illiquid junk.
      const eventVolume = ev.markets.reduce((s, m) => s + (Number(m.volume) || 0), 0);
      const anyResolvedAtGate = ev.markets.some(m => isResolved(m));
      if (!anyResolvedAtGate && eventVolume > 0 && eventVolume < TUNING.MIN_EVENT_VOLUME) {
        d.body.innerHTML = '<div style="max-width:560px;margin:60px auto;padding:24px;background:#12121a;border:1px solid #333;border-left:6px solid #f0a070;border-radius:10px;font-family:system-ui,sans-serif;color:#ddd">'
          +'<h2 style="margin:0 0 8px;color:#f0a070">⚠ Event too thinly traded</h2>'
          +'<div style="color:#aaa;font-size:13px;margin-bottom:6px">Total volume: <b style="color:#ddd">$'+Math.round(eventVolume).toLocaleString()+'</b> · gate: <b>$'+TUNING.MIN_EVENT_VOLUME.toLocaleString()+'</b></div>'
          +'<div style="color:#888;font-size:12px">Predictor signal is unreliable below this volume — top holders don\'t have enough notional to differentiate informed flow from noise. Skipping analysis to avoid false-confidence picks.</div>'
          +'<div style="color:#666;font-size:11px;margin-top:12px">Override: lower TUNING.MIN_EVENT_VOLUME if you want to force analysis on a thinner event.</div>'
          +'</div>';
        return;
      }
      markPhase('event');
      try { console.time('[PM Sports] fetchHolders'); } catch(_){}
      // v2.11: detect event league once. Used by eliteEdge niche multiplier — NBA-focused
      // wallets count more on NBA markets than generic profitable wallets do, etc.
      const eventLeague = (() => {
        const hay = ((slug||'') + ' ' + (ev && ev.title ? ev.title : '')).toLowerCase();
        const m = hay.match(LEAGUE_REGEX);
        return m ? m[1].toLowerCase() : null;
      })();
      function nicheMultiplier(walletLeagueFocus){
        const wl = walletLeagueFocus && walletLeagueFocus.league ? walletLeagueFocus.league.toLowerCase() : null;
        if (!eventLeague || !wl || wl === 'other') return 0.65;          // either side unknown
        return wl === eventLeague ? 1.0 : 0.35;                          // match or different
      }
      setStep(3, 'Loading holders for top '+topN+'…', 8);
      // Holder fetch with per-market status tracking. Returns {holders, status}.
      async function fetchHolders(conditionId, limit, attempt){
        attempt = attempt || 0;
        const t0 = Date.now();
        const url = 'https://data-api.polymarket.com/holders?market='+conditionId+'&limit='+limit;
        if (attempt === 0) mon.waveTotal++;
        try {
          const r = await fetch(url);
          mon.calls++; mon.totalMs += Date.now()-t0;
          // v2.7: 429 returns fast — outer retry loop at "Retrying N failed market(s) after 5s"
          // already owns rate-limit recovery. The old path did up to ~4s of inner backoff AND
          // the 5s outer wait = 9+s per rate-limited market. Inner retry kept for 5xx/network
          // where it belongs (transient server-side issues, not backpressure signals).
          if (r.status === 429) {
            bumpFail(url, r.status);
            return { holders:null, status:r.status };
          }
          if (r.status >= 500) {
            if (attempt < 3) {
              const wait = Math.min(500 * Math.pow(2, attempt), 10000) * (0.5 + Math.random());
              await new Promise(r => setTimeout(r, wait));
              return fetchHolders(conditionId, limit, attempt+1);
            }
            bumpFail(url, r.status);
            return { holders:null, status:r.status };
          }
          // v2.6: 404/400/403/422 silent — markets without holder data, empty markets, etc.
          if (isExpectedNoData(r.status)) { mon.expectedNoData++; updateMon(); return { holders:null, status:r.status }; }
          updateMon();
          if (!r.ok) {
            bumpFail(url, r.status);
            return { holders:null, status:r.status };
          }
          const j = await r.json();
          return { holders: Array.isArray(j) ? j : null, status: r.status };
        } catch (e) {
          mon.calls++; mon.totalMs += Date.now()-t0;
          if (attempt < 3) {
            const wait = Math.min(500 * Math.pow(2, attempt), 10000) * (0.5 + Math.random());
            await new Promise(r => setTimeout(r, wait));
            return fetchHolders(conditionId, limit, attempt+1);
          }
          bumpFail(url, (e && e.message) || 'network');
          return { holders:null, status:(e && e.message) || 'network' };
        }
      }
      const markets=[];
      const failedMarkets=[];   // v2.14: ONLY 429/5xx/network — retry-eligible. Drives the warn banner.
      const noDataMarkets=[];   // v2.14: silent 4xx (400/403/404/422) or empty holders array. Not retried.
      // v2.14: a result is retry-eligible only when the failure looks transient (rate-limit, server
      // error, network). Empty holder arrays and 4xx silent responses are "no data exists for this
      // market" — retrying them just burns 5+ seconds and produces nothing. status is a number for
      // HTTP responses or a string for thrown network/exception messages from fetchHolders' catch.
      function isHolderRetryable(res){
        const s = res && res.status;
        if (s === 429) return true;
        if (typeof s === 'number' && s >= 500) return true;
        if (typeof s === 'string' && s.length > 0) return true;
        return false;
      }
      // v2.15: cache-aware wrapper around fetchHolders. Internal retries inside fetchHolders
      // bypass this wrapper (they call themselves directly), so we don't double-count cache
      // hits or stale-cache mid-retry. Cache write is conditional on the result class:
      //   - non-empty success → 10min TTL
      //   - silent 4xx / empty array → 3min TTL
      //   - 429 / 5xx / network (retryable failure) → not cached
      // v2.22: in-flight Map closes the gap from the dedupe audit. Concurrent callers for
      // the same conditionId share a single network call instead of both hitting the API
      // (matches walletPromises / inflightFetches patterns). holderDedupeHits surfaces in
      // the end-of-run log so we can see whether the gap was actually being hit.
      const inflightHolders = new Map();
      async function fetchHoldersCached(cid, limit){
        const cached = cacheGetHolder(cid);
        if (cached && cached.holders !== undefined) {
          mon.holderCacheHits++;
          return { holders: cached.holders, status: cached.status };
        }
        if (inflightHolders.has(cid)) {
          mon.holderDedupeHits++;
          return inflightHolders.get(cid);
        }
        const p = (async () => {
          const res = await fetchHolders(cid, limit);
          if (res && res.holders && res.holders.length) {
            cacheSetHolder(cid, {holders: res.holders, status: res.status}, HOLDER_TTL_OK);
          } else if (res && !isHolderRetryable(res)) {
            cacheSetHolder(cid, {holders: res.holders, status: res.status}, HOLDER_TTL_NO_DATA);
          }
          return res;
        })().finally(() => { inflightHolders.delete(cid); });
        inflightHolders.set(cid, p);
        return p;
      }
      // v2.3: parse outcome/clob/price arrays once per market, then fetch holders in parallel batches.
      // v2.4: TUNING-backed batch size + spacing (original v2.3 `6 + 200ms` 429'd on 20+ market events).
      const parsedMarkets = ev.markets.map(m => ({
        m,
        outcomes: typeof m.outcomes==='string' ? JSON.parse(m.outcomes) : m.outcomes,
        clob:     typeof m.clobTokenIds==='string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds,
        prices:   parseOutcomePrices(m)
      }));
      for (let i = 0; i < parsedMarkets.length; i += TUNING.HOLDER_FETCH_BATCH) {
        const batch = parsedMarkets.slice(i, i + TUNING.HOLDER_FETCH_BATCH);
        const results = await Promise.all(batch.map(p => fetchHoldersCached(p.m.conditionId, topN)));
        results.forEach((res, k) => {
          const p = batch[k];
          if (res.holders && res.holders.length) {
            markets.push({m:p.m, outcomes:p.outcomes, clob:p.clob, prices:p.prices, hr:res.holders});
          } else if (isHolderRetryable(res)) {
            failedMarkets.push({conditionId:p.m.conditionId, question:p.m.question, status:res.status, outcomes:p.outcomes, clob:p.clob, prices:p.prices, m:p.m});
          } else {
            // v2.14: empty array or expected 4xx — count silently, do NOT retry.
            noDataMarkets.push({conditionId:p.m.conditionId, question:p.m.question, status:res.status});
          }
        });
        if (i + TUNING.HOLDER_FETCH_BATCH < parsedMarkets.length) await new Promise(r => setTimeout(r, TUNING.HOLDER_FETCH_SPACING_MS));
      }
      // v2.14: retry pass only runs when there are TRULY-retryable markets. Markets that returned
      // no data on first pass are already in noDataMarkets and will not waste a retry slot.
      if (failedMarkets.length) {
        setS('Retrying '+failedMarkets.length+' rate-limited/server-failed · '+noDataMarkets.length+' no-data · '+markets.length+' loaded after 5s…', 90);
        await new Promise(r => setTimeout(r, 5000));
        const stillFailed = [];
        for (const f of failedMarkets) {
          const res = await fetchHoldersCached(f.conditionId, topN);
          if (res.holders && res.holders.length) {
            markets.push({m:f.m, outcomes:f.outcomes, clob:f.clob, prices:f.prices, hr:res.holders});
          } else if (isHolderRetryable(res)) {
            stillFailed.push({conditionId:f.conditionId, question:f.question, status:res.status});
          } else {
            // v2.14: retry returned non-retryable (e.g. 404 or empty) — not a real failure, just no data.
            noDataMarkets.push({conditionId:f.conditionId, question:f.question, status:res.status});
          }
          await new Promise(r => setTimeout(r, 600));  // pace the retry to avoid re-triggering rate limits
        }
        failedMarkets.length = 0;
        stillFailed.forEach(f => failedMarkets.push(f));
      }
      // v2.14: surface no-data markets in console for debugging (don't render a UI banner — they're expected).
      if (noDataMarkets.length) {
        console.log('[PM Sports] '+noDataMarkets.length+' market(s) had no holder data (silent 4xx / empty array — not retried):',
          noDataMarkets.map(m => (m.question || m.conditionId.slice(0,10)) + ' ['+m.status+']').slice(0, 20).join(' · '));
      }
      markPhase('holders');
      try { console.timeEnd('[PM Sports] fetchHolders'); console.time('[PM Sports] loadWallets'); } catch(_){}
      if(!markets.length){
        const failParts = [];
        if (failedMarkets.length) failParts.push(failedMarkets.length+' rate-limited/server-failed after retry');
        if (noDataMarkets.length) failParts.push(noDataMarkets.length+' had no holder data');
        d.body.innerHTML='<h1 style="color:#f88">No markets loaded</h1><pre style="color:#f88">'+esc(failParts.join(' · ') || 'unknown')+'</pre>';
        return;
      }
      const walletSet=new Set();
      markets.forEach(r=>r.hr.forEach(tok=>tok.holders.forEach(h=>walletSet.add(h.proxyWallet))));
      const walletList=[...walletSet];
      const userStats={},positionsByWallet={},activityByWallet={};
      const total=walletList.length;
      let done=0;
      // v2.30.1: /closed-positions per-wallet call is ONLY consumed at the "closedArr.length > 0
      // → winRate override" branch below (around line ~4060). When NO market in the event is
      // yet resolved the response is guaranteed-empty and the call is wasted. Compute the gate
      // once here so _loadWalletRaw's parallel Promise.all can short-circuit it without
      // re-deriving the flag per wallet. Counted in mon.closedPositionsSkips.
      const eventHasResolved = markets.some(r => isResolved(r.m));
      function deriveFromActivity(activity){
        const actArr = Array.isArray(activity) ? activity : [];
        let wins=0, losses=0;
        actArr.forEach(a=>{const rp=Number(a&&a.realizedPnl)||0; if(rp>100)wins++; else if(rp<-100)losses++;});
        const winRate = (wins+losses) ? wins/(wins+losses) : 0;
        let earliest = null;
        actArr.forEach(a=>{const t=Number(a&&a.timestamp); if(t && (earliest==null || t<earliest)) earliest=t;});
        // Bot detection: stdev of inter-trade intervals (seconds)
        const trades = actArr.filter(a=>a && a.type==='TRADE' && Number(a.timestamp)).map(a=>Number(a.timestamp)).sort((x,y)=>x-y);
        let tradeIntervalStdDev = null;
        if (trades.length >= 11) {
          const deltas = [];
          for (let i=1;i<trades.length;i++) deltas.push(trades[i]-trades[i-1]);
          const mean = deltas.reduce((s,v)=>s+v,0)/deltas.length;
          const variance = deltas.reduce((s,v)=>s+(v-mean)*(v-mean),0)/deltas.length;
          tradeIntervalStdDev = Math.sqrt(variance);
        }
        const tradeCount = trades.length;
        return {winRate, earliestActivity: earliest, winRateSampled: actArr.length === 500, tradeIntervalStdDev, tradeCount};
      }
      function deriveFromPositions(positions){
        const posArr = Array.isArray(positions) ? positions : [];
        // entryQuality: capital-weighted avg of (cashPnl + realizedPnl) / capital
        let num=0, den=0;
        posArr.forEach(p=>{
          const size=Number(p.size)||0, avg=Number(p.avgPrice)||0;
          const capital = Math.max(size*avg, 1);
          if (capital<=1) return;
          const pnl = (Number(p.cashPnl)||0) + (Number(p.realizedPnl)||0);
          num += pnl;
          den += capital;
        });
        const entryQuality = den>0 ? num/den : 0;
        // leagueFocus: group by league prefix in eventSlug/title
        const leagueUSD = {};
        posArr.forEach(p=>{
          const s = ((p.eventSlug||p.slug||p.title||'')+'').toLowerCase();
          const m = s.match(LEAGUE_REGEX);
          const league = m ? m[1].toLowerCase() : 'other';
          const usd = (Number(p.size)||0) * (Number(p.avgPrice)||0);
          leagueUSD[league] = (leagueUSD[league]||0) + usd;
        });
        const totalUSD = Object.values(leagueUSD).reduce((a,b)=>a+b,0);
        let leagueFocus = null;
        if (totalUSD > 0) {
          let topLeague = 'other', topUSD = 0;
          Object.entries(leagueUSD).forEach(([lg,usd])=>{if(usd>topUSD){topUSD=usd;topLeague=lg;}});
          leagueFocus = { league: topLeague, pct: topUSD/totalUSD };
        }
        return {entryQuality, leagueFocus};
      }
      // v2.13: address-level dedupe. The walletList is already Set-deduped, but if two
      // sites end up calling loadWallet concurrently for the same address (e.g. retry path
      // or future code that triggers per-side wallet loads), the second now joins the
      // in-flight promise instead of duplicating the 8-call Promise.all. Lower-cased key
      // catches mixed-case duplicates if they slip in.
      const walletPromises = new Map();
      async function loadWallet(ww){
        const key = (ww || '').toLowerCase();
        if (walletPromises.has(key)) {
          mon.walletDedupeHits++;
          return walletPromises.get(key);
        }
        const p = _loadWalletRaw(ww).finally(() => walletPromises.delete(key));
        walletPromises.set(key, p);
        return p;
      }
      async function _loadWalletRaw(ww){
        const cached = cacheGet(ww);
        if (cached) {
          walletCacheHits++;
          userStats[ww] = {value:cached.value, pnlAll:cached.pnlAll, pnl30d:cached.pnl30d, pnl7d:cached.pnl7d, volume:cached.volume, winRate:cached.winRate||0, earliestActivity:cached.earliestActivity, winRateSampled:!!cached.winRateSampled, positionsSampled:!!cached.positionsSampled, tradeIntervalStdDev:cached.tradeIntervalStdDev!=null?cached.tradeIntervalStdDev:null, tradeCount:cached.tradeCount||0, entryQuality:cached.entryQuality||0, leagueFocus:cached.leagueFocus||null};
          positionsByWallet[ww] = cached.positions || [];
          activityByWallet[ww] = cached.activity || [];
          done++; setStep(4, 'Loading wallets '+done+'/'+total+' · market data fetching in parallel', 8+Math.round(done/total*84)); updateCounts();
          return;
        }
        // v2.30.0: per-wallet fail cooldown. If the wallet's 8 calls all returned null on a
        // recent run (within WALLET_FAIL_TTL=15min), skip the entire 8-call Promise.all and
        // populate the empty-state payload directly. Net effect for the prediction layer is
        // identical to a successful all-null fetch (same zeros, same empty arrays); we just
        // avoid burning the 8 calls again. Counted in mon.walletFailSkips.
        if (walletFailCooldownActive(ww)) {
          mon.walletFailSkips++;
          userStats[ww] = {value:0, pnlAll:0, pnl30d:0, pnl7d:0, volume:0, winRate:0, earliestActivity:null, winRateSampled:false, positionsSampled:false, tradeIntervalStdDev:null, tradeCount:0, entryQuality:0, leagueFocus:null};
          positionsByWallet[ww] = [];
          activityByWallet[ww] = [];
          done++; setStep(4, 'Loading wallets '+done+'/'+total+' · market data fetching in parallel', 8+Math.round(done/total*84)); updateCounts();
          return;
        }
        // v2.7: derive 30d/7d PnL from activity.realizedPnl + timestamp instead of hitting
        // /profit?window=30d + /profit?window=7d. Saves 2 calls per wallet (8 → 6 parallel).
        // pAll (window=all) stays as ground-truth lifetime PnL. Gated by TUNING.DERIVE_WINDOW_PNL.
        const deriveWin = !!TUNING.DERIVE_WINDOW_PNL;
        const [valueR, pAll, p30, p7, volR, positions, activity, closedPositions] = await Promise.all([
          safeFetch('https://data-api.polymarket.com/value?user='+ww),
          safeFetch('https://lb-api.polymarket.com/profit?window=all&limit=1&address='+ww),
          deriveWin ? Promise.resolve(null) : safeFetch('https://lb-api.polymarket.com/profit?window=30d&limit=1&address='+ww),
          deriveWin ? Promise.resolve(null) : safeFetch('https://lb-api.polymarket.com/profit?window=7d&limit=1&address='+ww),
          safeFetch('https://lb-api.polymarket.com/volume?window=all&limit=1&address='+ww),
          safeFetch('https://data-api.polymarket.com/positions?user='+ww+'&limit=500'),
          safeFetch('https://data-api.polymarket.com/activity?user='+ww+'&limit=500'),
          // v2.30.1: skip when no market is resolved — closedArr would be empty anyway and
          // the only downstream consumer (the closedArr.length>0 winRate override below) is a
          // no-op on an empty array. mon.closedPositionsSkips bumped once per skip below.
          eventHasResolved
            ? safeFetch('https://data-api.polymarket.com/closed-positions?user='+ww+'&limit=500')  // v2.0: unbiased settlement history
            : Promise.resolve(null)
        ]);
        if (!eventHasResolved) mon.closedPositionsSkips++;
        const actArr = Array.isArray(activity) ? activity : [];
        const posArr = Array.isArray(positions) ? positions : [];
        const closedArr = Array.isArray(closedPositions) ? closedPositions : [];
        let {winRate, earliestActivity, winRateSampled, tradeIntervalStdDev, tradeCount} = deriveFromActivity(actArr);
        // v2.0: if closed-positions endpoint returns data, derive winRate from it instead
        // (activity-based winRate is capped at 500 rows; closed-positions gives full settlement history).
        if (closedArr.length) {
          let w=0, l=0;
          closedArr.forEach(p => {
            const pnl = Number(p && (p.realizedPnl != null ? p.realizedPnl : p.pnl)) || 0;
            if (pnl > 100) w++; else if (pnl < -100) l++;
          });
          if (w + l > 0) { winRate = w / (w + l); winRateSampled = closedArr.length === 500; }
        }
        const {entryQuality, leagueFocus} = deriveFromPositions(posArr);
        // v2.7.1: window PnL — three arms.
        //   A) deriveWin && actArr capped at 500: activity is truncated, derivation would
        //      undercount. Fall back to lb-api /profit?window=30d|7d for THIS wallet only.
        //      Pays back ~10-15% of v2.7's saved API calls but restores correctness on the
        //      heavy-trader wallets where it matters most (Elite badge, window-PnL tabs).
        //   B) deriveWin && not capped: sum activity.realizedPnl by timestamp window. v2.7 path.
        //   C) flag off: use the lb-api responses fired in the main Promise.all (legacy v2.6).
        let pnl30dDerived, pnl7dDerived;
        if (deriveWin && actArr.length === 500) {
          const [p30Fb, p7Fb] = await Promise.all([
            safeFetch('https://lb-api.polymarket.com/profit?window=30d&limit=1&address='+ww),
            safeFetch('https://lb-api.polymarket.com/profit?window=7d&limit=1&address='+ww)
          ]);
          pnl30dDerived = p30Fb && p30Fb[0] ? (Number(p30Fb[0].amount)||0) : 0;
          pnl7dDerived  = p7Fb  && p7Fb[0]  ? (Number(p7Fb[0].amount) ||0) : 0;
        } else if (deriveWin) {
          const nowSec = Math.floor(Date.now()/1000);
          const cutoff30 = nowSec - 30*86400;
          const cutoff7  = nowSec -  7*86400;
          let s30 = 0, s7 = 0;
          actArr.forEach(a => {
            const ts = Number(a && a.timestamp) || 0;
            const rp = Number(a && a.realizedPnl) || 0;
            if (!ts || !rp) return;
            if (ts >= cutoff30) s30 += rp;
            if (ts >= cutoff7)  s7  += rp;
          });
          pnl30dDerived = s30;
          pnl7dDerived  = s7;
        } else {
          pnl30dDerived = p30 && p30[0] ? (Number(p30[0].amount)||0) : 0;
          pnl7dDerived  = p7  && p7[0]  ? (Number(p7[0].amount) ||0) : 0;
        }
        const derived = {
          value: valueR && valueR[0] ? (Number(valueR[0].value)||0) : 0,
          pnlAll: pAll && pAll[0] ? (Number(pAll[0].amount)||0) : 0,
          pnl30d: pnl30dDerived,
          pnl7d: pnl7dDerived,
          volume: volR && volR[0] ? (Number(volR[0].amount)||0) : 0,
          winRate,
          earliestActivity,
          winRateSampled,
          positionsSampled: posArr.length === 500,
          tradeIntervalStdDev,
          tradeCount,
          entryQuality,
          leagueFocus
        };
        if (actArr.length === 500) {
          const firstAct = await safeFetch('https://data-api.polymarket.com/activity?user='+ww+'&limit=1&sortDirection=ASC');
          if (firstAct && firstAct[0] && firstAct[0].timestamp) derived.earliestActivity = firstAct[0].timestamp;
        }
        userStats[ww] = derived;
        positionsByWallet[ww] = posArr;
        activityByWallet[ww] = actArr;
        // v2.30.0: detect "all 8 calls failed" — every parallel response was null. Mark the
        // wallet in fail-cooldown (15min) and SKIP cacheSet so the next scan hits the
        // fail-cooldown gate above instead of an empty HOT cache entry. Partial successes
        // still cacheSet normally so a single bad endpoint doesn't poison the wallet.
        const allFailed = valueR == null && pAll == null && volR == null && positions == null && activity == null && closedPositions == null;
        if (allFailed) {
          markWalletFailed(ww);
        } else {
          cacheSet(ww, derived, posArr, actArr);
        }
        done++; setStep(4, 'Loading wallets '+done+'/'+total+' · market data fetching in parallel', 8+Math.round(done/total*84)); updateCounts();
      }
      // v2.22: kick off the five market-only sub-fetches (trade tapes / OI / order books /
      // price history / comments) in PARALLEL with the wallet phase. All five outputs are
      // write-once closure variables that downstream code only reads after the prediction
      // build starts (audit confirmed no mid-loop mutations), so overlapping the network
      // with loadWallets shaves the entire renderUI network tail off the critical path.
      // Per-block try/catch preserves the original silent-failure behavior — a sub-fetch
      // failure won't abort the run. setStep messaging during this phase comes from the
      // wallet-progress callback ("Loading wallets X/Y · market data fetching in parallel").
      const tradesByToken = {};         // tokenId → [{side,size,price,timestamp,wallet}]
      const tradeCountByMarket = {};    // conditionId → trade count fetched
      const oiByCid = {};               // conditionId → open interest scalar
      const bookByToken = {};           // tokenId → {tilt, bidVol, askVol, depthMid, bestBid, bestAsk}
      const refPriceByToken = {};       // tokenId → reference price (scalar) for true CLV
      const latestPriceByToken = {};    // tokenId → most recent point in prices-history (closing-line proxy)
      const alertsByCid = {};           // conditionId → news-leakage hits
      const uniqueTokens = new Set();
      markets.forEach(r => r.hr.forEach(tok => { if (tok.token) uniqueTokens.add(tok.token); }));
      const tokenList = [...uniqueTokens];
      // v2.31.0: parallel market-activity fetch closure variable. Populated by the new
      // subfetchPromises[] IIFE below; consumed by the post-wallet exit-detection loop.
      // Stays null until the IIFE assigns; guard handles a thrown-or-never-run case.
      let allMarketActResults = null;
      // v2.32.0: comments deferred — fire-and-forget assignment lives just after the
      // subfetchPromises[] array close. alertsByCid is display-only; no prediction component reads it.
      let commentsBackgroundPromise = Promise.resolve();
      const subfetchPromises = [
        // ── Trade tapes ──
        // Per-market /trades?market=<cid>&limit=500 captures every trade regardless of current
        // holder status. Lets Flow24h see activity from wallets outside top-N holders that the
        // per-wallet n24 reconstruction systematically misses.
        (async () => {
          try {
            const tradesResults = await Promise.all(markets.map(async r => {
              // v2.30.0: 60s cache. Re-scans within the window reuse the snapshot — Flow24h
              // sums a 24h trade window so 60s of drift is negligible to modelProb. Only
              // cache on a successful (non-null) fetch.
              const cached = cacheGetShort(TRADES_PREFIX, r.m.conditionId, TRADES_TTL);
              if (cached) { mon.tradesCacheHits++; return { conditionId: r.m.conditionId, trades: cached }; }
              const raw = await safeFetch('https://data-api.polymarket.com/trades?market='+r.m.conditionId+'&limit=500');
              const trades = Array.isArray(raw) ? raw : [];
              if (raw != null) cacheSetShort(TRADES_PREFIX, r.m.conditionId, trades);
              return { conditionId: r.m.conditionId, trades };
            }));
            tradesResults.forEach(({conditionId, trades}) => {
              tradeCountByMarket[conditionId] = trades.length;
              trades.forEach(t => {
                if (!t || !t.asset) return;
                const side = (t.side||'').toUpperCase();
                const size = Number(t.size)||0;
                const price = Number(t.price)||0;
                const ts = Number(t.timestamp)||0;
                if (!ts || !size) return;
                (tradesByToken[t.asset] = tradesByToken[t.asset] || []).push({ side, size, price, timestamp: ts, wallet: t.proxyWallet || t.maker || t.taker || null });
              });
            });
            markPhase('trades');
          } catch(e) { /* trades optional — preserve original silent-failure behavior */ }
        })(),
        // ── Open Interest ──
        // /oi snapshot — aggregate notional held across ALL wallets per market (not just
        // top-N holders). Used for display and heldRatio filtering.
        (async () => {
          try {
            // v2.30.0: 30s cache on the /oi snapshot. /oi returns ALL markets in one call so
            // we cache the raw response keyed by sportKey (each scan's union-keyed parse below
            // is the same shape). oiFactor formula unchanged.
            let oiResp = cacheGetShort(OI_PREFIX, sportKey, OI_TTL);
            if (oiResp) { mon.oiCacheHits++; }
            else {
              oiResp = await safeFetch('https://data-api.polymarket.com/oi');
              if (oiResp != null) cacheSetShort(OI_PREFIX, sportKey, oiResp);
            }
            const arr = Array.isArray(oiResp) ? oiResp : (oiResp && Array.isArray(oiResp.data) ? oiResp.data : []);
            arr.forEach(row => {
              const cid = row && (row.conditionId || row.condition_id || row.market);
              const oi = row && Number(row.oi != null ? row.oi : (row.openInterest != null ? row.openInterest : 0));
              if (cid && !isNaN(oi)) oiByCid[cid] = oi;
            });
          } catch(e) { /* OI optional */ }
        })(),
        // ── Order books ──
        // POST /books batch first (1 roundtrip for all tokens), graceful fallback to per-token
        // GETs. Top-5-level tilt = (bidVol$ − askVol$) / (bidVol$ + askVol$) ∈ [−1, +1].
        // Consumed as the bookTilt component (weight 0.08); null on empty book (settled markets).
        (async () => {
          // v2.30.0: per-token 30s cache on the PARSED bookByToken record (not the raw book).
          // Storing the small parsed shape keeps the cache tight; we only need to re-derive
          // for tokens that miss the cache. bookTilt formula below is byte-identical.
          const missingTokens = [];
          tokenList.forEach(t => {
            const c = cacheGetShort(BOOKS_PREFIX, t, BOOKS_TTL);
            if (c) { mon.booksCacheHits++; bookByToken[t] = c; }
            else { missingTokens.push(t); }
          });
          if (missingTokens.length === 0) { markPhase('books'); return; }
          let bookResults = null;
          try {
            const batchBody = { params: missingTokens.map(t => ({token_id: t})) };
            const batchResp = await safePost('https://clob.polymarket.com/books', batchBody);
            if (Array.isArray(batchResp) && batchResp.length === missingTokens.length) {
              bookResults = missingTokens.map((tokenId, i) => ({tokenId, book: batchResp[i]}));
            }
          } catch(e) { /* fall through to per-token */ }
          if (!bookResults) {
            bookResults = await Promise.all(missingTokens.map(async tokenId => {
              const book = await safeFetch('https://clob.polymarket.com/book?token_id='+tokenId);
              return { tokenId, book };
            }));
          }
          bookResults.forEach(({tokenId, book}) => {
            if (!book) { bookByToken[tokenId] = {tilt:null, bidVol:0, askVol:0, depthMid:null, bestBid:null, bestAsk:null}; return; }
            const bids = (book.bids||[]).map(l=>({price:Number(l.price), size:Number(l.size)})).filter(l=>l.size>0).sort((a,b)=>b.price-a.price).slice(0,5);
            const asks = (book.asks||[]).map(l=>({price:Number(l.price), size:Number(l.size)})).filter(l=>l.size>0).sort((a,b)=>a.price-b.price).slice(0,5);
            const bidVol = bids.reduce((s,l)=>s+l.size*l.price, 0);
            const askVol = asks.reduce((s,l)=>s+l.size*l.price, 0);
            const totalVol = bidVol+askVol;
            const tilt = totalVol>0 ? (bidVol-askVol)/totalVol : null;
            const totalSize = bids.reduce((s,l)=>s+l.size,0) + asks.reduce((s,l)=>s+l.size,0);
            const depthMid = totalSize>0 ? totalVol/totalSize : null;
            const bestBid = bids.length ? bids[0].price : null;
            const bestAsk = asks.length ? asks[0].price : null;
            bookByToken[tokenId] = {tilt, bidVol, askVol, depthMid, bestBid, bestAsk};
            // v2.30.0: only cache when we actually got a book (not the empty fallback).
            cacheSetShort(BOOKS_PREFIX, tokenId, bookByToken[tokenId]);
          });
          markPhase('books');
        })(),
        // ── Price history ──
        // Per-token prices-history → reference price for TRUE CLV. Ref = price N hours before
        // game start (if startDate known), else 24h ago. Used for closing-line proxy too.
        (async () => {
          const startByCid = {};
          markets.forEach(r => {
            const sd = r.m.startDate ? Math.floor(Date.parse(r.m.startDate)/1000) : null;
            if (sd != null && !isNaN(sd)) startByCid[r.m.conditionId] = sd;
          });
          const cidByToken = {};
          markets.forEach(r => r.hr.forEach(tok => { if (tok.token) cidByToken[tok.token] = r.m.conditionId; }));
          // v2.30.0: per-token 60s cache on the parsed {refPrice, latestPrice} pair (much
          // smaller than the raw series). CLV / closing-line proxy formulas unchanged.
          const phResults = await Promise.all(tokenList.map(async tokenId => {
            const cached = cacheGetShort(PRICES_PREFIX, tokenId, PRICES_TTL);
            if (cached) {
              mon.pricesCacheHits++;
              return { tokenId, cachedDerived: cached };
            }
            const cid = cidByToken[tokenId];
            const startSec = cid && startByCid[cid] != null ? startByCid[cid] : null;
            const hist = await safeFetch('https://clob.polymarket.com/prices-history?market='+tokenId+'&interval=1h&fidelity=60');
            return {tokenId, startSec, hist};
          }));
          const nowSec = Math.floor(Date.now()/1000);
          phResults.forEach(({tokenId, startSec, hist, cachedDerived}) => {
            if (cachedDerived) {
              refPriceByToken[tokenId]    = cachedDerived.refPrice != null ? cachedDerived.refPrice : null;
              latestPriceByToken[tokenId] = cachedDerived.latestPrice != null ? cachedDerived.latestPrice : null;
              return;
            }
            const series = Array.isArray(hist) ? hist : (hist && Array.isArray(hist.history) ? hist.history : []);
            if (!series.length) { refPriceByToken[tokenId] = null; latestPriceByToken[tokenId] = null; return; }
            const pts = series.map(pt => ({
              t: Number(pt.t || pt.timestamp || pt.time) || 0,
              p: Number(pt.p || pt.price || pt.value) || 0
            })).filter(pt => pt.t > 0 && pt.p > 0).sort((a,b)=>a.t-b.t);
            if (!pts.length) { refPriceByToken[tokenId] = null; latestPriceByToken[tokenId] = null; return; }
            latestPriceByToken[tokenId] = pts[pts.length - 1].p;
            const refTime = startSec != null
              ? startSec - TUNING.CLV_REF_HOURS_BEFORE_START * 3600
              : nowSec - 24 * 3600;
            let best = pts[0], bestDelta = Math.abs(pts[0].t - refTime);
            for (let i = 1; i < pts.length; i++) {
              const d = Math.abs(pts[i].t - refTime);
              if (d < bestDelta) { best = pts[i]; bestDelta = d; }
            }
            refPriceByToken[tokenId] = best.p;
            // v2.30.0: only cache when we got a usable series.
            cacheSetShort(PRICES_PREFIX, tokenId, {
              refPrice:    refPriceByToken[tokenId],
              latestPrice: latestPriceByToken[tokenId]
            });
          });
          markPhase('prices-history');
        })(),
        // ── Market activity (v2.31.0) ──
        // /activity?market=<cid>&limit=500 per market, run in parallel here so it overlaps
        // with the wallet phase instead of executing serially after wallets finish (where
        // it used to live as a for…of loop). Only the FETCH stage moves; the
        // exit-detection processing remains post-wallet because it reads userStats[w]
        // populated by loadWallet.
        (async () => {
          try {
            allMarketActResults = await Promise.all(markets.map(async r => {
              const cached = cacheGetShort(MARKET_ACTIVITY_PREFIX, r.m.conditionId, MARKET_ACTIVITY_TTL);
              if (cached) { mon.marketActivityCacheHits++; return { r, acts: cached }; }
              const raw = await safeFetch('https://data-api.polymarket.com/activity?market='+r.m.conditionId+'&limit=500');
              const acts = Array.isArray(raw) ? raw : [];
              if (raw != null) cacheSetShort(MARKET_ACTIVITY_PREFIX, r.m.conditionId, acts);
              return { r, acts };
            }));
          } catch(e) { /* market-activity optional — post-wallet loop guards against null */ }
        })()
      ];
      // v2.32.0: comments DEFERRED — populates display-only alertsByCid in the background.
      // Removed from subfetchPromises[] so the prediction build does NOT block on a slow
      // comments fetch. On scans where comments lag, badges miss this scan but reappear
      // next scan (L1 + localStorage cache hit). No prediction component reads alertsByCid;
      // consumed only at render line ~6307 for the news-mentions display badge.
      commentsBackgroundPromise = (async () => {
        try {
          const ALERT_KEYWORDS = ['injur','ruled out','questionable','doubtful','starting','lineup','weather','rain','confirmed','scratched','gtd','out for','active','inactive'];
          const commentsResults = await Promise.all(markets.map(async r => {
            const cached = cacheGetShort(COMMENTS_PREFIX, r.m.conditionId, COMMENTS_TTL);
            if (cached) { mon.commentsCacheHits++; return { cid: r.m.conditionId, comments: cached }; }
            const comments = await safeFetch('https://gamma-api.polymarket.com/comments?market='+r.m.conditionId+'&limit=100');
            if (comments != null) cacheSetShort(COMMENTS_PREFIX, r.m.conditionId, comments);
            return {cid: r.m.conditionId, comments};
          }));
          commentsResults.forEach(({cid, comments}) => {
            const arr = Array.isArray(comments) ? comments : (comments && Array.isArray(comments.data) ? comments.data : []);
            if (!arr.length) return;
            const hits = {};
            arr.forEach(c => {
              const body = ((c && (c.body || c.text || c.content || c.comment)) || '').toString().toLowerCase();
              if (!body) return;
              ALERT_KEYWORDS.forEach(kw => { if (body.includes(kw)) hits[kw] = (hits[kw]||0) + 1; });
            });
            const total = Object.values(hits).reduce((a,b)=>a+b, 0);
            if (total > 0) alertsByCid[cid] = {total, hits, sampleCount: arr.length};
          });
          markPhase('comments');
        } catch(e) { /* comments optional */ }
      })();
      // Wallet phase — ramps currentBatch in [HOLDER_FETCH_BATCH=6, MAX_DYNAMIC_BATCH=32].
      for(let i=0;i<walletList.length;i+=currentBatch){
        await Promise.all(walletList.slice(i,i+currentBatch).map(loadWallet));
        endWave();
        await new Promise(r=>setTimeout(r,0));   // v2.33.0: 50→0 (event-loop yield only; endpoint 429 cooldown absorbs spikes)
      }
      markPhase('wallets');
      try { console.timeEnd('[PM Sports] loadWallets'); console.time('[PM Sports] subfetchAwait'); } catch(_){}
      // v2.22: most or all sub-fetches will already be settled by the time wallets finish;
      // this await collapses to near-zero on a typical fresh load.
      setStep(5, 'Awaiting market data (books · trades · prices · OI · comments)…', 92);
      await Promise.allSettled(subfetchPromises);
      try { console.timeEnd('[PM Sports] subfetchAwait'); console.time('[PM Sports] renderUI'); } catch(_){}
      setStep(5, 'Building predictions · exits…', 95);
      const now=Math.floor(Date.now()/1000);
      // Pre-render exit collection, so per-side profitable-exit counts are available to the predictor.
      // For each market: fetch recent activity, bucket per token (side), find wallets whose latest action
      // on that token was a SELL within 72h AND lifetime pnl > $5k.
      const exitsByToken = {}; // token (asset) -> [{w,ts,sold,netSold,pnl,tier,age,market}]
      const exitsCandidates = []; // full rendering list (post-dedupe)
      const currentHolders = new Set();
      markets.forEach(r=>r.hr.forEach(tok=>tok.holders.forEach(h=>currentHolders.add(h.proxyWallet))));
      // v2.31.0: market-activity was pre-fetched in parallel inside subfetchPromises[]
      // above. allMarketActResults is an array of {r, acts} pairs; guard handles a
      // thrown/never-run IIFE. Body below is byte-identical to the prior for…of body.
      if (!allMarketActResults) allMarketActResults = [];
      for(const {r, acts} of allMarketActResults){
        if (!acts.length) continue;
        // Group last action per (wallet, asset/token) pair; also track sell/buy sums per token.
        const lastByWalletToken = {};  // key: w|token -> activity
        const sellSum = {}, buySum = {};
        acts.forEach(a=>{
          if(!a) return;
          const w = a.proxyWallet || a.user;
          if(!w) return;
          const token = a.asset;
          if(!token) return;
          const key = w+'|'+token;
          if(!lastByWalletToken[key] || (a.timestamp||0) > lastByWalletToken[key].timestamp) lastByWalletToken[key] = a;
          const side = (a.side||'').toUpperCase();
          const sz = Number(a.size)||0;
          if(side==='SELL') sellSum[key] = (sellSum[key]||0) + sz;
          else if(side==='BUY') buySum[key] = (buySum[key]||0) + sz;
        });
        Object.entries(lastByWalletToken).forEach(([key,a])=>{
          const [w, token] = key.split('|');
          if(currentHolders.has(w)) return;
          if((a.side||'').toUpperCase()!=='SELL') return;
          const age = now - (a.timestamp||0);
          if(age > 72*3600) return;
          const sold = sellSum[key]||0;
          if(sold <= 0) return;
          const bought = buySum[key]||0;
          const netSold = Math.max(sold-bought, 0);
          const tier = age <= 24*3600 ? 'fresh' : 'recent';
          const cached = userStats[w] || cacheGet(w) || null;
          const pnl = cached && typeof cached.pnlAll==='number' ? cached.pnlAll : null;
          (exitsByToken[token] = exitsByToken[token] || []).push({w,ts:a.timestamp,token,sold,netSold,pnl,tier,age,market:r.m.question||r.m.conditionId.slice(0,10)});
        });
      }
      // Backfill pnlAll for unknown exit candidates (top by sold volume, capped at 50)
      const allExitRows = Object.values(exitsByToken).flat();
      const uniqueByWallet = {};
      allExitRows.forEach(x=>{if(!uniqueByWallet[x.w] || x.ts > uniqueByWallet[x.w].ts) uniqueByWallet[x.w] = x;});
      const unknownExits = Object.values(uniqueByWallet).filter(c=>c.pnl==null).sort((a,b)=>b.sold-a.sold).slice(0,50);
      const pnlByWallet = {};
      for(let i=0;i<unknownExits.length;i+=10){
        const batch = unknownExits.slice(i,i+10);
        const arr = await Promise.all(batch.map(c=>safeFetch('https://lb-api.polymarket.com/profit?window=all&limit=1&address='+c.w)));
        batch.forEach((c,k)=>{const resp=arr[k]; if(resp && resp[0] && typeof resp[0].amount==='number') pnlByWallet[c.w] = resp[0].amount;});
        await new Promise(r=>setTimeout(r,0));   // v2.33.0: 50→0 (event-loop yield only; endpoint 429 cooldown absorbs spikes)
      }
      // v2.0: exits are now quality-weighted instead of binary pnl>$5k counts.
      // score = Σ over unique (wallet, token) of: walletQuality × netSold × timeWeight
      //   walletQuality = tanh(pnlAll/$50k) × winRate  ∈ [0, 1]
      //   timeWeight    = 1.0 if age ≤ 24h, 0.5 if 24–72h, 0 otherwise
      // Still kept `profitableExitsByToken` as a raw count for UI display continuity.
      const profitableExitsByToken = {};   // token → count (display only)
      const exitQualityByToken = {};        // token → quality-weighted score (predictor input)
      Object.entries(exitsByToken).forEach(([token, arr])=>{
        const byW = {};
        arr.forEach(x=>{
          const pnl = x.pnl!=null ? x.pnl : pnlByWallet[x.w];
          if(typeof pnl !== 'number' || pnl <= 5000) return;
          if(!byW[x.w] || x.ts > byW[x.w].ts) byW[x.w] = {...x, pnl};
        });
        profitableExitsByToken[token] = Object.keys(byW).length;
        let qualityScore = 0;
        Object.values(byW).forEach(x=>{
          const u = userStats[x.w] || cacheGet(x.w) || null;
          const wr = (u && typeof u.winRate === 'number') ? u.winRate : 0.5;
          const walletQuality = Math.tanh((x.pnl||0) / 50000) * wr;
          const ageHours = x.age / 3600;
          const timeWeight = ageHours <= 24 ? 1.0 : (ageHours <= 72 ? 0.5 : 0);
          qualityScore += walletQuality * x.netSold * timeWeight;
          exitsCandidates.push(x);
        });
        exitQualityByToken[token] = qualityScore;
      });
      markPhase('exits');
      setStep(6, 'Rendering dashboard…', 97); updateCounts();
      const mmSet=new Set();
      markets.forEach(r=>{
        const walletTokens={};
        r.hr.forEach(tok=>{tok.holders.forEach(h=>{(walletTokens[h.proxyWallet]=walletTokens[h.proxyWallet]||new Set()).add(tok.token);});});
        Object.entries(walletTokens).forEach(([w,ts])=>{if(ts.size>1)mmSet.add(w);});
      });
      function isEliteFn(u){const v=u.volume||0;const p=u.pnlAll||0;return p>25000 && v>100000 && (p/(v||1))>0.15 && (u.pnl30d||0)>=0 && (u.pnl7d||0)>=0 && (u.winRate||0)>0.55;}
      // Archetype classifier with confidence. Precedence: market_maker > bot > insider_like > late_edge > sharp > public_chase > neutral.
      // Each archetype evaluates its required conditions; confidence = (met/total) × avg_overshoot_strength.
      // Returns {archetype, confidence, reasons[]}.
      function computeArchetypeWithConfidence(r){
        const u = r.u;
        // v2.3: prefer per-row profile (loosened gates for prop / derivative markets) over event-wide PROFILE.
        const P = r.profile || PROFILE;
        // Helper: each cond is {ok: bool, strength: [0,1] (how far past threshold), reason: str}
        const evalArch = (conds) => {
          const met = conds.filter(c=>c.ok);
          if (met.length !== conds.length) return null;  // hard-AND for all archetype conditions
          const strength = met.length ? met.reduce((s,c)=>s+Math.max(0,Math.min(1,c.strength||1)),0)/met.length : 0;
          return { strength, reasons: met.map(c=>c.reason) };
        };
        // 1) market_maker
        const mmConds = [
          { ok: r.inventoryRatio!=null && r.inventoryRatio>=0.7 && r.inventoryRatio<=1.43,
            strength: r.inventoryRatio==null?0:Math.max(0,1-Math.abs(Math.log(r.inventoryRatio||1))),
            reason: 'inventory balanced ('+(r.inventoryRatio||0).toFixed(2)+')' },
          { ok: (u.volume||0) > 100000, strength: Math.min((u.volume||0)/300000, 1), reason: 'volume '+Math.round((u.volume||0)/1000)+'k' },
          { ok: Math.abs(u.pnlAll||0) < (u.volume||0)*0.02,
            strength: (u.volume||0)>0 ? Math.max(0, 1 - Math.abs(u.pnlAll||0)/((u.volume||0)*0.02)) : 0,
            reason: 'flat PnL vs volume' }
        ];
        const mm = evalArch(mmConds);
        if (mm) return { archetype:'market_maker', confidence: mm.strength, reasons: mm.reasons };
        // 2) bot
        const botConds = [
          { ok: u.tradeIntervalStdDev!=null && u.tradeIntervalStdDev < P.botIntervalMs/1000,
            strength: u.tradeIntervalStdDev==null?0:Math.max(0,1-u.tradeIntervalStdDev/(P.botIntervalMs/1000)),
            reason: 'tight intervals ('+Math.round(u.tradeIntervalStdDev||0)+'s σ)' },
          { ok: (u.tradeCount||0) >= 50, strength: Math.min((u.tradeCount||0)/200, 1), reason: (u.tradeCount||0)+' trades' },
          { ok: (u.volume||0) > 100000, strength: Math.min((u.volume||0)/500000, 1), reason: 'volume '+Math.round((u.volume||0)/1000)+'k' }
        ];
        const bot = evalArch(botConds);
        if (bot) return { archetype:'bot', confidence: bot.strength, reasons: bot.reasons };
        // 3) insider_like — trades in insider window before start, with positive edge
        const inWindow = r.tradeInInsiderWindow === true;
        const insiderConds = [
          { ok: inWindow, strength: 1, reason: 'bet within '+Math.round(P.insiderWindow/60)+'min of start' },
          { ok: (u.entryQuality||0) > 0.05, strength: Math.min((u.entryQuality||0)/0.25, 1), reason: 'CLV +'+Math.round((u.entryQuality||0)*100)+'%' },
          { ok: (u.pnlAll||0) > P.sharpMinPnl*0.3, strength: Math.min((u.pnlAll||0)/(P.sharpMinPnl), 1), reason: 'lifetime PnL '+Math.round((u.pnlAll||0)/1000)+'k' }
        ];
        const ins = evalArch(insiderConds);
        if (ins) return { archetype:'insider_like', confidence: ins.strength, reasons: ins.reasons };
        // 4) late_edge — low preGameShare + positive quality + material PnL
        const leConds = [
          { ok: r.preGameShare!=null && r.preGameShare < 0.3, strength: r.preGameShare==null?0:Math.max(0,1-r.preGameShare/0.3), reason: 'mostly in-game ('+Math.round((r.preGameShare||0)*100)+'% pre-game)' },
          { ok: (u.entryQuality||0) > 0.05, strength: Math.min((u.entryQuality||0)/0.25, 1), reason: 'CLV +'+Math.round((u.entryQuality||0)*100)+'%' },
          { ok: (u.pnlAll||0) > P.sharpMinPnl*0.5, strength: Math.min((u.pnlAll||0)/P.sharpMinPnl, 1), reason: 'lifetime PnL '+Math.round((u.pnlAll||0)/1000)+'k' }
        ];
        const le = evalArch(leConds);
        if (le) return { archetype:'late_edge', confidence: le.strength, reasons: le.reasons };
        // 5) sharp — two paths: strict (lifetime PnL + winRate + positive CLV) or veteran (4x PnL + 50%+ winRate regardless of CLV)
        const sharpGate = (u.positionsSampled === false) ? P.sharpMinPnl : P.sharpMinPnl*2;
        const strictSharp = [
          { ok: (u.pnlAll||0) > sharpGate, strength: Math.min((u.pnlAll||0)/(sharpGate*2), 1), reason: 'lifetime PnL '+Math.round((u.pnlAll||0)/1000)+'k > '+(sharpGate/1000)+'k gate' },
          { ok: (u.winRate||0) > P.sharpMinWinRate, strength: Math.min(((u.winRate||0)-P.sharpMinWinRate)/0.15, 1), reason: 'winRate '+Math.round((u.winRate||0)*100)+'%' },
          { ok: (u.entryQuality||0) > -0.15, strength: Math.min(((u.entryQuality||0)+0.15)/0.35, 1), reason: 'CLV '+Math.round((u.entryQuality||0)*100)+'% ≥ -15%' }
        ];
        const sh = evalArch(strictSharp);
        if (sh) return { archetype:'sharp', confidence: sh.strength, reasons: sh.reasons };
        // Veteran sharp: very large lifetime edge, waive CLV + relax winRate
        const veteranSharp = [
          { ok: (u.pnlAll||0) > P.sharpMinPnl*4, strength: Math.min((u.pnlAll||0)/(P.sharpMinPnl*8), 1), reason: 'veteran PnL '+Math.round((u.pnlAll||0)/1000)+'k > '+(P.sharpMinPnl*4/1000)+'k' },
          { ok: (u.winRate||0) > 0.50, strength: Math.min(((u.winRate||0)-0.50)/0.20, 1), reason: 'winRate '+Math.round((u.winRate||0)*100)+'%' }
        ];
        const vsh = evalArch(veteranSharp);
        if (vsh) return { archetype:'sharp', confidence: Math.min(vsh.strength, 0.8), reasons: vsh.reasons };
        // 6) public_chase — high preGameShare + poor quality
        const pcConds = [
          { ok: r.preGameShare!=null && r.preGameShare > 0.8, strength: r.preGameShare==null?0:Math.min((r.preGameShare-0.8)/0.2, 1), reason: 'chase pre-game ('+Math.round((r.preGameShare||0)*100)+'%)' },
          { ok: (u.entryQuality||0) < -0.05, strength: Math.min(Math.abs(u.entryQuality||0)/0.25, 1), reason: 'CLV '+Math.round((u.entryQuality||0)*100)+'%' },
          { ok: (r.avg||0) > P.publicMinAvgEntry, strength: Math.min(((r.avg||0)-P.publicMinAvgEntry)/0.2, 1), reason: 'bought at '+Math.round((r.avg||0)*100)+'¢' }
        ];
        const pc = evalArch(pcConds);
        if (pc) return { archetype:'public_chase', confidence: pc.strength, reasons: pc.reasons };
        // 7) legacy public — no preGameShare data required
        const pubConds = [
          { ok: (r.avg||0) > P.publicMinAvgEntry, strength: Math.min(((r.avg||0)-P.publicMinAvgEntry)/0.2, 1), reason: 'bought at '+Math.round((r.avg||0)*100)+'¢' },
          { ok: (u.entryQuality||0) < 0, strength: Math.min(Math.abs(u.entryQuality||0)/0.2, 1), reason: 'CLV '+Math.round((u.entryQuality||0)*100)+'%' },
          { ok: (u.pnlAll||0) < 0, strength: Math.min(Math.abs(u.pnlAll||0)/10000, 1), reason: 'lifetime PnL '+Math.round((u.pnlAll||0)/1000)+'k' }
        ];
        const pub = evalArch(pubConds);
        if (pub) return { archetype:'public', confidence: pub.strength, reasons: pub.reasons };
        return { archetype:'neutral', confidence: 0, reasons: [] };
      }
      const sides={};
      const multiMarketEvent = markets.length > 1;
      markets.forEach(r=>{
        const marketStartSec = r.m.startDate ? Math.floor(new Date(r.m.startDate).getTime()/1000) : (r.m.createdAt ? Math.floor(new Date(r.m.createdAt).getTime()/1000) : null);
        const marketAgeShort = marketStartSec != null && (now - marketStartSec) < 86400;
        const marketResolved = isResolved(r.m);
        const marketWinner = marketResolved ? winnerOf(r.m, r.outcomes) : null;
        // v2.3: per-market profile (looser sharp gates on props / derivatives)
        const marketProfile = getMarketProfile(r.m.question || '', sportKey);
        r.hr.forEach(tok=>{
          const idx=r.clob.indexOf(tok.token);
          const label=r.outcomes[idx]||('Outcome '+idx);
          const sideKey = r.m.conditionId + '|' + label;  // disambiguate multi-market events sharing outcome names
          const price=r.prices?parseFloat(r.prices[idx]):0.5;
          const rows=tok.holders.slice().sort((a,b)=>b.amount-a.amount).map((h,i)=>{
            const u=userStats[h.proxyWallet]||{value:0,pnlAll:0,pnl30d:0,pnl7d:0,volume:0,winRate:0,earliestActivity:null,winRateSampled:false,positionsSampled:false,tradeIntervalStdDev:null,tradeCount:0,entryQuality:0,leagueFocus:null};
            const positions=positionsByWallet[h.proxyWallet]||[];
            const acts=activityByWallet[h.proxyWallet]||[];
            const thisPos=positions.find(p=>p.asset===tok.token)||{};
            const avg=thisPos.avgPrice||null;
            let posPnl=positions.filter(p=>p.asset===tok.token).reduce((s,p)=>s+((Number(p.cashPnl)||0)+(Number(p.realizedPnl)||0)),0);
            // Resolved-market backfill path A: /positions drops settled rows, sum activity.realizedPnl for this token/market.
            if (posPnl === 0 && marketResolved) {
              acts.forEach(a=>{
                if (a && a.conditionId === r.m.conditionId && a.asset === tok.token) {
                  posPnl += Number(a.realizedPnl) || 0;
                }
              });
            }
            // Resolved-market backfill path B: analytical settlement PnL when activity cache misses (bounded to last 100).
            // If we still have $0 but thisPos has size + avgPrice, compute what the token would have paid out at settlement.
            if (posPnl === 0 && marketResolved && thisPos && (Number(thisPos.size)||0) > 0 && (Number(thisPos.avgPrice)||0) > 0) {
              const size = Number(thisPos.size);
              const avg = Number(thisPos.avgPrice);
              const won = marketWinner === label;
              posPnl = size * ((won ? 1 : 0) - avg);
            }
            // Inventory ratio: this-side $ vs other-side(s) $ on the SAME market
            let thisSideUSD=0, otherSideUSD=0;
            positions.forEach(p=>{
              if(p.conditionId !== r.m.conditionId) return;
              const usd=(Number(p.size)||0)*(Number(p.avgPrice)||0);
              if(p.asset===tok.token) thisSideUSD+=usd; else otherSideUSD+=usd;
            });
            const inventoryRatio = (thisSideUSD>0 && otherSideUSD>0) ? thisSideUSD/otherSideUSD : null;
            let firstInMarket=null;
            let tradeInInsiderWindow=false;
            acts.forEach(a=>{if(a && a.asset===tok.token){const t=Number(a.timestamp); if(t && (firstInMarket==null || t<firstInMarket)) firstInMarket=t;}});
            // Insider window: any BUY within PROFILE.insiderWindow seconds BEFORE market start.
            if (marketStartSec != null) {
              acts.forEach(a=>{
                if(!a || a.asset!==tok.token) return;
                if(a.type && a.type!=='TRADE') return;
                if((a.side||'').toUpperCase()!=='BUY') return;
                const t=Number(a.timestamp)||0;
                if(t>0 && t<marketStartSec && (marketStartSec-t)<=PROFILE.insiderWindow) tradeInInsiderWindow=true;
              });
            }
            const hold=firstInMarket?now-firstInMarket:null;
            const conc=u.value>0?(h.amount*price/u.value):null;
            const isNew = u.earliestActivity ? (now - u.earliestActivity) < 7*86400 : false;
            // Pre-game share on this market (if market.startDate exposed)
            let preGameShare=null;
            if (marketStartSec != null) {
              let total=0, preCount=0;
              acts.forEach(a=>{
                if(!a||a.conditionId!==r.m.conditionId)return;
                if(a.type && a.type!=='TRADE')return;
                total++;
                if((Number(a.timestamp)||0) < marketStartSec) preCount++;
              });
              preGameShare = total>0 ? preCount/total : null;
            }
            let n24=0;
            if (!marketAgeShort) {
              acts.forEach(a=>{
                if(!a||a.asset!==tok.token)return;
                if(a.type && a.type!=='TRADE')return;
                const ts=Number(a.timestamp);
                if(!ts||(now-ts)>86400)return;
                const sz=Number(a.size)||0;
                const side=(a.side||'').toUpperCase();
                if(side==='BUY')n24+=sz;else if(side==='SELL')n24-=sz;
              });
            }
            const n24pct=h.amount>0?n24/h.amount:0;
            const mm=mmSet.has(h.proxyWallet);
            const altMm=thisPos && thisPos.asset===tok.token && (Number(thisPos.size)||0)>0 && (thisPos.avgPrice==null||thisPos.avgPrice===0);
            const volMm=(u.volume||0)>500000 && Math.abs(u.pnlAll||0)<2000;
            const elite=isEliteFn(u);
            const bookmarked=!!bookmarks[h.proxyWallet];
            const row = {rank:i+1,h,u,price,avg,posPnl,hold,conc,isNew,n24,n24pct,mm,altMm,volMm,elite,bookmarked,inventoryRatio,preGameShare,tradeInInsiderWindow,firstInMarket,sideLabel:label,tokenId:tok.token,conditionId:r.m.conditionId,profile:marketProfile};
            const ac = computeArchetypeWithConfidence(row);
            row.archetype = ac.archetype;
            row.archConfidence = ac.confidence;
            row.archReasons = ac.reasons;
            return row;
          });
          sides[sideKey]={rows,price,market:r.m,displayLabel:label,marketQuestion:r.m.question||'',resolved:marketResolved,winner:marketWinner};
          // v2.29.0: attach normalized display fields once. displayLabel stays raw — every
          // internal match (outcomes[].indexOf, winner equality, DOM-button lookup, sideKey
          // identity) continues to key on it. Only human-facing renderers read displaySide.
          const _disp = normalizeDisplaySide(r.m.question || '', label);
          sides[sideKey].rawSide     = _disp.rawSide;
          sides[sideKey].displaySide = _disp.displaySide;
          sides[sideKey].line        = _disp.line;
          sides[sideKey].sideType    = _disp.sideType;
        });
      });
      // ── PREDICTION SCORING ────────────────────────────────────────────
      // For each side s within a conditionId group, compute 6 normalized [-1,+1] components:
      //   SharpEdge, Flow24h, CLV, Consistency, ExitSignal, InsiderTiming
      // Opposite side = mean of other sides' raw values within the same conditionId.
      // Score = Σ weight_i × component_i, skipping missing components and renormalizing weights.
      // Probability = softmax(alpha × score) within conditionId. Confidence scaled by DataQuality.
      // Group sides by conditionId
      const marketGroups = {};
      Object.entries(sides).forEach(([label, s])=>{
        const cid = s.market.conditionId;
        (marketGroups[cid] = marketGroups[cid] || []).push(label);
      });
      // DataQuality (market-wide, informs confidence)
      const dq_failureRate = mon.calls>0 ? mon.fails/Math.max(mon.calls,1) : 0;
      const dq_truncationRate = walletList.length ? walletList.filter(w=>userStats[w] && userStats[w].positionsSampled).length / walletList.length : 0;
      const dq_coverage = Math.min(walletList.length/Math.max(topN,1), 1);
      let DataQuality = (1-dq_failureRate) * (1-dq_truncationRate) * dq_coverage;
      const anyStartExposed = markets.some(r=>r.m.startDate || r.m.createdAt);
      if (!anyStartExposed) DataQuality *= 0.7;  // insider window unavailable
      DataQuality = Math.max(0, Math.min(1, DataQuality));
      // Raw per-side metrics used by the component computations
      function rawMetrics(label){
        const rows = sides[label].rows;
        const sidePrice = sides[label].price || 0.5;
        let sharpNotional=0, totalNotional=0, insiderNotional=0, publicNotional=0, edgeWeightedSum=0, edgeWeightSum=0, sharpCount=0, eliteNotional=0, eliteNotionalNiche=0, eliteCount=0;
        // v2.11: elite diagnostics — what's the average wallet quality of the elite cohort on this side?
        let eliteSumPnlAll=0, eliteSumWinRate=0, eliteRoiWeightedSum=0, eliteRoiWeightSum=0;
        // v2.12: amount-weighted elite average entry price. Feeds tail-winners extension math.
        let eliteEntryWeightedSum=0, eliteAmountSum=0;
        let trueClvWeightedSum=0, trueClvWeightSum=0;  // v2.0: for true CLV from prices-history
        // v2.8: per-archetype unrealized-ROI accumulators for holderProfit. ROI = (curPrice−avg)/avg,
        // weighted by entryNotional so bigger positions count more within the bucket.
        let sharpRoiWeightedSum=0, sharpRoiWeightSum=0, sharpRoiCount=0;
        let publicRoiWeightedSum=0, publicRoiWeightSum=0, publicRoiCount=0;
        const sharpWinRates=[];
        const tokenId = rows[0] ? rows[0].tokenId : null;
        const refPrice = tokenId ? refPriceByToken[tokenId] : null;
        rows.forEach(r=>{
          const curPrice = r.price || sidePrice;
          const amount = r.h.amount || 0;
          const notional = amount * curPrice;
          totalNotional += notional;
          // v1.9: sharpEdge orthogonalized — count only `sharp` archetype. insider_like and late_edge
          // are measured by insiderTiming and winRate (via consistency) respectively.
          if (r.archetype==='sharp') { sharpNotional += notional; sharpCount++; }
          if (r.archetype==='insider_like') insiderNotional += notional;
          if (r.archetype==='public' || r.archetype==='public_chase') publicNotional += notional;  // v2.1: contrarian input
          // v2.10: elite is the strongest PnL filter we have on a wallet (isEliteFn at line 1478).
          // Sum notional held by elite wallets per side; eliteEdge component diffs share vs other sides.
          // v2.11: niche-multiplied notional (eliteNotionalNiche) is what feeds eliteEdge — wallets
          // whose leagueFocus matches the event league get full credit, mismatches get 0.35×.
          // Diagnostics (eliteAvgPnlAll/WinRate/Roi) accumulate across the elite cohort regardless of niche.
          if (r.elite) {
            eliteNotional += notional;
            eliteCount++;
            const niche = nicheMultiplier(r.u && r.u.leagueFocus);
            eliteNotionalNiche += notional * niche;
            eliteSumPnlAll  += Number(r.u && r.u.pnlAll)  || 0;
            eliteSumWinRate += Number(r.u && r.u.winRate) || 0;
            // capital-weighted unrealized ROI for the elite cohort (per-share PnL ÷ entry price)
            if (r.avg != null && r.avg > 0 && curPrice > 0 && amount > 0) {
              const entryNot = amount * r.avg;
              const roi = (curPrice - r.avg) / r.avg;
              eliteRoiWeightedSum += roi * entryNot;
              eliteRoiWeightSum   += entryNot;
              // v2.12: amount-weighted entry price (the natural "avg cost across all elite shares")
              eliteEntryWeightedSum += r.avg * amount;
              eliteAmountSum        += amount;
            }
          }
          const eq = Math.max(-1, Math.min(1, r.u.entryQuality||0)); // clamp per wallet before weighted avg
          if (notional > 0) { edgeWeightedSum += eq*notional; edgeWeightSum += notional; }
          if (r.archetype==='sharp' && r.u.winRate!=null) sharpWinRates.push(r.u.winRate);
          // v2.0: true CLV per wallet = refPrice - avgPrice (entered below post-entry mark = positive).
          // Use each wallet's avgPrice (from /positions), weighted by notional.
          if (refPrice != null && r.avg != null && notional > 0) {
            const wClv = Math.max(-1, Math.min(1, refPrice - r.avg));
            trueClvWeightedSum += wClv * notional;
            trueClvWeightSum += notional;
          }
          // v2.8: holderProfit per-bucket ROI accumulation. r.avg is from /positions; null when the
          // holder doesn't have a position record (rare — usually holders/positions agree per wallet).
          if (amount > 0 && r.avg != null && r.avg > 0 && curPrice > 0) {
            const entryNotional = amount * r.avg;
            if (entryNotional > 0) {
              const unrealizedRoi = (curPrice - r.avg) / r.avg;
              if (r.archetype === 'sharp') {
                sharpRoiWeightedSum += unrealizedRoi * entryNotional;
                sharpRoiWeightSum   += entryNotional;
                sharpRoiCount++;
              } else if (r.archetype === 'public' || r.archetype === 'public_chase') {
                publicRoiWeightedSum += unrealizedRoi * entryNotional;
                publicRoiWeightSum   += entryNotional;
                publicRoiCount++;
              }
            }
          }
        });
        const sharpAvgUnrealizedRoi  = sharpRoiWeightSum  > 0 ? sharpRoiWeightedSum  / sharpRoiWeightSum  : null;
        const publicAvgUnrealizedRoi = publicRoiWeightSum > 0 ? publicRoiWeightedSum / publicRoiWeightSum : null;
        const walletEdgeSide = edgeWeightSum>0 ? edgeWeightedSum/edgeWeightSum : 0;
        const trueClvSide = trueClvWeightSum > 0 ? trueClvWeightedSum/trueClvWeightSum : null;
        const insiderShare = totalNotional>0 ? insiderNotional/totalNotional : 0;
        const eliteShare      = totalNotional>0 ? eliteNotional      /totalNotional : 0;  // v2.10
        const eliteShareNiche = totalNotional>0 ? eliteNotionalNiche /totalNotional : 0;  // v2.11
        const eliteAvgPnlAll  = eliteCount > 0 ? eliteSumPnlAll  / eliteCount : null;
        const eliteAvgWinRate = eliteCount > 0 ? eliteSumWinRate / eliteCount : null;
        const eliteAvgRoi     = eliteRoiWeightSum > 0 ? eliteRoiWeightedSum / eliteRoiWeightSum : null;
        const eliteAvgEntry   = eliteAmountSum   > 0 ? eliteEntryWeightedSum / eliteAmountSum   : null;  // v2.12
        const publicShare  = totalNotional>0 ? publicNotional /totalNotional : 0;
        const avgWinRateSharp = sharpWinRates.length ? sharpWinRates.reduce((a,b)=>a+b,0)/sharpWinRates.length : null;
        const exitQuality = tokenId ? (exitQualityByToken[tokenId]||0) : 0;  // v2.0: quality-weighted
        const exitsCount = tokenId ? (profitableExitsByToken[tokenId]||0) : 0;  // kept for UI display
        // Flow24h from trade tape (Prompt C): comprehensive, not limited to top-N holders.
        // Net24hUSD = Σ ±size×price over trades in last 24h (BUY +, SELL −).
        let net24USD = 0, trades24hCount = 0;
        if (tokenId && tradesByToken[tokenId]) {
          tradesByToken[tokenId].forEach(t=>{
            if (now - t.timestamp > 86400) return;
            trades24hCount++;
            const usd = t.size * t.price;
            if (t.side === 'BUY') net24USD += usd;
            else if (t.side === 'SELL') net24USD -= usd;
          });
        }
        // Book tilt (Prompt B): per-token top-5-level CLOB imbalance, pre-computed in bookByToken.
        const bookEntry = tokenId ? bookByToken[tokenId] : null;
        const bookTilt = bookEntry && bookEntry.tilt != null ? bookEntry.tilt : null;
        return {sharpNotional, sharpCount, totalNotional, insiderShare, publicShare, net24USD, trades24hCount, walletEdgeSide, trueClvSide, avgWinRateSharp, exitsCount, exitQuality, bookTilt, sharpAvgUnrealizedRoi, publicAvgUnrealizedRoi, sharpRoiCount, publicRoiCount, eliteShare, eliteShareNiche, eliteCount, eliteNotional, eliteNotionalNiche, eliteAvgPnlAll, eliteAvgWinRate, eliteAvgRoi, eliteAvgEntry};
      }

      // v2.9: Cluster Intel — group wallets that look coordinated on the same side.
      // Display + log only this phase; no model scoring impact (Phase 2 territory).
      // Algorithm: greedy clustering. Sort eligible holders by avgPrice; start a new cluster
      // when the price gap to the previous holder exceeds CLUSTER_MAX_ENTRY_PRICE_GAP. Within
      // each price-cluster, subdivide by entry-time gaps (firstInMarket) when timestamps exist.
      // Eligibility: amount > 0, avg != null, archetype not 'market_maker' (LP flow, not directional).
      // Quality scoring rewards: more wallets, higher notional, tight price/time, sharp-heavy mix,
      // unrealized profit. Penalizes: public-heavy clusters, missing timing data.
      function detectClustersForSide(rows, sidePrice, opts){
        // v2.23: opts is optional for back-compat with any future stray caller.
        // Expected shape: { tokenId, exitQualityByToken } — used for the new sub-scores
        // computed inside this function (eliteShareScore / pnlMagnitudeScore / exitPenalty).
        // fairValueScore is computed by the post-prediction enrichment pass (needs modelProb).
        const tokenId = opts && opts.tokenId;
        const exitQualityForSide = (opts && opts.exitQualityByToken) || {};
        const eligible = (rows || []).filter(r =>
          r && r.h && r.h.proxyWallet
          && (r.h.amount || 0) > 0
          && r.avg != null && r.avg > 0
          && r.archetype !== 'market_maker'
        );
        if (eligible.length < TUNING.CLUSTER_MIN_WALLETS) return [];
        // Stage 1: greedy price clustering
        const byPrice = eligible.slice().sort((a,b) => (a.avg||0) - (b.avg||0));
        const priceGroups = [];
        let cur = [byPrice[0]];
        for (let i = 1; i < byPrice.length; i++) {
          if ((byPrice[i].avg - byPrice[i-1].avg) <= TUNING.CLUSTER_MAX_ENTRY_PRICE_GAP) {
            cur.push(byPrice[i]);
          } else {
            if (cur.length) priceGroups.push(cur);
            cur = [byPrice[i]];
          }
        }
        if (cur.length) priceGroups.push(cur);
        // Stage 2: within each price group, subdivide by time gaps when timestamps available
        const candidates = [];
        priceGroups.forEach(grp => {
          if (grp.length < TUNING.CLUSTER_MIN_WALLETS) return;
          const withTime = grp.filter(r => r.firstInMarket != null && !isNaN(r.firstInMarket));
          if (withTime.length >= TUNING.CLUSTER_MIN_WALLETS) {
            const byTime = withTime.slice().sort((a,b) => a.firstInMarket - b.firstInMarket);
            let tcur = [byTime[0]];
            for (let i = 1; i < byTime.length; i++) {
              if ((byTime[i].firstInMarket - byTime[i-1].firstInMarket) <= TUNING.CLUSTER_MAX_ENTRY_TIME_GAP_SEC) {
                tcur.push(byTime[i]);
              } else {
                if (tcur.length >= TUNING.CLUSTER_MIN_WALLETS) candidates.push({rows: tcur, timingConfidence: 1});
                tcur = [byTime[i]];
              }
            }
            if (tcur.length >= TUNING.CLUSTER_MIN_WALLETS) candidates.push({rows: tcur, timingConfidence: 1});
            // Also keep the price-only group at lower timing confidence if it adds wallets (no-time holders)
            const noTime = grp.filter(r => r.firstInMarket == null || isNaN(r.firstInMarket));
            if (noTime.length && grp.length >= TUNING.CLUSTER_MIN_WALLETS) {
              candidates.push({rows: grp, timingConfidence: 0.4});
            }
          } else {
            // No timing data for the group; price-only with low confidence
            candidates.push({rows: grp, timingConfidence: 0.2});
          }
        });
        // Stage 3: build cluster objects + score
        const clusters = candidates.map(c => {
          const wallets = [];
          const seen = new Set();
          c.rows.forEach(r => {
            if (seen.has(r.h.proxyWallet)) return;  // dedupe by wallet
            seen.add(r.h.proxyWallet);
            wallets.push({
              addr: r.h.proxyWallet,
              amount: r.h.amount || 0,
              avg: r.avg,
              archetype: r.archetype || 'neutral',
              // v2.23: PnL magnitude + elite share inputs. r.u is the wallet's userStats
              // object (already attached at row construction, line 3335). isEliteFn is the
              // strongest single PnL gate we have on a wallet (defined just above at the
              // archetype computation block).
              pnlAll: (r.u && r.u.pnlAll) || 0,
              elite: r.u ? isEliteFn(r.u) : false
            });
          });
          if (wallets.length < TUNING.CLUSTER_MIN_WALLETS) return null;
          const cur = sidePrice || 0.5;
          const totalNotional = wallets.reduce((s,w) => s + (w.amount * (w.avg||0)), 0);
          if (totalNotional < TUNING.CLUSTER_MIN_NOTIONAL) return null;
          const avgEntry = wallets.reduce((s,w) => s + (w.avg||0) * (w.amount * (w.avg||0)), 0) / Math.max(totalNotional, 1);
          const unrealizedRoi = avgEntry > 0 ? (cur - avgEntry) / avgEntry : 0;
          const archetypeCounts = {};
          wallets.forEach(w => { archetypeCounts[w.archetype] = (archetypeCounts[w.archetype]||0) + 1; });
          const sharpLike = (archetypeCounts['sharp']||0) + (archetypeCounts['insider_like']||0) + (archetypeCounts['late_edge']||0);
          const publicLike = (archetypeCounts['public']||0) + (archetypeCounts['public_chase']||0);
          // Timing span (if time available on at least 2 wallets)
          const times = c.rows.map(r => r.firstInMarket).filter(t => t != null && !isNaN(t));
          const timingSpanSec = times.length >= 2 ? (Math.max.apply(null, times) - Math.min.apply(null, times)) : null;
          // Quality score components (each 0..1, then normalized to 0..1 overall):
          //   walletWeight: tanh((n-3)/4) → 0 at n=3, ~0.46 at n=5, ~0.76 at n=7, saturates
          //   notionalWeight: tanh(notional/50000) → ~0.46 at $25k, ~0.76 at $50k, saturates
          //   priceTightness: 1 - (priceSpread / MAX_GAP) — tighter clusters score higher
          //   timingTightness: confidence × (1 - span/MAX_GAP) — only counts when timing exists
          //   archetypeQuality: (sharpLike - publicLike) / walletCount → -1..+1, then clamp 0..1
          //   roiBonus: tanh(roi × 5) → small + when in profit, − when in loss; clamped 0..1
          const walletWeight = Math.max(0, Math.min(1, Math.tanh((wallets.length - 3) / 4)));
          const notionalWeight = Math.tanh(totalNotional / 50000);
          const priceSpread = wallets.length > 1 ? Math.max.apply(null, wallets.map(w => w.avg)) - Math.min.apply(null, wallets.map(w => w.avg)) : 0;
          const priceTightness = Math.max(0, 1 - (priceSpread / TUNING.CLUSTER_MAX_ENTRY_PRICE_GAP));
          const timingTightness = (timingSpanSec != null && c.timingConfidence > 0)
            ? c.timingConfidence * Math.max(0, 1 - (timingSpanSec / TUNING.CLUSTER_MAX_ENTRY_TIME_GAP_SEC))
            : 0;
          const archetypeQuality = Math.max(0, Math.min(1, (sharpLike - publicLike) / Math.max(wallets.length, 1)));
          const roiBonus = Math.max(0, Math.min(1, Math.tanh(unrealizedRoi * 5)));
          // Weighted average of the six factors (all roughly 0..1). Renamed from qualityScore
          // to baseQualityScore in v2.23 — this is now the 50% backbone of the new blended score
          // assembled in the post-prediction enrichment pass below. Formula UNCHANGED.
          const baseQualityScore = (walletWeight*0.20 + notionalWeight*0.20 + priceTightness*0.15
                              + timingTightness*0.20 + archetypeQuality*0.20 + roiBonus*0.05);
          // v2.23 Phase 1 — three of four new cluster quality sub-scores.
          // The fourth (fairValueScore) requires modelProb and is computed in the post-prediction
          // enrichment pass; storing 0 here is just a placeholder until that pass overwrites it.
          //
          // 1. Elite share — share of cluster wallets that pass isEliteFn. Per spec, an elite
          //    share of 0.30 saturates the sub-score at 1.0 (eliteShare / 0.30, clamped).
          const eliteWalletCount = wallets.filter(w => w.elite).length;
          const eliteShare = eliteWalletCount / Math.max(wallets.length, 1);
          const eliteShareScore = clamp01(eliteShare / 0.30);
          // 2. PnL magnitude — log10-scaled lifetime PnL per wallet, averaged across cluster.
          //    log10(max(pnl,1))/6 is 0 below $1 PnL and saturates at 1.0 at $1M lifetime PnL.
          //    Negative-PnL wallets contribute 0 (clamped). Per spec: "do not reward losers".
          const walletPnlScores = wallets.map(w => {
            const pnl = Math.max(w.pnlAll || 0, 1);
            return clamp01(Math.log10(pnl) / 6);
          });
          const pnlMagnitudeScore = walletPnlScores.length
            ? walletPnlScores.reduce((a,b) => a+b, 0) / walletPnlScores.length
            : 0;
          // 3. Exit-quality anti-correlation penalty — if smart money is simultaneously exiting
          //    this token (exitQualityByToken populated at line 3146), a cluster of buyers is
          //    counter-signal, not consensus. Penalty subtracted from the final blended score.
          const exitQualityRaw = tokenId ? (exitQualityForSide[tokenId] || 0) : 0;
          const exitPenalty = clamp01(exitQualityRaw);
          // qualityScore + label here are placeholders that the enrichment pass will overwrite
          // once modelProb is known. They use baseQualityScore so the dedupe sort below (and any
          // pre-enrichment consumer) still gets a sensible ordering.
          const placeholderLabel = baseQualityScore >= TUNING.CLUSTER_STRONG_SCORE ? 'strong'
                                 : baseQualityScore >= 0.40 ? 'medium' : 'weak';
          return {
            walletCount: wallets.length, wallets, totalNotional, avgEntry, currentPrice: cur, unrealizedRoi,
            archetypeCounts, sharpLikeCount: sharpLike, publicLikeCount: publicLike,
            timingSpanSec, timingConfidence: c.timingConfidence,
            // v2.23: pre-enrichment Phase-1 inputs. The post-prediction enrichment pass blends
            // these into the final qualityScore and overwrites label.
            baseQualityScore,
            eliteShareScore,
            pnlMagnitudeScore,
            exitPenalty,
            fairValueScore: 0,
            qualityScore: baseQualityScore,
            label: placeholderLabel
          };
        }).filter(Boolean);
        // Dedupe: a wallet might appear in both a tight time-subgroup and the looser price-only parent.
        // Prefer higher-quality clusters; remove later clusters that share ≥50% wallets with an earlier kept one.
        // Pre-enrichment qualityScore == baseQualityScore here, which is a stable ordering for
        // dedupe purposes (dedupe is about dropping overlapping candidates, not final ranking —
        // the enrichment pass and panel render both re-sort post-blend).
        clusters.sort((a,b) => b.qualityScore - a.qualityScore || b.totalNotional - a.totalNotional);
        const kept = [];
        clusters.forEach(c => {
          const cAddrs = new Set(c.wallets.map(w => w.addr));
          const dup = kept.some(k => {
            const overlap = k.wallets.filter(w => cAddrs.has(w.addr)).length;
            return overlap / Math.max(k.walletCount, c.walletCount) >= 0.5;
          });
          if (!dup) kept.push(c);
        });
        return kept;
      }

      // Compute raw metrics per side
      const sideRaw = {};
      Object.keys(sides).forEach(label=>{sideRaw[label] = rawMetrics(label);});
      // v2.9: detect clusters per side. Display + log only — no model scoring impact.
      // v2.23: tokenId + exitQualityByToken passed through so detectClustersForSide can compute
      // three of the four new Phase-1 sub-scores (eliteShareScore / pnlMagnitudeScore /
      // exitPenalty). The fourth (fairValueScore) is filled in by the enrichment pass that
      // runs after the predictions loop closes — see further below. The console log moves
      // there too so the printed scores reflect the final blended values.
      const clustersBySide = {};
      Object.keys(sides).forEach(label => {
        const s = sides[label];
        const sideTokenId = (s.rows && s.rows[0]) ? s.rows[0].tokenId : null;
        const cs = detectClustersForSide(s.rows, s.price, {
          tokenId: sideTokenId,
          exitQualityByToken
        });
        if (cs.length) clustersBySide[label] = cs;
      });
      // Build components per conditionId group
      const predictions = {};  // label -> {score, components, probability, confidence, activeWeights}
      Object.entries(marketGroups).forEach(([cid, labels])=>{
        labels.forEach(label=>{
          const r = sideRaw[label];
          const others = labels.filter(l=>l!==label);
          const oppMean = (key) => others.length ? others.reduce((s,l)=>s+(sideRaw[l][key]||0),0)/others.length : 0;
          // K1/K2 adaptive: scale with side notional (v2.0 added K2 adaptive)
          const K1_eff = Math.max(TUNING.K1_BASE, r.totalNotional * TUNING.SHARPEDGE_SIDE_FRACTION);
          const K2_eff = Math.max(TUNING.K2_BASE, r.totalNotional * TUNING.K2_SIDE_FRACTION);
          const sharpEdge     = Math.tanh((r.sharpNotional - oppMean('sharpNotional')) / K1_eff);
          let flow24h         = Math.tanh((r.net24USD      - oppMean('net24USD'))      / K2_eff);
          const walletEdge    = Math.max(-1, Math.min(1, r.walletEdgeSide - oppMean('walletEdgeSide')));
          // v2.0: true CLV component. Skip when this token has no history; opp mean over sides that do.
          let clv = null;
          if (r.trueClvSide != null) {
            const oppClv = others.map(l=>sideRaw[l].trueClvSide).filter(x=>x!=null);
            if (oppClv.length) {
              const oppMeanClv = oppClv.reduce((a,b)=>a+b,0)/oppClv.length;
              clv = Math.max(-1, Math.min(1, r.trueClvSide - oppMeanClv));
            } else {
              clv = Math.max(-1, Math.min(1, r.trueClvSide));  // lone token → use raw diff
            }
          }
          // Consistency: skip when no sharps on either side; amplify by 5×
          let consistency = null;
          if (r.avgWinRateSharp!=null) {
            const oppRates = others.map(l=>sideRaw[l].avgWinRateSharp).filter(x=>x!=null);
            if (oppRates.length) {
              const oppMeanWR = oppRates.reduce((a,b)=>a+b,0)/oppRates.length;
              consistency = Math.tanh((r.avgWinRateSharp - oppMeanWR) * TUNING.CONSISTENCY_AMP);
            }
          }
          // v2.0: exit signal uses quality-weighted score (was count). K3 rescaled to 5000.
          const exitSignal    = Math.tanh((oppMean('exitQuality') - r.exitQuality) / TUNING.K3);
          let insiderTiming   = Math.max(-1, Math.min(1, r.insiderShare - oppMean('insiderShare')));
          // v2.1: contrarian — when public/public_chase archetypes hold a majority of this side's
          // notional, the fade-the-public heuristic predicts negative edge. Magnitude saturates
          // quickly so the signal stays bounded even when one side is near-pure-public.
          const contrarian = -Math.tanh((r.publicShare - oppMean('publicShare')) * 2);
          // Book tilt (Prompt B): skip if own-side has no book; opp mean only over sides that also have a book.
          let bookTilt = null;
          if (r.bookTilt != null) {
            const oppBooks = others.map(l=>sideRaw[l].bookTilt).filter(x=>x!=null);
            if (oppBooks.length) {
              const oppMeanBook = oppBooks.reduce((a,b)=>a+b,0)/oppBooks.length;
              bookTilt = Math.max(-1, Math.min(1, r.bookTilt - oppMeanBook));
            } else {
              bookTilt = Math.max(-1, Math.min(1, r.bookTilt));  // lone book → use raw tilt
            }
          }
          // v2.0: time decay on time-sensitive components. flow24h and insiderTiming lose
          // relevance as the game approaches and the lines firm up. Half-life = 6h by default.
          const startStr = sides[label].market && sides[label].market.startDate;
          const startSec = startStr ? Math.floor(Date.parse(startStr)/1000) : null;
          if (startSec != null && !isNaN(startSec)) {
            const hoursToEvent = Math.max(0, (startSec - now) / 3600);
            const timeDecay = 1 / (1 + hoursToEvent / TUNING.TIME_DECAY_HALF_LIFE_HRS);
            flow24h = flow24h * timeDecay;
            insiderTiming = insiderTiming * timeDecay;
          }
          // v2.8: holderProfit — sharps' weighted-avg unrealized ROI minus public's, on THIS side.
          // Skip when either bucket is empty (small-N noise isn't worth scoring). Per-side only;
          // softmax over sides handles side-vs-opponent comparison. tanh saturates the signal.
          let holderProfit = null;
          if (r.sharpAvgUnrealizedRoi != null && r.publicAvgUnrealizedRoi != null
              && r.sharpRoiCount > 0 && r.publicRoiCount > 0) {
            holderProfit = Math.tanh((r.sharpAvgUnrealizedRoi - r.publicAvgUnrealizedRoi) * TUNING.HOLDER_PROFIT_K);
          }
          // v2.10: eliteEdge — share of side notional held by isEliteFn-validated wallets vs others.
          // Elite is the most direct PnL gate we have (pnlAll>$25k, vol>$100k, pnl/vol>15%, win>55%,
          // pnl30d≥0, pnl7d≥0). The diff vs opposite side captures "winners are on this side."
          // Skip when no eligible wallets on either side (rare; tiny markets).
          // v2.11: gated on min sample (≥2 elite wallets OR ≥$7500 elite notional) — one tiny
          // elite wallet shouldn't drive a full signal. Uses niche-multiplied shares so an NBA-
          // focused elite wallet counts more on NBA than on UFC. Compared against opposite sides'
          // niche-multiplied shares so the comparison is consistent.
          let eliteEdge = null;
          if (r.totalNotional > 0 && (r.eliteCount >= 2 || r.eliteNotional >= 7500)) {
            const oppEliteShares = others.map(l => sideRaw[l].eliteShareNiche).filter(x => x != null && !isNaN(x));
            const oppMeanElite = oppEliteShares.length ? oppEliteShares.reduce((a,b)=>a+b,0)/oppEliteShares.length : 0;
            eliteEdge = Math.tanh((r.eliteShareNiche - oppMeanElite) * TUNING.ELITE_EDGE_K);
          }
          // v2.11: publicTrap as zero-weight diagnostic. Negative when public dominates and elite
          // is absent (this side is a fade-the-public scenario). NOT in TUNING.WEIGHTS — the
          // active-weight loop only iterates WEIGHTS keys, so absence = zero score contribution.
          // We measure it now, weight it later if grading shows it predicts losses.
          const publicTrap = -Math.tanh(((r.publicShare || 0) - (r.eliteShare || 0)) * 2);
          const components = {sharpEdge, flow24h, walletEdge, clv, consistency, exit: exitSignal, insiderTiming, bookTilt, contrarian, holderProfit, eliteEdge, publicTrap};
          // Weighted sum, skipping missing components (consistency = null) and renormalizing
          let score=0, wsum=0;
          const activeWeights = {};
          Object.entries(TUNING.WEIGHTS).forEach(([k,w])=>{
            const v = components[k];
            if (v==null || isNaN(v)) return;
            score += v*w;
            wsum += w;
            activeWeights[k] = w;
          });
          const normalizedScore = wsum>0 ? score/wsum : 0;
          const rawP = Math.exp(TUNING.ALPHA * normalizedScore);
          predictions[label] = {score: normalizedScore, components, rawP, activeWeights};
        });
        // Softmax within conditionId group
        const sumExp = labels.reduce((s,l)=>s + predictions[l].rawP, 0);
        labels.forEach(label=>{
          const p = predictions[label];
          const r = sideRaw[label];
          p.probability = sumExp>0 ? p.rawP/sumExp : 1/labels.length;
          // v1.9: sample-size factor. A strong score from 2 sharps shouldn't carry the same
          // confidence as the same score from 60 sharps. tanh(n/8) saturates near 1 by n≈20.
          // v2.5: loosened from tanh(n/8)*tanh(notional/100k) (product collapsed to near-zero
          // on realistic prop markets with 1-3 sharps) to a gentler single tanh(n/3) with a
          // 0.5 floor so non-sharp components (clv, walletEdge, book) still produce meaningful
          // confidence even on sides with few sharps.
          const sampleFactor = 0.5 + 0.5 * Math.tanh((r.sharpCount||0) / 3);
          // v2.3: OI conviction factor. When observed holder notional is small relative to total open
          // interest, most positions are flipping through (low conviction) → mild confidence haircut.
          // Conservative: floor at OI_CONVICTION_FLOOR, ceiling at 1.0. Skipped when OI is missing or tiny.
          const cidOi = oiByCid[sides[label].market.conditionId];
          let oiFactor = 1.0;
          if (typeof cidOi === 'number' && cidOi > 5000 && r.totalNotional > 1000) {
            const heldRatio = Math.min(1, r.totalNotional / cidOi);
            oiFactor = TUNING.OI_CONVICTION_FLOOR + (1 - TUNING.OI_CONVICTION_FLOOR) * heldRatio;
          }
          p.confidence = Math.max(0, Math.min(1, TUNING.CONFIDENCE_FLOOR + TUNING.CONFIDENCE_SCALE * Math.abs(p.score) * DataQuality * sampleFactor * oiFactor));
          p.sampleFactor = sampleFactor;
          p.oiFactor = oiFactor;
        });
      });
      // ── END PREDICTION SCORING ────────────────────────────────────────
      // v2.23 Phase 1 — cluster qualityScore enrichment. READ-ONLY on predictions[*].
      // v2.24 Phase 2A extends this pass with cross-event recurring-group detection:
      // top-5 wallet coalitions tracked in localStorage; small qualityScore penalty when
      // the same group appears across many distinct events. Both Phase-1 and Phase-2A
      // changes are display-only — this block does NOT mutate predictions[*], modelProb,
      // p.confidence, top-pick selection, bet thresholds, or any prediction component.
      //
      // Blended formula (Phase 1 + Phase 2A):
      //   newQualityScore = clamp01( baseQualityScore   * 0.50
      //                            + eliteShareScore    * 0.10
      //                            + fairValueScore     * 0.15
      //                            + pnlMagnitudeScore  * 0.15
      //                            − exitPenalty        * 0.10
      //                            − recurringGroupScore * 0.10 )
      // fairValueScore needs predictions[label].probability (modelProb), only available
      // after the predictions loop above closes. recurringGroupScore reads/writes the
      // rolling localStorage memory loaded once below.
      // v2.24.1: destructure the diagnostic counters from loadRecurringGroups (raw loaded
      // count, post-prune active count, decayed by 12h TTL, capped by 5000-entry cap) and
      // also accumulate two per-run counters as clusters are scored: `recTouched` is the
      // set of unique groupKeys recorded via touchRecurringGroup this page load, and
      // `recPenalizedClusters` / `recMaxPenalty` track where the recur penalty actually
      // applied (recurringEventCount >= 3, since the formula is no-op at counts 1–2).
      const { mem: recurringMemory, loaded: recLoaded, active: recActive,
              decayed: recDecayed, capped: recCapped } = loadRecurringGroups();
      const recTouched = new Set();
      let recPenalizedClusters = 0;
      let recMaxPenalty = 0;
      Object.entries(clustersBySide).forEach(([label, clusters]) => {
        const pred = predictions[label];
        const modelProb = pred && pred.probability;
        clusters.forEach(c => {
          let fairValueScore = 0;
          if (modelProb != null && c.avgEntry != null) {
            const fairValueEdge = modelProb - c.avgEntry;
            fairValueScore = clamp01((fairValueEdge + 0.05) / 0.15);
          }
          c.fairValueScore = fairValueScore;
          // v2.24 Phase 2A — cross-event recurring-group detection. Skips clusters with
          // fewer than RECURRING_GROUP_MIN_WALLETS=3 (per spec — small clusters are exempt).
          // touchRecurringGroup() records the current event in the memory entry's events
          // set (dedupe-on-insert), then we read events.length so the count INCLUDES the
          // current sighting. Score saturates at 1.0 when the group has appeared in 10+
          // distinct events; 1–2 events together = 0 penalty (organic / coincidence ok).
          let recurringGroupScore = 0;
          let recurringEventCount = 0;
          let recurringGroupKey = null;
          if (c.wallets && c.wallets.length >= TUNING.RECURRING_GROUP_MIN_WALLETS) {
            recurringGroupKey = computeClusterGroupKey(c.wallets);
            if (recurringGroupKey && slug) {
              const entry = touchRecurringGroup(recurringMemory, recurringGroupKey, slug);
              if (entry) {
                recurringEventCount = entry.events.length;
                recurringGroupScore = clamp01((recurringEventCount - 2) / 8);
                // v2.24.1: per-run diagnostic accumulators. `recTouched` is a Set so the
                // same coalition appearing across both Yes/No sides only counts once.
                recTouched.add(recurringGroupKey);
                if (recurringGroupScore > 0) {
                  recPenalizedClusters += 1;
                  const applied = recurringGroupScore * 0.10;
                  if (applied > recMaxPenalty) recMaxPenalty = applied;
                }
              }
            }
          }
          c.recurringGroupScore = recurringGroupScore;
          c.recurringEventCount = recurringEventCount;
          c.recurringGroupKey   = recurringGroupKey;
          const blended =
              c.baseQualityScore   * 0.50
            + c.eliteShareScore    * 0.10
            + fairValueScore       * 0.15
            + c.pnlMagnitudeScore  * 0.15
            - c.exitPenalty        * 0.10
            - recurringGroupScore  * 0.10;
          c.qualityScore = clamp01(blended);
          c.label = c.qualityScore >= TUNING.CLUSTER_STRONG_SCORE ? 'strong'
                  : c.qualityScore >= 0.40 ? 'medium' : 'weak';
        });
        clusters.sort((a,b) => b.qualityScore - a.qualityScore || b.totalNotional - a.totalNotional);
      });
      // v2.24 Phase 2A: persist memory once, after all clusters across all sides scored.
      // Silent no-op if localStorage is disabled / quota full.
      saveRecurringGroups(recurringMemory);
      // v2.24.1: single-line diagnostic summary of recurring-group activity this page load.
      // Emitted before the existing enriched log so the operational summary shows first.
      try {
        console.log('[PM Sports v2.24 recurring groups]', {
          loaded: recLoaded,
          active: recActive,
          touched: recTouched.size,
          decayed: recDecayed,
          capped: recCapped,
          penalizedClusters: recPenalizedClusters,
          maxPenalty: Number(recMaxPenalty.toFixed(4)),
          storageKey: TUNING.RECURRING_GROUPS_KEY
        });
      } catch(_){}
      try {
        console.log('[PM Sports clusters · v2.24 enriched]', clustersBySide);
        Object.entries(clustersBySide).forEach(([label, clusters]) => {
          clusters.forEach((c, i) => {
            console.log(
              '  ['+label+' #'+i+']',
              'q='+(c.qualityScore*100).toFixed(0)+'%',
              '(base='+(c.baseQualityScore*100).toFixed(0),
              '+ elite='+(c.eliteShareScore*100).toFixed(0),
              '+ fair='+(c.fairValueScore*100).toFixed(0),
              '+ pnl='+(c.pnlMagnitudeScore*100).toFixed(0),
              '− exit='+(c.exitPenalty*100).toFixed(0),
              '− recur='+((c.recurringGroupScore||0)*100).toFixed(0),
              c.recurringEventCount ? '· '+c.recurringEventCount+'evt' : '',
              ')'
            );
          });
        });
      } catch(_){}
      // ── v2.25 Phase 2 Part 1: CLV TRACKING (display + log only) ───────────
      // For each side, aggregate per-wallet (referencePrice − avgEntry) weighted by entry
      // notional, bucketed by Elite/Public. This is purely observational: never feeds
      // prediction math, weights, modelProb, Top Picks, Tail Winners, or alerts.
      // Reads sides[label].rows (which carry r.avg from /positions and r.elite from
      // isEliteFn) and refPriceByToken[tokenId] (the v2.0 closing-line proxy already
      // populated upstream — no new fetches). marketEdgeFor() is hoisted in this scope
      // and is also pure-read on predictions[] / book / market price.
      //
      // Weighting: entry notional (amount × avg) — matches cluster.avgEntry semantics
      // (line ~3726) so this aggregate is comparable to the cluster-level avgEntry.
      const clvBySide = {};
      const clvLogRows = [];
      const clvConsoleSummary = [];
      // v2.26 Phase 2 Part 2: per-(wallet, marketType) specialization memory + side rollups.
      // Loaded once (decay + cap inside loadWalletSpecialization), updated dedup-gated inside
      // the per-row loop below, persisted once after the side-loop. Display + log only.
      const specializationMem = loadWalletSpecialization();
      const seenSpecializationKeys = new Set();
      const specializationBySide = {};
      const specConsoleSummary = [];
      // v2.27 Phase 2 Part 3: pass-level entry/exit pressure rollups. Computed inside the
      // same side-loop after sideSpec is finalized; persisted after the loop. Display + log
      // only — never read by prediction math.
      const accumulationBySide = {};
      const accumulationLogRows = [];
      const accumulationConsoleSummary = [];
      Object.keys(sides).forEach(label => {
        const s = sides[label];
        if (!s || !s.rows || !s.rows.length) return;
        const tokenId = s.rows[0].tokenId;
        const referencePrice = tokenId ? refPriceByToken[tokenId] : null;
        // v2.28.1: removed the `if (referencePrice == null) return;` early-return that
        // previously gated the entire side iteration. CLV + specialization still require a
        // reference price (gated inline below), but the v2.27 entry/exit pressure block runs
        // unconditionally — computeSidePressure tolerates null referencePrice (smartBuyVWAP
        // falls back to null; hiddenAccumulation null-checks before firing). Pre-branch
        // declarations (cid / marketType / round3 / round4 / pred / me) are hoisted so both
        // the CLV branch AND the always-on pressure block can reference them.
        const cid = s.market && s.market.conditionId;
        const marketType = classifyMarketType(
          s.marketQuestion || (s.market && s.market.question) || '',
          sportKey
        );
        const round3 = v => v == null ? null : Number(v.toFixed(3));
        const round4 = v => v == null ? null : Number(v.toFixed(4));
        const pred = predictions[label];
        const me = marketEdgeFor(label);
        // ── CLV + Specialization branch ─── requires referencePrice ───────────
        if (referencePrice != null) {
          let sideW = 0, sideWS = 0;
          let eliteW = 0, eliteWS = 0;
          let publicW = 0, publicWS = 0;
          let walletCount = 0, eliteWalletCount = 0, publicWalletCount = 0;
          // v2.26: side-local specialization accumulators. Weighted by entry notional, matching
          // the CLV bucket weighting above. Pre-update scores are used for the rollup; the
          // memory entry is updated AFTER scoring (track-record semantics).
          let sideSpecScoreSum   = 0, sideSpecScoreWeight   = 0;
          let eliteSpecScoreSum  = 0, eliteSpecScoreWeight  = 0;
          let publicSpecScoreSum = 0, publicSpecScoreWeight = 0;
          let scoredWallets = 0, lowSampleWallets = 0;
          const topWalletCandidates = [];
          s.rows.forEach(r => {
            if (r == null || r.avg == null || isNaN(r.avg)) return;
            const amount = (r.h && r.h.amount) || 0;
            const weight = amount * r.avg;             // entry notional
            if (!(weight > 0)) return;
            const walletCLV = referencePrice - r.avg;
            walletCount += 1;
            sideW  += walletCLV * weight;
            sideWS += weight;
            if (r.elite) {
              eliteWalletCount += 1;
              eliteW  += walletCLV * weight;
              eliteWS += weight;
            } else {
              publicWalletCount += 1;
              publicW  += walletCLV * weight;
              publicWS += weight;
            }
            // v2.26: specialization update + side rollup. Snapshot the wallet's PRE-update
            // memory entry, score it, use that score in the side rollup, THEN update the entry.
            // Dedup-gated by (wallet, conditionId, sideLabel, marketType) — gate wraps BOTH the
            // memory increment AND the rollup accumulation so duplicates don't double-count.
            const walletAddr = r.h && r.h.proxyWallet;
            if (walletAddr) {
              const memKey = walletAddr + '|' + marketType;
              const preScore = walletSpecializationScore(specializationMem[memKey]);
              const dedupKey = walletAddr + '|' + cid + '|' + (s.displayLabel || label) + '|' + marketType;
              if (!seenSpecializationKeys.has(dedupKey)) {
                seenSpecializationKeys.add(dedupKey);
                let entry = specializationMem[memKey];
                if (!entry) {
                  entry = specializationMem[memKey] = {
                    wallet: walletAddr, marketType, sport: sportKey,
                    samples: 0, totalNotional: 0,
                    clvSumWeighted: 0, clvWeight: 0,
                    positiveClvCount: 0,
                    avgEntrySumWeighted: 0, refPriceSumWeighted: 0,
                    eliteCount: 0, publicCount: 0,
                    lastUpdated: 0
                  };
                }
                entry.samples += 1;
                entry.totalNotional += weight;
                entry.clvSumWeighted += walletCLV * weight;
                entry.clvWeight += weight;
                entry.positiveClvCount += walletCLV > 0 ? 1 : 0;
                entry.avgEntrySumWeighted += r.avg * weight;
                entry.refPriceSumWeighted += referencePrice * weight;
                entry.eliteCount += r.elite ? 1 : 0;
                entry.publicCount += r.elite ? 0 : 1;
                entry.lastUpdated = Date.now();
                if (preScore.score == null) {
                  lowSampleWallets += 1;
                } else {
                  scoredWallets += 1;
                  sideSpecScoreSum    += preScore.score * weight;
                  sideSpecScoreWeight += weight;
                  if (r.elite) {
                    eliteSpecScoreSum    += preScore.score * weight;
                    eliteSpecScoreWeight += weight;
                  } else {
                    publicSpecScoreSum    += preScore.score * weight;
                    publicSpecScoreWeight += weight;
                  }
                  topWalletCandidates.push({
                    wallet: walletAddr, score: preScore.score, label: preScore.label,
                    samples: preScore.samples, avgCLV: preScore.avgCLV,
                    positiveCLVRate: preScore.positiveCLVRate
                  });
                }
              }
            }
          });
          const sideWeightedCLV   = sideWS  > 0 ? sideW  / sideWS  : null;
          const eliteWeightedCLV  = eliteWS > 0 ? eliteW / eliteWS : null;
          const publicWeightedCLV = publicWS > 0 ? publicW / publicWS : null;
          const clvSpread = (eliteWeightedCLV != null && publicWeightedCLV != null)
            ? eliteWeightedCLV - publicWeightedCLV : null;
          clvBySide[label] = {
            referencePrice, sideWeightedCLV, eliteWeightedCLV,
            publicWeightedCLV, clvSpread,
            walletCount, eliteWalletCount, publicWalletCount
          };
          // v2.26: finalize side specialization rollups using the per-row accumulators.
          const sideSpec = {
            marketType,
            sideSpecializationScore:   sideSpecScoreWeight   > 0 ? sideSpecScoreSum   / sideSpecScoreWeight   : null,
            eliteSpecializationScore:  eliteSpecScoreWeight  > 0 ? eliteSpecScoreSum  / eliteSpecScoreWeight  : null,
            publicSpecializationScore: publicSpecScoreWeight > 0 ? publicSpecScoreSum / publicSpecScoreWeight : null,
            scoredWallets, lowSampleWallets,
            topWallets: topWalletCandidates.sort((a, b) => b.score - a.score).slice(0, 5)
          };
          specializationBySide[label] = sideSpec;
          clvLogRows.push({
            timestamp:         Date.now(),
            slug:              slug || null,
            marketQuestion:    s.marketQuestion || (s.market && s.market.question) || null,
            conditionId:       cid || null,
            sideLabel:         s.displayLabel || label,
            sport:             sportKey,
            marketType,
            modelProb:         pred ? pred.probability : null,
            effectiveCost:     me ? me.effectiveCost : null,
            referencePrice,
            sideWeightedCLV,
            eliteWeightedCLV,
            publicWeightedCLV,
            clvSpread,
            walletCount,
            eliteWalletCount,
            publicWalletCount
          });
          clvConsoleSummary.push({
            market:            s.marketQuestion ? s.marketQuestion.slice(0, 60) : cid,
            side:              s.displayLabel || label,
            modelProb:         round3(pred ? pred.probability : null),
            referencePrice:    round3(referencePrice),
            sideWeightedCLV:   round4(sideWeightedCLV),
            eliteWeightedCLV:  round4(eliteWeightedCLV),
            publicWeightedCLV: round4(publicWeightedCLV),
            clvSpread:         round4(clvSpread),
            walletCount
          });
          // v2.26: specialization console summary row (one per side). Numeric values rounded
          // for log legibility; full precision is kept in the persisted memory blob.
          const round1 = v => v == null ? null : Number(v.toFixed(1));
          specConsoleSummary.push({
            market:                    s.marketQuestion ? s.marketQuestion.slice(0, 60) : cid,
            side:                      s.displayLabel || label,
            sport:                     sportKey,
            marketType,
            sideSpecializationScore:   round1(sideSpec.sideSpecializationScore),
            eliteSpecializationScore:  round1(sideSpec.eliteSpecializationScore),
            publicSpecializationScore: round1(sideSpec.publicSpecializationScore),
            scoredWallets, lowSampleWallets,
            topWallets: sideSpec.topWallets.map(w => ({
              addr: w.wallet.slice(0, 6) + '…' + w.wallet.slice(-4),
              score: round1(w.score), label: w.label,
              samples: w.samples,
              avgCLV: round4(w.avgCLV),
              positiveCLVRate: round3(w.positiveCLVRate)
            }))
          });
        }
        // ── v2.27 ENTRY / EXIT PRESSURE — runs unconditionally (v2.28.1 ungated) ──
        // Reads tradesByToken[tokenId] (already in closure scope from the parallel subfetch
        // block) and s.rows for the wallet→bucket map. No new network fetches. The pressure
        // result is read-only by the renderer + the console.log + the localStorage log row;
        // never mutates predictions, weights, modelProb, Top Picks, Tail Winners, or alerts.
        // computeSidePressure handles null referencePrice safely: smartBuyVWAP falls back to
        // null, hiddenAccumulation requires non-null refPrice + the ≥0.5¢ gap guard.
        const book = tokenId ? bookByToken[tokenId] : null;
        const currentPrice = (book && book.bestAsk != null) ? book.bestAsk
                           : (s.price != null) ? s.price
                           : null;
        const sideTrades = (tokenId && tradesByToken[tokenId]) || [];
        const sidePressure = computeSidePressure({
          rows:           s.rows,
          trades:         sideTrades,
          currentPrice,
          referencePrice,
          modelProb:      pred ? pred.probability : null,
          lookbackSec:    TUNING.ACCUMULATION_LOOKBACK_HOURS * 3600,
          minNotional:    TUNING.ACCUMULATION_MIN_NOTIONAL,
          ratioHi:        1.25,
          ratioLo:        0.80
        });
        accumulationBySide[label] = sidePressure;
        accumulationLogRows.push({
          timestamp:             Date.now(),
          slug:                  slug || null,
          marketQuestion:        s.marketQuestion || (s.market && s.market.question) || null,
          conditionId:           cid || null,
          sideLabel:             s.displayLabel || label,
          sport:                 sportKey,
          marketType,
          modelProb:             pred ? pred.probability : null,
          effectiveCost:         me ? me.effectiveCost : null,
          currentPrice,
          eliteBuyNotional:      sidePressure.eliteBuyNotional,
          eliteSellNotional:     sidePressure.eliteSellNotional,
          eliteNetNotional:      sidePressure.eliteNetNotional,
          sharpBuyNotional:      sidePressure.sharpBuyNotional,
          sharpSellNotional:     sidePressure.sharpSellNotional,
          sharpNetNotional:      sidePressure.sharpNetNotional,
          publicBuyNotional:     sidePressure.publicBuyNotional,
          publicSellNotional:    sidePressure.publicSellNotional,
          publicNetNotional:     sidePressure.publicNetNotional,
          smartNetNotional:      sidePressure.smartNetNotional,
          smartBuySellRatio:     sidePressure.smartBuySellRatio,
          distributionPressure:  sidePressure.distributionPressure,
          accumulationPressure:  sidePressure.accumulationPressure,
          hiddenAccumulation:    sidePressure.hiddenAccumulation,
          smartMoneyStillAdding: sidePressure.smartMoneyStillAdding,
          smartMoneyDumping:     sidePressure.smartMoneyDumping,
          pressureLabel:         sidePressure.pressureLabel,
          pressureReason:        sidePressure.pressureReason
        });
        const round0$ = v => v == null ? null : Math.round(v);
        accumulationConsoleSummary.push({
          market:            s.marketQuestion ? s.marketQuestion.slice(0, 60) : cid,
          side:              s.displayLabel || label,
          sport:             sportKey,
          marketType,
          modelProb:         round3(pred ? pred.probability : null),
          effectiveCost:     round3(me ? me.effectiveCost : null),
          currentPrice:      round3(currentPrice),
          eliteNetNotional:  round0$(sidePressure.eliteNetNotional),
          sharpNetNotional:  round0$(sidePressure.sharpNetNotional),
          publicNetNotional: round0$(sidePressure.publicNetNotional),
          smartNetNotional:  round0$(sidePressure.smartNetNotional),
          smartBuySellRatio: round3(sidePressure.smartBuySellRatio),
          pressureLabel:     sidePressure.pressureLabel,
          pressureReason:    sidePressure.pressureReason
        });
      });
      try { console.log('[PM Sports CLV tracking]', clvConsoleSummary); } catch(_){}
      try {
        if (clvLogRows.length) {
          const prior = JSON.parse(localStorage.getItem(TUNING.CLV_LOG_KEY) || '[]');
          const combined = (Array.isArray(prior) ? prior : []).concat(clvLogRows).slice(-TUNING.CLV_LOG_MAX);
          localStorage.setItem(TUNING.CLV_LOG_KEY, JSON.stringify(combined));
        }
      } catch(_){}
      // v2.26: emit per-side wallet-specialization summary + persist the updated memory blob.
      // The console line + saveWalletSpecialization both no-op safely if console / localStorage
      // are unavailable; the in-memory specializationBySide bundle is still available to the
      // Research-Mode renderer for this session.
      try { console.log('[PM Sports wallet specialization]', specConsoleSummary); } catch(_){}
      try { saveWalletSpecialization(specializationMem); } catch(_){}
      // v2.27: emit per-side accumulation-pressure summary + persist rolling log. Same
      // try/catch envelope as v2.25 CLV log — silent failure preserved (script must not
      // block on console / storage). The in-memory accumulationBySide bundle is still
      // available to the Research-Mode renderer in this session regardless of write status.
      try { console.log('[PM Sports accumulation pressure]', accumulationConsoleSummary); } catch(_){}
      try {
        if (accumulationLogRows.length) {
          const prior = JSON.parse(localStorage.getItem(TUNING.ACCUMULATION_LOG_KEY) || '[]');
          const combined = (Array.isArray(prior) ? prior : []).concat(accumulationLogRows).slice(-TUNING.ACCUMULATION_LOG_MAX);
          localStorage.setItem(TUNING.ACCUMULATION_LOG_KEY, JSON.stringify(combined));
        }
      } catch(_){}
      // v1.9: signed market-edge helper. Uses the side's bestAsk as fillable entry price
      // (fallback: gamma lastTradePrice → outcomePrices → 0.5), factored through takerBaseFee.
      // Returns null when inputs missing. Edge > 0 means model prob > effective cost = bet; ≤ 0 = skip.
      function marketEdgeFor(label){
        const p = predictions[label];
        const s = sides[label];
        if (!p || !s) return null;
        const tokenId = s.rows[0] ? s.rows[0].tokenId : null;
        const book = tokenId ? bookByToken[tokenId] : null;
        const lastTrade = s.market && s.market.lastTradePrice != null ? Number(s.market.lastTradePrice) : null;
        const rawPrice = (book && book.bestAsk != null) ? book.bestAsk
                       : (lastTrade != null && !isNaN(lastTrade)) ? lastTrade
                       : (s.price != null) ? s.price
                       : 0.5;
        // v2.5: fee is sanity-capped at 5%. Polymarket's takerBaseFee is 1% standard but the
        // gamma payload has been observed returning it as a raw percentage (e.g. 1 → meaning 1%)
        // rather than a decimal (0.01). Treating 1.0 as a decimal gave effectiveCost = 100¢ on
        // every row and broke every edge calc. Parse defensively: if the value looks like it's
        // encoded as percent or basis points, divide; otherwise accept as decimal. Cap at 5%.
        // v2.7.3: tightened boundaries. Old code treated anything >1 as basis-points, so
        // gamma returning 1.5 (1.5% as percent) became 0.00015 (0.015%) — a near-zero fee
        // that inflated edge. New rule: >5 = basis-points (5%+ as percent is unrealistic
        // for Polymarket; can only be bps), ≥0.5 = percent, <0.5 = already decimal.
        // Garbage values (e.g. 0.07–0.5 range, which is neither standard percent nor decimal)
        // hit the >0.05 catch-all and fall back to 1%.
        let feeRaw = s.market && s.market.takerBaseFee != null ? Number(s.market.takerBaseFee) : 0.01;
        if (!isFinite(feeRaw) || feeRaw < 0) feeRaw = 0.01;
        if (feeRaw > 5)         feeRaw = feeRaw / 10000;  // basis-points (100 = 1%, 50 = 0.5%)
        else if (feeRaw >= 0.5) feeRaw = feeRaw / 100;     // percent (1 = 1%, 1.5 = 1.5%, 5 = 5%)
        // else: ≤0.5, presumed already decimal (0.01 = 1%, 0.025 = 2.5%)
        if (feeRaw > 0.05) feeRaw = 0.01;                  // still weird, fall back to default
        const fee = feeRaw;
        const effectiveCost = Math.min(1, rawPrice * (1 + fee));
        return {edge: p.probability - effectiveCost, effectiveCost, rawPrice, fee};
      }
      // ── TAIL WINNERS SCORE (v2.12) ────────────────────────────────────
      // EXECUTION-LAYER ONLY. Does not feed back into modelProb, components, or weights.
      // Asks: "Given that the model thinks this side has edge, can we still tail it at the
      // CURRENT price, or is it already too extended past where the smart money got in?"
      //
      //   rangeToFair    = modelProb − eliteAvgEntry        // how far elite was below fair
      //   extensionRatio = (currentPrice − eliteAvgEntry)
      //                  / rangeToFair                       // 0 = at elite entry, 1 = at fair, >1 = past fair
      //
      // Hard zeros: edge ≤ 0, rangeToFair ≤ 0 (elite entry above fair = bad tail), or
      // extensionRatio ≥ 1 (already past model fair value).
      //
      // tailScore (0–100) is a weighted sum of five sub-scores:
      //   35% remaining edge        — modelProb − effectiveCost, mapped 0¢→0 / 10¢→1.
      //   25% extension quality     — 1 − extensionRatio, clamped 0..1 (further from fair = better).
      //   20% holder profitability  — eliteAvgRoi mapped to 0..1 + holderProfit mapped to 0..1, averaged.
      //   10% elite vs public dominance — eliteShare − publicShare, normalized.
      //   10% exit safety           — exit component: positive = no smart-money flight here.
      //
      // Return shape used by Top Picks filter/rank and prediction-table display.
      // null when essential inputs are missing (treated as "tail unavailable" = neutral 1.0× rank).
      function computeTailScore(label){
        const p = predictions[label];
        const s = sides[label];
        const r = sideRaw[label];
        const me = marketEdgeFor(label);
        if (!p || !s || !r || !me) return null;
        const modelProb     = p.probability;
        const effectiveCost = me.effectiveCost;
        const currentPrice  = me.rawPrice;
        const edge          = modelProb - effectiveCost;
        const eliteAvgEntry = r.eliteAvgEntry;
        const eliteRoi      = r.eliteAvgRoi;
        const holderProfit  = p.components ? p.components.holderProfit : null;
        const exitSignal    = p.components ? p.components.exit : null;
        const eliteShare    = r.eliteShare || 0;
        const publicShare   = r.publicShare || 0;
        const fairValue     = modelProb;
        // Hard-zero guards — edge gone or extension impossible.
        if (edge <= 0) {
          return {tailScore:0, stillTailPrice:'NO', extensionRatio:null, eliteAvgEntry, currentPrice, fairValue,
                  edge, exitSignal, eliteAvgRoi: eliteRoi,
                  reason:'No remaining edge — model probability does not exceed market ask + fee.'};
        }
        if (eliteAvgEntry == null || isNaN(eliteAvgEntry)) {
          return null;  // tail not computable without elite cohort entry — neutral pass-through
        }
        const rangeToFair = modelProb - eliteAvgEntry;
        if (rangeToFair <= 0) {
          return {tailScore:0, stillTailPrice:'NO', extensionRatio:null, eliteAvgEntry, currentPrice, fairValue,
                  edge, exitSignal, eliteAvgRoi: eliteRoi,
                  reason:'Bad tail: elite avg entry ('+(eliteAvgEntry*100).toFixed(0)+'¢) is at or above model fair value ('+(fairValue*100).toFixed(0)+'¢).'};
        }
        const extensionRatio = (currentPrice - eliteAvgEntry) / rangeToFair;
        // Sub-scores, each 0..1.
        const edgeScore = Math.max(0, Math.min(1, edge / 0.10));   // edge of 10pp saturates.
        const extensionScore = extensionRatio >= 1 ? 0
                              : extensionRatio < 0 ? 1            // entered below elite (great)
                              : Math.max(0, 1 - extensionRatio);
        let holderScore = 0; let holderParts = 0;
        if (eliteRoi != null && !isNaN(eliteRoi)) {
          // ROI of +30% → 1.0; 0% → 0.5; −30% → 0.
          holderScore += Math.max(0, Math.min(1, 0.5 + eliteRoi / 0.6));
          holderParts++;
        }
        if (holderProfit != null && !isNaN(holderProfit)) {
          holderScore += Math.max(0, Math.min(1, (holderProfit + 1) / 2));
          holderParts++;
        }
        holderScore = holderParts > 0 ? holderScore / holderParts : 0.5;
        // dominance: +20pp elite-over-public → 1.0; 0pp → 0.5; −20pp → 0.
        const dominanceScore = Math.max(0, Math.min(1, 0.5 + (eliteShare - publicShare) * 2.5));
        // exit safety: exitSignal +1 → 1.0 (no flight); 0 → 0.5; −1 → 0 (smart money fleeing this side).
        const exitScore = (exitSignal == null || isNaN(exitSignal))
          ? 0.6
          : Math.max(0, Math.min(1, (exitSignal + 1) / 2));
        const rawScore = 0.35 * edgeScore
                       + 0.25 * extensionScore
                       + 0.20 * holderScore
                       + 0.10 * dominanceScore
                       + 0.10 * exitScore;
        let tailScore = Math.round(rawScore * 100);
        // Heavy penalty when extensionRatio ≥ 1 (spec): force into "NO" zone regardless of edge.
        if (extensionRatio >= 1) tailScore = Math.min(tailScore, 25);
        // stillTailPrice classification.
        let stillTailPrice;
        if (tailScore >= 70 && extensionRatio < 0.7 && edge >= 0.03) stillTailPrice = 'YES';
        else if (tailScore >= 50 && extensionRatio < 0.9)            stillTailPrice = 'MAYBE';
        else                                                          stillTailPrice = 'NO';
        // Reason synthesis.
        let reason;
        if (extensionRatio >= 1) {
          reason = 'Too late: price ('+(currentPrice*100).toFixed(0)+'¢) already above model fair value ('+(fairValue*100).toFixed(0)+'¢).';
        } else if (extensionRatio > 0.85) {
          reason = 'Tight tail: price '+(extensionRatio*100).toFixed(0)+'% of the way from elite entry to fair value, only '+(edge*100).toFixed(1)+'pp edge left.';
        } else if (eliteRoi != null && eliteRoi > 0.05 && extensionRatio < 0.7) {
          reason = 'Elite holders profitable ('+(eliteRoi*100).toFixed(0)+'% ROI), price still '+((1-extensionRatio)*100).toFixed(0)+'% of the way from elite entry to model fair value.';
        } else if (exitSignal != null && exitSignal < -0.3) {
          reason = 'Caution: smart-money exits on this side (exit signal '+exitSignal.toFixed(2)+').';
        } else if (eliteShare > publicShare + 0.1) {
          reason = 'Elite outweighs public on this side, '+(edge*100).toFixed(1)+'pp edge remaining at '+(extensionRatio*100).toFixed(0)+'% extension.';
        } else {
          reason = 'Positive model edge ('+(edge*100).toFixed(1)+'pp), '+(extensionRatio*100).toFixed(0)+'% of the way to fair, no major exits.';
        }
        return {tailScore, stillTailPrice, extensionRatio, eliteAvgEntry, currentPrice, fairValue,
                edge, exitSignal, eliteAvgRoi: eliteRoi, reason};
      }
      // Precompute tail for every side (used by Top Picks filter, ranking, and prediction-table UI).
      const tailBySide = {};
      Object.keys(predictions).forEach(label => { tailBySide[label] = computeTailScore(label); });
      try { console.log('[PM Sports tail]', tailBySide); } catch(_){}
      // v2.34.0: precompute grade for every side. Uses scan-time signals only (notional /
      // holderCount / marketType / tail / accumulationBySide) so the grade is consistent
      // across dashboard, rollup table, EVENT DECISION banner, and bot export. Pure
      // execution-layer dimension — no impact on modelProb, components, weights, or
      // Top Picks ranking formula (the ranking formula is unchanged).
      const gradesBySide = {};
      Object.keys(predictions).forEach(label => {
        const p = predictions[label];
        const s = sides[label] || {};
        const sr = sideRaw[label] || {};
        const tail = tailBySide[label] || null;
        const accum = accumulationBySide[label] || null;
        const me = marketEdgeFor(label);
        if (!p || !me) { gradesBySide[label] = { grade:'PASS', reasons:['no edge data'] }; return; }
        const mqText = s.marketQuestion || (s.market && s.market.question) || '';
        gradesBySide[label] = gradeSide({
          action:            classifyAction(me.edge, p.confidence),
          edge:              me.edge,
          confidence:        p.confidence,
          modelProb:         p.probability,
          totalNotional:     sr.totalNotional != null ? sr.totalNotional : null,
          holderCount:       s.rows ? s.rows.length : null,
          marketType:        classifyMarketType(mqText, sportKey),
          tailScore:         tail ? tail.tailScore : null,
          extensionRatio:    tail ? tail.extensionRatio : null,
          exitSignal:        tail ? tail.exitSignal : null,
          smartMoneyDumping: accum ? accum.smartMoneyDumping === true : false
        });
      });
      try { console.log('[PM Sports grades]', gradesBySide); } catch(_){}
      // ── TOP PICKS (v1.9 + v2.12 tail filter/rank) ────────────────────
      // Rank favored-side-per-live-market by edge × confidence × liquidity, with v2.12 tail multiplier.
      // Edge is now signed against the bestAsk+fee (v1.9 fix); edge ≤ 0 = market-efficient, skip.
      const topPicks = Object.keys(predictions).map(label => {
        const p = predictions[label];
        const s = sides[label];
        if (!s || !p) return null;
        if (s.resolved) return null;
        if (p.probability < 0.5) return null;
        const liq = sideRaw[label] ? sideRaw[label].totalNotional : 0;
        if (liq < TUNING.TOP_PICKS_MIN_NOTIONAL) return null;
        const me = marketEdgeFor(label);
        if (!me || me.edge <= 0) return null;                     // no edge over market → skip
        if (me.edge * p.confidence < TUNING.TOP_PICKS_MIN_EDGE_CONF) return null;
        // v2.12: tail-winners gate. Tail-null sides (no elite cohort) bypass — keep legacy behavior.
        // When tail IS computable: drop picks where the price is past fair value, score is too low,
        // or smart money is fleeing this side. Model-side filter (edge × confidence) already passed.
        const tail = tailBySide[label];
        if (tail) {
          if (tail.tailScore < TUNING.TAIL_MIN_SCORE) return null;
          if (tail.extensionRatio != null && tail.extensionRatio >= 1) return null;
          if (tail.exitSignal != null && tail.exitSignal < TUNING.TAIL_MAX_EXIT_PENALTY) return null;
        }
        const liqFactor = Math.min(1, Math.sqrt(liq / 100000));
        // v2.12: rankScore = legacy(edge × confidence × liqFactor) × tail-multiplier (no tail = 1.0×).
        // Tail multiplier maps tailScore 0→0.5, 50→0.75, 100→1.0. Cannot create a pick on its own.
        const tailMult = tail ? (0.5 + tail.tailScore / 200) : 1.0;
        const rank = me.edge * p.confidence * liqFactor * tailMult;
        const contribs = Object.entries(p.components)
          .filter(([,v]) => v != null && !isNaN(v))
          .map(([k,v]) => ({k, v, contrib: Math.abs(v * (p.activeWeights[k]||0))}))
          .sort((a,b) => b.contrib - a.contrib)
          .slice(0, 2);
        // v2.34.0: attach precomputed grade (additive; ranking formula unchanged).
        const gradeEntry = gradesBySide[label] || null;
        return {label, rank, edge: me.edge, effectiveCost: me.effectiveCost, liq, contribs, p, s, tail,
                grade: gradeEntry ? gradeEntry.grade : null,
                gradeReasons: gradeEntry ? gradeEntry.reasons : []};
      }).filter(Boolean).sort((a,b) => b.rank - a.rank).slice(0, TUNING.TOP_PICKS_COUNT);
      // v2.2: Decision Summary support. Compute near-miss (highest-edge pick that didn't clear
      // thresholds) and analysis counts so the header can explain "why no picks" on efficient events.
      const pickedLabels = new Set(topPicks.map(t => t.label));
      const nearMiss = Object.keys(predictions).map(label => {
        if (pickedLabels.has(label)) return null;
        const p = predictions[label];
        const s = sides[label];
        if (!s || !p || s.resolved) return null;
        if (p.probability < 0.5) return null;   // only consider favored side
        const me = marketEdgeFor(label);
        if (!me) return null;
        return {label, s, p, edge: me.edge, rank: me.edge * p.confidence};
      }).filter(Boolean).sort((a,b) => b.rank - a.rank)[0] || null;
      // count unique LIVE markets (one per conditionId, not per side)
      const liveCids = new Set();
      Object.values(sides).forEach(s => { if (!s.resolved) liveCids.add(s.market.conditionId); });
      const analyzedLiveMarkets = liveCids.size;
      // sub-markets that hit either BET or LEAN classification (actionable even if not in top N)
      let actionableRowCount = 0;
      Object.keys(predictions).forEach(label => {
        const p = predictions[label];
        const s = sides[label];
        if (!s || !p || s.resolved || p.probability < 0.5) return;
        const me = marketEdgeFor(label);
        if (!me) return;
        if (me.edge >= TUNING.TABLE_LEAN_EDGE) actionableRowCount++;
      });
      function roll(rows,n){const s=rows.slice(0,n);return{n,posPnl:s.reduce((a,r)=>a+(r.posPnl||0),0),portPnl:s.reduce((a,r)=>a+(r.u.pnlAll||0),0),shares:s.reduce((a,r)=>a+r.h.amount,0)};}
      const sideKeys=Object.keys(sides),totalTraders=walletList.length;
      function pnlForWin(u,win){return win==='7d'?(u.pnl7d||0):win==='30d'?(u.pnl30d||0):(u.pnlAll||0);}
      function computeTag(u,conc,win){const p=pnlForWin(u,win);return p>5000&&conc>0.1?'smart':(p<-5000?'dumb':'meh');}
      function dot(p){return p>1000?'🟢':p<-1000?'🔴':'⚪';}
      function consistency(u){return dot(u.pnl7d||0)+dot(u.pnl30d||0)+dot(u.pnlAll||0);}
      function passesFilter(r,win,filter){
        if(filter==='smart') return computeTag(r.u,r.conc,win)==='smart';
        if(filter==='nodumb') return computeTag(r.u,r.conc,win)!=='dumb';
        if(filter==='elite') return !!r.elite;
        if(filter==='bookmarked') return !!r.bookmarked;
        if(filter==='nomm') return !r.mm && !r.altMm && !r.volMm;
        if(filter==='sharp') return r.archetype==='sharp';
        if(filter==='insider') return r.archetype==='insider_like';
        if(filter==='lateedge') return r.archetype==='late_edge';
        if(filter==='mmArch') return r.archetype==='market_maker';
        if(filter==='botArch') return r.archetype==='bot';
        if(filter==='chase') return r.archetype==='public_chase';
        if(filter==='publicArch') return r.archetype==='public' || r.archetype==='public_chase';
        if(filter==='hiClv') return (r.u.entryQuality||0)>0.05;
        if(filter==='hi7d') return (r.u.pnl7d||0)>10000;
        if(filter==='hiconc') return r.conc!=null && r.conc>0.15;
        if(filter==='bigport') return (r.u.value||0)>500000;
        return true;
      }
      // v2.12: small share-count cards now show market context for multi-market events so the user
      // can tell which "YES" card belongs to which market. Cards with no signal AND zero combined
      // posPnl are hidden by default (controlled by TUNING.SHOW_ZERO_SIGNAL_CARDS / toggle button).
      let cardsHtml='';
      let zeroSignalCount = 0;
      sideKeys.forEach(k=>{
        const s=sides[k];
        const rows=s.rows;
        const sr = sideRaw[k] || {};
        const pComp = predictions[k] && predictions[k].components || {};
        const totalShares=rows.reduce((s,r)=>s+r.h.amount,0);
        const totalPosPnl=rows.reduce((s,r)=>s+(r.posPnl||0),0);
        const lbl = s.displayLabel||k;
        const cls=lbl.toLowerCase()==='yes'?'y':lbl.toLowerCase()==='no'?'n':'';
        // Multi-market: prepend market question + short conditionId so YES/NO cards aren't ambiguous.
        const cidShort = s.market && s.market.conditionId ? s.market.conditionId.slice(0,6)+'…' : '';
        const mqLine = multiMarketEvent && s.marketQuestion
          ? '<div class=sub style="font-size:10px;margin-bottom:4px;color:#888">'+esc(s.marketQuestion.slice(0,50))+(cidShort?' · <span class=mute>'+cidShort+'</span>':'')+'</div>'
          : '';
        // Hide-condition: no elite, no sharp, no meaningful holderProfit, AND zero posPnl.
        const hpAbs = (pComp.holderProfit != null && !isNaN(pComp.holderProfit)) ? Math.abs(pComp.holderProfit) : 0;
        const hasSignal = (sr.eliteCount||0) > 0 || (sr.sharpCount||0) > 0 || hpAbs > 0.05;
        const isZero = !hasSignal && Math.abs(totalPosPnl) < 1;
        if (isZero) zeroSignalCount++;
        const hideCls = isZero ? ' zeroSignalCard' : '';
        cardsHtml+='<div class="card '+cls+hideCls+'">'+mqLine
          +'<div class=lbl>'+esc(lbl)+' · Top '+topN+' shares</div>'
          +'<div class=val>'+Math.round(totalShares).toLocaleString()+'</div>'
          +'<div class=sub>Combined pos PnL: <span class="'+(totalPosPnl>=0?'pos':'neg')+'">'+fmt(totalPosPnl)+'</span></div></div>';
      });
      cardsHtml+='<div class="card"><div class=lbl>Unique Traders</div><div class=val>'+totalTraders+'</div><div class=sub>In analyzed top holders</div></div>';
      // v2.12: zero-signal toggle button. Only render when at least one card was hidden.
      const zeroSignalBtn = zeroSignalCount > 0
        ? '<button class=showZeroBtn id=showZeroBtn>Show '+zeroSignalCount+' zero/no-signal card'+(zeroSignalCount>1?'s':'')+'</button>'
        : '';
      function rowHtml(r,win){
        const name=r.h.name||r.h.pseudonym||r.h.proxyWallet.slice(0,8);
        const tag=computeTag(r.u,r.conc,win);
        const winPnl=pnlForWin(r.u,win);
        const newFlag=r.isNew?' <span class=warn title="First activity <7d ago">⚠️</span>':'';
        const eliteIcon=r.elite?' 👑':'';
        let mmIcons='';
        if(r.mm) mmIcons+='<span class=mmIcon title="Holds both sides">🔄</span>';
        if(r.altMm) mmIcons+='<span class=mmIcon title="No avg entry · likely MM">🤖</span>';
        if(r.volMm) mmIcons+='<span class=mmIcon title="High volume, flat PnL">💹</span>';
        if(mmIcons) mmIcons=' '+mmIcons;
        const verified=r.h.verified?' ✓':'';
        const starCls=r.bookmarked?'star':'starOff';
        const starGlyph=r.bookmarked?'⭐':'☆';
        const starCell='<td><span class="'+starCls+'" data-bm="'+r.h.proxyWallet+'" title="Bookmark">'+starGlyph+'</span></td>';
        let n24cell;
        if(Math.abs(r.n24pct)>0.05){
          const up=r.n24pct>0;
          const dollars=r.n24*(r.price||0);
          n24cell='<td class="'+(up?'pos':'neg')+'">'+(up?'↑ +':'↓ ')+Math.round(r.n24pct*100)+'% ('+fmtS(dollars)+')</td>';
        } else {
          n24cell='<td class=mute>—</td>';
        }
        const arch = r.archetype || 'neutral';
        const archCls = arch==='neutral'||arch==='—' ? 'dash' : arch.replace('_','');
        const archGlyph = arch==='sharp'?'🎯 sharp'
                       : arch==='insider_like'?'⚡ insider?'
                       : arch==='late_edge'?'⏱ late-edge'
                       : arch==='market_maker'?'🔁 MM'
                       : arch==='bot'?'🤖 bot'
                       : arch==='public_chase'?'📉 chase'
                       : arch==='public'?'📉 public'
                       : '—';
        const confPct = r.archConfidence ? Math.round(r.archConfidence*100) : null;
        const reasonsTitle = (r.archReasons||[]).join(' · ');
        const archCell = '<td><span class="arche '+archCls+'" title="'+esc(reasonsTitle)+'">'+archGlyph+(confPct!=null?' '+confPct+'%':'')+'</span></td>';
        const clvPct = r.u.entryQuality!=null ? Math.round(r.u.entryQuality*100) : null;
        const clvCell = clvPct==null ? '<td class=mute>—</td>' : '<td class="'+(clvPct>0?'pos':clvPct<0?'neg':'mute')+'">'+(clvPct>0?'+':'')+clvPct+'%</td>';
        const lf = r.u.leagueFocus;
        const focusCell = (lf && lf.league) ? '<td>'+esc(lf.league.toUpperCase())+' '+Math.round((lf.pct||0)*100)+'%</td>' : '<td class=mute>—</td>';
        return '<tr><td class=mute>'+r.rank+'</td><td><a target=_blank href="https://polymarket.com/profile/'+r.h.proxyWallet+'">'+esc(name)+eliteIcon+'</a>'+mmIcons+verified+newFlag+'</td><td>'+Math.round(r.h.amount).toLocaleString()+'</td><td>'+(r.avg!=null?(r.avg*100).toFixed(1)+'¢':'-')+'</td><td>'+dur(r.hold)+'</td>'+n24cell+'<td class="'+(r.posPnl>0?'pos':r.posPnl<0?'neg':'mute')+'">'+fmt(r.posPnl)+'</td><td>'+(r.u.value?fmtS(r.u.value):'-')+'</td><td>'+(r.conc!=null?pct(Math.min(r.conc,1)):'-')+'</td><td class="'+(winPnl>0?'pos':winPnl<0?'neg':'mute')+'">'+fmtS(winPnl)+'</td><td>'+consistency(r.u)+'</td>'+archCell+clvCell+focusCell+'<td class="'+tag+'">'+(tag==='smart'?'🟢':tag==='dumb'?'🔴':'⚪')+'</td>'+starCell+'</tr>';
      }
      // Archetype-primary badge summary. Legacy smart/dumb shown as secondary.
      function badgesFor(rows,win){
        let ar={sharp:0, insider_like:0, late_edge:0, market_maker:0, bot:0, public:0, public_chase:0, neutral:0};
        let el=0, bm=0, s=0, du=0, m=0;
        rows.forEach(r=>{
          ar[r.archetype] = (ar[r.archetype]||0) + 1;
          if(r.elite)el++;
          if(r.bookmarked)bm++;
          const t=computeTag(r.u,r.conc,win);
          if(t==='smart')s++;else if(t==='dumb')du++;else m++;
        });
        const primary = '<span class=badges>🎯 '+ar.sharp+' sharp · ⚡ '+ar.insider_like+' insider? · ⏱ '+ar.late_edge+' late-edge · 🔁 '+ar.market_maker+' MM · 🤖 '+ar.bot+' bot · 📉 '+(ar.public+ar.public_chase)+' public · 👑 '+el+' elite · ⭐ '+bm+'★</span>';
        const legacy  = '<span class=badges><span class=ratio>(legacy: '+s+' smart / '+du+' dumb / '+m+' neutral)</span></span>';
        return primary+'<br>'+legacy;
      }
      const winLabel={all:'All-Time','30d':'30d','7d':'7d'};
      function tableHtml(label,cls,win,filter){
        const {rows,price}=sides[label];
        const filtered=rows.filter(r=>passesFilter(r,win,filter));
        const head='<tr><th>#</th><th>Trader</th><th>Shares</th><th>Entry</th><th>Hold</th><th>24h Δ</th><th>Pos PnL</th><th>Port</th><th>%/Port</th><th>'+(winLabel[win]||'All-Time')+'</th><th>Consistency</th><th>Archetype</th><th>CLV%</th><th>Focus</th><th>Sig</th><th>⭐</th></tr>';
        const body=filtered.map(r=>rowHtml(r,win)).join('');
        const sel='<select class=sidefilter data-side="'+esc(label)+'">'
          +'<option value=all'+(filter==='all'?' selected':'')+'>All holders</option>'
          +'<option value=elite'+(filter==='elite'?' selected':'')+'>Elite only</option>'
          +'<option value=sharp'+(filter==='sharp'?' selected':'')+'>🎯 Sharp only</option>'
          +'<option value=insider'+(filter==='insider'?' selected':'')+'>⚡ Insider? only</option>'
          +'<option value=lateedge'+(filter==='lateedge'?' selected':'')+'>⏱ Late-edge only</option>'
          +'<option value=mmArch'+(filter==='mmArch'?' selected':'')+'>🔁 MM (archetype) only</option>'
          +'<option value=botArch'+(filter==='botArch'?' selected':'')+'>🤖 Bots only</option>'
          +'<option value=chase'+(filter==='chase'?' selected':'')+'>📉 Public-chase only</option>'
          +'<option value=publicArch'+(filter==='publicArch'?' selected':'')+'>📉 Public (any) only</option>'
          +'<option value=hiClv'+(filter==='hiClv'?' selected':'')+'>Has CLV &gt;5%</option>'
          +'<option value=bookmarked'+(filter==='bookmarked'?' selected':'')+'>Bookmarked only</option>'
          +'<option value=smart'+(filter==='smart'?' selected':'')+'>(legacy) Smart only</option>'
          +'<option value=nodumb'+(filter==='nodumb'?' selected':'')+'>(legacy) Hide dumb</option>'
          +'<option value=nomm'+(filter==='nomm'?' selected':'')+'>(legacy) Hide MM tells</option>'
          +'<option value=hi7d'+(filter==='hi7d'?' selected':'')+'>High weekly PnL (&gt;$10k 7d)</option>'
          +'<option value=hiconc'+(filter==='hiconc'?' selected':'')+'>High concentration (&gt;15%)</option>'
          +'<option value=bigport'+(filter==='bigport'?' selected':'')+'>Large portfolio (&gt;$500k)</option>'
          +'</select>';
        // Prediction box in panel header
        const p = predictions[label];
        let predBox = '';
        if (p) {
          const prob = Math.round(p.probability*100);
          const conf = Math.round(p.confidence*100);
          predBox = '<span class=predBox><span class=big>Pred '+prob+'%</span><span class=conf>conf '+conf+'%</span></span>';
        }
        // Explainability: expandable component breakdown
        let predDetails = '';
        if (p) {
          const c = p.components;
          // v2.11.2: guard both v (NaN) and w (undefined for diagnostic-only components like
          // publicTrap that aren't in TUNING.WEIGHTS). Diag rows render with a "(diag)" tag
          // instead of a fake "× 0.00" multiplier so the breakdown is honest about zero weight.
          const f = (v,w) => {
            if (v == null || isNaN(v)) return '<span class=mute>skipped</span>';
            const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'mute';
            const val = '<span class="'+cls+'">'+(v>0?'+':'')+v.toFixed(3)+'</span>';
            return (w == null || isNaN(w)) ? val + ' <span class=mute>(diag)</span>' : val + ' × ' + w.toFixed(2);
          };
          const row = (k,name)=>'<div class=comp><b>'+name+'</b><span>'+f(c[k], TUNING.WEIGHTS[k])+'</span></div>';
          predDetails = '<details class=predDetails><summary>Score breakdown (score '+p.score.toFixed(3)+' → '+Math.round(p.probability*100)+'% · conf '+Math.round(p.confidence*100)+'%)</summary>'
            + row('sharpEdge','SharpEdge')
            + row('walletEdge','WalletEdge')
            + row('flow24h','Flow24h')
            + row('clv','CLV (true)')
            + row('consistency','Consistency')
            + row('exit','ExitSignal')
            + row('insiderTiming','InsiderTiming')
            + row('bookTilt','BookTilt')
            + row('contrarian','Contrarian')
            + row('holderProfit','HolderProfit')
            + row('eliteEdge','EliteEdge')
            + row('publicTrap','PublicTrap (diag)')
            + '</details>';
        }
        // v2.25 Phase 2 Part 1: CLV tracking display (display-only, no scoring impact).
        // Reads the side's clvBySide[label] bundle populated in the post-enrichment pass.
        // Independent of `p` — renders whenever any reference price was available for the
        // side. Bucket counts in the row label help interpret a missing bucket (e.g. "Elite (0)"
        // → no elite wallets on this side, so eliteWeightedCLV is null and shows "—").
        let clvDetails = '';
        const clvForSide = clvBySide[label];
        if (clvForSide) {
          const fmtClv = v => {
            if (v == null || isNaN(v)) return '<span class=mute>—</span>';
            const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'mute';
            return '<span class="'+cls+'">'+(v>0?'+':'')+(v*100).toFixed(2)+'¢</span>';
          };
          const clvRow = (k, name) => '<div class=comp><b>'+name+'</b><span>'+fmtClv(clvForSide[k])+'</span></div>';
          clvDetails = '<details class=clvDetails><summary>CLV tracking · ref '
            + (clvForSide.referencePrice*100).toFixed(1) + '¢ · '
            + clvForSide.walletCount + ' wallet' + (clvForSide.walletCount===1?'':'s')
            + ' (display + log only, no scoring impact)</summary>'
            + clvRow('sideWeightedCLV',   'Side CLV')
            + clvRow('eliteWeightedCLV',  'Elite CLV ('+clvForSide.eliteWalletCount+')')
            + clvRow('publicWeightedCLV', 'Public CLV ('+clvForSide.publicWalletCount+')')
            + clvRow('clvSpread',         'CLV Spread (elite − public)')
            + '</details>';
        }
        // v2.26 Phase 2 Part 2: Wallet specialization display (display + log only). Reads the
        // side's specializationBySide[label] bundle populated in the post-enrichment pass.
        // Renders a sibling <details> block next to clvDetails. NULL bucket scores render as
        // "—" (no scored wallets in that bucket). The Top 5 list is sorted score-desc and shows
        // short-form addr + score badge + samples + avgCLV + +CLV rate. Compact, research-only.
        let specializationDetails = '';
        const specForSide = specializationBySide[label];
        if (specForSide) {
          const fmtScore = v => v == null ? '<span class=mute>—</span>'
            : '<span class="'+(v >= 75 ? 'pos' : v < 55 ? 'neg' : 'mute')+'">'+v.toFixed(1)+'</span>';
          const labelBadge = lbl => !lbl ? '' : ' <span class=arche '+(lbl==='strong'?'sharp':lbl==='useful'?'neutral':'public')+' style="font-size:10px">'+lbl+'</span>';
          const topRows = specForSide.topWallets.map(w =>
              '<div class=comp><b>'+esc(w.wallet.slice(0,6)+'…'+w.wallet.slice(-4))+'</b>'
            + '<span>'+w.score.toFixed(1)+labelBadge(w.label)
            + ' · n='+w.samples
            + ' · CLV '+((w.avgCLV||0)*100).toFixed(2)+'¢'
            + ' · +CLV '+((w.positiveCLVRate||0)*100).toFixed(0)+'%'
            + '</span></div>').join('');
          specializationDetails = '<details class=specializationDetails><summary>Wallet specialization · '
            + esc(specForSide.marketType) + ' · '
            + specForSide.scoredWallets + ' scored · '
            + specForSide.lowSampleWallets + ' low-sample'
            + ' (display + log only, no scoring impact)</summary>'
            + '<div class=comp><b>Side Spec Score</b><span>'   + fmtScore(specForSide.sideSpecializationScore)   + '</span></div>'
            + '<div class=comp><b>Elite Spec Score</b><span>'  + fmtScore(specForSide.eliteSpecializationScore)  + '</span></div>'
            + '<div class=comp><b>Public Spec Score</b><span>' + fmtScore(specForSide.publicSpecializationScore) + '</span></div>'
            + (topRows ? '<div style="margin-top:4px;padding-top:4px;border-top:1px solid #222"><b style="font-size:11px;color:#888">Top 5 specialized wallets</b></div>'+topRows : '')
            + '</details>';
        }
        // v2.27 Phase 2 Part 3: Entry / Exit Pressure block. Display + log only — reads
        // accumulationBySide[label] populated in the v2.25/v2.26 side-loop. Pressure label
        // drives summary color (ACCUMULATING=pos / DISTRIBUTING=neg / others=mute); $ nets
        // color by sign. Compact research-only panel; never used by scoring.
        let pressureDetails = '';
        const pressureForSide = accumulationBySide[label];
        if (pressureForSide) {
          const labelCls = pressureForSide.pressureLabel === 'ACCUMULATING' ? 'pos'
                         : pressureForSide.pressureLabel === 'DISTRIBUTING' ? 'neg'
                         : 'mute';
          // v2.28.1: negative-net rendering now reads "-$1,500" instead of "$-1,500".
          const fmt$ = v => {
            if (v == null) return '<span class=mute>—</span>';
            const cls  = v > 0 ? 'pos' : v < 0 ? 'neg' : 'mute';
            const sign = v < 0 ? '-' : '';
            return '<span class="'+cls+'">'+sign+'$'+Math.abs(Math.round(v)).toLocaleString()+'</span>';
          };
          const fmtRatio = v => v == null ? '<span class=mute>—</span>' : v.toFixed(2);
          const yesno = b => b ? '<span class=pos>YES</span>' : '<span class=mute>no</span>';
          pressureDetails = '<details class=pressureDetails><summary>Entry / Exit Pressure · '
            + '<span class="'+labelCls+'">'+esc(pressureForSide.pressureLabel)+'</span>'
            + ' (display + log only, no scoring impact)</summary>'
            + '<div class=comp><b>Smart Net</b><span>'             + fmt$(pressureForSide.smartNetNotional)     + '</span></div>'
            + '<div class=comp><b>Elite Net</b><span>'             + fmt$(pressureForSide.eliteNetNotional)     + '</span></div>'
            + '<div class=comp><b>Sharp Net</b><span>'             + fmt$(pressureForSide.sharpNetNotional)     + '</span></div>'
            + '<div class=comp><b>Public Net</b><span>'            + fmt$(pressureForSide.publicNetNotional)    + '</span></div>'
            + '<div class=comp><b>Smart Buy/Sell Ratio</b><span>'  + fmtRatio(pressureForSide.smartBuySellRatio)+ '</span></div>'
            + '<div class=comp><b>Distribution Pressure</b><span>' + yesno(pressureForSide.distributionPressure)+ '</span></div>'
            + '<div class=comp><b>Accumulation Pressure</b><span>' + yesno(pressureForSide.accumulationPressure)+ '</span></div>'
            + '<div class=comp><b>Hidden Accumulation</b><span>'   + yesno(pressureForSide.hiddenAccumulation)  + '</span></div>'
            + '<div class=comp><b>Smart Still Adding</b><span>'    + yesno(pressureForSide.smartMoneyStillAdding)+'</span></div>'
            + '<div class=comp><b>Smart Dumping</b><span>'         + yesno(pressureForSide.smartMoneyDumping)   + '</span></div>'
            + '<div class=comp><b>Reason</b><span class=mute style="font-size:11px">'+esc(pressureForSide.pressureReason)+'</span></div>'
            + '</details>';
        }
        // Multi-market subtitle + post-settlement note
        const sd = sides[label];
        // v2.29.0: displayLabel stays raw (used for winner-equality checks); displayTitle is
        // the human-facing string we render in the panel header.
        const displayLabel = sd.displayLabel || label;
        const displayTitle = sd.displaySide || displayLabel;
        const subtitle = multiMarketEvent && sd.marketQuestion ? '<div class=panelSubtitle>'+esc(sd.marketQuestion.slice(0,80))+(sd.resolved&&sd.winner?' · <span class=arche '+(sd.winner===displayLabel?'sharp':'public')+' style="font-size:10px">'+(sd.winner===displayLabel?'✓ won':'lost')+'</span>':'')+'</div>' : (sd.resolved&&sd.winner?'<div class=panelSubtitle><span class=arche '+(sd.winner===displayLabel?'sharp':'public')+' style="font-size:10px">'+(sd.winner===displayLabel?'✓ SETTLED — won':'SETTLED — lost')+'</span></div>':'');
        const settleNote = sd.resolved && rows.length>0 && rows.length < topN*0.2
          ? ' <span class=settleNote>(post-settlement, '+rows.length+' holder'+(rows.length>1?'s':'')+' remaining)</span>'
          : '';
        return '<div class=panel data-panel="'+esc(label)+'"><div class="ptitle '+cls+'"><span>'+esc(displayTitle)+' Holders'+settleNote+predBox+subtitle+'</span><span class=right>'+badgesFor(rows,win)+'<span>'+(price*100).toFixed(0)+'¢ · '+filtered.length+'/'+rows.length+'</span>'+sel+'</span></div>'+predDetails+clvDetails+specializationDetails+pressureDetails+'<div class=tblwrap><table><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div></div>';
      }
      function rollupTable(){
        const anyResolvedInEvent = markets.some(r=>isResolved(r.m));
        const predTitle = anyResolvedInEvent
          ? 'Prediction — per-side score <span class=mute style="font-weight:400;font-size:11px">(retrospective — market settled)</span>'
          : 'Prediction — per-side score <span class=mute style="font-weight:400;font-size:11px">(softmax within market)</span>';
        // v2.21: stable id on outer container so the click handler can re-render in place.
        // Sort button label reflects the CURRENT sort direction so the user knows what
        // toggling will switch to.
        const sortLabel = state.predSort === 'edge' ? 'Sort: Edge ↓' : 'Sort: Score ↓';
        let h='<div class=rollup id=rollupContainer><h2>'+predTitle+' <button class=sortBtn id=predSortBtn type=button>'+sortLabel+'</button></h2><table><thead><tr>'+(multiMarketEvent?'<th>Market</th>':'')+'<th>Side</th><th>Pred</th><th>Cost</th><th>Edge</th><th>Conf</th><th>Score</th><th>SharpEdge</th><th>WalletEdge</th><th>Flow24h</th><th>CLV</th><th>Consistency</th><th>Exit</th><th>Insider</th><th>Book</th><th>Contrarian</th><th>HolderProfit</th><th>EliteEdge</th><th>PublicTrap</th><th>Tail</th><th>Entry</th><th>Current</th><th>Fair</th><th>Ext</th><th>Reason</th></tr></thead><tbody>';
        // v1.8: sort by score desc; dedupe to favored side on live markets; keep both sides on resolved (retrospective clarity).
        // v2.21: optional sort by mktEdge desc (state.predSort === 'edge'). marketEdgeFor is pure
        // and cheap so computing it once per row in the sort comparator is fine. Nulls (no edge
        // data) sort to the bottom via a -Infinity sentinel.
        const edgeOf = (k) => {
          const me = marketEdgeFor(k);
          return (me && me.edge != null) ? me.edge : -Infinity;
        };
        const predRows = sideKeys
          .map(k => ({k, p: predictions[k], s: sides[k]}))
          .filter(x => x.p && x.s)
          .filter(x => x.s.resolved ? true : x.p.probability >= 0.5)
          .sort((a,b) => state.predSort === 'edge'
            ? (edgeOf(b.k) - edgeOf(a.k))
            : (b.p.score - a.p.score));
        // v2.2: classify row by actionability and hide non-actionable by default (with expand toggle).
        let hiddenCount = 0;
        predRows.forEach(({k, p, s})=>{
          // v2.29.0: lbl is what the human reads (e.g. "Under 4.5"); cls is derived from
          // rawSide so pure Yes/No markets keep their pos/neg color. O/U markets fall
          // through to '' — intentional, color expansion is out of scope this patch.
          const lbl = s.displaySide || s.displayLabel || k;
          const rawLc = String(s.rawSide || s.displayLabel || k).toLowerCase();
          const cls=rawLc==='yes'?'pos':rawLc==='no'?'neg':'';
          const c=p.components;
          const fv=v=>v==null?'<span class=mute>—</span>':'<span class="'+(v>0?'pos':v<0?'neg':'mute')+'">'+(v>0?'+':'')+v.toFixed(2)+'</span>';
          const marketCell = multiMarketEvent?'<td class=mute>'+esc((s.marketQuestion||'').slice(0,50))+'</td>':'';
          // v2.29.0: s.winner is the raw Polymarket outcome string; compare against the raw
          // label, not the human-facing lbl (which may be "Under 4.5").
          const rawLbl = s.displayLabel || k;
          const wonBadge = (s.resolved && s.winner===rawLbl) ? ' <span class="arche sharp">✓ won</span>' : (s.resolved&&s.winner?' <span class="arche public">lost</span>':'');
          // v2.34.0: rollup-table grade badge in the Side cell. Pulls from precomputed
          // gradesBySide so dashboard, banner, and bot export all agree. Hover surfaces
          // the downgrade reasons so users can audit why a row missed A+.
          const _gradeEntry = gradesBySide[k] || null;
          const _gradeStr   = _gradeEntry ? _gradeEntry.grade : null;
          const _gradeCls   = _gradeStr === 'A+' ? 'gradeAPlus'
                            : _gradeStr === 'A'  ? 'gradeA'
                            : _gradeStr === 'B'  ? 'gradeB'
                            : _gradeStr === 'C'  ? 'gradeC'
                            : 'gradePass';
          const _gradeTitle = (_gradeEntry && _gradeEntry.reasons && _gradeEntry.reasons.length)
                              ? _gradeEntry.reasons.join(' · ') : '';
          const gradeBadge = _gradeStr
            ? ' <span class="gradeBadge '+_gradeCls+'" title="'+esc(_gradeTitle)+'">'+esc(_gradeStr)+'</span>'
            : '';
          const me = marketEdgeFor(k);
          const mktEdge = me ? me.edge : null;
          const costPct = me ? Math.round(me.effectiveCost*100) : null;
          const edgeCell = mktEdge==null ? '<td class=mute>—</td>'
                         : '<td class="'+(mktEdge>0?'pos':'neg')+'">'+(mktEdge>0?'+':'')+Math.round(mktEdge*100)+'pp</td>';
          const costCell = costPct==null ? '<td class=mute>—</td>' : '<td>'+costPct+'¢</td>';
          // v2.2 row classification
          let rowType = 'rowPass';
          if (s.resolved) rowType = 'rowSettled';
          else if (mktEdge == null) rowType = 'rowNoData';
          else if (mktEdge >= TUNING.TABLE_BET_EDGE && p.confidence >= 0.50) rowType = 'rowBet';
          else if (mktEdge >= TUNING.TABLE_LEAN_EDGE) rowType = 'rowLean';
          else if (mktEdge <= TUNING.TABLE_FADE_EDGE) rowType = 'rowFade';
          const actionable = rowType === 'rowBet' || rowType === 'rowLean' || rowType === 'rowSettled';
          if (!actionable) hiddenCount++;
          const rowCls = ' class="'+rowType+(actionable ? '' : ' hiddenByDefault')+'"';
          // v2.12: tail diagnostics row cells (execution layer only).
          const tail = tailBySide[k];
          const tCell  = tail ? '<td>'+tail.tailScore+'</td>' : '<td class=mute>n/a</td>';
          const teCell = (tail && tail.eliteAvgEntry != null) ? '<td>'+(tail.eliteAvgEntry*100).toFixed(0)+'¢</td>' : '<td class=mute>—</td>';
          const tcCell = (tail && tail.currentPrice  != null) ? '<td>'+(tail.currentPrice *100).toFixed(0)+'¢</td>' : '<td class=mute>—</td>';
          const tfCell = (tail && tail.fairValue     != null) ? '<td>'+(tail.fairValue    *100).toFixed(0)+'¢</td>' : '<td class=mute>—</td>';
          const txCell = (tail && tail.extensionRatio != null) ? '<td>'+(tail.extensionRatio*100).toFixed(0)+'%</td>' : '<td class=mute>—</td>';
          const trCell = tail ? '<td style="text-align:left;max-width:340px;white-space:normal;color:#888;font-size:11px">'+esc(tail.reason||'')+'</td>' : '<td class=mute>—</td>';
          h+='<tr'+rowCls+'>'+marketCell+'<td class="'+cls+'">'+esc(lbl)+gradeBadge+wonBadge+'</td><td>'+Math.round(p.probability*100)+'%</td>'+costCell+edgeCell+'<td>'+Math.round(p.confidence*100)+'%</td><td>'+p.score.toFixed(3)+'</td><td>'+fv(c.sharpEdge)+'</td><td>'+fv(c.walletEdge)+'</td><td>'+fv(c.flow24h)+'</td><td>'+fv(c.clv)+'</td><td>'+fv(c.consistency)+'</td><td>'+fv(c.exit)+'</td><td>'+fv(c.insiderTiming)+'</td><td>'+fv(c.bookTilt)+'</td><td>'+fv(c.contrarian)+'</td><td>'+fv(c.holderProfit)+'</td><td>'+fv(c.eliteEdge)+'</td><td>'+fv(c.publicTrap)+'</td>'+tCell+teCell+tcCell+tfCell+txCell+trCell+'</tr>';
        });
        if (hiddenCount > 0) {
          const colspan = 21 + (multiMarketEvent?1:0);  // v2.12: +6 cols for tail (Tail/Entry/Current/Fair/Ext/Reason)
          h += '<tr class=rowToggle><td colspan="'+colspan+'" style="text-align:center"><button class=showHidden>Show '+hiddenCount+' no-edge row'+(hiddenCount>1?'s':'')+' (PASS / FADE)</button></td></tr>';
        }
        h+='</tbody></table><h2 style="margin-top:16px">Rollup — combined PnL by top N holders</h2><table><thead><tr>'+(multiMarketEvent?'<th>Market</th>':'')+'<th>Side</th><th>Top N</th><th>Shares</th><th>Position PnL</th><th>All-Time Portfolio PnL (sum)</th></tr></thead><tbody>';
        sideKeys.forEach(k=>{
          const s=sides[k];
          // v2.29.0: render displaySide; color class still keyed on rawSide.
          const lbl = s.displaySide || s.displayLabel || k;
          const rawLc = String(s.rawSide || s.displayLabel || k).toLowerCase();
          const cls=rawLc==='yes'?'pos':rawLc==='no'?'neg':'';
          const marketCell = multiMarketEvent?'<td class=mute>'+esc((s.marketQuestion||'').slice(0,50))+'</td>':'';
          [10,25,50,100].forEach(n=>{
            const r=roll(s.rows,n);
            h+='<tr>'+marketCell+'<td class="'+cls+'">'+esc(lbl)+'</td><td>Top '+n+'</td><td>'+Math.round(r.shares).toLocaleString()+'</td><td class="'+(r.posPnl>=0?'pos':'neg')+'">'+fmt(r.posPnl)+'</td><td class="'+(r.portPnl>=0?'pos':'neg')+'">'+fmt(r.portPnl)+'</td></tr>';
          });
        });
        h+='</tbody></table></div>';return h;
      }
      const rankedSides=sideKeys
        .map(k=>({k,shares:sides[k].rows.reduce((s,r)=>s+r.h.amount,0)}))
        .sort((a,b)=>b.shares-a.shares)
        .map(x=>x.k);
      const sideClasses={};
      sideKeys.forEach(k=>{
        const lbl = (sides[k].displayLabel||k).toLowerCase();
        if(lbl==='yes') sideClasses[k]='y';
        else if(lbl==='no') sideClasses[k]='n';
      });
      const renderedSides=rankedSides;
      // v2.21: predSort toggles the prediction-table ordering between 'score' (default —
      // model-confidence-first) and 'edge' (best market mispricing first, nulls/PASS at bottom).
      const state={win:'all',filter:{},predSort:'score'};
      renderedSides.forEach(k=>{state.filter[k]='all';});
      const toolbar='<div class=toolbar><div class=tabs>'
        +'<button class="tab active" data-win="all">All-Time</button>'
        +'<button class=tab data-win="30d">30 Days</button>'
        +'<button class=tab data-win="7d">7 Days</button>'
        +'</div><div class=toolbarRight><span id=selfmon class=selfmon></span><select class=topn>'
        +'<option value=50'+(topN===50?' selected':'')+'>Fast (Top 50)</option>'
        +'<option value=100'+(topN===100?' selected':'')+'>Standard (Top 100)</option>'
        +'<option value=200'+(topN===200?' selected':'')+'>Deep (Top 200)</option>'
        +'</select></div></div>';
      function gridHtml(){
        return renderedSides.map(k=>tableHtml(k,sideClasses[k],state.win,state.filter[k])).join('');
      }
      const streakPh='<details class=streakPanel id=streak style="display:none"></details>';
      const exitsPh='<details class=exitsPanel id=exits style="display:none"></details>';
      const ioBtns='<div class=ioBtns><button class=ioBtn id=bmExport>Export bookmarks</button><button class=ioBtn id=bmImport>Import bookmarks</button><input type=file accept=".json" id=bmImportFile style="display:none"></div>';
      const warnBadge = failedMarkets.length ? '<div class=warnBadge>⚠ '+failedMarkets.length+' market(s) failed to load after retry · '+esc(failedMarkets.map(f=>(f.question||f.conditionId.slice(0,10))+' ('+(f.status||'?')+')').join(' · ').slice(0,500))+'</div>' : '';
      // Settlement banner: fires when any market in the event is resolved.
      const resolvedSurviving = markets.filter(r=>isResolved(r.m));
      let resolvedBanner = '';
      if (resolvedSurviving.length > 0) {
        const outcomesList = resolvedSurviving.map(r=>{
          const w = winnerOf(r.m, r.outcomes);
          return esc((r.m.question || r.m.conditionId.slice(0,10)) + (w ? ' — ' + w + ' won' : ' — winner unknown'));
        }).join(' · ');
        const allResolved = resolvedSurviving.length === markets.length;
        resolvedBanner = '<div class=resolvedBanner><div class=title>✅ '+(allResolved?'SETTLED':resolvedSurviving.length+'/'+markets.length+' MARKETS SETTLED')+'</div><div class=outcomes>'+outcomesList+'</div><div class=sub>Live signals (24h flow, exits, insider timing) are near-zero on settled markets. Per-wallet posPnl backfilled from activity realizedPnl. Predictor below is retrospective.</div></div>';
      }
      // Cross-market consistency panel (Prompt A). Runs once on ev.markets using outcomePrices.
      const consCheck = checkConsistency(ev);
      let consistencyPanel = '';
      if (consCheck.subs.length >= 2) {
        const errCount = consCheck.findings.filter(f=>f.severity==='error').length;
        const infoCount = consCheck.findings.filter(f=>f.severity==='info').length;
        const findingsHtml = consCheck.findings.length
          ? consCheck.findings.map(f=>'<li class="'+(f.severity==='error'?'err':'info')+'">'+(f.severity==='error'?'⚠️ ':'ℹ️ ')+esc(f.message)+'</li>').join('')
          : '<li class=ok>No violations detected across '+consCheck.subs.length+' sub-markets (heuristic check; some real violations may be missed)</li>';
        const rows = consCheck.subs.map(x=>{
          const p = x.pYes!=null ? Math.round(x.pYes*100)+'¢' : '—';
          const kind = x.spreadVal!=null ? '−'+x.spreadVal+' handicap'
                     : (x.totalKind ? x.totalKind+' '+x.totalLine : 'moneyline/other');
          return '<tr><td>'+esc(x.q.slice(0,70))+'</td><td>'+p+'</td><td>'+(x.team?esc(x.team):'<span class=mute>—</span>')+'</td><td>'+kind+'</td></tr>';
        }).join('');
        const summaryText = errCount>0
          ? '⚖️ Cross-market consistency — <span class=err>'+errCount+' violation'+(errCount>1?'s':'')+'</span>'+(infoCount>0?' · '+infoCount+' notes':'')
          : '⚖️ Cross-market consistency — no violations'+(infoCount>0?' · '+infoCount+' notes':'');
        consistencyPanel = '<details class=consistencyPanel'+(errCount>0?' open':'')+'><summary>'+summaryText+'</summary><ul class=findings>'+findingsHtml+'</ul><div class=tblwrap><table><thead><tr><th>Market</th><th>P(Yes)</th><th>Team</th><th>Kind</th></tr></thead><tbody>'+rows+'</tbody></table></div></details>';
      }
      // Top Picks strip (v1.9): surfaces the 2-3 highest-ranked favored sides.
      const COMP_LABEL = {sharpEdge:'SharpEdge',flow24h:'Flow24h',walletEdge:'WalletEdge',clv:'CLV',consistency:'Consistency',exit:'Exit',insiderTiming:'Insider',bookTilt:'Book',contrarian:'Contrarian',holderProfit:'HolderProfit',eliteEdge:'EliteEdge',publicTrap:'PublicTrap'};
      let topPicksHtml = '';
      if (topPicks.length === 0) {
        topPicksHtml = '<div class=topPicks><div class="pickCard empty">No actionable edges in this event — model prob doesn\'t exceed market ask+fee on any side above the '+(TUNING.TOP_PICKS_MIN_EDGE_CONF*100).toFixed(0)+'% edge×conf floor or $'+(TUNING.TOP_PICKS_MIN_NOTIONAL/1000).toFixed(0)+'k liquidity gate</div></div>';
      } else {
        const cards = topPicks.map((tp, i) => {
          // v2.29.0: human-facing card header — use displaySide (e.g. "Under 4.5"); fall back
          // to raw displayLabel / tp.label for non-O/U markets and back-compat.
          const label = (tp.s && tp.s.displaySide) || (tp.s && tp.s.displayLabel) || tp.label;
          const prob = Math.round(tp.p.probability*100);
          const conf = Math.round(tp.p.confidence*100);
          const edgePp = Math.round(tp.edge*100);
          const costC = Math.round(tp.effectiveCost*100);
          const marginal = tp.rank < 0.3 ? ' marginal' : '';
          const why = tp.contribs.map(c => (COMP_LABEL[c.k]||c.k)+' '+(c.v>0?'+':'')+c.v.toFixed(2)).join(' · ');
          const liqStr = tp.liq >= 1e6 ? '$'+(tp.liq/1e6).toFixed(1)+'M' : '$'+Math.round(tp.liq/1000)+'k';
          // v2.7: confidence-scaled Kelly. f* = confidence × edge / (1 − effectiveCost).
          // Rationale: confidence already gates actionability (top-pick gate is
          // edge × confidence ≥ TUNING.TOP_PICKS_MIN_EDGE_CONF, default 0.08) and ranks picks;
          // it should scale STAKE too, so a 55%-confidence edge sizes smaller than a 90%-confidence
          // edge of the same size. Still multiplied by TOP_PICKS_KELLY_MULT (quarter-Kelly) and
          // clamped at 10% of bankroll as a hard ceiling for sanity.
          // v2.7.1: confidence is INTENTIONALLY used in two places — the actionability gate
          // (TOP_PICKS_MIN_EDGE_CONF, edge × confidence ≥ 0.08) filters out low-conviction
          // edges entirely, and the Kelly multiplier here sizes survivors proportionally to
          // confidence. They are complementary, not duplicative. Don't merge them — removing
          // either silently doubles stake on marginal edges or admits noise to the top picks.
          const confScale = tp.p && tp.p.confidence != null ? tp.p.confidence : 0;
          const fullKelly = (tp.effectiveCost > 0 && tp.effectiveCost < 1) ? confScale * tp.edge / (1 - tp.effectiveCost) : 0;
          const kelly = Math.max(0, Math.min(0.10, fullKelly * TUNING.TOP_PICKS_KELLY_MULT));
          const kellyStr = (kelly*100).toFixed(1)+'%';
          // v2.1: comment-scan news alerts for this market
          const cidAlerts = alertsByCid[tp.s.market.conditionId];
          const alertBadge = cidAlerts ? '<div class=newsAlert>📢 '+cidAlerts.total+' news mention'+(cidAlerts.total>1?'s':'')+' in comments ('+Object.keys(cidAlerts.hits).slice(0,3).join(', ')+')</div>' : '';
          // v2.12: Tail Winners block — execution-layer info, not part of model score.
          let tailHtml = '';
          if (tp.tail) {
            const t = tp.tail;
            const flagCls = t.stillTailPrice === 'YES' ? 'yes' : t.stillTailPrice === 'MAYBE' ? 'maybe' : 'no';
            const entryStr = t.eliteAvgEntry != null ? (t.eliteAvgEntry*100).toFixed(0)+'¢' : '—';
            const curStr   = t.currentPrice  != null ? (t.currentPrice *100).toFixed(0)+'¢' : '—';
            const fairStr  = t.fairValue     != null ? (t.fairValue    *100).toFixed(0)+'¢' : '—';
            const extStr   = t.extensionRatio != null ? (t.extensionRatio*100).toFixed(0)+'%' : '—';
            tailHtml = '<div class=tailBlock>'
              +'<div class=tailHdr><b>Tail Winners: '+t.tailScore+'/100</b><span class="tailFlag '+flagCls+'">Still tail-able: '+t.stillTailPrice+'</span></div>'
              +'<div class=tailMeta>Elite Avg Entry <b>'+entryStr+'</b> → Current <b>'+curStr+'</b> · Fair Value <b>'+fairStr+'</b> · Extension <b>'+extStr+'</b></div>'
              +'<div class=tailReason>'+esc(t.reason||'')+'</div>'
            +'</div>';
          } else {
            tailHtml = '<div class=tailNa>Tail: n/a (no elite cohort detected — using legacy ranking)</div>';
          }
          return '<div class="pickCard'+marginal+'">'
            +'<div class=pick>#'+(i+1)+' · BET '+esc(label.toUpperCase())+'</div>'
            +'<div class=mkt>'+esc((tp.s.marketQuestion||'').slice(0,80))+'</div>'
            +alertBadge
            +'<div class=stats>'
              +'<div><span>Prob</span><b>'+prob+'%</b></div>'
              +'<div><span>Cost</span><b>'+costC+'¢</b></div>'
              +'<div><span>Edge</span><b>+'+edgePp+'pp</b></div>'
              +'<div><span>Conf</span><b>'+conf+'%</b></div>'
              +'<div><span>¼Kelly</span><b>'+kellyStr+'</b></div>'
              +'<div><span>Liq</span><b>'+liqStr+'</b></div>'
            +'</div>'
            +tailHtml
            +'<div class=why>Why: '+esc(why)+'</div>'
          +'</div>';
        }).join('');
        topPicksHtml = '<h2 class=topPicksHdr>🎯 Top Picks — model prob vs market ask+fee, weighted by confidence and liquidity</h2><div class=topPicks>'+cards+'</div>';
      }
      // v2.2 Decision Summary: first thing on page, green if picks exist, grey otherwise.
      // Carries the "should I bet?" answer so user doesn't have to scan the dashboard.
      let decisionSummary = '';
      {
        // v2.34.0: EVENT DECISION banner is now grade-aware. The headline switches between
        // ACTION (A+/A picks), WATCH (only B picks), or PASS (no picks). The old "N actionable
        // bets" count over-spotlighted thin-liquidity LEANs — grade lets us separate
        // high-conviction picks from "show in the rollup but don't headline" picks.
        const has = topPicks.length > 0;
        const highConviction = topPicks.filter(tp => tp && (tp.grade === 'A+' || tp.grade === 'A'));
        const watchOnly      = topPicks.filter(tp => tp && tp.grade === 'B');
        const hcCount = highConviction.length;
        const cls = hcCount > 0 ? 'decisionSummary ok'
                  : has        ? 'decisionSummary watch'
                  : 'decisionSummary pass';
        let heading;
        if (hcCount > 0) {
          const aPlus = highConviction.filter(tp => tp.grade === 'A+').length;
          const aOnly = hcCount - aPlus;
          const parts = [];
          if (aPlus) parts.push('<b>'+aPlus+' A+ bet'+(aPlus>1?'s':'')+'</b>');
          if (aOnly) parts.push('<b>'+aOnly+' A bet'+(aOnly>1?'s':'')+'</b>');
          heading = '🎯 ACTION: '+parts.join(' + ')+' on this event';
        } else if (has) {
          heading = '👀 WATCH: <b>'+watchOnly.length+' B-grade pick'+(watchOnly.length>1?'s':'')+'</b> — see rollup for context';
        } else {
          heading = '⚡ <b>No actionable bets</b> on this event';
        }
        let subline = '';
        if (analyzedLiveMarkets > 0) {
          subline = analyzedLiveMarkets+' live market'+(analyzedLiveMarkets>1?'s':'')+' analyzed';
          if (!has) subline += ' — market agrees with the model, nothing worth the fee';
          else if (hcCount === 0 && watchOnly.length > 0) subline += ' — no A/A+ conviction this scan';
        }
        // v2.34.0: high-conviction pick list — compact one-line summary per A+/A pick.
        // Surfaces side, grade, edge, model prob so the reader can act without scrolling
        // to the Top Picks cards. Reasons array is shown as a tooltip on hover.
        let hcLines = '';
        if (highConviction.length) {
          hcLines = '<div class=hcPicks>' + highConviction.map(tp => {
            const tpLabel = (tp.s && tp.s.displaySide) || (tp.s && tp.s.displayLabel) || tp.label || '?';
            const mq = (tp.s && tp.s.marketQuestion) || '';
            const edgePp = tp.edge != null ? ((tp.edge*100).toFixed(1)+'pp') : '—';
            const probPp = (tp.p && tp.p.probability != null) ? Math.round(tp.p.probability*100)+'%' : '—';
            const costC  = tp.effectiveCost != null ? Math.round(tp.effectiveCost*100)+'¢' : '—';
            const reasonsTitle = (tp.gradeReasons && tp.gradeReasons.length) ? tp.gradeReasons.join(' · ') : '';
            const gradeCls = tp.grade === 'A+' ? 'gradeAPlus' : 'gradeA';
            return '<div class=hcPick title="'+esc(reasonsTitle)+'">'
              +'<span class="gradeBadge '+gradeCls+'">'+esc(tp.grade)+'</span> '
              +'<b>'+esc(tpLabel)+'</b> at <b>'+costC+'</b> '
              +'<span class=mute>(model '+probPp+', edge '+edgePp+')</span> '
              +'<span class=hcMkt>'+esc(mq.slice(0,55))+'</span>'
              +'</div>';
          }).join('') + '</div>';
        }
        let nearMissLine = '';
        if (!has && nearMiss) {
          // v2.29.0: near-miss display label uses displaySide so O/U markets read naturally.
          const nmLabel = (nearMiss.s && nearMiss.s.displaySide) || (nearMiss.s && nearMiss.s.displayLabel) || nearMiss.label;
          const nmMkt = nearMiss.s.marketQuestion || '';
          const nmEdge = (nearMiss.edge*100).toFixed(1);
          nearMissLine = '<div class=nearMiss>Closest miss: <b>'+esc(nmLabel)+'</b> on <span class=mute>'+esc(nmMkt.slice(0,60))+'</span> · edge '+(nearMiss.edge>=0?'+':'')+nmEdge+'pp (below '+Math.round(TUNING.TABLE_BET_EDGE*100)+'pp threshold)</div>';
        }
        const gradeBtn = '<button class=gradeBtn id=gradePredBtn title="Score the local prediction log">📊 Grade</button>';
        decisionSummary = '<div class="'+cls+'">'+gradeBtn+'<div class=heading>'+heading+'</div><div class=subline>'+esc(subline)+'</div>'+hcLines+nearMissLine+'</div>';
      }
      // v2.9: Cluster Intel panel — display only, sits in Research Mode above the existing cards.
      // Sorts clusters globally by qualityScore so the most coordinated groups float to the top.
      let clusterPanel = '';
      {
        const flat = [];
        Object.entries(clustersBySide).forEach(([sideKey, cs]) => {
          const s = sides[sideKey] || {};
          // v2.29.0: cluster block header reads displaySide; sideKey identity stays raw.
          cs.forEach(c => flat.push({sideKey, mq: s.marketQuestion || '', sideLabel: s.displaySide || s.displayLabel || sideKey, c}));
        });
        flat.sort((a,b) => b.c.qualityScore - a.c.qualityScore || b.c.totalNotional - a.c.totalNotional);
        const totalCount = flat.length;
        if (totalCount === 0) {
          clusterPanel = '<details class=clusterPanel><summary>🔍 Cluster Intel · no coordinated groups detected</summary><div class=empty>No clusters met the thresholds (≥'+TUNING.CLUSTER_MIN_WALLETS+' wallets, ≥$'+(TUNING.CLUSTER_MIN_NOTIONAL/1000).toFixed(0)+'k notional, ≤'+Math.round(TUNING.CLUSTER_MAX_ENTRY_PRICE_GAP*100)+'¢ price spread).</div></details>';
        } else {
          const fmtUsd = n => n >= 1e6 ? '$'+(n/1e6).toFixed(1)+'M' : n >= 1000 ? '$'+(n/1000).toFixed(1)+'k' : '$'+Math.round(n);
          const fmtTime = secs => {
            if (secs == null) return '<span class=mute>n/a</span>';
            if (secs < 60) return secs+'s';
            if (secs < 3600) return Math.round(secs/60)+'m';
            return (secs/3600).toFixed(1)+'h';
          };
          const blocks = flat.slice(0, 12).map(({mq, sideLabel, c}) => {
            const archStr = Object.entries(c.archetypeCounts).sort((a,b)=>b[1]-a[1])
              .map(([a,n]) => n+' '+a).join(', ');
            const roiCls = c.unrealizedRoi > 0 ? 'pos' : c.unrealizedRoi < 0 ? 'neg' : '';
            const roiStr = (c.unrealizedRoi >= 0 ? '+' : '')+(c.unrealizedRoi*100).toFixed(1)+'%';
            const walletList = c.wallets.slice(0, 8).map(w =>
              '<a target=_blank href="https://polymarket.com/profile/'+w.addr+'">'+w.addr.slice(0,8)+'…'+w.addr.slice(-4)+'</a>'
              +' <span class=mute>('+w.archetype+', '+Math.round(w.amount).toLocaleString()+' @ '+(w.avg*100).toFixed(1)+'¢)</span>'
            ).join(' · ') + (c.wallets.length > 8 ? ' · <span class=mute>+'+(c.wallets.length-8)+' more</span>' : '');
            return '<div class=group>'
              +'<div class=ghdr>'+esc(sideLabel)+' on <span class=mute>'+esc(mq.slice(0,70))+'</span>'
              +'<span class="badge '+c.label+'">'+c.label+' · '+(c.qualityScore*100).toFixed(0)+'%</span></div>'
              +'<div class=meta>'
                +'<span><b>'+c.walletCount+'</b> wallets</span>'
                +'<span><b>'+fmtUsd(c.totalNotional)+'</b> notional</span>'
                +'<span>avg entry <b>'+(c.avgEntry*100).toFixed(1)+'¢</b></span>'
                +'<span>now <b>'+(c.currentPrice*100).toFixed(1)+'¢</b></span>'
                +'<span>ROI <b class="'+roiCls+'">'+roiStr+'</b></span>'
                +'<span>timing span <b>'+fmtTime(c.timingSpanSec)+'</b></span>'
              +'</div>'
              +'<div class=arch>archetypes: '+esc(archStr)+' · sharp-like '+c.sharpLikeCount+' / public-like '+c.publicLikeCount+'</div>'
              // v2.23: Phase-1 sub-score breakdown — display-only audit trail so the new
              // qualityScore can be sanity-checked without opening console.
              // v2.24 Phase 2A: extended with the recurring-group penalty term and a
              // conditional "⟲ seen together in N events" note when the same top-5 wallet
              // coalition has appeared in at least 2 distinct events (matches the score's
              // no-penalty threshold so users see context before the score moves).
              +'<div class=clusterBreakdown style="font-size:11px;color:#888;margin-top:2px">'
                +'score = base '+(c.baseQualityScore*100).toFixed(0)+'%·0.50'
                +' + elite '+(c.eliteShareScore*100).toFixed(0)+'%·0.10'
                +' + fair '+(c.fairValueScore*100).toFixed(0)+'%·0.15'
                +' + pnl '+(c.pnlMagnitudeScore*100).toFixed(0)+'%·0.15'
                +' − exit '+(c.exitPenalty*100).toFixed(0)+'%·0.10'
                // v2.24.1: suppress the recur term on zero-recurrence clusters so the
                // breakdown doesn't carry a useless "− recur 0%·0.10" on every cluster.
                // The "⟲ seen together" note below keeps its ≥2-event gate independently.
                +(c.recurringGroupScore > 0
                  ? ' − recur '+(c.recurringGroupScore*100).toFixed(0)+'%·0.10'
                  : '')
                +' = <b>'+(c.qualityScore*100).toFixed(0)+'%</b>'
              +'</div>'
              +(c.recurringEventCount >= 2
                ? '<div class=clusterRecurring style="font-size:11px;color:#a07050;margin-top:2px">'
                  +'⟲ this top-'+TUNING.RECURRING_GROUP_TOPN+' wallet group seen together in '
                  +'<b>'+c.recurringEventCount+'</b> event'+(c.recurringEventCount > 1 ? 's' : '')
                  +'</div>'
                : '')
              +'<div class=wallets>'+walletList+'</div>'
            +'</div>';
          }).join('');
          const overflow = totalCount > 12 ? '<div class=empty>+'+(totalCount-12)+' more clusters (top 12 shown)</div>' : '';
          clusterPanel = '<details class=clusterPanel open><summary>🔍 Cluster Intel · '+totalCount+' coordinated group'+(totalCount>1?'s':'')+' detected (display-only, no scoring impact)</summary><div class=body>'+blocks+overflow+'</div></details>';
        }
      }
      // v2.28: Bot Export Layer. Built right before researchBody so the structured snapshot
      // is ready before any UI strings reference it. All inputs are read-only — the helper
      // is wrapped in its own try/catch and returns a stub object on failure, so the dashboard
      // never breaks. window.pmSportsBotExport is set on the parent page (where a VPS scanner
      // would inject) AND mirrored to the popup window so the in-popup Copy button works.
      let botExport = null;
      let totalHolderRowsForExport = 0;
      try {
        totalHolderRowsForExport = Object.values(sides).reduce((s, sd) => s + (sd && sd.rows ? sd.rows.length : 0), 0);
      } catch(_){}
      try {
        // v2.34.0: grade aggregates across topPicks (the EVENT DECISION banner reads
        // aPlusCount + aCount to decide whether to highlight "ACTION" vs "WATCH").
        // gradeCounts spans every side analyzed so bot consumers see full coverage.
        const gradeCounts = { 'A+':0, A:0, B:0, C:0, PASS:0 };
        Object.values(gradesBySide).forEach(g => {
          if (g && g.grade && gradeCounts[g.grade] != null) gradeCounts[g.grade]++;
        });
        const topPickGradeCounts = { 'A+':0, A:0, B:0, C:0, PASS:0 };
        topPicks.forEach(tp => {
          const g = tp && tp.grade;
          if (g && topPickGradeCounts[g] != null) topPickGradeCounts[g]++;
        });
        const highConvictionCount = topPickGradeCounts['A+'] + topPickGradeCounts['A'];
        const decisionInfo = {
          hasActionableBets:    topPicks.length > 0,
          actionableCount:      topPicks.length,
          // v2.34.0: high-conviction = A+/A grades among the surfaced top picks. This is
          // what the EVENT DECISION banner highlights — B-grade LEANs fall through to
          // the rollup table where users can still see them with full context.
          highConvictionCount:  highConvictionCount,
          aPlusCount:           topPickGradeCounts['A+'],
          aCount:               topPickGradeCounts['A'],
          bCount:               topPickGradeCounts['B'],
          cCount:               topPickGradeCounts['C'],
          passCount:            topPickGradeCounts['PASS'],
          gradeCountsAllSides:  gradeCounts,
          closestMiss: nearMiss ? {
            side:        nearMiss.s.displayLabel || nearMiss.label,
            market:      nearMiss.s.marketQuestion || (nearMiss.s.market && nearMiss.s.market.question) || null,
            conditionId: nearMiss.s.market && nearMiss.s.market.conditionId || null,
            edge:        nearMiss.edge,
            modelProb:   nearMiss.p && nearMiss.p.probability != null ? nearMiss.p.probability : null,
            confidence:  nearMiss.p && nearMiss.p.confidence  != null ? nearMiss.p.confidence  : null
          } : null,
          reason: highConvictionCount > 0
            ? highConvictionCount + ' high-conviction pick' + (highConvictionCount > 1 ? 's' : '') + ' (A+/A).'
            : topPicks.length > 0
              ? topPicks.length + ' actionable pick' + (topPicks.length > 1 ? 's' : '') + ' but none high-conviction.'
              : (analyzedLiveMarkets > 0
                  ? analyzedLiveMarkets + ' live market' + (analyzedLiveMarkets > 1 ? 's' : '') + ' analyzed; market agrees with the model.'
                  : 'No live markets to analyze.')
        };
        botExport = buildBotExport({
          slug, sportKey, ev,
          sides, predictions, sideRaw,
          topPicks, clvBySide, specializationBySide, accumulationBySide,
          tailBySide, gradesBySide, clustersBySide,
          marketEdgeFor, classifyAction, classifyMarketType,
          mon, dataQuality: DataQuality,
          walletList, walletCacheHits,
          totalHolderRows: totalHolderRowsForExport,
          topN, decisionInfo
        });
        try { window.pmSportsBotExport  = botExport; } catch(_){}
        try { window.pmSportsGetExport  = function(){ return window.pmSportsBotExport; }; } catch(_){}
        // Mirror onto the popup window so the in-popup Copy button can read it without
        // crossing window.opener. Popup may have closed already — silent if so.
        try { if (w && !w.closed) { w.pmSportsBotExport = botExport; w.pmSportsGetExport = function(){ return w.pmSportsBotExport; }; } } catch(_){}
        try { console.log('[PM Sports bot export]', botExport); } catch(_){}
      } catch(e) {
        try { console.warn('[PM Sports bot export] wrapper failed:', e); } catch(_){}
      }
      // v2.28: research-mode banner with Copy-JSON button. botBannerHtml is plain string; the
      // click handler is wired further down in the event-handler block (alongside the existing
      // Grade button + sort toggles).
      const botBannerHtml = '<div class=botExportBanner>'
        + '<span>📦 <b>Bot export ready</b> · <code>window.pmSportsBotExport</code>'
        + (botExport && botExport.error ? ' <span class=mute>(stub: '+esc(botExport.error)+')</span>' : '')
        + '</span>'
        + '<button class=copyBotBtn id=copyBotBtn type=button>Copy Bot Export JSON</button>'
        + '</div>';
      // v2.2 research mode: everything below Top Picks collapsed by default.
      const researchBody = botBannerHtml+warnBadge+consistencyPanel+clusterPanel+streakPh+'<div class=cards>'+cardsHtml+'</div>'+zeroSignalBtn+toolbar+rollupTable()+'<div class=grid id=sidesgrid>'+gridHtml()+'</div>'+exitsPh;
      const researchMode = '<details class=researchMode><summary>🔬 Research mode · expand to see full dashboard (holder tables, per-side PnL, all sub-markets)</summary>'+researchBody+'</details>';
      // v2.17: header sub-line shows userscript version (always), SPORTGPT version (if present),
      // last scan time (always), and unique-wallet count (always). Same data the live status
      // panel uses, surfaced in the popup so the user knows what scan they're looking at.
      const sgptV = getSportGPTVersion();
      const verBits = ['Sports Money v'+SCRIPT_VERSION];
      if (sgptV) verBits.unshift('SPORTGPT v'+sgptV);
      const headerSub = verBits.join(' · ') + ' · ' + totalTraders + ' wallets locked · DataQuality '
                      + Math.round(DataQuality*100) + '% · last scan ' + new Date().toLocaleTimeString();
      const app='<div class=hdr><div><h1>'+esc(ev.title||slug)+'</h1><div class=sub>'+esc(headerSub)+'</div></div></div>'+decisionSummary+resolvedBanner+topPicksHtml+researchMode+ioBtns;
      d.getElementById('app').innerHTML=app;
      d.getElementById('app').style.display='block';
      d.getElementById('loading').style.display='none';
      markPhase('render');
      try { console.timeEnd('[PM Sports] renderUI'); } catch(_){}
      const _total = Math.round(((typeof performance!=='undefined' && performance.now) ? performance.now() : Date.now()) - tStart);
      // v2.13: total holder rows across all markets/sides for "is dedupe helping" sanity-check.
      const totalHolderRows = Object.values(sides).reduce((s, sd) => s + (sd.rows ? sd.rows.length : 0), 0);
      console.log('[PM Sports] timings(ms):',
        Object.entries(timings).map(([k,v])=>k+':'+v).join(' | '),
        '| total:'+_total,
        '| wallets:'+walletCacheHits+'/'+walletList.length+' cached',
        '| markets:'+markets.length,
        '| tokens:'+tokenList.length,
        '| holderRows:'+totalHolderRows,
        '| concurrency:'+currentBatch,
        // v2.35.0: turbo concurrency diagnostics — surfaces high-water batch, whether the
        // one-shot fail429 rollback tripped this scan, and the raw fail breakdown.
        '| maxBatch:'+(mon.maxBatchReached || 0),
        '| turboRollback:'+(mon.turboRollbackTriggered ? 'YES@call'+mon.turboRollbackAtCall : 'no'),
        '| 429:'+(mon.fail429 || 0),
        '| realFails:'+(mon.realFails || 0));
      // v2.13: dedupe-savings + failure-breakdown summary. Lets the user see at a glance whether
      // the dedupe wrappers are actually saving calls and which failure category dominates.
      console.log('[PM Sports] v2.13 perf:', {
        uniqueWallets: walletList.length,
        totalHolderRows,
        walletCacheHits,
        walletCacheMisses: walletList.length - walletCacheHits,
        fetchDedupeHits: mon.fetchDedupeHits || 0,
        walletDedupeHits: mon.walletDedupeHits || 0,
        holderDedupeHits: mon.holderDedupeHits || 0,   // v2.22: in-flight holder dedupe hits
        totalFails: mon.fails,
        fail429: mon.fail429 || 0,
        realFails: mon.realFails || 0,
        expectedNoData: mon.expectedNoData || 0,
        // v2.35.0: turbo concurrency diagnostics for structured-log consumers.
        maxBatchReached: mon.maxBatchReached || 0,
        turboRollbackTriggered: mon.turboRollbackTriggered === true,
        turboRollbackAtCall: mon.turboRollbackAtCall,
        totalScanMs: _total
      });
      // v2.15: cache-hit summary across all three caches. freshApiCallsAvoided sums the calls we
      // would have fired without the cache layer (one per wallet hit + one per holder hit + one
      // per event hit). It's the "did the cache pay rent this run?" number.
      const eHits = mon.eventCacheHits  || 0;
      const hHits = mon.holderCacheHits || 0;
      const wHits = walletCacheHits      || 0;
      console.log('[PM Sports] v2.15 cache:', {
        walletCacheHits: wHits,
        holderCacheHits: hHits,
        eventCacheHits:  eHits,
        freshApiCallsAvoided: wHits + hHits + eHits,
        walletHotTtlMin:  Math.round(WALLET_HOT_TTL/60000),    // v2.22: 4h
        walletColdTtlMin: Math.round(WALLET_COLD_TTL/60000),   // v2.22: 45min
        holderCacheTtlMin: Math.round(HOLDER_TTL_OK/60000),
        eventCacheTtlMin:  Math.round(EVENT_TTL/60000)
      });
      // v2.6: per-endpoint fail breakdown — makes it obvious which endpoint is burning the fail counter
      // when the "N fails" badge is high. Check the browser console after each load.
      if (mon.fails > 0) {
        const byEp = Object.entries(mon.failsByEndpoint).sort((a,b)=>b[1]-a[1]).slice(0,10);
        const byStatus = Object.entries(mon.failsByStatus).sort((a,b)=>b[1]-a[1]);
        console.log('[PM Sports] fail breakdown (total '+mon.fails+'):');
        console.log('  by status:', byStatus.map(([s,n])=>s+'='+n).join(' · '));
        console.log('  by endpoint:');
        byEp.forEach(([ep,n])=>console.log('    '+n+'  '+ep));
      }
      // v2.30.0: subfetch cache + fail cooldown + top-5 slowest diagnostics. Display + transport
      // only — no prediction math impact. Shows whether the new caches are paying rent and
      // surfaces the slowest endpoints so the next round of tuning has data to work with.
      console.log('[PM Sports] v2.30 subfetch cache:', {
        trades:   mon.tradesCacheHits   || 0,
        books:    mon.booksCacheHits    || 0,
        prices:   mon.pricesCacheHits   || 0,
        oi:       mon.oiCacheHits       || 0,
        comments: mon.commentsCacheHits || 0,
        marketActivity: mon.marketActivityCacheHits || 0,   // v2.31.0
        sessionL1Hits:  mon.sessionCacheHits         || 0,  // v2.31.0
        scanAborts:     scanAbortsTotal                     // v2.32.0: re-scan AbortController fires
      });
      console.log('[PM Sports] v2.30 fail cooldowns:', {
        walletFailSkips:      mon.walletFailSkips || 0,
        endpoint429Skips:     mon.endpoint429Skips || 0,
        endpoints429Cooled:   endpoint429Until.size,
        closedPositionsSkips: mon.closedPositionsSkips || 0   // v2.30.1
      });
      if (slowest.length) {
        console.log('[PM Sports] v2.30 top-'+slowest.length+' slowest requests:');
        slowest.forEach((s,i) => console.log('  '+(i+1)+'. '+s.ms+'ms  '+s.url));
      }
      // ────────────────────────────────────────────────────────────────
      // v2.16: snapshot state for the live loop on the main page. Pure read of values
      // already computed during the scan — no model recomputation. Closing the popup
      // does NOT terminate the loop (it lives on the main page's window).
      try {
        const liveSlug = slug;
        const livePredictions = {};
        const liveSideMeta    = {};
        const liveSnapshot    = {};
        Object.keys(predictions).forEach(label => {
          const p = predictions[label];
          const s = sides[label];
          const r = sideRaw[label] || {};
          const me = marketEdgeFor(label);
          if (!s || !p) return;
          // Skip resolved sides — live edge means nothing once the market settles.
          if (s.resolved) return;
          const tokenId = s.rows && s.rows[0] ? s.rows[0].tokenId : null;
          const componentsCopy = {};
          Object.keys(p.components || {}).forEach(k => {
            const v = p.components[k];
            componentsCopy[k] = (v == null || isNaN(v)) ? null : v;
          });
          livePredictions[label] = {
            probability: p.probability,
            confidence:  p.confidence,
            score:       p.score,
            components:  componentsCopy,
            sampleFactor: p.sampleFactor,
            oiFactor:    p.oiFactor
          };
          // v2.19: also derive outcomeIndex from r.outcomes if available — used by alert click
          // navigation to disambiguate which outcome to select on the page.
          let outcomeIndex = null;
          try {
            const outcomes = (s.market && (Array.isArray(s.market.outcomes) ? s.market.outcomes : (typeof s.market.outcomes === 'string' ? JSON.parse(s.market.outcomes) : null))) || null;
            if (Array.isArray(outcomes)) {
              const idx = outcomes.indexOf(s.displayLabel || label);
              if (idx >= 0) outcomeIndex = idx;
            }
          } catch(_){}
          liveSideMeta[label] = {
            cid:               s.market ? s.market.conditionId : null,
            displayLabel:      s.displayLabel || label,
            marketQuestion:    s.marketQuestion || (s.market ? s.market.question : '') || '',
            tokenId:           tokenId,
            slug:              liveSlug,                                      // v2.19 — for click-nav
            outcomeIndex:      outcomeIndex,                                  // v2.19 — for click-nav
            confidence:        p.confidence != null ? p.confidence : null,    // v2.19 — for alert card
            fee:               me ? me.fee : 0.01,
            fallbackPrice:     me ? me.rawPrice : (s.price || 0.5),
            eliteAvgEntry:     r.eliteAvgEntry != null ? r.eliteAvgEntry : null,
            eliteAvgRoi:       r.eliteAvgRoi   != null ? r.eliteAvgRoi   : null,
            eliteShare:        r.eliteShare    || 0,
            publicShare:       r.publicShare   || 0,
            holderProfit:      componentsCopy.holderProfit != null ? componentsCopy.holderProfit : null,
            exitSignal:        componentsCopy.exit         != null ? componentsCopy.exit         : null,
            totalSideNotional: r.totalNotional || 0
          };
          // Seed lastSnapshot with the values computed by the scan so the FIRST tick
          // doesn't fire spurious alerts comparing fresh prices against null.
          if (me) {
            liveSnapshot[label] = {
              edge: me.edge,
              rawPrice: me.rawPrice,
              effectiveCost: me.effectiveCost,
              modelProb: p.probability,
              action: classifyAction(me.edge, p.confidence),
              tailScore: tailBySide[label] ? tailBySide[label].tailScore : null,
              extensionRatio: tailBySide[label] && tailBySide[label].extensionRatio != null ? tailBySide[label].extensionRatio : null,
              t: Date.now()
            };
          }
        });
        const enabledStored = (function(){
          try { const v = localStorage.getItem(LIVE_ALERT_ENABLED_KEY); if (v == null) return true; return v === 'true'; }
          catch(_) { return true; }
        })();
        // Carry forward existing alertHistory on rescan so a rescan doesn't re-fire alerts
        // we just showed. Same for the alerts list — keep last 10 across rescans.
        const prior = window.pmSportsLiveState;
        const carryAlerts        = (prior && prior.slug === liveSlug && Array.isArray(prior.alerts))         ? prior.alerts        : [];
        const carryAlertHistory  = (prior && prior.slug === liveSlug && prior.alertHistory)                  ? prior.alertHistory  : {};
        if (prior && prior.timerId) { try { clearInterval(prior.timerId); } catch(_){} }
        window.pmSportsLiveState = {
          slug: liveSlug,
          lastFullScanAt: Date.now(),
          lastPriceRefreshAt: null,
          uniqueWallets: walletList.length,
          predictions: livePredictions,
          sideMeta:    liveSideMeta,
          bookSnapshot: {},
          lastSnapshot: liveSnapshot,
          alerts:        carryAlerts,
          alertHistory:  carryAlertHistory,
          enabled: enabledStored,
          timerId: null,
          // v2.21: dashboard popup handle — used by flashPickCardForAlert() to outline the
          // matching .pickCard when an ORANGE alert fires. Closed-popup case is handled
          // upstream (popup.closed check + try/catch absorbs cross-window access errors).
          popupWindow: (typeof w !== 'undefined') ? w : null,
          // v2.21: history-panel sort mode. Toggle via the Sort button inside the panel header.
          alertHistorySort: 'edge'
        };
        installLiveLoop();
        console.log('[PM Sports live] state exported · '+Object.keys(livePredictions).length+' sides locked · loop running every '+(LIVE_TICK_MS/1000)+'s');
      } catch(e) { console.warn('[PM Sports live] state export failed:', e); }
      // v1.9: prediction log for offline calibration.
      // Dump each side's model output with resolved state; if later re-hit after settlement,
      // we can compare modelProb vs actual winner to validate ALPHA / re-tune. Ring buffer: last 500.
      try {
        const predLogRows = Object.keys(predictions).map(k=>{
          const p = predictions[k];
          const s = sides[k];
          const me = marketEdgeFor(k);
          const sr = sideRaw[k] || {};
          const roundC = v => v==null ? null : Math.round(v*1000)/1000;
          // v2.11: closing-line proxy + true CLV. closingPrice = last point in prices-history series
          // for this side's token. clv = closingPrice - entryMarketPrice (positive = market moved
          // toward our pick after we logged it).
          const tokenId = s && s.rows && s.rows[0] ? s.rows[0].tokenId : null;
          const closingPrice = tokenId && latestPriceByToken[tokenId] != null ? latestPriceByToken[tokenId] : null;
          const entryMarketPrice = me ? me.effectiveCost : null;
          const clv = (closingPrice != null && entryMarketPrice != null) ? (closingPrice - entryMarketPrice) : null;
          return {
            t: Math.round(Date.now()/1000),
            slug, cid: s.market.conditionId, label: s.displayLabel||k,
            marketQuestion: s.marketQuestion || s.market.question || '',
            resolved: !!s.resolved, winner: s.winner||null,
            modelProb: roundC(p.probability),
            marketPrice: entryMarketPrice != null ? roundC(entryMarketPrice) : null,   // legacy alias
            entryMarketPrice: entryMarketPrice != null ? roundC(entryMarketPrice) : null,
            closingPrice: closingPrice != null ? roundC(closingPrice) : null,
            clv: clv != null ? roundC(clv) : null,
            edge: me ? roundC(me.edge) : null,
            score: roundC(p.score),
            confidence: roundC(p.confidence),
            sampleFactor: roundC(p.sampleFactor),
            // v2.11: eliteEdge diagnostics — surfaced so grader can correlate without recomputing.
            eliteShare: sr.eliteShare != null ? roundC(sr.eliteShare) : null,
            eliteShareNiche: sr.eliteShareNiche != null ? roundC(sr.eliteShareNiche) : null,
            eliteWalletCount: sr.eliteCount || 0,
            eliteNotional: sr.eliteNotional != null ? Math.round(sr.eliteNotional) : null,
            totalSideNotional: sr.totalNotional != null ? Math.round(sr.totalNotional) : null,
            eliteAvgPnlAll: sr.eliteAvgPnlAll != null ? Math.round(sr.eliteAvgPnlAll) : null,
            eliteAvgWinRate: sr.eliteAvgWinRate != null ? roundC(sr.eliteAvgWinRate) : null,
            eliteAvgRoi: sr.eliteAvgRoi != null ? roundC(sr.eliteAvgRoi) : null,
            publicTrap: p.components && p.components.publicTrap != null ? roundC(p.components.publicTrap) : null,
            components: Object.fromEntries(Object.entries(p.components).map(([ck,cv])=>[ck, roundC(cv)]))
          };
        });
        console.log('[PM_PRED_LOG]', JSON.stringify(predLogRows));
        const PLOG_KEY = 'pmsports_predlog_v1';
        const prior = JSON.parse(localStorage.getItem(PLOG_KEY) || '[]');
        const combined = (Array.isArray(prior) ? prior : []).concat(predLogRows).slice(-500);
        localStorage.setItem(PLOG_KEY, JSON.stringify(combined));
        // v2.7.1: settled rows survive PLOG ring-buffer eviction. Keyed by (cid,label),
        // overwrite-on-rerun so latest snapshot wins. 5000-row soft cap as localStorage
        // safety, not eviction policy. gradePredictions() reads SLOG primary, PLOG secondary.
        // v2.7.3: scan `combined` (this run + prior PLOG) instead of `predLogRows` (this run
        // only) so historical resolved rows already in PLOG migrate to SLOG before they
        // ring-evict. SLOG write logic below dedupes by (cid,label) so re-scanning the same
        // rows on every run is harmless.
        const settledNew = combined.filter(r => r && r.resolved === true && r.winner != null && r.label != null);
        if (settledNew.length) {
          const SLOG_KEY = 'pmsports_settled_v1';
          const priorS = JSON.parse(localStorage.getItem(SLOG_KEY) || '[]');
          const arr = Array.isArray(priorS) ? priorS.slice() : [];
          const idx = new Map();
          arr.forEach((r, i) => { if (r && r.cid && r.label) idx.set(r.cid+'|'+r.label, i); });
          settledNew.forEach(r => {
            const k = r.cid+'|'+r.label;
            if (idx.has(k)) arr[idx.get(k)] = r;
            else { idx.set(k, arr.length); arr.push(r); }
          });
          localStorage.setItem(SLOG_KEY, JSON.stringify(arr.slice(-5000)));
        }
      } catch(e) { console.warn('[PM Sports] pred log failed:', e); }
      // v2.12: zero-signal toggle — flips body.showZero so the .zeroSignalCard CSS rule reveals them.
      if (TUNING.SHOW_ZERO_SIGNAL_CARDS) d.body.classList.add('showZero');
      const showZeroBtn = d.getElementById('showZeroBtn');
      if (showZeroBtn) {
        showZeroBtn.addEventListener('click', () => {
          const showing = d.body.classList.toggle('showZero');
          showZeroBtn.textContent = showing
            ? 'Hide zero/no-signal cards'
            : 'Show '+zeroSignalCount+' zero/no-signal card'+(zeroSignalCount>1?'s':'');
        });
      }
      // v2.7: Grade-button handler — opens modal with gradePredictions() summary.
      const gradeBtnEl = d.getElementById('gradePredBtn');
      if (gradeBtnEl) {
        gradeBtnEl.addEventListener('click', () => {
          const g = gradePredictions();
          const pct = v => (v == null ? '—' : (v*100).toFixed(1)+'%');
          let body;
          if (!g || g.n === 0) {
            body = '<div class=empty>No settled predictions in the log yet.<br>Open events with resolved markets to populate.</div>';
          } else {
            // v2.11: signed pct (shows + or − prefix). Used for edgeCaptured + calibrationGap.
            const spct = v => v == null ? '—' : ((v>=0?'+':'')+(v*100).toFixed(1)+'pp');
            const statCells = [
              ['Settled N', g.n],
              ['+Edge N', g.posEdgeN],
              ['Brier', g.brier != null ? g.brier.toFixed(3) : '—'],
              ['Win rate', pct(g.winRate)],
              ['+Edge win', pct(g.posEdgeWinRate)],
              ['Avg entry price', pct(g.avgEntryMarketPrice)],
              ['Edge captured', spct(g.edgeCaptured)],
              ['Avg model prob', pct(g.avgModelProb)],
              ['Calibration gap', spct(g.calibrationGap)],
              ['Avg confidence', pct(g.avgConfidence)],
              ['Avg edge', pct(g.avgEdge)]
            ].map(([k,v]) => '<div class=cell><span>'+esc(k)+'</span><b>'+esc(String(v))+'</b></div>').join('');
            // v2.11: per-component winners-vs-losers separation table — does the component
            // actually distinguish settled winners from losers?
            const sep = g.componentSeparation || {};
            const sepKeys = Object.keys(sep).filter(k => sep[k].winnerAvg != null || sep[k].loserAvg != null);
            const sepRows = sepKeys.map(k => {
              const r = sep[k];
              const fmt = v => v == null ? '—' : v.toFixed(3);
              const deltaCls = r.delta == null ? '' : (r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '');
              return '<tr><td>'+esc(k)+'</td><td>'+fmt(r.winnerAvg)+'</td><td>'+fmt(r.loserAvg)+'</td><td class="'+deltaCls+'">'+(r.delta!=null?(r.delta>=0?'+':'')+r.delta.toFixed(3):'—')+'</td></tr>';
            }).join('');
            const sepTable = sepRows
              ? '<h3 style="font-size:13px;color:#aaa;margin:16px 0 4px;font-weight:500">Winners vs losers — component averages (positive Δ = component predicts wins)</h3><table><thead><tr><th>Component</th><th>Winner avg</th><th>Loser avg</th><th>Δ (W−L)</th></tr></thead><tbody>'+sepRows+'</tbody></table>'
              : '';
            const compRows = (g.components||[]).slice(0, 12).map(c =>
              '<tr><td>'+esc(c.component)+'</td><td>'+c.n+'</td><td>'+c.corr.toFixed(3)+'</td></tr>'
            ).join('');
            const compTable = compRows
              ? '<h3 style="font-size:13px;color:#aaa;margin:16px 0 4px;font-weight:500">Component correlations with outcome</h3><table><thead><tr><th>Component</th><th>N</th><th>Pearson r</th></tr></thead><tbody>'+compRows+'</tbody></table>'
              : '';
            body = '<div class=verdict>'+esc(g.verdict||'')+'</div><div class=statGrid>'+statCells+'</div>'+sepTable+compTable;
          }
          // v2.21: version history surfaced beneath the grade body. Always rendered, even
          // when the log is empty — useful for confirming installed version + recent changes.
          const verRows = (VERSION_HISTORY || []).map(v =>
            '<tr><td><b>v'+esc(v.version)+'</b></td><td>'+esc(v.tuningSummary||'')+'</td><td class=mute>'+esc(v.weightDeltas||'—')+'</td><td>'+esc(v.notes||'')+'</td></tr>'
          ).join('');
          const verSection = '<details style="margin-top:16px;background:#0d0d14;border:1px solid #22222d;border-radius:6px;padding:8px 12px"><summary style="cursor:pointer;font-size:13px;color:#aaa;font-weight:500">📜 Version history</summary>'
            + '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">'
            + '<thead><tr><th style="text-align:left;color:#888;padding:4px 6px">Version</th><th style="text-align:left;color:#888;padding:4px 6px">Tuning</th><th style="text-align:left;color:#888;padding:4px 6px">Weight Δ</th><th style="text-align:left;color:#888;padding:4px 6px">Notes</th></tr></thead>'
            + '<tbody>'+verRows+'</tbody></table></details>';
          let overlay = d.getElementById('gradeOverlay');
          if (overlay) overlay.remove();
          overlay = d.createElement('div');
          overlay.className = 'gradeOverlay';
          overlay.id = 'gradeOverlay';
          overlay.innerHTML = '<div class=gradeModal><button class=closeX id=gradeClose>×</button><h2>📊 Prediction log grade</h2>'+body+verSection+'</div>';
          d.body.appendChild(overlay);
          const closeIt = () => { const o = d.getElementById('gradeOverlay'); if (o) o.remove(); };
          d.getElementById('gradeClose').addEventListener('click', closeIt);
          overlay.addEventListener('click', e => { if (e.target === overlay) closeIt(); });
        });
      }
      // v2.28: Copy-Bot-Export-JSON button. Uses navigator.clipboard when available; falls
      // back to a hidden-textarea + document.execCommand path for older browsers / restricted
      // contexts. Per spec: if clipboard fails, console.warn only — never throw, never block.
      const copyBotBtnEl = d.getElementById('copyBotBtn');
      if (copyBotBtnEl) {
        copyBotBtnEl.addEventListener('click', () => {
          let json = '';
          try { json = JSON.stringify(botExport, null, 2); }
          catch(e) {
            try { console.warn('[PM Sports bot export] JSON.stringify failed:', e); } catch(_){}
            return;
          }
          const flashCopied = () => {
            copyBotBtnEl.textContent = 'Copied ✓';
            copyBotBtnEl.classList.add('copied');
            setTimeout(() => {
              try { copyBotBtnEl.textContent = 'Copy Bot Export JSON'; copyBotBtnEl.classList.remove('copied'); } catch(_){}
            }, 1500);
          };
          // Modern clipboard API path.
          const navClip = (w && w.navigator && w.navigator.clipboard) || (typeof navigator !== 'undefined' ? navigator.clipboard : null);
          if (navClip && typeof navClip.writeText === 'function') {
            navClip.writeText(json).then(flashCopied, (err) => {
              try { console.warn('[PM Sports bot export] navigator.clipboard.writeText rejected:', err && err.message); } catch(_){}
              // Try the textarea fallback once before giving up.
              tryFallback();
            });
            return;
          }
          tryFallback();
          function tryFallback(){
            try {
              const ta = d.createElement('textarea');
              ta.value = json;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              d.body.appendChild(ta);
              ta.focus();
              ta.select();
              let ok = false;
              try { ok = d.execCommand('copy'); } catch(_){}
              try { ta.remove(); } catch(_){}
              if (ok) flashCopied();
              else { try { console.warn('[PM Sports bot export] clipboard fallback failed'); } catch(_){} }
            } catch(e) {
              try { console.warn('[PM Sports bot export] clipboard fallback threw:', e && e.message); } catch(_){}
            }
          }
        });
      }
      d.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{
        state.win=b.dataset.win;
        d.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));
        d.getElementById('sidesgrid').innerHTML=gridHtml();
      }));
      // v2.2: click the "Show N no-edge rows" footer to reveal hidden PASS/FADE rows in the prediction table.
      d.querySelectorAll('button.showHidden').forEach(b=>b.addEventListener('click',()=>{
        d.querySelectorAll('tr.hiddenByDefault').forEach(r=>r.classList.remove('hiddenByDefault'));
        b.closest('tr').remove();
      }));
      // v2.21: predtable sort toggle (Score ↔ Edge). Delegated on the dashboard body so it
      // survives re-renders. Re-renders the rollup container in place; the showHidden footer
      // is re-attached automatically because the new outerHTML reincludes it.
      d.body.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('#predSortBtn');
        if (!btn) return;
        e.preventDefault();
        state.predSort = (state.predSort === 'edge') ? 'score' : 'edge';
        const container = d.getElementById('rollupContainer');
        if (!container) return;
        // outerHTML replacement preserves DOM position. The replacement re-runs rollupTable()
        // which carries the freshly toggled state.predSort.
        const replacement = d.createElement('div');
        replacement.innerHTML = rollupTable();
        const newNode = replacement.firstChild;
        if (newNode) container.replaceWith(newNode);
        // Re-attach showHidden handlers on any re-rendered toggle row.
        d.querySelectorAll('button.showHidden').forEach(b => {
          if (b._wired) return;
          b._wired = true;
          b.addEventListener('click', () => {
            d.querySelectorAll('tr.hiddenByDefault').forEach(r=>r.classList.remove('hiddenByDefault'));
            b.closest('tr').remove();
          });
        });
      });
      d.querySelector('.topn').addEventListener('change',e=>{
        localStorage.setItem(TOPN_KEY,e.target.value);
        w.close();
        run();
      });
      d.getElementById('sidesgrid').addEventListener('change',e=>{
        if(!e.target.classList.contains('sidefilter')) return;
        const side=e.target.dataset.side;
        state.filter[side]=e.target.value;
        d.getElementById('sidesgrid').innerHTML=gridHtml();
      });
      d.getElementById('sidesgrid').addEventListener('click',e=>{
        const el=e.target.closest('[data-bm]');
        if(!el) return;
        e.preventDefault();
        const addr=el.dataset.bm;
        if(bookmarks[addr]) delete bookmarks[addr]; else bookmarks[addr]={bookmarkedAt:Date.now(),firstSeenMarket:slug,note:''};
        saveBookmarks();
        renderedSides.forEach(k=>{sides[k].rows.forEach(r=>{if(r.h.proxyWallet===addr) r.bookmarked=!!bookmarks[addr];});});
        d.getElementById('sidesgrid').innerHTML=gridHtml();
      });
      d.getElementById('bmExport').addEventListener('click',()=>{
        const blob=new Blob([JSON.stringify(bookmarks,null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob);
        const a=d.createElement('a');
        a.href=url; a.download='pmdash_bookmarks_'+Date.now()+'.json';
        d.body.appendChild(a); a.click(); a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      });
      d.getElementById('bmImport').addEventListener('click',()=>d.getElementById('bmImportFile').click());
      d.getElementById('bmImportFile').addEventListener('change',ev=>{
        const file=ev.target.files&&ev.target.files[0];
        if(!file) return;
        const reader=new FileReader();
        reader.onload=()=>{
          try{
            const incoming=JSON.parse(reader.result);
            let added=0;
            if(Array.isArray(incoming)){incoming.forEach(a=>{if(!bookmarks[a]){bookmarks[a]={bookmarkedAt:Date.now(),firstSeenMarket:'imported',note:''};added++;}});}
            else if(incoming && typeof incoming==='object'){Object.entries(incoming).forEach(([a,v])=>{if(!bookmarks[a]){bookmarks[a]=v;added++;}});}
            saveBookmarks();
            renderedSides.forEach(k=>{sides[k].rows.forEach(r=>{r.bookmarked=!!bookmarks[r.h.proxyWallet];});});
            d.getElementById('sidesgrid').innerHTML=gridHtml();
            alert('Imported '+added+' new bookmarks');
          }catch(err){alert('Import failed: '+err.message);}
        };
        reader.readAsText(file);
      });
      // Exits panel (synchronous render from pre-computed exitsCandidates)
      (function renderExitsPanel(){
        const exitsNode=d.getElementById('exits');
        if(!exitsNode) return;
        if(!exitsCandidates.length) return;
        const exits=exitsCandidates.slice().sort((a,b)=>b.ts-a.ts);
        const fresh=exits.filter(x=>x.tier==='fresh').length;
        const recent=exits.filter(x=>x.tier==='recent').length;
        const body=exits.slice(0,200).map(x=>'<tr><td>'+(x.tier==='fresh'?'🔴':'🟡')+'</td><td><a target=_blank href="https://polymarket.com/profile/'+x.w+'">'+x.w.slice(0,10)+'…</a></td><td>'+Math.round(x.netSold).toLocaleString()+'</td><td>'+esc((x.market||'').slice(0,48))+'</td><td>'+dur(x.age)+' ago</td><td class="'+(x.pnl>0?'pos':x.pnl<0?'neg':'mute')+'">'+(x.pnl!=null?fmtS(x.pnl):'-')+'</td></tr>').join('');
        exitsNode.innerHTML='<summary>Recently Exited ('+exits.length+' wallets · 🔴 '+fresh+' &lt;24h · 🟡 '+recent+' 24–72h)</summary><div class=tblwrap><table><thead><tr><th>Tier</th><th>Wallet</th><th>Net sold (72h)</th><th>Market</th><th>Exit</th><th>Lifetime PnL</th></tr></thead><tbody>'+body+'</tbody></table></div>';
        exitsNode.style.display='block';
      })();
      (async()=>{
        const streakNode=d.getElementById('streak');
        try{
          await withTimeout((async()=>{
          const seriesId=ev.series && ev.series[0] && ev.series[0].id;
          if(!seriesId) return;
          const seriesLabel=esc(ev.series[0].title||ev.series[0].ticker||'Recurring series');
          streakNode.innerHTML='<summary><span class=pat>Recurring series · '+seriesLabel+'</span><span class=wl> · Loading historical performance…</span></summary>';
          streakNode.style.display='block';
          const allRows=Object.values(sides).flatMap(s=>s.rows);
          // Archetype-driven smart-wallet selection for streak (sharp or insider_like, ordered by confidence then pnl)
          const smartWallets=allRows.filter(r=>r.archetype==='sharp' || r.archetype==='insider_like')
            .sort((a,b)=>((b.archConfidence||0)*(b.u.pnlAll||0))-((a.archConfidence||0)*(a.u.pnlAll||0)))
            .slice(0,10).map(r=>r.h.proxyWallet);
          if(!smartWallets.length){
            streakNode.innerHTML='<summary><span class=pat>'+seriesLabel+'</span><span class=wl> · No smart wallets on this market</span></summary>';
            return;
          }
          const sampled=smartWallets.some(sw=>{const u=userStats[sw]; return u && u.positionsSampled;});
          const listing=await safeFetch('https://gamma-api.polymarket.com/events?closed=true&series_id='+seriesId+'&limit=50');
          const currentIds=new Set(ev.markets.map(m=>m.conditionId));
          const histEvents=(Array.isArray(listing)?listing:[]).filter(e=>!(e.markets||[]).some(m=>currentIds.has(m.conditionId)));
          const histMarkets=histEvents.flatMap(e=>e.markets||[]).filter(m=>m&&m.conditionId);
          histMarkets.sort((a,b)=>new Date(b.endDate||b.closedTime||0)-new Date(a.endDate||a.closedTime||0));
          const topMarkets=histMarkets.slice(0,20);
          if(!topMarkets.length){
            streakNode.innerHTML='<summary><span class=pat>'+seriesLabel+'</span><span class=wl> · Insufficient historical markets</span></summary>';
            return;
          }
          const marketOutcome=[];
          topMarkets.forEach(m=>{
            let w=0,l=0;
            smartWallets.forEach(sw=>{
              const positions=positionsByWallet[sw]||[];
              positions.filter(p=>p.conditionId===m.conditionId).forEach(p=>{
                const rp=(Number(p.realizedPnl)||0)+(Number(p.cashPnl)||0);
                if(rp>500)w++;else if(rp<-500)l++;
              });
            });
            if(w+l>0) marketOutcome.push({m,net:w>l?1:(l>w?-1:0),w,l});
          });
          const decisive=marketOutcome.filter(x=>x.net!==0);
          if(!decisive.length){
            streakNode.innerHTML='<summary><span class=pat>'+seriesLabel+'</span><span class=wl> · No decisive smart-money outcomes</span></summary>';
            return;
          }
          const wins=decisive.filter(x=>x.net>0).length;
          const losses=decisive.length-wins;
          let streak=0;
          const sign=decisive[0].net;
          for(const x of decisive){if(x.net===sign)streak++;else break;}
          const streakStr=(sign>0?'+':'-')+streak;
          const sampleNote=sampled?' · <span class=mute>sampled</span>':'';
          const detailBody=decisive.slice(0,20).map(x=>'<tr><td>'+(x.net>0?'🟢 W':'🔴 L')+'</td><td>'+esc((x.m.question||'').slice(0,64))+'</td><td>'+x.w+'</td><td>'+x.l+'</td><td>'+(x.m.endDate?new Date(x.m.endDate).toLocaleDateString():'-')+'</td></tr>').join('');
          streakNode.innerHTML='<summary><span class=pat>'+seriesLabel+' recent · Smart money '+wins+'W / '+losses+'L ('+Math.round(wins/(wins+losses)*100)+'%) · Current streak: '+streakStr+sampleNote+'</span></summary><div class=tblwrap><table><thead><tr><th>Result</th><th>Market</th><th>Wins</th><th>Losses</th><th>Closed</th></tr></thead><tbody>'+detailBody+'</tbody></table></div>';
          })(), 30000, 'streak');
        }catch(err){
          console.log('[PM Dashboard] streak error',err);
          if(streakNode){streakNode.innerHTML='<summary style="color:#888">Recurring series · timed out</summary>';streakNode.style.display='block';}
        }
      })();
    }catch(e){d.body.innerHTML='<h1 style="color:#f88">Error</h1><pre style="color:#f88;white-space:pre-wrap">'+(e.stack||e.message)+'</pre>';}
    finally{if(activeScanController===myAbortController)activeScanController=null;}   // v2.32.0
  }
})();
