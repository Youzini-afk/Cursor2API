#!/usr/bin/env node
/**
 * Container entrypoint (Zeabur / plain Docker) for the self-hosted API gateway.
 *
 * The gateway needs two processes:
 *   1. Node SDK bridge — `scripts/cursor-sdk-local-agent-bridge.mjs`, talks to
 *      Cursor through `@cursor/sdk` (Node only: gRPC over HTTP/2 + native deps).
 *      Bound to loopback, never exposed publicly.
 *   2. Bun sidecar — `sidecar/server.ts`, serves `/health` and the public
 *      `/v1/*` OpenAI + Anthropic surface on `$PORT`.
 *
 * `server.mjs start` is the local/desktop orchestrator: it daemonizes, writes
 * state into `~/.cursor2api`, and picks a random bridge port. A container needs
 * the opposite: one foreground supervisor whose lifetime *is* the container's,
 * so this script stays in the foreground, streams both children's logs to
 * stdout/stderr, forwards SIGTERM, and exits non-zero if either child dies.
 *
 * If `CURSOR_SDK_BRIDGE_URL` is already set, the bridge is assumed to be an
 * external service and only the sidecar is started.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const BRIDGE_SCRIPT = path.join(repoRoot, "scripts", "cursor-sdk-local-agent-bridge.mjs");
const SIDECAR_SCRIPT = path.join(repoRoot, "sidecar", "server.ts");

const DEFAULT_PORT = 8080;
const DEFAULT_BRIDGE_PORT = 8792;
const SHUTDOWN_GRACE_MS = 5_000;

function log(message) {
  console.log(`[entrypoint] ${message}`);
}

function parsePort(raw, fallback) {
  const value = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

function parseMillis(raw, fallback) {
  const value = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** A wildcard bind address is not dialable; connect over loopback instead. */
function dialHost(host) {
  return host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

const publicPort = parsePort(process.env.PORT, DEFAULT_PORT);
const publicHost = process.env.HOST?.trim() || "0.0.0.0";
const externalBridgeUrl = process.env.CURSOR_SDK_BRIDGE_URL?.trim() || "";
const bridgeHost = process.env.CURSOR_SDK_BRIDGE_HOST?.trim() || "127.0.0.1";
const requestedBridgePort = parsePort(process.env.CURSOR_SDK_BRIDGE_PORT, DEFAULT_BRIDGE_PORT);
// `$PORT` is assigned by the platform, so a fixed bridge port can collide with it.
const bridgePort = requestedBridgePort === publicPort
  ? (publicPort < 65_535 ? publicPort + 1 : publicPort - 1)
  : requestedBridgePort;
const bridgeToken = process.env.CURSOR_SDK_BRIDGE_TOKEN?.trim() || randomBytes(24).toString("hex");
const bridgeStartupTimeoutMs = parseMillis(process.env.BRIDGE_STARTUP_TIMEOUT_MS, 120_000);
const sidecarStartupTimeoutMs = parseMillis(process.env.SIDECAR_STARTUP_TIMEOUT_MS, 60_000);

/** name -> ChildProcess, for live children only. */
const children = new Map();
let shuttingDown = false;

function stopAll(signal = "SIGTERM") {
  for (const child of children.values()) {
    try {
      child.kill(signal);
    } catch {
      // The child is already gone; nothing to clean up.
    }
  }
}

function drainThenExit(code) {
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  const timer = setInterval(() => {
    if (children.size === 0) {
      clearInterval(timer);
      process.exit(code);
      return;
    }
    if (Date.now() >= deadline) {
      stopAll("SIGKILL");
      clearInterval(timer);
      process.exit(code);
    }
  }, 100);
}

function fail(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`fatal: ${reason}`);
  stopAll();
  drainThenExit(1);
}

function start(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit"
  });
  children.set(name, child);

  child.on("error", (error) => {
    children.delete(name);
    if (error?.code === "ENOENT") {
      fail(`'${command}' is not installed or not on PATH (required to run ${name}).`);
      return;
    }
    fail(`could not start ${name}: ${error?.message || error}`);
  });

  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    fail(`${name} exited unexpectedly (code=${code}, signal=${signal}).`);
  });

  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      await response.text().catch(() => {});
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(500);
  }

  log(`${label} was not healthy within ${timeoutMs}ms (last error: ${lastError}).`);
  return false;
}

async function main() {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`received ${signal}, stopping child processes.`);
      stopAll();
      drainThenExit(0);
    });
  }

  if (isLoopback(publicHost)) {
    log(`warning: HOST=${publicHost} only accepts local connections; the platform health check and public traffic will fail. Use 0.0.0.0.`);
  }

  let sidecarBridgeUrl = externalBridgeUrl;

  if (externalBridgeUrl) {
    log(`using external SDK bridge at ${externalBridgeUrl}; not starting a local bridge.`);
    if (!process.env.CURSOR_SDK_BRIDGE_TOKEN?.trim()) {
      log("warning: CURSOR_SDK_BRIDGE_TOKEN is not set, so the external bridge must be unauthenticated.");
    }
  } else {
    log(`starting SDK bridge (node ${process.version}) on http://${bridgeHost}:${bridgePort}/sdk`);
    start("bridge", process.execPath, [BRIDGE_SCRIPT], {
      CURSOR_SDK_BRIDGE_HOST: bridgeHost,
      CURSOR_SDK_BRIDGE_PORT: String(bridgePort),
      CURSOR_SDK_BRIDGE_TOKEN: bridgeToken
    });

    const bridgeReady = await waitForHealth(
      `http://${dialHost(bridgeHost)}:${bridgePort}/health`,
      "SDK bridge",
      bridgeStartupTimeoutMs
    );
    if (!bridgeReady) {
      fail("SDK bridge failed to start.");
      return;
    }
    log("SDK bridge is healthy.");
    sidecarBridgeUrl = `http://${dialHost(bridgeHost)}:${bridgePort}/sdk`;
  }

  log(`starting sidecar API on http://${publicHost}:${publicPort}`);
  start("sidecar", "bun", ["run", SIDECAR_SCRIPT], {
    HOST: publicHost,
    PORT: String(publicPort),
    CURSOR_SDK_BRIDGE_URL: sidecarBridgeUrl,
    CURSOR_SDK_BRIDGE_TOKEN: bridgeToken
  });

  const sidecarReady = await waitForHealth(
    `http://${dialHost(publicHost)}:${publicPort}/health`,
    "sidecar API",
    sidecarStartupTimeoutMs
  );
  if (!sidecarReady) {
    fail("sidecar API failed to start.");
    return;
  }

  log(`ready on port ${publicPort} — OpenAI: /v1, Anthropic: /, health: /health`);
}

main().catch((error) => {
  fail(error?.message || String(error));
});
