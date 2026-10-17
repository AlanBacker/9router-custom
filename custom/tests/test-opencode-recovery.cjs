'use strict';
const assert=require('node:assert/strict');
const {createPool}=require('../server/opencode-public-proxy.cjs');
const {classifyFailure}=require('../server/opencode-recovery-rules.cjs');
const url='https://opencode.ai/inference/openai/v1/chat/completions';
const config={sources:['https://list.example'],ipCheckUrl:'https://ip.example',targetCheckUrl:'https://opencode.ai/inference/v1/models',healthMaxAgeSeconds:900,sourceRefreshSeconds:600,probeTimeoutMs:500,maxCandidates:100,maxSourceBytes:10000,maxCandidatesPerRound:10,probeConcurrency:1,replenishIntervalSeconds:1};
const options=()=>({method:'POST',headers:{authorization:'Bearer public','x-opencode-session':'a'},body:'{"model":"test"}'});
function fixture({auto=true,count=3,always=false,status=429,detail={type:'FreeUsageLimitError',message:'Rate limit exceeded'},abortAfterFirst=false,saved=null,throwFirst=null}={}){
 let clock=100000,session='a',renews=0,cache=saved,c={enabled:true,targetCount:1,autoRecover429:auto};
 const posts=[],events=[],probeUrls=[],ips={'http://8.8.8.8:3128':'9.9.9.9','http://1.1.1.1:3128':'149.112.112.112','http://8.8.4.4:3128':'208.67.222.222'};
 const controller=new AbortController();
 const pool=createPool({config,logger:{info(){},warn(){}},now:()=>clock,
  storage:{read:()=>({config:c,connections:[{session,name:'line'}]}),load:()=>cache,save:v=>{cache=v},status(){}},
  makeAgent:url=>({url,destroy:async()=>{}}),
  renewSession:(old,reason)=>{assert.equal(reason,'invalid_session');assert.equal(old,session);renews++;return session='renewed';},
  nativeFetch:async(u,i={})=>{
   events.push(String(u));
   if(u===config.sources[0])return new Response(Object.keys(ips).slice(0,count).join('\n'));
   if(u===config.ipCheckUrl){if(i.dispatcher)probeUrls.push(i.dispatcher.url);return Response.json({ip:i.dispatcher?ips[i.dispatcher.url]:'4.2.2.2'});}
   if(u===config.targetCheckUrl)return Response.json({data:[]});
   posts.push(i);
   if(abortAfterFirst)controller.abort();
   if(throwFirst&&(posts.length===1||always))throw throwFirst;
   return posts.length===1||always?Response.json({error:detail},{status,headers:{'retry-after':'30'}}):new Response('data: SUCCESS\n\n',{headers:{'content-type':'text/event-stream'}});
  }
 });
 return {pool,posts,events,probeUrls,controller,cache:()=>cache,renews:()=>renews,advance:n=>{clock+=n},disable:()=>{c.autoRecover429=false}};
}
async function run(f){await f.pool.refresh();const response=await f.pool.fetch(url,{...options(),signal:f.controller.signal});await response.text();return response;}
(async()=>{
 assert.equal(classifyFailure(429,{error:{type:'FreeTierError',message:'Rate limit'}}).kind,'rate');
 assert.equal(classifyFailure(429,{error:{message:'Endpoint is unavailable.'}}).kind,'endpoint');
 assert.equal(classifyFailure(403,{error:{type:'FreeTierError',message:'Forbidden'}}).kind,'access');
 const f=fixture();assert.equal((await run(f)).status,200);assert.equal(f.posts.length,2);assert.notEqual(f.posts[0].dispatcher.url,f.posts[1].dispatcher.url);assert.equal(new Headers(f.posts[1].headers).get('x-opencode-session'),'a');assert.equal(f.renews(),0);assert.equal(f.pool.snapshot().proxySwitches,1);assert.equal(f.pool.snapshot().recoverySuccesses,1);assert.equal(f.pool.snapshot().healthy,2);f.advance(30001);assert.equal(f.pool.snapshot().healthy,3,'old exit keeps Retry-After cooldown');
 assert.equal(f.pool.snapshot().desired,3,'two standby exits');assert.equal(f.pool.shouldStop429Fallback(),true);f.disable();assert.equal(f.pool.shouldStop429Fallback(),false);
 const repeated=fixture({always:true});assert.equal((await run(repeated)).status,429);assert.equal(repeated.posts.length,2,'one retry maximum');assert.equal(repeated.renews(),0);
 const off=fixture({auto:false});assert.equal((await run(off)).status,429);assert.equal(off.posts.length,1);assert.equal(off.pool.snapshot().proxySwitches,0);
 const empty=fixture({count:1});assert.equal((await run(empty)).status,429);assert.equal(empty.posts.length,1,'no spare means no retry or direct fallback');
 const endpoint=fixture({detail:{message:'Endpoint is unavailable.'}});assert.equal((await run(endpoint)).status,429);assert.equal(endpoint.posts.length,1);assert.equal(endpoint.pool.snapshot().healthy,3,'endpoint failure does not cool IP');assert.equal(endpoint.renews(),0);
 const invalid=fixture({status:400,detail:{code:'invalid_session',message:'Session is invalid'}});assert.equal((await run(invalid)).status,200);assert.equal(invalid.renews(),1);assert.equal(invalid.posts[0].dispatcher.url,invalid.posts[1].dispatcher.url,'session repair retains proxy');for(const name of ['x-opencode-session','x-opencode-session-id','x-session-affinity','x-session-id'])assert.equal(new Headers(invalid.posts[1].headers).get(name),'renewed');assert.equal(invalid.pool.snapshot().sessionRepairs,1);
 const invalid429=fixture({detail:{type:'session_expired',message:'Session expired'}});assert.equal((await run(invalid429)).status,200);assert.equal(invalid429.pool.snapshot().healthy,3,'invalid-session 429 is not quota cooldown');
 const forbidden=fixture({status:403,detail:{type:'FreeTierError',message:'Forbidden'}});assert.equal((await run(forbidden)).status,200);assert.equal(forbidden.posts.length,2);assert.equal(forbidden.renews(),0);
 for(const status of [407,408,502,503,504]){const gateway=fixture({status,detail:{message:'Gateway error'}});assert.equal((await run(gateway)).status,200,'gateway '+status);assert.equal(gateway.posts.length,2);assert.equal(gateway.renews(),0);}
 const banned=fixture({status:403,detail:{message:'Account has been banned'}});assert.equal((await run(banned)).status,403);assert.equal(banned.posts.length,1);assert.equal(banned.renews(),0,'account restriction never creates an identity');
 const unauthorized=fixture({status:401,detail:{message:'Invalid API key'}});assert.equal((await run(unauthorized)).status,401);assert.equal(unauthorized.posts.length,1);assert.equal(unauthorized.renews(),0);
 assert.equal(unauthorized.pool.snapshot().lines[0].state,'auth-cooldown');const paused=await unauthorized.pool.fetch(url,options());assert.equal(paused.status,503);assert.equal(paused.headers.get('retry-after'),'30');assert.equal(unauthorized.posts.length,1,'quarantined identity is not hammered');
 const pausedRestart=fixture({saved:unauthorized.cache()});await pausedRestart.pool.refresh();assert.equal((await pausedRestart.pool.fetch(url,options())).status,503);assert.equal(pausedRestart.posts.length,0,'identity quarantine survives restart');
 unauthorized.advance(30001);assert.equal((await run(unauthorized)).status,200,'expired quarantine automatically permits a new check');
 const parameter=fixture({status:400,detail:{message:'Invalid max_tokens'}});assert.equal((await run(parameter)).status,400);assert.equal(parameter.posts.length,1);
 const connectionError=Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});const network=fixture({throwFirst:connectionError});assert.equal((await run(network)).status,200);assert.equal(network.posts.length,2);assert.notEqual(network.posts[0].dispatcher.url,network.posts[1].dispatcher.url);
 const dead=fixture({throwFirst:connectionError,always:true});const deadResponse=await run(dead);assert.equal(deadResponse.status,502);assert.equal(dead.posts.length,2,'transport failure bounded too');
 const bug=fixture({throwFirst:new Error('internal bug')});await assert.rejects(run(bug),/internal bug/);assert.equal(bug.posts.length,1,'programming errors are not replayed');
 const abort=fixture({abortAfterFirst:true});assert.equal((await run(abort)).status,429);assert.equal(abort.posts.length,1,'abort prevents replay');
 const maintenance=fixture();await maintenance.pool.refresh();assert.equal(maintenance.pool.snapshot().maintenance.automatic,true);const sourceCount=()=>maintenance.events.filter(u=>u===config.sources[0]).length;const initialSources=sourceCount();maintenance.advance(600001);await maintenance.pool.refresh();assert(sourceCount()>initialSources,'source lists refresh without user action');const probes=maintenance.pool.snapshot().tested;maintenance.advance(900001);await maintenance.pool.refresh();assert(maintenance.pool.snapshot().tested>probes,'expired exit health automatically rechecked');assert.equal(maintenance.pool.snapshot().healthy,3);
 const cached='http://8.8.4.4:3128';const restarted=fixture({count:1,saved:{version:1,entries:[{url:cached,egress:'208.67.222.222',until:0,checkedAt:100000}],assignments:{a:cached}}});await restarted.pool.refresh();assert.equal(restarted.probeUrls[0],cached,'restarts revalidate prior working exits before new public candidates');assert.equal(restarted.pool.snapshot().healthy,1);restarted.advance(1001);await restarted.pool.refresh();assert.equal(restarted.pool.snapshot().healthy,2);
 console.log('PASS: bounded rate/access/gateway/transport recovery; Retry-After; invalid-session-only renewal; persistent auth quarantine and expiry; automatic maintenance and restart revalidation; exclusions and retry limits.');
})().catch(e=>{console.error(e);process.exitCode=1});


