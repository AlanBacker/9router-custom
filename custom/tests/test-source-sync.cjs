'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{execFileSync,spawnSync}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'9router-source-sync-test-')),upstream=path.join(dir,'official'),fork=path.join(dir,'custom');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const setup=cwd=>{git(cwd,'config','user.name','Fixture');git(cwd,'config','user.email','fixture@example.invalid');};
try{
 fs.mkdirSync(upstream);git(upstream,'init','-b','master');setup(upstream);fs.writeFileSync(path.join(upstream,'app.js'),'const value=1;\n');git(upstream,'add','.');git(upstream,'commit','-m','Original application');
 git(dir,'clone',upstream,fork);setup(fork);git(fork,'switch','-c','main');git(fork,'remote','add','upstream',upstream);
 fs.mkdirSync(path.join(fork,'custom/scripts'),{recursive:true});fs.copyFileSync('custom/scripts/prepare-sync.cjs',path.join(fork,'custom/scripts/prepare-sync.cjs'));
 fs.writeFileSync(path.join(fork,'custom/scripts/apply-source.cjs'),'const fs=require("fs");if(!fs.readFileSync("app.js","utf8").includes("value=42"))throw Error("Custom source lost");');
 fs.writeFileSync(path.join(fork,'app.js'),'const value=42;\n');git(fork,'add','.');git(fork,'commit','-m','Native custom feature');
 fs.writeFileSync(path.join(upstream,'new-upstream.js'),'export const feature=true;\n');git(upstream,'add','.');git(upstream,'commit','-m','Official source update');
 const run=()=>spawnSync(process.execPath,['custom/scripts/prepare-sync.cjs'],{cwd:fork,encoding:'utf8',env:{...process.env,FORCE_BUILD:'false',GITHUB_REPOSITORY:'Fixture/Source',GITHUB_OUTPUT:path.join(dir,'outputs')}});
 const first=run();assert.equal(first.status,0,first.stderr);assert(fs.existsSync(path.join(fork,'new-upstream.js')));assert.equal(fs.readFileSync(path.join(fork,'app.js'),'utf8'),'const value=42;\n');assert(JSON.parse(first.stdout).changed);
 const head=git(fork,'rev-parse','HEAD');const second=run();assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).changed,false);assert.equal(git(fork,'rev-parse','HEAD'),head,'no-op sync must not create commits');
 fs.writeFileSync(path.join(upstream,'app.js'),'const value=2;\n');git(upstream,'add','.');git(upstream,'commit','-m','Conflicting official change');const conflict=run();assert.notEqual(conflict.status,0);assert.equal(git(fork,'rev-parse','HEAD'),head,'conflicting sync must not advance main');assert.match(conflict.stderr,/remain unchanged/);
 console.log('PASS: actual Git source merge, retained native customization, unchanged-source skip and conflict preservation.');
}finally{
 const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('9router-source-sync-test-'));fs.rmSync(resolved,{recursive:true,force:true});
}
