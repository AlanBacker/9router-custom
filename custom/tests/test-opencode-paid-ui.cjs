'use strict';
// Pure helpers behind the paid-egress dashboard panel: URL <-> form round-trip, redaction, defaults.
const assert = require('node:assert/strict');
const { parseTemplate, buildTemplate, maskTemplate, normalizeConfig } = require('../browser/opencode-paid-egress-ui.js');

const template = 'http://acct__cr.us;sessid.{id};sessttl.120:p%40ss%3Aword@gw.dataimpulse.com:823';

// 1. Parse without touching the network, keeping percent-encoded credentials intact.
const p = parseTemplate(template);
assert.equal(p.login, 'acct');
assert.equal(p.password, 'p@ss:word');
assert.equal(p.host, 'gw.dataimpulse.com');
assert.equal(p.port, '823');
assert.equal(p.params, 'cr.us;sessid.{id};sessttl.120');

// 2. Round-trip: rebuilding must reproduce a URL the pool can use (and that carries {id}).
const rebuilt = buildTemplate(p);
assert(rebuilt.includes('{id}'), 'the sticky placeholder survives a save from the UI');
assert.equal(parseTemplate(rebuilt).password, 'p@ss:word', 'special characters round-trip');
assert.equal(parseTemplate(rebuilt).login, 'acct');
assert.equal(parseTemplate(rebuilt).params, p.params);

// 3. Passwords with URL-hostile characters are escaped, not injected.
const escaped = buildTemplate({ login: 'a', password: 'x@y:z/w?q#f', host: 'gw.example', port: '823', params: 'cr.us;sessid.{id}' });
assert(escaped.includes(encodeURIComponent('x@y:z/w?q#f')), 'the password is percent-encoded, so it cannot break out of the userinfo');
assert.equal(parseTemplate(escaped).password, 'x@y:z/w?q#f');

// 4. A missing {id} is refused at build time: it would give every slot the same exit IP.
assert.throws(() => buildTemplate({ login: 'a', password: 'b', host: 'h', port: '1', params: 'cr.us' }), /{id}/);
assert.throws(() => buildTemplate({ login: '', password: 'b', host: 'h', port: '1', params: '{id}' }), /登录名/);
assert.throws(() => buildTemplate({ login: 'a', password: '', host: 'h', port: '1', params: '{id}' }), /密码/);

// 5. Redaction: what the panel prints must never include the password.
const masked = maskTemplate(template);
assert(!masked.includes('p%40ss') && !masked.includes('p@ss'), 'masked output hides the password');
assert(masked.includes('//***@'), 'masked output keeps the URL shape');

// 6. Defaults for a brand-new install, and coercion of junk input.
const fresh = normalizeConfig(null);
assert.equal(fresh.enabled, true);
assert.equal(fresh.count, 0);
assert.equal(fresh.concurrency, 4);
assert.equal(fresh.lines, 30);
assert.equal(fresh.drainFree, true);
assert.equal(fresh.params, 'cr.us;sessid.{id};sessttl.120');
const junk = normalizeConfig({ count: '999', concurrency: 0, lines: -5, enabled: 'yes' });
assert.equal(junk.count, 64, 'count is clamped');
assert.equal(junk.concurrency, 4, 'concurrency falls back to the default');
assert.equal(junk.lines, 1, 'lines is clamped to at least 1');
assert.equal(junk.enabled, true, 'only an explicit false disables the panel');

console.log('PASS: the paid-egress form round-trips templates, refuses a missing {id}, escapes special characters, and never prints the password.');
