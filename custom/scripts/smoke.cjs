'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const run=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
(async()=>{
 const name='autopatch-ci-'+crypto.randomBytes(5).toString('hex'),volume=name+'-data';
 try{
  run('run','-d','--name',name,'-p','127.0.0.1::20128','-v',volume+':/app/data','-e','INITIAL_PASSWORD='+crypto.randomBytes(24).toString('hex'),'-e','JWT_SECRET='+crypto.randomBytes(32).toString('hex'),'9router-custom:ci');
  const getBase=()=> 'http://127.0.0.1:'+run('port',name,'20128/tcp').split(':').at(-1);let base=getBase();
  let healthy=false;for(let n=0;n<90;n++){try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert(healthy,'Container did not become healthy');
  assert.equal((await fetch(base+'/api/settings')).status,401,'Management API must require login');
  run('exec','-u','node',name,'node','/app/custom/scripts/verify-build.cjs');
  run('exec','-u','node',name,'node','/app/custom/server/check-proxy-runtime.cjs');
  assert.match(run('exec','-u','node',name,'bun','--version'),/^\d+\.\d+\.\d+/, 'Bun runtime is present for the inference relay');
  run('exec','-u','node',name,'node','-e','const net=require("net"),s=net.connect(20129,"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))');
  assert(/\[OpenCodeRelay\] Bun transport ready/.test(run('logs','--tail','200',name)),'inference relay started with the app');
  const before=run('inspect','--format','{{.Image}}',name);run('restart',name);base=getBase();
  let restarted=false;let last='no response';for(let n=0;n<90;n++){try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)});last='HTTP '+r.status;if(r.ok){restarted=true;break;}}catch(e){last=e.message;}await new Promise(r=>setTimeout(r,500));}assert(restarted,'Restart health check failed at '+base+': '+last);assert.equal(run('inspect','--format','{{.Image}}',name),before);
  run('exec','-u','node',name,'node','/app/custom/scripts/verify-build.cjs');
  run('exec',name,'node','-e','const fs=require("fs");for(const p of ["/app/.ds41-low-fix","/app/.opencode-pool-fix","/app/.opencode-anonymous-fix"])if(fs.existsSync(p))throw Error("Unexpected compiled-bundle patch state")');
  console.log('PASS: clean data volume startup, health, authenticated management, application-user dependencies, restart idempotence. No upstream inference requests sent.');
 }catch(e){try{console.error(run('logs','--tail','80',name));}catch{}throw e;}
 finally{try{run('rm','-f',name);}catch{}try{run('volume','rm',volume);}catch{}}
})().catch(e=>{console.error(e.message);process.exitCode=1});
