import { accountPoolHealth } from "./accounts";
import { getDb } from "./db";
import { flushRequestLogs } from "./logs";

export type OverviewPeriod = "24h" | "7d" | "30d";

interface CacheEntry {
  expiresAt: number;
  value: OverviewData;
}

const cache = new Map<OverviewPeriod, CacheEntry>();
const CACHE_TTL_MS = 15_000;

export interface OverviewData {
  period: OverviewPeriod;
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
  pool: ReturnType<typeof accountPoolHealth>;
  recentErrors: Array<{
    id: string;
    endpoint: string;
    model: string | null;
    error: string | null;
    createdAt: string;
    accountId: string | null;
  }>;
}

export function getOverview(period: OverviewPeriod, refresh = false): OverviewData {
  flushRequestLogs();
  const cached = cache.get(period);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const value = computeOverview(period);
  cache.set(period, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function invalidateOverviewCache(): void {
  cache.clear();
}

function computeOverview(period: OverviewPeriod): OverviewData {
  const since = sinceIso(period);
  const db = getDb();
  const totals = db.query<{
    requests: number;
    ok: number;
    errors: number;
    avg_latency: number | null;
    avg_first_token: number | null;
  }>(
    `SELECT
      COUNT(*) AS requests,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      AVG(latency_ms) AS avg_latency,
      AVG(first_token_ms) AS avg_first_token
     FROM request_logs
     WHERE created_at >= ?`
  ).get(since) ?? { requests: 0, ok: 0, errors: 0, avg_latency: null, avg_first_token: null };

  const bucketExpr = period === "24h"
    ? "substr(created_at, 1, 13)"
    : "substr(created_at, 1, 10)";
  const trend = db.query<{ bucket: string; ok: number; errors: number }>(
    `SELECT ${bucketExpr} AS bucket,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
     FROM request_logs
     WHERE created_at >= ?
     GROUP BY bucket
     ORDER BY bucket ASC`
  ).all(since);

  const topModels = db.query<{ model: string; count: number }>(
    `SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS count
     FROM request_logs
     WHERE created_at >= ?
     GROUP BY model
     ORDER BY count DESC
     LIMIT 8`
  ).all(since);

  const accountDistribution = db.query<{ accountId: string | null; count: number }>(
    `SELECT account_id AS accountId, COUNT(*) AS count
     FROM request_logs
     WHERE created_at >= ?
     GROUP BY account_id
     ORDER BY count DESC
     LIMIT 12`
  ).all(since);

  const recentErrors = db.query<{
    id: string;
    endpoint: string;
    model: string | null;
    error: string | null;
    created_at: string;
    account_id: string | null;
  }>(
    `SELECT id, endpoint, model, error, created_at, account_id
     FROM request_logs
     WHERE status = 'error'
     ORDER BY created_at DESC
     LIMIT 12`
  ).all();

  const requests = Number(totals.requests ?? 0);
  const ok = Number(totals.ok ?? 0);
  const errors = Number(totals.errors ?? 0);
  return {
    period,
    totals: {
      requests,
      ok,
      errors,
      successRate: requests > 0 ? (ok / requests) * 100 : 0,
      avgLatencyMs: totals.avg_latency === null ? null : Number(totals.avg_latency),
      avgFirstTokenMs: totals.avg_first_token === null ? null : Number(totals.avg_first_token)
    },
    trend,
    topModels,
    accountDistribution,
    pool: accountPoolHealth(),
    recentErrors: recentErrors.map((row) => ({
      id: row.id,
      endpoint: row.endpoint,
      model: row.model,
      error: row.error,
      createdAt: row.created_at,
      accountId: row.account_id
    }))
  };
}

function sinceIso(period: OverviewPeriod): string {
  const ms = period === "24h" ? 24 * 60 * 60 * 1000 : period === "7d" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}
