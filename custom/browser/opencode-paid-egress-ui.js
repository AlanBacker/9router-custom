/* 9R_OC_PAID_UI_V1 */
/*
 * Dashboard panel for the paid (residential) egress pool.
 *
 * The credentials are stored in settings.opencodePaidEgress and are never rendered: the password
 * input starts empty and an empty value means "keep the stored password". The panel only ever
 * displays the exit IPs and per-slot health reported by the runtime snapshot (which is redacted
 * server-side).
 */
(function () {
  'use strict';

  const LIMIT = 64;
  const DEFAULTS = { host: 'gw.dataimpulse.com', port: '823', params: 'cr.us;sessid.{id};sessttl.120' };

  // "http://login__params:password@host:port" -> parts (never used to display the password)
  function parseTemplate(value) {
    const out = { login: '', password: '', host: '', port: '', params: '' };
    try {
      const u = new URL(String(value || ''));
      out.host = u.hostname || '';
      out.port = u.port || '';
      const user = decodeURIComponent(u.username || '');
      const pass = decodeURIComponent(u.password || '');
      const at = user.indexOf('__');
      if (at >= 0) { out.login = user.slice(0, at); out.params = user.slice(at + 2); }
      else out.login = user;
      out.password = pass;
    } catch { /* unparseable: leave blank so the operator re-enters it */ }
    return out;
  }

  function buildTemplate(parts) {
    const login = encodeURIComponent(String(parts.login || '').trim());
    const password = encodeURIComponent(String(parts.password || ''));
    const host = String(parts.host || '').trim();
    const port = String(parts.port || '').trim();
    const params = String(parts.params || '').trim();
    if (!login) throw new Error('请填写登录名');
    if (!password) throw new Error('请填写密码');
    if (!host) throw new Error('请填写网关地址');
    if (params && !params.includes('{id}')) throw new Error('参数里必须包含 {id}，否则每个出口会是同一个 IP');
    return `http://${login}${params ? '__' + params : ''}:${password}@${host}${port ? ':' + port : ''}`;
  }

  function maskTemplate(value) {
    return String(value || '').replace(/\/\/[^/@\s]*@/, '//***@');
  }

  function normalizeConfig(input) {
    const src = input && typeof input === 'object' ? input : {};
    const parsed = parseTemplate(src.template);
    return {
      ...src,
      enabled: src.enabled !== false,
      count: Math.max(0, Math.min(LIMIT, Number(src.count) || 0)),
      concurrency: Math.max(1, Math.min(LIMIT, Number(src.concurrency) || 4)),
      lines: Math.max(1, Math.min(500, Number(src.lines) || 30)),
      drainFree: src.drainFree !== false,
      host: parsed.host || DEFAULTS.host,
      port: parsed.port || DEFAULTS.port,
      login: parsed.login,
      params: parsed.params || DEFAULTS.params,
      hasPassword: !!parsed.password
    };
  }

  async function saveConfig(fetchFn, config) {
    const r = await fetchFn('/api/settings', {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ opencodePaidEgress: config })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || '保存失败：HTTP ' + r.status);
    return body;
  }

  function install(win) {
    if (win.__9routerOpenCodePaidUiV1) return;
    win.__9routerOpenCodePaidUiV1 = true;
    const doc = win.document;
    let busy = false, polling = false;
    const onPage = () => /^\/dashboard\/providers\/(opencode|oc)\/?$/.test(decodeURIComponent(win.location.pathname));

    async function poll() {
      const panel = doc.getElementById('9router-opencode-paid');
      if (!panel || polling || !onPage()) return;
      polling = true;
      try {
        const r = await win.fetch('/api/settings', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new Error('读取失败，请确认已登录 9Router');
        const s = await r.json();
        const raw = s.opencodePaidEgress || null;
        const c = normalizeConfig(raw);
        panel._config = raw || {};
        panel._hasPassword = c.hasPassword;

        const form = panel.querySelector('form');
        if (!panel.contains(doc.activeElement) && !busy) {
          form.elements.enabled.checked = c.enabled;
          form.elements.count.value = c.count;
          form.elements.concurrency.value = c.concurrency;
          form.elements.lines.value = c.lines;
          form.elements.drainFree.checked = c.drainFree;
          form.elements.host.value = c.host;
          form.elements.port.value = c.port;
          form.elements.login.value = c.login;
          form.elements.params.value = c.params;
          form.elements.password.placeholder = c.hasPassword ? '已设置（留空不修改）' : '请输入代理密码';
        }

        const runtime = s.opencodePublicProxyRuntime || {};
        const slots = Array.isArray(runtime.paidSlots) ? runtime.paidSlots : [];
        const status = panel.querySelector('[role=status]');
        if (!raw) {
          status.textContent = '尚未配置付费出口，当前只使用免费代理池。填写下面表单并保存即可启用。';
        } else if (c.enabled === false) {
          status.textContent = '付费出口已关闭，流量全部走免费代理池。';
        } else {
          const lines = slots.map(slot =>
            `slot ${String(slot.slot).replace(/^slot/, '')} → ${slot.egress || '待检测'} · ${slot.ok ? '可用' : slot.until ? '冷却中' : '正在验证'} · ${slot.lines} 条线 · 换 IP ${slot.rotations} 次`
          );
          status.textContent =
            `付费出口 ${runtime.paidEgresses || 0} / ${c.count} 个可用 · 承载 ${runtime.paidAssigned || 0} 条线 · 容量 ${runtime.paidCapacity || 0} 条线\n` +
            `${lines.join('\n') || '等待第一轮验证…'}`;
        }

        const totals = panel.querySelector('[data-totals]');
        totals.textContent =
          `每出口并发上限 ${c.concurrency} · 每出口线路上限 ${c.lines} · ${c.drainFree ? '付费够用时清空免费绑定' : '允许免费池分担'}\n` +
          `网关 ${c.host}${c.port ? ':' + c.port : ''} · ${maskTemplate(raw && raw.template)}`;
      } catch (e) {
        const status = panel.querySelector('[role=status]');
        if (status) status.textContent = e.message;
      } finally {
        polling = false;
      }
    }

    function mount() {
      const existing = doc.getElementById('9router-opencode-paid');
      if (!onPage()) { existing?.remove(); return; }
      if (existing) return;
      const anchor = doc.getElementById('9router-opencode-public-proxy');
      if (!anchor) return; // the other panel mounts first; retry on the next tick
      const panel = doc.createElement('section');
      panel.id = '9router-opencode-paid';
      panel.setAttribute('aria-label', '付费出口（住宅 IP）');
      panel.style.cssText = 'border:1px solid #0f766e;border-radius:12px;padding:20px;margin-bottom:20px;background:rgba(13,148,136,.10);color:inherit';
      panel.innerHTML = `<h2 style="font-size:18px;font-weight:600;margin-bottom:8px">付费出口（住宅 IP）</h2>
        <p style="font-size:13px;opacity:.85;margin-bottom:14px">按流量计费的住宅代理。每个出口一个粘性会话身份；出口被封时自动换一个新 IP 并重新验证，不消耗额外费用（只按流量计费）。</p>
        <form style="display:grid;gap:10px;max-width:760px">
          <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
            <label style="display:flex;gap:7px;align-items:center"><input name="enabled" type="checkbox">启用付费出口</label>
            <label style="display:flex;gap:7px;align-items:center"><input name="drainFree" type="checkbox">付费够用时清空免费绑定</label>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap">
            <label style="font-size:13px;display:grid;gap:5px">出口数量<input name="count" type="number" min="0" max="64" step="1" value="0" required style="width:110px;border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit"></label>
            <label style="font-size:13px;display:grid;gap:5px">每出口并发<input name="concurrency" type="number" min="1" max="64" step="1" value="4" required style="width:110px;border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit"></label>
            <label style="font-size:13px;display:grid;gap:5px">每出口线路<input name="lines" type="number" min="1" max="500" step="1" value="30" required style="width:110px;border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit"></label>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap">
            <label style="font-size:13px;display:grid;gap:5px;flex:1 1 260px">网关地址<input name="host" type="text" value="gw.dataimpulse.com" required style="border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit"></label>
            <label style="font-size:13px;display:grid;gap:5px;width:110px">端口<input name="port" type="text" value="823" style="border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit"></label>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap">
            <label style="font-size:13px;display:grid;gap:5px;flex:1 1 260px">登录名<input name="login" type="text" autocomplete="off" required style="border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit"></label>
            <label style="font-size:13px;display:grid;gap:5px;flex:1 1 260px">密码<input name="password" type="password" autocomplete="new-password" placeholder="已设置（留空不修改）" style="border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit"></label>
          </div>
          <label style="font-size:13px;display:grid;gap:5px">出口参数（<code>__</code> 之后的部分，必须包含 <code>{id}</code>）<input name="params" type="text" value="cr.us;sessid.{id};sessttl.120" required style="border:1px solid #64748b;border-radius:7px;padding:8px;background:transparent;color:inherit;font-family:ui-monospace,monospace"></label>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
            <button type="submit" style="background:#0d9488;border:0;border-radius:8px;color:white;padding:9px 16px;cursor:pointer">保存配置</button>
            <button type="button" data-remint style="border:1px solid #f59e0b;border-radius:8px;padding:8px 14px;background:transparent;color:inherit;cursor:pointer">全部换成新 IP</button>
          </div>
        </form>
        <p role="status" aria-live="polite" style="font-size:13px;margin-top:12px;white-space:pre-wrap">读取状态…</p>
        <p data-totals style="font-size:12px;opacity:.8;margin-top:8px;white-space:pre-wrap"></p>
        <p style="font-size:12px;opacity:.6;margin-top:8px">密码只保存在本地数据库，不会回显到页面。出口被封时自动换 IP（同一出口每分钟最多一次）。</p>`;

      const form = panel.querySelector('form');
      const status = panel.querySelector('[role=status]');

      async function save(remint) {
        if (busy) return;
        busy = true;
        for (const el of form.elements) el.disabled = true;
        try {
          const parsed = parseTemplate((panel._config || {}).template);
          const password = String(form.elements.password.value || '');
          const config = { ...(panel._config || {}) };
          config.enabled = form.elements.enabled.checked;
          config.count = Number(form.elements.count.value);
          config.concurrency = Number(form.elements.concurrency.value);
          config.lines = Number(form.elements.lines.value);
          config.drainFree = form.elements.drainFree.checked;
          config.template = buildTemplate({
            login: form.elements.login.value,
            password: password || parsed.password,
            host: form.elements.host.value,
            port: form.elements.port.value,
            params: form.elements.params.value
          });
          if (remint) config.mintNonce = Date.now();
          await saveConfig(win.fetch.bind(win), config);
          // Keep the cached config in step with what was just stored: a stale mintNonce would make
          // the next plain "save" look like a fresh re-mint request and rotate every exit again.
          panel._config = config;
          form.elements.password.value = '';
          status.textContent = remint
            ? '已保存，正在为每个出口申请新 IP（约 20 秒后完成验证）。'
            : '已保存，后台数秒内生效。';
        } catch (e) {
          status.textContent = e.message;
        } finally {
          busy = false;
          for (const el of form.elements) el.disabled = false;
        }
      }

      form.addEventListener('submit', e => { e.preventDefault(); void save(false); });
      panel.querySelector('[data-remint]').addEventListener('click', () => void save(true));
      anchor.insertAdjacentElement('afterend', panel);
      void poll();
    }

    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      win.setTimeout(() => { scheduled = false; mount(); }, 80);
    };
    new win.MutationObserver(schedule).observe(doc.documentElement, { childList: true, subtree: true });
    win.setInterval(() => { mount(); void poll(); }, 3000);
    schedule();
  }

  if (typeof module === 'object' && module.exports) module.exports = { parseTemplate, buildTemplate, maskTemplate, normalizeConfig, saveConfig, install };
  if (typeof window !== 'undefined') install(window);
})();
