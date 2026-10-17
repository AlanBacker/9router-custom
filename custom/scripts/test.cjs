'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
process.chdir(path.resolve(__dirname,'../..'));
for(const file of fs.readdirSync('custom/tests').filter(n=>/^test-.*\.cjs$/.test(n)).sort()){
 const result=spawnSync(process.execPath,[path.join('custom/tests',file)],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
