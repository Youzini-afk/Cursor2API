-- Sidecar admin SQLite schema. Do NOT put this in the repo-root migrations/
-- directory — that folder is wrangler D1 only.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT,
  cursor_user_id TEXT,
  cursor_email TEXT,
  cursor_name TEXT,
  cursor_api_key_ciphertext TEXT NOT NULL,
  cursor_api_key_iv TEXT NOT NULL,
  cursor_api_key_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 4,
  auth_status TEXT NOT NULL DEFAULT 'active',
  failure_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_error TEXT,
  last_used_at TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_cursor_user_id
ON accounts(cursor_user_id)
WHERE cursor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_enabled_priority
ON accounts(enabled, priority);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  account_id TEXT,
  rpm_limit INTEGER,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_gateway_keys_hash
ON gateway_keys(key_hash);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  account_id TEXT,
  gateway_key_id TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  completion_chars INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  first_token_ms INTEGER,
  cursor_agent_id TEXT,
  cursor_run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created
ON request_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_logs_account_created
ON request_logs(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
