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
  console.log('PASS: Bun relay wiring, per-request egress, untouched caller tools, official probe template.');
})().catch(e=>{console.error(e);process.exitCode=1});
