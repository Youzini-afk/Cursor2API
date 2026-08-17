import { accountIdForCursor, decryptText, encryptText, sha256Hex } from "../../worker/crypto";
import { verifyCursorApiKey } from "../../worker/cursor";
import { HttpError } from "../../worker/http";

import { requireStoreEncryptionKey } from "./crypto-guard";
import { getDb } from "./db";
import { isAuthenticationFailure, nowIso, redactSecrets } from "./http";
import { adminDeps, adminEnv } from "./runtime";
import { getSettings } from "./settings";
import type { AccountAuthStatus, AccountRow, ResolvedAuth } from "./types";

/**
 * In-flight request counts are process-local. A restart resets them to zero,
 * which is acceptable because the sidecar is a single instance and in-memory
 * SDK sessions reset the same way.
 */
const inFlight = new Map<string, number>();

export interface AccountPublic {
  id: string;
  label: string | null;
  cursorUserId: string | null;
  cursorEmail: string | null;
  cursorName: string | null;
  hint: string | null;
  enabled: boolean;
  priority: number;
  maxConcurrent: number;
  authStatus: AccountAuthStatus;
  failureCount: number;
  cooldownUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  lastVerifiedAt: string | null;
  inFlight: number;
  createdAt: string;
  updatedAt: string;
}

export function listAccounts(): AccountPublic[] {
  const rows = getDb().query<AccountRow>("SELECT * FROM accounts ORDER BY priority ASC, created_at ASC").all();
  return rows.map(toPublic);
}

export function getAccount(id: string): AccountPublic {
  return toPublic(requireAccount(id));
}

export async function createAccount(input: { cursorApiKey: string; label?: string }): Promise<AccountPublic> {
  const cursorApiKey = input.cursorApiKey.trim();
  if (!cursorApiKey) throw new HttpError("cursorApiKey is required", 400, "invalid_request");
  const secret = requireStoreEncryptionKey();
  const me = await verifyCursorApiKey(adminEnv(), adminDeps(), cursorApiKey);
  const now = nowIso();
  const cursorUserId = me.userId === undefined ? null : String(me.userId);
  const cursorEmail = me.userEmail || null;
  const cursorName = [me.userFirstName, me.userLastName].filter(Boolean).join(" ").trim() || me.apiKeyName || null;
  const id = await accountIdForCursor(cursorUserId, cursorEmail, await sha256Hex(cursorApiKey));
  const encrypted = await encryptText(cursorApiKey, secret);
  const existing = getDb().query<AccountRow>("SELECT * FROM accounts WHERE id = ?").get(id);
  if (existing) throw new HttpError("This Cursor account is already in the pool", 409, "account_exists");

  getDb().query(
    `INSERT INTO accounts (
      id, label, cursor_user_id, cursor_email, cursor_name,
      cursor_api_key_ciphertext, cursor_api_key_iv, cursor_api_key_hint,
      enabled, priority, max_concurrent, auth_status, failure_count,
      created_at, updated_at, last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 4, 'active', 0, ?, ?, ?)`
  ).run(
    id,
    input.label?.trim() || null,
    cursorUserId,
    cursorEmail,
    cursorName,
    encrypted.ciphertext,
    encrypted.iv,
    cursorApiKey.slice(-4),
    now,
    now,
    now
  );
  return getAccount(id);
}

export function patchAccount(id: string, patch: AccountPatch): AccountPublic {
  const current = requireAccount(id);
  const next = applyPatch(current, patch);
  persistAccount(next);
  return toPublic(next);
}

export function patchAccounts(ids: string[], patch: AccountPatch): AccountPublic[] {
  return ids.map((id) => patchAccount(id, patch));
}

export function deleteAccount(id: string): void {
  requireAccount(id);
  getDb().query("DELETE FROM accounts WHERE id = ?").run(id);
  inFlight.delete(id);
}

export async function verifyAccount(id: string): Promise<AccountPublic> {
  const row = requireAccount(id);
  const secret = requireStoreEncryptionKey();
  let cursorApiKey: string;
  try {
    cursorApiKey = await decryptText(row.cursor_api_key_ciphertext, row.cursor_api_key_iv, secret);
  } catch {
    markDecryptFailed(id);
    throw new HttpError("Failed to decrypt this account's Cursor key. Check ENCRYPTION_KEY.", 500, "decrypt_failed");
  }
  const me = await verifyCursorApiKey(adminEnv(), adminDeps(), cursorApiKey);
  const now = nowIso();
  getDb().query(
    `UPDATE accounts SET
      cursor_user_id = ?, cursor_email = ?, cursor_name = ?,
      auth_status = 'active', last_error = NULL, last_verified_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    me.userId === undefined ? null : String(me.userId),
    me.userEmail || null,
    [me.userFirstName, me.userLastName].filter(Boolean).join(" ").trim() || me.apiKeyName || null,
    now,
    now,
    id
  );
  return getAccount(id);
}

export function resetCooldown(id: string): AccountPublic {
  const now = nowIso();
  requireAccount(id);
  getDb().query(
    "UPDATE accounts SET cooldown_until = NULL, failure_count = 0, last_error = NULL, updated_at = ? WHERE id = ?"
  ).run(now, id);
  return getAccount(id);
}

export async function checkoutAccount(boundAccountId?: string | null): Promise<{ row: AccountRow; cursorApiKey: string; release: () => void }> {
  const now = Date.now();
  const candidates = listSelectable(now, boundAccountId);
  if (candidates.length === 0) {
    throwNoAccount(now, boundAccountId);
  }
  const selected = candidates[0];
  let cursorApiKey: string;
  try {
    cursorApiKey = await decryptText(selected.cursor_api_key_ciphertext, selected.cursor_api_key_iv, requireStoreEncryptionKey());
  } catch {
    markDecryptFailed(selected.id);
    throw new HttpError("Failed to decrypt the selected account's Cursor key. Check ENCRYPTION_KEY.", 500, "decrypt_failed");
  }

  const usedAt = nowIso();
  getDb().query("UPDATE accounts SET last_used_at = ?, updated_at = ? WHERE id = ?").run(usedAt, usedAt, selected.id);
  incrementInFlight(selected.id);
  return {
    row: { ...selected, last_used_at: usedAt, updated_at: usedAt },
    cursorApiKey,
    release: () => decrementInFlight(selected.id)
  };
}

export function recordAccountSuccess(accountId: string): void {
  const now = nowIso();
  getDb().query(
    "UPDATE accounts SET failure_count = 0, cooldown_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?"
  ).run(now, accountId);
}

export function recordAccountFailure(accountId: string, error: unknown): void {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  if (isAuthStatusFailure(error)) {
    markReauthRequired(accountId, message);
    return;
  }
  const row = getDb().query<AccountRow>("SELECT * FROM accounts WHERE id = ?").get(accountId);
  if (!row) return;
  const settings = getSettings().config.pool;
  const failureCount = row.failure_count + 1;
  const delay = Math.min(settings.cooldownBaseMs * 2 ** Math.max(0, failureCount - 1), settings.cooldownMaxMs);
  const cooldownUntil = new Date(Date.now() + delay).toISOString();
  const disable = failureCount >= settings.maxFailuresBeforeDisable;
  getDb().query(
    `UPDATE accounts SET
      failure_count = ?, cooldown_until = ?, last_error = ?,
      enabled = CASE WHEN ? THEN 0 ELSE enabled END,
      updated_at = ?
     WHERE id = ?`
  ).run(failureCount, cooldownUntil, message.slice(0, 500), disable ? 1 : 0, nowIso(), accountId);
}

export function accountPoolHealth(): { available: number; cooling: number; disabled: number; reauthRequired: number; total: number } {
  const now = new Date().toISOString();
  const rows = getDb().query<AccountRow>("SELECT * FROM accounts").all();
  let available = 0;
  let cooling = 0;
  let disabled = 0;
  let reauthRequired = 0;
  for (const row of rows) {
    if (row.auth_status === "reauth_required") reauthRequired += 1;
    if (!row.enabled) {
      disabled += 1;
      continue;
    }
    if (row.cooldown_until && row.cooldown_until > now) {
      cooling += 1;
      continue;
    }
    if (row.auth_status === "active" && (inFlight.get(row.id) ?? 0) < row.max_concurrent) {
      available += 1;
    }
  }
  return { available, cooling, disabled, reauthRequired, total: rows.length };
}

export function applyAccountOutcome(auth: ResolvedAuth, result: { ok: boolean; error?: unknown; status?: number }): void {
  if (!auth.accountId) return;
  if (result.ok) {
    recordAccountSuccess(auth.accountId);
    return;
  }
  recordAccountFailure(auth.accountId, result.error ?? new Error(`request failed (${result.status ?? "error"})`));
}

export function resetInFlight(): void {
  inFlight.clear();
}

function listSelectable(nowMs: number, boundAccountId?: string | null): AccountRow[] {
  const now = new Date(nowMs).toISOString();
  const rows = boundAccountId
    ? getDb().query<AccountRow>("SELECT * FROM accounts WHERE id = ?").all(boundAccountId)
    : getDb().query<AccountRow>("SELECT * FROM accounts").all();

  return rows
    .filter((row) => {
      if (!row.enabled) return false;
      if (row.auth_status !== "active") return false;
      if (row.cooldown_until && row.cooldown_until > now) return false;
      return (inFlight.get(row.id) ?? 0) < row.max_concurrent;
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aUsed = a.last_used_at ?? "";
      const bUsed = b.last_used_at ?? "";
      if (aUsed !== bUsed) return aUsed < bUsed ? -1 : 1;
      return a.created_at < b.created_at ? -1 : 1;
    });
}

function throwNoAccount(nowMs: number, boundAccountId?: string | null): never {
  const now = new Date(nowMs).toISOString();
  const rows = boundAccountId
    ? getDb().query<AccountRow>("SELECT * FROM accounts WHERE id = ?").all(boundAccountId)
    : getDb().query<AccountRow>("SELECT * FROM accounts").all();
  if (rows.length === 0) {
    throw new HttpError("No Cursor accounts are configured in the pool", 503, "no_account_available");
  }
  const cooling = rows.some((row) => row.enabled && row.cooldown_until && row.cooldown_until > now);
  throw new HttpError(
    cooling
      ? "All Cursor accounts are cooling down or at capacity"
      : "No enabled Cursor accounts are available",
    503,
    "no_account_available"
  );
}

function requireAccount(id: string): AccountRow {
  const row = getDb().query<AccountRow>("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!row) throw new HttpError("Account not found", 404, "not_found");
  return row;
}

function persistAccount(row: AccountRow): void {
  getDb().query(
    `UPDATE accounts SET
      label = ?, enabled = ?, priority = ?, max_concurrent = ?, updated_at = ?
     WHERE id = ?`
  ).run(row.label, row.enabled, row.priority, row.max_concurrent, row.updated_at, row.id);
}

function applyPatch(row: AccountRow, patch: AccountPatch): AccountRow {
  return {
    ...row,
    label: patch.label !== undefined ? (patch.label?.trim() || null) : row.label,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
    priority: patch.priority !== undefined ? patch.priority : row.priority,
    max_concurrent: patch.maxConcurrent !== undefined ? patch.maxConcurrent : row.max_concurrent,
    updated_at: nowIso()
  };
}

function markDecryptFailed(id: string): void {
  getDb().query(
    "UPDATE accounts SET auth_status = 'decrypt_failed', last_error = ?, updated_at = ? WHERE id = ?"
  ).run("decrypt_failed", nowIso(), id);
}

function markReauthRequired(id: string, message: string): void {
  getDb().query(
    "UPDATE accounts SET auth_status = 'reauth_required', enabled = 0, last_error = ?, updated_at = ? WHERE id = ?"
  ).run(message.slice(0, 500), nowIso(), id);
}

function incrementInFlight(id: string): void {
  inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
}

function decrementInFlight(id: string): void {
  const next = (inFlight.get(id) ?? 1) - 1;
  if (next <= 0) inFlight.delete(id);
  else inFlight.set(id, next);
}

function toPublic(row: AccountRow): AccountPublic {
  return {
    id: row.id,
    label: row.label,
    cursorUserId: row.cursor_user_id,
    cursorEmail: row.cursor_email,
    cursorName: row.cursor_name,
    hint: row.cursor_api_key_hint,
    enabled: row.enabled === 1,
    priority: row.priority,
    maxConcurrent: row.max_concurrent,
    authStatus: row.auth_status,
    failureCount: row.failure_count,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    lastUsedAt: row.last_used_at,
    lastVerifiedAt: row.last_verified_at,
    inFlight: inFlight.get(row.id) ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isAuthStatusFailure(error: unknown): boolean {
  return isAuthenticationFailure(error);
}

export interface AccountPatch {
  enabled?: boolean;
  priority?: number;
  maxConcurrent?: number;
  label?: string | null;
}
