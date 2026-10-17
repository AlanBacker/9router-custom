'use strict';
const MARK = '9R_OC_ANONYMOUS_V1';
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

module.exports={transform,transformHandler};
