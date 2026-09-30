// Synthetic preview only, never imported by the app or bundled into production.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const dist = new URL('../dist/console/dashboard/', import.meta.url);
const cases = ['recorded', 'empty', 'missing-summary', 'signed-out', 'unavailable', 'malformed', 'loading', 'admin', 'admin-refresh-failure'];
const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7) ?? 'recorded';
const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7) ?? 4178);
if (!cases.includes(selected) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use --case=' + cases.join('|') + ' and --port=1024..65535');
const payload = { version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'sent_recorded', at: '2026-09-29T03:30:00Z' }, waiting: { count: 1, first: { id: 'synthetic-1', summary: 'Calendar proposal awaiting a full review.' } }, next_card: { id: 'synthetic-card', label: 'Check-in', scheduled_at: '2026-09-29T09:00:00Z' }, latest_activity: { kind: 'Background run', status: 'recorded', at: '2026-09-29T07:35:00Z', summary: 'Synthetic design preview only.' }, services: [{ account_id: 'synthetic-google', email: 'sample@example.test', grants: ['calendar', 'gmail'], health: 'needs_reconnect' }] };
const admin = {csrf:'synthetic-csrf',as_of:'2026-09-30T08:00:00Z',current_issuer:{id:'issuer',email:'admin@example.test',issued_count:2},owners:[{id:'issuer',email:'admin@example.test',state:'active',presences:['telegram'],created_at:'2026-09-01T00:00:00Z',issued_count:2},...Array.from({length:12},(_,i)=>({id:`owner-${i}`,email:`person${i}@example.test`,state:'active',presences:[],created_at:'2026-09-01T00:00:00Z',issued_count:0}))],invites:[{id:'one',email:'one@example.test',issued_by:'issuer',issuer_email:'admin@example.test',created_at:'2026-09-29T00:00:00Z',expires_at:'2026-10-13T00:00:00Z',used_at:null,revoked_at:null},{id:'two',email:'two@example.test',issued_by:'issuer',issuer_email:'admin@example.test',created_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-15T00:00:00Z',used_at:null,revoked_at:null}]};
let adminReadFailed=false;
const server = createServer((req, res) => {
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
