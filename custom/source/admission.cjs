'use strict';
function pendingResult(model,hook='Symbol.for("9router.opencodePublicProxy.v1")'){
 return `/*9R_OC_ADMISSION_STATUS_V2*/return(globalThis[${hook}]?.getUnavailable?.(${model})||{allRateLimited:true,retryAfter:new Date(Date.now()+60000).toISOString(),retryAfterHuman:"60s",lastError:"OpenCodePublicProxyUnavailable: 当前没有可用线路，恢复时间未知",lastErrorCode:503});`;
}
function upgradePending(code){
 if(code.includes('9R_OC_ADMISSION_STATUS_V2'))return code;
 const start=code.indexOf('/*9R_OC_ADMISSION_PENDING_V1*/');if(start<0)throw Error('Missing admission pending guard');
 const match=code.slice(start).match(/canRoute\?\.\([^,]+,\s*(\w+)\)/);if(!match)throw Error('Cannot identify admission model');
 const old=/return\s*\{\s*allRateLimited:\s*true,\s*retryAfter:\s*new Date\(Date\.now\(\)\s*\+\s*5000\)\.toISOString\(\),\s*retryAfterHuman:\s*"5s",\s*lastError:\s*"OpenCodePublicProxyUnavailable: 匿名线路正在进行真实推理验证，请稍后重试",\s*lastErrorCode:\s*503\s*\};/;
 const tail=code.slice(start);if(!old.test(tail))throw Error('Unsupported admission error layout');
 return code.slice(0,start)+tail.replace(old,pendingResult(match[1]));
}
function transformAuth(code){
 if(code.includes('9R_OC_ADMISSION_V1')){const updated=upgradePending(code);return {code:updated,count:updated===code?0:1};}
 let count=0;
 const gate=(connection,model)=>`/*9R_OC_ADMISSION_V1*/if(${connection}.providerSpecificData?.opencodePoolManaged===true&&globalThis[Symbol.for("9router.opencodePublicProxy.v1")]?.canRoute?.(${connection}.id,${model})===false)return false;`;
 code=code.replace(/const availableConnections = connections\.filter\(c => \{/g,whole=>{count++;return whole+gate('c','model');});
 code=code.replace(/(\w+)\.filter\((\w+)=>\{(?=if\(\w+\.has\(\2\.id\)\|\|\(0,[\w$.]+\)\(\2,(\w+)\)\)return!1;let \w+=\2\.providerSpecificData\?\.enabledModels)/g,(whole,connections,c,model)=>{count++;return whole+gate(c,model);});
 const pending=(connections,model)=>`/*9R_OC_ADMISSION_PENDING_V1*/if(${connections}.some(__ocConn=>__ocConn.providerSpecificData?.opencodePoolManaged===true&&globalThis[Symbol.for("9router.opencodePublicProxy.v1")]?.canRoute?.(__ocConn.id,${model})===false))return{allRateLimited:true,retryAfter:new Date(Date.now()+5000).toISOString(),retryAfterHuman:"5s",lastError:"OpenCodePublicProxyUnavailable: 匿名线路正在进行真实推理验证，请稍后重试",lastErrorCode:503};`;
 code=code.replace('if (availableConnections.length === 0) {',whole=>whole+pending('connections','model'));
 code=code.replace(/0===(\w+)\.length\)\{(?=let \w+=(\w+)\.filter\(\w+=>\(0,[\w$.]+\)\(\w+,(\w+)\)\))/g,(whole,available,connections,model)=>whole+pending(connections,model));
 return {code:count?upgradePending(code):code,count};
}
module.exports={transformAuth,upgradePending};
