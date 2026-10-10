import { appApprovalDecisionResultV1Schema, appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { handleApp } from '../src/channels/app-api';
import { routerSignature } from '../src/identity/owner-directory';
import { sha256Hex } from '../src/connectors/google';

const proof = vi.hoisted(() => ({
  outputs: [] as any[][], telegram: [] as { method: string; body: any }[], moved: 0, sentRaw: [] as string[], eventTag: 'etag-3pm',
}));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  return { id: 'approvals-fixture-reply', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'I proposed moving it to 4.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) => {
  proof.telegram.push({ method, body });
  return method === 'sendMessage' ? { message_id: proof.telegram.length, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true;
} }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: () => ({
    event: async (id: string) => ({ id, etag: proof.eventTag, title: 'Design review', status: 'confirmed', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' }),
    moveEvent: async () => { proof.moved++; proof.eventTag = 'etag-4pm'; return { id: 'ev-3pm', etag: 'etag-4pm' }; },
    sendRaw: async (raw: string) => { proof.sentRaw.push(raw); return { message_id: 'gmail-1' }; },
    findSentByMessageId: async (messageId: string) => proof.sentRaw.length ? { message_id: 'gmail-1', thread_id: 'thread-1', rfc822_message_id: messageId, label_ids: ['SENT'] } : false,
  }) };
});

it('approves from the app with exactly one effect, refuses a stale digest, and retires the other surface', async () => {
  proof.outputs = []; proof.telegram = []; proof.moved = 0; proof.sentRaw = []; proof.eventTag = 'etag-3pm';
  const name = `approvals-app-owner-${crypto.randomUUID()}`, stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const SECRET = 'fictional-approvals-router-secret-0000000000', DIRECTORY = 'https://approvals.fixture.invalid', OWNER = '10000000-0000-0000-0000-0000000000a1', AUTH = '20000000-0000-0000-0000-0000000000a1', EMAIL = 'owner@example.test', TELEGRAM = 424242;
    let hash: string | undefined, live = false; const created = new Date().toISOString(), expires = Date.now() + 3_600_000;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_list') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'approvals-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'assert_channel_presence') { expect(a.p_sig).toBe(await routerSignature(SECRET, a.p_at, `presence.${a.p_do_name}.${a.p_provider}.${a.p_subject}`)); return Response.json(a.p_do_name === name && a.p_provider === 'telegram' && a.p_subject === String(TELEGRAM)); }
      if (fn === 'health_context_read') return Response.json({ context: null, previous: null });
      if (fn === 'health_plane') return Response.json(null);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-webhook-secret', WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined,
      WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'approvals-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key',
      WALDO_ROUTER_HMAC_SECRET: SECRET, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined, GOOGLE_CLIENT_ID: 'fictional-client', GOOGLE_CLIENT_SECRET: 'fictional-secret' };
    const instance = new TelegramOwnerDO(state, settings as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://app.fixture.invalid'); state.storage.kv.put('telegram_subject', String(TELEGRAM));
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
    const routed = { ...settings, TELEGRAM_OWNER_DO: { idFromName: (n: string) => env.TELEGRAM_OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app = async (path: string, body?: unknown, credential?: string) => {
      const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    const list = async (credential: string, query = '') => appApprovalListV1Schema.parse(await (await app(`/approvals${query}`, undefined, credential)).json()).approvals;
    const effects = () => [...state.storage.kv.list<{ owner_ref: string; tool: string; state: string }>({ prefix: 'owner:effect:' })].map(([, record]) => record);
    const telegramDesk = () => (instance as any).setup('telegram').desk;
    try {
      expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
      const credential = (await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json() as { credential: string }).credential;

      const start = '2030-01-02T16:00:00Z', end = '2030-01-02T17:00:00Z';
      proof.outputs.push([{ type: 'function_call', call_id: 'move-3pm', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'move', event_id: 'ev-3pm', title: 'Design review', start, end, reason: 'Owner asked to move it to 4' }) }], []);
      const sent = await (await app('/chat/main/messages', { client_message_id: 'move-3pm-client-0001', text: 'Move my 3pm to 4' }, credential)).json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<any>(`app:inbox-record:${sent.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      expect(state.storage.kv.get('owner_principal_ref')).toBe(`prn_${OWNER.replaceAll('-', '')}`);
      expect(proof.telegram.filter(call => call.method === 'sendMessage')).toEqual([]);

      const history = appHistoryResultV1Schema.parse(await (await app('/chat/main', undefined, credential)).json());
      const reply = history.messages.find(message => message.role === 'assistant' && message.parent_id === sent.message_id)!;
      const part = reply.parts.find(candidate => candidate.type === 'approval') as Extract<(typeof reply.parts)[number], { type: 'approval' }>;
      expect(part).toMatchObject({ kind: 'calendar_change', actions: ['approve', 'edit', 'skip'] });
      expect(part.review).toContain('Design review');
      const [moving] = await list(credential, '?state=open');
      expect(moving).toMatchObject({ approval_id: part.approval_id, state: 'open', presented_surfaces: ['app'], payload_digest: part.payload_digest, exact: { changes: { action: 'move', title: 'Design review', start, end } } });
      const stored = state.storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM ledger WHERE id = ?', part.approval_id).one().payload_json;
      expect(part.payload_digest).toBe(`sha256:${await sha256Hex(stored)}`);

      const stale = await app('/approvals/decisions', { approval_id: part.approval_id, action: 'approve', expected_digest: `sha256:${'0'.repeat(64)}`, request_id: 'move-stale-0001' }, credential);
      expect(stale.status).toBe(409);
      expect(appApprovalDecisionResultV1Schema.parse(await stale.json())).toMatchObject({ receipt: { state: 'rejected' }, approval_state: 'superseded' });
      expect(proof.moved).toBe(0); expect((await list(credential))[0]).toMatchObject({ state: 'open' });

      const decision = { approval_id: part.approval_id, action: 'approve', expected_digest: part.payload_digest, request_id: 'move-decision-0001' };
      const approved = await app('/approvals/decisions', decision, credential);
      expect(approved.status).toBe(200);
      expect(appApprovalDecisionResultV1Schema.parse(await approved.json())).toMatchObject({ receipt: { state: 'recorded', message: 'Done.' }, duplicate: false, approval_state: 'done' });
      expect(proof.moved).toBe(1);
      expect(effects()).toMatchObject([{ owner_ref: `prn_${OWNER.replaceAll('-', '')}`, tool: 'calendar_change', state: 'done' }]);
      const repeated = await app('/approvals/decisions', decision, credential);
      expect(appApprovalDecisionResultV1Schema.parse(await repeated.json())).toMatchObject({ duplicate: true, approval_state: 'done' });
      expect((await app('/approvals/decisions', { ...decision, action: 'skip' }, credential)).status).toBe(409);
      await telegramDesk().callback({ id: 'late-tap', from: { id: TELEGRAM }, data: `a:${part.approval_id}`, message: { message_id: 999, chat: { id: TELEGRAM } } }, 'late-tap');
      expect(proof.telegram.find(call => call.method === 'answerCallbackQuery')?.body.text).toBe('Already handled.');
      expect(proof.moved).toBe(1);

      proof.telegram = [];
      const raw = 'To: sam@example.test\r\nSubject: Friday\r\n\r\nSee you at four.';
      const email = await telegramDesk().proposeSendEmail({ to: ['sam@example.test'], subject: 'Friday', body: 'See you at four.', message_id: '<friday@waldo-send>', raw, digest: await sha256Hex(raw) });
      const card = proof.telegram.find(call => call.method === 'sendMessage' && JSON.stringify(call.body.reply_markup ?? {}).includes(`a:${email}`))!;
      expect(card.body.chat_id).toBe(TELEGRAM);
      const [mail] = (await list(credential, '?state=open')).filter(item => item.approval_id === email);
      expect([...mail!.presented_surfaces!].sort()).toEqual(['app', 'telegram']);
      const emailed = await app('/approvals/decisions', { approval_id: email, action: 'approve', expected_digest: mail!.payload_digest, request_id: 'email-decision-0001' }, credential);
      expect(appApprovalDecisionResultV1Schema.parse(await emailed.json())).toMatchObject({ receipt: { state: 'recorded' }, approval_state: 'done' });
      expect(proof.sentRaw).toEqual([raw]);
      expect(proof.telegram.filter(call => call.method === 'editMessageReplyMarkup')).toEqual([{ method: 'editMessageReplyMarkup', body: { chat_id: TELEGRAM, message_id: proof.telegram.indexOf(card) + 1, reply_markup: { inline_keyboard: [] } } }]);
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM approval_presentations WHERE approval_id = ? AND retired_at IS NULL', email).one().n).toBe(0);

      proof.telegram = [];
      const message = await (instance as any).setup('app').desk.proposeSendMessage({ channel: 'telegram', content: 'Running ten minutes late.', idempotency_key: 'late-0001' });
      const [note] = (await list(credential, '?state=open')).filter(item => item.approval_id === message);
      expect(note).toMatchObject({ presented_surfaces: ['app'], exact: { recipients: { to: ['telegram'], cc: [], bcc: [] } } });
      const messaged = await app('/approvals/decisions', { approval_id: message, action: 'approve', expected_digest: note!.payload_digest, request_id: 'message-decision-0001' }, credential);
      expect(appApprovalDecisionResultV1Schema.parse(await messaged.json())).toMatchObject({ receipt: { state: 'recorded' }, approval_state: 'done' });
      expect(proof.telegram.filter(call => call.method === 'sendMessage').map(call => call.body)).toEqual([{ chat_id: TELEGRAM, text: 'Running ten minutes late.' }]);

      expect((await app('/approvals?state=approved', undefined, credential)).status).toBe(400);
      expect((await app('/approvals')).status).toBe(401);
      expect(effects().filter(record => record.state !== 'done')).toEqual([]);
      expect(effects().every(record => record.owner_ref === `prn_${OWNER.replaceAll('-', '')}`)).toBe(true);
      state.storage.kv.put('owner_principal_ref', `prn_${'f'.repeat(32)}`);
      const foreign = await app('/approvals', undefined, credential);
      expect(foreign.status).toBe(403);
      expect(state.storage.kv.get('owner_principal_ref')).toBe(`prn_${'f'.repeat(32)}`);
    } finally { (instance as any).ownerBrowser.stop(); await (instance as any).ownerBrowser.maintain(); await state.storage.deleteAlarm(); fetcher.mockRestore(); }
  });
}, 30_000);
