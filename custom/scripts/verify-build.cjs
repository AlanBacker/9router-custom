'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),manifest=path.join(root,'custom/build-manifest.json');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
function files(dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.posix.join(dir,e.name)):e.name.endsWith('.js')?[path.posix.join(dir,e.name)]:[]);}
function write(){
 const server=files('.next/server'),client=files('.next/static'),proofs=[];
 for(const [token,group]of [['9router.opencodeAnonymous.v1',server],['[OpenCodeAutoRecovery]',server],['9router.opencodePublicProxy.v1',server],['canRoute',server],['9router-opencode-pool',client],['全目标实测通过',client],['auth-cooldown',client],['data-maintenance',client]]){
  const file=group.find(f=>fs.readFileSync(path.join(root,f),'utf8').includes(token));assert(file,'Compiled feature missing: '+token);proofs.push({token,file,sha256:sha(file)});
 }
 const source=['custom-server.js','open-sse/config/opencodeCustom.js','open-sse/services/opencodeCustom.js','open-sse/executors/opencode.js','open-sse/providers/registry/opencode.js','open-sse/translator/concerns/thinkingUnified.js','src/sse/handlers/chat.js'];
 fs.writeFileSync(manifest,JSON.stringify({version:1,build:'source',proofs,source:source.map(file=>({file,sha256:sha(file)}))},null,2)+'\n');
 console.log('Verified source-built server and dashboard features; saved hashes.');
}
function verifyIfBuilt(){
 if(!fs.existsSync(manifest)){if(process.env.NODE_ENV==='production')throw Error('Missing source build verification manifest');return;}
 const data=JSON.parse(fs.readFileSync(manifest));assert.equal(data.build,'source');
 for(const entry of [...data.proofs,...data.source])assert.equal(sha(entry.file),entry.sha256,'Built file changed: '+entry.file);
 assert.equal(typeof require('../server/opencode-public-proxy.cjs').getProxyAgent(),'function');
 console.log('Native source build verified; no runtime bundle patching.');
}
module.exports={verifyIfBuilt};
if(require.main===module){if(process.argv.includes('--write'))write();else verifyIfBuilt();}
