'use strict';
// Regression for paid egresses (sticky-session residential proxies paid per GB):
// minted as distinct slots, preferred over the free pool, carrying paid concurrency/line caps,
// surviving a restart with their marker, and re-minted to a different exit IP when refused.
const assert=require('node:assert/strict');
const {createPool}=require('../server/opencode-public-proxy.cjs');
const SESSION='ses_0123456789abABCDEFGHIJKLMN';
const sse=()=>new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const inference='https://opencode.ai/inference/openai/v1/chat/completions';
const business=session=>({method:'POST',headers:{authorization:'Bearer public','x-opencode-session':session},body:'{"model":"test-free"}'});

globalThis[Symbol.for('9router.opencodeAnonymous.v1')]={getManagedSession:()=>SESSION};

const config={
  sources:['https://lists.example/proxies'],ipCheckUrl:'https://ip.example',targetCheckUrl:'https://opencode.ai/inference/v1/models',
  healthMaxAgeSeconds:900,sourceRefreshSeconds:600,probeTimeoutMs:500,maxCandidates:100,maxSourceBytes:10000,maxCandidatesPerRound:20,
  probeConcurrency:2,replenishIntervalSeconds:1,inferenceValidation:true,probeModels:['test-free'],inferenceConcurrency:2,
  inferenceProbesPerMinute:100,inferenceAttemptsPerLine:1,inferenceTimeoutMs:2000,
  screenInference:true,screenModel:'test-free',screenSessions:2,screenBlockedCooldownSeconds:900,
  allowProxySharing:true,maxConcurrentPerEgress:1,maxLinesPerEgress:1,egressFailureThreshold:3,maxEgressCooldownMs:900000,
  paidEgressTemplate:'http://user-session-{id}:pass@paid.example:8080',paidEgressCount:2,
  maxPaidConcurrentPerEgress:9,maxPaidLinesPerEgress:33
};

function fixture(overrides={}){
  const {blockFirstPaid=false}=overrides;
  const cfg={...config,...overrides.config};
  let clock=100000,enabled=true,saved;
  const warns=[],blockedIps=new Set();
  const connections=[{id:'id0',name:'line0',session:'session0'},{id:'id1',name:'line1',session:'session1'},{id:'id2',name:'line2',session:'session2'}];
  const freeIps={'http://8.8.8.8:3128':'9.9.9.9','http://1.1.1.1:8080':'149.112.112.112'};
  // A paid sticky session keeps a stable exit IP per session id, so re-minting changes the IP.
  const ipOf=url=>{
    const u=String(url||'');
    if(u.includes('secret-user'))return '45.33.9.9';
    if(u.includes('8.8.8.8:3128'))return '9.9.9.9';
    if(u.includes('1.1.1.1:8080'))return '149.112.112.112';
    const m=/session-([0-9a-f]+)/.exec(u);
    return m?'45.33.1.'+(parseInt(m[1].slice(0,2),16)%200+10):'4.2.2.2';
  };
  const nativeFetch=async(u,init={})=>{
    const url=init.dispatcher?.url;
    if(u===cfg.sources[0])return new Response(Object.keys(freeIps).map(x=>x.replace('http://','')).join('\n'));
    if(u===cfg.ipCheckUrl)return Response.json({ip:url?ipOf(url):'4.2.2.2'});
    if(u===cfg.targetCheckUrl)return Response.json({data:[]});
    if(String(init.body||'').includes('"tools"')){
      const ip=ipOf(url);
      if(blockedIps.has(ip))return Response.json({error:{type:'FreeTierError',message:'Forbidden'}},{status:403});
      if(blockFirstPaid&&!blockedIps.size&&/paid\.example/.test(String(url||''))){blockedIps.add(ip);return Response.json({error:{type:'FreeTierError',message:'Forbidden'}},{status:403});}
      return sse();
    }
    return new Response('{}');
  };
  const pool=createPool({
    nativeFetch,makeAgent:url=>({url,destroy(){return Promise.resolve()}}),config:cfg,now:()=>clock,
    logger:{info(){},warn:m=>warns.push(String(m))},
    storage:{read:()=>({config:{enabled,targetCount:1,autoRecover429:true,probeModels:['test-free']},connections}),load:()=>saved,save:v=>{saved=v},status(){}}
  });
  return {pool,warns,state:()=>saved,advance:ms=>{clock+=ms},blocked:()=>[...blockedIps],cfg:()=>cfg};
}
const paidUrls=state=>(state.entries||[]).filter(e=>/paid\.example/.test(e.url)).map(e=>e.url);

(async()=>{
  // A configured template mints one sticky-session slot per unit, each a different exit IP.
  const f=fixture();
  await f.pool.refresh();
  const snapshot=f.pool.snapshot();
  assert.equal(snapshot.paidEgresses,2,'both paid slots are validated');
  assert(snapshot.healthy>snapshot.paidEgresses,'the free pool is still used alongside paid exits');
  const urls=paidUrls(f.state());
  assert.equal(urls.length,2,'two paid exits are in the pool');
  assert.equal(new Set(urls).size,2,'slots use different sticky session ids');
  const paidEntry=f.state().entries.find(e=>/paid\.example/.test(e.url));
  assert.equal(paidEntry.paid,'slot0','paid marker persists with the entry');
  assert.equal(paidEntry.paidLines,33,'paid line budget is carried on the entry');
  assert.deepEqual(Object.keys(f.state().paidIds).sort(),['slot0','slot1'],'sticky ids are persisted for restarts');

  // Paid exits carry the traffic; the free pool is the fallback.
  const used=[];
  for(const session of ['session0','session1','session2']){
    const res=await f.pool.fetch(inference,business(session));
    used.push(f.pool.getBinding(session)?.url||'');
    await res.text();
  }
  assert(used.every(u=>/paid\.example/.test(u)),'every line is placed on a paid exit: '+JSON.stringify(used));

  // A refused paid exit is re-minted to a new exit IP instead of being parked for the cooldown.
  const r=fixture({blockFirstPaid:true});
  await r.pool.refresh();
  assert(r.warns.some(w=>w.includes('re-minting a new exit IP')),'a 403 on a paid exit re-mints the slot');
  const blocked=r.blocked();
  assert.equal(blocked.length,1,'exactly one exit IP was refused');
  assert(!r.state().entries.some(e=>e.egress===blocked[0]),'the refused exit is dropped, not parked');
  assert(r.warns.some(w=>w.includes('refused (screen-403)')),'the refusal reason is reported');
  r.advance(2000);
  await r.pool.refresh();
  assert.equal(r.pool.snapshot().paidEgresses,2,'the re-minted slot comes back healthy on a new IP');

  // The non-committed secret file may carry both a static list and the sticky-session template.
  const secret=require('node:path').join(require('node:os').tmpdir(),'paid-egress-'+process.pid+'.json');
  require('node:fs').writeFileSync(secret,JSON.stringify({template:'http://user-session-{id}:pass@paid.example:8080',count:1,egresses:['http://secret-user:secret-pass@8.8.8.8:3128']}));
  const file=fixture({config:{...config,paidEgressTemplate:null,paidEgressCount:0,paidEgressFile:secret}});
  await file.pool.refresh();
  const fileEntries=(file.state().entries||[]).map(e=>e.url);
  assert.equal(file.pool.snapshot().paidEgresses,2,'secret file contributes a static egress and a minted slot');
  assert(fileEntries.includes('http://secret-user:secret-pass@8.8.8.8:3128'),'a static paid egress keeps its credentials');
  assert(fileEntries.filter(u=>/user-session-[0-9a-f]+:pass@paid\.example/.test(u)).length===1,'the file template is minted');
  require('node:fs').unlinkSync(secret);

  // Once a paid exit can carry the lines, lines pinned to the free pool are drained onto it.
  const d = fixture({ config: { ...config, paidEgressTemplate: null, paidEgressCount: 0 } });
  await d.pool.refresh();
  const freeRes = await d.pool.fetch(inference, business('session0'));
  await freeRes.text();
  const before = d.pool.getBinding('session0')?.url || '';
  assert(!/paid\.example/.test(before), 'line starts on the free pool: ' + before);
  d.cfg().paidEgressTemplate = config.paidEgressTemplate;
  d.cfg().paidEgressCount = 1;
  d.advance(2000);
  await d.pool.refresh();
  const afterRes = await d.pool.fetch(inference, business('session0'));
  await afterRes.text();
  const after = d.pool.getBinding('session0')?.url || '';
  assert(/paid\.example/.test(after), 'line was drained off the free pool onto paid: ' + after);

  console.log('PASS: paid sticky-session slots are minted, preferred, capped, persisted across restart, re-minted to a new exit IP when refused, configurable from the secret file, and drain lines off the free pool.');
})().catch(e=>{console.error(e);process.exitCode=1});
