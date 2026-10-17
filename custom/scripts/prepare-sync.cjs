'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),record='custom/upstream.lock.json';
function git(...args){return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();}
function codeHash(){
 const hash=crypto.createHash('sha256');
 for(const file of git('ls-files','-z').split('\0').filter(Boolean).sort()){
  if([record,'custom/build-manifest.json'].includes(file))continue;
  let bytes=fs.readFileSync(path.join(root,file));try{bytes=Buffer.from(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n/g,'\n'));}catch{}
  hash.update(file+'\0').update(bytes).update('\0');
 }return hash.digest('hex');
}
function main(){
 process.chdir(root);const baseHead=git('rev-parse','HEAD');
 git('config','user.name','github-actions[bot]');git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com');
 if(!git('remote').split('\n').includes('upstream'))git('remote','add','upstream','https://github.com/decolua/9router.git');
 git('fetch','--no-tags','upstream','master');const sourceSha=git('rev-parse','refs/remotes/upstream/master');
 git('merge','--no-ff','--no-commit','refs/remotes/upstream/master');
 execFileSync(process.execPath,['custom/scripts/apply-source.cjs'],{cwd:root,stdio:'inherit'});
 git('add','-A');const currentHash=codeHash();
 let previous;try{previous=JSON.parse(fs.readFileSync(record));}catch(e){if(e.code!=='ENOENT')throw e;}
 const changed=process.env.FORCE_BUILD==='true'||previous?.sourceSha!==sourceSha||previous?.codeHash!==currentHash;
 if(changed){
  fs.writeFileSync(record,JSON.stringify({schemaVersion:1,repository:'decolua/9router',branch:'master',sourceSha,codeHash:currentHash,preparedAt:new Date().toISOString()},null,2)+'\n');git('add',record);
  if(spawnSync('git',['diff','--cached','--quiet'],{cwd:root}).status!==0)git('commit','-m','Sync upstream '+sourceSha.slice(0,12)+' and reapply source customizations');
 }
 const repository=process.env.GITHUB_REPOSITORY||'AlanBacker/9router-custom';if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('Invalid repository');
 const output={changed,baseHead,sourceSha,revision:git('rev-parse','HEAD'),image:'ghcr.io/'+repository.toLowerCase()};
 if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(output).map(([k,v])=>k+'='+v).join('\n')+'\n');
 console.log(JSON.stringify(output,null,2));
}
module.exports={codeHash};
if(require.main===module)try{main()}catch(e){console.error('Source merge/customization failed; published source and stable image remain unchanged. '+e.message);process.exitCode=1;}
