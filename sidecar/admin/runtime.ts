import type { Deps, Env } from "../../worker/types";

let envRef: Env | undefined;
let depsRef: Deps | undefined;

export function initAdminRuntime(env: Env, deps: Deps): void {
  envRef = env;
  depsRef = deps;
}

export function adminEnv(): Env {
  if (!envRef) throw new Error("Admin runtime is not initialized");
  return envRef;
}

export function adminDeps(): Deps {
  if (!depsRef) throw new Error("Admin runtime is not initialized");
  return depsRef;
}
