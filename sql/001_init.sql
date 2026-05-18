CREATE TABLE IF NOT EXISTS raw_exports (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  slug TEXT,
  url TEXT,
  script_version TEXT,
  event_title TEXT,
  sport_key TEXT,
  data_quality NUMERIC,
  export_json JSONB NOT NULL,
  export_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_raw_exports_created_at ON raw_exports(created_at);
CREATE INDEX IF NOT EXISTS idx_raw_exports_slug ON raw_exports(slug);
CREATE INDEX IF NOT EXISTS idx_raw_exports_hash ON raw_exports(export_hash);

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  raw_export_id BIGINT REFERENCES raw_exports(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  slug TEXT,
  url TEXT,
  market TEXT,
  condition_id TEXT,
  token_id TEXT,
  side TEXT,
  raw_side TEXT,
  display_side TEXT,
  side_type TEXT,
  line NUMERIC,
  sport TEXT,
  market_type TEXT,
  action TEXT,
  model_prob NUMERIC,
  effective_cost NUMERIC,
  edge NUMERIC,
  confidence NUMERIC,
  score NUMERIC,
  tail_score NUMERIC,
  pressure_label TEXT,
  smart_net_notional NUMERIC,
  clv_spread NUMERIC,
  best_cluster_quality NUMERIC,
  cluster_count INT,
  recurring_group_score NUMERIC,
  recurring_event_count INT,
  data_quality NUMERIC,
  telegram_sent BOOLEAN NOT NULL DEFAULT false,
  telegram_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_signals_slug ON signals(slug);
CREATE INDEX IF NOT EXISTS idx_signals_condition_side ON signals(condition_id, raw_side, action);
CREATE INDEX IF NOT EXISTS idx_signals_action ON signals(action);
