# CENTISPORT

Sports Money collector MVP for Polymarket event pages.

This repo does **not** rebuild the Sports Money prediction model. It opens Polymarket event URLs, injects the Sports Money userscript, reads `window.pmSportsBotExport`, stores exports/signals in Postgres, and optionally sends Telegram alerts.

## MVP Flow

1. Open each URL from `EVENT_URLS`
2. Inject `vendor/pm-sports-dashboard.user.js`
3. Wait for `window.pmSportsBotExport`
4. Save full export JSON to `raw_exports`
5. Extract actionable signals into `signals`
6. Send Telegram for BET signals
7. Repeat on interval

No auto-betting. Manual execution only.

## Setup

```bash
npm install
npm run playwright:install
cp .env.example .env
```

Fill `.env`:

```text
DATABASE_URL=postgres://postgres:postgres@localhost:5432/centisport
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
EVENT_URLS=https://polymarket.com/sports/nba/example-event
```

Put your current Sports Money userscript here:

```text
vendor/pm-sports-dashboard.user.js
```

## Database

Run migration:

```bash
npm run migrate
```

## Run once

```bash
npm run scan:once
```

## Run continuously

```bash
npm start
```

## Local Postgres quick start

Use any local Postgres. Example with Docker:

```bash
docker run --name centisport-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=centisport \
  -p 5432:5432 \
  -d postgres:16-alpine
```

Then use:

```text
DATABASE_URL=postgres://postgres:postgres@localhost:5432/centisport
```

## Important fields

- `side`: raw Polymarket outcome, kept for back compatibility
- `rawSide`: exact raw outcome used for matching/clicking
- `displaySide`: human-readable side, e.g. `Under 4.5`
- `line`: parsed O/U line when available
- `sideType`: `over`, `under`, `yes`, `no`, or `team`

Telegram uses `displaySide`. Matching/deduping uses `rawSide`.
