import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { adminError, adminJson, nowIso, readJsonBody } from "./http";
import { getSettings } from "./settings";

const COOKIE_NAME = "c2a_admin";
const COOKIE_PATH = "/api/admin";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const SCRYPT_SALT = "cursor2api-admin-login";

interface SessionPayload {
  v: 1;
  iat: number;
  exp: number;
}

const loginFailures = new Map<string, { count: number; resetAt: number }>();

let sessionSecret = "";

export function initAdminAuth(): void {
  const configured = process.env.ADMIN_SESSION_SECRET?.trim();
  if (configured) {
    sessionSecret = configured;
    return;
  }
  sessionSecret = randomBytes(32).toString("hex");
  console.warn("[admin] ADMIN_SESSION_SECRET is not set; login sessions will reset on restart.");
}

export function adminPasswordConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD?.trim());
}

export function adminUnavailableResponse(): Response {
  console.error("[admin] ADMIN_PASSWORD is not set; refusing all /api/admin requests.");
  return adminError(
    "admin_unconfigured",
    "ADMIN_PASSWORD is not set. The admin API is disabled until a password is configured.",
    503
  );
}

export async function handleLogin(request: Request): Promise<Response> {
  if (!adminPasswordConfigured()) return adminUnavailableResponse();
  const ip = clientIp(request);
  const limited = loginRateLimited(ip);
  if (limited) {
    return adminError("rate_limited", "Too many failed login attempts. Try again later.", 429);
  }

  const body = await readJsonBody<{ password?: unknown }>(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (!passwordsEqual(password, process.env.ADMIN_PASSWORD || "")) {
    recordLoginFailure(ip);
    return adminError("invalid_credentials", "Invalid password", 401);
  }
  clearLoginFailures(ip);

  const ttlHours = getSettings().config.security.sessionTtlHours;
  const token = signSession(ttlHours);
  const maxAge = Math.max(1, Math.floor(ttlHours * 3600));
  return adminJson(
    { authenticated: true },
    { headers: { "set-cookie": serializeCookie(token, maxAge, isHttps(request)) } }
  );
}

export function handleLogout(request: Request): Response {
  return adminJson(
    { authenticated: false },
    { headers: { "set-cookie": serializeCookie("", 0, isHttps(request)) } }
  );
}

export function handleMe(): Response {
  return adminJson({ authenticated: true });
}

export function requireAdminSession(request: Request): Response | null {
  if (!adminPasswordConfigured()) return adminUnavailableResponse();
  const token = readCookie(request, COOKIE_NAME);
  if (!token || !verifySession(token)) {
    return adminError("unauthorized", "Admin session required", 401);
  }
  return null;
}

function passwordsEqual(provided: string, expected: string): boolean {
  const left = scryptSync(provided, SCRYPT_SALT, 32);
  const right = scryptSync(expected, SCRYPT_SALT, 32);
  return timingSafeEqual(left, right);
}

function signSession(ttlHours: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    v: 1,
    iat: now,
    exp: now + Math.max(3600, Math.floor(ttlHours * 3600))
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecretOrThrow()).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifySession(token: string): boolean {
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return false;
  const expected = createHmac("sha256", sessionSecretOrThrow()).update(encoded).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    return payload.v === 1 && Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function sessionSecretOrThrow(): string {
  if (!sessionSecret) initAdminAuth();
  return sessionSecret;
}

function serializeCookie(value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    return trimmed.slice(name.length + 1);
  }
  return "";
}

function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  return new URL(request.url).protocol === "https:";
}

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "local";
}

function loginRateLimited(ip: string): boolean {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() >= entry.resetAt) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now >= entry.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

export function resetLoginRateLimit(): void {
  loginFailures.clear();
}

export function loginRateLimitState(ip: string): { count: number } {
  return { count: loginFailures.get(ip)?.count ?? 0 };
}

/** Exported for tests. */
export const authTest = {
  signSession,
  verifySession,
  passwordsEqual,
  COOKIE_NAME,
  nowIso
};
