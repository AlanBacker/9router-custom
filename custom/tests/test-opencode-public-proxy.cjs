'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {publicIPv4,normalizeProxy,parseCandidates,mergeCandidates,createPool,createTransportPool,getProxyAgent}=require('../server/opencode-public-proxy.cjs');
const {updateConfig}=require('../browser/opencode-public-proxy-ui.js');
const quiet={info(){},warn(){}};
const config={sources:['https://lists.example/proxies'],ipCheckUrl:'https://ip.example',targetCheckUrl:'https://opencode.ai/inference/v1/models',healthMaxAgeSeconds:900,sourceRefreshSeconds:600,probeTimeoutMs:500,maxCandidates:100,maxSourceBytes:10000,maxCandidatesPerRound:10,probeConcurrency:2,replenishIntervalSeconds:1,allowProxySharing:false};
const url='https://opencode.ai/inference/openai/v1/chat/completions';
const options=(session,authorization='Bearer public')=>({method:'POST',headers:{authorization,'x-opencode-session':session},body:'{}'});
function fixture({duplicate=false,failFirstSource=false}={}){
 let c={enabled:false,targetCount:2},saved,status,clock=100000,postStatus=200;
 const calls=[],agents=[];
 const ipByUrl={'http://8.8.8.8:3128':'9.9.9.9','http://1.1.1.1:8080':duplicate?'9.9.9.9':'149.112.112.112'};
 const storage={read:()=>({config:c,connections:[{session:'a',name:'line a'},{session:'b',name:'line b'}]}),load:()=>saved,save:v=>{saved=v},status:v=>{status=v}};
 const nativeFetch=async(u,init={})=>{
   calls.push({url:String(u),init});
   if(u==='https://lists.example/unavailable')throw new Error('Source unavailable');
   if(u===config.sources[0])return new Response('8.8.8.8:3128\n1.1.1.1:8080\n127.0.0.1:22\n10.0.0.1:80');
   if(u===config.ipCheckUrl)return Response.json({ip:init.dispatcher?ipByUrl[init.dispatcher.url]:'4.2.2.2'});
   if(u===config.targetCheckUrl)return Response.json({data:[]});
   if(postStatus===429)return Response.json({error:{type:'FreeUsageLimitError',message:'Rate limit exceeded'}},{status:429,headers:{'retry-after':'30'}});
   return new Response('data: OK\n\n',{headers:{'content-type':'text/event-stream'}});
 };
 const poolConfig=failFirstSource?{...config,sources:['https://lists.example/unavailable',...config.sources]}:config;
 const pool=createPool({nativeFetch,makeAgent:url=>{const a={url,destroyed:false,destroy(){this.destroyed=true;return Promise.resolve()}};agents.push(a);return a},storage,config:poolConfig,logger:quiet,now:()=>clock});
 return {pool,calls,agents,enable:()=>{c={...c,enabled:true}},disable:()=>{c={...c,enabled:false}},advance:ms=>{clock+=ms},limit:()=>{postStatus=429},state:()=>({saved,status})};
}
(async()=>{
for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','224.0.0.1','0.0.0.0','::1'])assert.equal(publicIPv4(ip),false,ip);
assert.equal(publicIPv4('8.8.8.8'),true);
assert.equal(normalizeProxy('http://user:pass@8.8.8.8:80'),null);assert.equal(normalizeProxy('localhost:8080'),null);assert.equal(normalizeProxy('http://8.8.8.8:80/path'),null);assert.equal(normalizeProxy('socks5://8.8.8.8:8080'),null);
assert.deepEqual(parseCandidates('8.8.8.8:3128\nhttp://8.8.8.8:3128\n127.0.0.1:80'),['http://8.8.8.8:3128']);
assert.deepEqual(mergeCandidates([['a','b','c','d'],['backup1'],['backup2','a']],3),['a','backup1','backup2']);
assert.equal(typeof getProxyAgent(),'function');
const denied={exports:{}};
const outputReq=require('node:module').createRequire(path.resolve('custom/server/opencode-public-proxy.cjs'));
vm.runInNewContext(fs.readFileSync('custom/server/opencode-public-proxy.cjs','utf8'),{module:denied,require:name=>name==='node:fs'?{...fs,accessSync(){const e=new Error('permission denied');e.code='EACCES';throw e}}:outputReq(name),__dirname:path.resolve('custom/server'),process:{env:{}},console});
assert.throws(()=>denied.exports.getProxyAgent(),e=>e.cause?.code==='EACCES'&&e.message.includes('代理依赖目录不可读'));

const f=fixture();f.pool.tick();assert.equal(f.calls.length,0,'disabled must not download lists');
await (await f.pool.fetch(url,options('a'))).text();assert.equal(f.calls[0].init.dispatcher,undefined);
f.calls.length=0;f.enable();await f.pool.refresh();assert.equal(f.pool.snapshot().healthy,2);
assert.equal(f.pool.snapshot().sources[0].count,2);assert.equal(f.pool.snapshot().sources[0].ok,true);
const a=await f.pool.fetch(url,options('a'));assert.equal(a.status,200);
assert.equal((await f.pool.fetch(url,options('a'))).status,503,'one in-flight request per line');
const b=await f.pool.fetch(url,options('b'));assert.equal(b.status,200);
const posts=f.calls.filter(c=>c.url===url);assert.notEqual(posts.at(-1).init.dispatcher.url,posts.at(-2).init.dispatcher.url);
assert.notEqual(posts.at(-1).init[Symbol.for('9router.opencodeEgress.v1')],posts.at(-2).init[Symbol.for('9router.opencodeEgress.v1')]);
await a.text();await b.text();
f.limit();const r=await f.pool.fetch(url,options('a'));assert.equal(r.status,429);await r.text();
assert.equal(f.pool.snapshot().healthy,1);assert.equal((await f.pool.fetch(url,options('a'))).status,503,'no reuse of another bound line or direct fallback');
f.advance(30001);assert.equal(f.pool.snapshot().healthy,2);
f.disable();f.pool.tick();assert(f.agents.every(a=>a.destroyed));
const direct=await f.pool.fetch(url,options('a'));await direct.text();assert.equal(f.calls.at(-1).init.dispatcher,undefined);
const other=await f.pool.fetch(url,options('a','Bearer actual-account-key'));await other.text();assert.equal(f.calls.at(-1).init.dispatcher,undefined);

const duplicate=fixture({duplicate:true});duplicate.enable();await duplicate.pool.refresh();assert.equal(duplicate.pool.snapshot().healthy,1,'different addresses sharing one egress must be deduplicated');
const limited=await duplicate.pool.fetch(url,options('a'));await limited.text();assert.equal((await duplicate.pool.fetch(url,options('b'))).status,503);
const backup=fixture({failFirstSource:true});backup.enable();await backup.pool.refresh();assert.equal(backup.pool.snapshot().healthy,2);assert.equal(backup.pool.snapshot().sources[0].ok,false);assert.equal(backup.pool.snapshot().sources[1].ok,true);

// A maintenance round that never settles must be abandoned so later ticks still make progress.
{
  let clock=500000,hang=false;
  const stallConfig={...config,roundTimeoutMs:30000,targetCount:1};
  const storage={read:()=>({config:{enabled:true,targetCount:1},connections:[{session:'a',name:'line a'}]}),load:()=>null,save:()=>{},status:()=>{}};
  const nativeFetch=async(u,init={})=>{
    if(u===stallConfig.sources[0])return new Response('8.8.8.8:3128');
    if(u===stallConfig.ipCheckUrl)return Response.json({ip:init.dispatcher?'9.9.9.9':'4.2.2.2'});
    if(u===stallConfig.targetCheckUrl){if(hang)return new Promise(()=>{});return Response.json({data:[]});}
    return new Response('data: ok\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const pool=createPool({nativeFetch,makeAgent:()=>({url:'http://8.8.8.8:3128',destroy(){return Promise.resolve()}}),storage,config:stallConfig,logger:quiet,now:()=>clock});
  await pool.refresh();
  assert.equal(pool.snapshot().healthy,1,'baseline round completes');
  hang=true;clock+=stallConfig.healthMaxAgeSeconds*1000+1;
  void pool.refresh();                       // starts a round that will never settle
  assert.equal(pool.snapshot().maintenance.roundAgeSeconds,0,'a fresh round has zero age');
  clock+=30001;
  assert.equal(pool.snapshot().maintenance.stalled,true,'a round past its deadline is reported as stalled');
  hang=false;
  await pool.refresh();                      // abandon the hung round, start a fresh one that completes
  const snap=pool.snapshot();
  assert.equal(snap.maintenance.roundAbandons,1,'the hung round is abandoned exactly once');
  assert.equal(snap.maintenance.stalled,false,'a fresh round is not stalled');
  assert.equal(snap.healthy,1,'the pool keeps working after a stall');
}
const payload=[];
// Inference screening must keep anti-abuse-blocked egresses out of the assignable pool.
{
  let clock=700000;
  const cfg={...config,targetCount:2,screenBlockedCooldownSeconds:1800};
  const storage={read:()=>({config:{enabled:true,targetCount:2},connections:[{session:'a',name:'line a'},{session:'b',name:'line b'}]}),load:()=>null,save:()=>{},status:()=>{}};
  const nativeFetch=async(u,init={})=>{
    if(u===cfg.sources[0])return new Response('8.8.8.8:3128\n1.1.1.1:8080');
    if(u===cfg.ipCheckUrl)return Response.json({ip:init.dispatcher?(init.dispatcher.url==='http://8.8.8.8:3128'?'9.9.9.9':'149.112.112.112'):'4.2.2.2'});
    if(u===cfg.targetCheckUrl)return Response.json({data:[]});
    return new Response('data: ok\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const screened=[];
  const screen=async u=>{screened.push(u);return u==='http://8.8.8.8:3128'?{ok:false,status:403}:{ok:true,status:200};};
  const pool=createTransportPool({nativeFetch,makeAgent:u=>({url:u,destroy(){return Promise.resolve()}}),storage,config:cfg,logger:quiet,now:()=>clock,screenEgress:screen});
  await pool.refresh();
  const snap=pool.snapshot();
  assert.equal(snap.healthy,1,'only a proxy that passed real inference enters the assignable pool');
  assert.equal(screened.length,2,'both connectivity-passing candidates are screened');
  const r=await pool.fetch(url,options('a'));
  assert.equal(r.status,200);
  assert.equal(r.headers.get('x-9router-opencode-cooldown'),null);
  await r.text();
  // The blocked egress must not be retried before its quarantine expires.
  const before=screened.length;clock+=60000;await pool.refresh();
  assert.equal(screened.length,before,'a 403-blocked egress is quarantined, not re-screened every round');
}
// A throttled or broken screening identity must never condemn otherwise-usable egresses.
{
  let clock=900000;
  const cfg={...config,targetCount:1,allowProxySharing:true};
  const storage={read:()=>({config:{enabled:true,targetCount:1},connections:[{session:'a',name:'line a'}]}),load:()=>null,save:()=>{},status:()=>{}};
  const nativeFetch=async(u,init={})=>{
    if(u===cfg.sources[0])return new Response('8.8.8.8:3128');
    if(u===cfg.ipCheckUrl)return Response.json({ip:init.dispatcher?'9.9.9.9':'4.2.2.2'});
    if(u===cfg.targetCheckUrl)return Response.json({data:[]});
    return new Response('data: ok\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const pool=createTransportPool({nativeFetch,makeAgent:u=>({url:u,destroy(){return Promise.resolve()}}),storage,config:cfg,logger:quiet,now:()=>clock,screenEgress:async()=>({ok:false,status:429,retryAfter:900})});
  await pool.refresh();
  assert.equal(pool.snapshot().healthy,0,'a throttled screen defers the egress instead of condemning it');
  clock+=121000;await pool.refresh();
  assert.equal(pool.snapshot().healthy,1,'the egress becomes assignable after the short deferral');
}
// A shared egress survives isolated gateway blips; only repeated failures cool it.
{
  let clock=950000;
  const cfg={...config,targetCount:1,allowProxySharing:true,egressFailureThreshold:3};
  const storage={read:()=>({config:{enabled:true,targetCount:1},connections:[{session:'a',name:'line a'}]}),load:()=>null,save:()=>{},status:()=>{}};
  const nativeFetch=async(u,init={})=>{
    if(u===cfg.sources[0])return new Response('8.8.8.8:3128');
    if(u===cfg.ipCheckUrl)return Response.json({ip:init.dispatcher?'9.9.9.9':'4.2.2.2'});
    if(u===cfg.targetCheckUrl)return Response.json({data:[]});
    return Response.json({error:{message:'bad gateway'}},{status:502});
  };
  const pool=createTransportPool({nativeFetch,makeAgent:u=>({url:u,destroy(){return Promise.resolve()}}),storage,config:cfg,logger:quiet,now:()=>clock});
  await pool.refresh();
  assert.equal(pool.snapshot().healthy,1);
  await (await pool.fetch(url,options('a'))).text();
  assert.equal(pool.snapshot().healthy,1,'one isolated 502 must not quarantine a shared egress');
  await (await pool.fetch(url,options('a'))).text();
  await (await pool.fetch(url,options('a'))).text();
  assert.equal(pool.snapshot().healthy,0,'repeated 502s eventually cool the egress');
}
// A scarce pool may share one validated egress across lines, but each line still serializes its own requests.
{
  let clock=800000;
  const cfg={...config,allowProxySharing:true,targetCount:1};
  const storage={read:()=>({config:{enabled:true,targetCount:1},connections:[{session:'a',name:'line a'},{session:'b',name:'line b'}]}),load:()=>null,save:()=>{},status:()=>{}};
  const nativeFetch=async(u,init={})=>{
    if(u===cfg.sources[0])return new Response('8.8.8.8:3128');
    if(u===cfg.ipCheckUrl)return Response.json({ip:init.dispatcher?'9.9.9.9':'4.2.2.2'});
    if(u===cfg.targetCheckUrl)return Response.json({data:[]});
    return new Response('data: OK\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const pool=createTransportPool({nativeFetch,makeAgent:u=>({url:u,destroy(){return Promise.resolve()}}),storage,config:cfg,logger:quiet,now:()=>clock});
  await pool.refresh();
  assert.equal(pool.snapshot().healthy,1);
  const a=await pool.fetch(url,options('a'));assert.equal(a.status,200);await a.text();
  const b=await pool.fetch(url,options('b'));assert.equal(b.status,200,'a scarce pool shares its validated egress across lines');await b.text();
  const a1=await pool.fetch(url,options('a'));assert.equal(a1.status,200);
  assert.equal((await pool.fetch(url,options('a'))).status,503,'a single line still serializes its own requests');
  await a1.text();
}
await updateConfig(async(u,i)=>{payload.push({u,i});return Response.json({opencodePublicProxy:{enabled:true}})},{enabled:true,targetCount:15});
assert.deepEqual(JSON.parse(payload[0].i.body),{opencodePublicProxy:{enabled:true,targetCount:15}});
await assert.rejects(updateConfig(async()=>Response.json({error:'Unauthorized'},{status:401}),{enabled:true}),/Unauthorized/);
console.log('PASS: disabled zero probing; proxy parsing/private IP rejection; live egress dedup; separate line dispatch; stream occupancy; quota cooldown; strict no-direct behavior; key isolation; authenticated toggle payload; stalled maintenance rounds are detected and abandoned without freezing the pool; egresses that fail real inference screening are quarantined instead of being assigned; a throttled screen defers instead of condemning; isolated gateway blips survive a shared egress; scarce pools share one validated egress while serializing each line.');
})().catch(e=>{console.error(e);process.exitCode=1});
