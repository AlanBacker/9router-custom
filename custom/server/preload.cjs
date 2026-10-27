'use strict';
const path=require('node:path'),os=require('node:os');
process.env.NINEROUTER_APP_ROOT=path.resolve(__dirname,'../..');
process.env.DATA_DIR=process.env.DATA_DIR||path.join(os.homedir(),'.9router');
process.env.NINEROUTER_THINKING_COMPAT='1';
process.env.NINEROUTER_OPENCODE_ANONYMOUS='1';
process.env.NINEROUTER_OPENCODE_PUBLIC_PROXY='1';
require('./thinking-compat.cjs');
// Upstream free-tier inference is gated on the Bun TLS fingerprint; start the
// co-located Bun relay before the fetch wrappers so it can be used as soon as
// the port is up (asynchronous, fail-open when Bun is absent).
require('./opencode-bun-relay.cjs').startBunRelay();
require('./opencode-anonymous.cjs');
// Explicit: verify-build.cjs imports the proxy module before this file runs, so the
// module's own load-time hook already saw an unset environment.
require('./opencode-public-proxy.cjs').installPublicProxy();
// Outermost marker: if a later fetch patch replaces the chain, this line simply
// stops appearing while [OpenCodeAnonymous] keeps logging — that is the signal
// that something bypassed the pool. Never alters the request.
const layer=globalThis.fetch;
const traced=async function opencodeTraceFetch(input,init){
  try{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.hostname==='opencode.ai'&&url.pathname.startsWith('/inference/')&&String(init?.method).toUpperCase()==='POST'){
      const relay=globalThis[Symbol.for('9router.opencodeRelay.v1')];
      console.info(`[OpenCodeFetch] ${url.pathname} next=${layer.__9rLayer||layer.name||'anonymous'} relay=${relay?.ready?relay.url:'down'}`);
    }
  }catch{}
  return layer(input,init);
};
traced.__9rLayer='preload-trace';
globalThis.fetch=traced;
