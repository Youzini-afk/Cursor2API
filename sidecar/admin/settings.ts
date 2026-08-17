import { HttpError } from "../../worker/http";
import type { Env } from "../../worker/types";

import { getDb } from "./db";
import { nowIso } from "./http";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "./types";

interface SettingsRow {
  key: string;
  value: string;
  revision: number;
  updated_at: string;
}

let cache: { config: RuntimeConfig; revision: number; updatedAt: string } | undefined;

export function getSettings(): { config: RuntimeConfig; revision: number; updatedAt: string } {
  if (cache) return cache;
  const row = getDb().query<SettingsRow>("SELECT key, value, revision, updated_at FROM runtime_settings WHERE key = 'gateway'").get();
  if (!row) {
    cache = { config: structuredClone(DEFAULT_RUNTIME_CONFIG), revision: 1, updatedAt: nowIso() };
    return cache;
  }
  cache = {
    config: mergeConfig(JSON.parse(row.value) as Partial<RuntimeConfig>),
    revision: row.revision,
    updatedAt: row.updated_at
  };
  return cache;
}

export function putSettings(input: { config: Partial<RuntimeConfig>; revision: number }): { config: RuntimeConfig; revision: number; updatedAt: string } {
  const current = getSettings();
  if (input.revision !== current.revision) {
    throw new HttpError("Settings revision conflict", 409, "revision_conflict");
  }
  const next = mergeConfig({ ...current.config, ...input.config, pool: { ...current.config.pool, ...input.config.pool }, bridge: { ...current.config.bridge, ...input.config.bridge }, logs: { ...current.config.logs, ...input.config.logs }, security: { ...current.config.security, ...input.config.security } });
  const updatedAt = nowIso();
  const revision = current.revision + 1;
  getDb().query(
    "UPDATE runtime_settings SET value = ?, revision = ?, updated_at = ? WHERE key = 'gateway'"
  ).run(JSON.stringify(next), revision, updatedAt);
  cache = { config: next, revision, updatedAt };
  return cache;
}

export function applyRuntimeBridgeTimeout(env: Env): void {
  const timeout = getSettings().config.bridge.runTimeoutMs;
  if (timeout > 0) env.CURSOR_SDK_BRIDGE_TIMEOUT_MS = String(timeout);
}

export function invalidateSettingsCache(): void {
  cache = undefined;
}

function mergeConfig(input: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    pool: { ...DEFAULT_RUNTIME_CONFIG.pool, ...input.pool },
    bridge: { ...DEFAULT_RUNTIME_CONFIG.bridge, ...input.bridge },
    logs: { ...DEFAULT_RUNTIME_CONFIG.logs, ...input.logs },
    security: { ...DEFAULT_RUNTIME_CONFIG.security, ...input.security }
  };
}
