// The deployed constructor must register reads from its explicit environment gate only.
import {env,runInDurableObject} from 'cloudflare:test';
import {beforeEach,expect,it,vi} from 'vitest';
import {buildSessionState} from '@waldo/contracts';
import {TelegramOwnerDO} from '../src/channels/telegram-owner-do';
import {dispatchTool} from '../src/tools/dispatcher';
import {sanitise} from '../src/scribe/sanitiser';
import type {readMcpToolHandler} from '../src/tools/live/mcp';
const captured=vi.hoisted(()=>({handlers:[] as ReturnType<typeof readMcpToolHandler>[]}));
vi.mock('../src/tools/live/mcp',async load=>{
 const actual=await load<typeof import('../src/tools/live/mcp')>();
 return {...actual,readMcpToolHandler:(...args:Parameters<typeof actual.readMcpToolHandler>)=>{const handler=actual.readMcpToolHandler(...args);captured.handlers.push(handler);return handler;}};
});
vi.mock('../src/channels/telegram-api',async load=>({...await load<typeof import('../src/channels/telegram-api')>(),createTelegramCaller:()=>async(method:string)=>method==='getMe'?{username:'fixture_bot'}:method==='sendMessage'?{message_id:1}:true}));
vi.mock('openai',()=>({default:class{responses={create:async(body:unknown)=>{
 const name=(body as {text?:{format?:{name?:string}}}).text?.format?.name;
 return {id:'fixture',output_text:name==='task_source_scope'?'{"decision":"retain","sources":[]}':name==='claim_ops'?'{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}':name==='reaction'?'{"reaction":"👌"}':'Local read-gate fixture reply.',output:[],usage:{input_tokens:1,output_tokens:1}};
}}}}));
const registry=JSON.stringify([{name:'drive',url:'https://drivemcp.googleapis.com/mcp/v1',auth:'google',requires:'drive',allow_tools:['search_files'],read_tools:['search_files']}]);
let sequence=920000;
beforeEach(()=>{captured.handlers=[];});
it.each([undefined,'0','true',' 1 ','1'])('actual deployed read registration is enabled only for MCP_READ_INTENTS=1 (%j)',async gate=>{
 const id=++sequence;const name=`owner-mcp-gate-${id}`;
 await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)),async(_instance,state)=>{
  const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('local gate proof denies network');});
  try{
   const settings={...env,TELEGRAM_BOT_TOKEN:'12345:fictional',TELEGRAM_WEBHOOK_SECRET:'fictional-inbox-secret',OPENAI_API_KEY:'fictional-model-key',WALDO_MCP_SERVERS:registry,...(gate===undefined?{}:{MCP_READ_INTENTS:gate})};
   const instance=new TelegramOwnerDO(state,settings);
   expect((await instance.fetch(new Request('https://local.invalid/enqueue',{method:'POST',headers:{'x-waldo-inbox-secret':'fictional-inbox-secret','x-waldo-telegram-subject':'81101','x-waldo-do-name':name},body:JSON.stringify({update_id:id,message:{message_id:id,from:{id:81101,is_bot:false},chat:{id:81101,type:'private'},text:'Local constructor gate proof'}})}))).status).toBe(200);
   await instance.alarm();expect(captured.handlers.length).toBeGreaterThan(0);
   const out=await dispatchTool({id:'local-read',name:'read_mcp_tool',args:{server:'drive',tool:'search_files',args:{}}},{authenticatedUserId:'owner',turnId:'local-turn',trigger:'user_message',session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise},{handlers:[captured.handlers.at(-1)!]});
   // Enabled mode reaches the real empty-grant resolution; no live credential is needed.
   expect(out).toMatchObject(gate==='1'?{ok:false,code:'auth_failed',source_taint:'external',connect:{reason:'not_connected',feature:'drive'}}:{ok:false,code:'forbidden',source_taint:'external'});
   expect(network).not.toHaveBeenCalled();
  }finally{await state.storage.deleteAlarm();network.mockRestore();}
 });
});
