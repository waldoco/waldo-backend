#!/usr/bin/env node
// LOCAL trace for the iMessage backend connector. Real workerd (Miniflare, production bundle), real
// PostgreSQL 15 + PostgREST in disposable local containers with all canonical migrations, a scripted
// model served in-process, and a SIMULATED host (not the real waldo-imessage-host). Every outbound
// fetch of the Worker passes through one instrumented boundary; anything that is not the loopback
// database or the in-process scripted model is counted as forbidden egress and fails the trace.
// Nothing here touches Apple, hosted Supabase/Cloudflare, Telegram or a real model.
//   node packages/runtime/scripts/imessage-local-trace.mjs --dry-run   # validate guards, zero calls
//   node packages/runtime/scripts/imessage-local-trace.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY = process.argv.includes('--dry-run');
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(runtime, '../..');
const report = (line) => console.log(`LOCAL trace: ${line}`);
const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const hmac = (key, bytes) => createHmac('sha256', key).update(bytes).digest('hex');
const started = performance.now();

// ---- local-target guard (runs before any request) -------------------------------------------
export const loopbackOrigin = (raw) => {
  let url; try { url = new URL(raw); } catch { throw new Error('origin is not a URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || raw.endsWith('/') && raw.length > url.origin.length + 1) throw new Error(`refusing non-loopback origin ${url.origin}`);
  return url.origin;
};
for (const bad of ['https://example.supabase.co', 'http://user:pw@127.0.0.1:1', 'http://127.0.0.1:1/path', 'http://127.0.0.1:1?x=1', 'http://127.0.0.1.evil.invalid:1', 'http://10.0.0.1:1'])
  assert.throws(() => loopbackOrigin(bad), `guard must refuse ${bad}`);
assert.equal(loopbackOrigin('http://127.0.0.1:5999'), 'http://127.0.0.1:5999');
const dockerContext = DRY ? 'orbstack' : execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim();
assert.ok(['orbstack', 'default', 'desktop-linux'].includes(dockerContext), `refusing non-local docker context ${dockerContext}`);
assert.ok(!process.env.DOCKER_HOST, 'refusing inherited DOCKER_HOST');
report('local-target guard ok (loopback origins only, local docker context, no inherited endpoints)');
if (DRY) { report('dry run: zero containers, zero network calls, zero worker starts'); process.exit(0); }

// ---- disposable PostgreSQL + PostgREST ---------------------------------------------------------
const tag = `waldo-imessage-trace-${randomBytes(4).toString('hex')}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const psql = (sql) => execFileSync('docker', ['exec', '-i', `${tag}-db`, 'psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const cleanup = () => {
  for (const c of [`${tag}-rest`, `${tag}-db`]) try { docker('rm', '-f', c); } catch {}
  try { docker('network', 'rm', tag); } catch {}
};
const routerSecret = randomBytes(32).toString('hex'), wrappingKey = randomBytes(32).toString('hex');
const ownerId = '30000000-0000-4000-8000-000000000001', otherOwnerId = '30000000-0000-4000-8000-000000000002';
const doName = `imessage-trace-owner-${randomBytes(4).toString('hex')}`, otherDo = `${doName}-other`;
const secrets = [routerSecret, wrappingKey];
let mf, outbound = { allowed: 0, model: 0, forbidden: [] }, workerLog = '';
const rpcLog = [];
const policy = { signatureMaxAgeMs: 60000, heartbeatMaxAgeMs: 90000, capabilityMaxAgeMs: 90000, maxRequestBytes: 131072, maxRetainedBytes: 16777216, maxRecords: 4096,
  pullMaxWaitMs: 0, deliveryDeadlineMs: 20000, mutationDeadlineMs: 30000, commitmentMaxAgeMs: 30000, setupLifetimeMs: 600000, replyHandoffMaxAgeMs: 600000,
  source: 'handoff-2026-10-10-proposed-local-test-profile' };
const replyText = 'Local scripted owner reply.';
let modelTurns = 0;

try {
  docker('network', 'create', '--internal', tag);
  docker('run', '-d', '--name', `${tag}-db`, '--network', tag, '--label', 'waldo.imessage.trace=1', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'TZ=UTC', 'postgres:15-bookworm');
  // The image runs a temporary init server first; require several consecutive successful queries.
  for (let ok = 0, i = 0; ok < 4 && i < 120; i++) {
    try { psql('select 1'); ok++; } catch { ok = 0; }
    await new Promise(r => setTimeout(r, 500));
  }
  psql(readFileSync(join(repo, 'scripts/pgtap/shim.sql'), 'utf8'));
  const migrations = readdirSync(join(repo, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const f of migrations) psql(readFileSync(join(repo, 'supabase/migrations', f), 'utf8'));
  report(`real PostgreSQL 15: ${migrations.length} canonical migrations applied (last ${migrations.at(-1)})`);
  psql(`select vault.create_secret('${routerSecret}', 'waldo_router_hmac');
    insert into waldo.owners(id, do_name, email) values ('${ownerId}', '${doName}', 'trace-owner@example.invalid'), ('${otherOwnerId}', '${otherDo}', 'trace-other@example.invalid');
    grant usage on schema waldo to anon;`);
  // PostgREST reaches the database only on the internal network; its port is published on loopback only.
  docker('run', '-d', '--name', `${tag}-rest`, '--network', 'bridge', '--label', 'waldo.imessage.trace=1', '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://postgres@${tag}-db:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=waldo', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', 'PGRST_DB_CHANNEL_ENABLED=false', 'postgrest/postgrest:v12.2.3');
  docker('network', 'connect', tag, `${tag}-rest`);
  const restOrigin = loopbackOrigin(`http://${docker('port', `${tag}-rest`, '3000/tcp').split('\n')[0].replace('0.0.0.0', '127.0.0.1')}`);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(restOrigin + '/')).status < 500) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
  report(`PostgREST on ${new URL(restOrigin).hostname} (loopback-published port)`);

  // ---- production bundle in real workerd -------------------------------------------------------
  const out = mkdtempSync(join(tmpdir(), 'waldo-imessage-bundle-')), persist = mkdtempSync(join(tmpdir(), 'waldo-imessage-do-'));
  execFileSync('pnpm', ['exec', 'wrangler', 'versions', 'upload', '--env', '', '--dry-run', '--outdir', out], { cwd: runtime, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  const { Miniflare } = createRequire(resolve(realpathSync(resolve(runtime, 'node_modules/@cloudflare/vitest-pool-workers')), 'package.json'))('miniflare');
  const config = JSON.parse(readFileSync(resolve(runtime, 'wrangler.jsonc'), 'utf8').replace(/\/\/[^\n]*/g, ''));
  const modelResponse = (body) => {
    const format = body?.text?.format?.name;
    if (!format) modelTurns++;
    const text = format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : replyText;
    return { id: `resp_${randomBytes(6).toString('hex')}`, object: 'response', status: 'completed', model: body?.model ?? 'scripted',
      output: [{ type: 'message', id: `msg_${randomBytes(6).toString('hex')}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  };
  const outboundService = async (request) => {
    const url = new URL(request.url);
    if (url.origin === restOrigin && url.pathname.startsWith('/rest/v1/rpc/')) {
      outbound.allowed++;
      const headers = new Headers(request.headers); headers.delete('apikey');
      const response = await fetch(`${restOrigin}${url.pathname.slice('/rest/v1'.length)}`, { method: request.method, headers, body: await request.text(), redirect: 'error' });
      rpcLog.push(`${url.pathname.split('/').at(-1)} ${response.status}`);
      return response;
    }
    if (url.hostname === 'api.openai.com' && url.pathname === '/v1/responses') { outbound.model++; return Response.json(modelResponse(await request.json())); }
    outbound.forbidden.push(url.origin);
    return new Response('forbidden egress', { status: 599 });
  };
  const start = async () => {
    mf = new Miniflare({ host: '127.0.0.1', port: 0, handleRuntimeStdio: (stdout, stderr) => { for (const s of [stdout, stderr]) s.on('data', c => { workerLog += c.toString(); }); },
      durableObjectsPersist: persist,
      workers: [{ outboundService, modules: true, modulesRoot: out, scriptPath: resolve(out, 'index.js'), compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags ?? [],
        bindings: { WALDO_RELEASE: 'imessage-local-trace', WALDO_ENVIRONMENT: 'test', WALDO_OWNER_DO_NAMESPACE: '', WALDO_OWNER_TELEGRAM_ID: '', WALDO_EGRESS_ALLOWLIST: '', LANGFUSE_CAPTURE_TEXT: 'false',
          COMMON_OWNER_TASKS: '0', WALDO_TOOL_OFFLOAD: '0', WALDO_OWNER_TIMEZONE: 'UTC', OPENAI_API_KEY: `fictional-${randomBytes(8).toString('hex')}`,
          SUPABASE_PROJECT_URL: restOrigin, SUPABASE_PUBLISHABLE_KEY: `fictional-${randomBytes(8).toString('hex')}`, WALDO_ROUTER_HMAC_SECRET: routerSecret,
          IMESSAGE_CONNECTOR_ENABLED: '1', IMESSAGE_CONNECTOR_POLICY: JSON.stringify(policy), IMESSAGE_CREDENTIAL_WRAPPING_KEY: wrappingKey },
        durableObjects: Object.fromEntries(config.durable_objects.bindings.map(b => [b.name, { className: b.class_name, useSQLite: true }])),
        ratelimits: { RESPONSIBILITY_RATE_LIMITER: { simple: { limit: 120, period: 60 } } } }] });
    return loopbackOrigin((await mf.ready).origin);
  };
  let origin = await start();
  report(`real workerd (production bundle) on ${new URL(origin).hostname}; durable objects persisted to a scratch dir`);
  const http = (path, init = {}) => fetch(origin + path, { redirect: 'manual', ...init });

  // ---- owner console session (seeded fixture session, real cookie/CSRF path) ------------------
  const consoleSession = async (name, owner) => {
    const session = randomBytes(16).toString('hex');
    psql(`insert into waldo.console_sessions(owner_id, session_hash) values ('${owner}', '${sha256(session.trim().toUpperCase())}');`);
    const ownerNs = await mf.getDurableObjectNamespace('TELEGRAM_OWNER_DO');
    const grant = await (ownerNs.get(ownerNs.idFromName(name))).fetch('http://owner.invalid/grant-console', { method: 'POST', headers: { 'x-waldo-do-name': name } });
    const consoleToken = await grant.text();
    const cookie = `waldo_console=${consoleToken}; waldo_owner=${encodeURIComponent(name)}.${session}.${hmac(routerSecret, `0.cookie.${name}.${session}`)}`;
    const page = await http('/console/imessage', { headers: { cookie } });
    if (page.status !== 200 && process.env.IMESSAGE_TRACE_DEBUG === '1') console.error(`console page ${page.status}: ${(await page.clone().text()).slice(0, 300)}`);
    assert.equal(page.status, 200, 'authenticated iMessage console page');
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf, 'console exposes CSRF');
    const action = (a, fields = {}) => http('/console/action', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ action: a, csrf, ...fields }) });
    return { cookie, action, page: () => http('/console/imessage', { headers: { cookie } }) };
  };
  const owner = await consoleSession(doName, ownerId);

  // ---- simulated host ---------------------------------------------------------------------------
  const host = (label) => {
    const h = { label, bridgeId: '', accountId: '', key: '', generation: `trace-gen-${label}`, seq: 0, journal: new Map(), sends: 0 };
    h.signed = (path, body, o = {}) => {
      const fields = { version: 1, bridgeId: o.bridgeId ?? h.bridgeId, accountId: h.accountId, atMs: o.atMs ?? Date.now(), nonce: o.nonce ?? `trace-${randomBytes(8).toString('hex')}` };
      const signature = hmac(o.key ?? h.key, Buffer.concat([Buffer.from(JSON.stringify([1, fields.bridgeId, fields.accountId, fields.atMs, fields.nonce]) + '\n'), Buffer.from(body, 'utf8')]));
      return http(`/channels/imessage/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-waldo-imessage-s2': JSON.stringify({ ...fields, signature }) }, body });
    };
    h.scope = () => ({ version: 1, bridgeId: h.bridgeId, accountId: h.accountId });
    h.message = (text, o = {}) => { const n = ++h.seq, sender = o.sender ?? 'owner@example.invalid';
      return { version: 1, bridgeId: h.bridgeId, accountId: h.accountId, eventId: o.eventId ?? `trace-${label}-${n}`, cursor: { databaseGeneration: h.generation, value: String(n) },
        occurredAt: new Date(Date.now() - 1000).toISOString(), service: o.service ?? 'iMessage', senderHandle: sender, chatGuid: o.chat ?? `iMessage;-;${sender}`, participants: [sender],
        isGroup: o.isGroup ?? false, isFromMe: o.isFromMe ?? false, messageGuid: `trace-guid-${label}-${n}`, partIndex: 0, kind: 'message', text, attachments: [] }; };
    h.heartbeat = () => h.signed('/heartbeat', JSON.stringify({ ...h.scope(), databaseGeneration: h.generation, status: 'online' }));
    h.capabilities = () => {
      const features = Object.fromEntries(['text', 'files', 'replies', 'standard_reactions', 'custom_reactions', 'formatting', 'url_preview', 'effects', 'native_voice', 'typing', 'read_receipts', 'edit', 'unsend', 'stickers', 'polls', 'groups', 'group_mutations', 'name_photo_sharing']
        .map(f => [f, f === 'text' ? { receive: true, send: true, exactTarget: true, verified: true, probeReference: 'trace-probe' } : { receive: false, send: false, exactTarget: false, verified: false }]));
      return h.signed('/capabilities', JSON.stringify({ ...h.scope(), transport: 'imsg', hostVersion: 'trace-host', transportVersion: 'trace', readiness: 'ready', features }));
    };
    h.pull = async () => { const r = await h.signed('/commands/pull', JSON.stringify(h.scope())); return { status: r.status, delivery: r.status === 200 ? (await r.json()).delivery : null }; };
    h.execute = (d) => {
      const digest = sha256(d.body), command = JSON.parse(d.body);
      if (h.journal.has(command.commandId)) { assert.equal(h.journal.get(command.commandId).digest, digest); return h.journal.get(command.commandId).result; }
      const s2ok = hmac(h.key, Buffer.concat([Buffer.from(JSON.stringify([1, d.headers.bridgeId, d.headers.accountId, d.headers.atMs, d.headers.nonce]) + '\n'), Buffer.from(d.body, 'utf8')])) === d.headers.signature;
      const cText = JSON.stringify(['waldo-imessage-http-v1:commitment', 1, h.bridgeId, h.accountId, d.deliveryId, command.commandId, digest, d.commitment.expiresAtMs]);
      const ok = s2ok && d.commitment.commandDigest === digest && hmac(h.key, Buffer.from(cText, 'utf8')) === d.commitment.signature && Date.now() <= d.commitment.expiresAtMs && command.allowSMSFallback === false;
      const result = ok ? { version: 1, commandId: command.commandId, target: command.target, state: 'local_recorded', messageGuid: `trace-sent-${command.commandId}`, evidence: { kind: 'local_database', reference: `trace-row-${++h.sends}` } }
        : { version: 1, commandId: command.commandId, target: command.target, state: 'rejected', disposition: 'not_started', reason: 'commitment_invalid' };
      h.journal.set(command.commandId, { digest, result });
      return result;
    };
    h.postResult = (d, result, digest = sha256(d.body)) => h.signed('/commands/result', JSON.stringify({ ...h.scope(), deliveryId: d.deliveryId, commandId: JSON.parse(d.body).commandId, commandDigest: digest, result }));
    return h;
  };
  const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
  const pump = async () => {
    // Alarms fire on their own in workerd; give the persisted wakes time to run end to end.
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); }
  };

  // 1. Invitation, redeem, pending scope cannot reach private turns or commands.
  const A = host('a');
  const pair = await owner.action('imessage.pair');
  assert.equal(pair.status, 200); assert.match(pair.headers.get('cache-control') ?? '', /no-store/);
  const code = (await pair.text()).split('\n')[0]; secrets.push(code);
  const redeem = (c) => http('/channels/imessage/v1/pair/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, code: c, hostVersion: 'trace-host', transportVersion: 'waldo-imessage-http-v1', databaseGeneration: A.generation }) });
  const redeemed = await redeem(code); assert.equal(redeemed.status, 200);
  const grant = await redeemed.json(); Object.assign(A, { bridgeId: grant.bridgeId, accountId: grant.accountId, key: grant.credential.key }); secrets.push(A.key);
  assert.equal((await redeem(code)).status, 401, 'invitation is one-use');
  assert.equal(psql(`select state from waldo.imessage_bridges where bridge_id='${A.bridgeId}'`), 'pending');
  assert.equal(psql(`select count(*) from waldo.imessage_bridges where wrapped_credential like '%${A.key}%'`), '0', 'database never holds the plaintext key');
  assert.equal((await A.heartbeat()).status, 200);
  assert.equal((await A.pull()).status, 401, 'pending credential cannot pull commands');
  assert.equal((await A.signed('/events', JSON.stringify(A.message('private question before verification')))).status, 401, 'pending credential cannot submit owner turns');
  report('1 invitation/redeem ok; pending credential: heartbeat 200, pull 401, owner turn 401; DB holds only wrapped credential');

  // 2. Wrong challenge/sender rejects; exact challenge + console confirmation activates.
  const verify = await owner.action('imessage.verify', { id: A.bridgeId, subject: SUBJECT, chat: CHAT });
  const challenge = (await verify.text()).split('\n')[0]; secrets.push(challenge);
  assert.equal((await A.signed('/events', JSON.stringify(A.message(challenge, { sender: 'alias@example.invalid' })))).status, 401);
  assert.equal((await A.signed('/events', JSON.stringify(A.message('wic_' + '0'.repeat(48))))).status, 401);
  assert.equal((await owner.action('imessage.activate', { id: A.bridgeId, subject: SUBJECT, chat: CHAT })).status, 400, 'nothing observed yet');
  assert.equal((await A.signed('/events', JSON.stringify(A.message(challenge)))).status, 200);
  assert.equal((await owner.action('imessage.activate', { id: A.bridgeId, subject: SUBJECT, chat: CHAT })).status, 303);
  assert.equal(psql(`select b.state || '/' || p.provider || '/' || p.state from waldo.imessage_bridges b join waldo.presences p on p.id = b.presence_id where b.bridge_id='${A.bridgeId}'`), 'active/imessage/active');
  report('2 wrong sender/challenge 401; exact challenge + owner confirmation activated a real presence row');

  // 3. Heartbeat + fresh verified text capabilities.
  assert.equal((await A.heartbeat()).status, 200); assert.equal((await A.capabilities()).status, 200);
  report('3 heartbeat + verified text capability accepted');

  // 4. Signed direct message -> durable ACK -> genuine owner runtime -> one frozen reply.
  const event = A.message('What matters most today?'), body = JSON.stringify(event);
  const ack = await A.signed('/events', body); assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), { admitted: true, eventId: event.eventId, digest: sha256(body) });
  let delivery = null;
  for (let i = 0; i < 80 && !delivery; i++) { await new Promise(r => setTimeout(r, 250)); delivery = (await A.pull()).delivery; }
  assert.ok(delivery, 'frozen reply reached the bridge mailbox');
  assert.equal(modelTurns, 1, 'exactly one owner turn ran');
  const command = JSON.parse(delivery.body);
  assert.equal(command.text, replyText); assert.equal(command.allowSMSFallback, false);
  assert.deepEqual(command.target, { bridgeId: A.bridgeId, accountId: A.accountId, chatGuid: CHAT });
  report('4 signed event ACKed with raw digest; one genuine owner turn (scripted model); one frozen reply to the exact chat');

  // 5. Host validates command + commitment, journals, posts matched local_recorded.
  const result = A.execute(delivery); assert.equal(result.state, 'local_recorded');
  assert.equal((await A.postResult(delivery, result)).status, 200);
  report('5 host verified S2 + commitment, journaled, posted local_recorded (not delivered)');

  // 6. Lost event ACK: identical body + fresh nonce -> same receipt, no second turn; changed body conflicts.
  const again = await A.signed('/events', body); assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { admitted: true, eventId: event.eventId, digest: sha256(body) });
  assert.equal((await A.signed('/events', JSON.stringify({ ...event, text: 'changed bytes' }))).status, 409);
  await pump(); assert.equal(modelTurns, 1, 'no second turn after lost ACK');
  report('6 lost ACK retry same receipt, no second turn; changed body 409');

  // 7. Lost pull/result ACK, terminal repeat and worker restart: no second native send.
  assert.equal((await A.postResult(delivery, result)).status, 200, 'identical terminal repeat');
  await mf.dispose(); origin = await start();
  assert.equal((await A.heartbeat()).status, 200);
  assert.equal((await A.pull()).delivery, null, 'settled command never redelivered after restart');
  assert.equal(A.sends, 1);
  report('7 terminal repeat 200; workerd restart (persisted DOs): no redelivery, one native send');

  // 8. Wrong digest/target results are refused; an unknown result quarantines the lane permanently.
  await A.signed('/events', JSON.stringify(A.message('Second question')));
  let d2 = null; for (let i = 0; i < 80 && !d2; i++) { await new Promise(r => setTimeout(r, 250)); d2 = (await A.pull()).delivery; }
  assert.ok(d2);
  const c2 = JSON.parse(d2.body);
  assert.equal((await A.postResult(d2, A.execute(d2), '0'.repeat(64))).status, 409, 'wrong digest');
  assert.equal((await A.postResult(d2, { version: 1, commandId: c2.commandId, target: { ...c2.target, chatGuid: 'iMessage;-;other@example.invalid' }, state: 'unknown', disposition: 'may_have_completed', reason: 'x' })).status, 409, 'wrong target');
  assert.equal((await A.postResult(d2, { version: 1, commandId: c2.commandId, target: c2.target, state: 'unknown', disposition: 'may_have_completed', reason: 'native_timeout' })).status, 200);
  assert.equal((await A.postResult(d2, A.execute(d2))).status, 409, 'late success cannot replace the first terminal result');
  report('8 wrong digest/target 409; unknown result accepted and quarantines; late success 409');

  // 11. Quarantine survives restart and late results; status stays available.
  await mf.dispose(); origin = await start();
  await A.heartbeat(); await A.capabilities();
  await A.signed('/events', JSON.stringify(A.message('Third question')));
  await pump();
  assert.equal((await A.pull()).delivery, null, 'quarantined lane publishes nothing');
  const page = await (await owner.page()).text();
  assert.match(page, /sending paused/);
  report('11 quarantine survived restart; new replies not published; console status still available');

  // 10. Non-turn events and isolation.
  const before = modelTurns;
  for (const e of [A.message('group', { isGroup: true, chat: 'iMessage;+;trace-group', sender: 'x@example.invalid' }), A.message('sms', { service: 'SMS', chat: 'SMS;-;+15550000009', sender: '+15550000009' }),
    A.message('echo', { isFromMe: true }), A.message('stranger', { sender: 'stranger@example.invalid' })]) assert.equal((await A.signed('/events', JSON.stringify(e))).status, 200);
  await pump(); assert.equal(modelTurns, before, 'groups/SMS/echo/unknown sender never become turns');
  const other = await consoleSession(otherDo, otherOwnerId);
  assert.equal((await other.action('imessage.revoke', { id: A.bridgeId })).status, 400, 'another owner cannot revoke');
  const B = host('b');
  const codeB = (await (await other.action('imessage.pair')).text()).split('\n')[0]; secrets.push(codeB);
  const gB = await (await redeem(codeB)).json(); Object.assign(B, { bridgeId: gB.bridgeId, accountId: gB.accountId, key: gB.credential.key }); secrets.push(B.key);
  assert.equal((await B.signed('/commands/pull', JSON.stringify({ version: 1, bridgeId: A.bridgeId, accountId: B.accountId }), { bridgeId: A.bridgeId })).status, 401, 'foreign bridge with own key');
  assert.equal((await A.signed('/commands/pull', JSON.stringify(A.scope()), { key: B.key })).status, 401, 'own bridge with foreign key');
  report('10 group/SMS/echo/stranger produced no turns; cross-owner revoke and cross-account pulls refused');

  // 9. Revoke: canonical first, then reconnects rejected; evidence retained.
  assert.equal((await owner.action('imessage.revoke', { id: A.bridgeId })).status, 303);
  assert.equal(psql(`select state from waldo.imessage_bridges where bridge_id='${A.bridgeId}'`), 'revoked');
  for (const r of [await A.heartbeat(), await A.signed('/events', JSON.stringify(A.message('after revoke')))]) assert.equal(r.status, 401);
  assert.equal((await A.pull()).status, 401);
  assert.equal(psql(`select count(*) from waldo.presences where provider='imessage' and state='active'`), '0');
  report('9 revoke committed canonically; heartbeat/events/pull rejected afterwards; presence unlinked');

  // Real concurrency (parallel PostgreSQL connections through PostgREST): one-use consumption and live-subject uniqueness.
  const rpc = async (fn, op, params) => {
    const locator = JSON.stringify(Object.values(params)), at = Math.floor(Date.now() / 1000);
    const sig = hmac(routerSecret, `${at}.imsg.${op}.${sha256(locator)}`);
    const r = await fetch(`${restOrigin}/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-profile': 'waldo' }, body: JSON.stringify({ ...params, p_locator: locator, p_at: at, p_sig: sig }) });
    assert.equal(r.status, 200, `${fn} reachable`); return r.json();
  };
  const raceCode = sha256(`race-${randomBytes(8).toString('hex')}`);
  assert.equal(await rpc('imessage_issue_invitation', 'invite', { p_do_name: otherDo, p_environment: 'test', p_code_hash: raceCode, p_lifetime_seconds: 600 }), true);
  const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => rpc('imessage_redeem_invitation', 'redeem', { p_code_hash: raceCode, p_environment: 'test',
    p_bridge_id: `imb_${randomBytes(16).toString('hex')}`, p_account_id: `ima_${randomBytes(16).toString('hex')}`, p_wrapped_credential: `v1.${'0'.repeat(24)}.${'ab'.repeat(20)}`,
    p_host_version: 'race', p_transport_version: 'race', p_generation: `race-${i}`, p_pending_seconds: 600 })));
  assert.equal(racers.filter(r => r !== null).length, 1, 'six parallel redemptions of one invitation: exactly one wins');
  const raceSubject = `race-${randomBytes(4).toString('hex')}@example.invalid`, raceChat = `iMessage;-;${raceSubject}`;
  const raceOwners = [0, 1].map(i => ({ id: `40000000-0000-4000-8000-00000000000${i}`, name: `${doName}-race-${i}`, bridge: `imb_${randomBytes(16).toString('hex')}` }));
  psql(raceOwners.map(o => `insert into waldo.owners(id, do_name, email) values ('${o.id}', '${o.name}', '${o.name}@example.invalid');
    insert into waldo.imessage_bridges(bridge_id, account_id, owner_id, environment, state, wrapped_credential, host_version, transport_version, database_generation, pending_expires_at,
      expected_subject, expected_chat_guid, challenge_hash, challenge_expires_at, observed_subject, observed_chat_guid, observed_at)
    values ('${o.bridge}', 'ima_${randomBytes(16).toString('hex')}', '${o.id}', 'test', 'pending', 'v1.${'0'.repeat(24)}.${'ab'.repeat(20)}', 'race', 'race', 'race', now() + interval '10 minutes',
      '${raceSubject}', '${raceChat}', '${'c'.repeat(64)}', now() + interval '10 minutes', '${raceSubject}', '${raceChat}', now());`).join('\n'));
  const activations = await Promise.all(raceOwners.map(o => rpc('imessage_activate', 'activate', { p_do_name: o.name, p_bridge_id: o.bridge, p_subject: raceSubject, p_chat_guid: raceChat })));
  assert.equal(activations.filter(a => a !== null).length, 1, 'two owners racing for one Apple sender: exactly one activation');
  assert.equal(psql(`select count(*) from waldo.presences where provider='imessage' and subject='${raceSubject}' and state='active'`), '1');
  report('concurrency: 6 parallel redemptions -> 1 winner; 2 owners racing one sender -> 1 active binding (real PostgreSQL transactions)');

  // 12. Egress and log redaction.
  assert.deepEqual(outbound.forbidden, [], 'forbidden outbound network must be zero');
  for (const s of secrets) assert.ok(!workerLog.includes(s), 'worker logs never contain keys, codes or challenges');
  assert.ok(!workerLog.includes(SUBJECT), 'worker logs never contain the Apple sender handle');
  for (const text of ['What matters most today?', 'Second question', replyText]) assert.ok(!workerLog.includes(text), 'worker logs never contain private message or reply text');
  report(`12 outbound: ${outbound.allowed} loopback database calls, ${outbound.model} in-process scripted model calls, forbidden egress ${outbound.forbidden.length}; ${workerLog.length} bytes of worker stdout/stderr captured, none containing keys, codes, challenges or the sender handle`);
  report(`PASS in ${Math.round(performance.now() - started)} ms. Simulated host only; real host, Apple delivery, recipient readback and deployment UNVERIFIED.`);
  await mf.dispose(); mf = undefined;
  rmSync(out, { recursive: true, force: true }); rmSync(persist, { recursive: true, force: true });
} catch (error) {
  console.error(`LOCAL trace: FAIL ${error instanceof Error ? error.message : String(error)}`);
  // Redacted diagnostics: every known secret is masked before anything is printed.
  let tail = workerLog.slice(-4000);
  for (const secret of secrets) tail = tail.split(secret).join('[redacted]');
  if (process.env.IMESSAGE_TRACE_DEBUG === '1') console.error(`LOCAL trace: rpc ${rpcLog.slice(-30).join(', ')}\nLOCAL trace: worker log tail (redacted)\n${tail}`);
  if (outbound.forbidden.length) console.error(`LOCAL trace: forbidden egress origins ${[...new Set(outbound.forbidden)].join(', ')}`);
  process.exitCode = 1;
} finally {
  try { await mf?.dispose(); } catch {}
  cleanup();
  const left = execFileSync('docker', ['ps', '-aq', '--filter', `name=${tag}`], { encoding: 'utf8' }).trim();
  report(left ? `WARNING owned containers remain: ${left}` : 'owned containers and network removed');
}
