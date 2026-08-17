import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { notFound } from "../../worker/http";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

export function adminDistDir(): string {
  return process.env.ADMIN_DIST?.trim() || join(repoRoot, "admin", "dist");
}

export function isBackendPath(pathname: string): boolean {
  const clean = normalizePath(pathname);
  return clean === "/health"
    || clean === "/v1"
    || clean.startsWith("/v1/")
    || clean === "/api"
    || clean.startsWith("/api/");
}

export function serveAdminAsset(request: Request, pathname: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound();

  const clean = normalizePath(pathname);
  if (clean === "/") {
    // Relative Location so a bind-address Request.url (0.0.0.0) cannot leak
    // into the browser address bar behind Zeabur / any reverse proxy.
    return new Response(null, { status: 302, headers: { location: "/admin/" } });
  }
  if (clean !== "/admin" && !clean.startsWith("/admin/")) return notFound();

  const root = adminDistDir();
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) return notFound();

  const relativeUrl = clean === "/admin" ? "/" : clean.slice("/admin".length);
  const file = lookupFile(root, relativeUrl);
  if (file) {
    const body = readFileSync(file.path);
    const immutable = file.webPath.startsWith("assets/");
    return new Response(body, {
      headers: {
        "content-type": MIME[file.ext] || "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache"
      }
    });
  }

  if (extname(relativeUrl)) return notFound();
  return new Response(readFileSync(indexPath), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}

function lookupFile(root: string, requestPath: string): { path: string; webPath: string; ext: string } | null {
  const trimmed = requestPath.replace(/^\/+/, "");
  if (!trimmed) return null;
  const full = resolve(root, trimmed);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return { path: full, webPath: rel.replaceAll("\\", "/"), ext: extname(full).toLowerCase() };
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}
