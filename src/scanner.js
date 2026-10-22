import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { config } from './config.js';

async function loadUserScript() {
  return readFile(config.userScriptPath, 'utf8');
}

export async function scanEventUrl(url) {
  const userScript = await loadUserScript();
  const browser = await chromium.launch({
    headless: config.headless,
    ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
  });
  // The userscript is injected as a page script (what Tampermonkey does); bypassing CSP keeps
  // Polymarket's policy from blocking it.
  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();
  page.setDefaultTimeout(config.pageTimeoutMs);

  const logs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/PM Sports|Sports Money/i.test(text)) logs.push(text);
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
    // Inject after DOMContentLoaded (Tampermonkey runs it at document-idle); as an init script
    // it would run before <html> exists and its MutationObserver setup would throw.
    await page.addScriptTag({ content: userScript });

    try {
      await page.waitForFunction(() => typeof window.pmSportsRun === 'function', null, { timeout: 30000 });
    } catch {
      throw new Error('Userscript did not expose window.pmSportsRun (needs pm-sports-dashboard v2.36.0+)');
    }

    // The scan only runs when triggered. Fire it without awaiting: run() resolves after the
    // dashboard renders, and completion is detected below.
    const startedAt = await page.evaluate(() => {
      const t = Date.now();
      window.pmSportsRun();
      return t;
    });

    const handle = await page.waitForFunction(
      (t) => {
        const st = window.pmSportsLastScanStatus;
        if (st && (st.status === 'error' || st.status === 'skipped')) return { failed: st };
        const e = window.pmSportsBotExport;
        if (e && e.schemaVersion && e.exportedAt >= t) return { ok: true };
        return false;
      },
      startedAt,
      { timeout: config.exportTimeoutMs, polling: 500 },
    );
    const outcome = await handle.jsonValue();
    if (outcome.failed) {
      throw new Error(`Scan ${outcome.failed.status}: ${outcome.failed.reason || 'unknown reason'}`);
    }

    const exportData = await page.evaluate(() => window.pmSportsBotExport);
    if (!exportData || !exportData.schemaVersion) {
      throw new Error('window.pmSportsBotExport missing or invalid');
    }
    return { exportData, logs };
  } finally {
    await browser.close();
  }
}
