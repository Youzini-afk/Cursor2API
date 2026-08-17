export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api/admin/v1${path}`, {
    ...init,
    headers,
    credentials: "include"
  });
  const payload = await response.json().catch(() => ({})) as {
    data?: T;
    error?: { code?: string; message?: string };
  };
  if (response.status === 401 && path !== "/auth/login" && path !== "/auth/me") {
    if (window.location.pathname !== "/admin/login") {
      window.history.pushState({}, "", "/admin/login");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload.error?.code || "error", payload.error?.message || `HTTP ${response.status}`);
  }
  return payload.data as T;
}

export const api = {
  login: (password: string) => request<{ authenticated: boolean }>("/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ authenticated: boolean }>("/auth/logout", { method: "POST" }),
  me: () => request<{ authenticated: boolean }>("/auth/me"),
  overview: (period: string, refresh = false) =>
    request<Overview>(`/overview?period=${period}${refresh ? "&refresh=1" : ""}`),
  accounts: () => request<Account[]>("/accounts"),
  createAccount: (body: { cursorApiKey: string; label?: string }) =>
    request<Account>("/accounts", { method: "POST", body: JSON.stringify(body) }),
  patchAccount: (id: string, patch: Partial<Pick<Account, "enabled" | "priority" | "maxConcurrent" | "label">>) =>
    request<Account>(`/accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteAccount: (id: string) => request<{ deleted: boolean }>(`/accounts/${id}`, { method: "DELETE" }),
  verifyAccount: (id: string) => request<Account>(`/accounts/${id}/verify`, { method: "POST" }),
  resetCooldown: (id: string) => request<Account>(`/accounts/${id}/reset-cooldown`, { method: "POST" }),
  keys: () => request<GatewayKey[]>("/gateway-keys"),
  createKey: (body: { name: string; accountId?: string; rpmLimit?: number }) =>
    request<GatewayKey & { key: string }>("/gateway-keys", { method: "POST", body: JSON.stringify(body) }),
  patchKey: (id: string, patch: { name?: string; enabled?: boolean; rpmLimit?: number | null }) =>
    request<GatewayKey>(`/gateway-keys/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteKey: (id: string) => request<{ deleted: boolean }>(`/gateway-keys/${id}`, { method: "DELETE" }),
  settings: () => request<SettingsPayload>("/settings"),
  saveSettings: (body: { config: RuntimeConfig; revision: number }) =>
    request<SettingsPayload>("/settings", { method: "PUT", body: JSON.stringify(body) }),
  logs: (query: string) => request<LogPage>(`/logs${query}`),
  log: (id: string) => request<RequestLog>(`/logs/${id}`)
};

export interface Account {
  id: string;
  label: string | null;
  cursorUserId: string | null;
  cursorEmail: string | null;
  cursorName: string | null;
  hint: string | null;
  enabled: boolean;
  priority: number;
  maxConcurrent: number;
  authStatus: "active" | "reauth_required" | "decrypt_failed";
  failureCount: number;
  cooldownUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  lastVerifiedAt: string | null;
  inFlight: number;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayKey {
  id: string;
  prefix: string;
  name: string;
  enabled: boolean;
  accountId: string | null;
  rpmLimit: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface RuntimeConfig {
  pool: {
    strategy: "priority-lru";
    cooldownBaseMs: number;
    cooldownMaxMs: number;
    maxFailuresBeforeDisable: number;
  };
  bridge: { runTimeoutMs: number };
  logs: { retentionDays: number; flushIntervalMs: number; batchSize: number };
  security: { sessionTtlHours: number };
}

export interface SettingsPayload {
  config: RuntimeConfig;
  revision: number;
  updatedAt: string;
}

export interface Overview {
  period: string;
  totals: {
    requests: number;
    ok: number;
    errors: number;
    successRate: number;
    avgLatencyMs: number | null;
    avgFirstTokenMs: number | null;
  };
  trend: Array<{ bucket: string; ok: number; errors: number }>;
  topModels: Array<{ model: string; count: number }>;
  accountDistribution: Array<{ accountId: string | null; count: number }>;
  pool: { available: number; cooling: number; disabled: number; reauthRequired: number; total: number };
  recentErrors: Array<{
    id: string;
    endpoint: string;
    model: string | null;
    error: string | null;
    createdAt: string;
    accountId: string | null;
  }>;
}

export interface RequestLog {
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

export interface LogPage {
  items: RequestLog[];
  page: number;
  pageSize: number;
  total: number;
}
