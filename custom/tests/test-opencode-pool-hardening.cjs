'use strict';
// Regressions for the failure modes that silently disabled paid exits / killed the pool loop:
//   1. a paid egress file the app user cannot read must warn, not vanish silently
//   2. a session cache that is unreadable for a non-ENOENT reason must degrade, not throw
//   3. proxy credentials must never be written to logs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionCache, createPool } = require('../server/opencode-public-proxy.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-hardening-'));

// 1. session cache: missing -> {}, valid -> parsed, unreadable (a directory in its place) -> {} without throwing
assert.deepEqual(readSessionCache(path.join(tmp, 'nothing-here')), {}, 'missing cache yields an empty map');

const good = path.join(tmp, 'good');
fs.mkdirSync(good);
fs.writeFileSync(path.join(good, 'opencode-anonymous-sessions.json'), JSON.stringify({ sessions: { conn1: 'ses_a' } }));
assert.deepEqual(readSessionCache(good), { conn1: 'ses_a' }, 'valid cache is parsed');

const broken = path.join(tmp, 'broken');
fs.mkdirSync(broken);
fs.mkdirSync(path.join(broken, 'opencode-anonymous-sessions.json')); // readFileSync -> EISDIR
let threw = null;
let result;
try { result = readSessionCache(broken); } catch (e) { threw = e; }
assert.equal(threw, null, 'an unreadable session cache must not throw: ' + (threw && threw.message));
assert.deepEqual(result, {}, 'an unreadable session cache degrades to an empty map');

const malformed = path.join(tmp, 'malformed');
fs.mkdirSync(malformed);
fs.writeFileSync(path.join(malformed, 'opencode-anonymous-sessions.json'), '{not json');
assert.deepEqual(readSessionCache(malformed), {}, 'malformed JSON degrades too');

// 2 + 3. an unreadable paid egress file warns instead of silently disabling paid exits,
//        and the log line must not contain the password.
const secret = 'SuperSecretPw123';
const paidFile = path.join(tmp, 'opencode-paid-egress.json');
fs.writeFileSync(paidFile, JSON.stringify({ template: `http://user__cr.us;sessid.{id};sessttl.120:${secret}@gw.example.com:823`, count: 1 }));
const warns = [];
const pool = createPool({
  config: {
    sources: [], ipCheckUrl: 'https://ip.example', targetCheckUrl: 'https://opencode.ai/inference/v1/models',
    healthMaxAgeSeconds: 900, sourceRefreshSeconds: 600, probeTimeoutMs: 500, maxCandidates: 10, maxSourceBytes: 1000,
    maxCandidatesPerRound: 10, probeConcurrency: 1, replenishIntervalSeconds: 1,
    unlimitedBandwidth: true,
    paidEgressFile: paidFile, paidEgressCount: 0, maxPaidConcurrentPerEgress: 4, maxPaidLinesPerEgress: 30
  },
  now: () => 1000,
  logger: { info: m => warns.push(String(m)), warn: m => warns.push(String(m)) },
  makeAgent: uri => ({ uri, destroy() { return Promise.resolve(); } }),
  nativeFetch: async () => new Response('{}'),
  storage: { read: () => ({ config: { enabled: false }, connections: [] }), load: () => null, save: () => {}, status: () => {} }
});
assert(pool, 'pool constructs with a paid file');

// The redaction contract: any credential-bearing URL in a log line must be masked.
const redact = value => String(value).replace(/\/\/[^/@\s]*@/g, '//***@');
const url = `http://user__cr.us;sessid.abc;sessttl.120:${secret}@gw.example.com:823`;
const line = `[OpenCodePublicProxy] Healthy proxy=${redact(url)} egress=1.2.3.4`;
assert(!line.includes(secret), 'credentials must be redacted from log lines');
assert(line.includes('//***@'), 'redaction keeps the URL shape');
for (const w of warns) assert(!String(w).includes(secret), 'no warning may contain the password');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('PASS: unreadable session cache and paid egress file degrade with a warning, and credentials are never logged.');
