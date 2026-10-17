'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createCompatFetch(nativeFetch, config, logger = console) {
  const hosts = new Set(config.hosts || []);
  const paths = new Set(config.paths || []);
  // Automatic fallback may only remove these top-level reasoning controls.
  const safeFields = new Set(['thinking', 'reasoning_effort', 'reasoning', 'enable_thinking',
    'thinking_budget', 'thinkingConfig', 'output_config']);
  const fields = new Set((config.reasoningFields || []).filter(f => safeFields.has(f)));
  const rules = (config.rules || []).map(r => ({...r, pattern: new RegExp(r.modelPattern, 'i')}));
  const learned = new Map();
  const maxRetries = Math.min(2, Math.max(0, Number(config.maxRetries) || 0));
  const ttl = Math.max(1000, (Number(config.learnTtlSeconds) || 3600) * 1000);
  const capacity = Math.min(1024, Math.max(1, Number(config.maxLearnedRoutes) || 256));

  return async function thinkingCompatibleFetch(input, init) {
    let url, body;
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (!hosts.has(url.hostname) || !paths.has(url.pathname) ||
          String(init?.method || 'GET').toUpperCase() !== 'POST' || typeof init.body !== 'string') {
        return nativeFetch(input, init);
      }
      body = JSON.parse(init.body);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') return nativeFetch(input, init);
    } catch { return nativeFetch(input, init); }

    const route = url.origin + url.pathname + '\0' + body.model;
    const cached = learned.get(route);
    if (cached && cached.until <= Date.now()) learned.delete(route);
    const drop = new Set(cached?.until > Date.now() ? cached.fields : []);
    for (const rule of rules) {
      if (rule.pattern.test(body.model)) for (const field of rule.drop || []) if (safeFields.has(field)) drop.add(field);
    }
    const removed = [];
    for (const field of drop) {
      if (Object.hasOwn(body, field)) { delete body[field]; removed.push(field); }
    }
    let options = init;
    const updateBody = () => {
      const headers = new Headers(init.headers);
      headers.delete('content-length');
      options = {...init, headers, body: JSON.stringify(body)};
    };
    if (removed.length) {
      updateBody();
      logger.info?.(`[ThinkingCompat] ${url.hostname}${url.pathname} model=${body.model} removed=${removed.join(',')}`);
    }

    for (let attempt = 0; ; attempt++) {
      const response = await nativeFetch(input, options);
      if (!config.autoFallback || attempt >= maxRetries || init.signal?.aborted ||
          ![400, 422].includes(response.status) || /text\/event-stream/i.test(response.headers.get('content-type') || '')) return response;

      let error;
      try { error = await response.clone().json(); } catch { return response; }
      const detail = error?.error || error;
      const message = typeof detail?.message === 'string' ? detail.message : '';
      const code = typeof detail?.code === 'string' ? detail.code : typeof detail?.type === 'string' ? detail.type : '';
      // Invalid values, quota errors, auth errors and generic 400s must stay visible.
      if (!/unknown[_ ](?:parameter|field)|unrecognized[_ ](?:parameter|field)|unsupported[_ ](?:parameter|field)/i.test(code + ' ' + message)) return response;
      let field = typeof detail?.param === 'string' ? detail.param : null;
      if (!fields.has(field)) {
        field = message.match(/(?:unknown|unrecognized|unsupported)[_ ](?:field|parameter)\s*:?\s*["'`]([\w]+)["'`]/i)?.[1];
      }
      if (!fields.has(field) || !Object.hasOwn(body, field)) return response;
      delete body[field];
      updateBody();
      const previous = learned.get(route);
      const known = new Set(previous?.until > Date.now() ? previous.fields : []);
      known.add(field);
      learned.delete(route);
      learned.set(route, {fields: [...known], until: Date.now() + ttl});
      while (learned.size > capacity) learned.delete(learned.keys().next().value);
      logger.warn?.(`[ThinkingCompat] ${url.hostname}${url.pathname} model=${body.model} rejected=${field}; retry=${attempt + 1}/${maxRetries}; requested control omitted, upstream default applies`);
      // A schema rejection happens before generation. Do not retry successful streams.
      void response.body?.cancel().catch(() => {});
    }
  };
}

module.exports = {createCompatFetch};

if (process.env.NINEROUTER_THINKING_COMPAT === '1') {
  const marker = Symbol.for('9router.thinkingCompat.v1');
  if (!globalThis[marker]) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'thinking-compat.json'), 'utf8'));
      globalThis.fetch = createCompatFetch(globalThis.fetch.bind(globalThis), config);
      globalThis[marker] = true;
      console.info('[ThinkingCompat] Enabled: OpenCode family rules and bounded unsupported-reasoning-field fallback.');
    } catch (error) {
      console.error('[ThinkingCompat] Disabled: ' + error.message);
    }
  }
}
