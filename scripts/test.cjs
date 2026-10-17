'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
process.chdir(path.join(__dirname,'..'));
for(const file of fs.readdirSync('tests').filter(n=>/^test-.*\.cjs$/.test(n)).sort()){
 const r=spawnSync(process.execPath,[path.join('tests',file)],{stdio:'inherit'});
 if(r.status!==0)process.exit(r.status||1);
}
