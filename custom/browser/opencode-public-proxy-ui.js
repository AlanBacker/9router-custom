/* 9R_OC_PUBLIC_PROXY_UI_V1 */
(function(){
  'use strict';
  async function updateConfig(fetchFn,config){
    const r=await fetchFn('/api/settings',{method:'PATCH',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({opencodePublicProxy:config})});
    const body=await r.json();if(!r.ok)throw new Error(body.error||'保存失败：HTTP '+r.status);return body;
  }
  function install(win){
    if(win.__9routerOpenCodePublicProxyV1)return;win.__9routerOpenCodePublicProxyV1=true;
    const doc=win.document;let busy=false,polling=false;
    const onPage=()=>/^\/dashboard\/providers\/(opencode|oc)\/?$/.test(win.location.pathname);
    async function poll(){
      const panel=doc.getElementById('9router-opencode-public-proxy');if(!panel||polling||!onPage())return;
      polling=true;
      try{
        const r=await win.fetch('/api/settings',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('读取失败，请确认已登录9Router');
        const s=await r.json(),c=s.opencodePublicProxy||{},runtime=s.opencodePublicProxyRuntime||{};
        panel._config=c;
        const form=panel.querySelector('form');
        if(!panel.contains(doc.activeElement)&&!busy){form.elements.enabled.checked=c.enabled===true;form.elements.targetCount.value=Number(c.targetCount)||0;form.elements.autoRecover429.checked=c.autoRecover429===true;}
        const status=panel.querySelector('[role=status]');
        const phases={disabled:'关闭',checking:'正在获取和检测代理',ready:'已就绪',waiting:'等待合格代理'};
        status.textContent=`${c.enabled===true?(phases[runtime.phase]||'等待后台启动'):'关闭'} · 连通独立出口 ${runtime.healthy||0} / 目标 ${runtime.desired||'自动'} · 已绑定 ${runtime.assigned||0} 条线路 · 已检测 ${runtime.tested||0} 个候选\n自动恢复${c.autoRecover429?'开启':'关闭'} · 已换出口 ${runtime.proxySwitches||0} 次 · 已重建失效会话 ${runtime.sessionRepairs||0} 次 · 恢复成功 ${runtime.recoverySuccesses||0} 次${runtime.lastError?'\n'+runtime.lastError:''}`;
        const maintenance=runtime.maintenance||{},time=value=>value?new Date(value).toLocaleTimeString():'待启动';
        panel.querySelector('[data-maintenance]').textContent=c.enabled===true?`后台自动维护中 · 每${maintenance.replenishSeconds||45}秒补充/检查 · 每${(maintenance.sourceRefreshSeconds||600)/60}分钟更新列表 · 每${(maintenance.healthMaxAgeSeconds||900)/60}分钟重新验证出口\n下次池检查：${runtime.phase==='checking'?'本轮进行中':time(maintenance.nextCheckAt)} · 下次列表更新：${time(maintenance.nextSourceRefreshAt)} · 最近状态：${time(runtime.updatedAt)}`:'自动维护随代理开关开启；关闭时停止下载和探测。';
        const list=panel.querySelector('[data-lines]');list.replaceChildren();
        for(const line of runtime.lines||[]){const row=doc.createElement('div');row.textContent=line.state==='auth-cooldown'?`${line.name} · 鉴权/账号异常，隔离至 ${new Date(line.until).toLocaleTimeString()}（HTTP ${line.status}），到期自动复查`:`${line.name} → ${line.egressIp||'待检测'} · ${line.state} · ${line.proxyUrl}`;list.append(row);}
        const sources=panel.querySelector('[data-sources]');sources.replaceChildren();
        for(const source of runtime.sources||[]){const row=doc.createElement('div');row.textContent=`${source.ok?'✓':'✗'} ${source.url} · ${source.count||0} 个候选${source.error?' · '+source.error:''}`;sources.append(row);}
      }catch(e){panel.querySelector('[role=status]').textContent=e.message;}finally{polling=false;}
    }
    function mount(){
      const existing=doc.getElementById('9router-opencode-public-proxy');
      if(!onPage()){existing?.remove();return;}if(existing)return;
      const pool=doc.getElementById('9router-opencode-pool');if(!pool)return;
      const panel=doc.createElement('section');panel.id='9router-opencode-public-proxy';
      panel.style.cssText='border:1px solid #475569;border-radius:12px;padding:20px;margin-bottom:20px;background:rgba(100,116,139,.08);color:inherit';
      panel.innerHTML=`<h2 style="font-size:18px;font-weight:600;margin-bottom:8px">自动公共代理</h2>
      <p style="font-size:13px;opacity:.8;margin-bottom:14px">自动下载公开列表，检测HTTPS和OpenCode连通性，按实际出口IP去重，为每条匿名线路绑定不同出口。失效后后台补充；可用出口不足时返回错误，不回落直连。</p>
      <form style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <label style="display:flex;gap:7px;align-items:center"><input name="enabled" type="checkbox">启用自动公共代理</label>
      <label style="display:flex;gap:7px;align-items:center"><input name="autoRecover429" type="checkbox">故障自动恢复（限流／代理／会话）</label>
      <label style="font-size:13px">目标出口数 <input name="targetCount" type="number" min="0" max="100" step="1" value="0" required style="width:85px;border:1px solid #64748b;border-radius:7px;padding:7px;background:transparent;color:inherit">（0＝按启用线路数量）</label>
      <button type="submit" style="background:#0d9488;border:0;border-radius:8px;color:white;padding:9px 16px">保存开关</button>
      <button type="button" data-refresh style="border:1px solid #64748b;border-radius:8px;padding:8px 14px;background:transparent;color:inherit">立即补充检测</button></form>
      <p style="font-size:12px;opacity:.8;margin-top:10px">自动恢复默认关闭。开启后额外预留2个出口；限流、代理拒绝、网关错误或连接失败先冷却原出口，再换一个空闲出口重试，最多1次。仅明确会话失效时更新该会话（每条最多5分钟一次）；鉴权/账号停用隔离对应线路并到期复查，保留错误原因；普通参数错误和端点不可用不会换IP。</p>
      <p style="font-size:12px;opacity:.7;margin-top:12px">默认关闭。连通检测不代表免费推理一定可用；上游403或429会冷却该出口并尝试其他线路，不能保证扩量。请求经过第三方代理，始终校验目标HTTPS证书，仅用于OpenCode Free匿名请求。</p>
      <p style="font-size:12px;opacity:.7;margin-top:8px">公开列表：<a style="color:#7dd3fc" href="https://github.com/proxifly/free-proxy-list" target="_blank" rel="noopener noreferrer">Proxifly</a> / <a style="color:#7dd3fc" href="https://github.com/TheSpeedX/PROXY-List" target="_blank" rel="noopener noreferrer">TheSpeedX</a> / <a style="color:#7dd3fc" href="https://github.com/monosans/proxy-list" target="_blank" rel="noopener noreferrer">Monosans</a> / <a style="color:#7dd3fc" href="https://github.com/roosterkid/openproxylist" target="_blank" rel="noopener noreferrer">OpenProxyList</a> / <a style="color:#7dd3fc" href="https://github.com/jetkai/proxy-list" target="_blank" rel="noopener noreferrer">Jetkai</a></p>
      <p role="status" aria-live="polite" style="font-size:13px;margin-top:12px;white-space:pre-wrap">读取状态…</p>
      <p data-maintenance style="font-size:12px;opacity:.8;margin-top:8px;white-space:pre-wrap"></p>
      <div data-sources style="font-size:12px;margin-top:10px;display:grid;gap:4px;overflow-wrap:anywhere"></div>
      <div data-lines style="font-size:12px;margin-top:10px;display:grid;gap:5px;overflow-wrap:anywhere"></div>`;
      const form=panel.querySelector('form'),status=panel.querySelector('[role=status]');
      async function save(refresh){
        if(busy)return;busy=true;for(const e of form.elements)e.disabled=true;
        try{
          const config={...panel._config,enabled:form.elements.enabled.checked,targetCount:Number(form.elements.targetCount.value),autoRecover429:form.elements.autoRecover429.checked};
          if(refresh){if(!config.enabled)throw new Error('请先启用开关，后台才会获取公共代理');config.refreshNonce=Date.now();}
          await updateConfig(win.fetch.bind(win),config);status.textContent='已保存，后台数秒内生效。';
        }catch(e){status.textContent=e.message;}finally{busy=false;for(const e of form.elements)e.disabled=false;}
      }
      form.addEventListener('submit',e=>{e.preventDefault();void save(false);});panel.querySelector('[data-refresh]').addEventListener('click',()=>void save(true));
      pool.insertAdjacentElement('afterend',panel);void poll();
    }
    let scheduled=false;const schedule=()=>{if(!scheduled){scheduled=true;win.setTimeout(()=>{scheduled=false;mount();},80);}};
    new win.MutationObserver(schedule).observe(doc.documentElement,{childList:true,subtree:true});
    win.setInterval(()=>{mount();void poll();},3000);schedule();
  }
  if(typeof module==='object'&&module.exports)module.exports={updateConfig,install};
  if(typeof window!=='undefined')install(window);
})();
