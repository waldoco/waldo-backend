// Synthetic preview only, never imported by the app or bundled into production.
import { memoryPreview } from './memory-preview.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const dist = new URL('../dist/console/dashboard/', import.meta.url);
const cases = ['recorded', 'empty', 'missing-summary', 'signed-out', 'unavailable', 'malformed', 'loading', 'admin', 'admin-refresh-failure','memory','memory-partial','memory-error','vault-locked'];
const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? 'recorded';
const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7) ?? 4178);
if (!cases.includes(selected) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use --case=' + cases.join('|') + ' and --port=1024..65535');
// Times follow the real clock in the fixture's zone (UTC+5:30) so the day rail has something to draw.
const zoneMidnight = (() => { const shifted = new Date(Date.now() + 330 * 60000); return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60000; })();
const at = (minutes) => new Date(zoneMidnight + minutes * 60000).toISOString();
const nowMinutes = Math.floor((Date.now() - zoneMidnight) / 60000);
const payload = { version: 1, as_of: new Date().toISOString(), timezone: 'Asia/Kolkata', brief: { status: 'sent_recorded', at: at(8 * 60) }, waiting: { count: 2, first: { id: 'synthetic-1', summary: 'Move Design review from 3:00 pm to 4:30 pm.' } }, next_card: { id: 'synthetic-card', label: 'Check-in', scheduled_at: at(Math.min(23 * 60 + 30, nowMinutes + 95)) }, latest_activity: { kind: 'update_card', status: 'recorded', at: at(Math.max(0, nowMinutes - 25)), summary: 'Updated the Check-in card with a shifted meeting.' }, services: [{ account_id: 'synthetic-google', email: 'sample@example.test', grants: ['calendar', 'gmail'], health: 'needs_reconnect' }] };
const admin = {csrf:'synthetic-csrf',as_of:'2026-09-30T08:00:00Z',current_issuer:{id:'issuer',email:'admin@example.test',issued_count:2},owners:[{id:'issuer',email:'admin@example.test',state:'active',presences:['telegram'],created_at:'2026-09-01T00:00:00Z',issued_count:2},...Array.from({length:12},(_,i)=>({id:`owner-${i}`,email:`person${i}@example.test`,state:'active',presences:[],created_at:'2026-09-01T00:00:00Z',issued_count:0}))],invites:[{id:'one',email:'one@example.test',issued_by:'issuer',issuer_email:'admin@example.test',created_at:'2026-09-29T00:00:00Z',expires_at:'2026-10-13T00:00:00Z',used_at:null,revoked_at:null},{id:'two',email:'two@example.test',issued_by:'issuer',issuer_email:'admin@example.test',created_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-15T00:00:00Z',used_at:null,revoked_at:null}]};

const vault = { version: 1, state: 'available', as_of: new Date().toISOString(),
  memory: { state: 'available', groups: [
    { kind: 'fact', total: 2, items: [{ id: 'syn:claim:1', text: 'Lives in Bengaluru and works from home on Fridays', source_label: 'You said this', origin: 'owner', recorded_at: '2026-10-02' }, { id: 'syn:claim:2', text: 'Leads the design team at a small studio', source_label: 'You confirmed this', origin: 'owner', recorded_at: '2026-10-09' }] },
    { kind: 'preference', total: 1, items: [{ id: 'syn:claim:3', text: 'Prefers meetings after 11 am', source_label: "Waldo's inference", origin: 'agent', recorded_at: '2026-10-14' }] },
    { kind: 'interpretation', total: 1, items: [{ id: 'syn:node:1', text: 'Protects mornings for deep work', source_label: "Waldo's pattern from your Spots", origin: 'agent', recorded_at: '2026-10-20' }] },
  ] },
  connections: { token_note: "Tokens are stored encrypted (Supabase Vault). Waldo's model never sees them.",
    google: [{ account_id: 'synthetic-google', email: 'sample@example.test', grants: ['calendar', 'gmail'], status: 'active', token_storage: 'supabase_vault', connected_at: null, last_used_at: null, revoke: { view: 'connections', action: 'google.disconnect' } }],
    mcp: [{ id: 'synthetic-mcp', name: 'Granola', host: 'mcp.granola.example', status: 'active', scopes: ['meetings.read'], tools: 6, runs_without_asking: 6, connected_at: '2026-10-18T09:00:00.000Z', last_used_at: null, revoke: { view: 'connections', action: 'mcp.disconnect' } }],
    channels: [{ channel: 'telegram', state: 'unlinked', revoke: null }, { channel: 'imessage', state: 'linked', revoke: { view: 'imessage', action: 'imessage.unlink' } }, { channel: 'whatsapp', state: 'unlinked', revoke: null }],
    health: { state: 'available', manage: 'app', rows: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-01T08:00:00.000Z', withdrawn_at: null, newest_upload_at: new Date(Date.now() - 3600000).toISOString() }, { source: 'apple', purpose: 'model_processing', status: 'granted', granted_at: '2026-10-01T08:00:00.000Z', withdrawn_at: null, newest_upload_at: new Date(Date.now() - 3600000).toISOString() }] } },
  access_log: { window_days: 30, kept_steps: 500,
    tools: { rows: [['search_communication', 'core', 'read', true, 20], ['query_calendar', 'core', 'read', true, 22], ['propose_calendar_change', 'calendar', 'acted', true, 23], ['get_health', 'core', 'read', true, 90], ['web_search', 'core', 'read', false, 200]].map(([tool, category, kind, ok, ago]) => ({ at: new Date(Date.now() - ago * 60000).toISOString(), tool, category, kind, ok })), next_before: null, oldest_at: new Date(Date.now() - 6 * 86400000).toISOString() },
    approvals: { rows: [{ at: new Date(Date.now() - 23 * 60000).toISOString(), kind: 'calendar_change', decision: 'done', decided_at: new Date(Date.now() - 21 * 60000).toISOString() }, { at: new Date(Date.now() - 86400000).toISOString(), kind: 'email_send', decision: 'skipped', decided_at: new Date(Date.now() - 86000000).toISOString() }], next_before: null } } };
const rev = 'a'.repeat(64);
const controls = (view) => {
  const base = { version: 1, view, state: 'available', csrf: 'synthetic-csrf', revision: rev };
  const data = {
    day: { timezone: 'Asia/Kolkata', date: '2026-09-29', cards: [
      { id: 'brief', name: 'The Brief', defaultTime: '08:00', time: '08:00', reason: 'Your morning read on the day ahead.', sent: true, pin: null },
      { id: 'checkin', name: 'Check-in', defaultTime: '14:30', time: '14:30', reason: 'A midday look at what moved.', sent: false, pin: '14:30' },
      { id: 'close', name: 'The Close', defaultTime: '20:30', time: null, reason: 'An evening wrap of what got done.', sent: false, pin: null }],
      proactivity: { quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' } },
    connections: { google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'sample@example.test', calendar: true, mail: true, tasks: false, health: 'needs_reconnect' }, { id: 'g2', email: 'work@example.test', calendar: true, mail: true, tasks: true, health: 'access_granted' }] }, telegram: { linked: true, unlinkAvailable: true }, sessions: { until: 'Oct 6, 9:00 PM', count: 2, items: [{ signed_in: 'Oct 6, 9:00 AM', until: 'Oct 6, 9:00 PM', current: true }, { signed_in: 'Oct 5, 8:00 PM', until: 'Oct 6, 8:00 AM', current: false }] }, channels: [{ channel: 'imessage', state: 'linked', masked_label: 'Your iPhone' }] },
    waiting: { proposals: [
      { id: 'p1', kind: 'calendar_change', summary: 'Move Design review from 3:00 pm to 4:30 pm.', state: 'open', review: { kind: 'calendar_change', action: 'move', title: 'Design review', event_id: 'evt_synthetic', start: '2026-09-29 16:30', end: '2026-09-29 17:15', reason: 'Overlaps with your protected focus block.' }, actions: ['approval.approve', 'approval.skip'] },
      { id: 'p2', kind: 'email_send', summary: 'Reply to Sam about the Thursday agenda.', state: 'open', review: { kind: 'email_send', to: ['sam@example.test'], cc: [], bcc: [], subject: 'Re: Thursday agenda', body: 'Thursday works. I will send the agenda tonight.' }, actions: ['approval.skip'] }] },
    activity: { last_request: { trace: 'tg-812', at: '2026-09-29 07:30', ok: false, partial: false, recorded_steps: 3, hops: [{ hop: 'owner_request', ok: true, ms: 0, note: '' }, { hop: 'memory', ok: false, ms: 20, note: 'bad json' }, { hop: 'llm_reply', ok: true, ms: 2140, note: '' }] }, steps: [{ step: 'Telegram in', state: 'ok', at: '2026-09-29 07:30', note: null }, { step: 'Calendar read', state: 'ok', at: '2026-09-29 07:30', note: null }, { step: 'Reply drafted', state: 'failed', at: '2026-09-29 07:31', note: null }, { step: 'Brief send', state: 'unseen', at: null, note: null }],
      trace: [{ time: '2026-09-29 07:35', hop: 'update_card', ok: true, ms: 840, summary: 'Updated the Check-in card with a shifted meeting.' }, { time: '2026-09-29 07:10', hop: 'heartbeat', ok: true, ms: 120, summary: null }, { time: '2026-09-29 06:50', hop: 'tool_attempt', ok: false, ms: 2210, summary: 'Calendar read timed out.' }, { time: '2026-09-29 06:20', hop: 'llm_reply', ok: true, ms: 1640, summary: 'Answered a question about Thursday.' }, { time: '2026-09-29 05:58', hop: 'reminder', ok: true, ms: 90, summary: 'Reminder recorded for passport renewal.' }, { time: '2026-09-29 05:30', hop: 'heartbeat', ok: true, ms: 140, summary: null }, { time: '2026-09-29 04:10', hop: 'tool_attempt', ok: true, ms: 980, summary: 'Read tomorrow’s calendar.' }],
      runs: [{ id: 'r1', kind: 'heartbeat', status: 'completed', summary: null, started: '2026-09-29 07:10', ended: '2026-09-29 07:10' }],
      page: { trace_before: null, runs_before: null, trace_applied: null, runs_applied: null }, ledger: 'Reminder: renew passport (Fri)\nFollow up with Sam (Thu)' },
    profile: { sections: [{ title: 'Rhythm', lines: ['Prefers deep work before noon.', 'Checks messages after lunch.', 'Winds down around 10pm.'] }, { title: 'Work', lines: ['Runs product at a 12-person startup.', 'Board meeting every first Thursday.'] }, { title: 'People', lines: ['Sam is the closest collaborator.', 'Calls family on Sunday evenings.'] }, { title: 'Preferences', lines: ['Short replies, no bullet lists.', 'Aisle seat on flights.', 'Coffee, never after 3pm.'] }], barriers: 1, removal: { state: 'none_recorded', pending_count: 0 }, holds: [] },
    setup: { telegram_linked: true, google_access_granted: true, quiet_hours_set: false },
    usage: { rows: [{ model: 'synthetic-model', calls: 42, input: 120000, cached: 80000, output: 9000, usd: 0.4312 }] },
    files: { storage: 'telegram_reference', items: [{ id: 1, kind: 'document', name: 'itinerary.pdf', mime: 'application/pdf', size: 48213, caption: 'Flights for October', at: 1790000000 }] },
    imessage: { enabled: true, address: 'waldo@example.test', linked_hint: '4321', admin: true, phone: null, photon: 'connected', actions: ['imessage.link', 'imessage.unlink', 'imessage.pair', 'imessage.pair_shared'], bridges: [
      { id: 'imb_' + '1'.repeat(32), kind: 'owner', state: 'pending', subject: 'sample@example.test', chat: 'iMessage;-;sample@example.test', observed: true, host_version: 'synthetic-host-1', actions: ['imessage.verify', 'imessage.activate', 'imessage.revoke'] },
      { id: 'imb_' + '2'.repeat(32), kind: 'shared', state: 'active', subject: 'operator@example.test', chat: 'iMessage;-;operator@example.test', observed: true, host_version: 'synthetic-host-1', actions: ['imessage.revoke'] }] },
    devices: { actions: ['device.pair'], devices: [{ id: 'dev_synthetic', label: 'Synthetic MacBook', capabilities: ['machine_state_query', 'notify_local'], created_at: '2026-10-16 09:00', actions: ['device.revoke', 'device.query', 'device.notify'] }],
      query_kinds: ['session_status', 'attempt_status', 'worktree_watch'], notification_bodies: ['Your Mac is connected.', 'Your Mac needs attention.', 'Status update'] },
  }[view];
  const status = { imessage: { bridges: [{ id: 'imb_' + '2'.repeat(32), online: true, text_ready: true, sending_paused: false }] },
    devices: { devices: [{ id: 'dev_synthetic', online: true, last_seen_at: '2026-10-16 10:42', commands: [{ class: 'machine_state_query', state: 'answered', result_state: 'idle' }] }] } }[view];
  return { ...base, data, ...(status ? { status } : {}) };
};
// Synthetic one-time values in the real formats, so the shown-once display can be checked. Nothing is minted.
const reveals = { 'imessage.link': { kind: 'link_code', value: 'waldo ABCDEFGHJK' }, 'imessage.pair': { kind: 'host_code', value: 'wim_' + '0123456789abcdef'.repeat(3) },
  'imessage.pair_shared': { kind: 'host_code', value: 'wim_' + 'fedcba9876543210'.repeat(3) }, 'imessage.verify': { kind: 'challenge', value: 'wic_' + '0123456789abcdef'.repeat(3) }, 'device.pair': { kind: 'pairing_code', value: 'wp1.00000000-0000-4000-8000-000000000000.' + 'S'.repeat(43) } };
let adminReadFailed=false;
// Synthetic chat: a short history, and a reply that lands about four seconds after each message.
const chatRows = selected === 'empty' ? [] : [
  { id: 'syn-u1', role: 'user', text: 'What does tomorrow look like?', parts: [], channel: 'telegram', parent_id: null, created_at: Date.now() - 26 * 3600000 },
  { id: 'syn-a1', role: 'assistant', text: 'Three things tomorrow:\n\n- **9:30** Standup\n- **13:00** Lunch with Sam\n- **16:30** Design review\n\nYour morning is clear until standup.', parts: [], channel: 'telegram', parent_id: 'syn-u1', created_at: Date.now() - 26 * 3600000 + 4000 },
  { id: 'syn-u2', role: 'user', text: 'Move the design review to 5 and tell Sam lunch is still on', parts: [], channel: 'app', parent_id: null, created_at: Date.now() - 3600000 },
  { id: 'syn-a2', role: 'assistant', text: 'I moved **Design review** to 5:00 pm. The email to Sam needs your OK first.\n\nDone: 1 calendar change.', channel: 'app', parent_id: 'syn-u2', created_at: Date.now() - 3600000 + 9000,
    parts: [{ type: 'text', text: '' }, { type: 'approval', approval_id: 'syn-ap', kind: 'email_send', review: 'To: sam@example.test\nSubject: Lunch tomorrow\n\nStill on for 1 pm tomorrow.', payload_digest: 'sha256:' + 'a'.repeat(64), actions: ['approve', 'skip'], expires_at: Date.now() + 86400000, fallback_text: 'Send Sam a note that lunch is still on?', question: 'Send Sam a note that lunch is still on?' },
      { type: 'receipt', items: [{ kind: 'calendar_change', target: 'Design review', outcome: 'accepted', via_task: false, at: Date.now() - 3600000 + 8000, digest: null }], more: 0, fallback_text: 'Done: 1 calendar change.' },
      { type: 'quick_replies', choices: [{ id: 'thanks', label: 'Thanks' }, { id: 'later', label: 'Remind me at 4' }], fallback_text: 'Thanks / Remind me at 4' }] },
];
const chatRuns = new Map();
const threads = selected === 'empty' ? [] : [
  { thread_id: 'thr_6a1f0c2e-9b4d-4c3a-8e7f-1a2b3c4d5e6f', title: 'Goa trip in December', revision: 1, title_revision: 2, state: 'active', created_at: Date.now() - 3 * 86400000, last_activity_at: Date.now() - 2 * 3600000,
    rows: [{ id: 'syn-g1', role: 'user', text: 'Find three beach hotels in North Goa under 6k a night for Dec 20–23', parts: [], channel: 'app', parent_id: null, created_at: Date.now() - 2 * 3600000 - 60000 },
      { id: 'syn-g2', role: 'assistant', text: 'Three options under ₹6,000 a night for Dec 20–23:\n\n1. **Ronil Beach Resort**, Baga · ₹5,400 · pool, 2 min to the beach\n2. **Casa Anjuna** · ₹5,900 · quiet, heritage house\n3. **Morjim Sands** · ₹4,800 · right on the beach\n\nWant me to hold one?', parts: [], channel: 'app', parent_id: 'syn-g1', created_at: Date.now() - 2 * 3600000 }] },
  { thread_id: 'thr_7b2e1d3f-0c5e-4d4b-9f8a-2b3c4d5e6f7a', title: null, revision: 1, title_revision: 1, state: 'active', created_at: Date.now() - 86400000, last_activity_at: Date.now() - 86400000, rows: [] },
  { thread_id: 'thr_8c3f2e4a-1d6f-4e5c-a09b-3c4d5e6f7a8b', title: 'Q3 board prep', revision: 2, title_revision: 2, state: 'archived', created_at: Date.now() - 20 * 86400000, last_activity_at: Date.now() - 12 * 86400000,
    rows: [{ id: 'syn-b1', role: 'user', text: 'Pull together last quarter’s numbers for the board deck', parts: [], channel: 'app', parent_id: null, created_at: Date.now() - 12 * 86400000 }] },
];
const chatJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const chatReceipt = (client) => { const run = chatRuns.get(client); if (!run) return null; const done = Date.now() - run.at > 4000;
  if (done && !run.replied) { run.replied = true; const rows = run.rows ?? chatRows; rows.push({ id: `syn-r${Date.now()}`, role: 'assistant', text: `Synthetic reply to “${run.text.slice(0, 80)}”.\n\nThis preview has no model; on staging Waldo answers here.`, parts: [], channel: 'app', parent_id: run.id, created_at: Date.now() });
    if (run.thread) { run.thread.last_activity_at = Date.now(); if (run.thread.title === null) { run.thread.title = run.text.split(' ').slice(0, 4).join(' '); run.thread.title_revision += 1; } } }
  return { accepted: true, message_id: run.id, state: run.cancelled ? 'revoked' : done ? 'completed' : 'running', ...(run.cancelled ? { closed_reason: 'cancelled' } : {}) }; };
const server = createServer((req, res) => {
  if(req.url?.startsWith('/console/dashboard/api/v1/memory?')) {
    const data=memoryPreview(new URL(req.url,'http://localhost').searchParams,selected==='memory-partial');
    res.writeHead(selected==='memory-error'?503:data.error?404:200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(selected==='memory-error'?{error:'memory_unavailable'}:data));return;
  }
  if (req.url?.startsWith('/console/dashboard/api/v1/chat/threads')) {
    const url = new URL(req.url, 'http://localhost'), [, , id, action, client, extra] = url.pathname.slice('/console/dashboard/api/v1/chat'.length).split('/');
    const body = () => new Promise(done => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => done(raw ? JSON.parse(raw) : {})); });
    const shown = t => ({ ...t, preview: [...t.rows].reverse().find(r => r.text)?.text.slice(0, 280) ?? null });
    const recorded = t => ({ operation_id: crypto.randomUUID(), state: 'recorded', thread_id: t.thread_id, revision: t.revision, title_revision: t.title_revision, thread_state: t.state });
    if (!id && req.method === 'GET') return chatJson(res, 200, { threads: threads.filter(t => t.state !== 'deleted').sort((a, b) => b.last_activity_at - a.last_activity_at).map(({ rows, ...t }) => shown({ ...t, rows })).map(({ rows, ...t }) => t) });
    if (!id && req.method === 'POST') return void body().then(b => { const t = { thread_id: `thr_${crypto.randomUUID()}`, title: b.title ?? null, revision: 1, title_revision: 1, state: 'active', created_at: Date.now(), last_activity_at: Date.now(), rows: [] }; threads.push(t); chatJson(res, 200, recorded(t)); });
    const t = threads.find(item => item.thread_id === id);
    if (!t) return chatJson(res, 404, { error: 'thread_not_found' });
    if (t.state === 'deleted') return chatJson(res, 410, { error: 'thread_deleted' });
    if (!action && req.method === 'GET') { const { rows, ...meta } = shown(t); return chatJson(res, 200, { thread: meta, history: { messages: [...rows].reverse(), next_cursor: null } }); }
    if (['rename', 'archive', 'delete'].includes(action)) return void body().then(b => {
      if (action === 'rename') { t.title = b.title; t.title_revision += 1; }
      if (action === 'archive') { t.state = b.archived ? 'archived' : 'active'; t.revision += 1; }
      if (action === 'delete') { t.state = 'deleted'; t.revision += 1; }
      chatJson(res, 200, recorded(t));
    });
    if (action === 'messages' && !client && req.method === 'POST') return void body().then(b => {
      if (t.state === 'archived') return chatJson(res, 409, { error: 'thread_archived' });
      const rid = `syn-t${Date.now()}`; t.rows.push({ id: rid, role: 'user', text: b.text, parts: [], channel: 'app', parent_id: null, created_at: Date.now() });
      chatRuns.set(b.client_message_id, { id: rid, text: b.text, at: Date.now(), rows: t.rows, thread: t }); chatJson(res, 202, { accepted: true, message_id: rid, state: 'admitted' });
    });
    if (action === 'messages' && client) { const run = chatRuns.get(client); if (run && extra === 'cancel') run.cancelled = true; const receipt = chatReceipt(client); return chatJson(res, receipt ? 200 : 404, receipt ?? { error: 'message_not_found' }); }
    return chatJson(res, 404, { error: 'not_found' });
  }
  if (req.url?.startsWith('/console/dashboard/api/v1/chat')) {
    const url = new URL(req.url, 'http://localhost'), rest = url.pathname.slice('/console/dashboard/api/v1/chat'.length);
    if (selected === 'signed-out') return chatJson(res, 401, { error: 'sign_in_required' });
    if (rest === '' && req.method === 'GET') { const limit = Number(url.searchParams.get('limit') ?? 30); return chatJson(res, 200, { messages: [...chatRows].reverse().slice(0, limit), next_cursor: null }); }
    if (rest === '/messages' && req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => { const { client_message_id: client, text } = JSON.parse(body); const id = `syn-${chatRows.length}`;
      chatRows.push({ id, role: 'user', text, parts: [], channel: 'app', parent_id: null, created_at: Date.now() }); chatRuns.set(client, { id, text, at: Date.now() }); chatJson(res, 202, { accepted: true, message_id: id, state: 'admitted' }); }); return; }
    const [, , client, action] = rest.split('/');
    if (action === 'cancel') { const run = chatRuns.get(client); if (run) run.cancelled = true; }
    const receipt = chatReceipt(client); return chatJson(res, receipt ? 200 : 404, receipt ?? { error: 'unavailable' });
  }
  if(req.url?.startsWith('/console/dashboard/api/v1/controls?')) {
    const view=new URL(req.url,'http://localhost').searchParams.get('view');
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(controls(view)));return;
  }
  if (req.url === '/console/dashboard/api/v1/actions' && req.method === 'POST') {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', async () => {
      const form = await new Request('http://preview.invalid', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) }).formData();
      const reveal = reveals[String(form.get('action'))];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ receipt: { state: 'recorded', message: 'Synthetic receipt only. Nothing was paired, linked or sent.' }, duplicate: false, ...(reveal ? { reveal } : {}) }));
    }); return;
  }
  if(req.url === '/console/admin') {
    res.writeHead(selected.startsWith('admin') ? (adminReadFailed?503:200):404,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(selected.startsWith('admin')&&!adminReadFailed ? admin : {error:'not_found'})); return;
  }
  if(req.url === '/console/action' && req.method==='POST' && selected.startsWith('admin')) {
    let body=''; req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const form=new URLSearchParams(body); const action=form.get('action');
      if(form.get('csrf')!==admin.csrf){res.writeHead(403);res.end();return;}
      if(action==='invite.create') {
        if(admin.current_issuer.issued_count>=5){res.writeHead(409);res.end();return;}
        admin.current_issuer.issued_count++;admin.owners[0].issued_count++;
        admin.invites.unshift({id:`synthetic-${admin.current_issuer.issued_count}`,email:form.get('value'),issued_by:'issuer',issuer_email:'admin@example.test',created_at:admin.as_of,expires_at:'2026-10-14T08:00:00Z',used_at:null,revoked_at:null});
      } else if(action==='invite.revoke') {const invite=admin.invites.find(i=>i.id===form.get('id'));if(invite)invite.revoked_at=admin.as_of;}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({message:action==='invite.create'?'Synthetic receipt only. Copy it now and send it yourself. Waldo did not email anyone.':'Synthetic receipt only. Invite revoked. Waldo did not email anyone.',...(action==='invite.create'?{code:'SYNTHETICCODE'}:{})}));
      if(selected==='admin-refresh-failure')adminReadFailed=true;
    });return;
  }
  if (req.url?.startsWith('/console/dashboard/api/v1/vault')) {
    res.writeHead(selected === 'vault-locked' ? 403 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(selected === 'vault-locked' ? { error: 'step_up_required' } : vault)); return;
  }
  if (req.url === '/console/dashboard/api/v1/overview') {
    if (selected === 'signed-out' || selected === 'unavailable') { res.writeHead(selected === 'signed-out' ? 401 : 503); res.end(); return; }
    const record = selected === 'empty' ? { ...payload, brief: { status: 'not_scheduled', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] }
      : selected === 'missing-summary' ? { ...payload, waiting: { count: 2, first: null } } : payload;
    const send = () => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(selected === 'malformed' ? JSON.stringify({ version: 2 }) : JSON.stringify(record)); };
    if (selected === 'loading') {
      const timer = setTimeout(send, 3000);
      res.on('close', () => clearTimeout(timer));
    } else send();
    return;
  }
  // Protected legacy destinations are deliberately not simulated by this server.
  if (req.url !== '/console/dashboard' && req.url !== '/console/dashboard/' && !req.url?.startsWith('/console/dashboard/assets/')) { res.writeHead(404); res.end('Preview does not simulate the owner console.'); return; }
  const path = req.url?.startsWith('/console/dashboard/assets/') ? req.url.slice('/console/dashboard/'.length) : 'index.html';
  if (!/^(assets\/[a-zA-Z0-9_.-]+|index\.html)$/.test(path)) { res.writeHead(404); res.end(); return; }
  try {
    const content = readFileSync(new URL(path, dist));
    res.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' });
    if (path === 'index.html') {
      const banner = '<style>body::before{content:"DESIGN PREVIEW | SYNTHETIC DATA | NOT DEPLOYED";display:block;background:#251f21;color:white;text-align:center;padding:9px;font:600 12px Arial,sans-serif}</style>';
      res.end(content.toString().replace('</head>', banner + '</head>'));
    } else res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic dashboard preview (${selected}): http://127.0.0.1:${port}/console/dashboard`));
