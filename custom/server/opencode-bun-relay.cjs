"use strict";
/**
 * Node-side manager for the Bun inference relay.
 *
 * Upstream free-tier inference only accepts the Bun TLS fingerprint, so the
 * Node app proxies /inference/* through a co-located Bun process. This module
 * spawns it once, waits (asynchronously) until the loopback port answers a
 * token-authenticated ping, and publishes { ready, url, token } on a global
 * symbol that opencode-public-proxy.cjs reads for every request.
 *
 * Unattended by design: a crashed relay is respawned with backoff, and the
 * whole subsystem fails open (Node transport) when Bun is not installed.
 */
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SYMBOL = Symbol.for("9router.opencodeRelay.v1");
const DEFAULT_PORT = 20129;
const READY_TIMEOUT_MS = 20000;
const PING_PATH = "/__9r/ping";
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const MAX_ATTEMPTS = 6;

function state() {
  return globalThis[SYMBOL] || null;
}

/** Loopback base URL when the relay is up, "" otherwise. */
function relayUrl() {
  const s = state();
  return s && s.ready && s.url ? s.url : "";
}

function pingRelay(port, token, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: PING_PATH, method: "GET", timeout: timeoutMs, headers: { "x-9r-relay-token": token } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function waitUntilReady(port, token, deadline, alive) {
  while (Date.now() < deadline) {
    if (!alive()) return false;
    if (await pingRelay(port, token)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function bunBinary() {
  return process.env.BUN_BIN || "bun";
}

/**
 * Upstream rejects free-tier inference over IPv6 while accepting the identical
 * request over IPv4, and Bun prefers AAAA by default. The flag is passed on the
 * command line so it also covers fetch calls made before any script code runs.
 */
function dnsOrder() {
  const value = String(process.env.OPENCODE_RELAY_DNS_ORDER || "ipv4first").trim();
  return value === "verbatim" || value === "ipv6first" ? value : "ipv4first";
}

/**
 * Start the relay unless disabled. Idempotent; never throws.
 * @param {{ port?: number, script?: string, logger?: Console }} [options]
 */
function startBunRelay(options = {}) {
  const existing = state();
  if (existing) return existing;

  const logger = options.logger || console;
  const port = Number(options.port || process.env.OPENCODE_RELAY_PORT || DEFAULT_PORT);
  const record = {
    ready: false,
    url: "",
    port,
    token: crypto.randomBytes(16).toString("hex"),
    child: null,
    error: null,
    attempts: 0,
    lastReadyAt: 0,
    startedAt: Date.now(),
    stopping: false,
    dnsFlag: true,
  };
  globalThis[SYMBOL] = record;

  if (process.env.OPENCODE_RELAY_DISABLE === "1") {
    record.error = "disabled";
    return record;
  }

  const script = options.script || path.join(__dirname, "opencode-bun-relay.ts");
  const bin = bunBinary();

  const stop = () => {
    record.stopping = true;
    record.ready = false;
    record.url = "";
    try {
      record.child?.kill();
    } catch {
      /* ignore */
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", stop);

  const scheduleRestart = () => {
    if (record.stopping) return;
    record.ready = false;
    record.url = "";
    if (Date.now() - record.lastReadyAt > 300000) record.attempts = 0;
    const delay = BACKOFF_MS[Math.min(record.attempts, BACKOFF_MS.length - 1)];
    record.attempts++;
    if (record.attempts === MAX_ATTEMPTS) {
      logger.warn?.("[OpenCodeRelay] relay keeps crashing; continuing to retry at the 60s backoff cap");
    }
    logger.warn?.(`[OpenCodeRelay] restarting relay in ${delay}ms (attempt ${record.attempts})`);
    const timer = setTimeout(launch, delay);
    timer.unref?.();
  };

  function launch() {
    if (record.stopping) return;
    let child;
    const args = [...(record.dnsFlag ? [`--dns-result-order=${dnsOrder()}`] : []), script];
    try {
      child = spawn(bin, args, {
        env: { ...process.env, OPENCODE_RELAY_PORT: String(port), OPENCODE_RELAY_TOKEN: record.token },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      record.error = error?.message || String(error);
      logger.warn?.(`[OpenCodeRelay] bun unavailable (${record.error}); inference stays on Node transport`);
      return;
    }

    record.child = child;
    let captured = "";
    const log = (stream, chunk) => {
      const text = String(chunk);
      captured = (captured + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) stream?.(line.trim());
    };
    child.stdout?.on("data", (chunk) => log(logger.info?.bind(logger), chunk));
    child.stderr?.on("data", (chunk) => log(logger.info?.bind(logger), chunk));
    child.once("error", (error) => {
      record.error = error?.message || String(error);
      logger.warn?.(`[OpenCodeRelay] failed to start bun (${record.error}); inference stays on Node transport`);
    });
    child.once("exit", (code, signal) => {
      record.ready = false;
      record.url = "";
      if (record.stopping) return;
      record.error = `relay exited code=${code} signal=${signal || ""} ${captured.slice(-400)}`.trim();
      logger.warn?.(`[OpenCodeRelay] ${record.error}`);
      // An old Bun rejects the spawn flag outright. The relay script sets the same
      // DNS order itself, so retry once without the flag instead of looping forever.
      if (record.dnsFlag && /dns-result-order|unknown (flag|option)|unexpected argument|invalid option/i.test(captured)) {
        record.dnsFlag = false;
        logger.warn?.("[OpenCodeRelay] bun rejected --dns-result-order; retrying with the in-script IPv4 order");
        const timer = setTimeout(launch, 250);
        timer.unref?.();
        return;
      }
      scheduleRestart();
    });

    void (async () => {
      const alive = () => record.child === child && child.exitCode === null;
      const ready = await waitUntilReady(port, record.token, Date.now() + READY_TIMEOUT_MS, alive);
      if (!ready) {
        if (alive()) {
          record.error = record.error || `relay did not answer ${PING_PATH} within ${READY_TIMEOUT_MS}ms${captured ? " | " + captured.slice(-300).trim() : ""}`;
          logger.warn?.(`[OpenCodeRelay] ${record.error} (bun=${bin})`);
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      record.ready = true;
      record.url = `http://127.0.0.1:${port}`;
      record.error = null;
      record.attempts = 0;
      record.lastReadyAt = Date.now();
      logger.info?.(`[OpenCodeRelay] Bun transport ready at ${record.url} (${Date.now() - record.startedAt}ms)`);
    })();
  }

  launch();
  return record;
}

module.exports = { SYMBOL, startBunRelay, relayUrl, DEFAULT_PORT };
