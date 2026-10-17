const assert = require('node:assert/strict');
const config = require('../patches/thinking-compat.json');
const {createCompatFetch} = require('../patches/thinking-compat.cjs');
const URL = 'https://opencode.ai/inference/v1/chat/completions';
const silent = {info(){},warn(){}};
const opts = body => ({method:'POST',headers:{authorization:'Bearer test-only','content-length':'999'},body:JSON.stringify(body)});
const reject = field => Response.json({error:{param:field,type:'invalid_request_error',message:`Upstream failed: [unknown_parameter] json: unknown field "${field}"`}},{status:400});

(async()=>{
  const sent=[];
  const compat=createCompatFetch(async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true})},config,silent);
  for(const level of ['low','high','max']){
    const original=opts({model:'glm-5.3-flash-free',thinking:{type:'enabled'},reasoning_effort:level,messages:[{role:'user',content:'test'}]});
    original.signal=new AbortController().signal;
    await compat(URL,original);
    assert(!Object.hasOwn(sent.at(-1),'thinking'));assert.equal(sent.at(-1).reasoning_effort,level);
    assert(JSON.parse(original.body).thinking,'Caller body changed');
  }
  await compat(URL,opts({model:'deepseek-v4.1-flash-free',thinking:{type:'enabled'},reasoning_effort:'low'}));
  assert.equal(sent.at(-1).thinking.type,'enabled');assert.equal(sent.at(-1).reasoning_effort,'low');

  const dynamic=[];
  const logs=[];
  const adaptive=createCompatFetch(async(url,init)=>{
    const body=JSON.parse(init.body);dynamic.push({body,headers:new Headers(init.headers),signal:init.signal});
    if(Object.hasOwn(body,'thinking'))return reject('thinking');
    if(Object.hasOwn(body,'reasoning_effort'))return reject('reasoning_effort');
    return Response.json({ok:true});
  },config,{info(){},warn:s=>logs.push(s)});
  const signal=new AbortController().signal;
  const first=opts({model:'future-free',thinking:{type:'enabled'},reasoning_effort:'high',messages:[{role:'user',content:'test'}],tools:[{type:'function'}]});first.signal=signal;
  assert.equal((await adaptive(URL,first)).status,200);assert.equal(dynamic.length,3);
  assert.equal(dynamic.at(-1).headers.get('content-length'),null);
  assert.equal(dynamic.at(-1).headers.get('authorization'),'Bearer test-only');
  assert.equal(dynamic.at(-1).signal,signal);assert.equal(dynamic.at(-1).body.tools.length,1);
  assert.equal((await adaptive(URL,first)).status,200);assert.equal(dynamic.length,4,'Rejected fields were not learned');
  assert.equal(logs.length,2);assert(logs.every(s=>s.includes('upstream default')));

  for(const field of ['tools','messages','model','temperature']){
    let attempts=0;
    const guarded=createCompatFetch(async()=>{attempts++;return reject(field)},config,silent);
    const response=await guarded(URL,opts({model:'new-free',thinking:{type:'enabled'},reasoning_effort:'high',tools:[],messages:[],temperature:1}));
    assert.equal(response.status,400);assert.equal(attempts,1,'A non-reasoning field was retried');
  }
  for(const [status,message] of [[401,'Unauthorized'],[429,'rate limited'],[400,'reasoning_effort must be low or high'],[500,'unknown field "thinking"']]){
    let attempts=0;const guarded=createCompatFetch(async()=>{attempts++;return Response.json({error:{message}},{status})},config,silent);
    const r=await guarded(URL,opts({model:'new-free',thinking:{type:'enabled'}}));assert.equal(r.status,status);assert.equal(attempts,1);
  }
  const bypass=[];const pass=createCompatFetch(async(url,init)=>{bypass.push(init);return Response.json({ok:true})},config,silent);
  const original=opts({model:'glm-5.3-flash',thinking:{type:'enabled'}});
  await pass('https://api.z.ai/api/paas/v4/chat/completions',original);assert.equal(bypass[0],original);
  await pass('https://opencode.ai/inference/v1/responses',original);assert.equal(bypass[1],original);
  const stream=new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const streaming=createCompatFetch(async()=>stream,config,silent);
  assert.equal(await streaming(URL,opts({model:'glm-5.3-flash-free',reasoning_effort:'high'})),stream);
  assert.match(await stream.text(),/\[DONE\]/);
  console.log('PASS: GLM family rules; preserved DeepSeek and effort; bounded rejection fallback and learning; auth/signal/tool preservation; no retries for value/auth/quota failures; untouched success streams and other routes.');
})().catch(e=>{console.error(e);process.exitCode=1});
