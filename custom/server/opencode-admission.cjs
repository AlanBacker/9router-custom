'use strict';
const {buildProbe,consumeProbe}=require('./opencode-inference-probe.cjs');
const {classifyFailure}=require('./opencode-recovery-rules.cjs');
const PROBE=Symbol.for('9router.opencodeAdmissionProbe.v1');
function createAdmission({pool,storage,config,now=Date.now,logger=console,builder=buildProbe}){
  const states=new Map(),modelPauses=new Map();let round=null,windowStart=now(),used=0,cursor=0;
  let roundStartedAt=0,roundToken=0;
  const maxPerMinute=config.inferenceProbesPerMinute||24,concurrency=config.inferenceConcurrency||2;
  const models=()=>{const c=storage.read().config||{};return [...new Set((Array.isArray(c.probeModels)?c.probeModels:config.probeModels||[]).filter(m=>typeof m==='string'&&/^[a-zA-Z0-9._-]{1,128}$/.test(m)))].slice(0,8);};
  const enabled=()=>storage.read().config?.enabled===true;
  function state(session){let s=states.get(session);if(!s){s={passed:new Map(),requested:new Set(),nextAt:0,testing:false,reason:'等待真实推理验证'};states.set(session,s);}return s;}
  function ready(session,model){
    const s=states.get(session),b=pool.getBinding(session),p=s?.passed.get(model);
    return !!(b&&p&&p.url===b.url&&p.egress===b.egress&&p.at>now()-(config.inferenceHealthMaxAgeSeconds||1800)*1000&&pool.bindingValid(session));
  }
  function targets(session){return [...new Set([...models(),...state(session).requested])].slice(0,8);}
  function isReady(session,model){return model?ready(session,String(model).replace(/\([^()]*\)$/,'')):targets(session).length>0&&targets(session).every(m=>ready(session,m));}
  function canRoute(id,model){
    if(!enabled())return true;
    const c=(storage.read().connections||[]).find(c=>c.id===id);if(!c?.session)return false;
    const normalized=String(model||'').replace(/\([^()]*\)$/,'');if(normalized&&/^[a-zA-Z0-9._-]{1,128}$/.test(normalized)&&state(c.session).requested.size<8)state(c.session).requested.add(normalized);
    // A line that is validating one model may still serve another model it already passed.
    // Only the requested model's readiness gates routing; unrelated validation must not hide a usable line.
    if(!isReady(c.session,normalized||null))return false;
    if(pool.sessionBusy?pool.sessionBusy(c.session):pool.getBinding(c.session)?.inFlight)return false;
    return true;
  }
  function snapshot(base){
    if(!enabled())return {...base,admissionEnabled:false};
    const connections=storage.read().connections||[],lines=connections.map(c=>{
      const s=state(c.session),b=pool.getBinding(c.session),required=targets(c.session),passed=required.filter(m=>ready(c.session,m));
      return {name:c.name,proxyUrl:b?.url,egressIp:b?.egress,state:required.length&&passed.length===required.length?'ready':s.testing?'testing':s.nextAt>now()?'validation-cooldown':'pending',validatedModels:passed,requiredModels:required,lastValidationError:s.reason,nextValidationAt:s.nextAt||null};
    });
    const readyCount=lines.filter(l=>l.state==='ready').length;
    const readyByModel=Object.fromEntries([...new Set(lines.flatMap(l=>l.requiredModels))].map(model=>[model,lines.filter(l=>l.validatedModels.includes(model)).length]));
    return {...base,admissionEnabled:true,connectivityHealthy:base.healthy,readyCount,readyByModel,pendingCount:lines.length-readyCount,lines,inferenceProbesThisMinute:used,inferenceProbesPerMinute:maxPerMinute,phase:round?'validating':readyCount?'ready':'waiting'};
  }
  async function validate(connection,genModels){
    const session=connection.session,s=state(session);if(!session||s.testing||s.nextAt>now())return;
    s.testing=true;s.reason='正在真实推理测试';pool.publish(true);
    try{
      for(let attempt=0;attempt<(config.inferenceAttemptsPerLine||3)&&enabled();attempt++){
        if(isReady(session,null)){s.reason=null;s.nextAt=0;return;}
        const model=genModels.find(m=>!ready(session,m));if(!model)return;
        if(modelPauses.get(model)>now()){s.reason=`目标模型 ${model} 暂不可用，等待冷却`;s.nextAt=modelPauses.get(model);return;}
        if(used>=maxPerMinute){s.reason='等待下一批验证预算';return;}
        if(!pool.canAcquire(session)){s.reason='等待新的连通代理';s.nextAt=now()+3000;return;}
        let request;try{request=await builder(model,session,config);}catch(e){s.reason=e.message;s.nextAt=now()+60000;return;}
        if(!enabled())return;
        if(used>=maxPerMinute)return;used++;
        let result;
        try{
          const response=await pool.fetch(request.url,{...request.init,signal:AbortSignal.timeout(config.inferenceTimeoutMs||12000),[PROBE]:true});
          result=await consumeProbe(response);
        }catch(e){result={ok:false,status:502,detail:{error:{message:e.cause?.code||e.code||e.name}}};}
        const b=pool.getBinding(session);
        if(result.ok&&b&&pool.bindingValid(session)){
          s.passed.set(model,{url:b.url,egress:b.egress,at:now()});s.reason=null;
          logger.info?.(`[OpenCodeAdmission] accepted line=${connection.name} model=${model} egress=${b.egress}`);
          continue;
        }
        const issue=result.status===200?{kind:'gateway'}:classifyFailure(result.status,result.detail);
        s.reason=`推理验证未通过：${model} HTTP ${result.status}`;
        logger.warn?.(`[OpenCodeAdmission] rejected line=${connection.name} model=${model} status=${result.status} kind=${issue.kind}`);
        if(['auth','session','endpoint','other'].includes(issue.kind)||[400,404,422].includes(result.status)){
          const seconds=Number(result.retryAfter),date=Date.parse(result.retryAfter||'');s.nextAt=now()+(Number.isFinite(seconds)&&seconds>0?Math.min(seconds,86400)*1000:Number.isFinite(date)&&date>now()?Math.min(date-now(),86400000):30000);if(issue.kind==='endpoint')modelPauses.set(model,s.nextAt);return;
        }
        pool.rejectBinding(session,result.status===403?(config.inferenceRejectCooldownSeconds||1800)*1000:60000,result.status===403,result.status===403?'access':undefined);
        // Only the failing model loses its pass; other models on this line keep theirs.
        s.passed.delete(model);pool.publish(true);
      }
      if(!isReady(session,null))s.nextAt=now()+(config.inferenceRetrySeconds||15)*1000;
    }finally{s.testing=false;pool.publish(true);}
  }
  async function maintain(){
    if(!enabled())return;
    if(round){
      const age=now()-roundStartedAt;
      if(age<=(config.inferenceRoundTimeoutMs||180000))return round;
      // Never let a stalled validation round block future validation work.
      logger.warn?.(`[OpenCodeAdmission] Validation round stalled ${Math.round(age/1000)}s; abandoning it so later rounds can proceed`);
      round=null;
    }
    if(now()-windowStart>=60000){windowStart=now();used=0;}
    const connections=(storage.read().connections||[]).filter(c=>c.session);
    const active=new Set(connections.map(c=>c.session));for(const session of states.keys())if(!active.has(session))states.delete(session);
    if(!connections.length||used>=maxPerMinute)return;
    const queue=connections.slice(cursor).concat(connections.slice(0,cursor)).filter(c=>!isReady(c.session,null));cursor=(cursor+Math.max(1,concurrency))%connections.length;
    let index=0;
    const token=++roundToken;roundStartedAt=now();
    const work=(async()=>{try{await Promise.all(Array.from({length:concurrency},async()=>{while(enabled()&&used<maxPerMinute&&index<queue.length){const c=queue[index++];await validate(c,targets(c.session));}}));}finally{if(token===roundToken)round=null;pool.publish(true);}})();
    round=work;
    return round;
  }
  async function fetch(input,init){
    let url,headers,body;try{url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);headers=new Headers(init?.headers);body=JSON.parse(init?.body);}catch{return pool.fetch(input,init);}
    if(!enabled()||url.hostname!=='opencode.ai'||!url.pathname.startsWith('/inference/')||headers.get('authorization')!=='Bearer public'||init?.method?.toUpperCase()!=='POST')return pool.fetch(input,init);
    const session=headers.get('x-opencode-session');
    if(!(storage.read().connections||[]).some(c=>c.session===session))return pool.fetch(input,init);
    const s=state(session),model=String(body.model||'');
    if(s.requested.size<8&&/^[a-zA-Z0-9._-]{1,128}$/.test(model))s.requested.add(model);
    void maintain();
    if(!ready(session,model)){
      // A validated line can drop out for a few seconds while its egress is refreshed or the
      // pool finds a replacement. Wait briefly and force this line's revalidation instead of
      // failing the caller instantly. During a total outage the pool often recovers within a few
      // seconds too, so allow a shorter wait rather than answering instantly. Both paths are
      // bounded by a real clock and by the per-minute probe budget.
      const healthy=pool.snapshot?.().healthy||0;
      const waitMs=healthy>0?(Number(config.admissionWaitMs)||0):(Number(config.admissionShortWaitMs)||0);
      const connection=(storage.read().connections||[]).find(c=>c.session===session);
      const until=Date.now()+waitMs;
      while(waitMs>0&&!ready(session,model)&&Date.now()<until&&used<maxPerMinute){
        if(connection)await validate(connection,targets(session)).catch(()=>{});
        if(ready(session,model))break;
        if(Date.now()>=until||used>=maxPerMinute)break;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
    if(!ready(session,model)){
      const status=require('./availability-status.cjs').describeUnavailable(snapshot(pool.snapshot()),model,{now:now()});
      return Response.json({error:{type:'OpenCodePublicProxyUnavailable',message:status.lastError.replace(/^OpenCodePublicProxyUnavailable: /,'')}},{status:503,headers:{'retry-after':status.retryAfterHuman.replace(/s$/,'')}});
    }
    let response=await pool.fetch(input,{...init,[PROBE]:true});
    {
      // The pool disables its own retry loop for admission-gated traffic, so a blocked egress
      // (403 FreeTierError) or a dead one (502/504) would otherwise be shown to the user once.
      // Drop the offending binding, force a revalidation, and retry once on a different egress.
      const firstDetail=response.ok?undefined:await response.clone().json().catch(()=>undefined);
      const firstKind=response.ok?'ok':classifyFailure(response.status,firstDetail).kind;
      const spareBudget=used<maxPerMinute;
      if(spareBudget&&(firstKind==='access'||firstKind==='gateway')&&firstDetail?.error?.type!=='OpenCodePublicProxyUnavailable'){
        pool.rejectBinding(session,firstKind==='access'?(config.inferenceRejectCooldownSeconds||1800)*1000:60000,firstKind==='access',firstKind);
        void response.body?.cancel().catch(()=>{});
        const connection=(storage.read().connections||[]).find(c=>c.session===session);
        if(connection)await validate(connection,targets(session)).catch(()=>{});
        if(ready(session,model)){
          const retry=await pool.fetch(input,{...init,[PROBE]:true});
          if(retry.ok)return retry;
          const detail=await retry.clone().json().catch(()=>undefined);
          void retry.body?.cancel().catch(()=>{});
          // The retry also failed: this line has no working exit right now, so unlink it. Leaving
          // the (now banned) exit bound would make the next request try the same dead exit first.
          pool.rejectBinding(session,60000,false);
          s.passed.delete(model);s.reason=`业务请求 HTTP ${retry.status}，等待重新验证`;s.nextAt=now()+1000;pool.publish(true);
          return pool.handledError(retry,detail);
        }
      }
    }
    if(!response.ok){const detail=await response.clone().json().catch(()=>undefined);if(detail?.error?.type!=='OpenCodePublicProxyUnavailable'||!pool.bindingValid(session)){s.passed.delete(model);s.reason=`业务请求 HTTP ${response.status}，等待重新验证`;s.nextAt=now()+1000;pool.publish(true);}return pool.handledError(response,detail);}
    return response;
  }
  return {fetch,maintain,snapshot,canRoute,isReady};
}
module.exports={createAdmission,PROBE};
