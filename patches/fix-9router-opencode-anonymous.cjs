'use strict';
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const MARK = '9R_OC_ANONYMOUS_V1';
const OLD_FALLBACK_MARK = '9R_OC_ANONYMOUS_FALLBACK_V1';
const FALLBACK_MARK = '9R_OC_ANONYMOUS_FALLBACK_V4';
function transform(code) {
  let count = 0;
  const isOpencodeMethod = offset => /constructor\(\)\s*\{\s*super\(["']opencode["'],\s*[^;{}]+?\);?\s*\}\s*$/.test(code.slice(Math.max(0, offset - 200), offset));
  code = code.replace(/prepareRequestCredentials\(\{body\s*:\s*(\w+),\s*credentials\s*:\s*(\w+),\s*providerSessionId\s*:\s*(\w+),\s*clientTool\s*:\s*(\w+)\}\s*=\s*\{\}\)\s*\{/g,
    (whole, body, credentials, session, tool, offset) => {
      if (!isOpencodeMethod(offset)) return whole;
      count++;
      return whole + `/*${MARK}*/const __ocSession=globalThis[Symbol.for('9router.opencodeAnonymous.v1')]?.getManagedSession(${credentials});if(__ocSession)return{...${credentials},_opencodeSession:__ocSession};`;
    });
  // Readable source uses shorthand destructuring.
  code = code.replace(/prepareRequestCredentials\(\{\s*body,\s*credentials,\s*providerSessionId,\s*clientTool\s*\}\s*=\s*\{\}\)\s*\{/g, (whole, offset) => {
    if (!isOpencodeMethod(offset)) return whole;
    count++;
    return whole + `/*${MARK}*/const __ocSession=globalThis[Symbol.for('9router.opencodeAnonymous.v1')]?.getManagedSession(credentials);if(__ocSession)return{...credentials,_opencodeSession:__ocSession};`;
  });
  return {code, count};
}
function transformHandler(code) {
  if (code.includes(FALLBACK_MARK)) return {code,count:0};
  let count=0;
  const stop=(provider,result)=>`/*${FALLBACK_MARK}*/if(${provider}==="opencode"&&(String(${result}.error||"").includes("[OpenCodeAutoRecovery]")||(${result}.status===429&&/\\bendpoint is unavailable\\b/i.test(String(${result}.error||"")))||(${result}.status===503&&/OpenCodePublicProxyUnavailable|自动公共代理|匿名线路正在处理/.test(String(${result}.error||"")))))return ${result}.response;`;
  if(/9R_OC_ANONYMOUS_FALLBACK_V[123]/.test(code)){
    code=code.replace(/\/\*9R_OC_ANONYMOUS_FALLBACK_V[123]\*\/if\((\w+)==="opencode"[\s\S]{0,1000}?return (\w+)\.response;/g,(whole,provider,result)=>{count++;return stop(provider,result)});
    return {code,count};
  }
  code=code.replace(/if \(result\.success\) return result\.response;/g,whole=>{
    count++;return stop('provider','result')+whole;
  });
  code=code.replace(/if\((\w+)\.success\)return\s+\1\.response;(?=let \w+=null,\w+=\1\.resetsAtMs;if\(["']antigravity["']===(\w+)&&)/g,(whole,result,provider)=>{
    count++;return stop(provider,result)+whole;
  });
  return {code,count};
}
function main() {
  const dry = process.argv.includes('--dry-run');
  const manifestPath = '/app/.opencode-anonymous-fix/manifest.json';
  let state={version:0,files:[]};
  if (fs.existsSync(manifestPath)) {
    state = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!state.files?.length || !state.files.every(f => {const code=fs.readFileSync(f.file,'utf8');return code.includes(MARK)||/9R_OC_ANONYMOUS_FALLBACK_V[1234]/.test(code)})) throw new Error('Anonymous patch state inconsistent');
    if(state.version>=5)return console.log('OPENCODE ANONYMOUS ALREADY APPLIED.');
  }
  const source = '/app/open-sse/executors/opencode.js';
  const handler='/app/src/sse/handlers/chat.js';
  const files = [source, ...(fs.existsSync(handler)?[handler]:[]), ...fs.readdirSync('/app/.next/server/chunks').filter(n=>n.endsWith('.js')).map(n=>path.join('/app/.next/server/chunks',n))];
  const changes = [];
  let executors=0,handlers=0;
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    let updated=original;
    if(original.includes('x-opencode-session')&&original.includes('_opencodeSession')){
      if(original.includes(`/*${MARK}*/`))executors++;
      else {
        const result=transform(original);
        if(result.count>1)throw new Error('Ambiguous executor match: '+file);
        executors+=result.count;updated=result.code;
      }
    }
    if(original.includes('No more accounts available')){
      const result=transformHandler(updated);
      if(result.count>1)throw new Error('Ambiguous handler match: '+file);
      handlers+=result.count||Number(original.includes(FALLBACK_MARK));updated=result.code;
    }
    if(updated===original)continue;
    const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {input: updated, encoding: 'utf8'});
    if (check.status !== 0) throw new Error('Invalid transformed syntax: ' + file);
    changes.push({file, original, updated});
  }
  if (executors!==2 || handlers!==(fs.existsSync(handler)?2:1)) throw new Error('Expected source/compiled executors and handler match; no files changed');
  if (dry) return console.log('OPENCODE ANONYMOUS DRY RUN OK: ' + changes.map(c=>c.file).join(', '));
  const backupDir = '/app/.opencode-anonymous-fix/backup-'+Date.now(); fs.mkdirSync(backupDir, {recursive:true});
  const filesState = changes.map((c,i) => {
    const backup = path.join(backupDir,String(i)); fs.writeFileSync(backup,c.original); return {file:c.file,backup};
  });
  try {
    for(const c of changes) fs.writeFileSync(c.file,c.updated);
    fs.writeFileSync(manifestPath,JSON.stringify({version:5,files:[...state.files,...filesState]},null,2));
  } catch(e) { for(const c of changes)fs.writeFileSync(c.file,c.original); throw e; }
  console.log('OPENCODE ANONYMOUS PATCH OK: persistent managed session isolation.');
}
module.exports={transform,transformHandler};
if(require.main===module)try{main()}catch(e){console.error('OPENCODE ANONYMOUS STOP:',e.message);process.exitCode=1}
