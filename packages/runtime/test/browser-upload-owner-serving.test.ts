// Candidate-only acceptance: actual registered owner inbox, signed metadata
// custody, private workspace/R2, approval callback and effect ledger. Provider
// transport and model replies are explicit fakes; no live requests are allowed.
import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {TelegramOwnerDO} from '../src/channels/telegram-owner-do';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
import {commonBrowserFixture,commonBrowserMeteredFixtureLoader} from './fixtures/common-browser-sdk';
import {routerSignature} from '../src/identity/owner-directory';
import {consoleAccess,CONSOLE_COOKIE} from '../src/channels/console';
import {generalDigest} from '../src/channels/general-browser-observation';
const proof=vi.hoisted(()=>({inputs:[] as any[],outputs:[] as any[],delivered:[] as any[],calls:0,handle:'',fileRef:'',downloadRef:'',fileId:'',revision:0,uploads:0,closed:false,changed:false}));
const csv=new TextEncoder().encode('owner,amount\nfictional,7\n');
vi.mock('../src/channels/cloudflare-general-browser',async load=>{
 const actual=await load<typeof import('../src/channels/cloudflare-general-browser')>();
 return {...actual,cloudflareGeneralBrowser:(options:any)=>({...actual.cloudflareGeneralBrowser(options),download:async(_session:any,_snapshot:any,_ref:string,prepare:any,consume:any)=>{await prepare();await consume({filename:'report.csv',mime:'text/csv',byte_size:csv.length,sha256:await generalDigest(csv)},csv);},upload:async(_session:any,_snapshot:any,_ref:string,file:any,authority:any,prepare:any)=>{
  expect(proof.closed).toBe(true);await authority.assertCurrent();await prepare();proof.uploads++;
  expect(file.name).toBe('report.csv');expect(new Uint8Array(file.buffer)).toEqual(csv);return {filename:file.name,mime:file.mimeType,byte_size:file.buffer.length,sha256:await generalDigest(file.buffer)};
 }})};
});
vi.mock('openai',()=>({default:class{responses={create:async(input:any)=>{
 proof.inputs.push(structuredClone(input));const format=input.text?.format?.name;
 const outputs=(Array.isArray(input.input)?input.input:[]).filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));
 for(const result of outputs){proof.outputs.push(result);if(result.ok&&result.data?.session_handle)proof.handle=result.data.session_handle;if(result.ok&&result.data?.elements){proof.fileRef=result.data.elements.find((element:any)=>element.name==='Document')?.ref??proof.fileRef;proof.downloadRef=result.data.elements.find((element:any)=>element.name==='Download CSV')?.ref??proof.downloadRef;}if(result.ok&&result.data?.download){proof.fileId=result.data.download.file_id;proof.revision=result.data.download.revision;}}
 if(!format&&commonBrowserFixture.pages.length){const page=commonBrowserFixture.pages[0];if(!page.uploadFormFixture){page.uploadFormFixture=true;const evaluate=page.evaluate;page.evaluate=async()=>{const state=await evaluate();return {...state,elements:[...state.elements.map((element:any)=>element.type==='file'?{...element,inForm:true,formAction:'https://example.com/upload',formMethod:'post'}:element),{selector:'a',tag:'a',role:'link',name:'Download CSV',href:'https://example.com/report.csv',value:'',type:'',disabled:false,selected:false,checked:false,inForm:false}]};};}}
 const at=format?-1:proof.calls++;
 const call=at===0?{name:'browse_page',args:{provider:'cloudflare_playwright',retain_session:true,url:'https://example.com/a',instruction:'Read signed-in fictional account'}}:at===1?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.handle,url:'https://example.com/a',task:'Observe authenticated report and upload input',max_actions:1,command:{operation:'inspect'}}}:at===2?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.handle,url:'https://example.com/a',task:'Save authenticated CSV',max_actions:1,command:{operation:'download',element_ref:proof.downloadRef}}}:at===3?{name:'browse_act',args:{provider:'cloudflare_playwright',session_handle:proof.handle,url:'https://example.com/a',task:'Upload this exact retained CSV after approval',max_actions:1,command:{operation:'upload',element_ref:proof.fileRef,file_id:proof.fileId,revision:proof.revision}}}:undefined;
 return {id:'fictional-file-serving-model',output:call?[{type:'function_call',call_id:`file-serving-${at}`,name:call.name,arguments:JSON.stringify(call.args)}]:[],output_text:format==='task_source_scope'?'{"decision":"retain","sources":[]}':format==='claim_ops'?'{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}':format==='reaction'?'{"reaction":"👌"}':format?'Local structured fixture.':call?'':'Approve the exact report.csv file and destination in the owner card.',usage:{input_tokens:1,output_tokens:1}};
}}}}));
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string,body:any)=>{proof.delivered.push({method,body});return method==='getMe'?{username:'fictional_file_fixture_bot'}:method==='sendMessage'?{message_id:proof.delivered.length,chat:{id:body.chat_id}}:true;}}));

registerCommonBrowserSdk(commonBrowserMeteredFixtureLoader);

it.each(['approve','deny','revoked'] as const)('candidate patch: actual registered-owner file delivery and %s callback preserve exact custody',async mode=>{
 commonBrowserFixture.reset();commonBrowserFixture.text='Signed in as fictional intended owner';Object.assign(proof,{inputs:[],outputs:[],delivered:[],calls:0,handle:'',fileRef:'',downloadRef:'',fileId:'',revision:0,uploads:0,closed:false,changed:false});
 const name=`file-serving-${crypto.randomUUID()}`,subject='81101',owner='10000000-0000-0000-0000-000000000001';
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
 await runInDurableObject(stub,async(_instance,state)=>{
  const mapping={owner_id:owner,environment:'staging',namespace:'fixture-owner-namespace',do_name:name,do_id:state.id.toString(),state_version:0,mapping_version:1},bodies=new Map<string,Uint8Array>(),unexpected:string[]=[];
  const fixtureEnv={...env,COMMON_OWNER_TASKS:'0',COMMON_BROWSER_REGISTRATION:undefined,WALDO_ENVIRONMENT:'staging',WALDO_OWNER_DO_NAMESPACE:mapping.namespace,WALDO_EGRESS_ALLOWLIST:'*',WALDO_TOOL_OFFLOAD:'0',LANGFUSE_CAPTURE_TEXT:'true',BROWSER:{fetch:vi.fn(async()=>new Response('{}'))} as never,RESPONSIBILITY_RATE_LIMITER:{limit:async()=>({success:true})} as never,TELEGRAM_BOT_TOKEN:'12345:fictional',TELEGRAM_WEBHOOK_SECRET:'fictional-inbox-secret',OPENAI_API_KEY:'fictional-model-key',SUPABASE_PROJECT_URL:'https://signed-metadata.invalid',SUPABASE_PUBLISHABLE_KEY:'fictional-publishable',WALDO_ROUTER_HMAC_SECRET:'fictional-router-secret',ARTIFACTS:{put:async(key:string,bytes:Uint8Array)=>{bodies.set(key,new Uint8Array(bytes));return null;},get:async(key:string)=>{const bytes=bodies.get(key);return bytes?{arrayBuffer:async()=>bytes.slice().buffer}:null;},delete:async(key:string)=>{bodies.delete(key);}} as never};
  const network=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
   const url=String(input),prefix=fixtureEnv.SUPABASE_PROJECT_URL+'/rest/v1/rpc/';if(!url.startsWith(prefix)||init?.method!=='POST'){unexpected.push(url);throw Error('unexpected live network');}
   const fn=url.slice(prefix.length),args=JSON.parse(String(init.body));let message:string,value:any;
   if(fn==='workspace_owner_binding'){expect([args.p_environment,args.p_namespace,args.p_do_name,args.p_do_id]).toEqual([mapping.environment,mapping.namespace,name,state.id.toString()]);const locator=JSON.stringify([mapping.environment,mapping.namespace,name,state.id.toString()]);expect(args.p_locator).toBe(locator);message='workspace.bind.'+await generalDigest(locator);value={...mapping};}
   else if(fn==='common_owner_authority'){const locator=JSON.stringify(['telegram',subject,name]);expect(args.p_locator).toBe(locator);message='common.owner.'+locator;value={owner_id:owner,auth_user_id:'10000000-0000-0000-0000-000000000003',presence_id:'10000000-0000-0000-0000-000000000004',provider:'telegram',subject,do_name:name,state_version:0,admission_revision:proof.changed?'2':'1'};}
   else if(fn==='assert_channel_presence'){message=`presence.${name}.telegram.${subject}`;value=true;}
   else if(fn==='health_context_read'){message=`healthctx.read.${name}`;value=null;}
   else if(fn==='health_log_recent'){message=`health.recent.${name}.${args.p_limit}`;value=[];}
   else{unexpected.push(url);throw Error('unexpected signed RPC');}
   expect(args.p_sig).toBe(await routerSignature(fixtureEnv.WALDO_ROUTER_HMAC_SECRET,args.p_at,message));return Response.json(value);
  });
  const instance=new TelegramOwnerDO(state,fixtureEnv);let update=9990000;
  const send=async(body:any,foreign=false)=>{const id=++update;const response=await instance.fetch(new Request('https://local.invalid/enqueue',{method:'POST',headers:{'x-waldo-inbox-secret':fixtureEnv.TELEGRAM_WEBHOOK_SECRET,'x-waldo-telegram-subject':foreign?'81102':subject,'x-waldo-do-name':name},body:JSON.stringify({update_id:id,...body})}));if(foreign)return response;expect(response.status).toBe(200);for(let i=0;i<8;i++){await instance.alarm();const row=state.storage.kv.get<any[]>('telegram_owner_inbox_v1')?.find(item=>item.updateId===id);if(row?.closedAt!==undefined||row?.state==='completed'||row?.state==='consumed')return response;}throw Error('owner inbox did not finish');};
  try{
   state.storage.kv.put('origin','https://local.invalid');
   await send({message:{message_id:update+1,from:{id:Number(subject),is_bot:false},chat:{id:Number(subject),type:'private'},text:'Use Cloudflare to save my fictional account CSV in my private workspace, then ask me to approve uploading that exact file.'}});proof.closed=true;
   const download=proof.outputs.find(item=>item.ok&&item.data?.download)?.data.download,proposal=proof.outputs.find(item=>item.ok&&item.data?.stopped==='approval_pending')?.data;
   expect(download).toMatchObject({filename:'report.csv',retrieval:'verified',audience:'owner_authenticated',provenance:'provider_import'});expect(proposal).toMatchObject({stopped:'approval_pending'});expect(proof.uploads).toBe(0);
   const token=await consoleAccess(state.storage).grant(),cookie=`${CONSOLE_COOKIE}=${token}`;
   expect((await instance.fetch(new Request(download.url))).status).toBe(401);
   const delivered=await instance.fetch(new Request(download.url,{headers:{cookie}}));expect(delivered.status).toBe(200);expect(new Uint8Array(await delivered.arrayBuffer())).toEqual(csv);
   const payload=JSON.parse(state.storage.sql.exec<{payload_json:string}>('SELECT payload_json FROM ledger WHERE id = ?',proposal.proposal_id).one().payload_json);expect(payload.nativeUpload.binding).toMatchObject({fileId:download.file_id,revision:download.revision,sha256:download.sha256,byteSize:download.byte_size,filename:'report.csv',destination:'https://example.com/upload'});
   const calls=proof.inputs.length,callback={callback_query:{id:'fictional-approval',from:{id:Number(subject)},data:`${mode==='deny'?'s':'a'}:${proposal.proposal_id}`,message:{message_id:1,chat:{id:Number(subject),type:'private'}}}};
   expect((await send({callback_query:{...callback.callback_query,from:{id:81102},message:{message_id:1,chat:{id:81102,type:'private'}}}},true)).status).toBe(403);expect(proof.uploads).toBe(0);
   if(mode==='revoked')proof.changed=true;
   await send(callback);expect(proof.inputs).toHaveLength(calls);expect(proof.uploads).toBe(mode==='approve'?1:0);
   expect(state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id = ?',proposal.proposal_id).one().status).toBe(mode==='approve'?'done':mode==='deny'?'skipped':'uncertain');
   await send({...callback,callback_query:{...callback.callback_query,id:'fictional-replay'}});expect(proof.uploads).toBe(mode==='approve'?1:0);
   expect(JSON.stringify(proof.inputs)).not.toContain('fixture-retained-provider');expect(JSON.stringify(proof.inputs)).not.toContain('owner,amount');expect(commonBrowserFixture.allocations).toBe(1);expect(unexpected).toEqual([]);
   await send({message:{message_id:update+1,from:{id:Number(subject),is_bot:false},chat:{id:Number(subject),type:'private'},text:'/stop'}});await vi.waitFor(()=>expect(commonBrowserFixture.ends).toBe(1));
  }finally{await state.storage.deleteAlarm();network.mockRestore();}
 });
});
