"use strict";
/**
 * Node-side manager for the Bun inference relay.
 *
 * Upstream free-tier inference only accepts the Bun TLS fingerprint, so the
 * Node app proxies /inference/* through a co-located Bun process. This module
 * spawns it once, waits (asynchronously) until the loopback port accepts
 * connections, and publishes { ready, url } on a global symbol that
 * opencode-public-proxy.cjs reads for every request.
 *
 * Fail-open by design: without Bun the pool keeps working exactly as before
 * (Node -> upstream), it just keeps hitting the upstream 429 gate.
 */
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SYMBOL = Symbol.for("9router.opencodeRelay.v1");
const DEFAULT_PORT = 20129;
const READY_TIMEOUT_MS = 20000;

function state() {
  return globalThis[SYMBOL] || null;
}

/** Loopback base URL when the relay is up, "" otherwise. */
function relayUrl() {
  const s = state();
  return s && s.ready && s.url ? s.url : "";
}

function probePort(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitUntilReady(port, deadline) {
  while (Date.now() < deadline) {
    if (await probePort(port, "127.0.0.1", 500)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function bunBinary() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN;
  return "bun";
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
    child: null,
    error: null,
    startedAt: Date.now(),
  };
  globalThis[SYMBOL] = record;

  if (process.env.OPENCODE_RELAY_DISABLE === "1") {
    record.error = "disabled";
    return record;
  }

  const script =
    options.script || path.join(__dirname, "opencode-bun-relay.ts");
  const bin = bunBinary();

  let child;
  try {
    child = spawn(bin, [script], {
      env: {
        ...process.env,
        OPENCODE_RELAY_PORT: String(port),
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    record.error = error?.message || String(error);
    logger.warn?.(`[OpenCodeRelay] bun unavailable (${record.error}); inference stays on Node transport`);
    return record;
  }

  record.child = child;
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderr = (stderr + text).slice(-2000);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) logger.info?.(line.trim());
    }
  });
  child.once("error", (error) => {
    record.error = error?.message || String(error);
    record.ready = false;
    record.url = "";
    logger.warn?.(`[OpenCodeRelay] failed to start bun (${record.error}); inference stays on Node transport`);
  });
  child.once("exit", (code, signal) => {
    record.ready = false;
    record.url = "";
    if (!record.stopping && (code !== 0 || signal)) {
      record.error = `relay exited code=${code} signal=${signal || ""} ${stderr.slice(-400)}`.trim();
      logger.warn?.(`[OpenCodeRelay] ${record.error}`);
    }
  });

  const stop = () => {
    record.stopping = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", stop);

  void (async () => {
    const ready = await waitUntilReady(port, Date.now() + READY_TIMEOUT_MS);
    if (!ready) {
      record.error = record.error || "relay did not open its port";
      logger.warn?.(
        `[OpenCodeRelay] ${record.error} (bun=${bin}); inference stays on Node transport (upstream 429 expected)`,
      );
      return;
    }
    record.ready = true;
    record.url = `http://127.0.0.1:${port}`;
    logger.info?.(
      `[OpenCodeRelay] Bun transport ready at ${record.url} (${Date.now() - record.startedAt}ms)`,
    );
  })();

  return record;
}

module.exports = { SYMBOL, startBunRelay, relayUrl, DEFAULT_PORT };
