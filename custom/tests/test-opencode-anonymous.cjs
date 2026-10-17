'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {createSessionStore,createAnonymousFetch}=require('../server/opencode-anonymous.cjs');
const {transform,transformHandler}=require('../source/anonymous.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'9router-anonymous-'));
const quiet={info(){},warn(){}};
const config={hosts:['opencode.ai'],paths:['/inference/v1/chat/completions'],endpointCooldownSeconds:5,defaultSessionCooldownSeconds:2,maxCooldownSeconds:86400,maxCooldowns:512};
const url='https://opencode.ai/inference/v1/chat/completions';
const options=(session='a',model='glm-5.3-flash-free',authorization='Bearer public')=>({method:'POST',headers:{authorization,'x-opencode-session':session},body:JSON.stringify({model,messages:[{role:'user',content:'hi'}]})});
(async()=>{
try {
const file=path.join(dir,'sessions.json'),store=createSessionStore(file);
const creds=id=>({connectionId:id,providerSpecificData:{opencodePoolManaged:true}});
const a=store.getManagedSession(creds('a')),b=store.getManagedSession(creds('b'));
assert.match(a,/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);assert.notEqual(a,b);
assert.equal(createSessionStore(file).getManagedSession(creds('a')),a);
assert.equal(store.getManagedSession({connectionId:'unmanaged'}),undefined);
assert.throws(()=>createSessionStore(file,1).getManagedSession(creds('a')),/Invalid anonymous/);
const bad=path.join(dir,'bad.json');fs.writeFileSync(bad,'{"version":1,"sessions":{"a":"invalid"}}');
const broken=createSessionStore(bad);for(let i=0;i<2;i++)assert.throws(()=>broken.getManagedSession(creds('a')),/Invalid anonymous/);

// Exercise the actual provider class: a shared client session previously wins over connection identity.
const source=fs.readFileSync('open-sse/executors/opencode.js','utf8');
const original=source.replace(/\/\*9R_OC_ANONYMOUS_V1\*\/const __ocSession=[^;]+;if\(__ocSession\)return\{[^}]+\};/,'');assert.notEqual(source,original);
function loadClass(code,hook){
 const clean=code.replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport\s+/g,'');
 const sandbox={crypto,console,CUSTOM_ANONYMOUS_HOOK:"9router.opencodeAnonymous.v1",MEMORY_CONFIG:{sessionTtlMs:3600000,sessionCleanupIntervalMs:60000},PROVIDERS:{opencode:{}},BaseExecutor:class{constructor(provider,config){this.provider=provider;this.config=config}},setInterval:()=>({unref(){}}),resolveSessionId:()=> 'same-client-session'};
 if(hook)sandbox[Symbol.for('9router.opencodeAnonymous.v1')]=hook;
 return vm.runInNewContext(clean+'\n;OpenCodeExecutor',sandbox);
}
const args=id=>({body:{messages:[]},credentials:creds(id),providerSessionId:'same-client-session'});
const Before=loadClass(original),before=new Before();
assert.equal(before.prepareRequestCredentials(args('a'))._opencodeSession,before.prepareRequestCredentials(args('b'))._opencodeSession);
const patched=transform(original);assert.equal(patched.count,1);
const After=loadClass(source,store),after=new After();
assert.equal(after.prepareRequestCredentials(args('a'))._opencodeSession,a);
assert.equal(after.prepareRequestCredentials(args('b'))._opencodeSession,b);
assert.notEqual(a,b);
const min='class G extends Base{constructor(){super("opencode",PROVIDERS.opencode)}prepareRequestCredentials({body:a,credentials:b,providerSessionId:c,clientTool:d}={}){return b}}';
assert.equal(transform(min).count,1);new vm.Script(transform(min).code);
assert.equal(transform(min.replace('"opencode"','"other-provider"')).count,0);
const handler=transformHandler('function handle(provider,result){if (result.success) return result.response;return "fallback";}');
assert.equal(handler.count,1);
const handle=vm.runInNewContext(handler.code+';handle');
const result={status:429,error:'[429]: Endpoint is unavailable.',response:'original-response'};
assert.equal(handle('opencode',result),'original-response');
assert.equal(handle('other',result),'fallback');
assert.equal(handle('opencode',{...result,status:500}),'fallback');
assert.equal(handle('opencode',{...result,error:'FreeUsageLimitError'}),'fallback');
assert.equal(handle('opencode',{...result,status:503,error:'OpenCodePublicProxyUnavailable'}),'original-response');
assert.equal(handle('other',{...result,status:503,error:'OpenCodePublicProxyUnavailable'}),'fallback');
assert.equal(handle('opencode',{...result,status:503,error:'Unrelated backend error'}),'fallback');
const oldHandler='/*9R_OC_ANONYMOUS_FALLBACK_V1*/if(z==="opencode"&&x.status===429&&/\\bendpoint is unavailable\\b/i.test(String(x.error||"")))return x.response;';
assert.equal(transformHandler(oldHandler).count,1);
const compiled='if(x.success)return x.response;let y=null,B=x.resetsAtMs;if("antigravity"===z&&(409===x.status||429===x.status)){}';
assert.equal(transformHandler(compiled).count,1);

let clock=10000,calls=0;
const endpoint=createAnonymousFetch(async()=>{calls++;return new Response(JSON.stringify({error:{message:'Upstream request failed: Endpoint is unavailable.'}}),{status:429,headers:{'content-type':'application/json'}})},config,quiet,()=>clock);
assert.equal((await endpoint(url,options('a'))).status,429);
assert.equal((await endpoint(url,options('b'))).headers.get('x-9router-opencode-cooldown'),'endpoint-unavailable');assert.equal(calls,1);
await endpoint(url,options('b','other-model'));assert.equal(calls,2);
clock+=5001;await endpoint(url,options('b'));assert.equal(calls,3);

calls=0;clock=10000;
const limited=createAnonymousFetch(async()=>{calls++;return new Response(JSON.stringify({error:{type:'FreeUsageLimitError',message:'limit'}}),{status:429,headers:{'content-type':'application/json','retry-after':'30'}})},config,quiet,()=>clock);
await limited(url,options('a'));await limited(url,options('a'));assert.equal(calls,1);
await limited(url,options('b'));assert.equal(calls,2);
clock+=10000;assert.equal((await limited(url,options('a'))).headers.get('retry-after'),'20');assert.equal(calls,2);
clock+=20001;await limited(url,options('a'));assert.equal(calls,3);
assert.equal(store.getManagedSession(creds('a')),a);

calls=0;const success=new Response('data: chunk\n\n',{headers:{'content-type':'text/event-stream'}});
const unchanged=createAnonymousFetch(async()=>{calls++;return success},config,quiet);
assert.equal(await unchanged(url,options()),success);assert.equal(success.bodyUsed,false);
await unchanged(url,options('a','model','Bearer real-key'));assert.equal(calls,2);
await unchanged('https://other.example/inference/v1/chat/completions',options());assert.equal(calls,3);
let usedUrl;
const modern='/inference/openai/v1/chat/completions';
const rerouted=createAnonymousFetch(async(u)=>{usedUrl=u;return new Response('OK')},{...config,paths:[...config.paths,modern],routeOverrides:{'/inference/v1/chat/completions':modern}},quiet);
await rerouted(url,options());assert.equal(usedUrl,'https://opencode.ai'+modern);
const abort=new AbortController();abort.abort();await assert.rejects(unchanged(url,{...options(),signal:abort.signal}),{name:'AbortError'});assert.equal(calls,3);
assert.equal(store.renewInvalidSession(a,'rate_limit'),null);
const renewed=store.renewInvalidSession(a,'invalid_session');assert.match(renewed,/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);assert.notEqual(renewed,a);
assert.equal(store.getManagedSession(creds('b')),b,'unaffected sessions retained');
assert.equal(store.renewInvalidSession(a,'invalid_session'),null,'stale identity cannot renew again');
const reloaded=createSessionStore(file);assert.equal(reloaded.getManagedSession(creds('a')),renewed);assert.equal(reloaded.renewInvalidSession(renewed,'invalid_session'),null,'five-minute guard survives process restart');assert.equal(Object.keys(JSON.parse(fs.readFileSync(file)).sessions).length,2);
let invalidCalls=0;const invalidFetch=createAnonymousFetch(async()=>{invalidCalls++;return Response.json({error:{code:'invalid_session'}},{status:429})},config,quiet);await invalidFetch(url,options('invalid'));await invalidFetch(url,options('replacement'));assert.equal(invalidCalls,2,'session-invalid responses do not poison quota cache');
const hookContext={};hookContext[Symbol.for('9router.opencodePublicProxy.v1')]={shouldStop429Fallback:()=>true};
const bounded=vm.runInNewContext(handler.code+';handle',hookContext);for(const status of [401,403,429,502,503,504]){assert.equal(bounded('opencode',{...result,status,error:'[OpenCodeAutoRecovery] exhausted'}),'original-response');assert.equal(bounded('other',{...result,status,error:'[OpenCodeAutoRecovery] exhausted'}),'fallback');}assert.equal(bounded('opencode',{...result,error:'FreeUsageLimitError'}),'fallback','real-key errors without the handled marker keep normal account fallback');
for(const version of [2,3]){const old=handler.code.replaceAll('9R_OC_ANONYMOUS_FALLBACK_V4','9R_OC_ANONYMOUS_FALLBACK_V'+version);const migrated=transformHandler(old);assert.equal(migrated.count,1);new vm.Script(migrated.code);assert.equal(transformHandler(migrated.code).count,0);}
console.log('PASS: persistent isolated sessions; actual shared-client regression; endpoint and session cooldown scopes; expiry; pass-through and abort.');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
