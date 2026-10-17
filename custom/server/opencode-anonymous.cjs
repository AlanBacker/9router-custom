'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {classifyFailure} = require('./opencode-recovery-rules.cjs');
const HOOK = Symbol.for('9router.opencodeAnonymous.v1');
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function createSessionStore(file, maxSessions = 5000) {
  let entries;
  let renewedAt=new Map();
  function load() {
    if (entries) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) throw new Error('Invalid anonymous session file');
      const loaded = new Map(Object.entries(parsed.sessions));
      if (loaded.size > maxSessions || [...loaded.values()].some(s => !SESSION_RE.test(s))) throw new Error('Invalid anonymous session entries');
      entries = loaded;
      renewedAt=new Map(Object.entries(parsed.renewedAt||{}));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries = new Map();
    }
  }
  function save(next,renewals=renewedAt) {
    const tmp = file + '.' + process.pid + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify({version: 1, sessions: Object.fromEntries(next),renewedAt:Object.fromEntries(renewals)}, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  function getManagedSession(credentials) {
    if (credentials?.providerSpecificData?.opencodePoolManaged !== true || !credentials?.connectionId) return undefined;
    load();
    const id = String(credentials.connectionId);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid managed connection ID');
    if (entries.has(id)) return entries.get(id);
    if (entries.size >= maxSessions) throw new Error('Anonymous session capacity reached');
    // Use the native timestamp/counter shape. Quota errors do not renew sessions.
    const session = generateSession();
    const next = new Map(entries); next.set(id, session);
    save(next); entries = next;
    return session;
  }
  function generateSession(){
    const time = (~(BigInt(Date.now()) * 4096n + 1n) & ((1n << 48n) - 1n)).toString(16).padStart(12, '0');
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const suffix = [...crypto.randomBytes(14)].map(n => chars[n % chars.length]).join('');
    return `ses_${time}${suffix}`;
  }
  function renewInvalidSession(previous,reason){
    if(reason!=='invalid_session')return null;
    load();const pair=[...entries].find(([,session])=>session===previous);
    if(!pair)return null;const [id]=pair;
    if(Date.now()-Number(renewedAt.get(id)||0)<300000)return null;
    const replacement=generateSession(),next=new Map(entries),times=new Map(renewedAt);
    next.set(id,replacement);times.set(id,Date.now());save(next,times);entries=next;renewedAt=times;
    return replacement;
  }
  return {getManagedSession,renewInvalidSession};
}

function cooldownMs(headers, config, now) {
  let seconds = Number(config.defaultSessionCooldownSeconds) || 2;
  const retry = headers.get('retry-after');
  if (retry !== null) {
    const numeric = Number(retry);
    const value = Number.isFinite(numeric) ? numeric : (Date.parse(retry) - now) / 1000;
    if (Number.isFinite(value) && value > 0) seconds = value;
  }
  for (const name of ['reset-after', 'x-ratelimit-reset-after']) {
    const value = Number(headers.get(name));
    if (Number.isFinite(value) && value > 0) seconds = Math.max(seconds, value);
  }
  const millis = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(millis) && millis > 0) seconds = Math.max(seconds, millis / 1000);
  return Math.min(Math.max(1, Number(config.maxCooldownSeconds) || 86400) * 1000, Math.max(1000, seconds * 1000));
}

function createAnonymousFetch(nativeFetch, config, logger = console, now = Date.now) {
  const hosts = new Set(config.hosts), paths = new Set(config.paths), cooldowns = new Map();
  function remember(key, entry) {
    cooldowns.delete(key); cooldowns.set(key, entry);
    while (cooldowns.size > (config.maxCooldowns || 512)) cooldowns.delete(cooldowns.keys().next().value);
  }
  return async function anonymousFetch(input, init) {
    let url, body, headers;
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      headers = new Headers(init?.headers);
      if (!hosts.has(url.hostname) || !paths.has(url.pathname) || String(init?.method).toUpperCase() !== 'POST' || headers.get('authorization') !== 'Bearer public') return nativeFetch(input, init);
      body = JSON.parse(init.body);
      if (typeof body.model !== 'string') return nativeFetch(input, init);
    } catch { return nativeFetch(input, init); }
    if (init.signal?.aborted) throw init.signal.reason || new DOMException('Aborted', 'AbortError');
    const redirectedPath = config.routeOverrides?.[url.pathname];
    if (redirectedPath && paths.has(redirectedPath)) {
      url.pathname = redirectedPath;
      input = url.href;
    }
    const session = headers.get('x-opencode-session');
    const route = url.origin + url.pathname + '\0' + body.model;
    const egress = init[Symbol.for('9router.opencodeEgress.v1')];
    const sessionKey = route + '\0' + (egress ? 'ip:' + egress : session);
    const t = now();
    for (const key of [route, sessionKey]) {
      const entry = cooldowns.get(key);
      if (!entry) continue;
      if (entry.until <= t) { cooldowns.delete(key); continue; }
      const cachedHeaders = new Headers(entry.headers);
      cachedHeaders.set('retry-after', String(Math.max(1, Math.ceil((entry.until - t) / 1000))));
      cachedHeaders.set('x-9router-opencode-cooldown', entry.kind);
      logger.info?.(`[OpenCodeAnonymous] model=${body.model} status=429 cached=${entry.kind}`);
      return new Response(entry.body, {status: 429, headers: cachedHeaders});
    }
    const response = await nativeFetch(input, init);
    const digest = session ? crypto.createHash('sha256').update(session).digest('hex').slice(0, 12) : 'none';
    const limits = {};
    for (const [key, value] of response.headers) if (/retry|reset|ratelimit/i.test(key)) limits[key] = value;
    logger.info?.(`[OpenCodeAnonymous] route=${url.pathname} model=${body.model} session=${digest} status=${response.status} limits=${JSON.stringify(limits)}`);
    if (response.status !== 429 || /text\/event-stream/i.test(response.headers.get('content-type') || '')) return response;
    let text, detail;
    try { text = await response.clone().text(); if (text.length > 65536) return response; detail = JSON.parse(text); } catch { return response; }
    if(classifyFailure(response.status,detail).kind==='session')return response;
    const message = detail?.error?.message || detail?.message || '';
    const endpointUnavailable = /\bendpoint is unavailable\b/i.test(message);
    const kind = endpointUnavailable ? 'endpoint-unavailable' : 'session-rate-limit';
    const wait = endpointUnavailable ? Math.max((config.endpointCooldownSeconds || 5) * 1000, cooldownMs(response.headers, config, now())) : cooldownMs(response.headers, config, now());
    const safeHeaders = new Headers(response.headers);
    safeHeaders.delete('content-length'); safeHeaders.delete('content-encoding'); safeHeaders.delete('set-cookie');
    remember(endpointUnavailable ? route : sessionKey, {until: now() + wait, kind, headers: [...safeHeaders], body: text});
    logger.warn?.(`[OpenCodeAnonymous] model=${body.model} session=${digest} cooldown=${kind} seconds=${Math.ceil(wait / 1000)}; session retained`);
    if (endpointUnavailable && !response.headers.has('retry-after')) {
      const updatedHeaders = new Headers(response.headers);
      updatedHeaders.set('retry-after', String(Math.ceil(wait / 1000)));
      return new Response(response.body, {status: response.status, statusText: response.statusText, headers: updatedHeaders});
    }
    return response;
  };
}

module.exports = {createSessionStore, createAnonymousFetch, cooldownMs};
if (process.env.NINEROUTER_OPENCODE_ANONYMOUS === '1' && !globalThis[HOOK]) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'opencode-anonymous.json'), 'utf8'));
  if(process.env.DATA_DIR)config.sessionFile=config.sessionFile.replace(/^\/app\/data(?=\/|$)/,process.env.DATA_DIR);
  const store = createSessionStore(config.sessionFile, config.maxSessions);
  globalThis[HOOK] = store;
  globalThis.fetch = createAnonymousFetch(globalThis.fetch.bind(globalThis), config);
  console.info('[OpenCodeAnonymous] Enabled: persistent per-connection sessions; scoped 429 cooldowns.');
}
