import { apiKeyPrefix, randomToken, sha256Hex } from "../../worker/crypto";
import { HttpError } from "../../worker/http";

import { getDb } from "./db";
import { nowIso } from "./http";
import type { GatewayKeyRow } from "./types";

const rpmWindows = new Map<string, number[]>();

export interface GatewayKeyPublic {
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

export function listGatewayKeys(): GatewayKeyPublic[] {
  return getDb()
    .query<GatewayKeyRow>("SELECT * FROM gateway_keys ORDER BY created_at DESC")
    .all()
    .map(toPublic);
}

export async function createGatewayKey(input: { name: string; accountId?: string | null; rpmLimit?: number | null }): Promise<GatewayKeyPublic & { key: string }> {
  const name = input.name.trim();
  if (!name) throw new HttpError("name is required", 400, "invalid_request");
  if (input.accountId) {
    const account = getDb().query<{ id: string }>("SELECT id FROM accounts WHERE id = ?").get(input.accountId);
    if (!account) throw new HttpError("Bound account not found", 400, "invalid_account");
  }
  const plaintext = randomToken("cmp");
  const now = nowIso();
  const id = `key_${crypto.randomUUID()}`;
  getDb().query(
    `INSERT INTO gateway_keys (id, prefix, key_hash, name, enabled, account_id, rpm_limit, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(id, apiKeyPrefix(plaintext), await sha256Hex(plaintext), name, input.accountId ?? null, input.rpmLimit ?? null, now);
  const row = requireKey(id);
  return { ...toPublic(row), key: plaintext };
}

export function patchGatewayKey(id: string, patch: { name?: string; enabled?: boolean; rpmLimit?: number | null }): GatewayKeyPublic {
  const row = requireKey(id);
  const name = patch.name !== undefined ? patch.name.trim() : row.name;
  if (!name) throw new HttpError("name is required", 400, "invalid_request");
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled;
  const rpmLimit = patch.rpmLimit !== undefined ? patch.rpmLimit : row.rpm_limit;
  getDb().query("UPDATE gateway_keys SET name = ?, enabled = ?, rpm_limit = ? WHERE id = ?").run(name, enabled, rpmLimit, id);
  return toPublic(requireKey(id));
}

export function deleteGatewayKey(id: string): void {
  requireKey(id);
  getDb().query("DELETE FROM gateway_keys WHERE id = ?").run(id);
  rpmWindows.delete(id);
}

export async function lookupGatewayKey(plaintext: string): Promise<GatewayKeyRow | null> {
  const hash = await sha256Hex(plaintext);
  const row = getDb().query<GatewayKeyRow>("SELECT * FROM gateway_keys WHERE key_hash = ?").get(hash);
  if (!row || row.revoked_at || row.enabled !== 1) return null;
  return row;
}

export function touchGatewayKey(id: string): void {
  getDb().query("UPDATE gateway_keys SET last_used_at = ? WHERE id = ?").run(nowIso(), id);
}

export function consumeRpm(id: string, limit: number | null): boolean {
  if (!limit || limit <= 0) return true;
  const now = Date.now();
  const window = (rpmWindows.get(id) ?? []).filter((stamp) => now - stamp < 60_000);
  if (window.length >= limit) {
    rpmWindows.set(id, window);
    return false;
  }
  window.push(now);
  rpmWindows.set(id, window);
  return true;
}

export function resetRpmWindows(): void {
  rpmWindows.clear();
}

function requireKey(id: string): GatewayKeyRow {
  const row = getDb().query<GatewayKeyRow>("SELECT * FROM gateway_keys WHERE id = ?").get(id);
  if (!row) throw new HttpError("Gateway key not found", 404, "not_found");
  return row;
}

function toPublic(row: GatewayKeyRow): GatewayKeyPublic {
  return {
    id: row.id,
    prefix: row.prefix,
    name: row.name,
    enabled: row.enabled === 1 && !row.revoked_at,
    accountId: row.account_id,
    rpmLimit: row.rpm_limit,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}
