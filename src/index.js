import { config, requireConfig } from './config.js';
import {
  migrate,
  closeDb,
  insertRawExport,
  insertSignal,
  wasRecentlyAlerted,
  markTelegramSent,
} from './db.js';
import { extractSignals } from './extractSignals.js';
import { scanEventUrl } from './scanner.js';
import { formatSignalAlert, sendTelegramMessage, telegramEnabled } from './telegram.js';

async function processUrl(url) {
  console.log(`Scanning ${url}`);
  const { exportData } = await scanEventUrl(url);
  const event = exportData.event || {};
  const rawExportId = await insertRawExport(exportData);
  const signals = extractSignals(exportData);

  console.log(
    `Saved raw export ${rawExportId}: ${event.title || exportData.slug || url}; signals=${signals.length}`,
  );

  for (const signal of signals) {
    const signalId = await insertSignal(rawExportId, signal, event.dataQuality);
    const duplicate = await wasRecentlyAlerted(signal, config.duplicateAlertMinutes);
    if (duplicate) {
      console.log(`Skipping duplicate alert for ${signal.market} ${signal.displaySide || signal.side}`);
      continue;
    }

    if (!telegramEnabled()) {
      console.log(`Telegram disabled. Would alert: ${signal.market} ${signal.displaySide || signal.side}`);
      continue;
    }

    const text = formatSignalAlert(signal, event);
    const messageId = await sendTelegramMessage(text);
    await markTelegramSent(signalId, messageId);
    console.log(`Telegram sent for signal ${signalId}`);
  }

  return { rawExportId, signals: signals.length };
}

async function runScanCycle() {
  const results = [];
  for (const url of config.eventUrls) {
    try {
      results.push(await processUrl(url));
    } catch (error) {
      console.error(`Scan failed for ${url}:`, error);
    }
  }
  return results;
}

async function main() {
  requireConfig();
  await migrate();

  console.log('CENTISPORT collector started');
  console.log(`URLs: ${config.eventUrls.length}`);
  console.log(`Interval: ${config.scanIntervalSeconds}s`);
  console.log(`Telegram: ${telegramEnabled() ? 'enabled' : 'disabled'}`);

  await runScanCycle();

  if (config.scanOnce) return;

  setInterval(() => {
    runScanCycle().catch((error) => console.error('Scan cycle failed:', error));
  }, config.scanIntervalSeconds * 1000);
}

process.on('SIGINT', async () => {
  console.log('Shutting down');
  await closeDb();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down');
  await closeDb();
  process.exit(0);
});

main().catch(async (error) => {
  console.error('Fatal error:', error);
  await closeDb().catch(() => {});
  process.exit(1);
});
