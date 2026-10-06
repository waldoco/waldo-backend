import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityControls, activityPageCursors, FilesControls, ProfileControls, SetupControls, UsageControls, WaitingControls } from './Panels';
import type { ActivityRecord, FilesRecord, ProfileRecord, SetupRecord, UsageRecord, WaitingRecord } from './controls-model';

const base = { version: 1 as const, state: 'available' as const, csrf: 'c'.repeat(64), revision: 'a'.repeat(64) };
const noop = () => {};
const waiting: WaitingRecord = { ...base, view: 'waiting', data: { timezone: null, proposals: [
  { id: 'calendar', kind: 'calendar_change', summary: 'Move event', state: 'open', actions: ['approval.approve', 'approval.skip'], review: { kind: 'calendar_change', action: 'move', title: 'Gym', event_id: 'gym-1', start: '2026-10-02T08:00Z', end: '2026-10-02T09:00Z', reason: 'Requested move' } },
  { id: 'email', kind: 'email_send', summary: 'Send email', state: 'open', actions: ['approval.skip'], review: { kind: 'email_send', to: ['to@test.invalid'], cc: ['cc@test.invalid'], bcc: ['bcc@test.invalid'], subject: '<script>subject</script>', body: '<script>full email body</script>' } },
  { id: 'message', kind: 'message_send', summary: 'Send message', state: 'unconfirmed', actions: [], review: { kind: 'message_send', channel: 'telegram', content: 'Exact message words' } },
  { id: 'long-email', kind: 'email_send', summary: 'Long email', state: 'review_only', actions: ['approval.skip'], review: null },
  { id: 'undo', kind: 'calendar_change', summary: 'Recorded move', state: 'done', actions: ['approval.undo'], review: null },
] } };
const activity: ActivityRecord = { ...base, view: 'activity', data: {
  trace: [{ time: '10:00', hop: 'patrol_skip', ok: true, ms: 0, summary: 'Suppressed during quiet hours' }, { time: '11:00', hop: 'tool_attempt', ok: false, ms: 15, summary: '<script>failure</script>' }],
  runs: [{ id: 'run1', kind: 'reminder', status: 'running', started: '10-02 11:00', ended: null, summary: null }], steps: [{ step: 'Google read', state: 'unseen', at: null, note: null }], last_request: { trace: 'tg-812', at: '2026-10-02 11:00', ok: false, partial: false, recorded_steps: 2, hops: [{ hop: 'llm_reply', ok: true, ms: 2140, note: '' }, { hop: 'memory', ok: false, ms: 20, note: 'bad json' }] },
  page: { trace_before: 11, runs_before: 22, trace_applied: 33, runs_applied: 44 }, ledger: '<script>reminder text</script>',
} };

describe('full waiting proposal review', () => {
  it('draws the calendar illustration in the owner zone when it is known, and keeps the exact values', () => {
    const kolkata = renderToStaticMarkup(<WaitingControls record={{ ...waiting, data: { ...waiting.data, timezone: 'Asia/Kolkata' } }} busy={false} onAction={noop}/>);
    expect(kolkata).toContain('Fri, Oct 2, 1:30 PM–2:30 PM');
    expect(kolkata).toContain('The illustration is in Asia/Kolkata');
    expect(kolkata).toContain('2026-10-02T08:00Z');
    expect(kolkata).toContain('Approve this calendar change');
    const west = renderToStaticMarkup(<WaitingControls record={{ ...waiting, data: { ...waiting.data, timezone: 'America/Los_Angeles' } }} busy={false} onAction={noop}/>);
    expect(west).toContain('1:00 AM–2:00 AM');
  });

  it('keeps the disclosed UTC illustration when no owner zone is known', () => {
    const unknown = renderToStaticMarkup(<WaitingControls record={waiting} busy={false} onAction={noop}/>);
    expect(unknown).toContain('8:00 AM–9:00 AM');
    expect(unknown).toContain('The illustration is in UTC');
  });

  it('shows the last chat request from its own trace, apart from background jobs', () => {
    const html = renderToStaticMarkup(<ActivityControls record={activity} busy={false} onPage={noop}/>);
    expect(html).toContain('The last request, step by step');
    expect(html).toContain('Failure recorded in this request');
    expect(html).toContain('Background jobs, last ran');
    expect(html.indexOf('The last request, step by step')).toBeLessThan(html.indexOf('Background jobs, last ran'));
    expect(html).toContain('2140 ms'); expect(html).toContain('bad json'); expect(html).toContain('Memory update'); expect(html).toContain('Started 2026-10-02 11:00');
    expect(html).not.toContain('Some earlier steps');
    const cut = renderToStaticMarkup(<ActivityControls record={{ ...activity, data: { ...activity.data, last_request: { ...activity.data.last_request!, ok: true, partial: true, recorded_steps: 6, hops: [{ hop: 'llm_reply', ok: true, ms: 5, note: '' }] } } }} busy={false} onPage={noop}/>);
    expect(cut).toContain('Some earlier steps'); expect(cut).toContain('1 of 6'); expect(cut).not.toContain('Every step recorded');
    const none = renderToStaticMarkup(<ActivityControls record={{ ...activity, data: { ...activity.data, last_request: null } }} busy={false} onPage={noop}/>);
    expect(none).toContain('No chat request recorded yet.');
  });

  it('renders exact reviewed words and recipients, eligible calendar decisions, and chat-only sends', () => {
    const html = renderToStaticMarkup(<WaitingControls record={waiting} busy={false} onAction={noop}/>);
    expect(html).toContain('to@test.invalid'); expect(html).toContain('cc@test.invalid'); expect(html).toContain('bcc@test.invalid');
    expect(html).toContain('&lt;script&gt;full email body&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('Exact message words'); expect(html).toContain('gym-1'); expect(html).toContain('Requested move');
    expect(html.match(/Approve this calendar change/g)).toHaveLength(1);
    expect(html).toContain('Dismiss proposal'); expect(html).toContain('Undo calendar change');
    expect(html).toContain('review card in chat'); expect(html).toContain('couldn’t confirm the review card was delivered');
    expect(html).toContain('no Send it button'); expect(html).toMatch(/<details[^>]*open=""/);
  });

  it('never renders generic email approval even with erroneous action metadata and blocks pending decisions', () => {
    const email = waiting.data.proposals[1]!;
    const html = renderToStaticMarkup(<WaitingControls record={{ ...waiting, data: { timezone: null, proposals: [{ ...email, actions: ['approval.approve', 'approval.undo'] }] } }} busy onAction={noop}/>);
    expect(html).not.toMatch(/<button[^>]*>Approve/); expect(html).not.toContain('Undo calendar');
    const pending = renderToStaticMarkup(<WaitingControls record={waiting} busy onAction={noop}/>);
    expect(pending).toContain('disabled=""'); expect(pending).not.toContain('/console/waiting');
  });
});

describe('recorded activity and pagination', () => {
  it('preserves recorded suppression/failure/pending distinctions and escapes ledger words', () => {
    const html = renderToStaticMarkup(<ActivityControls record={activity} busy={false} onPage={noop}/>);
    expect(html).toContain('Suppressed during quiet hours'); expect(html).toContain('Failure recorded'); expect(html).toContain('Recorded status: running');
    expect(html).toContain('no end recorded'); expect(html).toContain('Not seen yet'); expect(html).toContain('not a full history');
    expect(html).toContain('&lt;script&gt;reminder text&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('doesn’t by itself verify');
  });
  it('moves each list independently while preserving the other applied cursor', () => {
    expect(activityPageCursors(activity.data.page, 'trace', true)).toEqual({ trace_before: 11, runs_before: 44 });
    expect(activityPageCursors(activity.data.page, 'trace', false)).toEqual({ trace_before: null, runs_before: 44 });
    expect(activityPageCursors(activity.data.page, 'runs', true)).toEqual({ runs_before: 22, trace_before: 33 });
    expect(activityPageCursors(activity.data.page, 'runs', false)).toEqual({ runs_before: null, trace_before: 33 });
  });
});

describe('profile, setup, usage and Telegram references', () => {
  it('shows pending removal without pretending the withheld profile is empty or purged', () => {
    const record: ProfileRecord = { ...base, view: 'profile', data: { sections: [], barriers: 2, removal: { state: 'incomplete', pending_count: 1 }, holds: [{ kind: 'shared', reason: '<script>gate reason</script>', created_at: '2026-10-02' }] } };
    const html = renderToStaticMarkup(<ProfileControls record={record}/>);
    expect(html).toContain('Removal incomplete'); expect(html).toContain('not an empty Profile'); expect(html).not.toContain('No profile sections');
    expect(html).toContain('No retry target is available in this read'); expect(html).toContain('2 recorded do-not-relearn notes'); expect(html).toContain('Corrections go through chat');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;gate reason&lt;/script&gt;');
  });
  it('keeps setup in the modern shell and distinguishes grants from verified reads', () => {
    const record: SetupRecord = { ...base, view: 'setup', data: { telegram_linked: true, google_access_granted: true, quiet_hours_set: false } };
    const html = renderToStaticMarkup(<SetupControls record={record}/>);
    expect(html).toContain('href="#/connections"'); expect(html).toContain('href="#/day"'); expect(html).toContain('To do');
    expect(html).toContain('verify a live read'); expect(html).not.toContain('/console/connections');
  });
  it('labels cost as a recorded estimate, preserves tokens, and escapes model names', () => {
    const record: UsageRecord = { ...base, view: 'usage', data: { rows: [{ model: '<script>model</script>', calls: 1, input: 100, cached: 50, output: 10, usd: .0123 }] } };
    const html = renderToStaticMarkup(<UsageControls record={record}/>);
    expect(html).toContain('not verified provider billing'); expect(html).toContain('$0.0123'); expect(html).toContain('100'); expect(html).toContain('50');
    expect(html).not.toContain('<script>');
  });
  it('uses the existing authenticated file-open route and describes only reference removal', () => {
    const record: FilesRecord = { ...base, view: 'files', data: { storage: 'telegram_reference', items: [{ id: 7, kind: 'document', name: '<script>report.pdf', caption: 'Owner caption', mime: 'application/pdf', size: null, at: 1790000000000 }] } };
    const html = renderToStaticMarkup(<FilesControls record={record} busy onAction={noop}/>);
    expect(html).toContain('href="/console/file?id=7"'); expect(html).toContain('Size unavailable'); expect(html).toContain('from list');
    expect(html).toContain('disabled=""'); expect(html).toContain('does not purge Telegram bytes'); expect(html).toContain('Sharing is unavailable');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('/console/files');
  });
});
it('uses honest labels with raw types inspectable, without inventing missing outcomes',()=>{
 const record:ActivityRecord={...activity,data:{...activity.data,trace:['update_card','joined_path','llm_reply','unknown_hop'].map(hop=>({time:'10:00',hop,ok:true,ms:0,summary:null}))}};
 const html=renderToStaticMarkup(<ActivityControls record={record} busy={false} onPage={noop}/>);
 for(const label of ['Update card','Conversation processing','Chat reply','Recorded activity'])expect(html).toContain(`<span class="value">${label}</span>`);
 expect(html).toContain('No outcome summary recorded.');expect(html).toContain('<details');expect(html).toContain('unknown_hop');
 expect(html).not.toMatch(/<span class="value">(update_card|joined_path|llm_reply|unknown_hop)<\/span>/);
});
it('retains exact calendar timestamps, reference and invalid values in visible review',()=>{
 const proposal=waiting.data.proposals[0]!;
 const record:WaitingRecord={...waiting,data:{timezone:null,proposals:[{...proposal,review:{kind:'calendar_change',action:'move',title:'Review',event_id:'exact-ref',start:'2026-10-06T23:30:00+05:30',end:'invalid-end',reason:'Requested'}}]}};
 const html=renderToStaticMarkup(<WaitingControls record={record} busy={false} onAction={noop}/>);
 expect(html).toContain('2026-10-06T23:30:00+05:30');expect(html).toContain('invalid-end');expect(html).toContain('exact-ref');expect(html).toContain('Time or time zone could not be read');
});
it('does not offer calendar approval when a recorded time is invalid',()=>{
 const proposal=waiting.data.proposals[0]!;
 for(const start of ['invalid','2026-10-06T23:30:00']){
 const record:WaitingRecord={...waiting,data:{timezone:null,proposals:[{...proposal,review:{kind:'calendar_change',action:'move',title:'Review',event_id:'ref',start,end:null,reason:'Requested'}}]}};
 const html=renderToStaticMarkup(<WaitingControls record={record} busy={false} onAction={noop}/>);
 expect(html).toContain(start);expect(html).not.toContain('Approve this calendar change');
 }
});
