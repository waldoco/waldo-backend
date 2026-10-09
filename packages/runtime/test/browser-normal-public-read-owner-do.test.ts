import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {TelegramOwnerDO} from '../src/channels/telegram-owner-do';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
const proof=vi.hoisted(()=>({inputs:[] as any[],sent:[] as string[],calls:[] as string[]}));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000002',custodyDigest:'b'.repeat(64)})})}));
vi.mock('openai',()=>({default:class{responses={create:async(input:any)=>{
 proof.inputs.push(structuredClone(input));const format=input.text?.format?.name,outputs=(Array.isArray(input.input)?input.input:[]).filter((row:any)=>row.type==='function_call_output');
 const read=!format&&!outputs.length;
 return {id:'normal-public-fake',output:read?[{type:'function_call',call_id:'ordinary-public-read',name:'browse_page',arguments:JSON.stringify({provider:'cloudflare_playwright',url:'https://example.com/menu',instruction:'Read menu'})}]:[],output_text:format==='claim_ops'?'{}':format?'{}':read?'':'Vegetarian pasta is available.',usage:{input_tokens:1,output_tokens:1}};
}}}}));
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string,payload:any)=>{if(method==='sendMessage'){proof.sent.push(payload.text);return {message_id:proof.sent.length,chat:{id:payload.chat_id}};}return method==='getMe'?{username:'normal_public_fake_bot'}:true;}}));
let alive=false;
registerCommonBrowserSdk(async()=>({acquire:async()=>{proof.calls.push('acquire');alive=true;return {sessionId:'normal-public-session'};},connect:async()=>({newContext:async()=>({route:async()=>{},newPage:async()=>({mainFrame:()=>null,setDefaultTimeout(){},goto:async()=>({status:()=>200}),url:()=> 'https://example.com/menu',title:async()=> 'Menu',locator:()=>({innerText:async()=> 'Vegetarian pasta'})}),close:async()=>{}}),newBrowserCDPSession:async()=>({send:async()=>{proof.calls.push('close');alive=false;}}),close:async()=>{}}),sessions:async()=>alive?[{sessionId:'normal-public-session'}]:[],endpointURLString:()=>''} as never));
it.each(['absent','expired'])('ordinary two-argument ownerDO returns useful public text with %s registration and retained accounting',async kind=>{
 proof.inputs=[];proof.sent=[];proof.calls=[];alive=false;
 const doName=`normal-public-${kind}-${crypto.randomUUID()}`,subject=81102;
 const stub=env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(doName));
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Live network forbidden'));
 try{await runInDurableObject(stub,async(_instance,state)=>{
  const runtimeEnv={...env,COMMON_OWNER_TASKS:'0',WALDO_ENVIRONMENT:'staging',WALDO_EGRESS_ALLOWLIST:'*',WALDO_TOOL_OFFLOAD:'0',BROWSER:{} as never,OPENAI_API_KEY:'fictional',TELEGRAM_BOT_TOKEN:'12345:fictional',TELEGRAM_WEBHOOK_SECRET:'normal-public-fake-secret',COMMON_BROWSER_REGISTRATION:kind==='absent'?undefined:JSON.stringify({policy:{ref:'expired',doName,subject:String(subject),directoryOwnerId:'10000000-0000-0000-0000-000000000002',createdAt:1,expiresAt:2,allowedOrigins:['*'],maxAllocations:1,maxReservedBrowserMs:20000,lifetimeMs:10000,maxScreenshotBytes:1024},billing:{cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true},spend:{limitMicrousd:10000000,maxCalls:100,validUntil:2}})};
  const instance=new TelegramOwnerDO(state,runtimeEnv);
  const response=await instance.fetch(new Request('https://fixture.invalid/enqueue',{method:'POST',headers:{'content-type':'application/json','x-waldo-inbox-secret':'normal-public-fake-secret','x-waldo-telegram-subject':String(subject),'x-waldo-do-name':doName},body:JSON.stringify({update_id:81102001,message:{message_id:1,date:Math.floor(Date.now()/1000),chat:{id:subject,type:'private'},from:{id:subject,is_bot:false,first_name:'Fixture'},text:'Use Cloudflare to read the public menu.'}})}));expect(response.status).toBe(200);
  await vi.waitFor(async()=>{await instance.alarm();expect(proof.sent.some(text=>text.includes('Vegetarian pasta'))).toBe(true);},{timeout:10000,interval:50});
  const output=proof.inputs.flatMap(input=>Array.isArray(input.input)?input.input:[]).find((row:any)=>row.type==='function_call_output');
  expect(JSON.parse(output.output)).toMatchObject({ok:true,data:{provider:'cloudflare_playwright',data:{text:'Vegetarian pasta'}}});
  expect(state.storage.kv.get<any>('owner-public-browser-spend:v1')).toMatchObject({ownerId:'prn_10000000000000000000000000000002',reservedMicrousd:2090000});
  expect(state.storage.kv.get('common-public-browser-month:'+new Date().toISOString().slice(0,7))).toBe(2090000);
  expect(proof.calls).toEqual(['acquire','close']);expect(alive).toBe(false);expect(network).not.toHaveBeenCalled();await state.storage.deleteAlarm();
 });}finally{network.mockRestore();}
},20000);
