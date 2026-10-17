const assert = require('node:assert/strict');
const vm = require('node:vm');
const { transform } = require('../source/deepseek.cjs');
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

const fs=require('node:fs');const actual=fs.readFileSync('open-sse/translator/concerns/thinkingUnified.js','utf8');const start=actual.indexOf('function applyFormat('),end=actual.indexOf('export function applyThinking(');const native=vm.runInNewContext(actual.slice(start,end)+';applyFormat',{toLevel:c=>c.level,CUSTOM_EXPLICIT_LOW_MODEL:/(?:^|\/)deepseek-v4\.1-flash-free(?:\([^()]*\))?$/});const body={model:'deepseek-v4.1-flash-free'};native('deepseek',body,{mode:'level',level:'low'},{},['low','high','max']);assert.equal(body.reasoning_effort,'low');console.log('PASS: native thinking source and bounded compatibility transforms.');
