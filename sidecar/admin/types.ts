export type AccountAuthStatus = "active" | "reauth_required" | "decrypt_failed";

export interface AccountRow {
  id: string;
  label: string | null;
  cursor_user_id: string | null;
  cursor_email: string | null;
  cursor_name: string | null;
  cursor_api_key_ciphertext: string;
  cursor_api_key_iv: string;
  cursor_api_key_hint: string | null;
  enabled: number;
  priority: number;
  max_concurrent: number;
  auth_status: AccountAuthStatus;
  failure_count: number;
  cooldown_until: string | null;
  last_error: string | null;
  last_used_at: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayKeyRow {
  id: string;
  prefix: string;
  key_hash: string;
  name: string;
  enabled: number;
  account_id: string | null;
  rpm_limit: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface RequestLogRow {
  id: string;
  endpoint: string;
  model: string | null;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  account_id: string | null;
  gateway_key_id: string | null;
  prompt_chars: number;
  completion_chars: number;
  latency_ms: number | null;
  first_token_ms: number | null;
  cursor_agent_id: string | null;
  cursor_run_id: string | null;
}

export interface RuntimeConfig {
  pool: {
    strategy: "priority-lru";
    cooldownBaseMs: number;
    cooldownMaxMs: number;
    maxFailuresBeforeDisable: number;
  };
  bridge: {
    runTimeoutMs: number;
  };
  logs: {
    retentionDays: number;
    flushIntervalMs: number;
    batchSize: number;
  };
  security: {
    sessionTtlHours: number;
  };
}

export interface ResolvedAuth {
  cursorApiKey: string;
  accountId?: string;
  gatewayKeyId?: string;
  /** Decrement the in-memory in-flight counter. Process-local; resets on restart. */
  release?: () => void;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  pool: {
    strategy: "priority-lru",
    cooldownBaseMs: 30_000,
    cooldownMaxMs: 1_800_000,
    maxFailuresBeforeDisable: 10
  },
  bridge: {
    runTimeoutMs: 180_000
  },
  logs: {
    retentionDays: 14,
    flushIntervalMs: 250,
    batchSize: 256
  },
  security: {
    sessionTtlHours: 168
  }
};

export const PUBLIC_ENCRYPTION_DEFAULT = "api-for-cursor";
export const GATEWAY_KEY_PREFIX = "cmp_";
export const LOCAL_API_KEY_LITERAL = "cursor-local";
