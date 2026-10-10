import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { appApprovalReviewV1Schema } from '@waldo/contracts';
import { approvalDesk } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { googleClient } from '../src/connectors/google';

const account={connection_id:'selected-connection',email:'owner@example.test'};
const calendar='team@example.test';
const start='2026-10-12T10:00:00Z',end='2026-10-12T11:00:00Z';
const journey=async(name:string,work:(state:DurableObjectState)=>Promise<void>)=>{
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)),async(_instance,state)=>work(state));
};
const fixture=(state:DurableObjectState)=>{
  const event:Record<string,any>={id:'existing',summary:'Reviewed meeting',start:{dateTime:start},end:{dateTime:end},description:'Original agenda',location:'Room 1',attendees:[{email:'peer@example.test'}],etag:'v1',status:'confirmed'};
  const f={event,writes:[] as {url:URL;body:Record<string,any>;etag:string|null}[],reads:[] as URL[],cards:[] as string[],connection:account.connection_id,lose:false,readBlocked:false};
  const client=()=>googleClient({clientId:'fixture',clientSecret:'fixture',redirectUri:'https://fixture.invalid/callback'},{refresh_token:'fixture'},(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture'});
    const method=init?.method??'GET';
    if(method==='GET'){f.reads.push(url);if(f.readBlocked)throw Error('Read unavailable');return Response.json(f.event);}
    const body=JSON.parse(String(init?.body)) as Record<string,any>;const etag=new Headers(init?.headers).get('if-match');
    if(etag&&etag!==f.event.etag)return Response.json({error:{message:'changed'}},{status:412});
    f.writes.push({url,body,etag});Object.assign(f.event,body,{etag:`v${f.writes.length+1}`});
    for(const key of ['start','end'])for(const endpoint of ['date','dateTime'])if(f.event[key]?.[endpoint]===null)delete f.event[key][endpoint];
    if(f.lose)throw Error('Mutation response lost');return Response.json(f.event);
  }) as typeof fetch,undefined,{...account,connection_id:f.connection});
  let next=0;const effects=ownerEffectLedger(state.storage,()=>1000);
  const desk=()=>approvalDesk(state.storage.sql,{effects,effectOwnerRef:'physical-owner',owner:0,google:async()=>client(),call:async(_method,body)=>{f.cards.push(String((body as {text?:string}).text));return {message_id:1};},newId:()=>String(++next),now:()=>1000,timezone:'UTC',log:()=>{}});
  return {f,desk,effects};
};

describe('common approval desk selected calendar journey',()=>{
  it('reviews exact invitees/content/account and applies then undoes only on that selected calendar',async()=>journey('selected-calendar-create-undo',async state=>{
    const {f,desk}=fixture(state);const d=desk();
    const id=await d.propose({account:account.email,calendar_id:calendar,action:'create',title:'Owner meeting',start,end,attendees:['peer@example.test'],send_updates:'all',description:'Exact approved agenda',location:'Room 2',reason:'Owner asked'},'turn','owner-operation');
    const review=d.pending(1000).find(p=>p.id===id)!.review;
    expect(appApprovalReviewV1Schema.parse(review)).toMatchObject({kind:'calendar_change',calendar_id:calendar,connection_ref:account.connection_id,attendees:['peer@example.test'],send_updates:'all',description:'Exact approved agenda',location:'Room 2',proposal_digest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(f.cards[0]).toContain('Exact approved agenda');expect(f.cards[0]).toContain('peer@example.test');expect(f.writes).toHaveLength(0);
    expect((await d.decide(id,'a','app')).toast).toBe('Done');
    expect(f.writes[0]!.url.pathname).toBe('/calendar/v3/calendars/team%40example.test/events');
    expect(f.writes[0]!.url.searchParams.get('sendUpdates')).toBe('all');
    expect(f.writes[0]!.body).toMatchObject({attendees:[{email:'peer@example.test'}],description:'Exact approved agenda',location:'Room 2'});
    expect((await desk().decide(id,'u','app')).toast).toBe('Undone');
    expect(f.writes[1]!.url.pathname).toContain('/calendars/team%40example.test/events/');expect(f.writes[1]!.url.searchParams.get('sendUpdates')).toBe('all');expect(f.writes[1]!.etag).toBe('v2');
    expect(f.reads.every(url=>url.pathname.includes('/calendars/team%40example.test/'))).toBe(true);
  }));
  it('freezes source event name/version/audience, preserves body and refuses changed audience or account',async()=>journey('selected-calendar-fences',async state=>{
    const {f,desk}=fixture(state);const d=desk();
    const args={account:account.email,calendar_id:calendar,action:'move' as const,event_id:'existing',title:'Model guessed name',start:'2026-10-12T12:00:00Z',end:'2026-10-12T13:00:00Z',send_updates:'externalOnly' as const,reason:'Owner asked'};
    const id=await d.propose(args);
    expect(d.pending(1000).find(p=>p.id===id)!.review).toMatchObject({title:'Reviewed meeting',attendees:['peer@example.test'],description:'Original agenda',location:'Room 1',seen_etag:'v1'});
    f.event.attendees=[{email:'other@example.test'}];expect((await d.decide(id,'a','app')).toast).toBe('The event changed');expect(f.writes).toHaveLength(0);
    f.event.attendees=[{email:'peer@example.test'}];const second=await d.propose(args);f.connection='reconnected-other-id';
    expect((await desk().decide(second,'a','app')).toast).toBe('Google is not connected');expect(f.writes).toHaveLength(0);
  }));
  it('never applies a payload replacement and never reserves custody after revocation during asynchronous digest',async()=>journey('selected-calendar-digest-revoke',async state=>{
    const {f,desk,effects}=fixture(state);const d=desk();
    const args={account:account.email,calendar_id:calendar,action:'create' as const,title:'Approved',start,end,attendees:['peer@example.test'],send_updates:'all' as const,reason:'Owner asked'};
    const id=await d.propose(args);state.storage.sql.exec("UPDATE ledger SET payload_json=json_set(payload_json,'$.description','Unreviewed') WHERE id=?",id);
    expect((await d.decide(id,'a','app')).toast).toBe('Calendar proposal changed');expect(f.writes).toHaveLength(0);
    const second=await d.propose(args);let checks=0;await d.decide(second,'a','app',async()=>{if(++checks>=4)throw Error('revoked');});
    expect(f.writes).toHaveLength(0);expect(effects.get(`approval:${second}:apply`)).toBeNull();
  }));
  it('reopens exact selected target after response loss, accepting equivalent times but never changed body',async()=>journey('selected-calendar-loss-readback',async state=>{
    const {f,desk}=fixture(state);const d=desk();
    const id=await d.propose({account:account.email,calendar_id:calendar,action:'create',title:'Approved',start,end,attendees:['peer@example.test'],send_updates:'none',description:'Exact agenda',location:'Room 2',reason:'Owner asked'});
    f.lose=true;f.readBlocked=true;expect((await d.decide(id,'a','app')).toast).toBe('Outcome unknown');expect(f.writes).toHaveLength(1);
    f.readBlocked=false;f.event.description='Later changed body';expect((await desk().decide(id,'a','app')).toast).toBe('Outcome unknown');expect(f.writes).toHaveLength(1);
    f.event.description='Exact agenda';f.event.start.dateTime='2026-10-12T10:00:00.000+00:00';f.event.end.dateTime='2026-10-12T11:00:00.000+00:00';
    expect((await desk().decide(id,'a','app')).toast).toBe('Done');expect(f.writes).toHaveLength(1);expect(d.pending(1000).find(p=>p.id===id)?.undoable??false).toBe(false);
  }));
  it('requires explicit guest notification choice and complete reviewed audience before admission',async()=>journey('selected-calendar-no-implicit-audience',async state=>{
    const {f,desk}=fixture(state);const d=desk();
    await expect(d.propose({account:account.email,calendar_id:calendar,action:'cancel',event_id:'existing',reason:'Owner asked'})).rejects.toThrow('notification choice');
    f.event.attendeesOmitted=true;await expect(d.propose({account:account.email,calendar_id:calendar,action:'cancel',event_id:'existing',send_updates:'all',reason:'Owner asked'})).rejects.toThrow('complete');expect(f.writes).toHaveLength(0);
  }));
});
