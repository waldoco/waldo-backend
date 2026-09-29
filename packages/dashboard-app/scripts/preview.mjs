// Synthetic preview only, never imported by the app or bundled into production.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const dist = new URL('../dist/console/dashboard/', import.meta.url);
const payload = { version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'sent_recorded', at: '2026-09-29T03:30:00Z' }, waiting: { count: 1, first: { id: 'synthetic-1', summary: 'Calendar proposal awaiting a full review.' } }, next_card: { id: 'synthetic-card', label: 'Check-in', scheduled_at: '2026-09-29T09:00:00Z' }, latest_activity: { kind: 'Background run', status: 'recorded', at: '2026-09-29T07:35:00Z', summary: 'Synthetic design preview only.' }, services: [{ account_id: 'synthetic-google', email: 'sample@example.test', grants: ['calendar', 'gmail'], health: 'needs_reconnect' }] };
const server = createServer((req, res) => {
  if (req.url === '/console/dashboard/api/v1/overview') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); return; }
  const path = req.url?.startsWith('/console/dashboard/assets/') ? req.url.slice('/console/dashboard/'.length) : 'index.html';
  if (!/^(assets\/[a-zA-Z0-9_.-]+|index\.html)$/.test(path)) { res.writeHead(404); res.end(); return; }
  try {
    const content = readFileSync(new URL(path, dist));
    res.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' });
    if (path === 'index.html') {
      const banner = '<style>body::before{content:"DESIGN PREVIEW | SYNTHETIC DATA | NOT DEPLOYED";position:fixed;bottom:0;left:0;right:0;background:#251f21;color:white;z-index:9999;text-align:center;padding:9px;font:600 12px Inter,Arial,sans-serif}</style>';
      res.end(content.toString().replace('</head>', banner + '</head>'));
    } else res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(4178, '127.0.0.1', () => console.log('Synthetic dashboard preview: http://127.0.0.1:4178'));
