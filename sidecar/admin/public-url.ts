/**
 * Reconstruct the URL the client actually requested.
 *
 * `HOST` is the bind address (`0.0.0.0` in the container). Using it in
 * redirects or `Request.url` sends browsers to `http://0.0.0.0:8080/...`.
 * Prefer `X-Forwarded-*` / `Host` from the platform proxy.
 */
export function isWildcardBind(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

export function nodeRequestUrl(input: {
  url?: string;
  hostHeader?: string | string[];
  forwardedHost?: string | string[];
  forwardedProto?: string | string[];
  bindHost: string;
  port: number;
}): string {
  const proto = firstHeader(input.forwardedProto) || "http";
  const host = firstHeader(input.forwardedHost) || firstHeader(input.hostHeader);
  const path = input.url || "/";
  if (host) return `${proto}://${host}${path}`;
  const bind = isWildcardBind(input.bindHost) ? "127.0.0.1" : input.bindHost;
  return `http://${bind}:${input.port}${path}`;
}

function firstHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || "";
}
