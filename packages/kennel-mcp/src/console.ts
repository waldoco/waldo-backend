import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sessionId = 'kennel-browser-demo';
const child = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL('./stdio-server.js', import.meta.url)),
    '--session-id',
    sessionId,
    '--allow',
    'session_started,permission_requested,turn_started,turn_completed',
  ],
  stderr: 'pipe',
});
const client = new Client({ name: 'kennel-observation-browser-simulator', version: '0.1.0' });
await client.connect(child);

function isLoopback(request: IncomingMessage): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function toolText(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('The local MCP returned an unsupported asynchronous task result.');
  }
  const text = result.content.find(
    (item): item is { type: 'text'; text: string } =>
      typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string',
  )?.text;
  if (text === undefined) throw new Error('The local MCP returned no text result.');
  return JSON.parse(text) as unknown;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > 64 * 1024) throw new Error('Request exceeds the Kennel 64 KiB admission cap.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kennel observation console</title><style>
:root{color-scheme:dark;--ink:#1d2024;--panel:#292d31;--paper:#efe9db;--muted:#b5b4ac;--copper:#c67848;--line:#4a4e51}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#633d2a,transparent 32rem),var(--ink);color:var(--paper);font-family:Georgia,serif}main{max-width:1080px;margin:auto;padding:clamp(1rem,5vw,4rem)}header{border-bottom:1px solid var(--line);padding-bottom:1.5rem;display:flex;justify-content:space-between;gap:1rem}small,button,.data{font-family:ui-monospace,monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--copper)}h1{font-size:clamp(2.4rem,8vw,5rem);font-weight:400;line-height:.9;letter-spacing:-.06em;margin:.35rem 0 0}.badge{height:max-content;border:1px solid var(--copper);padding:.45rem .7rem;border-radius:999px}.grid{display:grid;grid-template-columns:.75fr 1.45fr;gap:1rem;margin-top:1rem}.card{background:#292d31dd;border:1px solid var(--line);padding:1.2rem}.full{grid-column:1/-1}h2{font-size:1.2rem;font-weight:400;margin:0 0 1rem}.data{display:block;color:var(--muted);letter-spacing:0;text-transform:none;padding:.75rem 0;border-top:1px solid var(--line)}.data b{display:block;color:var(--paper);font-weight:400;margin-top:.25rem}button{color:var(--paper);text-align:left;background:transparent;border:1px solid #714631;padding:.8rem;cursor:pointer;transition:.16s}button:hover,button:focus-visible{background:#643d2b;border-color:var(--copper);outline:0}.actions{display:grid;grid-template-columns:repeat(2,1fr);gap:.6rem}.event{display:grid;grid-template-columns:7rem 1fr;gap:.7rem;border-top:1px solid var(--line);padding:.7rem 0;color:var(--muted);font-family:ui-monospace,monospace;font-size:.8rem}.event b{color:var(--paper);font-weight:400}.error b{color:#e4b458}@media(max-width:700px){header,.grid{display:block}.badge{display:inline-block;margin-top:1rem}.card{margin-top:1rem}.actions{grid-template-columns:1fr}.event{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}</style><main><header><div><small>Waldo Ã— Kennel / local observer</small><h1>Keep the signal,<br>not the transcript.</h1></div><div class="badge" id="state">connecting</div></header><div class="grid"><section class="card"><h2>Local session</h2><span class="data">linked session<b id="session">â€”</b></span><span class="data">consented signals<b id="consent">â€”</b></span><span class="data">Kennel delivery<b id="delivery">â€”</b></span></section><section class="card"><h2>Emit a minimized signal</h2><p>This page drives the actual stdio MCP process through a loopback-only development bridge.</p><div class="actions"><button data-kind="session_started">Session started</button><button data-kind="turn_started">Turn started</button><button data-kind="permission_requested">Permission requested</button><button data-kind="turn_completed">Turn completed</button><button data-invalid>Try unlinked session</button></div></section><section class="card full"><h2>Admission thread</h2><div id="thread" aria-live="polite"></div></section></div></main><script>let n=0;const q=s=>document.querySelector(s);function line(name,r){const e=document.createElement('div');e.className='event '+(r.accepted?'':'error');e.innerHTML='<span>'+new Date().toLocaleTimeString()+'</span><span><b>'+((r.accepted?name:r.code)||'event')+'</b><br>'+((r.accepted?(r.deduplicated?'retry deduplicated':r.projection.state+' Â· '+r.projection.attention):r.message)||'')+'</span>';q('#thread').prepend(e)}async function status(){const r=await fetch('/api/status');const v=await r.json();q('#session').textContent=v.linkedSessionId;q('#consent').textContent=v.allowedObservations.join(' Â· ');q('#delivery').textContent=v.kennelDelivery.replaceAll('_',' ');q('#state').textContent=v.projection.state.replace('_',' ')}function event(kind,bad){const o={eventId:'browser-'+(++n),schemaVersion:'1.0',occurredAt:new Date().toISOString(),observation:{kind,provider:'codex',sessionId:bad?'not-linked':'kennel-browser-demo'}};if(kind==='session_started')Object.assign(o.observation,{workingDirectoryName:'waldo-backend',startSource:'browser',initialState:'working'});if(kind==='permission_requested')Object.assign(o.observation,{judgmentId:'browser-judgment',toolName:'apply_patch',reason:'Synthetic fixture'});if(kind==='turn_completed')Object.assign(o.observation,{result:'completed',evidence:'Synthetic fixture'});return o}document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{const kind=b.dataset.kind||'turn_started';const r=await fetch('/api/emit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event(kind,b.hasAttribute('data-invalid')))});line(kind,await r.json());status()});status().catch(e=>line('connection',{code:'MCP_UNAVAILABLE',message:e.message}))</script>`;

const web = createServer(async (request, response) => {
  if (!isLoopback(request)) return void response.writeHead(403).end();
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      json(response, 200, toolText(await client.callTool({ name: 'kennel_get_observation_status' })));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/emit') {
      const result = await client.callTool({ name: 'kennel_publish_observation', arguments: (await body(request)) as Record<string, unknown> });
      json(response, 'isError' in result && result.isError ? 422 : 200, toolText(result));
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    json(response, 400, { code: 'LOCAL_BRIDGE_ERROR', message: error instanceof Error ? error.message : 'Local bridge failed.' });
  }
});

web.listen(4179, '127.0.0.1', () => process.stderr.write('Kennel observation console: http://127.0.0.1:4179\n'));
process.on('SIGINT', async () => { web.close(); await client.close(); });
