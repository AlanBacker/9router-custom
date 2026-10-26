'use strict';
// Regression: admission must not show the caller a blocked-egress 403 or an instant 503 while a
// working egress exists. It re-validates the line and retries once on a fresh egress instead.
const assert=require('node:assert/strict');
const {createAdmission}=require('../server/opencode-admission.cjs');
const url='https://opencode.ai/inference/v1/chat/completions';
const sse=()=>new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});

function fixture({biz403=0,healthy=3,probeOk=true}={}){
  const calls=[];let binding={url:'http://proxy-a:8080',egress:'1.1.1.1'};let remaining=biz403;
  const pool={
    getBinding:()=>binding,bindingValid:s=>s==='session0'&&Boolean(binding),sessionBusy:()=>false,canAcquire:()=>true,
    snapshot:()=>({healthy}),publish(){},
    rejectBinding(s){calls.push('reject');binding=null;},
    handledError:r=>r,
    async fetch(u,i={}){
      // The admission layer marks both probes and business calls with the same symbol, so tell
      // them apart the way the pool does: probes carry the tool schema in the body.
      const body=String(i.body||'');
      if(body.includes('Reply OK.')){
        calls.push('probe');
        if(!probeOk)return Response.json({error:{message:'proxy down'}},{status:502});
        binding={url:'http://proxy-b:9090',egress:'2.2.2.2'};return sse();
      }
      calls.push('business');
      if(remaining>0){remaining--;return Response.json({error:{type:'FreeTierError',message:"OpenCode's free tier can only be used from within OpenCode."}},{status:403});}
      return sse();
    }
  };
  const storage={read:()=>({config:{enabled:true,targetCount:1,probeModels:['test-free'],autoRecover429:true},connections:[{id:'id0',name:'line0',session:'session0'}]})};
  const config={probeModels:['test-free'],inferenceProbesPerMinute:24,inferenceConcurrency:2,admissionWaitMs:2000,admissionShortWaitMs:300,inferenceRejectCooldownSeconds:900,inferenceHealthMaxAgeSeconds:1800,inferenceAttemptsPerLine:1};
  const admission=createAdmission({pool,storage,config,now:Date.now,logger:{info(){},warn(){}}});
  return {admission,calls,lose(){binding=null;}};
}

const business={method:'POST',headers:{authorization:'Bearer public','x-opencode-session':'session0'},body:'{"model":"test-free"}'};

(async()=>{
  // A blocked egress used to leak one 403 to the caller; now it must be retried on a fresh egress.
  const f=fixture({biz403:1});await f.admission.maintain();
  assert.equal(f.admission.canRoute('id0','test-free'),true,'validated line can route');
  const retried=await f.admission.fetch(url,business);
  assert.equal(retried.status,200,'blocked egress 403 is retried instead of returned');
  assert.deepEqual(f.calls,['probe','business','reject','probe','business'],'exactly one revalidation and one retry');
  await retried.text();
  assert.equal(f.admission.canRoute('id0','test-free'),true,'line recovers on the replacement egress');

  // A line that lost its binding while an egress exists must wait, revalidate and then serve
  // instead of answering an instant 503.
  const w=fixture({healthy:2});await w.admission.maintain();
  assert.equal(w.admission.canRoute('id0','test-free'),true);
  w.lose();
  assert.equal(w.admission.canRoute('id0','test-free'),false,'lost binding cannot route');
  const waited=await w.admission.fetch(url,business);
  assert.equal(waited.status,200,'line revalidates instead of answering 503');
  await waited.text();

  // With no usable egress at all the caller still gets a fast 503 with retry-after.
  const dry=fixture({healthy:0,probeOk:false});
  const dryRes=await dry.admission.fetch(url,business);
  assert.equal(dryRes.status,503,'dry pool answers 503');
  assert(dryRes.headers.get('retry-after'),'503 carries retry-after');
  await dryRes.text();

  console.log('PASS: blocked-egress 403 retried once on a fresh exit, single revalidation, lost binding revalidated instead of 503, dry pool still 503.');
})().catch(e=>{console.error(e);process.exitCode=1});
