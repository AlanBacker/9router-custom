'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const run=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
(async()=>{
 const name='autopatch-ci-'+crypto.randomBytes(5).toString('hex'),volume=name+'-data';
 try{
  run('run','-d','--name',name,'-p','127.0.0.1::20128','-v',volume+':/app/data','-e','INITIAL_PASSWORD='+crypto.randomBytes(24).toString('hex'),'-e','JWT_SECRET='+crypto.randomBytes(32).toString('hex'),'9router-autopatch:ci');
  const port=run('port',name,'20128/tcp').split(':').at(-1),base='http://127.0.0.1:'+port;
  let healthy=false;for(let n=0;n<90;n++){try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert(healthy,'Container did not become healthy');
  assert.equal((await fetch(base+'/api/settings')).status,401,'Management API must require login');
  run('exec','-u','node',name,'node','/opt/9router-autopatch/verify-image.cjs');
  run('exec','-u','node',name,'node','/opt/9router-hotfix/check-proxy-runtime.cjs');
  const before=run('inspect','--format','{{.Image}}',name);run('restart',name);
  let restarted=false;for(let n=0;n<90;n++){try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)})).ok){restarted=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert(restarted,'Restart failed');assert.equal(run('inspect','--format','{{.Image}}',name),before);
  run('exec','-u','node',name,'node','/opt/9router-autopatch/verify-image.cjs');
  console.log('PASS: clean data volume startup, health, authenticated management, application-user dependencies, restart idempotence. No upstream inference requests sent.');
 }catch(e){try{console.error(run('logs','--tail','80',name));}catch{}throw e;}
 finally{try{run('rm','-f',name);}catch{}try{run('volume','rm',volume);}catch{}}
})().catch(e=>{console.error(e.message);process.exitCode=1});
