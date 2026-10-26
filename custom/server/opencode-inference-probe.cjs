'use strict';
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
let native;
async function buildProbe(model,session,config){
  if(!native){
    const root=process.env.NINEROUTER_APP_ROOT||process.cwd();
    const source=fs.readFileSync(path.join(root,'open-sse/executors/opencode.js'),'utf8');
    const ua=source.match(/const OPENCODE_UA\s*=\s*"([^"]+)"/)?.[1];
    const client=source.match(/const OPENCODE_CLIENT\s*=\s*"([^"]+)"/)?.[1];
    if(!ua||!client)throw new Error('Upstream probe builder layout changed');
    const fingerprint=await import(pathToFileURL(path.join(root,'open-sse/utils/opencodeFingerprint.js')).href);
    native={ua,client,fingerprint,responses:new Set([...((source.match(/const RESPONSES_MODELS = new Set\(\[([\s\S]*?)\]\)/)||[])[1]||'').matchAll(/"([^"]+)"/g)].map(m=>m[1])),messages:new Set([...((source.match(/const MESSAGES_MODELS = new Set\(\[([\s\S]*?)\]\)/)||[])[1]||'').matchAll(/"([^"]+)"/g)].map(m=>m[1]))};
  }
  if(native.messages.has(model))throw new Error('Probe model uses unsupported Messages protocol; choose Chat Completions or Responses model');
  const flat=native.responses.has(model),body={model,stream:true};
  if(flat){body.input=[{type:'message',role:'user',content:[{type:'input_text',text:'Reply OK.'}]}];body.max_output_tokens=config.inferenceMaxTokens||64;body.store=false;native.fingerprint.applyFingerprintTools(body,true);}
  else{
    // Upstream free-tier gate compares the whole request template against the
    // official client: a generic/no system prompt and any tool list are both
    // rejected with 429 FreeUsageLimitError. The title-generation template
    // (exact 2.0.32 system prompt, no tools) is the smallest known-good shape.
    const prompt=require('./opencode-native-prompt.json').title;
    body.messages=[{role:'system',content:prompt},{role:'user',content:'Reply OK.'}];
    body.max_tokens=config.inferenceMaxTokens||64;
    body.stream_options={include_usage:true};
  }
  const headers={'content-type':'application/json',authorization:'Bearer public','user-agent':native.ua,'x-opencode-client':native.client,accept:'text/event-stream','x-opencode-project':'global'};
  for(const name of ['x-opencode-session','x-opencode-session-id','x-session-id','x-session-affinity'])headers[name]=session;
  return {url:'https://opencode.ai/inference/v1/'+(flat?'responses':'chat/completions'),init:{method:'POST',headers,body:JSON.stringify(body)}};
}
async function consumeProbe(response,maxBytes=131072){
  if(!response.ok){
    let detail;try{detail=await response.json();}catch{}
    return {ok:false,status:response.status,detail,retryAfter:response.headers.get('retry-after')};
  }
  let tokens=false,finished=false,error=false,bytes=0,buffer='';
  const inspect=data=>{
    if(data==='[DONE]'){finished=true;return;}
    let value;try{value=JSON.parse(data);}catch{return;}
    if(value.error||value.type==='error'||value.type==='response.failed'){error=true;return;}
    for(const c of value.choices||[]){if(c.delta?.content||c.delta?.reasoning_content||c.message?.content||c.message?.reasoning_content)tokens=true;if(c.finish_reason)finished=true;}
    if(value.type==='response.output_text.delta'&&value.delta)tokens=true;
    if(value.type==='response.reasoning_summary_text.delta'&&value.delta)tokens=true;
    if(value.type==='response.completed')finished=true;
  };
  if(!/text\/event-stream/i.test(response.headers.get('content-type')||'')){
    try{const data=await response.json();inspect(JSON.stringify(data));finished=!!data.choices?.some(c=>c.finish_reason);}catch{}
  }else if(response.body){
    const reader=response.body.getReader(),decoder=new TextDecoder();
    try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>maxBytes)break;buffer+=decoder.decode(r.value,{stream:true});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(line.startsWith('data:'))inspect(line.slice(5).trim());}if(error||finished)break;}}finally{await reader.cancel().catch(()=>{});}
  }
  return {ok:tokens&&finished&&!error,status:response.status,detail:tokens&&finished&&!error?undefined:{error:{type:'InvalidInferenceResponse',message:'No completed inference output'}}};
}
module.exports={buildProbe,consumeProbe};
