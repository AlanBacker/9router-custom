/* 9R_OC_POOL_UI_V1 */
(function () {
  'use strict';
  const LIMIT = 1000;
  const FLASH = '9router.opencode.pool.flash.v1';

  async function api(fetchFn, url, options = {}) {
    const response = await fetchFn(url, {credentials: 'same-origin', cache: 'no-store', ...options});
    let body;
    try { body = await response.json(); }
    catch { throw new Error('请先登录 9Router，然后重试。'); }
    if (!response.ok) {
      const error = new Error(body.error || `请求失败：HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function createConnections({count, prefix, roundRobin = true, fetchFn, onProgress = () => {}}) {
    count = Number(count);
    prefix = String(prefix || '').trim();
    if (!Number.isSafeInteger(count) || count < 1 || count > LIMIT) throw new Error(`新增数量必须是 1–${LIMIT} 的整数。`);
    if (!prefix || prefix.length > 64) throw new Error('名称前缀需要填写，最多 64 个字符。');
    const created = [];
    try {
      const [{connections = []}, settings] = await Promise.all([
        api(fetchFn, '/api/providers'), api(fetchFn, '/api/settings'),
      ]);
      const existing = connections.filter(c => c.provider === 'opencode');
      const names = new Set(existing.map(c => c.name));
      let serial = 1;
      let priority = existing.reduce((max, c) => Math.max(max, Number(c.priority) || 0), 0);
      const poolId = settings.providerStrategies?.opencode?.proxyPoolId;
      let conflicts = 0;
      while (created.length < count) {
        let name;
        do { name = `${prefix} ${serial++}`; } while (names.has(name));
        let result;
        try {
          result = await api(fetchFn, '/api/providers', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({provider: 'opencode', apiKey: 'public', name,
              priority: ++priority, allowOverwrite: false,
              ...(poolId ? {proxyPoolId: poolId} : {}),
              providerSpecificData: {opencodePoolManaged: true}}),
          });
        } catch (error) {
          // A concurrent administrator may have claimed this name. Never overwrite it.
          if (error.status === 409 && conflicts++ < 20) { names.add(name); continue; }
          throw error;
        }
        if (!result.connection?.id) throw new Error('服务器未返回新连接编号，请刷新后检查连接列表。');
        names.add(name);
        created.push({id: result.connection.id, name});
        onProgress(created.length, count);
      }
      let warning = null;
      if (roundRobin) {
        try {
          const latest = await api(fetchFn, '/api/settings');
          await api(fetchFn, '/api/settings', {method: 'PATCH', headers: {'content-type': 'application/json'},
            body: JSON.stringify({providerStrategies: {...latest.providerStrategies,
              opencode: {...latest.providerStrategies?.opencode, fallbackStrategy: 'round-robin', stickyRoundRobinLimit: 1}}})});
        } catch (error) {
          warning = `连接已创建；自动开启轮询失败：${error.message}。可在下方手动开启。`;
        }
      }
      return {created, warning};
    } catch (error) {
      error.created = created;
      throw error;
    }
  }

  function install(win) {
    if (win.__9routerOpenCodePoolV1) return;
    win.__9routerOpenCodePoolV1 = true;
    const doc = win.document;
    let busy = false;
    let scheduled = false;
    const onPage = () => /^\/dashboard\/providers\/(?:opencode|oc)\/?$/.test(decodeURIComponent(win.location.pathname));
    function mount() {
      scheduled = false;
      if (!onPage()) { doc.getElementById('9router-opencode-pool')?.remove(); return; }
      if (doc.getElementById('9router-opencode-pool')) return;
      const heading = [...doc.querySelectorAll('h2')].find(el => /^(Connections|连接|連線|連接)$/.test(el.textContent.trim()));
      if (!heading) return;
      const card = heading.parentElement.parentElement;
      if (!card?.parentElement) return;
      const panel = doc.createElement('section');
      panel.id = '9router-opencode-pool';
      panel.setAttribute('aria-label', 'OpenCode Free 匿名会话池');
      panel.style.cssText = 'border:1px solid #475569;border-radius:12px;padding:20px;margin-bottom:20px;background:rgba(100,116,139,.08);color:inherit';
      panel.innerHTML = `<h2 style="font-size:18px;font-weight:600;margin-bottom:8px">OpenCode Free 匿名会话池</h2>
        <p style="font-size:13px;opacity:.8;margin-bottom:16px">填写新增数量。每条连接首次使用时分配独立、持久保存的上游会话，客户端会话不会覆盖它。重启和更新后继续使用原会话。</p>
        <form style="display:flex;gap:14px;align-items:end;flex-wrap:wrap">
          <label style="display:grid;gap:6px;font-size:13px">新增数量<input name="count" type="number" min="1" max="1000" step="1" value="1" required style="width:120px"></label>
          <label style="display:grid;gap:6px;font-size:13px">名称前缀<input name="prefix" type="text" maxlength="64" value="OpenCode Free" required style="width:220px;max-width:100%"></label>
          <label style="display:flex;align-items:center;gap:7px;font-size:13px;padding-bottom:10px"><input name="roundRobin" type="checkbox" checked>创建后开启逐个轮询</label>
          <button type="submit" style="background:#0d9488;border:0;border-radius:8px;color:white;padding:10px 18px;cursor:pointer">创建连接</button>
        </form>
        <p role="status" aria-live="polite" style="font-size:13px;margin-top:12px;white-space:pre-wrap"></p>
        <p style="font-size:12px;opacity:.65;margin-top:8px">这里创建的是匿名会话，不是注册账号；独立会话不保证独立额度。上游端点不可用时短暂共享冷却；会话限流按会话冷却，不自动刷新身份。</p>`;
      for (const input of panel.querySelectorAll('input:not([type=checkbox])')) {
        input.style.cssText += ';border:1px solid #64748b;border-radius:7px;padding:9px;background:transparent;color:inherit';
      }
      const form = panel.querySelector('form');
      const status = panel.querySelector('[role=status]');
      try {
        const flash = JSON.parse(win.sessionStorage.getItem(FLASH) || 'null');
        win.sessionStorage.removeItem(FLASH);
        if (flash && Date.now() - flash.at < 120000) {
          status.textContent = flash.message;
          if (flash.prefix) form.elements.prefix.value = flash.prefix;
          if (flash.remaining) form.elements.count.value = flash.remaining;
        }
      } catch {}
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        const count = Number(form.elements.count.value);
        const prefix = form.elements.prefix.value;
        const roundRobin = form.elements.roundRobin.checked;
        busy = true;
        for (const el of form.elements) el.disabled = true;
        status.textContent = '正在创建连接…';
        let message, total = 0;
        try {
          const result = await createConnections({count, prefix, roundRobin, fetchFn: win.fetch.bind(win),
            onProgress: (done, all) => { status.textContent = `正在创建：${done} / ${all}`; }});
          total = result.created.length;
          message = result.warning || `已新增 ${total} 个连接${roundRobin ? '，已开启逐个轮询' : ''}。`;
        } catch (error) {
          total = error.created?.length || 0;
          message = `已确认创建 ${total} / ${count} 个连接。${error.message}${total ? ' 已创建的连接已保留。' : ''}`;
        } finally {
          busy = false;
          for (const el of form.elements) el.disabled = false;
        }
        status.textContent = message;
        if (total) {
          try { win.sessionStorage.setItem(FLASH, JSON.stringify({message, at: Date.now(), prefix, remaining: count - total})); } catch {}
          win.location.reload();
        }
      });
      card.parentElement.insertBefore(panel, card);
    }
    doc.addEventListener('click', event => {
      if (!onPage()) return;
      const button = event.target.closest?.('button');
      if (!button) return;
      const heading = [...doc.querySelectorAll('h2')].find(el => /^(Connections|连接|連線|連接)$/.test(el.textContent.trim()));
      const card = heading?.parentElement?.parentElement;
      const label = button.textContent.trim().replace(/^add\s*/, '').trim();
      if (!card?.contains(button) || !/^(Add|Add Connection|添加|新增|添加连接|新增连接)$/.test(label)) return;
      const panel = doc.getElementById('9router-opencode-pool');
      if (!panel) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy) return;
      panel.querySelector('[name=count]').value = '1';
      panel.scrollIntoView({behavior: 'smooth', block: 'center'});
      panel.querySelector('[name=count]').focus();
    }, true);
    const schedule = () => { if (!scheduled) { scheduled = true; win.setTimeout(mount, 50); } };
    new win.MutationObserver(schedule).observe(doc.documentElement, {childList: true, subtree: true});
    win.addEventListener('popstate', schedule);
    schedule();
  }

  if (typeof module === 'object' && module.exports) module.exports = {createConnections, install};
  if (typeof window !== 'undefined') install(window);
})();
