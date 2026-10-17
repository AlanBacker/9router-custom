'use strict';
// Compatibility installer for the existing upstream-image deployment only.
// The native source-built image already compiles this guard and never runs this file.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {transformAuth}=require('./admission-source.cjs');
const files=['/app/src/sse/services/auth.js',...fs.readdirSync('/app/.next/server/chunks').filter(n=>n.endsWith('.js')).map(n=>path.join('/app/.next/server/chunks',n))];
const changes=[];let matches=0;
for(const file of files){
 if(!fs.existsSync(file))continue;const original=fs.readFileSync(file,'utf8');if(!original.includes('total connections:'))continue;
 const r=transformAuth(original);if(![0,1].includes(r.count)||!r.code.includes('9R_OC_ADMISSION_PENDING_V1')||!r.code.includes('9R_OC_ADMISSION_STATUS_V2'))throw Error('Unsupported credential selection layout: '+file);
 if(r.code===original){matches++;continue;}
 const check=spawnSync(process.execPath,['--input-type=module','--check'],{input:r.code,encoding:'utf8'});if(check.status!==0)throw Error('Invalid admission syntax: '+file+' '+check.stderr);
 changes.push({file,original,updated:r.code});matches++;
}
if(matches<1||matches>2)throw Error('Expected one compiled gate and optional source gate');
if(process.argv.includes('--dry-run')){console.log('ADMISSION_GATE_DRY_RUN_OK='+matches);process.exit(0);}
const backup='/app/.opencode-admission-fix/backup-'+Date.now();fs.mkdirSync(backup,{recursive:true});
try{for(const [i,c]of changes.entries()){fs.writeFileSync(path.join(backup,String(i)),c.original);fs.writeFileSync(c.file,c.updated);}}
catch(e){for(const c of changes)fs.writeFileSync(c.file,c.original);throw e;}
console.log('ADMISSION_GATE_READY='+matches);
