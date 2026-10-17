'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const modules=['thinking-compat.cjs','opencode-anonymous.cjs','opencode-public-proxy.cjs','opencode-recovery-rules.cjs'];
for(const module of modules)require('/opt/9router-hotfix/'+module);
for(const [dir,markers,version]of [
 ['.ds41-low-fix',['9R_DS41_LOW_V1']],
 ['.opencode-pool-fix',['9R_OC_POOL_V1']],
 ['.opencode-anonymous-fix',['9R_OC_ANONYMOUS_V1','9R_OC_ANONYMOUS_FALLBACK_V4'],5]
]){
 const m=JSON.parse(fs.readFileSync('/app/'+dir+'/manifest.json'));
 assert(m.files?.length,dir+' missing patch records');if(version)assert.equal(m.version,version);
 for(const f of m.files)assert(markers.some(mark=>fs.readFileSync(f.file,'utf8').includes(mark)),f.file+' lost patch marker');
}
const m=JSON.parse(fs.readFileSync('/app/.opencode-pool-fix/manifest.json'));
const asset=m.files.find(f=>f.file.startsWith('/app/.next/static/'));assert(asset,'Compiled dashboard missing');
const code=fs.readFileSync(asset.file,'utf8');for(const text of ['autoRecover429','auth-cooldown','data-maintenance'])assert(code.includes(text),'Missing dashboard field '+text);
assert.equal(typeof require('/opt/9router-hotfix/opencode-public-proxy.cjs').getProxyAgent(),'function');
console.log('Verified: source and compiled patches; recovery UI; runtime modules.');
