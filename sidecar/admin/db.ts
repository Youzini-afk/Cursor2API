import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";

import { DEFAULT_RUNTIME_CONFIG } from "./types";
import { nowIso } from "./http";

const SCHEMA_VERSION = 1;
const here = dirname(fileURLToPath(import.meta.url));

let db: Database | undefined;

export function dataDir(): string {
  return process.env.DATA_DIR?.trim() || join(process.cwd(), "data");
}

export function dbPath(): string {
  return join(dataDir(), "admin.db");
}

export function getDb(): Database {
  if (!db) throw new Error("Admin database is not initialized");
  return db;
}

export function initAdminDb(filename = dbPath()): Database {
  if (db) return db;
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }
  db = new Database(filename, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function closeAdminDb(): void {
  db?.close();
  db = undefined;
}

/** Test helper: replace the process-wide connection. */
export function resetAdminDb(filename = ":memory:"): Database {
  closeAdminDb();
  return initAdminDb(filename);
}

function migrate(database: Database): void {
  const row = database.query<{ user_version: number }>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  if (current < SCHEMA_VERSION) {
    const sql = readFileSync(join(here, "schema.sql"), "utf8");
    database.exec(sql);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  seedSettings(database);
}

function seedSettings(database: Database): void {
  const existing = database.query<{ key: string }>("SELECT key FROM runtime_settings WHERE key = 'gateway'").get();
  if (existing) return;
  database.query(
    "INSERT INTO runtime_settings (key, value, revision, updated_at) VALUES (?, ?, ?, ?)"
  ).run("gateway", JSON.stringify(DEFAULT_RUNTIME_CONFIG), 1, nowIso());
}
