'use strict';
try{
  const Agent=require('./opencode-public-proxy.cjs').getProxyAgent();
  if(typeof Agent!=='function')throw new Error('ProxyAgent export is unavailable');
  if(typeof process.getuid==='function'&&process.getuid()===0)throw new Error('Dependency validation must run as the application user');
  console.log('[OpenCodePublicProxy] Application-user dependency check OK uid='+(process.getuid?.()??'unknown'));
}catch(e){console.error('[OpenCodePublicProxy] Dependency check failed: '+e.message);process.exitCode=1;}
