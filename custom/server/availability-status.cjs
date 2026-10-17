'use strict';

// Report local unavailability without retrying requests or changing upstream identities.
function describeUnavailable(snapshot, model, {now=Date.now(),busyCount=0}={}) {
  const normalized=String(model||'').replace(/\([^()]*\)$/,'');
  const lines=snapshot.lines||[];
  const connected=Number(snapshot.connectivityHealthy??snapshot.healthy)||0;
  const interval=Number(snapshot.maintenance?.replenishSeconds)||45;
  const lastRound=Number(snapshot.lastRefresh)||0;
  const stalled=snapshot.maintenance?.automatic===true&&lastRound>0&&now-lastRound>Math.max(180000,interval*4000);
  let reason='目标模型没有通过验证的可用线路，恢复时间未知';
  let seconds=60;
  if(stalled&&connected===0)reason='代理维护任务长期未推进，当前没有合格线路；需要检查维护任务';
  else if(connected===0)reason='当前没有通过连通检查的代理，目标模型不可用，恢复时间未知';
  else if(busyCount>0&&(snapshot.readyByModel?.[normalized]||0)>0){reason='已验证线路正在处理请求，请降低并发';seconds=5;}
  else {
    const eligible=lines.filter(l=>!normalized||l.requiredModels?.includes(normalized));
    const future=eligible.map(l=>Number(l.nextValidationAt)||0).filter(t=>t>now);
    if(eligible.length&&future.length===eligible.length){
      seconds=Math.max(60,Math.ceil((Math.min(...future)-now)/1000));
      reason='目标模型的线路处于验证冷却中；冷却到期不代表调用一定恢复';
    }else if(Number(snapshot.inferenceProbesThisMinute)>=Number(snapshot.inferenceProbesPerMinute)&&Number(snapshot.inferenceProbesPerMinute)>0)
      reason='本轮验证预算已用完，目标模型当前没有可用线路';
  }
  seconds=Math.min(86400,seconds);
  return {allRateLimited:true,retryAfter:new Date(now+seconds*1000).toISOString(),retryAfterHuman:seconds+'s',lastError:'OpenCodePublicProxyUnavailable: '+reason,lastErrorCode:503};
}
module.exports={describeUnavailable};
