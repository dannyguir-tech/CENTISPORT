import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function closeDb() {
  await pool.end();
}

export async function migrate() {
  const sql = await readFile(new URL('../sql/001_init.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export function hashExport(exportData) {
  return crypto.createHash('sha256').update(JSON.stringify(exportData)).digest('hex');
}

export async function insertRawExport(exportData) {
  const event = exportData.event || {};
  const result = await pool.query(
    `INSERT INTO raw_exports
      (slug, url, script_version, event_title, sport_key, data_quality, export_json, export_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      exportData.slug || event.slug || null,
      exportData.url || null,
      exportData.scriptVersion || null,
      event.title || null,
      event.sportKey || null,
      Number.isFinite(Number(event.dataQuality)) ? Number(event.dataQuality) : null,
      JSON.stringify(exportData),
      hashExport(exportData),
    ],
  );
  return result.rows[0].id;
}

export async function insertSignal(rawExportId, signal, dataQuality) {
  const cluster = signal.cluster || {};
  const accumulation = signal.accumulation || {};
  const clv = signal.clv || {};
  const tail = signal.tail || {};

  const result = await pool.query(
    `INSERT INTO signals
      (raw_export_id, slug, url, market, condition_id, token_id, side, raw_side, display_side,
       side_type, line, sport, market_type, action, model_prob, effective_cost, edge,
       confidence, score, tail_score, pressure_label, smart_net_notional, clv_spread,
       best_cluster_quality, cluster_count, recurring_group_score, recurring_event_count,
       data_quality)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING id`,
    [
      rawExportId,
      signal.slug || null,
      signal.url || null,
      signal.market || null,
      signal.conditionId || null,
      signal.tokenId || null,
      signal.side || null,
      signal.rawSide || signal.side || null,
      signal.displaySide || signal.side || null,
      signal.sideType || null,
      signal.line ?? null,
      signal.sport || null,
      signal.marketType || null,
      signal.action || null,
      signal.modelProb ?? null,
      signal.effectiveCost ?? null,
      signal.edge ?? null,
      signal.confidence ?? null,
      signal.score ?? null,
      tail.tailScore ?? signal.tailScore ?? null,
      accumulation.pressureLabel || signal.pressureLabel || null,
      accumulation.smartNetNotional ?? signal.smartNetNotional ?? null,
      clv.clvSpread ?? signal.clvSpread ?? null,
      cluster.bestClusterQuality ?? signal.bestClusterQuality ?? null,
      cluster.clusterCount ?? signal.clusterCount ?? null,
      cluster.recurringGroupScore ?? signal.recurringGroupScore ?? null,
      cluster.recurringEventCount ?? signal.recurringEventCount ?? null,
      dataQuality ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function wasRecentlyAlerted(signal, minutes) {
  const conditionId = signal.conditionId || null;
  const rawSide = signal.rawSide || signal.side || null;
  const action = signal.action || null;
  if (!conditionId || !rawSide || !action) return false;

  const sinceMs = Math.max(1, Number(minutes) || 10) * 60 * 1000;
  const since = new Date(Date.now() - sinceMs);
  const result = await pool.query(
    `SELECT id FROM signals
     WHERE condition_id = $1
       AND raw_side = $2
       AND action = $3
       AND telegram_sent = true
       AND created_at > $4
     LIMIT 1`,
    [conditionId, rawSide, action, since],
  );
  return result.rowCount > 0;
}

export async function markTelegramSent(signalId, messageId) {
  await pool.query(
    `UPDATE signals SET telegram_sent = true, telegram_message_id = $2 WHERE id = $1`,
    [signalId, messageId == null ? null : String(messageId)],
  );
}
