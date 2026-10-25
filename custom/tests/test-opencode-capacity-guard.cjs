'use strict';
// Anti-freeze guards: exit screening must follow real capacity, not the configured line count,
// and admission must never let an unbounded crowd sit in the same wait loop.
const assert=require('node:assert/strict');
const {createPool}=require('../server/opencode-public-proxy.cjs');
const {createAdmission}=require('../server/opencode-admission.cjs');

const quiet={info(){},warn(){}};
const url='https://opencode.ai/inference/openai/v1/chat/completions';
const baseConfig={
  sources:['https://lists.example/proxies'],ipCheckUrl:'https://ip.example',
  targetCheckUrl:'https://opencode.ai/inference/v1/models',healthMaxAgeSeconds:900,
  sourceRefreshSeconds:600,probeTimeoutMs:500,maxCandidates:500,maxSourceBytes:200000,
  maxCandidatesPerRound:320,probeConcurrency:4,replenishIntervalSeconds:1,maxLinesPerEgress:24,
};

function capacityFixture({connections=100,auto=false,sharing=true}={}){
  let clock=100000;
  const config={enabled:true,targetCount:connections,autoRecover429:auto};
  const conns=Array.from({length:connections},(_,i)=>({session:'s'+i,name:'line '+i}));
  const list=Array.from({length:200},(_,i)=>`http://11.0.${i}.1:3128`);
  const ipOf=new Map(list.map((u,i)=>[u,`20.0.${i}.1`]));
  const nativeFetch=async(u,init={})=>{
    if(u===baseConfig.sources[0])return new Response(list.join('\n'));
    if(u===baseConfig.ipCheckUrl)return Response.json({ip:init.dispatcher?ipOf.get(init.dispatcher.url):'4.2.2.2'});
    if(u===baseConfig.targetCheckUrl)return Response.json({data:[]});
    return new Response('data: OK\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const pool=createPool({
    nativeFetch,makeAgent:u=>({url:u,destroy:async()=>{}}),
    storage:{read:()=>({config,connections:conns}),load:()=>null,save(){},status(){}},
    config:{...baseConfig,allowProxySharing:sharing},logger:quiet,now:()=>clock,
  });
  return {pool,advance:n=>{clock+=n}};
}

(async()=>{
  const shared=capacityFixture({connections:100});
  await shared.pool.refresh();
  const big=shared.pool.snapshot();
  assert.equal(big.configuredLines,100);
  assert.equal(big.desired,100);
  assert.equal(big.egressTarget,Math.ceil(100/24),'100 shared lines need 5 exits, not 100');
  assert.ok(big.healthy>=big.egressTarget&&big.healthy<=big.egressTarget+3,'screening stops around the capacity target (healthy='+big.healthy+')');
  assert.ok(big.tested<=big.egressTarget+4,'a 100-line install must not probe 100 proxies (tested='+big.tested+')');

  const exclusive=capacityFixture({connections:3,sharing:false});
  await exclusive.pool.refresh();
  assert.equal(exclusive.pool.snapshot().egressTarget,3,'sharing off means one exit per line');

  const standby=capacityFixture({connections:1,auto:true});
  await standby.pool.refresh();
  assert.equal(standby.pool.snapshot().desired,3);
  assert.equal(standby.pool.snapshot().egressTarget,3,'recovery keeps two standby exits');

  // A paid exit that covers every line removes the reason to screen public proxies at all.
  let clock=100000;
  const paidConfig={enabled:true,targetCount:50};
  const conns=Array.from({length:50},(_,i)=>({session:'p'+i,name:'paid line '+i}));
  const pool=createPool({
    nativeFetch:async(u,init={})=>{
      if(u===baseConfig.ipCheckUrl)return Response.json({ip:init.dispatcher?'20.9.9.9':'4.2.2.2'});
      if(u===baseConfig.targetCheckUrl)return Response.json({data:[]});
      return new Response('data: OK\n\n',{headers:{'content-type':'text/event-stream'}});
    },
    makeAgent:u=>({url:u,destroy:async()=>{}}),
    storage:{read:()=>({config:paidConfig,connections:conns,paid:{enabled:true,template:'http://user-sessid.{id}:secret@gw.example:823',count:2,lines:30,concurrency:4}}),load:()=>null,save(){},status(){}},
    config:{...baseConfig,maxLinesPerEgress:24},logger:quiet,now:()=>clock,
  });
  await pool.refresh();
  clock+=1001;
  await pool.refresh();
  const paid=pool.snapshot();
  assert.equal(paid.healthy,2,'both paid exits validate');
  assert.equal(paid.egressTarget,0,'paid capacity covers all 50 lines');

  // A permanently dead paid slot must not turn every round into a full public-candidate sweep
  // once the free pool already covers the lines.
  let fclock=200000;
  const deadConfig={enabled:true,targetCount:10};
  const deadConns=Array.from({length:10},(_,i)=>({session:'d'+i,name:'line '+i}));
  const freeList=Array.from({length:60},(_,i)=>`http://11.1.${i}.1:3128`);
  const freeIp=new Map(freeList.map((u,i)=>[u,`20.1.${i}.1`]));
  let probes=0;
  const deadPool=createPool({
    nativeFetch:async(u,init={})=>{
      if(u===baseConfig.ipCheckUrl){
        const dispatcher=init.dispatcher?.url||'';
        if(dispatcher.includes('gw.example'))return new Response('blocked',{status:403});
        probes++;
        return Response.json({ip:freeIp.get(dispatcher)||'4.2.2.2'});
      }
      if(u===baseConfig.targetCheckUrl)return Response.json({data:[]});
      if(u===baseConfig.sources[0])return new Response(freeList.join('\n'));
      return new Response('data: OK\n\n',{headers:{'content-type':'text/event-stream'}});
    },
    makeAgent:u=>({url:u,destroy:async()=>{}}),
    storage:{read:()=>({config:deadConfig,connections:deadConns,paid:{enabled:true,template:'http://user-sessid.{id}:secret@gw.example:823',count:2,lines:30,concurrency:4}}),load:()=>null,save(){},status(){}},
    config:{...baseConfig,maxLinesPerEgress:24},logger:quiet,now:()=>fclock,
  });
  await deadPool.refresh();
  const firstProbes=probes;
  fclock+=1001;
  await deadPool.refresh();
  assert.ok(probes-firstProbes<=2,'a dead paid slot only retries itself once free capacity is met (probed '+(probes-firstProbes)+' free candidates)');

  // Admission: with no working exit, at most admissionMaxWaiters requests may wait; the rest fail
  // fast with a retry hint instead of piling up for admissionWaitMs each.
  const conns40=Array.from({length:40},(_,i)=>({id:'c'+i,session:'a'+i,name:'line '+i}));
  const admissionConfig={enabled:true,probeModels:['test-free'],inferenceProbesPerMinute:24,inferenceConcurrency:2,admissionWaitMs:5000,admissionShortWaitMs:300,admissionMaxWaiters:8,inferenceTimeoutMs:100,inferenceAttemptsPerLine:1,inferenceHealthMaxAgeSeconds:1800};
  const admission=createAdmission({
    config:admissionConfig,now:Date.now,logger:quiet,
    storage:{read:()=>({config:admissionConfig,connections:conns40})},
    pool:{snapshot:()=>({healthy:0}),fetch:async()=>new Response('',{status:200}),getBinding:()=>null,bindingValid:()=>false,canAcquire:()=>false,sessionBusy:()=>false,rejectBinding(){},publish(){},handledError:r=>r},
  });
  const started=Date.now();
  const responses=await Promise.all(conns40.map(c=>admission.fetch(url,{method:'POST',headers:{authorization:'Bearer public','x-opencode-session':c.session},body:JSON.stringify({model:'test-free'})})));
  const elapsed=Date.now()-started;
  assert.ok(responses.every(r=>r.status===503),'no direct fallback and no hanging request');
  const snap=admission.snapshot({healthy:0});
  assert.equal(snap.admissionWaiters,0,'waiters are released');
  assert.equal(snap.admissionOverloads,32,'8 wait, the other 32 fail fast');
  assert.ok(elapsed<2500,'the crowd must not queue for admissionWaitMs (took '+elapsed+'ms)');
  console.log('PASS: egress screening follows line capacity (shared, exclusive, standby, paid) and admission waiters are bounded.');
})().catch(e=>{console.error(e);process.exitCode=1});
