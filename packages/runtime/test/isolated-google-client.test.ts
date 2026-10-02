import { describe, expect, it } from 'vitest';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import { isolatedCalendarEffectClient, isolatedGoogleClient } from '../scenarios/isolated-google-client';

const fixture = () => new IsolatedSourceWorld({
  clock: '2026-10-06T09:00:00Z', owners: [{ id: 'a' }, { id: 'b' }],
  sources: {
    mail: [
      { owner_id: 'a', id: 'm1', thread_id: 'shared', from: 'sender@example.invalid', subject: 'Alpha', snippet: 'first', body: 'alpha only', at: '2026-10-06T08:00:00Z' },
      { owner_id: 'b', id: 'm1', thread_id: 'shared', from: 'sender@example.invalid', subject: 'Beta', snippet: 'second', body: 'beta only', at: '2026-10-06T08:00:00Z' },
    ],
    calendar: [
      { owner_id: 'a', id: 'event', title: 'Alpha', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z', all_day: false },
      { owner_id: 'b', id: 'event', title: 'Beta', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z', all_day: false },
    ],
    tasks: [{ owner_id: 'a', id: 'task', title: 'Alpha task', status: 'todo' }],
  },
  revisions: [{ at: '2026-10-06T10:30:00Z', owner_id: 'a', source: 'mail', id: 'm1', patch: { snippet: 'revised' } }],
});

describe('isolated Google source adapter', () => {
  it('keeps same provider IDs scoped to owner and reflects revisions', async () => {
    const world = fixture(); const a = isolatedGoogleClient(world, 'a'); const b = isolatedGoogleClient(world, 'b');
    expect((await a.readThread('shared', 5))[0]?.body).toBe('alpha only');
    expect((await b.readThread('shared', 5))[0]?.body).toBe('beta only');
    expect((await a.events('2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z', 5, false))[0]?.title).toBe('Alpha');
    expect((await b.events('2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z', 5, false))[0]?.title).toBe('Beta');
    expect(await b.tasks('all', 5)).toEqual([]);
    world.advance('2026-10-06T11:00:00Z');
    expect((await a.newMail(Date.parse('2026-10-06T00:00:00Z'), 5))[0]?.snippet).toBe('revised');
    expect((await b.newMail(Date.parse('2026-10-06T00:00:00Z'), 5))[0]?.snippet).toBe('second');
  });
  it('fails closed on effects and unsupported reads', async () => {
    const a = isolatedGoogleClient(fixture(), 'a');
    await expect(a.sendRaw('payload')).rejects.toThrow(/intercepted approval/);
    await expect(a.draft({ to: ['x@example.invalid'], subject: 'x', body: 'x' })).rejects.toThrow(/intercepted approval/);
    await expect(a.searchMail('x', 5)).rejects.toThrow(/not implemented/);
  });
  it('assigns unique provider records across fresh adapter instances in one owner world', async () => {
    const world = fixture();
    const first = await isolatedCalendarEffectClient(world, 'a').createEvent({ title: 'First', start: '2026-10-06T11:00:00Z', end: '2026-10-06T11:30:00Z' });
    const second = await isolatedCalendarEffectClient(world, 'a').createEvent({ title: 'Second', start: '2026-10-06T12:00:00Z', end: '2026-10-06T12:30:00Z' });
    expect(first.id).not.toBe(second.id);
    expect(world.providerCalendarReadback('a').map((row) => row.title)).toEqual(['First', 'Second']);
    expect(world.providerCalendarReadback('b')).toEqual([]);
    expect(world.outbox('a')).toHaveLength(2);
  });
});

describe('isolated Gmail pages',()=>{
 const query='in:inbox category:primary after:1791244799 before:1791331200';
 it('maps the actual handler page path and preserves owner isolation/metadata only',async()=>{
  const w=fixture();const a=isolatedGoogleClient(w,'a');const page=await a.mailPage(query,1);
  expect(page.messages).toEqual([{id:'m1',thread_id:'shared',from:'sender@example.invalid',subject:'Alpha',snippet:'first',at:'2026-10-06T08:00:00Z'}]);expect(page.next_page_token).toBeNull();expect(page.result_size_estimate).toBe(1);expect(w.accessLog('b')).toEqual([]);
 });
 it('paginates selected owner rows, checks query/limit/owner and rejects malformed or mismatched cursors',async()=>{
  const w=new IsolatedSourceWorld({clock:'2026-10-06T09:00:00Z',owners:[{id:'a'},{id:'b'}],sources:{mail:[1,2,3].map(i=>({owner_id:'a',id:`m${i}`,thread_id:'t',from:'a@example.invalid',subject:`${i}`,snippet:'s',at:`2026-10-06T0${i}:00:00Z`}))}});
  const a=isolatedGoogleClient(w,'a');const first=await a.mailPage(query,1);expect(first.messages[0]?.id).toBe('m3');expect(first.next_page_token).not.toBeNull();
  const second=await isolatedGoogleClient(w,'a').mailPage(query,1,first.next_page_token!);expect(second.messages[0]?.id).toBe('m2');
  for(const [q,n,owner,token] of [[query+' ',1,'a',first.next_page_token],[query,2,'a',first.next_page_token],[query,1,'b',first.next_page_token],[query,1,'a','forged']] as const)await expect(isolatedGoogleClient(w,owner).mailPage(q,n,token!)).rejects.toThrow();
 });
 it('rejects unsupported query/invalid bounds before collecting and honors [after,before)',async()=>{
  const w=fixture();const a=isolatedGoogleClient(w,'a');
  await expect(a.mailPage('subject:Alpha',10)).rejects.toThrow();expect(w.accessLog('a')).toEqual([]);
  expect((await a.mailPage('in:inbox category:primary after:1791273600 before:1791273601',10)).messages).toHaveLength(1);
  expect((await a.mailPage('in:inbox category:primary after:1791273599 before:1791273600',10)).messages).toHaveLength(0);
 });
});
it('fixture cursors expose no source bytes and invalidate after revision',async()=>{
 // Selected-source wrapper coverage stays with the separate native supervisor suite.
 const q='in:inbox category:primary after:1791244799 before:1791331200';
 const many=new IsolatedSourceWorld({clock:'2026-10-06T09:00:00Z',owners:[{id:'a'},{id:'b'}],sources:{mail:[1,2].map(i=>({owner_id:'a',id:`m${i}`,thread_id:'t',from:'a@example.invalid',subject:'SECRET_SUBJECT',snippet:'s',body:'PRIVATE_BODY',at:`2026-10-06T0${i}:00:00Z`}))},revisions:[{at:'2026-10-06T10:00:00Z',owner_id:'a',source:'mail',id:'m1',patch:{snippet:'changed'}}]});
 const api=isolatedGoogleClient(many,'a');const first=await api.mailPage(q,1);expect(first.next_page_token).not.toBeNull();expect(decodeURIComponent(first.next_page_token!)).not.toContain('PRIVATE_BODY');expect(decodeURIComponent(first.next_page_token!)).not.toContain('SECRET_SUBJECT');many.advance('2026-10-06T10:00:00Z');await expect(api.mailPage(q,1,first.next_page_token!)).rejects.toThrow(/revision mismatch/);
});
import { googleHandlers } from '../src/tools/live/google';
import { queryCalendarArgsSchema, type QueryCalendarArgs } from '@waldo/contracts';
it('maps Calendar pages to the real handler and fences fixture owner, query and revision',async()=>{
 const world=new IsolatedSourceWorld({clock:'2026-10-06T09:00:00Z',owners:[{id:'a'},{id:'b'}],sources:{calendar:[1,2].map(i=>({owner_id:'a',id:`event-${i}`,title:'PRIVATE_TITLE',start:`2026-10-06T1${i}:00:00Z`,end:`2026-10-06T1${i}:30:00Z`,all_day:false}))},revisions:[{at:'2026-10-06T10:00:00Z',owner_id:'a',source:'calendar',id:'event-1',patch:{title:'changed'}}]});
 const client=isolatedGoogleClient(world,'a');
 const range={from:'2026-10-06T09:00:00Z',to:'2026-10-06T15:00:00Z'};
 expect(typeof client.calendarPage).toBe('function');
 const handler=googleHandlers({client:async()=>client},{propose:async()=>'',proposeSendEmail:async()=>'',record:()=>{}},{timezone:'UTC',now:()=>new Date(world.now())})[0]! as {handle(args:QueryCalendarArgs):Promise<unknown>};
 const first=await handler.handle(queryCalendarArgsSchema.parse({date_range:range,limit:1})) as any;
 expect(first.data.events).toHaveLength(1);
 expect(first.data.observed_at).toBe(world.now());
 const token=first.data.next_page_token;expect(token).toEqual(expect.any(String));expect(decodeURIComponent(token)).not.toContain('PRIVATE_TITLE');
 expect((await client.calendarPage!('primary',range.from,range.to,1,false,token)).events[0]?.id).toBe('event-2');
 for(const api of [isolatedGoogleClient(world,'b')])await expect(api.calendarPage!('primary',range.from,range.to,1,false,token)).rejects.toThrow(/mismatch/);
 await expect(client.calendarPage!('primary',range.from,range.to,2,false,token)).rejects.toThrow(/mismatch/);
 world.advance('2026-10-06T10:00:00Z');
 await expect(client.calendarPage!('primary',range.from,range.to,1,false,token)).rejects.toThrow(/revision mismatch/);
 await expect(client.calendarPage!('work',range.from,range.to,1,false)).rejects.toThrow(/unsupported/);
});
