import {env,runInDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {OwnerDO} from '../src/channels/owner-do';
import {registerCommonBrowserSdk} from '../src/channels/common-staging-registration';
import {jobBook,type TaskTicket} from '../src/tasks/jobs';
import {appSubjectFor} from '../src/channels/app-api';
const proof=vi.hoisted(()=>({calls:[] as string[]}));
// A real article's body text runs to tens of thousands of characters (the HTTP article, RFC 9110 far more).
const ARTICLE=vi.hoisted(()=>'HTTP is an application layer protocol. '+'It carries requests and responses between clients and servers. '.repeat(1_000));
const THREAD_BODY=vi.hoisted(()=>'Quarterly planning notes. '+'Each team lists its goals, owners and dates for the quarter. '.repeat(1_000));
vi.mock('../src/identity/common-owner-authority',()=>({commonOwnerAuthority:()=>({resolve:async()=>({directoryOwnerId:'10000000-0000-0000-0000-000000000003',custodyDigest:'c'.repeat(64)})})}));
vi.mock('../src/identity/owner-runtime-authority',async load=>({...await load<typeof import('../src/identity/owner-runtime-authority')>(),ownerRuntimeAuthority:()=>({resolve:async({doName}:{doName:string})=>({ownerId:'10000000-0000-0000-0000-000000000003',authenticatedUserId:'10000000-0000-0000-0000-000000000003',doName,stateVersion:1,admissionRevision:'1'})})}));
// The owner's real read_thread needs a Google connection; only its body is faked, so the call still runs through the owner's
// handler list, the task host and the dispatcher.
vi.mock('../src/tools/live/google',async load=>{
 const real=await load<typeof import('../src/tools/live/google')>();
 return {...real,googleHandlers:((...args:Parameters<typeof real.googleHandlers>)=>real.googleHandlers(...args).map(handler=>handler.name!=='read_thread'?handler:{...handler,eligible:()=>({ok:true as const}),
  handle:async()=>({ok:true as const,data:{thread_id:'t-1',cursor:null,messages:[{from:'colleague@example.com',subject:'Planning',body:THREAD_BODY}]},source_taint:'external' as const})})) as typeof real.googleHandlers};
});
let alive=false;
registerCommonBrowserSdk(async()=>({acquire:async()=>{proof.calls.push('acquire');alive=true;return {sessionId:'task-read-session'};},connect:async()=>({newContext:async()=>({serviceWorkers:()=>[],addInitScript:async()=>{},routeWebSocket:async()=>{},route:async()=>{},newPage:async()=>({mainFrame:()=>null,setDefaultTimeout(){},on(){},waitForLoadState:async()=>{},evaluate:async()=>{},goto:async()=>({status:()=>200}),url:()=> 'https://en.wikipedia.org/wiki/HTTP',title:async()=> 'HTTP',locator:()=>({innerText:async()=> ARTICLE})}),close:async()=>{}}),newBrowserCDPSession:async()=>({send:async()=>{proof.calls.push('close');alive=false;}}),close:async()=>{}}),sessions:async()=>alive?[{sessionId:'task-read-session'}]:[],endpointURLString:()=>''} as never));

const CANARIES=['0123456789abcdef','fedcba9876543210','00112233aabbccdd'];
type Host={taskClaim(t:TaskTicket):Promise<any>;taskTool(t:TaskTicket,c:unknown,k:string[]):Promise<any>};
// The real OwnerDO task host for one owner, with the Cloudflare browser SDK faked and no live network.
const withOwner=async(surface:'telegram'|'app',work:(host:Host,state:DurableObjectState,job:(key:string)=>TaskTicket)=>Promise<void>)=>{
 proof.calls=[];alive=false;
 const doName=`task-browse-${crypto.randomUUID()}`;
 const stub=env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName));
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Live network forbidden'));
 try{await runInDurableObject(stub,async(_instance,state)=>{
  await state.storage.put(surface==='app'?{app_subject:String(appSubjectFor(doName)),do_name:doName,origin:'https://fixture.invalid'}:{telegram_subject:'81103',do_name:doName,origin:'https://fixture.invalid'});
  const runtimeEnv={...env,COMMON_OWNER_TASKS:'0',WALDO_ENVIRONMENT:'staging',WALDO_EGRESS_ALLOWLIST:'*',BROWSER:{} as never,OPENAI_API_KEY:'fictional',TELEGRAM_BOT_TOKEN:'12345:fictional',TELEGRAM_WEBHOOK_SECRET:'task-browse-secret'};
  const host=new OwnerDO(state,runtimeEnv) as unknown as Host;
  const book=jobBook(state.storage.sql,{now:Date.now,newId:()=>crypto.randomUUID().replaceAll('-','').slice(0,12),newToken:()=>crypto.randomUUID()});
  const job=(key:string)=>{
   const {job:row}=book.create({kind:'task',profile:'reader',idempotencyKey:key,origin:`turn:${key}`,surface,brief:{title:'HTTP',goal:'Read the HTTP article.',context:'',done_when:'A summary.',started_at:Date.now(),timezone:'UTC'} as never,dueAt:Date.now(),deadlineAt:Date.now()+3_600_000});
   return book.startAttempt(row.id)!;
  };
  await work(host,state,job);
  // The owner object may plan its day cards with the model in the background (refused here); no read reaches the network.
  expect(network.mock.calls.map(([url])=>String(url)).filter(url=>!url.startsWith('https://api.openai.com/'))).toEqual([]);await state.storage.deleteAlarm();
 });}finally{network.mockRestore();}
};
const call=(name:string,args:unknown,id=`call-${name}`)=>({call_id:id,name,arguments:JSON.stringify(args)});
const browse=call('browse_page',{url:'https://en.wikipedia.org/wiki/HTTP',instruction:'Summarise the article'});
const taintOf=(state:DurableObjectState,id:string)=>state.storage.sql.exec<{taint:string|null}>('SELECT taint FROM task_jobs WHERE id = ?',id).one().taint;

// A worker's large read is stored for its own attempt and paged back with read_tool_output, the way an owner turn's is.
it.each(['telegram','app'] as const)('a reader task worker started on %s reads a real-size page: browse_page gives a stored handle it pages through',async surface=>{
 await withOwner(surface,async(host,_state,job)=>{
  const ticket=job('browse-1');
  const claim=await host.taskClaim(ticket);
  const offered=(claim.tools as {name:string}[]).map(tool=>tool.name);
  expect(offered).toEqual(expect.arrayContaining(['browse_page','read_tool_output']));
  const read=await host.taskTool(ticket,browse,CANARIES);
  expect(read).toMatchObject({ok:true,source_taint:'external',data:{stored_output:expect.any(String),read_with:'read_tool_output'}});
  expect(read.data.head).toContain('HTTP is an application layer protocol.');
  expect(proof.calls).toEqual(['acquire','close']);
  const page=await host.taskTool(ticket,call('read_tool_output',{id:read.data.stored_output,offset:4_000,length:8_000}),CANARIES);
  expect(page).toMatchObject({ok:true,source_taint:'external',data:{next_offset:12_000}});
  expect(page.data.text).toContain('It carries requests and responses');
 });
},20000);

it('an oversize mail thread read by a reader task worker is stored and paged the same way',async()=>{
 await withOwner('telegram',async(host,_state,job)=>{
  const ticket=job('thread-1');
  expect(await host.taskClaim(ticket)).not.toBe('fenced');
  const read=await host.taskTool(ticket,call('read_thread',{thread_id:'t-1'}),CANARIES);
  expect(read).toMatchObject({ok:true,source_taint:'external',data:{stored_output:expect.any(String)}});
  const page=await host.taskTool(ticket,call('read_tool_output',{id:read.data.stored_output,offset:8_000}),CANARIES);
  expect(page).toMatchObject({ok:true,data:{text:expect.stringContaining('Each team lists its goals')}});
 });
},20000);

// A worker resolves only handles its own attempt stored: never an owner turn's to-N output, another job's, or an earlier
// attempt's of the same job.
it('a worker cannot read a stored output it did not create in the same job and attempt',async()=>{
 await withOwner('telegram',async(host,state,job)=>{
  const first=job('own-1'),second=job('own-2');
  await host.taskClaim(first);await host.taskClaim(second);
  const stored=(await host.taskTool(first,browse,CANARIES)).data.stored_output as string;
  expect((await host.taskTool(second,call('read_thread',{thread_id:'t-1'}),CANARIES)).ok).toBe(true);
  const refused=async(ticket:TaskTicket,id:string)=>{
   const result=await host.taskTool(ticket,call('read_tool_output',{id},`read-${id}`),CANARIES);
   expect(result,id).toMatchObject({ok:false,error_code:'not_found'});
   expect(JSON.stringify(result)).not.toContain('application layer');
   expect(JSON.stringify(result)).not.toContain('Each team lists');
  };
  // The owner turn's ledger and in-memory store name their outputs to-1, to-2, ...
  for (const id of ['to-1','to-2']) await refused(second,id);
  await refused(second,stored);
  // The same job's next attempt starts with an empty store.
  state.storage.sql.exec("UPDATE task_jobs SET status = 'queued', lease_token = NULL WHERE id = ?",first.jobId);
  const next=jobBook(state.storage.sql,{now:Date.now,newId:()=>'unused',newToken:()=>crypto.randomUUID()}).startAttempt(first.jobId)!;
  expect(next.attempt).toBe(2);
  await host.taskClaim(next);
  await refused(next,stored);
 });
},20000);

// Storing an output must not launder its origin: the read-back alone marks the job external, so its report turn gets the
// outside-text tool set.
it('a job whose only outside read came back through read_tool_output is marked external',async()=>{
 await withOwner('telegram',async(host,state,job)=>{
  const ticket=job('taint-1');
  await host.taskClaim(ticket);
  const stored=(await host.taskTool(ticket,browse,CANARIES)).data.stored_output as string;
  expect(taintOf(state,ticket.jobId)).toBe('external');
  state.storage.sql.exec('UPDATE task_jobs SET taint = NULL WHERE id = ?',ticket.jobId);
  expect((await host.taskTool(ticket,call('read_tool_output',{id:stored}),CANARIES)).ok).toBe(true);
  expect(taintOf(state,ticket.jobId)).toBe('external');
 });
},20000);
