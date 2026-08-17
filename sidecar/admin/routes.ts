import { HttpError } from "../../worker/http";

import { createAccount, deleteAccount, getAccount, listAccounts, patchAccount, patchAccounts, resetCooldown, verifyAccount } from "./accounts";
import { adminUnavailableResponse, handleLogin, handleLogout, handleMe, requireAdminSession } from "./auth";
import { adminError, adminErrorFromUnknown, adminJson, readJsonBody } from "./http";
import { createGatewayKey, deleteGatewayKey, listGatewayKeys, patchGatewayKey } from "./keys";
import { getRequestLog, listRequestLogs } from "./logs";
import { getOverview, type OverviewPeriod } from "./overview";
import { adminEnv } from "./runtime";
import { applyRuntimeBridgeTimeout, getSettings, putSettings } from "./settings";

export async function handleAdminRoute(request: Request, pathname: string): Promise<Response> {
  const path = pathname.replace(/\/+$/, "") || "/";
  const rest = path.slice("/api/admin/v1".length) || "/";

  try {
    if (rest === "/auth/login" && request.method === "POST") return await handleLogin(request);
    if (!process.env.ADMIN_PASSWORD?.trim()) return adminUnavailableResponse();
    if (rest === "/auth/logout" && request.method === "POST") return handleLogout(request);

    const denied = requireAdminSession(request);
    if (denied) return denied;

    if (rest === "/auth/me" && request.method === "GET") return handleMe();
    if (rest === "/overview" && request.method === "GET") return handleOverview(request);
    if (rest === "/accounts" && request.method === "GET") return adminJson(listAccounts());
    if (rest === "/accounts" && request.method === "POST") return await handleCreateAccount(request);
    if (rest === "/accounts/batch" && request.method === "PATCH") return await handleBatchAccounts(request);

    const accountVerify = /^\/accounts\/([^/]+)\/verify$/.exec(rest);
    if (accountVerify && request.method === "POST") return adminJson(await verifyAccount(decodeURIComponent(accountVerify[1])));

    const accountCooldown = /^\/accounts\/([^/]+)\/reset-cooldown$/.exec(rest);
    if (accountCooldown && request.method === "POST") return adminJson(resetCooldown(decodeURIComponent(accountCooldown[1])));

    const accountOne = /^\/accounts\/([^/]+)$/.exec(rest);
    if (accountOne) {
      const id = decodeURIComponent(accountOne[1]);
      if (request.method === "GET") return adminJson(getAccount(id));
      if (request.method === "PATCH") return await handlePatchAccount(request, id);
      if (request.method === "DELETE") {
        deleteAccount(id);
        return adminJson({ deleted: true });
      }
    }

    if (rest === "/gateway-keys" && request.method === "GET") return adminJson(listGatewayKeys());
    if (rest === "/gateway-keys" && request.method === "POST") return await handleCreateKey(request);

    const keyOne = /^\/gateway-keys\/([^/]+)$/.exec(rest);
    if (keyOne) {
      const id = decodeURIComponent(keyOne[1]);
      if (request.method === "PATCH") return await handlePatchKey(request, id);
      if (request.method === "DELETE") {
        deleteGatewayKey(id);
        return adminJson({ deleted: true });
      }
    }

    if (rest === "/settings" && request.method === "GET") {
      const settings = getSettings();
      return adminJson({ config: settings.config, revision: settings.revision, updatedAt: settings.updatedAt });
    }
    if (rest === "/settings" && request.method === "PUT") return await handlePutSettings(request);

    if (rest === "/logs" && request.method === "GET") return handleLogs(request);
    const logOne = /^\/logs\/([^/]+)$/.exec(rest);
    if (logOne && request.method === "GET") return adminJson(getRequestLog(decodeURIComponent(logOne[1])));

    return adminError("not_found", "Not found", 404);
  } catch (error) {
    return adminErrorFromUnknown(error);
  }
}

async function handleOverview(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const refresh = url.searchParams.get("refresh") === "1";
  return adminJson(getOverview(period, refresh));
}

async function handleCreateAccount(request: Request): Promise<Response> {
  const body = await readJsonBody<{ cursorApiKey?: unknown; label?: unknown }>(request);
  if (typeof body.cursorApiKey !== "string") throw new HttpError("cursorApiKey is required", 400, "invalid_request");
  const account = await createAccount({
    cursorApiKey: body.cursorApiKey,
    label: typeof body.label === "string" ? body.label : undefined
  });
  return adminJson(account, { status: 201 });
}

async function handlePatchAccount(request: Request, id: string): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(request);
  return adminJson(patchAccount(id, parseAccountPatch(body)));
}

async function handleBatchAccounts(request: Request): Promise<Response> {
  const body = await readJsonBody<{ ids?: unknown; patch?: unknown }>(request);
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
    throw new HttpError("ids must be an array of strings", 400, "invalid_request");
  }
  if (!body.patch || typeof body.patch !== "object") throw new HttpError("patch is required", 400, "invalid_request");
  return adminJson(patchAccounts(body.ids, parseAccountPatch(body.patch as Record<string, unknown>)));
}

async function handleCreateKey(request: Request): Promise<Response> {
  const body = await readJsonBody<{ name?: unknown; accountId?: unknown; rpmLimit?: unknown }>(request);
  if (typeof body.name !== "string") throw new HttpError("name is required", 400, "invalid_request");
  const created = await createGatewayKey({
    name: body.name,
    accountId: typeof body.accountId === "string" ? body.accountId : null,
    rpmLimit: typeof body.rpmLimit === "number" ? body.rpmLimit : null
  });
  return adminJson(created, { status: 201 });
}

async function handlePatchKey(request: Request, id: string): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(request);
  return adminJson(patchGatewayKey(id, {
    name: typeof body.name === "string" ? body.name : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    rpmLimit: body.rpmLimit === null ? null : typeof body.rpmLimit === "number" ? body.rpmLimit : undefined
  }));
}

async function handlePutSettings(request: Request): Promise<Response> {
  const body = await readJsonBody<{ config?: unknown; revision?: unknown }>(request);
  if (!body.config || typeof body.config !== "object") throw new HttpError("config is required", 400, "invalid_request");
  if (typeof body.revision !== "number") throw new HttpError("revision is required", 400, "invalid_request");
  const saved = putSettings({ config: body.config as never, revision: body.revision });
  applyRuntimeBridgeTimeout(adminEnv());
  return adminJson({ config: saved.config, revision: saved.revision, updatedAt: saved.updatedAt });
}

function handleLogs(request: Request): Response {
  const url = new URL(request.url);
  return adminJson(listRequestLogs({
    page: Number(url.searchParams.get("page") || "1") || 1,
    status: url.searchParams.get("status") || undefined,
    model: url.searchParams.get("model") || undefined,
    accountId: url.searchParams.get("accountId") || undefined
  }));
}

function parsePeriod(value: string | null): OverviewPeriod {
  if (value === "7d" || value === "30d" || value === "24h") return value;
  return "24h";
}

function parseAccountPatch(body: Record<string, unknown>) {
  return {
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    priority: typeof body.priority === "number" ? body.priority : undefined,
    maxConcurrent: typeof body.maxConcurrent === "number" ? body.maxConcurrent : undefined,
    label: typeof body.label === "string" || body.label === null ? body.label : undefined
  };
}
