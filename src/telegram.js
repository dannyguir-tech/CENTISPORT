import { config } from './config.js';

export function telegramEnabled() {
  return Boolean(config.telegramBotToken && config.telegramChatId);
}

export function formatSignalAlert(signal, event = {}) {
  const pct = (v) => (v == null ? 'n/a' : `${(Number(v) * 100).toFixed(1)}%`);
  const cents = (v) => (v == null ? 'n/a' : `${(Number(v) * 100).toFixed(1)}¢`);
  const money = (v) => {
    if (v == null || !Number.isFinite(Number(v))) return 'n/a';
    const n = Math.round(Number(v));
    return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString()}`;
  };

  const cluster = signal.cluster || {};
  const accumulation = signal.accumulation || {};
  const clv = signal.clv || {};
  const tail = signal.tail || {};

  return [
    '🟧 SPORTS MONEY BET SIGNAL',
    '',
    `Event: ${event.title || signal.slug || 'Unknown event'}`,
    `Market: ${signal.market || 'Unknown market'}`,
    `Side: ${signal.displaySide || signal.rawSide || signal.side || 'Unknown side'}`,
    `Cost: ${cents(signal.effectiveCost)}`,
    `Model: ${pct(signal.modelProb)}`,
    `Edge: ${pct(signal.edge)}`,
    `Confidence: ${pct(signal.confidence)}`,
    '',
    `Tail: ${tail.tailScore ?? signal.tailScore ?? 'n/a'}`,
    `Pressure: ${accumulation.pressureLabel || signal.pressureLabel || 'n/a'}`,
    `Smart Net: ${money(accumulation.smartNetNotional ?? signal.smartNetNotional)}`,
    `CLV Spread: ${clv.clvSpread == null ? 'n/a' : cents(clv.clvSpread)}`,
    `Cluster: ${cluster.bestClusterQuality == null ? 'n/a' : Number(cluster.bestClusterQuality).toFixed(2)}`,
    `DataQuality: ${pct(signal.dataQuality)}`,
    '',
    signal.url || '',
    '',
    'Manual execution only. Recheck price before entry.',
  ].join('\n');
}

export async function sendTelegramMessage(text) {
  if (!telegramEnabled()) return null;

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Telegram send failed ${response.status}: ${body}`);
  }

  const json = await response.json();
  return json?.result?.message_id ?? null;
}
