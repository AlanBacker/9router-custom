const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {transformRegistry} = require('../patches/fix-9router-opencode-pool.cjs');
const {createConnections} = require('../patches/opencode-pool-ui.js');

const source = fs.readFileSync('_upstream/open-sse/providers/registry/opencode.js','utf8');
const minified = '({id:"opencode",priority:40,hasFree:!0,alias:"oc",uiAlias:"oc",display:{name:"OpenCode Free"},category:"free",noAuth:!0,transport:{noAuth:!0}})';
for (const code of [source.replace('export default',''), minified]) {
  const result = transformRegistry(code);
  assert.equal(result.count,1);
  const registry = vm.runInNewContext('('+result.code.replace(/;\s*$/,'')+')');
  assert.equal(registry.category,'freeTier');
  assert.equal(registry.noAuth,false);
  assert.equal(registry.transport.noAuth,true);
  assert.equal(registry.authModes[0],'apikey');
  assert.equal(transformRegistry(result.code).count,0);
}
assert.equal(transformRegistry('({id:"another",category:"free",noAuth:true})').count,0);
assert.throws(()=>transformRegistry('({id:"opencode",alias:"oc",display:{name:"Another"},category:"free",noAuth:true})'));

function fakeApi(options = {}) {
  const state = {connections: [{id:'old',provider:'opencode',name:'Free 1',priority:1}],
    settings:{providerStrategies:{other:{fallbackStrategy:'fill-first'},opencode:{proxyPoolId:'pool-a',customSetting:7}}},posts:[],patches:[],progress:[]};
  let conflict = options.conflict;
  const response = (status,body)=>({status,ok:status>=200&&status<300,json:async()=>structuredClone(body)});
  const fetchFn = async(url,req={})=>{
    if (req.method==='POST') {
      const body = JSON.parse(req.body);
      state.posts.push(body);
      if (conflict) { conflict=false; state.connections.push({id:'racing',provider:'opencode',name:body.name,priority:2});return response(409,{error:'Name conflict'}); }
      if(options.failAfter!==undefined && state.connections.filter(c=>c.id.startsWith('new')).length===options.failAfter)return response(503,{error:'Test failure'});
      const connection={...body,id:'new'+state.posts.length};state.connections.push(connection);
      return response(201,{connection});
    }
    if (req.method==='PATCH') {
      if(options.patchFailure)return response(500,{error:'Settings failure'});
      state.patches.push(JSON.parse(req.body));Object.assign(state.settings,state.patches.at(-1));return response(200,state.settings);
    }
    if(url==='/api/providers')return response(200,{connections:state.connections});
    if(url==='/api/settings')return response(200,state.settings);
    throw new Error('Unexpected request');
  };
  return {...state,fetchFn};
}

(async()=>{
  const normal=fakeApi();
  const result=await createConnections({count:3,prefix:'Free',fetchFn:normal.fetchFn,onProgress:n=>normal.progress.push(n)});
  assert.deepEqual(result.created.map(c=>c.name),['Free 2','Free 3','Free 4']);
  assert.equal(normal.connections.length,4);
  assert.deepEqual(normal.progress,[1,2,3]);
  for(const post of normal.posts){assert.equal(post.apiKey,'public');assert.equal(post.allowOverwrite,false);assert.equal(post.proxyPoolId,'pool-a')}
  assert.equal(normal.patches[0].providerStrategies.opencode.stickyRoundRobinLimit,1);
  assert.equal(normal.patches[0].providerStrategies.opencode.customSetting,7);
  assert.equal(normal.patches[0].providerStrategies.other.fallbackStrategy,'fill-first');
  const race=fakeApi({conflict:true});
  const raced=await createConnections({count:2,prefix:'Free',fetchFn:race.fetchFn});
  assert.deepEqual(raced.created.map(c=>c.name),['Free 3','Free 4']);
  const partial=fakeApi({failAfter:1});
  await assert.rejects(createConnections({count:3,prefix:'Free',fetchFn:partial.fetchFn}),e=>e.created.length===1&&/Test failure/.test(e.message));
  const warning=fakeApi({patchFailure:true});
  const warned=await createConnections({count:1,prefix:'Free',fetchFn:warning.fetchFn});
  assert.equal(warned.created.length,1);assert.match(warned.warning,/轮询失败/);
  const noRotation=fakeApi();await createConnections({count:1,prefix:'Free',roundRobin:false,fetchFn:noRotation.fetchFn});assert.equal(noRotation.patches.length,0);
  for(const count of [0,-1,1.5,1001,NaN]) await assert.rejects(createConnections({count,prefix:'Free',fetchFn:()=>{throw new Error('Should not fetch')}}),/新增数量/);
  await assert.rejects(createConnections({count:1,prefix:'',fetchFn:()=>{throw new Error('Should not fetch')}}),/前缀/);
  await assert.rejects(createConnections({count:1,prefix:'Free',fetchFn:async()=>({ok:false,status:401,json:async()=>({error:'Unauthorized'})})}),e=>e.status===401&&e.created.length===0);
  console.log('PASS: registry scope and transport; batch count and unique names; preserved settings/proxy; rotation; concurrent conflicts; partial failure; auth and invalid inputs.');
})().catch(e=>{console.error(e);process.exitCode=1});
