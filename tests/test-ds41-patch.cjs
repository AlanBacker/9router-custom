const assert = require('node:assert/strict');
const vm = require('node:vm');
const { transform } = require('../patches/fix-9router-ds41-low.cjs');
const source = `function applyFormat(fmt, body, cfg, caps, supportedLevels, display) {
 const eff = cfg;
 switch(fmt) {
 case "deepseek": {
   body.thinking = {type:"enabled"};
   const level = eff.level;
   const want = level === "xhigh" || level === "max" ? "max" : "high";
   body.reasoning_effort = want === "max" && supportedLevels && !supportedLevels.includes("max") ? "high" : want;
   break;
 }
 case "zai": body.reasoning_effort = cfg.level; break;
 }
 return body;
}`;
const minified = 'function a(e,t,r,n,i,o){switch(e){case"deepseek":t.thinking={type:"enabled"};let c=r.level,s="xhigh"===c||"max"===c?"max":"high";t.reasoning_effort="max"===s&&i&&!i.includes("max")?"high":s;break;case"zai":t.reasoning_effort=r.level}return t}';
for (const code of [source, minified]) {
 const result = transform(code);
 assert.equal(result.count, 1);
 const fn = vm.runInNewContext('(' + result.code + ')');
 for (const model of ['deepseek-v4.1-flash-free','oc/deepseek-v4.1-flash-free(low)','opencode/deepseek-v4.1-flash-free']) {
   for (const [level, expected] of [['low','low'],['medium','high'],['high','high'],['xhigh','max'],['max','max']]) {
     assert.equal(fn('deepseek',{model},{level},null,['low','high','max']).reasoning_effort, expected);
   }
 }
 for (const model of ['deepseek-v4-flash','deepseek-v4.1-flash','deepseek-v3.2','deepseek-v4.1-flash-free(low)(low)']) {
   assert.equal(fn('deepseek',{model},{level:'low'},null,['high','max']).reasoning_effort,'high');
 }
 assert.equal(fn('zai',{model:'glm-5.3-flash-free'},{level:'low'},null,null).reasoning_effort,'low');
 assert.equal(transform(result.code).count,0);
}
assert.equal(transform('function f() { return 1; }').count,0);
assert.throws(() => transform('case "deepseek": const want = level === "xhigh" || level === "max" ? "max" : "high"; body.reasoning_effort = want;'));
// Repeated container starts must not overwrite the existing original backups.
const fs = require('node:fs');
const moduleMock = {exports:{}};
let logs = [];
const requireMock = name => name === 'node:fs' ? {
  existsSync: () => true,
  readFileSync: file => file.endsWith('manifest.json')
    ? JSON.stringify({files:[{file:'/app/.next/server/chunks/example.js'}]})
    : '/*9R_DS41_LOW_V1*/',
  writeFileSync: () => {throw new Error('Must not write on repeated startup');},
} : require(name);
requireMock.main = moduleMock;
vm.runInNewContext(fs.readFileSync(require.resolve('../patches/fix-9router-ds41-low.cjs'),'utf8'), {
  require: requireMock, module: moduleMock, process:{argv:[]}, __filename:'/opt/9router-hotfix/fix.cjs',
  console:{log: s => logs.push(s),error: s => {throw new Error(s);}},
});
assert.ok(logs.some(s => s.includes('PATCH ALREADY APPLIED')));
console.log('PASS: source/minified forms; low/high/max; target model scope; unchanged GLM/other DeepSeek; idempotence; unknown-layout guard.');
