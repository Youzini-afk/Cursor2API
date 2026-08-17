import type { Deps, Env } from "../../worker/types";

import { initAdminAuth } from "./auth";
import { closeAdminDb, initAdminDb } from "./db";
import { flushRequestLogs, startLogWorkers, stopLogWorkers } from "./logs";
import { initAdminRuntime } from "./runtime";
import { applyRuntimeBridgeTimeout } from "./settings";

export function initAdmin(env: Env, deps: Deps): void {
  initAdminRuntime(env, deps);
  initAdminDb();
  initAdminAuth();
  applyRuntimeBridgeTimeout(env);
  startLogWorkers();
}

export function shutdownAdmin(): void {
  flushRequestLogs();
  stopLogWorkers();
  closeAdminDb();
}
