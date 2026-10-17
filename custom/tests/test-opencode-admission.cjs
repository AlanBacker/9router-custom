'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createPool}=require('../server/opencode-public-proxy.cjs');
const {buildProbe,consumeProbe}=require('../server/opencode-inference-probe.cjs');
const {transformAuth}=require('../source/admission.cjs');
const url='https://opencode.ai/inference/v1/chat/completions';
const stream=()=>new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
function fixture({bad=2,models=['test-free'],empty=false,budget=24,count=1}={}){
 let clock=100000,cache,enabled=true;
 const connections=Array.from({length:count},(_,i)=>({id:'id'+i,name:'line'+i,session:'session'+i}));
 const posts=[],ips={'http://8.8.8.8:3128':'9.9.9.9','http://1.1.1.1:3128':'149.112.112.112','http://8.8.4.4:3128':'208.67.222.222'};
 const config={sources:['https://list.example'],ipCheckUrl:'https://ip.example',targetCheckUrl:'https://opencode.ai/inference/v1/models',healthMaxAgeSeconds:900,sourceRefreshSeconds:600,probeTimeoutMs:500,maxCandidates:100,maxSourceBytes:10000,maxCandidatesPerRound:10,probeConcurrency:1,replenishIntervalSeconds:1,inferenceValidation:true,probeModels:models,inferenceConcurrency:2,inferenceProbesPerMinute:budget,inferenceAttemptsPerLine:3};
 const pool=createPool({config,now:()=>clock,logger:{info(){},warn(){}},storage:{read:()=>({config:{enabled,targetCount:3,autoRecover429:true},connections}),load:()=>cache,save:v=>{cache=v},status(){}},
  makeAgent:url=>({url,destroy:async()=>{}}),
  builder:async(model,session)=>({url,init:{method:'POST',headers:{authorization:'Bearer public','x-opencode-session':session},body:JSON.stringify({model})}}),
  nativeFetch:async(u,i={})=>{
   if(u===config.sources[0])return new Response(Object.keys(ips).join('\n'));
   if(u===config.ipCheckUrl)return Response.json({ip:i.dispatcher?ips[i.dispatcher.url]:'4.2.2.2'});
   if(u===config.targetCheckUrl)return Response.json({data:[]});
   posts.push(i);if(posts.length<=bad)return Response.json({error:{type:'FreeTierError',message:'Forbidden'}},{status:403});
   return empty?new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}):stream();
  }
 });
 return {pool,posts,cache:()=>cache,advance:n=>{clock+=n},disable:()=>{enabled=false}};
}
(async()=>{
 const f=fixture();await f.pool.refresh();assert.equal(f.pool.canRoute('id0','test-free'),false);assert.equal(f.pool.snapshot().readyCount,0);
 const pending=await f.pool.fetch(url,{method:'POST',headers:{authorization:'Bearer public','x-opencode-session':'session0'},body:'{"model":"test-free"}'});assert.equal(pending.status,503,'pending never sends business traffic');await f.pool.maintain();
 assert.equal(f.posts.length,3);assert.equal(new Set(f.posts.map(p=>p.dispatcher.url)).size,3,'failed proxies replaced until completed inference');assert.equal(f.pool.canRoute('id0','test-free'),true);assert.equal(f.pool.snapshot().readyCount,1);assert(f.cache().entries.some(e=>e.until>=100000+1800000),'rejected exits retain long quarantine');
 assert(f.posts.every(p=>new Headers(p.headers).get('x-opencode-session')==='session0'),'probe retries keep identity');
 const business=await f.pool.fetch(url,{method:'POST',headers:{authorization:'Bearer public','x-opencode-session':'session0'},body:'{"model":"test-free"}'});assert.equal(business.status,200);assert.equal(f.pool.canRoute('id0','test-free'),false,'busy validated lines excluded from concurrent selection');await business.text();assert.equal(f.pool.canRoute('id0','test-free'),true);
 f.advance(1800001);assert.equal(f.pool.canRoute('id0','test-free'),false,'expired validation cannot route');
 const noOutput=fixture({bad:0,empty:true});await noOutput.pool.refresh();await noOutput.pool.maintain();assert.equal(noOutput.pool.snapshot().readyCount,0);assert.equal(new Set(noOutput.posts.map(p=>p.dispatcher.url)).size,3,'empty HTTP 200 is rejected and replaced');
 const multi=fixture({bad:0,models:['a','b']});await multi.pool.refresh();await multi.pool.maintain();assert.equal(multi.pool.snapshot().readyCount,1);assert.equal(multi.posts.length,2,'each configured model is verified');assert.equal(multi.posts[0].dispatcher.url,multi.posts[1].dispatcher.url,'all checks use the bound exit');
 const limited=fixture({bad:0,models:['a','b'],budget:1,count:2});await limited.pool.refresh();await limited.pool.maintain();assert.equal(limited.posts.length,1,'concurrent workers respect global probe budget');assert.equal(limited.pool.snapshot().readyCount,0);
 const off=fixture({bad:0});off.disable();await off.pool.maintain();assert.equal(off.posts.length,0);
 assert.equal((await consumeProbe(new Response('data: {"error":{"message":"failed"}}\n\n',{headers:{'content-type':'text/event-stream'}}))).ok,false,'SSE errors never pass');
 const native=await buildProbe('deepseek-v4.1-flash-free','ses_0123456789abABCDEFGHIJKLMN',{inferenceMaxTokens:64});const b=JSON.parse(native.init.body);assert.equal(b.stream,true);assert.equal(b.max_tokens,64);assert(b.tools.some(t=>t.function.name==='read'));assert(b.tools.some(t=>t.function.name==='shell'));
 const min='let r=k.filter(a=>{if(n.has(a.id)||(0,f.Bl)(a,c))return!1;let b=a.providerSpecificData?.enabledModels;return!0});if(0===r.length){let b=k.filter(a=>(0,f.Bl)(a,c));return null;}';
 const transformed=transformAuth(min);assert.equal(transformed.count,1);assert(transformed.code.includes('9R_OC_ADMISSION_PENDING_V1'));assert.equal(transformAuth(transformed.code).count,0);
 const context={k:[{id:'pending',providerSpecificData:{opencodePoolManaged:true}},{id:'ready',providerSpecificData:{opencodePoolManaged:true}},{id:'ordinary'}],n:new Set(),f:{Bl:()=>false},c:'test',globalThis:{[Symbol.for('9router.opencodePublicProxy.v1')]:{canRoute:id=>id==='ready'}}};
 assert.deepEqual([...vm.runInNewContext('(function(){'+transformed.code+'return r.map(x=>x.id)})()',context)],['ready','ordinary']);
 const none={...context,k:[context.k[0]]};assert.equal(vm.runInNewContext('(function(){'+transformed.code+'return r})()',none).lastErrorCode,503);
 assert(fs.readFileSync('src/sse/services/auth.js','utf8').includes('9R_OC_ADMISSION_V1'));
 console.log('PASS: pending routing exclusion, repeated proxy replacement, completed inference only, stable sessions, every-model verification, global budget, expiry, native builder, empty/error SSE rejection, compiled compatibility gate.');
})().catch(e=>{console.error(e);process.exitCode=1});
