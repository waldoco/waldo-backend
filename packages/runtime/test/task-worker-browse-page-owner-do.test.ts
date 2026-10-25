import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {OwnerDO} from '../src/channels/owner-do';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
import {jobBook} from '../src/tasks/jobs';
import {appSubjectFor} from '../src/channels/app-api';
const proof=vi.hoisted(()=>({calls:[] as string[]}));
// A real article's body text runs to tens of thousands of characters (the HTTP article, RFC 9110 far more).
const ARTICLE='HTTP is an application layer protocol. '+'It carries requests and responses between clients and servers. '.repeat(1_000);
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000003',custodyDigest:'c'.repeat(64)})})}));
vi.mock('../src/identity/owner-runtime-authority',async load=>({...await load<typeof import('../src/identity/owner-runtime-authority')>(),ownerRuntimeAuthority:()=>({resolve:async({doName}:{doName:string})=>({ownerId:'10000000-0000-0000-0000-000000000003',authenticatedUserId:'10000000-0000-0000-0000-000000000003',doName,stateVersion:1,admissionRevision:'1'})})}));
let alive=false;
registerCommonBrowserSdk(async()=>({acquire:async()=>{proof.calls.push('acquire');alive=true;return {sessionId:'task-read-session'};},connect:async()=>({newContext:async()=>({serviceWorkers:()=>[],addInitScript:async()=>{},routeWebSocket:async()=>{},route:async()=>{},newPage:async()=>({mainFrame:()=>null,setDefaultTimeout(){},on(){},waitForLoadState:async()=>{},evaluate:async()=>{},goto:async()=>({status:()=>200}),url:()=> 'https://en.wikipedia.org/wiki/HTTP',title:async()=> 'HTTP',locator:()=>({innerText:async()=> ARTICLE})}),close:async()=>{}}),newBrowserCDPSession:async()=>({send:async()=>{proof.calls.push('close');alive=false;}}),close:async()=>{}}),sessions:async()=>alive?[{sessionId:'task-read-session'}]:[],endpointURLString:()=>''} as never));

// A reader task's worker reads a public page through the owner's Cloudflare browser, the way an owner turn does: the call
// goes through the real OwnerDO task host (profile allowlist, hooks, serial browser lane) with only the provider SDK faked.
it.each(['telegram','app'])('a reader task worker started on %s can read a public page with browse_page through the owner host',async surface=>{
 proof.calls=[];alive=false;
 const doName=`task-browse-${crypto.randomUUID()}`,subject=81103;
 const stub=env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName));
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Live network forbidden'));
 try{await runInDurableObject(stub,async(_instance,state)=>{
  await state.storage.put(surface==='app'?{app_subject:String(appSubjectFor(doName)),do_name:doName,origin:'https://fixture.invalid'}:{telegram_subject:String(subject),do_name:doName,origin:'https://fixture.invalid'});
  const runtimeEnv={...env,COMMON_OWNER_TASKS:'0',WALDO_ENVIRONMENT:'staging',WALDO_EGRESS_ALLOWLIST:'*',BROWSER:{} as never,OPENAI_API_KEY:'fictional',TELEGRAM_BOT_TOKEN:'12345:fictional',TELEGRAM_WEBHOOK_SECRET:'task-browse-secret'};
  const instance=new OwnerDO(state,runtimeEnv) as unknown as {taskClaim(t:unknown):Promise<any>;taskTool(t:unknown,c:unknown,k:string[]):Promise<any>};
  const book=jobBook(state.storage.sql,{now:Date.now,newId:()=>crypto.randomUUID().replaceAll('-','').slice(0,12),newToken:()=>crypto.randomUUID()});
  const {job}=book.create({kind:'task',profile:'reader',idempotencyKey:'browse-1',origin:'turn:1',surface,brief:{title:'HTTP',goal:'Read the HTTP article.',context:'',done_when:'A summary.',started_at:Date.now(),timezone:'UTC'} as never,dueAt:Date.now(),deadlineAt:Date.now()+3_600_000});
  const ticket=book.startAttempt(job.id)!;
  const claim=await instance.taskClaim(ticket);
  expect(claim).not.toBe('fenced');
  const offered=(claim.tools as {name:string}[]).map(tool=>tool.name);
  console.log('offered tools',JSON.stringify(offered));
  expect(offered).toContain('browse_page');
  const result=await instance.taskTool(ticket,{call_id:'call-browse',name:'browse_page',arguments:JSON.stringify({url:'https://en.wikipedia.org/wiki/HTTP',instruction:'Summarise the article'})},['0123456789abcdef','fedcba9876543210','00112233aabbccdd']);
  console.log('browse_page result',JSON.stringify({ok:result.ok,code:result.code,error_code:result.error_code,error:result.error,fix:result.fix}));
  expect(result).toMatchObject({ok:true});
  expect(JSON.stringify(result)).toContain('HTTP is an application layer protocol.');
  expect(proof.calls).toEqual(['acquire','close']);expect(network).not.toHaveBeenCalled();await state.storage.deleteAlarm();
 });}finally{network.mockRestore();}
},20000);
