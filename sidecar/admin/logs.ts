import { HttpError } from "../../worker/http";

import { applyAccountOutcome } from "./accounts";
import { getDb } from "./db";
import { nowIso, redactSecrets } from "./http";
import { getSettings } from "./settings";
import type { RequestLogRow, ResolvedAuth } from "./types";

interface InsertOp {
  kind: "insert";
  row: RequestLogRow;
}

interface UpdateOp {
  kind: "update";
  id: string;
  patch: Partial<Pick<RequestLogRow, "status" | "error" | "completed_at" | "model" | "prompt_chars" | "completion_chars" | "latency_ms" | "first_token_ms" | "cursor_agent_id" | "cursor_run_id">>;
}

type Op = InsertOp | UpdateOp;

const buffer: Op[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;
let retentionTimer: ReturnType<typeof setInterval> | undefined;

export function startLogWorkers(): void {
  stopLogWorkers();
  const interval = getSettings().config.logs.flushIntervalMs;
  flushTimer = setInterval(() => {
    flushRequestLogs();
  }, interval);
  if (typeof flushTimer === "object" && "unref" in flushTimer) flushTimer.unref();
  retentionTimer = setInterval(() => {
    pruneRequestLogs();
  }, 60 * 60 * 1000);
  if (typeof retentionTimer === "object" && "unref" in retentionTimer) retentionTimer.unref();
}

export function stopLogWorkers(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  flushTimer = undefined;
  retentionTimer = undefined;
}

export function flushRequestLogs(): void {
  if (buffer.length === 0) return;
  const batchSize = getSettings().config.logs.batchSize;
  const db = getDb();
  const apply = db.transaction(() => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, batchSize);
      for (const op of batch) {
        if (op.kind === "insert") {
          db.query(
            `INSERT INTO request_logs (
              id, endpoint, model, status, error, created_at, completed_at,
              account_id, gateway_key_id, prompt_chars, completion_chars,
              latency_ms, first_token_ms, cursor_agent_id, cursor_run_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            op.row.id,
            op.row.endpoint,
            op.row.model,
            op.row.status,
            op.row.error,
            op.row.created_at,
            op.row.completed_at,
            op.row.account_id,
            op.row.gateway_key_id,
            op.row.prompt_chars,
            op.row.completion_chars,
            op.row.latency_ms,
            op.row.first_token_ms,
            op.row.cursor_agent_id,
            op.row.cursor_run_id
          );
        } else {
          db.query(
            `UPDATE request_logs SET
              status = COALESCE(?, status),
              error = COALESCE(?, error),
              completed_at = COALESCE(?, completed_at),
              model = COALESCE(?, model),
              prompt_chars = COALESCE(?, prompt_chars),
              completion_chars = COALESCE(?, completion_chars),
              latency_ms = COALESCE(?, latency_ms),
              first_token_ms = COALESCE(?, first_token_ms),
              cursor_agent_id = COALESCE(?, cursor_agent_id),
              cursor_run_id = COALESCE(?, cursor_run_id)
             WHERE id = ?`
          ).run(
            op.patch.status ?? null,
            op.patch.error ?? null,
            op.patch.completed_at ?? null,
            op.patch.model ?? null,
            op.patch.prompt_chars ?? null,
            op.patch.completion_chars ?? null,
            op.patch.latency_ms ?? null,
            op.patch.first_token_ms ?? null,
            op.patch.cursor_agent_id ?? null,
            op.patch.cursor_run_id ?? null,
            op.id
          );
        }
      }
    }
  });
  apply();
}

export function pruneRequestLogs(): void {
  const days = getSettings().config.logs.retentionDays;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  getDb().query("DELETE FROM request_logs WHERE created_at < ?").run(cutoff);
}

export function beginRequestLog(input: {
  endpoint: string;
  auth: ResolvedAuth;
  model?: string;
  promptChars?: number;
}): RequestLogHandle {
  const id = `req_${crypto.randomUUID()}`;
  const createdAt = nowIso();
  const startedAt = Date.now();
  buffer.push({
    kind: "insert",
    row: {
      id,
      endpoint: input.endpoint,
      model: input.model ?? null,
      status: "pending",
      error: null,
      created_at: createdAt,
      completed_at: null,
      account_id: input.auth.accountId ?? null,
      gateway_key_id: input.auth.gatewayKeyId ?? null,
      prompt_chars: input.promptChars ?? 0,
      completion_chars: 0,
      latency_ms: null,
      first_token_ms: null,
      cursor_agent_id: null,
      cursor_run_id: null
    }
  });
  return new RequestLogHandle(id, startedAt, input.auth);
}

export class RequestLogHandle {
  private finished = false;
  private firstTokenMs: number | undefined;
  private model: string | undefined;
  private promptChars: number | undefined;

  constructor(
    readonly id: string,
    private readonly startedAt: number,
    private readonly auth: ResolvedAuth
  ) {}

  setMeta(meta: { model?: string; promptChars?: number }): void {
    this.model = meta.model ?? this.model;
    this.promptChars = meta.promptChars ?? this.promptChars;
    buffer.push({
      kind: "update",
      id: this.id,
      patch: {
        model: this.model,
        prompt_chars: this.promptChars
      }
    });
  }

  markFirstToken(): void {
    if (this.firstTokenMs !== undefined) return;
    this.firstTokenMs = Date.now() - this.startedAt;
  }

  finish(result: { ok: boolean; status?: string; error?: unknown; completionChars?: number; httpStatus?: number }): void {
    if (this.finished) {
      if (result.completionChars !== undefined) {
        buffer.push({ kind: "update", id: this.id, patch: { completion_chars: result.completionChars } });
      }
      return;
    }
    this.finished = true;
    const errorText = result.error
      ? redactSecrets(result.error instanceof Error ? result.error.message : String(result.error))
      : null;
    buffer.push({
      kind: "update",
      id: this.id,
      patch: {
        status: result.status ?? (result.ok ? "ok" : "error"),
        error: errorText,
        completed_at: nowIso(),
        model: this.model,
        prompt_chars: this.promptChars,
        completion_chars: result.completionChars,
        latency_ms: Date.now() - this.startedAt,
        first_token_ms: this.firstTokenMs
      }
    });
    applyAccountOutcome(this.auth, { ok: result.ok, error: result.error, status: result.httpStatus });
  }

  trackResponse(response: Response): Response {
    if (!response.body) {
      this.finish({ ok: response.ok, httpStatus: response.status });
      return response;
    }
    const handle = this;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = response.body!.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            if (next.value) {
              handle.markFirstToken();
              controller.enqueue(next.value);
            }
          }
          handle.finish({ ok: response.ok, httpStatus: response.status });
          controller.close();
        } catch (error) {
          handle.finish({ ok: false, error, httpStatus: 500 });
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      }
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}

export function listRequestLogs(input: {
  page?: number;
  status?: string;
  model?: string;
  accountId?: string;
  pageSize?: number;
}): { items: RequestLogRow[]; page: number; pageSize: number; total: number } {
  flushRequestLogs();
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 50));
  const page = Math.max(1, input.page ?? 1);
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.model) {
    where.push("model = ?");
    params.push(input.model);
  }
  if (input.accountId) {
    where.push("account_id = ?");
    params.push(input.accountId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = getDb().query<{ n: number }>(`SELECT COUNT(*) AS n FROM request_logs ${clause}`).get(...params)?.n ?? 0;
  const items = getDb()
    .query<RequestLogRow>(`SELECT * FROM request_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { items, page, pageSize, total };
}

export function getRequestLog(id: string): RequestLogRow {
  flushRequestLogs();
  const row = getDb().query<RequestLogRow>("SELECT * FROM request_logs WHERE id = ?").get(id);
  if (!row) throw new HttpError("Log not found", 404, "not_found");
  return row;
}
