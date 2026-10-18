import {describe,it,expect,vi} from 'vitest';
import {controlAction,controlRevision,RECEIPT_BOOK_KEY,whatsappLinkReceipt} from '../src/channels/dashboard-control-actions';
import type {ConsoleView} from '../src/channels/console';
const day={version:1,view:'day',state:'available',csrf:'csrf',data:{timezone:'UTC',cards:[],proactivity:{quiet_start:null,quiet_end:null,volume:'normal'}}};
const form=(revision:string,action='timezone.set',id='request-0001')=>{const f=new FormData();for(const [k,v] of Object.entries({csrf:'csrf',revision,view:'day',request_id:id,action,value:'UTC'}))f.set(k,v);return f;};
const setup=()=>{const rows=new Map<string,unknown>();const act=vi.fn(async():Promise<boolean|string>=>true);return {act,deps:{csrf:'csrf',expires:Date.now()+43200000,sessions:async()=>[{csrf:'csrf',expires:Date.now()+43200000}],projection:async()=>day,view:async()=>({cards:[],proactivity:day.data.proactivity} as unknown as ConsoleView),act,store:{get:async<T>(k:string)=>rows.get(k) as T|undefined,put:async(k:string,v:unknown)=>{rows.set(k,v);}}}};};
describe('modern control actions',()=>{
 it('requires current session CSRF and refuses a stale read without executing',async()=>{const {act,deps}=setup();const f=form(await controlRevision(day));f.set('csrf','wrong');expect((await controlAction(f,deps)).status).toBe(403);f.set('csrf','csrf');f.set('revision','stale');expect((await controlAction(f,deps)).status).toBe(409);expect(act).not.toHaveBeenCalled();});
 it('returns the same receipt for duplicate requests without executing twice',async()=>{const {act,deps}=setup();const f=form(await controlRevision(day));const first=await controlAction(f,deps),second=await controlAction(f,deps);expect(first.status).toBe(200);expect(await second.json()).toMatchObject({duplicate:true,receipt:{state:'recorded'}});expect(act).toHaveBeenCalledTimes(1);});
 it('retains duplicate protection when the same session is renewed beyond original expiry',async()=>{const {act,deps}=setup();const original=Date.now();deps.expires=original+10;const f=form(await controlRevision(day));await controlAction(f,deps);const clock=vi.spyOn(Date,'now').mockReturnValue(original+20);try{deps.expires=original+43200000;const replay=await controlAction(f,deps);expect(await replay.json()).toMatchObject({duplicate:true});expect(act).toHaveBeenCalledTimes(1);}finally{clock.mockRestore();}});
 it('never accepts send approval, admin actions or actions from a different view',async()=>{const {act,deps}=setup();for(const action of ['approval.approve','invite.create','google.disconnect'])expect((await controlAction(form(await controlRevision(day),action,action),deps)).status).toBe(403);expect(act).not.toHaveBeenCalled();});
 it('accepts a WhatsApp link only from the connections view and returns its code receipt',async()=>{const {act,deps}=setup();const f=form(await controlRevision(day),'whatsapp.link','wa-link-0001');expect((await controlAction(f,deps)).status).toBe(403);expect(act).not.toHaveBeenCalled();f.set('view','connections');f.set('request_id','wa-link-0002');act.mockResolvedValueOnce(whatsappLinkReceipt('ABCDEFGHJK') as never);const r=await controlAction(f,deps);expect(r.status).toBe(200);expect(await r.json()).toMatchObject({receipt:{state:'recorded',message:'Send this to the Waldo WhatsApp number within 10 minutes: waldo ABCDEFGHJK'}});expect(act).toHaveBeenCalledTimes(1);});
 it('accepts a WhatsApp unlink only from the connections view and only while WhatsApp is known linked',async()=>{const {act,deps}=setup();const f=form(await controlRevision(day),'whatsapp.unlink','wa-unlink-0001');expect((await controlAction(f,deps)).status).toBe(403);f.set('view','connections');for(const [n,whatsapp] of [[2,undefined],[3,{linked:false}]] as const){f.set('request_id','wa-unlink-000'+n);deps.view=async()=>({cards:[],proactivity:day.data.proactivity,...(whatsapp?{whatsapp}:{})} as unknown as ConsoleView);const r=await controlAction(f,deps);expect(r.status).toBe(409);expect(await r.json()).toMatchObject({error:'no_longer_eligible'});}expect(act).not.toHaveBeenCalled();f.set('request_id','wa-unlink-0004');deps.view=async()=>({cards:[],proactivity:day.data.proactivity,whatsapp:{linked:true}} as unknown as ConsoleView);expect((await controlAction(f,deps)).status).toBe(200);expect(act).toHaveBeenCalledTimes(1);});
 it('rejects a WhatsApp link when no code could be issued',()=>{expect(whatsappLinkReceipt(null)).toMatchObject({state:'rejected'});expect(whatsappLinkReceipt(null).message).not.toContain('waldo ');});
 it('does not present an unknown executor outcome as recorded success',async()=>{const {act,deps}=setup();act.mockResolvedValueOnce('unknown');const result=await controlAction(form(await controlRevision(day)),deps);expect(result.status).toBe(503);expect(await result.json()).toMatchObject({receipt:{state:'unconfirmed'}});});
 it('refuses new requests at the receipt capacity without forgetting replay protection',async()=>{const {act,deps}=setup();for(let i=0;i<100;i++)await controlAction(form(await controlRevision(day),'timezone.set','request-'+String(i).padStart(4,'0')),deps);const denied=await controlAction(form(await controlRevision(day),'timezone.set','request-overflow'),deps);expect(denied.status).toBe(429);expect(act).toHaveBeenCalledTimes(100);});
 it('preserves partial results and makes uncertain exceptions explicit',async()=>{const {act,deps}=setup();act.mockRejectedValueOnce(new Error('secret'));const result=await controlAction(form(await controlRevision(day)),deps);expect(result.status).toBe(503);const body=JSON.stringify(await result.json());expect(body).toContain('unconfirmed');expect(body).not.toContain('secret');});
});

describe('approval receipts', () => {
 it('give the console notice and the app receipt fixed text, never the desk message', async () => {
  const { approvalControlReceipt } = await import('../src/channels/dashboard-control-actions');
  const outcomes = [
   { toast: 'That failed', message: "That didn't work: PROVIDER-SECRET invalid_grant for owner@example.test" },
   { toast: 'Done', message: 'Done: Run lookup on the crm MCP server. Result (external content, bounded): EXTERNAL-TOOL-OUTPUT' },
   { toast: 'Not done', message: 'PAGE-SAID: card declined' },
   { toast: 'Outcome unknown', message: 'PROVIDER-SECRET timeout' },
   { toast: 'Something new', message: 'PROVIDER-SECRET' },
  ];
  for (const out of outcomes) {
   for (const receipt of [approvalControlReceipt(out), approvalControlReceipt(out, 'rejected'), approvalControlReceipt(out, 'recorded')]) expect(receipt.message).not.toMatch(/PROVIDER-SECRET|owner@example|EXTERNAL-TOOL-OUTPUT|PAGE-SAID/);
  }
  expect(approvalControlReceipt({ toast: 'Sent', message: 'Sent: Send email to a@x.test' })).toEqual({ state: 'recorded', message: 'Sent. This cannot be undone.' });
  expect(approvalControlReceipt({ toast: 'Done', message: 'x' }, 'unconfirmed').message).toBe('The proposal outcome could not be confirmed. Check the records and chat before retrying.');
 });
});

describe('calendar approval from the dashboard', () => {
 const item=(id:string,extra:Record<string,unknown>)=>({id,kind:'calendar_change',summary:'x',state:'open' as const,undoable:false,review:{kind:'calendar_change' as const,action:'create' as const,title:'Design review',event_id:null,start:'2026-10-20T10:00:00Z',end:'2026-10-20T10:30:00Z',reason:'asked',...extra}});
 const approve=async(revision:string,id:string)=>{const f=new FormData();for(const [k,v] of Object.entries({csrf:'csrf',revision,view:'waiting',request_id:`approve-${id}`,action:'approval.approve',id}))f.set(k,v);return f;};
 it('refuses a crafted approve of an invite with guests or notes, and approves a plain change', async () => {
  const {act,deps}=setup();
  const approvals=[item('p-invite',{attendees:['sam@example.com'],send_updates:'all'}),item('p-notes',{description:'Agenda'}),item('p-plain',{})];
  deps.view=async()=>({cards:[],proactivity:day.data.proactivity,approvals} as unknown as ConsoleView);
  const revision=await controlRevision(day);
  for(const id of ['p-invite','p-notes']){const refused=await controlAction(await approve(revision,id),deps);expect(refused.status).toBe(409);expect(await refused.json()).toMatchObject({error:'no_longer_eligible'});}
  expect(act).not.toHaveBeenCalled();
  expect((await controlAction(await approve(revision,'p-plain'),deps)).status).toBe(200);
  expect(act).toHaveBeenCalledTimes(1);
 });
});

describe('views that list their own actions',()=>{
 const imessage={version:1,view:'imessage',state:'available',csrf:'csrf',data:{actions:['imessage.link'],bridges:[{id:'imb_listed',actions:['imessage.revoke','imessage.verify']}]}};
 const listedSetup=()=>{const rows=new Map<string,unknown>();const act=vi.fn(async():Promise<unknown>=>true);const view=vi.fn(async()=>({cards:[]} as unknown as ConsoleView));
  return {act,view,rows,deps:{csrf:'csrf',expires:Date.now()+43200000,sessions:async()=>[{csrf:'csrf',expires:Date.now()+43200000}],projection:async()=>imessage,view,act:act as never,store:{get:async<T>(k:string)=>rows.get(k) as T|undefined,put:async(k:string,v:unknown)=>{rows.set(k,v);}}}};};
 const post=async(fields:Record<string,string>)=>{const f=new FormData();for(const [k,v] of Object.entries({csrf:'csrf',revision:await controlRevision(imessage),view:'imessage',request_id:'listed-0001',...fields}))f.set(k,v);return f;};
 it('takes eligibility from the fresh read and never builds the console view',async()=>{
  const {act,view,deps}=listedSetup();
  expect((await controlAction(await post({action:'imessage.link'}),deps)).status).toBe(200);
  for(const [action,id] of [['imessage.pair',''],['imessage.revoke','imb_unlisted'],['imessage.link','imb_listed'],['imessage.activate','imb_listed']] as const){
   const refused=await controlAction(await post({action,id,request_id:`refused-${action.replace('.','_')}-${id||'top'}`}),deps);
   expect({action,id,status:refused.status,body:await refused.json()}).toMatchObject({action,id,status:409,body:{error:'no_longer_eligible'}});
  }
  expect((await controlAction(await post({action:'imessage.revoke',id:'imb_listed',request_id:'listed-0002'}),deps)).status).toBe(200);
  expect(act).toHaveBeenCalledTimes(2);expect(view).not.toHaveBeenCalled();
 });
 it("accepts a view's own fields only on that view and hands them to the executor",async()=>{
  const {act,deps}=listedSetup();
  expect((await controlAction(await post({action:'imessage.verify',id:'imb_listed',query_kind:'session_status'}),deps)).status).toBe(400);
  const day=form(await controlRevision({version:1,view:'day',state:'available',csrf:'csrf',data:{}}));day.set('subject','owner@example.invalid');
  expect((await controlAction(day,deps)).status).toBe(400);
  expect(act).not.toHaveBeenCalled();
  expect((await controlAction(await post({action:'imessage.verify',id:'imb_listed',subject:'owner@example.invalid',chat:'iMessage;-;owner@example.invalid'}),deps)).status).toBe(200);
  expect(act).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({action:'imessage.verify',id:'imb_listed'}),{subject:'owner@example.invalid',chat:'iMessage;-;owner@example.invalid',request_id:'listed-0001'});
 });
 it("fingerprints a view's own fields, so a reused request id with a different sender is refused",async()=>{
  const {act,deps}=listedSetup();
  const verify=(subject:string)=>post({action:'imessage.verify',id:'imb_listed',subject,chat:`iMessage;-;${subject}`});
  expect((await controlAction(await verify('a@example.invalid'),deps)).status).toBe(200);
  expect(await (await controlAction(await verify('a@example.invalid'),deps)).json()).toMatchObject({duplicate:true});
  const reused=await controlAction(await verify('b@example.invalid'),deps);
  expect(reused.status).toBe(409);expect(await reused.json()).toMatchObject({error:'request_reused'});
  expect(act).toHaveBeenCalledTimes(1);
 });
 it('returns a one-time value in that response only and never writes it to the receipt book',async()=>{
  const {act,rows,deps}=listedSetup();
  const secret='wim_'+'a1'.repeat(24);
  act.mockResolvedValueOnce({receipt:{state:'recorded',message:'Enter this code on your Mac host.'},reveal:{kind:'host_code',value:secret}});
  const first=await controlAction(await post({action:'imessage.link'}),deps);
  expect(await first.json()).toEqual({receipt:{state:'recorded',message:'Enter this code on your Mac host.'},duplicate:false,reveal:{kind:'host_code',value:secret}});
  expect(JSON.stringify([...rows.values()])).not.toContain(secret);
  const replay=await controlAction(await post({action:'imessage.link'}),deps);
  const body=await replay.json();
  expect(body).toEqual({receipt:{state:'recorded',message:'Enter this code on your Mac host.'},duplicate:true});
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(act).toHaveBeenCalledTimes(1);
 });
 it("writes receipts only to the caller's own book, which keeps its own duplicates",async()=>{
  const {act,rows,deps}=listedSetup();
  const own={...deps,book:'console:channel-control-receipts'};
  expect((await controlAction(await post({action:'imessage.link'}),own)).status).toBe(200);
  expect([...rows.keys()]).toEqual(['console:channel-control-receipts']);
  expect(await (await controlAction(await post({action:'imessage.link'}),own)).json()).toMatchObject({duplicate:true});
  expect(await (await controlAction(await post({action:'imessage.link'}),deps)).json()).toMatchObject({duplicate:false});
  expect([...rows.keys()].sort()).toEqual([RECEIPT_BOOK_KEY,'console:channel-control-receipts'].sort());
  expect(act).toHaveBeenCalledTimes(2);
 });
 it('drops a one-time value when its receipt is not recorded',async()=>{
  const {act,deps}=listedSetup();
  act.mockResolvedValueOnce({receipt:{state:'rejected',message:'Not applied.'},reveal:{kind:'host_code',value:'wim_'+'b2'.repeat(24)}});
  const refused=await controlAction(await post({action:'imessage.link'}),deps);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({receipt:{state:'rejected',message:'Not applied.'},duplicate:false});
 });
});
