import 'dotenv/config';

function asBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asUrlList(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  eventUrls: asUrlList(process.env.EVENT_URLS),
  scanIntervalSeconds: asNumber(process.env.SCAN_INTERVAL_SECONDS, 300),
  minDataQuality: asNumber(process.env.MIN_DATA_QUALITY, 0.9),
  alertBetsOnly: asBool(process.env.ALERT_BETS_ONLY, true),
  alertLeans: asBool(process.env.ALERT_LEANS, false),
  duplicateAlertMinutes: asNumber(process.env.DUPLICATE_ALERT_MINUTES, 10),
  userScriptPath: process.env.USER_SCRIPT_PATH || 'vendor/pm-sports-dashboard.user.js',
  headless: asBool(process.env.HEADLESS, true),
  pageTimeoutMs: asNumber(process.env.PAGE_TIMEOUT_MS, 120000),
  exportTimeoutMs: asNumber(process.env.EXPORT_TIMEOUT_MS, 120000),
  scanOnce: asBool(process.env.SCAN_ONCE, false),
};

export function requireConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.eventUrls.length) missing.push('EVENT_URLS');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
