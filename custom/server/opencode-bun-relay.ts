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
import { setDefaultResultOrder } from "node:dns";

const PORT = Number(process.env.OPENCODE_RELAY_PORT || 20129);
const UPSTREAM = process.env.OPENCODE_RELAY_UPSTREAM || "https://opencode.ai";
const TOKEN = process.env.OPENCODE_RELAY_TOKEN || "";
const MAX_BODY = 32 * 1024 * 1024;

/**
 * Upstream rejects the free tier when the connection arrives over IPv6 (the
 * same request over IPv4 is accepted), and Bun resolves AAAA first by default.
 * Force IPv4 unless the operator explicitly asks for another order.
 */
const DNS_ORDER =
  process.env.OPENCODE_RELAY_DNS_ORDER === "verbatim" || process.env.OPENCODE_RELAY_DNS_ORDER === "ipv6first"
    ? process.env.OPENCODE_RELAY_DNS_ORDER
    : "ipv4first";
try {
  setDefaultResultOrder(DNS_ORDER);
} catch {
  /* older Bun: the --dns-result-order spawn flag still applies */
}

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

type ProbeShape = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string }; name?: string }>;
  reasoning_effort?: string;
  reasoning?: { effort?: string };
};

/** Counts and names only: never logs prompts, tool arguments or message text. */
function describeRequest(body: ArrayBuffer | undefined, req: Request): string {
  const session = req.headers.get("x-opencode-session") || req.headers.get("x-session-id") ? "y" : "n";
  if (!body) return `body=none sess=${session}`;
  const parsed = JSON.parse(new TextDecoder().decode(body)) as ProbeShape;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const system = messages.find((message) => message?.role === "system");
  const systemText = typeof system?.content === "string" ? system.content : "";
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.map((tool) => tool?.function?.name || tool?.name).filter((name): name is string => Boolean(name))
    : [];
  const roles = messages.map((message) => (message?.role || "?").slice(0, 1)).join("");
  const effort = parsed.reasoning_effort || parsed.reasoning?.effort || "";
  return [
    `model=${parsed.model || "-"}`,
    `msgs=${messages.length}(${roles})`,
    `sys=${systemText.length}${systemText.startsWith("You are a title generator.") ? ":title" : ""}`,
    `tools=${tools.length}${tools.length ? `[${tools.slice(0, 13).join(",")}]` : ""}`,
    `effort=${effort || "-"}`,
    `sess=${session}`,
  ].join(" ");
}

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
    const startedAt = Date.now();

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

    // Shape-only diagnostics: counts and names, never message content.
    if (process.env.OPENCODE_RELAY_LOG !== "0") {
      try {
        const shape = describeRequest(body, req);
        console.log(
          `[opencode-relay] ${upstream.status} ${shape} via=${proxy ? "proxy" : "direct"} ${Date.now() - startedAt}ms`,
        );
      } catch {
        /* logging must never break forwarding */
      }
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
  `[opencode-relay] listening on 127.0.0.1:${PORT} upstream=${UPSTREAM} bun=${Bun.version} dns=${DNS_ORDER}`,
);
