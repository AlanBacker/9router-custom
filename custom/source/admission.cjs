'use strict';
function transformAuth(code){
 if(code.includes('9R_OC_ADMISSION_V1'))return {code,count:0};
 let count=0;
 const gate=(connection,model)=>`/*9R_OC_ADMISSION_V1*/if(${connection}.providerSpecificData?.opencodePoolManaged===true&&globalThis[Symbol.for("9router.opencodePublicProxy.v1")]?.canRoute?.(${connection}.id,${model})===false)return false;`;
 code=code.replace(/const availableConnections = connections\.filter\(c => \{/g,whole=>{count++;return whole+gate('c','model');});
 code=code.replace(/(\w+)\.filter\((\w+)=>\{(?=if\(\w+\.has\(\2\.id\)\|\|\(0,[\w$.]+\)\(\2,(\w+)\)\)return!1;let \w+=\2\.providerSpecificData\?\.enabledModels)/g,(whole,connections,c,model)=>{count++;return whole+gate(c,model);});
 const pending=(connections,model)=>`/*9R_OC_ADMISSION_PENDING_V1*/if(${connections}.some(__ocConn=>__ocConn.providerSpecificData?.opencodePoolManaged===true&&globalThis[Symbol.for("9router.opencodePublicProxy.v1")]?.canRoute?.(__ocConn.id,${model})===false))return{allRateLimited:true,retryAfter:new Date(Date.now()+5000).toISOString(),retryAfterHuman:"5s",lastError:"OpenCodePublicProxyUnavailable: 匿名线路正在进行真实推理验证，请稍后重试",lastErrorCode:503};`;
 code=code.replace('if (availableConnections.length === 0) {',whole=>whole+pending('connections','model'));
 code=code.replace(/0===(\w+)\.length\)\{(?=let \w+=(\w+)\.filter\(\w+=>\(0,[\w$.]+\)\(\w+,(\w+)\)\))/g,(whole,available,connections,model)=>whole+pending(connections,model));
 return {code,count};
}
module.exports={transformAuth};
