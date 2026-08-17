import { HttpError } from "../../worker/http";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function adminJson(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ data }), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...headerRecord(init.headers) }
  });
}

export function adminError(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: JSON_HEADERS
  });
}

export function adminErrorFromUnknown(error: unknown): Response {
  if (error instanceof HttpError) {
    return adminError(error.code, error.message, error.status);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return adminError("internal_error", message, 500);
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new HttpError("Content-Type must be application/json", 415, "unsupported_media_type");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError("Invalid JSON body", 400, "invalid_json");
  }
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function redactSecrets(value: string): string {
  return value
    .replace(/crsr_[A-Za-z0-9_-]+/gi, "crsr_***")
    .replace(/cmp_[A-Za-z0-9_-]+/gi, "cmp_***");
}

export function isAuthenticationFailure(error: unknown, status?: number): boolean {
  if (status === 401) return true;
  if (error instanceof HttpError && (error.status === 401 || error.code === "unauthorized" || error.code === "cursor_unauthorized")) {
    return true;
  }
  const values = flattenErrorValues(error);
  return values.some((item) => {
    const name = String(item?.name || "").toLowerCase();
    const code = String(item?.code || "").toLowerCase();
    const message = String(item?.message || "").toLowerCase();
    const parsedStatus = Number(item?.status);
    return parsedStatus === 401
      || name.includes("authentication")
      || code === "unauthorized"
      || code === "authentication_error"
      || code === "cursor_unauthorized"
      || message.includes("authentication error")
      || message.includes("missing or invalid authorization")
      || message.includes("invalid authorization")
      || message.includes("invalid cursor api key")
      || message.includes("unauthorized");
  });
}

function flattenErrorValues(error: unknown): Array<Record<string, unknown>> {
  const seen = new Set<unknown>();
  const out: Array<Record<string, unknown>> = [];
  const walk = (value: unknown) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "object") {
      out.push(value as Record<string, unknown>);
      const record = value as { cause?: unknown; error?: unknown };
      walk(record.cause);
      walk(record.error);
    }
  };
  walk(error);
  return out;
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}
