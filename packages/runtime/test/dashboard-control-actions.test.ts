import {describe,it,expect,vi} from 'vitest';
import {controlAction,controlRevision} from '../src/channels/dashboard-control-actions';
import type {ConsoleView} from '../src/channels/console';
const day={version:1,view:'day',state:'available',csrf:'csrf',data:{timezone:'UTC',cards:[],proactivity:{quiet_start:null,quiet_end:null,volume:'normal'}}};
const form=(revision:string,action='timezone.set',id='request-0001')=>{const f=new FormData();for(const [k,v] of Object.entries({csrf:'csrf',revision,view:'day',request_id:id,action,value:'UTC'}))f.set(k,v);return f;};
const setup=()=>{const rows=new Map<string,unknown>();const act=vi.fn(async():Promise<boolean|string>=>true);return {act,deps:{csrf:'csrf',expires:Date.now()+43200000,sessions:async()=>[{csrf:'csrf',expires:Date.now()+43200000}],projection:async()=>day,view:async()=>({cards:[],proactivity:day.data.proactivity} as unknown as ConsoleView),act,store:{get:async<T>(k:string)=>rows.get(k) as T|undefined,put:async(k:string,v:unknown)=>{rows.set(k,v);}}}};};
describe('modern control actions',()=>{
 it('requires current session CSRF and refuses a stale read without executing',async()=>{const {act,deps}=setup();const f=form(await controlRevision(day));f.set('csrf','wrong');expect((await controlAction(f,deps)).status).toBe(403);f.set('csrf','csrf');f.set('revision','stale');expect((await controlAction(f,deps)).status).toBe(409);expect(act).not.toHaveBeenCalled();});
 it('returns the same receipt for duplicate requests without executing twice',async()=>{const {act,deps}=setup();const f=form(await controlRevision(day));const first=await controlAction(f,deps),second=await controlAction(f,deps);expect(first.status).toBe(200);expect(await second.json()).toMatchObject({duplicate:true,receipt:{state:'recorded'}});expect(act).toHaveBeenCalledTimes(1);});
 it('retains duplicate protection when the same session is renewed beyond original expiry',async()=>{const {act,deps}=setup();const original=Date.now();deps.expires=original+10;const f=form(await controlRevision(day));await controlAction(f,deps);const clock=vi.spyOn(Date,'now').mockReturnValue(original+20);try{deps.expires=original+43200000;const replay=await controlAction(f,deps);expect(await replay.json()).toMatchObject({duplicate:true});expect(act).toHaveBeenCalledTimes(1);}finally{clock.mockRestore();}});
 it('never accepts send approval, admin actions or actions from a different view',async()=>{const {act,deps}=setup();for(const action of ['approval.approve','invite.create','google.disconnect'])expect((await controlAction(form(await controlRevision(day),action,action),deps)).status).toBe(403);expect(act).not.toHaveBeenCalled();});
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
