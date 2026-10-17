'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const constants=fs.readFileSync('open-sse/config/opencodeCustom.js','utf8').replaceAll('export const ','const ');
const service=fs.readFileSync('open-sse/services/opencodeCustom.js','utf8').replace(/^import .*;\s*$/gm,'').replace('export function ','function ');
const guard=vm.runInNewContext(constants+'\n'+service+'\n;shouldStopOpenCodeFallback',{HTTP_STATUS:{RATE_LIMITED:429,SERVICE_UNAVAILABLE:503}});
for(const result of [{status:429,error:'Endpoint is unavailable'},{status:403,error:'[OpenCodeAutoRecovery] rejected'},{status:503,error:'OpenCodePublicProxyUnavailable'}]){assert.equal(guard('opencode',result),true);assert.equal(guard('other',result),false);}
assert.equal(guard('opencode',{status:429,error:'ordinary real-account error'}),false);
assert(fs.readFileSync('src/app/layout.js','utf8').includes('<OpenCodeCustomizations />'));
assert(fs.readFileSync('custom-server.js','utf8').includes('custom/server/preload.cjs'));
assert(fs.readFileSync('Dockerfile','utf8').includes('RUN node custom/scripts/apply-source.cjs --check'));
execFileSync(process.execPath,['custom/scripts/apply-source.cjs','--check'],{stdio:'inherit'});
console.log('PASS: actual native source guards, browser integration, startup integration and idempotent source validation.');
