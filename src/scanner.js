import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { config } from './config.js';

async function loadUserScript() {
  return readFile(config.userScriptPath, 'utf8');
}

export async function scanEventUrl(url) {
  const userScript = await loadUserScript();
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();
  page.setDefaultTimeout(config.pageTimeoutMs);

  const logs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/PM Sports|Sports Money/i.test(text)) logs.push(text);
  });

  try {
    await page.addInitScript(userScript);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });

    await page.waitForFunction(
      () => Boolean(window.pmSportsBotExport && window.pmSportsBotExport.schemaVersion),
      null,
      { timeout: config.exportTimeoutMs },
    );

    const exportData = await page.evaluate(() => window.pmSportsBotExport);
    if (!exportData || !exportData.schemaVersion) {
      throw new Error('window.pmSportsBotExport missing or invalid');
    }
    return { exportData, logs };
  } finally {
    await browser.close();
  }
}
