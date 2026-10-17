'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const upstream={repository:'decolua/9router',branch:'master',tag:'decolua/9router:latest'};
function patchDigest(root){
 const hash=crypto.createHash('sha256');
 function walk(relative){for(const ent of fs.readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(ent.name==='node_modules')continue;const name=path.posix.join(relative,ent.name);if(ent.isDirectory())walk(name);else hash.update(name+'\0').update(fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n')).update('\0');}}
 for(const dir of ['patches','scripts','tests','.github'])walk(dir);
 for(const name of ['Dockerfile','package.json'])hash.update(name+'\0').update(fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n')).update('\0');
 return hash.digest('hex');
}
function candidate({manifest,sourceSha,patchesSha,previous,repository,force=false}){
 if(!/^sha256:[0-9a-f]{64}$/.test(manifest.digest))throw Error('Invalid upstream image digest');
 if(!/^[0-9a-f]{40}$/.test(sourceSha))throw Error('Invalid upstream source commit');
 if(!/^[0-9a-f]{64}$/.test(patchesSha))throw Error('Invalid patch digest');
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw Error('Invalid destination repository');
 const next={schemaVersion:1,upstream:{...upstream,image:upstream.tag.split(':')[0]+'@'+manifest.digest,digest:manifest.digest,sourceSha},patchesSha,publishImage:'ghcr.io/'+repository.toLowerCase()};
 const changed=force||!previous||previous.upstream?.digest!==manifest.digest||previous.upstream?.sourceSha!==sourceSha||previous.patchesSha!==patchesSha;
 return {...next,changed};
}
function main(){
 const manifest=JSON.parse(execFileSync('docker',['buildx','imagetools','inspect',upstream.tag,'--format','{{json .Manifest}}'],{encoding:'utf8'}));
 const sourceSha=execFileSync('git',['ls-remote','https://github.com/'+upstream.repository+'.git','refs/heads/'+upstream.branch],{encoding:'utf8'}).trim().split(/\s+/)[0];
 let previous;try{previous=JSON.parse(fs.readFileSync('upstream.lock.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const next=candidate({manifest,sourceSha,patchesSha:patchDigest(process.cwd()),previous,repository:process.env.GITHUB_REPOSITORY||'AlanBacker/9router-autopatch',force:process.env.FORCE_BUILD==='true'});
 fs.writeFileSync('candidate.json',JSON.stringify(next,null,2)+'\n');
 if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`changed=${next.changed}\nimage=${next.upstream.image}\nsourceSha=${next.upstream.sourceSha}\npublishImage=${next.publishImage}\n`);
 console.log(JSON.stringify(next,null,2));
}
module.exports={patchDigest,candidate};
if(require.main===module)try{main()}catch(e){console.error(e.message);process.exitCode=1;}
