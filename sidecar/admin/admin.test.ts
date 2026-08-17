import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { encryptText, sha256Hex } from "../../worker/crypto";
import { HttpError } from "../../worker/http";

import { checkoutAccount, resetInFlight } from "./accounts";
import { isBackendPath, serveAdminAsset } from "./assets";
import { nodeRequestUrl } from "./public-url";
import { handleLogin, initAdminAuth, resetLoginRateLimit } from "./auth";
import { resetAdminDb } from "./db";
import { consumeRpm, resetRpmWindows } from "./keys";
import { extractPresentedKey, resolveAuth, resolvePassthroughKey } from "./resolve-auth";
import { handleAdminRoute } from "./routes";
import { getSettings, invalidateSettingsCache, putSettings } from "./settings";
import { LOCAL_API_KEY_LITERAL } from "./types";

const ENCRYPTION = "test-encryption-secret-with-enough-entropy";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = ENCRYPTION;
  process.env.ADMIN_PASSWORD = "correct-horse";
  process.env.ADMIN_SESSION_SECRET = "session-secret-for-admin-tests-32b";
  delete process.env.CURSOR_API_KEY;
  resetAdminDb(":memory:");
  initAdminAuth();
  resetLoginRateLimit();
  resetInFlight();
  resetRpmWindows();
  invalidateSettingsCache();
});

afterEach(() => {
  resetLoginRateLimit();
  resetInFlight();
  resetRpmWindows();
});

describe("isBackendPath", () => {
  test("protects API prefixes from SPA fallback", () => {
    expect(isBackendPath("/v1")).toBe(true);
    expect(isBackendPath("/v1/chat/completions")).toBe(true);
    expect(isBackendPath("/health")).toBe(true);
    expect(isBackendPath("/api/admin/v1/accounts")).toBe(true);
    expect(isBackendPath("/admin")).toBe(false);
    expect(isBackendPath("/admin/accounts")).toBe(false);
  });
});

describe("public request URL", () => {
  test("uses forwarded host instead of the 0.0.0.0 bind address", () => {
    expect(nodeRequestUrl({
      url: "/",
      hostHeader: "0.0.0.0:8080",
      forwardedHost: "cursor2api.zeabur.app",
      forwardedProto: "https",
      bindHost: "0.0.0.0",
      port: 8080
    })).toBe("https://cursor2api.zeabur.app/");
  });

  test("does not advertise a wildcard bind when Host is missing", () => {
    expect(nodeRequestUrl({
      url: "/health",
      bindHost: "0.0.0.0",
      port: 8080
    })).toBe("http://127.0.0.1:8080/health");
  });
});

describe("admin root redirect", () => {
  test("sends a relative Location so browsers stay on the public host", () => {
    const response = serveAdminAsset(new Request("http://0.0.0.0:8080/"), "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/");
  });
});

describe("resolvePassthroughKey", () => {
  test("keeps real Cursor keys and falls back for cursor-local", () => {
    expect(resolvePassthroughKey("crsr_live_key")).toBe("crsr_live_key");
    expect(resolvePassthroughKey(LOCAL_API_KEY_LITERAL)).toBe("");
    process.env.CURSOR_API_KEY = "crsr_from_env";
    expect(resolvePassthroughKey(LOCAL_API_KEY_LITERAL)).toBe("crsr_from_env");
    expect(resolvePassthroughKey("")).toBe("crsr_from_env");
  });
});

describe("resolveAuth", () => {
  test("passthrough path does not attach pool metadata", async () => {
    const auth = await resolveAuth(requestWithKey("crsr_direct"));
    expect(auth).toEqual({ cursorApiKey: "crsr_direct" });
  });

  test("gateway key selects the highest-priority idle account", async () => {
    await insertAccount({ id: "acct_low", key: "crsr_low", priority: 2, lastUsed: "2026-01-02T00:00:00.000Z" });
    await insertAccount({ id: "acct_high", key: "crsr_high", priority: 1, lastUsed: "2026-01-01T00:00:00.000Z" });
    const plaintext = await insertGatewayKey("pool");
    const auth = await resolveAuth(requestWithKey(plaintext));
    expect(auth?.cursorApiKey).toBe("crsr_high");
    expect(auth?.accountId).toBe("acct_high");
    expect(auth?.gatewayKeyId).toBeTruthy();
    auth?.release?.();
  });

  test("empty pool returns no_account_available", async () => {
    const plaintext = await insertGatewayKey("empty");
    await expect(resolveAuth(requestWithKey(plaintext))).rejects.toMatchObject({
      code: "no_account_available",
      status: 503
    });
  });

  test("cooling-only pool mentions cooldown", async () => {
    await insertAccount({
      id: "acct_cool",
      key: "crsr_cool",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString()
    });
    const plaintext = await insertGatewayKey("cool");
    try {
      await resolveAuth(requestWithKey(plaintext));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe("no_account_available");
      expect((error as HttpError).message).toContain("cooling");
    }
  });

  test("unknown gateway key is unauthorized (null)", async () => {
    expect(await resolveAuth(requestWithKey("cmp_unknown_key_value"))).toBeNull();
  });
});

describe("checkoutAccount", () => {
  test("skips accounts already at max_concurrent", async () => {
    await insertAccount({ id: "acct_busy", key: "crsr_busy", maxConcurrent: 1 });
    const first = await checkoutAccount();
    expect(first.row.id).toBe("acct_busy");
    await expect(checkoutAccount()).rejects.toMatchObject({ code: "no_account_available" });
    first.release();
    const second = await checkoutAccount();
    expect(second.row.id).toBe("acct_busy");
    second.release();
  });
});

describe("settings revision", () => {
  test("rejects a stale revision with 409", () => {
    const current = getSettings();
    putSettings({ config: { logs: { ...current.config.logs, retentionDays: 21 } }, revision: current.revision });
    expect(() => putSettings({ config: current.config, revision: current.revision })).toThrow(HttpError);
    try {
      putSettings({ config: current.config, revision: current.revision });
    } catch (error) {
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).code).toBe("revision_conflict");
    }
  });
});

describe("admin auth", () => {
  test("login without ADMIN_PASSWORD returns 503", async () => {
    delete process.env.ADMIN_PASSWORD;
    const response = await handleAdminRoute(
      new Request("http://127.0.0.1/api/admin/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "x" })
      }),
      "/api/admin/v1/auth/login"
    );
    expect(response.status).toBe(503);
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe("admin_unconfigured");
  });

  test("login sets a session cookie and me succeeds", async () => {
    const login = await handleLogin(jsonRequest("http://127.0.0.1/api/admin/v1/auth/login", { password: "correct-horse" }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") || "";
    expect(cookie).toContain("c2a_admin=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/admin");

    const me = await handleAdminRoute(
      new Request("http://127.0.0.1/api/admin/v1/auth/me", { headers: { cookie } }),
      "/api/admin/v1/auth/me"
    );
    expect(me.status).toBe(200);
  });

  test("wrong password is rejected and then rate limited", async () => {
    for (let i = 0; i < 8; i += 1) {
      const response = await handleLogin(jsonRequest("http://127.0.0.1/api/admin/v1/auth/login", { password: "nope" }));
      expect(response.status).toBe(401);
    }
    const limited = await handleLogin(jsonRequest("http://127.0.0.1/api/admin/v1/auth/login", { password: "nope" }));
    expect(limited.status).toBe(429);
  });
});

describe("rpm window", () => {
  test("blocks after the configured limit", () => {
    expect(consumeRpm("key_1", 2)).toBe(true);
    expect(consumeRpm("key_1", 2)).toBe(true);
    expect(consumeRpm("key_1", 2)).toBe(false);
  });
});

describe("extractPresentedKey", () => {
  test("prefers x-api-key over bearer", () => {
    const request = new Request("http://127.0.0.1/v1/models", {
      headers: { "x-api-key": "crsr_header", authorization: "Bearer crsr_bearer" }
    });
    expect(extractPresentedKey(request)).toBe("crsr_header");
  });
});

function requestWithKey(key: string): Request {
  return new Request("http://127.0.0.1/v1/models", {
    headers: { authorization: `Bearer ${key}` }
  });
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function insertAccount(input: {
  id: string;
  key: string;
  priority?: number;
  maxConcurrent?: number;
  lastUsed?: string;
  cooldownUntil?: string;
  enabled?: number;
}): Promise<void> {
  const encrypted = await encryptText(input.key, ENCRYPTION);
  const now = "2026-01-01T00:00:00.000Z";
  const { getDb } = await import("./db");
  getDb().query(
    `INSERT INTO accounts (
      id, label, cursor_user_id, cursor_email, cursor_name,
      cursor_api_key_ciphertext, cursor_api_key_iv, cursor_api_key_hint,
      enabled, priority, max_concurrent, auth_status, failure_count,
      cooldown_until, last_used_at, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.id,
    encrypted.ciphertext,
    encrypted.iv,
    input.key.slice(-4),
    input.enabled ?? 1,
    input.priority ?? 1,
    input.maxConcurrent ?? 4,
    input.cooldownUntil ?? null,
    input.lastUsed ?? null,
    now,
    now
  );
}

async function insertGatewayKey(name: string): Promise<string> {
  const { randomToken } = await import("../../worker/crypto");
  const { getDb } = await import("./db");
  const plaintext = randomToken("cmp");
  getDb().query(
    `INSERT INTO gateway_keys (id, prefix, key_hash, name, enabled, account_id, rpm_limit, created_at)
     VALUES (?, ?, ?, ?, 1, NULL, NULL, ?)`
  ).run(`key_${name}`, plaintext.slice(0, 14), await sha256Hex(plaintext), name, "2026-01-01T00:00:00.000Z");
  return plaintext;
}
