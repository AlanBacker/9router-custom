'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {publicIPv4,normalizeProxy,parseCandidates,mergeCandidates,createPool,getProxyAgent}=require('../server/opencode-public-proxy.cjs');
const {updateConfig}=require('../browser/opencode-public-proxy-ui.js');
const quiet={info(){},warn(){}};
const config={sources:['https://lists.example/proxies'],ipCheckUrl:'https://ip.example',targetCheckUrl:'https://opencode.ai/inference/v1/models',healthMaxAgeSeconds:900,sourceRefreshSeconds:600,probeTimeoutMs:500,maxCandidates:100,maxSourceBytes:10000,maxCandidatesPerRound:10,probeConcurrency:2,replenishIntervalSeconds:1};
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
const payload=[];
await updateConfig(async(u,i)=>{payload.push({u,i});return Response.json({opencodePublicProxy:{enabled:true}})},{enabled:true,targetCount:15});
assert.deepEqual(JSON.parse(payload[0].i.body),{opencodePublicProxy:{enabled:true,targetCount:15}});
await assert.rejects(updateConfig(async()=>Response.json({error:'Unauthorized'},{status:401}),{enabled:true}),/Unauthorized/);
console.log('PASS: disabled zero probing; proxy parsing/private IP rejection; live egress dedup; separate line dispatch; stream occupancy; quota cooldown; strict no-direct behavior; key isolation; authenticated toggle payload.');
})().catch(e=>{console.error(e);process.exitCode=1});
