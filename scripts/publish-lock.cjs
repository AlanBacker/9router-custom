'use strict';
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const data=JSON.parse(fs.readFileSync('candidate.json'));delete data.changed;data.verifiedAt=new Date().toISOString();data.overlayRevision=process.env.GITHUB_SHA;
const endpoint='repos/'+process.env.GITHUB_REPOSITORY+'/contents/upstream.lock.json';let sha;
try{sha=JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',stdio:['ignore','pipe','pipe']})).sha;}catch(e){if(!String(e.stderr).includes('404'))throw e;}
const payload={message:'chore: record verified upstream '+data.upstream.digest.slice(7,19),branch:'main',content:Buffer.from(JSON.stringify(data,null,2)+'\n').toString('base64'),...(sha?{sha}:{})};
execFileSync('gh',['api','--method','PUT',endpoint,'--input','-'],{input:JSON.stringify(payload),stdio:['pipe','ignore','inherit']});
console.log('Recorded tested upstream digest and patch revision.');
