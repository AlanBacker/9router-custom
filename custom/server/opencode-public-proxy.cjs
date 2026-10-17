'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {classifyFailure,transportFailure}=require('./opencode-recovery-rules.cjs');
const EGRESS=Symbol.for('9router.opencodeEgress.v1');
const MARK=Symbol.for('9router.opencodePublicProxy.v1');

function publicIPv4(ip){
  if(net.isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===0||b===168))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
function normalizeProxy(value){
  try{
    const u=new URL(/^https?:\/\//i.test(value)?value:'http://'+value);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!publicIPv4(u.hostname))return null;
    const port=u.port|| (u.protocol==='https:'?'443':'80');
    if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)return null;
    return u.origin;
  }catch{return null;}
}
function parseCandidates(text,limit=5000){
  const out=new Set();for(const line of String(text).split(/\r?\n/)){
    const raw=line.trim();if(!raw||raw.startsWith('#'))continue;
    const value=normalizeProxy(raw);if(value)out.add(value);if(out.size>=limit)break;
  }return [...out];
}
function mergeCandidates(lists,limit){
  const result=new Set();let row=0;
  while(result.size<limit&&lists.some(list=>row<list.length)){
    for(const list of lists){if(row<list.length)result.add(list[row]);if(result.size>=limit)break;}
    row++;
  }
  return [...result];
}
async function limitedText(response,maxBytes){
  if(!response.body)return '';
  const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,out='';
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes)throw new Error('Response too large');out+=decoder.decode(value,{stream:true});}return out+decoder.decode();}
  finally{void reader.cancel().catch(()=>{});}
}
function createTransportPool({nativeFetch,makeAgent,storage,config,logger=console,now=Date.now,renewSession=(old,reason)=>globalThis[Symbol.for('9router.opencodeAnonymous.v1')]?.renewInvalidSession(old,reason)}){
  let enabled=false,desired=0,round=null,lastRound=0,lastSources=0,nonce,baseline=null,hydrated=false,generation=0,lastPersist=0;
  let candidates=[],tested=0,sourceError=null,sourceStates=[],lastSourceAttempt=0;
  const entries=new Map(),assignments=new Map(),sessionIssues=new Map();
  let recoveryEnabled=false,proxySwitches=0,sessionRepairs=0,recoverySuccesses=0;
  function settings(){
    const s=storage.read();const c=s.config||{};
    const next=c.enabled===true;
    if(next!==enabled){enabled=next;generation++;if(!enabled){for(const entry of entries.values())if(!entry.inFlight){entry.agent?.destroy();entry.agent=null;}assignments.clear();}}
    recoveryEnabled=c.autoRecover429===true;
    desired=Math.min(100,Math.max(1,Number(c.targetCount)||s.connections?.length||1)+(recoveryEnabled?2:0));
    const active=new Set((s.connections||[]).map(c=>c.session).filter(Boolean));
    for(const session of assignments.keys())if(!active.has(session))assignments.delete(session);
    for(const [session,issue]of sessionIssues)if(!active.has(session)||issue.until<=now())sessionIssues.delete(session);
    return {...s,config:c};
  }
  function snapshot(){
    const t=now(),connections=storage.read().connections||[],names=new Map(connections.map(c=>[c.session,c.name]));
    const lines=[...assignments].map(([session,url])=>{const e=entries.get(url);return {name:names.get(session)||crypto.createHash('sha256').update(session).digest('hex').slice(0,8),proxyUrl:url,egressIp:e?.egress,state:e?.until>t?'cooldown':e?.inFlight?'busy':'ready'};});
    for(const [session,issue]of sessionIssues)if(issue.until>t&&!assignments.has(session))lines.push({name:names.get(session)||'匿名线路',state:'auth-cooldown',until:issue.until,status:issue.status});
    return {enabled,autoRecover429:recoveryEnabled,proxySwitches,sessionRepairs,recoverySuccesses,phase:!enabled?'disabled':round?'checking':usable().length?'ready':'waiting',desired,healthy:usable().length,assigned:assignments.size,tested,candidates:candidates.length,lastRefresh:lastRound||null,lastSourceAttempt:lastSourceAttempt||null,maintenance:{automatic:enabled,replenishSeconds:config.replenishIntervalSeconds,sourceRefreshSeconds:config.sourceRefreshSeconds,healthMaxAgeSeconds:config.healthMaxAgeSeconds,nextCheckAt:enabled?(lastRound+config.replenishIntervalSeconds*1000):null,nextSourceRefreshAt:enabled?(candidates.length?lastSourceAttempt+config.sourceRefreshSeconds*1000:lastRound+config.replenishIntervalSeconds*1000):null},lastError:sourceError,sources:sourceStates,lines,updatedAt:t};
  }
  function usable(){return [...entries.values()].filter(e=>e.checkedAt>now()-config.healthMaxAgeSeconds*1000&&e.until<=now()&&!e.failed);}
  function publish(force=false){
    if(!force&&now()-lastPersist<1000)return;
    lastPersist=now();try{
      storage.status(snapshot());
      if(hydrated)storage.save({version:1,entries:[...entries.values()].map(({url,egress,checkedAt,until,failed})=>({url,egress,checkedAt,until,failed})),assignments:Object.fromEntries(assignments),sessionIssues:Object.fromEntries(sessionIssues)});
    }catch(e){logger.warn?.('[OpenCodePublicProxy] Status persistence failed: '+e.message);}
  }
  function hydrate(){
    if(hydrated)return;hydrated=true;
    const saved=storage.load();if(saved?.version!==1)return;
    for(const e of (saved.entries||[]).slice(0,config.maxCandidates||5000))if(normalizeProxy(e.url)&&publicIPv4(e.egress)){
      entries.set(e.url,{...e,agent:null,inFlight:0,failed:true});candidates.push(e.url);
    }
    // Restored nodes must pass live checks again. Keep their quota cooldowns.
    for(const [session,url]of Object.entries(saved.assignments||{}))if(entries.has(url))assignments.set(session,url);
    for(const [session,issue]of Object.entries(saved.sessionIssues||{}).slice(0,5000))if(Number.isFinite(issue?.until)&&issue.until>now()&&[401,403].includes(issue.status))sessionIssues.set(session,issue);
  }
  function dispatcher(entry){
    if(!entry.agent)entry.agent=makeAgent(entry.url);
    return entry.agent;
  }
  async function probe(url,gen){
    const previous=entries.get(url);if(previous?.inFlight||previous?.until>now())return;
    const agent=previous?.agent||makeAgent(url),start=now();
    try{
      const check=await nativeFetch(config.ipCheckUrl,{dispatcher:agent,redirect:'error',signal:AbortSignal.timeout(config.probeTimeoutMs)});
      if(!check.ok)throw new Error('IP check failed');
      const ip=JSON.parse(await limitedText(check,4096)).ip;
      if(!publicIPv4(ip)||ip===baseline)throw new Error('Egress unchanged or non-public');
      if([...entries.values()].some(e=>e.url!==url&&e.egress===ip&&!e.failed&&e.checkedAt>now()-config.healthMaxAgeSeconds*1000))throw new Error('Duplicate egress');
      const target=await nativeFetch(config.targetCheckUrl,{dispatcher:agent,redirect:'error',signal:AbortSignal.timeout(config.probeTimeoutMs)});
      if(!target.ok)throw new Error('OpenCode unreachable');
      const models=JSON.parse(await limitedText(target,512*1024));
      if(!Array.isArray(models.data)&&!Array.isArray(models.models)&&!Array.isArray(models))throw new Error('Unexpected model response');
      if(!enabled||gen!==generation)throw new Error('Disabled while checking');
      // Recheck after async probes so equal egresses cannot race into the pool.
      if([...entries.values()].some(e=>e.url!==url&&e.egress===ip&&!e.failed&&e.checkedAt>now()-config.healthMaxAgeSeconds*1000))throw new Error('Duplicate egress');
      entries.set(url,{url,egress:ip,checkedAt:now(),until:previous?.until||0,failed:false,agent,inFlight:0,latency:now()-start});
      logger.info?.(`[OpenCodePublicProxy] Healthy proxy=${url} egress=${ip}`);
    }catch{
      if(previous){previous.failed=true;if(previous.agent===agent)previous.agent=null;}
      void agent.destroy();
    }finally{tested++;publish();}
  }
  async function refresh(){
    if(round)return round;
    const s=settings();if(!enabled){publish();return;}
    hydrate();const gen=generation;const force=s.config.refreshNonce!==nonce;nonce=s.config.refreshNonce;
    if(!force&&now()-lastRound<config.replenishIntervalSeconds*1000)return;
    lastRound=now();
    round=(async()=>{
      try{
        if(!baseline){const r=await nativeFetch(config.ipCheckUrl,{redirect:'error',signal:AbortSignal.timeout(config.probeTimeoutMs)});if(r.ok)baseline=JSON.parse(await limitedText(r,4096)).ip;}
        if(!publicIPv4(baseline))throw new Error('无法确认服务器出口IP，暂停代理检测');
        if(now()-lastSources>config.sourceRefreshSeconds*1000||!candidates.length||force){
          lastSourceAttempt=now();
          const results=await Promise.allSettled(config.sources.map(async source=>{
            const r=await nativeFetch(source,{redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('Source HTTP '+r.status);return parseCandidates(await limitedText(r,config.maxSourceBytes),config.maxCandidates);
          }));
          sourceStates=results.map((r,i)=>({url:config.sources[i],ok:r.status==='fulfilled',count:r.status==='fulfilled'?r.value.length:0,error:r.status==='rejected'?String(r.reason?.message||'Unavailable').slice(0,120):null,checkedAt:now()}));
          const found=mergeCandidates(results.filter(r=>r.status==='fulfilled').map(r=>r.value),config.maxCandidates);
          if(found.length){
            const fresh=mergeCandidates([found,candidates],config.maxCandidates);
            for(let i=fresh.length-1;i>0;i--){const j=crypto.randomInt(i+1);[fresh[i],fresh[j]]=[fresh[j],fresh[i]];}
            candidates=fresh;lastSources=now();sourceError=null;
          }else sourceError='公共列表暂时不可用或没有合格HTTP(S)地址';
        }
        // Revalidate known exits first after restart or failure; do not bury them in a shuffled public list.
        const due=[...entries.values()].filter(e=>!e.inFlight&&e.until<=now()&&(e.failed||e.checkedAt<=now()-config.healthMaxAgeSeconds*1000)).map(e=>e.url);
        const pending=[...new Set([...due,...candidates])];
        const queue=pending.splice(0,config.maxCandidatesPerRound);candidates=pending;
        let index=0;
        await Promise.all(Array.from({length:config.probeConcurrency},async()=>{
          while(enabled&&gen===generation&&index<queue.length){
            if(usable().length>=desired)break;
            const url=queue[index++];const e=entries.get(url);
            if(e&&!e.failed&&e.checkedAt>now()-config.healthMaxAgeSeconds*1000)continue;
            await probe(url,gen);
          }
        }));
        candidates.unshift(...queue.slice(index));
        if(!usable().length&&!sourceError)sourceError='尚未找到同时通过HTTPS及OpenCode连通检测的独立出口，继续后台补充';
      }catch(e){sourceError=String(e.message).slice(0,200);}
      finally{round=null;publish(true);}
    })();
    publish(true);return round;
  }
  function failure(message,seconds=5){return new Response(JSON.stringify({error:{type:'OpenCodePublicProxyUnavailable',message}}),{status:503,headers:{'content-type':'application/json','retry-after':String(seconds)}});}
  function handledError(response,detail){
    const previous=detail?.error&&typeof detail.error==='object'?detail.error:{};
    const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');headers.set('content-type','application/json');
    const message=String(previous.message||detail?.message||'Upstream HTTP '+response.status);
    void response.body?.cancel().catch(()=>{});
    return new Response(JSON.stringify({...detail,error:{...previous,message:'[OpenCodeAutoRecovery] '+message}}),{status:response.status,statusText:response.statusText,headers});
  }
  function releaseAfterBody(response,done){
    if(!response.body){done();return response;}
    const reader=response.body.getReader();let finished=false;
    const finish=()=>{if(!finished){finished=true;done();}};
    const body=new ReadableStream({async pull(controller){try{const r=await reader.read();if(r.done){finish();controller.close();}else controller.enqueue(r.value);}catch(e){finish();controller.error(e);}},async cancel(reason){try{await reader.cancel(reason);}finally{finish();}}});
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }
  async function fetchWithPool(input,init){
    let url,headers;
    try{url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);headers=new Headers(init?.headers);}catch{return nativeFetch(input,init);}
    if(url.hostname!=='opencode.ai'||!url.pathname.startsWith('/inference/')||String(init?.method).toUpperCase()!=='POST'||headers.get('authorization')!=='Bearer public')return nativeFetch(input,init);
    const s=settings();if(!enabled)return nativeFetch(input,init);
    if(init.signal?.aborted)throw init.signal.reason||new DOMException('Aborted','AbortError');
    hydrate();void refresh();
    let session=headers.get('x-opencode-session');if(!session)return failure('缺少固定上游会话，自动公共代理未发送请求');
    const recovery=s.config.autoRecover429===true&&!init[Symbol.for('9router.opencodeAdmissionProbe.v1')];
    const paused=sessionIssues.get(session);if(recovery&&paused?.until>now())return failure('自动公共代理：当前匿名线路因鉴权或账号异常暂时隔离，冷却到期后自动复查；其他线路仍可使用',Math.max(1,Math.ceil((paused.until-now())/1000)));
    const valid=e=>e&&!e.failed&&e.until<=now()&&e.checkedAt>now()-config.healthMaxAgeSeconds*1000;
    const alternative=exclude=>{
      const occupied=new Set([...assignments.values()]);
      return usable().filter(e=>!occupied.has(e.url)&&!e.inFlight&&e.egress!==exclude).sort((a,b)=>(a.latency||0)-(b.latency||0))[0];
    };
    for(let attempt=0;attempt<(recovery?2:1);attempt++){
      let entry=entries.get(assignments.get(session));
      if(!valid(entry)){
        assignments.delete(session);entry=alternative();
        if(!entry)return failure('自动公共代理已开启，但独立可用出口不足；正在检测和补充，没有回落直连');
        assignments.set(session,entry.url);
      }
      if(entry.inFlight)return failure('这条匿名线路正在处理请求，请使用其他空闲线路或稍后重试');
      entry.inFlight++;
      const end=()=>{entry.inFlight=Math.max(0,entry.inFlight-1);publish(true);};
      try{
        const response=await nativeFetch(input,{...init,headers,dispatcher:dispatcher(entry),[EGRESS]:entry.egress});
        let detail;
        if(!response.ok&&!/text\/event-stream/i.test(response.headers.get('content-type')||''))try{detail=JSON.parse(await limitedText(response.clone(),65536));}catch{}
        const issue=classifyFailure(response.status,detail);
        if(recovery&&issue.kind==='auth'&&[401,403].includes(response.status)){
          const retry=response.headers.get('retry-after'),numeric=Number(retry),delay=retry?(Number.isFinite(numeric)?numeric*1000:Date.parse(retry)-now()):300000;
          sessionIssues.set(session,{status:response.status,until:now()+Math.min(86400000,Math.max(1000,Number.isFinite(delay)?delay:300000))});assignments.delete(session);
          logger.warn?.(`[OpenCodePublicProxy] Explicit credential/account rejection status=${response.status}; affected anonymous line paused, identity retained`);
        }
        if(['rate','access','gateway'].includes(issue.kind)){
          const retry=response.headers.get('retry-after'),number=Number(retry);
          const delay=retry&&Number.isFinite(number)?number*1000:retry?Date.parse(retry)-now():issue.kind==='access'?300000:60000;
          entry.until=now()+Math.min(86400000,Math.max(1000,Number.isFinite(delay)?delay:60000));
        }
        const canRecover=recovery&&attempt===0&&!init.signal?.aborted&&shouldStop429Fallback();
        if(canRecover&&['rate','access','gateway'].includes(issue.kind)){
          const replacement=alternative(entry.egress);
          if(replacement){
            assignments.set(session,replacement.url);proxySwitches++;
            logger.warn?.(`[OpenCodePublicProxy] Fault recovery status=${response.status} kind=${issue.kind} old-egress=${entry.egress} new-egress=${replacement.egress}; retry=1/1; old egress cooldown retained`);
            end();void response.body?.cancel().catch(()=>{});continue;
          }
          logger.warn?.('[OpenCodePublicProxy] Fault recovery: no spare distinct egress; error returned');
        }
        if(canRecover&&issue.kind==='session'){
          let replacement;try{replacement=renewSession(session,issue.reason);}catch(e){logger.warn?.('[OpenCodePublicProxy] Session repair unavailable: '+e.message);}
          if(replacement){
            assignments.delete(session);session=replacement;assignments.set(session,entry.url);
            headers=new Headers(headers);
            for(const name of ['x-opencode-session','x-opencode-session-id','x-session-affinity','x-session-id'])headers.set(name,replacement);
            sessionRepairs++;
            logger.warn?.('[OpenCodePublicProxy] Explicit invalid/expired session: renewed one managed session; retry=1/1');
            end();void response.body?.cancel().catch(()=>{});continue;
          }
        }
        if(!response.ok){end();return recovery&&issue.kind!=='other'?handledError(response,detail):response;}
        if(attempt>0)recoverySuccesses++;
        publish(true);return releaseAfterBody(response,end);
      }catch(e){
        if(init.signal?.aborted){end();throw e;}
        const transport=transportFailure(e);
        if(transport){entry.failed=true;entry.until=now()+60000;assignments.delete(session);}
        end();
        if(recovery&&transport){
          const replacement=attempt===0&&shouldStop429Fallback()?alternative(entry.egress):null;
          if(replacement){assignments.set(session,replacement.url);proxySwitches++;logger.warn?.(`[OpenCodePublicProxy] Transport recovery old-egress=${entry.egress} new-egress=${replacement.egress}; retry=1/1`);continue;}
          return Response.json({error:{type:'OpenCodeAutoRecovery',message:'[OpenCodeAutoRecovery] Proxy connection failed; no further retry. See proxy pool status.'}},{status:502});
        }
        throw e;
      }
    }
  }
  function shouldStop429Fallback(){try{const s=settings();return enabled&&s.config.autoRecover429===true;}catch{return false;}}
  function tick(){try{settings();if(enabled)void refresh();else publish();}catch(e){logger.warn?.('[OpenCodePublicProxy] Settings unavailable: '+e.message);}}
  function getBinding(session){return entries.get(assignments.get(session));}
  function bindingValid(session){const e=getBinding(session);return !!(e&&!e.failed&&e.until<=now()&&e.checkedAt>now()-config.healthMaxAgeSeconds*1000);}
  function rejectBinding(session,delay){const e=getBinding(session);if(e)e.until=Math.max(e.until||0,now()+delay);assignments.delete(session);publish(true);}
  function canAcquire(session){if(bindingValid(session)&&!getBinding(session).inFlight)return true;const occupied=new Set(assignments.values());return usable().some(e=>!e.inFlight&&!occupied.has(e.url));}
  return {fetch:fetchWithPool,refresh,tick,snapshot,shouldStop429Fallback,getBinding,bindingValid,rejectBinding,canAcquire,publish,handledError};
}

function createPool(options){
  if(options.config.inferenceValidation!==true)return createTransportPool(options);
  let admission;
  const storage={...options.storage,status:value=>options.storage.status(admission?admission.snapshot(value):value)};
  const pool=createTransportPool({...options,storage});
  admission=require('./opencode-admission.cjs').createAdmission({...options,pool});
  function getUnavailable(model){const base=pool.snapshot();return require('./availability-status.cjs').describeUnavailable(admission.snapshot(base),model,{now:(options.now||Date.now)(),busyCount:base.lines.filter(l=>l.state==='busy').length});}
  return {...pool,fetch:admission.fetch,snapshot:()=>admission.snapshot(pool.snapshot()),getUnavailable,canRoute:admission.canRoute,maintain:admission.maintain,tick(){pool.tick();void admission.maintain().catch(e=>(options.logger||console).warn?.('[OpenCodeAdmission] '+e.message));}};
}

function runtimeStorage(config){
  const req=require('node:module').createRequire(path.join(process.env.NINEROUTER_APP_ROOT||process.cwd(),'package.json'));let db;
  const database=()=>{if(!db){db=new (req('better-sqlite3'))(config.dbFile);db.pragma('busy_timeout=3000');}return db;};
  return {
    read(){
      const d=database(),data=JSON.parse(d.prepare('SELECT data FROM settings WHERE id=1').get()?.data||'{}');
      let sessions={};try{sessions=JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR||'/app/data','opencode-anonymous-sessions.json'),'utf8')).sessions||{};}catch(e){if(e.code!=='ENOENT')throw e;}
      const connections=d.prepare('SELECT id,name,data FROM providerConnections WHERE provider=? AND isActive=1').all('opencode').filter(r=>JSON.parse(r.data).providerSpecificData?.opencodePoolManaged===true).map(r=>({id:r.id,name:r.name,session:sessions[r.id]||(config.inferenceValidation&&data.opencodePublicProxy?.enabled?globalThis[Symbol.for('9router.opencodeAnonymous.v1')]?.getManagedSession({connectionId:r.id,providerSpecificData:{opencodePoolManaged:true}}):undefined)}));
      return {config:data.opencodePublicProxy||{},connections};
    },
    status(value){database().prepare("UPDATE settings SET data=json_set(data,'$.opencodePublicProxyRuntime',json(?)) WHERE id=1").run(JSON.stringify(value));},
    load(){try{return JSON.parse(fs.readFileSync(config.stateFile,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    save(value){const tmp=config.stateFile+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,config.stateFile);},
  };
}
function getProxyAgent(){
  const vendored=path.join(__dirname,'runtime/node_modules/undici');
  try{
    fs.accessSync(path.join(vendored,'package.json'),fs.constants.R_OK);
    return require(vendored).ProxyAgent;
  }catch(error){
    if(error.code==='EACCES'||error.code==='EPERM')throw new Error('代理依赖目录不可读：'+vendored+'；请检查runtime目录权限', {cause:error});
    if(error.code!=='ENOENT')throw error;
  }
  return require('node:module').createRequire(path.join(process.env.NINEROUTER_APP_ROOT||process.cwd(),'package.json'))('undici').ProxyAgent;
}
module.exports={publicIPv4,normalizeProxy,parseCandidates,mergeCandidates,createPool,limitedText,getProxyAgent};
if(process.env.NINEROUTER_OPENCODE_PUBLIC_PROXY==='1'&&!globalThis[MARK]){
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'opencode-public-proxy.json'),'utf8'));
  if(process.env.DATA_DIR)for(const key of ['dbFile','stateFile'])config[key]=config[key].replace(/^\/app\/data(?=\/|$)/,process.env.DATA_DIR);
  const pool=createPool({nativeFetch:globalThis.fetch.bind(globalThis),config,storage:runtimeStorage(config),makeAgent:uri=>new (getProxyAgent())({uri,requestTls:{rejectUnauthorized:true},proxyTls:{rejectUnauthorized:true},connect:{timeout:config.probeTimeoutMs}})});
  globalThis[MARK]=pool;globalThis.fetch=pool.fetch;
  const timer=setInterval(()=>pool.tick(),3000);timer.unref();pool.tick();
  console.info('[OpenCodePublicProxy] Installed: disabled unless enabled in the dashboard; strict HTTPS and distinct tested egresses.');
}
