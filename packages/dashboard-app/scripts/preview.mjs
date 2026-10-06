// Synthetic preview only, never imported by the app or bundled into production.
import { memoryPreview } from './memory-preview.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const dist = new URL('../dist/console/dashboard/', import.meta.url);
const cases = ['recorded', 'empty', 'missing-summary', 'signed-out', 'unavailable', 'malformed', 'loading', 'admin', 'admin-refresh-failure','memory','memory-partial','memory-error'];
const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? 'recorded';
const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7) ?? 4178);
if (!cases.includes(selected) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use --case=' + cases.join('|') + ' and --port=1024..65535');
// Times follow the real clock in the fixture's zone (UTC+5:30) so the day rail has something to draw.
const zoneMidnight = (() => { const shifted = new Date(Date.now() + 330 * 60000); return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60000; })();
const at = (minutes) => new Date(zoneMidnight + minutes * 60000).toISOString();
const nowMinutes = Math.floor((Date.now() - zoneMidnight) / 60000);
const payload = { version: 1, as_of: new Date().toISOString(), timezone: 'Asia/Kolkata', brief: { status: 'sent_recorded', at: at(8 * 60) }, waiting: { count: 2, first: { id: 'synthetic-1', summary: 'Move Design review from 3:00 pm to 4:30 pm.' } }, next_card: { id: 'synthetic-card', label: 'Check-in', scheduled_at: at(Math.min(23 * 60 + 30, nowMinutes + 95)) }, latest_activity: { kind: 'update_card', status: 'recorded', at: at(Math.max(0, nowMinutes - 25)), summary: 'Updated the Check-in card with a shifted meeting.' }, services: [{ account_id: 'synthetic-google', email: 'sample@example.test', grants: ['calendar', 'gmail'], health: 'needs_reconnect' }] };
const admin = {csrf:'synthetic-csrf',as_of:'2026-09-30T08:00:00Z',current_issuer:{id:'issuer',email:'admin@example.test',issued_count:2},owners:[{id:'issuer',email:'admin@example.test',state:'active',presences:['telegram'],created_at:'2026-09-01T00:00:00Z',issued_count:2},...Array.from({length:12},(_,i)=>({id:`owner-${i}`,email:`person${i}@example.test`,state:'active',presences:[],created_at:'2026-09-01T00:00:00Z',issued_count:0}))],invites:[{id:'one',email:'one@example.test',issued_by:'issuer',issuer_email:'admin@example.test',created_at:'2026-09-29T00:00:00Z',expires_at:'2026-10-13T00:00:00Z',used_at:null,revoked_at:null},{id:'two',email:'two@example.test',issued_by:'issuer',issuer_email:'admin@example.test',created_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-15T00:00:00Z',used_at:null,revoked_at:null}]};

const rev = 'a'.repeat(64);
const controls = (view) => {
  const base = { version: 1, view, state: 'available', csrf: 'synthetic-csrf', revision: rev };
  const data = {
    day: { timezone: 'Asia/Kolkata', date: '2026-09-29', cards: [
      { id: 'brief', name: 'The Brief', defaultTime: '08:00', time: '08:00', reason: 'Your morning read on the day ahead.', sent: true, pin: null },
      { id: 'checkin', name: 'Check-in', defaultTime: '14:30', time: '14:30', reason: 'A midday look at what moved.', sent: false, pin: '14:30' },
      { id: 'close', name: 'The Close', defaultTime: '20:30', time: null, reason: 'An evening wrap of what got done.', sent: false, pin: null }],
      proactivity: { quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' } },
    connections: { google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'sample@example.test', calendar: true, mail: true, tasks: false, health: 'needs_reconnect' }, { id: 'g2', email: 'work@example.test', calendar: true, mail: true, tasks: true, health: 'access_granted' }] }, telegram: { linked: true, unlinkAvailable: true }, sessions: { until: 'Oct 6, 9:00 PM', count: 2 } },
    waiting: { proposals: [
      { id: 'p1', kind: 'calendar_change', summary: 'Move Design review from 3:00 pm to 4:30 pm.', state: 'open', review: { kind: 'calendar_change', action: 'move', title: 'Design review', event_id: 'evt_synthetic', start: '2026-09-29 16:30', end: '2026-09-29 17:15', reason: 'Overlaps with your protected focus block.' }, actions: ['approval.approve', 'approval.skip'] },
      { id: 'p2', kind: 'email_send', summary: 'Reply to Sam about the Thursday agenda.', state: 'open', review: { kind: 'email_send', to: ['sam@example.test'], cc: [], bcc: [], subject: 'Re: Thursday agenda', body: 'Thursday works. I will send the agenda tonight.' }, actions: ['approval.skip'] }] },
    activity: { steps: [{ step: 'Telegram in', state: 'ok', at: '2026-09-29 07:30', note: null }, { step: 'Calendar read', state: 'ok', at: '2026-09-29 07:30', note: null }, { step: 'Reply drafted', state: 'failed', at: '2026-09-29 07:31', note: null }, { step: 'Brief send', state: 'unseen', at: null, note: null }],
      trace: [{ time: '2026-09-29 07:35', hop: 'update_card', ok: true, ms: 840, summary: 'Updated the Check-in card with a shifted meeting.' }, { time: '2026-09-29 07:10', hop: 'heartbeat', ok: true, ms: 120, summary: null }, { time: '2026-09-29 06:50', hop: 'tool_attempt', ok: false, ms: 2210, summary: 'Calendar read timed out.' }, { time: '2026-09-29 06:20', hop: 'llm_reply', ok: true, ms: 1640, summary: 'Answered a question about Thursday.' }, { time: '2026-09-29 05:58', hop: 'reminder', ok: true, ms: 90, summary: 'Reminder recorded for passport renewal.' }, { time: '2026-09-29 05:30', hop: 'heartbeat', ok: true, ms: 140, summary: null }, { time: '2026-09-29 04:10', hop: 'tool_attempt', ok: true, ms: 980, summary: 'Read tomorrow’s calendar.' }],
      runs: [{ id: 'r1', kind: 'heartbeat', status: 'completed', summary: null, started: '2026-09-29 07:10', ended: '2026-09-29 07:10' }],
      page: { trace_before: null, runs_before: null, trace_applied: null, runs_applied: null }, ledger: 'Reminder: renew passport (Fri)\nFollow up with Sam (Thu)' },
    profile: { sections: [{ title: 'Rhythm', lines: ['Prefers deep work before noon.', 'Checks messages after lunch.', 'Winds down around 10pm.'] }, { title: 'Work', lines: ['Runs product at a 12-person startup.', 'Board meeting every first Thursday.'] }, { title: 'People', lines: ['Sam is the closest collaborator.', 'Calls family on Sunday evenings.'] }, { title: 'Preferences', lines: ['Short replies, no bullet lists.', 'Aisle seat on flights.', 'Coffee, never after 3pm.'] }], barriers: 1, removal: { state: 'none_recorded', pending_count: 0 }, holds: [] },
    setup: { telegram_linked: true, google_access_granted: true, quiet_hours_set: false },
    usage: { rows: [{ model: 'synthetic-model', calls: 42, input: 120000, cached: 80000, output: 9000, usd: 0.4312 }] },
    files: { storage: 'telegram_reference', items: [{ id: 1, kind: 'document', name: 'itinerary.pdf', mime: 'application/pdf', size: 48213, caption: 'Flights for October', at: 1790000000 }] },
  }[view];
  return { ...base, data };
};
let adminReadFailed=false;
const server = createServer((req, res) => {
  if(req.url?.startsWith('/console/dashboard/api/v1/memory?')) {
    const data=memoryPreview(new URL(req.url,'http://localhost').searchParams,selected==='memory-partial');
    res.writeHead(selected==='memory-error'?503:data.error?404:200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(selected==='memory-error'?{error:'memory_unavailable'}:data));return;
  }
  if(req.url?.startsWith('/console/dashboard/api/v1/controls?')) {
    const view=new URL(req.url,'http://localhost').searchParams.get('view');
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(controls(view)));return;
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
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({message:'Synthetic receipt only. Copy it now and send it yourself. Waldo did not email anyone.',...(action==='invite.create'?{code:'SYNTHETICCODE'}:{})}));
      if(selected==='admin-refresh-failure')adminReadFailed=true;
    });return;
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
