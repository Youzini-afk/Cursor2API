import { HttpError } from "../../worker/http";

import { checkoutAccount } from "./accounts";
import { consumeRpm, lookupGatewayKey, touchGatewayKey } from "./keys";
import { GATEWAY_KEY_PREFIX, LOCAL_API_KEY_LITERAL, type ResolvedAuth } from "./types";

/**
 * Dual-auth resolver.
 *
 * `cmp_…`  → gateway key: look up hash, pick a pool account, decrypt that
 *            account's Cursor key. `accountId` / `gatewayKeyId` are set.
 * anything else (including `crsr_…`) → passthrough. Empty / `cursor-local`
 *            falls back to `process.env.CURSOR_API_KEY`.
 */
export function extractPresentedKey(request: Request): string {
  const apiKeyHeader = (request.headers.get("x-api-key") || "").trim();
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const bearer = match ? match[1].trim() : "";
  return apiKeyHeader || bearer;
}

export function resolvePassthroughKey(presented: string): string {
  if (presented && presented !== LOCAL_API_KEY_LITERAL) return presented;
  return (process.env.CURSOR_API_KEY || "").trim();
}

export async function resolveAuth(request: Request): Promise<ResolvedAuth | null> {
  const presented = extractPresentedKey(request);
  if (presented.startsWith(GATEWAY_KEY_PREFIX)) {
    return await resolveGatewayAuth(presented);
  }
  const cursorApiKey = resolvePassthroughKey(presented);
  if (!cursorApiKey) return null;
  return { cursorApiKey };
}

async function resolveGatewayAuth(presented: string): Promise<ResolvedAuth | null> {
  const key = await lookupGatewayKey(presented);
  if (!key) return null;
  if (!consumeRpm(key.id, key.rpm_limit)) {
    throw new HttpError("Gateway key rate limit exceeded", 429, "rate_limited");
  }
  const checked = await checkoutAccount(key.account_id);
  touchGatewayKey(key.id);
  return {
    cursorApiKey: checked.cursorApiKey,
    accountId: checked.row.id,
    gatewayKeyId: key.id,
    release: checked.release
  };
}
