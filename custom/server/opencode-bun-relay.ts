/**
 * OpenCode inference relay, run by Bun.
 *
 * Upstream (opencode.ai) gates free-tier inference on the caller's TLS/HTTP
 * fingerprint: requests from Node/undici, curl or mitmproxy are answered with
 * 429 FreeUsageLimitError even when the body, headers and session id are
 * byte-identical to the official client, while the same request from Bun (the
 * runtime embedded in the OpenCode CLI) is accepted. The Node app therefore
 * hands every /inference/* request to this process.
 *
 * Per-request egress: the caller passes the upstream proxy URL in
 * `x-9r-egress-proxy`; it is stripped here and used as Bun's fetch proxy so the
 * request still leaves through the validated residential/datacenter exit.
 *
 * Bound to loopback only. Absolute upstream host and path are fixed, so this
 * cannot be used as an open proxy.
 */
const PORT = Number(process.env.OPENCODE_RELAY_PORT || 20129);
const UPSTREAM = process.env.OPENCODE_RELAY_UPSTREAM || "https://opencode.ai";
const TOKEN = process.env.OPENCODE_RELAY_TOKEN || "";
const MAX_BODY = 32 * 1024 * 1024;

const REQUEST_STRIP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-connection",
  "upgrade",
  "x-9r-egress-proxy",
  "x-9r-relay-token",
]);
const RESPONSE_STRIP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  maxRequestBodySize: MAX_BODY,
  async fetch(req) {
    const url = new URL(req.url);
    const authorized = !TOKEN || req.headers.get("x-9r-relay-token") === TOKEN;
    if (url.pathname === "/__9r/ping") {
      if (!authorized) return new Response("forbidden", { status: 401 });
      return Response.json({ ok: true, pid: process.pid });
    }
    if (!authorized) return new Response("forbidden", { status: 401 });
    if (!url.pathname.startsWith("/inference/")) {
      return new Response("not found", { status: 404 });
    }

    const proxy = req.headers.get("x-9r-egress-proxy") || undefined;
    const headers = new Headers();
    for (const [key, value] of req.headers) {
      if (!REQUEST_STRIP.has(key.toLowerCase())) headers.set(key, value);
    }

    let body: ArrayBuffer | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.arrayBuffer();
    }

    let upstream: Response;
    try {
      const init: RequestInit & { proxy?: string } = {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: req.signal,
      };
      if (proxy) init.proxy = proxy;
      upstream = await fetch(UPSTREAM + url.pathname + url.search, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(
        { error: { type: "RelayUpstreamError", message } },
        { status: 502 },
      );
    }

    const out = new Headers();
    for (const [key, value] of upstream.headers) {
      if (!RESPONSE_STRIP.has(key.toLowerCase())) out.set(key, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
});

const shutdown = () => {
  try {
    server.stop(true);
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `[opencode-relay] listening on 127.0.0.1:${PORT} upstream=${UPSTREAM} bun=${Bun.version}`,
);
