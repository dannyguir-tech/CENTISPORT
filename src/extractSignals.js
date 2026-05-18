import { config } from './config.js';

function normalizeAction(action) {
  return String(action || '').toUpperCase();
}

function withEventFields(side, exportData) {
  const event = exportData.event || {};
  return {
    ...side,
    slug: exportData.slug || event.slug || side.slug || null,
    url: exportData.url || side.url || null,
    sport: side.sport || event.sportKey || null,
    dataQuality: Number.isFinite(Number(event.dataQuality)) ? Number(event.dataQuality) : null,
  };
}

export function extractSignals(exportData) {
  const event = exportData.event || {};
  const dq = Number(event.dataQuality ?? 0);
  if (!Number.isFinite(dq) || dq < config.minDataQuality) return [];

  const sides = Array.isArray(exportData.sides) ? exportData.sides : [];
  const wanted = [];

  for (const side of sides) {
    const action = normalizeAction(side.action);
    if (config.alertBetsOnly && action !== 'BET') continue;
    if (!config.alertBetsOnly && !['BET', 'LEAN'].includes(action)) continue;
    if (!config.alertLeans && action === 'LEAN') continue;
    if (side.effectiveCost == null || !Number.isFinite(Number(side.effectiveCost))) continue;
    wanted.push(withEventFields({ ...side, action }, exportData));
  }

  return wanted.sort((a, b) => Number(b.edge || 0) - Number(a.edge || 0));
}
