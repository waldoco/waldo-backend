import { iso8601Schema } from '@waldo/contracts';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { googleClient, type GoogleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';
import { commonOwnerTools } from '../src/channels/common-owner-tool-policy';

const account={connection_id:'fixture-calendar',email:'owner@example.test'};
const storage=()=>{const db=new DatabaseSync(':memory:');return {exec(q:string,...args:any[]){const s=db.prepare(q);const rows=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>rows,one:()=>rows[0],[Symbol.iterator]:()=>rows[Symbol.iterator]()};}} as unknown as SqlStorage;};
const proposal={action:'create' as const,title:'Walk',start:iso8601Schema.parse('2030-01-01T12:00:00Z'),end:iso8601Schema.parse('2030-01-01T13:00:00Z'),reason:'Make time',connection_id:account.connection_id};

it('registered calendar proposal approves once and confirms provider readback before the channel receipt',async()=>{
 let event:any;let writes=0;let reads=0;
 const messages:string[]=[];
 const client=googleClient({clientId:'fixture',clientSecret:'fixture',redirectUri:''},{refresh_token:'fixture'},async(url,init)=>{
  if(String(url).includes('oauth2'))return Response.json({access_token:'fixture'});
  if(init?.method==='POST'){writes++;event={...JSON.parse(String(init.body)),id:JSON.parse(String(init.body)).id??'provider-event',etag:'v1'};return Response.json(event);}
  reads++;return Response.json(event);
 },undefined,account);
 const sql=storage();const deps={owner:42,call:async(method:string,body:object)=>{if(method==='sendMessage')messages.push((body as {text:string}).text);return {};},google:async()=>client,newId:()=> 'calendar',now:()=>1000,timezone:'UTC',log:()=>{}};
 const desk=approvalDesk(sql,deps);const tools=googleHandlers({client:async()=>client},desk,{timezone:'UTC',now:()=>new Date(1000)});
 expect(commonOwnerTools({googleConnected:true,driveReads:false,publicSearch:false,browser:false})).toContain('propose_calendar_change');
 const result=await tools.find(t=>t.name==='propose_calendar_change')!.handle(proposal as never);
 expect(result).toMatchObject({ok:true,data:{applied:false}});expect(writes).toBe(0);
 await Promise.all([desk.callback({id:'tap1',from:{id:42},data:'a:pcalendar'},'t'),desk.callback({id:'tap2',from:{id:42},data:'a:pcalendar'},'t')]);
 expect(writes).toBe(1);expect(reads).toBeGreaterThan(0);expect(messages.some(m=>m.startsWith('Done:'))).toBe(true);
 const reopened=approvalDesk(sql,deps);await reopened.decide('pcalendar','a','restart');expect(writes).toBe(1);
});

const fixture=()=>{
 let current:any={id:'existing',summary:'Walk',start:{dateTime:'2030-01-01T10:00:00Z'},end:{dateTime:'2030-01-01T11:00:00Z'},etag:'v1'};
 let writes=0,versions=1,failAfterWrite=false,failRead=false,failReceipt=false,race=false,wrongAck=false,readMismatch=false;
 let selected:GoogleClient|null;
 let receiptGate:Promise<void>|null=null,receiptEntered:(()=>void)|null=null;
 const calls:{url:string;method:string;match:unknown;body:any}[]=[],messages:string[]=[];
 const client=googleClient({clientId:'fixture',clientSecret:'fixture',redirectUri:''},{refresh_token:'fixture'},async(url,init)=>{
  if(String(url).includes('oauth2'))return Response.json({access_token:'fixture'});
  const method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;
  calls.push({url:String(url),method,match:(init?.headers as any)?.['if-match'],body});
  if(method==='GET'){
   if(failRead)throw new Error('read outage');
   if(!current)return Response.json({error:{message:'deleted'}},{status:410});
   return Response.json(readMismatch?{...current,extendedProperties:{private:{waldoApproval:'different'}}}:current);
  }
  if(race){current={...current,summary:'Owner edit',etag:'later'};race=false;}
  if(method!=='POST'&&(init?.headers as any)?.['if-match']!==current.etag)return Response.json({error:{message:'changed'}},{status:412});
  if(body?.start)for(const field of ['start','end'])for(const key of Object.keys(body[field]))if(body[field][key]===null)delete body[field][key];
  writes++;if(method==='DELETE')current=null;else current={...(method==='PATCH'?current:{}),...body,etag:`v${++versions}`};
  if(failAfterWrite)throw new Error('response lost');
  if(method==='DELETE')return new Response(null,{status:204});
  return Response.json(wrongAck?{...current,id:'wrong-event'}:current);
 },undefined,account);
 selected=client;
 const sql=storage();let n=0,now=1000;
 const deps={owner:42,call:async(method:string,body:object)=>{if(method==='sendMessage'){messages.push((body as {text:string}).text);if(receiptGate&&messages.at(-1)!.startsWith('Done:')){receiptEntered?.();await receiptGate;}if(failReceipt&&messages.at(-1)!.startsWith('Done:'))throw new Error('channel outage');}return {};},google:async(_intent:any,_feature:any,connectionId?:string)=>{if(connectionId&&selected?.account?.connection_id!==connectionId)throw new Error('selected account unavailable');return selected;},newId:()=>String(++n),now:()=>now,timezone:'UTC',log:()=>{}};
 const desk=()=>approvalDesk(sql,deps);
 return {sql,desk,client,calls,messages,writes:()=>writes,current:()=>current,select:(c:GoogleClient|null)=>{selected=c;},holdReceipt:()=>{let release!:()=>void;const entered=new Promise<void>(r=>{receiptEntered=r;});receiptGate=new Promise<void>(r=>{release=r;});return {entered,release};},advance:()=>{now+=600001;},allDay:()=>{current={...current,start:{date:'2030-01-01'},end:{date:'2030-01-02'}};},edit:()=>{current={...current,summary:'Owner edit',etag:'owner-edited'};},lose:()=>{failAfterWrite=true;},readOutage:(v:boolean)=>{failRead=v;},receiptOutage:(v:boolean)=>{failReceipt=v;},race:()=>{race=true;},wrongAck:()=>{wrongAck=true;},mismatch:(v:boolean)=>{readMismatch=v;}};
};
it.each(['create','move','cancel'] as const)('reconciles a lost %s response after restart without repeating the mutation',async(action)=>{
 const f=fixture(),d=f.desk();const id=await d.propose({...proposal,action,...(action!=='create'?{event_id:'existing'}:{})});
 f.lose();expect((await d.decide(id,'a','t')).toast).toBe('Outcome unknown');expect(f.writes()).toBe(1);
 await f.desk().reconcileCalendar();expect(f.writes()).toBe(1);expect(f.desk().ledger([])).toContain('- done:');
 expect(f.messages.some(m=>m.startsWith('Done:'))).toBe(true);await f.desk().reconcileCalendar();expect(f.writes()).toBe(1);
});
it('readback outage remains unknown and recovers a channel receipt without a second provider mutation',async()=>{
 const f=fixture(),d=f.desk(),id=await d.propose(proposal);f.readOutage(true);
 expect((await d.decide(id,'a','t')).toast).toBe('Outcome unknown');expect(f.writes()).toBe(1);
 await f.desk().reconcileCalendar();expect(f.desk().ledger([])).toContain('outcome unknown');
 f.readOutage(false);f.receiptOutage(true);await f.desk().reconcileCalendar();expect(f.desk().ledger([])).toContain('- done:');
 f.receiptOutage(false);await f.desk().reconcileCalendar();expect(f.writes()).toBe(1);
 const before=f.messages.length;await f.desk().reconcileCalendar();expect(f.messages).toHaveLength(before);
});
it('a wrong acknowledgement or mismatched readback cannot produce a success receipt',async()=>{
 const f=fixture(),id=await f.desk().propose(proposal);f.wrongAck();f.mismatch(true);
 expect((await f.desk().decide(id,'a','t')).toast).toBe('Outcome unknown');await f.desk().reconcileCalendar();
 expect(f.messages.some(m=>m.startsWith('Done:'))).toBe(false);expect(f.writes()).toBe(1);
});
it('frozen account survives disconnect and never executes against the replacement account',async()=>{
 const f=fixture(),id=await f.desk().propose(proposal);f.select({...f.client,account:{connection_id:'other',email:'other@example.test'}});
 expect((await f.desk().decide(id,'a','t')).toast).toBe('Calendar unavailable');expect(f.writes()).toBe(0);
});
it('recovery never switches accounts after a lost write',async()=>{
 const f=fixture(),id=await f.desk().propose(proposal);f.lose();await f.desk().decide(id,'a','t');
 f.select({...f.client,account:{connection_id:'other',email:'other@example.test'}});await f.desk().reconcileCalendar();
 expect(f.writes()).toBe(1);expect(f.desk().ledger([])).toContain('outcome unknown');expect(f.messages.some(m=>m.startsWith('Done:'))).toBe(false);
});
it('a changed reviewed payload is rejected without provider mutation',async()=>{
 const f=fixture(),id=await f.desk().propose(proposal);
 const entry=f.sql.exec<{payload_json:string}>('SELECT payload_json FROM ledger WHERE id = ?',id).one();const p=JSON.parse(entry.payload_json);p.title='Different';f.sql.exec('UPDATE ledger SET payload_json = ? WHERE id = ?',JSON.stringify(p),id);
 expect((await f.desk().decide(id,'a','t')).toast).toBe('Review changed');expect(f.writes()).toBe(0);
});
it.each(['create','move'] as const)('later edits protect %s Undo while unchanged Undo has conditional readback',async(action)=>{
 const f=fixture(),id=await f.desk().propose({...proposal,action,...(action==='move'?{event_id:'existing'}:{})});
 expect((await f.desk().decide(id,'a','t')).toast).toBe('Done');f.edit();
 expect((await f.desk().decide(id,'u','t')).toast).toBe('The event changed');expect(f.writes()).toBe(1);expect(f.current().summary).toBe('Owner edit');
 const g=fixture(),gid=await g.desk().propose({...proposal,action,...(action==='move'?{event_id:'existing'}:{})});await g.desk().decide(gid,'a','t');
 expect((await g.desk().decide(gid,'u','t')).toast).toBe('Undone');expect(g.calls.filter(c=>c.method!=='GET').at(-1)!.match).toBe('v2');expect(g.writes()).toBe(2);
});
it.each(['create','move'] as const)('owner edit racing %s Undo is protected by If-Match',async(action)=>{
 const f=fixture(),id=await f.desk().propose({...proposal,action,...(action==='move'?{event_id:'existing'}:{})});await f.desk().decide(id,'a','t');f.race();
 expect((await f.desk().decide(id,'u','t')).toast).toBe('The event changed');expect(f.writes()).toBe(1);expect(f.current().summary).toBe('Owner edit');
});
it('expired Undo cannot become fresh through late receipt recovery',async()=>{
 const f=fixture(),id=await f.desk().propose(proposal);await f.desk().decide(id,'a','t');f.advance();await f.desk().reconcileCalendar();
 expect((await f.desk().decide(id,'u','t')).toast).toBe('Too late to undo');expect(f.writes()).toBe(1);
});
it.each(['create','move'] as const)('reconciles lost %s Undo without a second reversal',async action=>{
 const f=fixture(),id=await f.desk().propose({...proposal,action,...(action==='move'?{event_id:'existing'}:{})});await f.desk().decide(id,'a','t');f.lose();
 expect((await f.desk().decide(id,'u','t')).toast).toBe('Outcome unknown');expect(f.writes()).toBe(2);
 await f.desk().reconcileCalendar();expect(f.writes()).toBe(2);expect(f.desk().ledger([])).toContain('- undone:');
});
it('a bounded recovery pass rotates past unavailable rows and retains uncertainty outside recent history',async()=>{
 const f=fixture();f.lose();
 for(let i=0;i<10;i++){const d=f.desk(),id=await d.propose(proposal);await d.decide(id,'a','t');}
 // Only the most recent created resource exists in this fixture. Nine older rows remain uncertain.
 await f.desk().reconcileCalendar();expect(f.messages.some(m=>m.startsWith('Done:'))).toBe(false);
 await f.desk().reconcileCalendar();expect(f.messages.some(m=>m.startsWith('Done:'))).toBe(true);expect(f.writes()).toBe(10);
 expect(f.desk().ledger([])).toContain('outcome unknown');
});
it('Undo restores an original all-day interval with date endpoints rather than invalid dateTime values',async()=>{
 const f=fixture();f.allDay();const id=await f.desk().propose({...proposal,action:'move',event_id:'existing'});
 expect((await f.desk().decide(id,'a','t')).toast).toBe('Done');expect((await f.desk().decide(id,'u','t')).toast).toBe('Undone');
 expect(f.current().start).toEqual({date:'2030-01-01'});expect(f.current().end).toEqual({date:'2030-01-02'});expect(f.writes()).toBe(2);
});
it.each(['recovery','callback'] as const)('a delayed %s apply receipt cannot overwrite a lost Undo operation',async origin=>{
 const f=fixture(),d=f.desk(),id=await d.propose(proposal),gate=f.holdReceipt();
 if(origin==='recovery')await d.decide(id,'a','t');
 const delivery=origin==='recovery'?d.reconcileCalendar():d.callback({id:'apply',from:{id:42},data:`a:${id}`},'t');
 await gate.entered;f.lose();expect((await f.desk().decide(id,'u','t')).toast).toBe('Outcome unknown');expect(f.writes()).toBe(2);
 gate.release();await delivery;
 const operation=()=>JSON.parse(f.sql.exec<{undo_json:string}>('SELECT undo_json FROM ledger WHERE id = ?',id).one().undo_json);
 expect(operation()).toMatchObject({phase:'undo'});expect(operation().delivered_at).toBeUndefined();
 await f.desk().reconcileCalendar();expect(f.writes()).toBe(2);expect(f.desk().ledger([])).toContain('- undone:');
 expect(f.messages.filter(m=>m.startsWith('Done:'))).toHaveLength(1);expect(f.messages.filter(m=>m.startsWith('Undone:'))).toHaveLength(1);
});
