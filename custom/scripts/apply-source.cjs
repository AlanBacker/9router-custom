'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const {transform:thinking}=require('../source/deepseek.cjs');
const {transformRegistry}=require('../source/registry.cjs');
const {transform:anonymous}=require('../source/anonymous.cjs');
const check=process.argv.includes('--check');let changed=0;
function update(name,fn){const file=path.join(root,name),before=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),after=fn(before);if(after!==before){if(check)throw Error('Source customization missing: '+name);fs.writeFileSync(file,after);changed++;}}
function create(name,contents){const file=path.join(root,name);if(fs.existsSync(file))return;if(check)throw Error('Missing custom source '+name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,contents);changed++;}
create('open-sse/config/opencodeCustom.js',`// Source customization constants. Kept out of provider-independent code.\nexport const CUSTOM_ANONYMOUS_HOOK = "9router.opencodeAnonymous.v1";\nexport const CUSTOM_EXPLICIT_LOW_MODEL = /(?:^|\\/)deepseek-v4\\.1-flash-free(?:\\([^()]*\\))?$/;\nexport const CUSTOM_OPENCODE_PROVIDER = "opencode";\nexport const CUSTOM_HANDLED_ERROR = "[OpenCodeAutoRecovery]";\nexport const CUSTOM_ENDPOINT_UNAVAILABLE = /\\bendpoint is unavailable\\b/i;\nexport const CUSTOM_PROXY_UNAVAILABLE = /OpenCodePublicProxyUnavailable|自动公共代理|匿名线路正在处理/;\n`);
create('open-sse/services/opencodeCustom.js',`import { CUSTOM_OPENCODE_PROVIDER, CUSTOM_HANDLED_ERROR, CUSTOM_ENDPOINT_UNAVAILABLE, CUSTOM_PROXY_UNAVAILABLE } from "../config/opencodeCustom.js";\nimport { HTTP_STATUS } from "../config/runtimeConfig.js";\nexport function shouldStopOpenCodeFallback(provider, result) {\n  if (provider !== CUSTOM_OPENCODE_PROVIDER) return false;\n  const message = String(result.error || "");\n  return message.includes(CUSTOM_HANDLED_ERROR) ||\n    (result.status === HTTP_STATUS.RATE_LIMITED && CUSTOM_ENDPOINT_UNAVAILABLE.test(message)) ||\n    (result.status === HTTP_STATUS.SERVICE_UNAVAILABLE && CUSTOM_PROXY_UNAVAILABLE.test(message));\n}\n`);
create('src/shared/components/OpenCodeCustomizations.jsx',`"use client";\nimport { useEffect } from "react";\nimport pool from "../../../custom/browser/opencode-pool-ui.js";\nimport proxy from "../../../custom/browser/opencode-public-proxy-ui.js";\nexport default function OpenCodeCustomizations() {\n  useEffect(() => { pool.install(window); proxy.install(window); }, []);\n  return null;\n}\n`);
update('open-sse/translator/concerns/thinkingUnified.js',code=>{
 if(code.includes('9R_DS41_LOW_V1'))return code;
 const result=thinking(code);assert.equal(result.count,1,'Thinking source layout changed');
 const modelCheck='/(?:^|\\/)deepseek-v4\\.1-flash-free(?:\\([^()]*\\))?$/.test(String(body.model||""))';
 assert(result.code.includes(modelCheck),'Thinking model guard changed');
 return 'import { CUSTOM_EXPLICIT_LOW_MODEL } from "../../config/opencodeCustom.js";\n'+result.code.replace(modelCheck,'CUSTOM_EXPLICIT_LOW_MODEL.test(String(body.model||""))');
});
update('open-sse/providers/registry/opencode.js',code=>{if(code.includes('9R_OC_POOL_V1'))return code;const r=transformRegistry(code);assert.equal(r.count,1,'Provider source layout changed');return r.code;});
update('open-sse/executors/opencode.js',code=>{if(code.includes('9R_OC_ANONYMOUS_V1'))return code;const r=anonymous(code);assert.equal(r.count,1,'Executor source layout changed');return 'import { CUSTOM_ANONYMOUS_HOOK } from "../config/opencodeCustom.js";\n'+r.code.replaceAll("Symbol.for('9router.opencodeAnonymous.v1')",'Symbol.for(CUSTOM_ANONYMOUS_HOOK)');});
update('src/sse/handlers/chat.js',code=>{
 if(code.includes('shouldStopOpenCodeFallback(provider, result)'))return code;
 const needle='if (result.success) return result.response;';assert.equal(code.split(needle).length,2,'Chat source layout changed');
 return 'import { shouldStopOpenCodeFallback } from "open-sse/services/opencodeCustom.js";\n'+code.replace(needle,'if (shouldStopOpenCodeFallback(provider, result)) return result.response;\n    '+needle);
});
update('src/app/layout.js',code=>{if(code.includes('<OpenCodeCustomizations />'))return code;assert(code.includes('<GoogleAnalytics '),'Layout source changed');return 'import OpenCodeCustomizations from "@/shared/components/OpenCodeCustomizations";\n'+code.replace('<GoogleAnalytics ','<OpenCodeCustomizations />\n        <GoogleAnalytics ');});
update('custom-server.js',code=>code.includes('custom/server/preload.cjs')?code:'require("./custom/scripts/verify-build.cjs").verifyIfBuilt();\nrequire("./custom/server/preload.cjs");\n'+code);
update('package.json',code=>{const p=JSON.parse(code);p.scripts['custom:apply']='node custom/scripts/apply-source.cjs';p.scripts['test:custom']='node custom/scripts/test.cjs';return JSON.stringify(p,null,2)+'\n';});
update('Dockerfile',code=>{
 if(code.includes('# CUSTOM_SOURCE_BUILD'))return code;
 assert.equal(code.split('RUN npm run build').length,2,'Docker build layout changed');
 assert(code.includes('COPY --from=builder /app/open-sse ./open-sse'),'Docker source copy changed');
 return code.replace('RUN npm run build',`# CUSTOM_SOURCE_BUILD: compile customized source; never rewrite .next bundles.\nRUN node custom/scripts/apply-source.cjs --check \\\n && npm ci --prefix /app/custom/server/runtime --ignore-scripts --omit=dev \\\n && npm run build \\\n && node custom/scripts/verify-build.cjs --write`)
 .replace('COPY --from=builder /app/open-sse ./open-sse',`COPY --from=builder /app/open-sse ./open-sse\nCOPY --from=builder /app/custom ./custom\nCOPY --from=builder /app/LICENSE ./LICENSE\nCOPY --from=builder /app/src/sse/handlers/chat.js ./src/sse/handlers/chat.js`);
});
update('Dockerfile',code=>code.includes('https://github.com/AlanBacker/9router-custom')?code:code.replace('ENV NODE_ENV=production','ARG CUSTOM_REVISION=local\nLABEL org.opencontainers.image.source="https://github.com/AlanBacker/9router-custom" \\\n      org.opencontainers.image.revision="${CUSTOM_REVISION}"\nENV NODE_ENV=production'));
update('.gitignore',code=>code.includes('# Custom source development')?code:code+'\n# Custom source development\n**/node_modules/\n.cache/\ncustom/build-manifest.json\n!custom/server/runtime/package-lock.json\n');
update('README.md',code=>code.startsWith('> **9Router Custom**')?code:'> **9Router Custom** — 完整源码定制仓库。自动合并官方源码并重新应用定制；[定制功能与同步方式](custom/README.md)。\n\n'+code);
const workflow=path.join(root,'.github/workflows');
for(const file of fs.readdirSync(workflow))if(/\.ya?ml$/.test(file)&&file!=='custom-source-sync.yml'){
 const dest=path.join(root,'.github/upstream-workflows',file+'.disabled');
 if(check)throw Error('Unconfigured upstream workflow remains enabled: '+file);
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(path.join(workflow,file),dest);changed++;
}
console.log('Source customizations '+(check?'verified':'applied')+': '+changed+' changed files. No compiled bundle edits.');
