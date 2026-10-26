'use strict';
// The dashboard owns the paid-exit configuration (settings.opencodePaidEgress). The pool must
// follow it without a restart, honour its caps, prune slots that are removed, re-mint every slot
// on request, respect the drain switch, and never publish credentials back to the browser.
const assert = require('node:assert/strict');
const { createPool } = require('../server/opencode-public-proxy.cjs');

const SESSION = 'ses_0123456789abABCDEFGHIJKLMN';
const sse = () => new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const inference = 'https://opencode.ai/inference/openai/v1/chat/completions';
const business = session => ({ method: 'POST', headers: { authorization: 'Bearer public', 'x-opencode-session': session }, body: '{"model":"test-free"}' });
const SECRET = 's3cretPassw0rd';
const template = `http://acct__cr.us;sessid.{id};sessttl.120:${SECRET}@paid.example:823`;

globalThis[Symbol.for('9router.opencodeAnonymous.v1')] = { getManagedSession: () => SESSION };

// Note: no paidEgressFile and no paidEgressTemplate here - only the dashboard config drives paid.
const config = {
  sources: ['https://lists.example/proxies'], ipCheckUrl: 'https://ip.example', targetCheckUrl: 'https://opencode.ai/inference/v1/models',
  healthMaxAgeSeconds: 900, sourceRefreshSeconds: 600, probeTimeoutMs: 500, maxCandidates: 100, maxSourceBytes: 10000, maxCandidatesPerRound: 20,
  probeConcurrency: 2, replenishIntervalSeconds: 1, inferenceValidation: true, probeModels: ['test-free'], inferenceConcurrency: 2,
  inferenceProbesPerMinute: 100, inferenceAttemptsPerLine: 1, inferenceTimeoutMs: 2000,
  screenInference: true, screenModel: 'test-free', screenSessions: 2, screenBlockedCooldownSeconds: 900,
  allowProxySharing: true, maxConcurrentPerEgress: 1, maxLinesPerEgress: 1, egressFailureThreshold: 3, maxEgressCooldownMs: 900000,
  admissionWaitMs: 3000, admissionShortWaitMs: 1000,
  maxPaidConcurrentPerEgress: 4, maxPaidLinesPerEgress: 30
};

function fixture() {
  let clock = 100000, saved;
  const warns = [];
  const connections = [{ id: 'id0', name: 'line0', session: 'session0' }, { id: 'id1', name: 'line1', session: 'session1' }];
  const freeIps = { 'http://8.8.8.8:3128': '9.9.9.9', 'http://1.1.1.1:8080': '149.112.112.112' };
  const db = { enabled: true, template, count: 2, concurrency: 2, lines: 7, drainFree: true };
  const ipOf = url => {
    const u = String(url || '');
    if (u.includes('8.8.8.8:3128')) return '9.9.9.9';
    if (u.includes('1.1.1.1:8080')) return '149.112.112.112';
    const m = /sessid\.([0-9a-f]+)/.exec(u);
    return m ? '45.33.1.' + (parseInt(m[1].slice(0, 2), 16) % 200 + 10) : '4.2.2.2';
  };
  const nativeFetch = async (u, init = {}) => {
    const url = init.dispatcher?.url;
    if (u === config.sources[0]) return new Response(Object.keys(freeIps).map(x => x.replace('http://', '')).join('\n'));
    if (u === config.ipCheckUrl) return Response.json({ ip: url ? ipOf(url) : '4.2.2.2' });
    if (u === config.targetCheckUrl) return Response.json({ data: [] });
    if (String(init.body || '').includes('Reply OK.')) return sse();
    return new Response('{}');
  };
  const pool = createPool({
    nativeFetch, makeAgent: url => ({ url, destroy() { return Promise.resolve() } }), config, now: () => clock,
    logger: { info() {}, warn: m => warns.push(String(m)) },
    storage: {
      read: () => ({ config: { enabled: true, targetCount: 1, autoRecover429: true, probeModels: ['test-free'] }, paid: { ...db }, connections }),
      load: () => saved, save: v => { saved = v }, status() {}
    }
  });
  const paidUrls = () => ((saved && saved.entries) || []).filter(e => /paid\.example/.test(e.url)).map(e => e.url);
  return { pool, warns, db, paidUrls, state: () => saved, advance: ms => { clock += ms } };
}

(async () => {
  const f = fixture();
  await f.pool.refresh();

  // 1. Dashboard config alone drives paid exits, including its caps.
  let s = f.pool.snapshot();
  assert.equal(s.paidEgresses, 2, 'two slots are minted from the dashboard template');
  assert.equal(s.paidSlots.length, 2, 'per-slot detail is published for the dashboard');
  assert.equal(s.paidSlots[0].concurrency, 2, 'per-exit concurrency comes from the dashboard');
  assert.equal(s.paidSlots[0].linesLimit, 7, 'per-exit line budget comes from the dashboard');
  assert.equal(s.paidCapacity, 14, 'capacity = slots x line budget');
  assert(s.paidSlots.every(x => x.egress && x.ok), 'each slot reports its exit IP and health');

  // 2. Credentials never reach the published snapshot (the dashboard polls it every 3s).
  const json = JSON.stringify(s);
  assert(!json.includes(SECRET), 'the proxy password must never be published');
  assert(!json.includes('acct__cr.us'), 'the login/params must not be published either');

  // 3. The dashboard switch turns paid exits off and traffic falls back to the free pool.
  const res = await f.pool.fetch(inference, business('session0'));
  await res.text();
  assert.equal(res.status, 200, 'a line serves through a paid exit');
  let line0 = f.pool.snapshot().lines.find(l => l.name === 'line0');
  assert(line0 && /\*\*\*@/.test(line0.proxyUrl), 'the published per-line URL is redacted: ' + (line0 && line0.proxyUrl));

  f.db.enabled = false;
  f.advance(2000);
  await f.pool.refresh();
  s = f.pool.snapshot();
  assert.equal(s.paidEgresses, 0, 'switching paid exits off removes them');
  assert.equal(s.paidSlots.length, 0, 'no paid slots are reported while off');
  const freeRes = await f.pool.fetch(inference, business('session0'));
  await freeRes.text();
  assert.equal(freeRes.status, 200, 'traffic still works through the free pool');
  line0 = f.pool.snapshot().lines.find(l => l.name === 'line0');
  assert(line0 && !/paid\.example/.test(line0.proxyUrl), 'the line moved off the paid pool');

  // 4. The drain switch is honoured: off keeps the line on free, on moves it to paid.
  f.db.enabled = true;
  f.db.drainFree = false;
  f.advance(2000);
  await f.pool.refresh();
  const stay = await f.pool.fetch(inference, business('session0'));
  await stay.text();
  line0 = f.pool.snapshot().lines.find(l => l.name === 'line0');
  assert(line0 && !/paid\.example/.test(line0.proxyUrl), 'drainFree=false leaves the line where it is');

  f.db.drainFree = true;
  f.advance(2000);
  await f.pool.refresh();
  const moved = await f.pool.fetch(inference, business('session0'));
  await moved.text();
  line0 = f.pool.snapshot().lines.find(l => l.name === 'line0');
  assert(line0 && /paid\.example/.test(line0.proxyUrl), 'drainFree=true rebinds the line onto paid');

  // 5. "Give me new IPs" re-mints every slot.
  const before = f.paidUrls();
  f.db.mintNonce = Date.now();
  f.advance(2000);
  await f.pool.refresh();
  const after = f.paidUrls();
  assert(after.length === before.length, 'the slot count is unchanged by a re-mint');
  assert(after.some(u => !before.includes(u)), 'every slot was re-minted to a new exit');
  assert(f.warns.some(w => w.includes('re-minting every slot')), 'the re-mint is logged');

  // 6. Reducing the slot count prunes the extra slot instead of leaving it serving.
  f.db.count = 1;
  f.advance(2000);
  await f.pool.refresh();
  s = f.pool.snapshot();
  assert.equal(s.paidSlots.length, 1, 'the removed slot is pruned');
  assert(f.paidUrls().length === 1, 'the pruned slot no longer persists');

  console.log('PASS: dashboard-configured paid exits honour count/caps, drive the drain switch, re-mint on request, prune removed slots, and never publish credentials.');
})().catch(e => { console.error(e); process.exitCode = 1; });
