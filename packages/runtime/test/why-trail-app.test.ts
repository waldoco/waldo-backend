import { appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';

// "Why this changed" over the app endpoints: an app chat turn reads the calendar and proposes a move with the steps behind
// it; /approvals shows them to approvals=8 and never below, and the day view shows a day card's to controls=14 and never below.
const proof = vi.hoisted(() => ({ outputs: [] as any[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  return { id: 'why-fixture-reply', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'I proposed moving it to Thursday.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) =>
  method === 'sendMessage' ? { message_id: 1, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: () => ({
    events: async () => [{ id: 'ev-3pm', title: 'Design review', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z', all_day: false }],
    event: async (id: string) => ({ id, etag: 'etag-3pm', title: 'Design review', status: 'confirmed', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' }),
  }) };
});

it('the app reads the steps behind a card at approvals=8 and a day card\'s at controls=14, and nothing below either', async () => {
  proof.outputs = [];
  const name = `why-app-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const DIRECTORY = 'https://why.fixture.invalid', OWNER = '10000000-0000-0000-0000-0000000000b1', AUTH = '20000000-0000-0000-0000-0000000000b1', EMAIL = 'owner@example.test';
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
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(Date.parse(created) + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'why-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'assert_channel_presence') return Response.json(false);
      if (fn === 'health_context_read') return Response.json({ context: null, previous: null });
      if (fn === 'health_plane') return Response.json(null);
      return Response.json(null);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', TELEGRAM_WEBHOOK_SECRET: 'fictional-webhook-secret', WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined,
      WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'why-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key',
      WALDO_ROUTER_HMAC_SECRET: 'fictional-why-router-secret-00000000000000', RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined, GOOGLE_CLIENT_ID: 'fictional-client', GOOGLE_CLIENT_SECRET: 'fictional-secret',
      WHY_TRAIL: '1' };
    const instance = new OwnerDO(state, settings as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://app.fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', scopes: null, refresh_token: 'fictional-not-a-token' }]);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    const app = async (path: string, body?: unknown, credential?: string, contract?: string) => {
      const response = await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(contract ? { [APP_CONTRACT_HEADER]: contract } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try {
      expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
      const credential = (await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json() as { credential: string }).credential;

      proof.outputs.push(
        [{ type: 'function_call', call_id: 'read-day', name: 'query_calendar', arguments: JSON.stringify({ date_range: { from: '2030-01-02T00:00:00+00:00', to: '2030-01-03T00:00:00+00:00' } }) }],
        [{ type: 'function_call', call_id: 'move-3pm', name: 'propose_calendar_change', arguments: JSON.stringify({ action: 'move', event_id: 'ev-3pm', title: 'Design review', start: '2030-01-03T11:00:00Z', end: '2030-01-03T12:00:00Z', reason: 'Clears the clash',
          why: [
            { verb: 'checked', label: 'Found the 3pm clash', source: { kind: 'calendar_event', ref: 'ev-3pm' } },
            { verb: 'read', label: "Read Priya's reply", source: { kind: 'mail_thread', ref: 'thr-priya' } },
          ] }) }],
        [],
      );
      const sent = await (await app('/chat/main/messages', { client_message_id: 'why-move-client-0001', text: 'Sort out my 3pm clash' }, credential)).json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<any>(`app:inbox-record:${sent.message_id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });

      const list = async (contract?: string) => appApprovalListV1Schema.parse(await (await app('/approvals', undefined, credential, contract)).json()).approvals;
      const [explained] = await list('approvals=8');
      expect(explained).toMatchObject({ kind: 'calendar_change', exact: { changes: { action: 'move', title: 'Design review' } } });
      expect(explained!.why).toEqual([{ at: expect.any(Number), verb: 'checked', label: 'Found the 3pm clash', source: 'calendar_event' }]);
      for (const contract of ['approvals=7', undefined]) expect((await list(contract))[0]!.why).toBeUndefined();
      const stored = state.storage.sql.exec<{ payload_json: string; summary: string }>('SELECT payload_json, summary FROM ledger WHERE id = ?', explained!.approval_id).one();
      expect(`${stored.payload_json}${stored.summary}`).not.toContain('3pm clash');

      const today = new Date().toISOString().slice(0, 10);
      dayPlanBook(state.storage.sql).why(today, 'card:brief', JSON.stringify([{ at: explained!.why![0]!.at, verb: 'checked', label: 'Found the 3pm clash', source: { kind: 'calendar_event', ref: 'ev-3pm' } }]));
      const day = async (contract: string) => (await (await app('/controls?view=day', undefined, credential, contract)).json() as { data: { cards: { id: string; why?: unknown }[] } }).data.cards;
      expect((await day('controls=14')).find(card => card.id === 'card:brief')?.why).toEqual(explained!.why);
      expect((await day('controls=13')).every(card => card.why === undefined)).toBe(true);
    } finally { (instance as any).ownerBrowser.stop(); await (instance as any).ownerBrowser.maintain(); await state.storage.deleteAlarm(); fetcher.mockRestore(); }
  });
}, 30_000);
