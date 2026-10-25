'use strict';
// The scenario that actually matters: a paid exit IP is banned WHILE it is serving traffic
// (not at boot). Two cases, both asserted end to end through the public fetch path:
//
//   Case A - one exit is refused. The caller must never see the 403: the slot is re-minted to a
//            new exit IP, the line is moved, and the request is retried transparently.
//   Case B - the whole paid pool is refused at once. That costs at most one failed request;
//            every refused slot is re-minted, no banned IP stays bound, and the next request succeeds.
const assert = require('node:assert/strict');
const { createPool } = require('../server/opencode-public-proxy.cjs');

const SESSION = 'ses_0123456789abABCDEFGHIJKLMN';
const inference = 'https://opencode.ai/inference/openai/v1/chat/completions';
const business = session => ({ method: 'POST', headers: { authorization: 'Bearer public', 'x-opencode-session': session }, body: '{"model":"test-free"}' });
const sse = () => new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

globalThis[Symbol.for('9router.opencodeAnonymous.v1')] = { getManagedSession: () => SESSION };

const config = {
  sources: ['https://lists.example/proxies'], ipCheckUrl: 'https://ip.example', targetCheckUrl: 'https://opencode.ai/inference/v1/models',
  healthMaxAgeSeconds: 900, sourceRefreshSeconds: 600, probeTimeoutMs: 500, maxCandidates: 100, maxSourceBytes: 10000,
  maxCandidatesPerRound: 20, probeConcurrency: 2, replenishIntervalSeconds: 1,
  inferenceValidation: true, probeModels: ['test-free'], inferenceConcurrency: 2, inferenceProbesPerMinute: 100,
  inferenceAttemptsPerLine: 1, inferenceTimeoutMs: 2000, inferenceRejectCooldownSeconds: 900,
  screenInference: true, screenModel: 'test-free', screenSessions: 2, screenBlockedCooldownSeconds: 900,
  allowProxySharing: true, maxConcurrentPerEgress: 1, maxLinesPerEgress: 24,
  egressFailureThreshold: 3, maxEgressCooldownMs: 900000, admissionWaitMs: 3000, admissionShortWaitMs: 1000,
  paidEgressTemplate: 'http://user-session-{id}:pass@paid.example:8080', paidEgressCount: 2,
  maxPaidConcurrentPerEgress: 4, maxPaidLinesPerEgress: 30, paidDrainFree: true
};

// banPaidBudget = how many paid exit IPs the upstream refuses (each on its first business request).
function fixture({ banPaidBudget = 0 } = {}) {
  let clock = 100000, saved;
  const warns = [], banned = new Set();
  const counters = { business403: 0, screens: 0, bans: 0 };
  const freeIps = { 'http://8.8.8.8:3128': '9.9.9.9', 'http://1.1.1.1:8080': '149.112.112.112' };
  const paidIps = new Map();
  const ipOf = url => {
    const u = String(url || '');
    if (u.includes('8.8.8.8:3128')) return '9.9.9.9';
    if (u.includes('1.1.1.1:8080')) return '149.112.112.112';
    const m = /session-([0-9a-f]+)/.exec(u);
    if (!m) return '4.2.2.2';
    // Every minted slot needs its own exit IP. Deriving the octet from two hex characters made
    // collisions possible (~0.5%), and a collision makes a banned IP take the spare slot with it.
    let ip = paidIps.get(m[1]);
    if (!ip) { ip = '45.33.1.' + (10 + paidIps.size); paidIps.set(m[1], ip); }
    return ip;
  };
  const nativeFetch = async (u, init = {}) => {
    const url = init.dispatcher?.url;
    if (u === config.sources[0]) return new Response(Object.keys(freeIps).map(x => x.replace('http://', '')).join('\n'));
    if (u === config.ipCheckUrl) return Response.json({ ip: ipOf(url) });
    if (u === config.targetCheckUrl) return Response.json({ data: [] });
    const isProbe = String(init.body || '').includes('"tools"');
    if (isProbe) { counters.screens++; return sse(); }
    // Business traffic: the upstream refuses this exit IP.
    if (/paid\.example/.test(String(url || ''))) {
      const ip = ipOf(url);
      if (!banned.has(ip) && counters.bans < banPaidBudget) {
        banned.add(ip); counters.bans++; counters.business403++;
        return Response.json({ error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode." } }, { status: 403 });
      }
    }
    return sse();
  };
  const pool = createPool({
    nativeFetch, makeAgent: url => ({ url, destroy() { return Promise.resolve(); } }), config, now: () => clock,
    logger: { info: m => warns.push(String(m)), warn: m => warns.push(String(m)) },
    storage: {
      read: () => ({ config: { enabled: true, targetCount: 1, autoRecover429: true, probeModels: ['test-free'] }, connections: [{ id: 'id0', name: 'line0', session: 'session0' }] }),
      load: () => saved, save: v => { saved = v; }, status() {}
    }
  });
  const refused = () => warns.filter(w => w.includes('refused (access)')).length;
  return { pool, warns, counters, refused, state: () => saved, advance: ms => { clock += ms; }, banned: () => [...banned] };
}

(async () => {
  // ---- Case A: one exit banned -> fully transparent to the caller ----
  const a = fixture({ banPaidBudget: 1 });
  await a.pool.refresh();
  assert.equal(a.pool.snapshot().paidEgresses, 2, 'both paid exits validate first');

  const res = await a.pool.fetch(inference, business('session0'));
  const status = res.status;
  const body = await res.text();

  assert.equal(status, 200, 'the caller must NOT see the 403 - it is retried on a fresh exit (got ' + status + ' ' + body.slice(0, 160) + ')');
  assert.equal(a.counters.business403, 1, 'the upstream refused the original paid IP exactly once');
  assert(a.refused() >= 1, 'the refused paid slot was re-minted to a new exit IP');
  assert(a.warns.some(w => w.includes('PAID egress slot=') && w.includes('refused (access)')), 'the refusal is attributed to the access/403 path');

  const bound = a.pool.getBinding('session0');
  assert(bound, 'the line is still bound after failover');
  assert(bound.paid != null, 'the line is still on a paid exit, not degraded to the free pool (egress=' + bound.egress + ', banned=' + JSON.stringify(a.banned()) + ', paidSlots=' + JSON.stringify(a.pool.snapshot().paidSlots.map(s => s.slot + ':' + s.egress + ':' + s.ok)) + ', recent=' + JSON.stringify(a.warns.slice(-4)) + ')');
  assert.notEqual(bound.egress, a.banned()[0], 'the line no longer uses the banned IP');

  const later = await a.pool.fetch(inference, business('session0'));
  await later.text();
  assert.equal(later.status, 200, 'subsequent traffic keeps working');

  // ---- Case B: the whole paid pool is refused at once ----
  const b = fixture({ banPaidBudget: 2 });
  await b.pool.refresh();
  const r1 = await b.pool.fetch(inference, business('session0'));
  await r1.text();
  assert.equal(b.banned().length, 2, 'both paid exits were refused');
  assert(b.refused() >= 1, 'refused paid slots are re-minted');
  const stuck = b.pool.getBinding('session0');
  assert(!stuck || !b.banned().includes(stuck.egress), 'a banned exit is never left bound to a line');

  b.advance(2000);
  await b.pool.refresh();
  const r2 = await b.pool.fetch(inference, business('session0'));
  const r2body = await r2.text();
  assert.equal(r2.status, 200, 'after the whole pool is refused the next request recovers onto a fresh exit (got ' + r2.status + ' ' + r2body.slice(0, 160) + ')');

  console.log('PASS: a paid exit refused mid-serving is detected, re-minted to a new IP, and the line is moved; a single refused exit is invisible to the caller, and even a full-pool refusal costs at most one request.');
})().catch(e => { console.error(e); process.exitCode = 1; });
