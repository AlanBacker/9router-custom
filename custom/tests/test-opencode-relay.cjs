'use strict';
// The upstream free tier rejects non-Bun TLS fingerprints and non-official request
// templates with 429 FreeUsageLimitError. These are static guards over the wiring that
// makes the Node app send inference through the co-located Bun relay untouched.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(p,'utf8');
const root=path.resolve(__dirname,'../..');

const preload=read(path.join(root,'custom/server/preload.cjs'));
assert(preload.includes('opencode-bun-relay.cjs'),'preload starts the Bun relay');
assert(preload.indexOf('opencode-bun-relay.cjs')<preload.indexOf('opencode-public-proxy.cjs'),'relay starts before the fetch wrappers');

const dockerfile=read(path.join(root,'Dockerfile'));
assert(/FROM oven\/bun:1-alpine AS bunbin/.test(dockerfile),'Bun comes from a multi-arch image');
assert(/COPY --from=bunbin \/usr\/local\/bin\/bun \/usr\/local\/bin\/bun/.test(dockerfile),'Bun is copied into the runtime image');

const relay=read(path.join(root,'custom/server/opencode-bun-relay.ts'));
assert(relay.includes('x-9r-egress-proxy'),'relay accepts the per-request egress');
assert(relay.includes('init.proxy = proxy'),'relay hands the egress to Bun fetch');
assert(relay.includes('startsWith("/inference/")'),'relay only forwards inference paths');
assert(relay.includes('/__9r/ping')&&relay.includes('x-9r-relay-token'),'relay answers an authenticated readiness ping');
assert(relay.includes('setDefaultResultOrder')&&relay.includes('DNS_ORDER'),'relay forces IPv4-first DNS (upstream rejects the IPv6 path)');

const manager=read(path.join(root,'custom/server/opencode-bun-relay.cjs'));
assert(manager.includes('OPENCODE_RELAY_TOKEN'),'relay manager hands a per-process token to Bun');
assert(manager.includes('scheduleRestart'),'relay is respawned with backoff when it dies');
assert(manager.includes('--dns-result-order=${dnsOrder()}'),'Bun is spawned IPv4-first (upstream 429s over IPv6)');

const proxy=read(path.join(root,'custom/server/opencode-public-proxy.cjs'));
assert(proxy.includes("Symbol.for('9router.opencodeRelay.v1')"),'pool reads the relay handle');
assert(proxy.includes('relayTarget(input)'),'business traffic is re-issued to the relay');
assert(proxy.includes('relayHeaders(headers,entry.url)'),'business traffic carries the selected egress');
assert(proxy.includes('relayTarget(request.url)'),'egress screening also uses the relay');
assert(proxy.includes('relayHeaders(request.init.headers,url)'),'egress screening keeps the screened proxy');

const executor=read(path.join(root,'open-sse/executors/opencode.js'));
assert(!/applyFingerprintTools\(body,\s*false\)/.test(executor),'chat lane must not rewrite the caller tool set');
assert(/applyFingerprintTools\(body,\s*true\)/.test(executor),'responses lane keeps its legacy fingerprint');

const prompt=JSON.parse(read(path.join(root,'custom/server/opencode-native-prompt.json'))).title;
assert.match(prompt,/^You are a title generator\./,'captured title prompt is present');
assert(prompt.length>1500,'captured title prompt is complete');

(async()=>{
  const {buildProbe}=require('../server/opencode-inference-probe.cjs');
  const probe=await buildProbe('deepseek-v4.1-flash-free','ses_0123456789abABCDEFGHIJKLMN',{inferenceMaxTokens:64});
  const body=JSON.parse(probe.init.body);
  assert.equal(body.messages[0].role,'system','probe sends a system prompt');
  assert.equal(body.messages[0].content,prompt,'probe uses the official title prompt verbatim');
  assert.equal(body.tools,undefined,'probe must not send tools');
  assert.equal(body.stream_options.include_usage,true,'probe asks for usage so completion is observable');
  assert.equal(probe.init.headers['user-agent'],'opencode/latest/2.0.26/cli');
  assert.equal(probe.init.headers['x-opencode-client'],'cli');
  for(const name of ['x-opencode-session','x-opencode-session-id','x-session-id','x-session-affinity'])assert.equal(probe.init.headers[name],'ses_0123456789abABCDEFGHIJKLMN',`probe carries ${name} (upstream 429s without a session header)`);

  // verify-build.cjs requires the proxy module before preload sets the environment,
  // which leaves it cached with the install hook disabled. The pool must therefore be
  // installable explicitly, and preload must call it.
  const preloadSrc=read(path.join(root,'custom/server/preload.cjs'));
  assert(preloadSrc.includes('installPublicProxy()'),'preload installs the pool explicitly after the environment is set');
  const proxySrc=read(path.join(root,'custom/server/opencode-public-proxy.cjs'));
  assert(proxySrc.includes('function installPublicProxy()'),'the pool exposes an explicit installer');
  assert(require('../server/opencode-public-proxy.cjs').installPublicProxy()===null,'the installer is inert without the env flag');
  assert(read(path.join(root,'custom/scripts/verify-build.cjs')).includes("require('../server/opencode-public-proxy.cjs')"),'verify-build still imports the module first (the hazard this guards against)');

  // The Node transport is guaranteed to be answered with 429 by the free tier, so a
  // missing relay must pause the call (503) instead of burning one account lock per line.
  assert(proxy.includes('relayGuard(pool.fetch'),'the installed fetch is relay-guarded');
  const {relayGuard}=require('../server/opencode-public-proxy.cjs');
  const RELAY=Symbol.for('9router.opencodeRelay.v1');
  const free={url:'https://opencode.ai/inference/v1/chat/completions',init:{method:'POST',headers:{authorization:'Bearer public'},body:'{}'}};
  const quiet={warn(){},info(){}};
  let calls=0;const inner=async()=>{calls++;return new Response('ok',{status:200})};
  assert.equal(typeof relayGuard,'function',"relay guard is exported for the pool's installed fetch");

  delete globalThis[RELAY];
  let guarded=relayGuard(inner,{waitMs:0,logger:quiet,disabled:()=>false});
  let response=await guarded(free.url,free.init);
  assert.equal(response.status,503,'free-tier calls fail loudly when the relay is missing');
  assert.equal((await response.json()).error.type,'OpenCodeRelayUnavailable','the status names the missing relay');
  assert.equal(calls,0,'a missing relay never falls back to the Node TLS fingerprint');

  globalThis[RELAY]={ready:true,url:'http://127.0.0.1:20129',token:'t',error:null};
  guarded=relayGuard(inner,{waitMs:0,logger:quiet,disabled:()=>false});
  response=await guarded(free.url,free.init);
  assert.equal(response.status,200,'relay-ready calls pass through');
  assert.equal(calls,1,'the underlying fetch runs once');

  delete globalThis[RELAY];
  const passThrough=relayGuard(inner,{waitMs:0,logger:quiet,disabled:()=>true});
  assert.equal((await passThrough(free.url,free.init)).status,200,'an operator can still disable the relay explicitly');
  assert.equal(calls,2,'the explicitly disabled relay is not guarded');

  const other=relayGuard(inner,{waitMs:0,logger:quiet,disabled:()=>false});
  assert.equal((await other('https://api.example.com/v1/chat',free.init)).status,200,'unrelated hosts are untouched');
  assert.equal(calls,3,'unrelated hosts never wait for the relay');

  globalThis[RELAY]={ready:false,url:'',token:'t',error:null};
  setTimeout(()=>{globalThis[RELAY]={ready:true,url:'http://127.0.0.1:20129',token:'t',error:null};},150);
  const late=relayGuard(inner,{waitMs:2000,logger:quiet,disabled:()=>false});
  assert.equal((await late(free.url,free.init)).status,200,'a relay that starts a moment later is awaited');
  delete globalThis[RELAY];

  console.log('PASS: Bun relay wiring, per-request egress, untouched caller tools, official probe template.');
})().catch(e=>{console.error(e);process.exitCode=1});
