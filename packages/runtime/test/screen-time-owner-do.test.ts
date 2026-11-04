import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { presenceAuthority } from './helpers/directory-presence';

// get_screen_time through the whole owner object, against a fake health plane that answers waldo.screen_time_days_read. The tool
// is offered only while SCREEN_TIME is on; on, the model's call reaches one signed read for the agent purpose and the stored days
// come back to the model in that turn, and nowhere else. Every value is synthetic.
const proof = vi.hoisted(() => ({ outputs: [] as unknown[][], replies: [] as string[], requests: [] as string[], rpc: [] as { fn: string; payload: string }[], answer: null as unknown }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.requests.push(JSON.stringify(input));
  return { id: 'screen-time-fixture-reply', output: format ? [] : proof.outputs.shift() ?? [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : proof.replies.shift() ?? 'Noted.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string, body: any) =>
  method === 'sendMessage' ? { message_id: 1, chat: { id: body.chat_id } } : method === 'getMe' ? { username: 'fixture_bot' } : true }));

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1] ?? 'other';
    const payload = String((JSON.parse(String(init?.body ?? '{}')) as { p_payload?: string }).p_payload ?? '');
    proof.rpc.push({ fn, payload });
    if (fn === 'common_owner_authority') return presenceAuthority('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', init?.body);
    if (fn === 'screen_time_days_read') return Response.json(proof.answer);
    if (fn === 'health_context_read') return Response.json(null);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); proof.outputs = []; proof.replies = []; proof.requests = []; proof.rpc = []; proof.answer = null; });

const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const call = (call_id: string, name: string, args: unknown) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) });
const toolOutput = (callId: string) => {
  for (const request of proof.requests) {
    const { input } = JSON.parse(request) as { input: unknown };
    const item = Array.isArray(input) ? (input as { type?: string; call_id?: string; output?: string }[]).find(entry => entry.type === 'function_call_output' && entry.call_id === callId) : undefined;
    if (item) return item.output ?? '';
  }
  return null;
};
// Declared to the model: a function in the request's tools, or one inside a tool-search namespace.
const declared = (tools: unknown): boolean => Array.isArray(tools) && tools.some((tool: { name?: string; tools?: unknown }) => tool?.name === 'get_screen_time' || declared(tool?.tools));
const offered = () => proof.requests.some(request => declared((JSON.parse(request) as { tools?: unknown }).tools));
const text = (update_id: number, words: string) => ({ update_id, message: { message_id: update_id, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: words } });

const withOwner = async (flag: string | undefined, body: (deliver: (update: unknown) => Promise<void>, state: DurableObjectState) => Promise<void>) => {
  const name = `screen-time-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const originalNow = Date.now;
    let now = Date.parse('2026-11-03T06:00:00Z');
    Date.now = () => now;
    const owner = new OwnerDO(state, { ...env, ...directory, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', COMMON_OWNER_TASKS: '0', BROWSER: undefined,
      ...(flag === undefined ? {} : { SCREEN_TIME: flag }) } as never);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7'); state.storage.kv.put('origin', 'https://owner.fixture.invalid');
    const deliver = async (update: unknown) => {
      expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify(update) }))).status).toBe(200);
      for (let i = 0; i < 3; i++) { now += 61_000; state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); }
    };
    try { await body(deliver, state); } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};

const summary = { day: '2026-11-02', timezone: 'UTC', platform: 'android', coverage: 'complete', screen_on_minutes: 377, pickups: 83, unlocks: 70, late_night_minutes: 41, late_night_window: '23:00-05:00' };
const range = { from: '2026-10-27', to: '2026-11-02' };

describe('get_screen_time through the owner object', () => {
  it('is not offered while SCREEN_TIME is off', async () => {
    for (const flag of [undefined, '0']) {
      await withOwner(flag, async deliver => {
        proof.outputs.push([call('st-off', 'get_screen_time', range)], []);
        proof.replies.push('', 'I can\'t see that.');
        await deliver(text(600, 'How much was I on my phone last week?'));
        expect(offered(), String(flag)).toBe(false);
        expect(toolOutput('st-off'), String(flag)).not.toContain('"ok":true');
        expect(proof.rpc.filter(entry => entry.fn.startsWith('screen_time_')), String(flag)).toEqual([]);
      });
      proof.requests = []; proof.rpc = [];
    }
  });

  it('on, the model reads the stored days through one signed read for the agent purpose, and nothing keeps them', async () => {
    proof.answer = { days: [{ device_id: '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', device: 1, received_at: '2026-11-03T01:00:00.000Z', summary }] };
    await withOwner('1', async (deliver, state) => {
      proof.outputs.push([call('st-on', 'get_screen_time', range)], []);
      proof.replies.push('', 'About six hours yesterday.');
      await deliver(text(601, 'How much was I on my phone yesterday?'));
      expect(offered()).toBe(true);
      const reads = proof.rpc.filter(entry => entry.fn.startsWith('screen_time_'));
      expect(reads.map(entry => [entry.fn, JSON.parse(entry.payload)])).toEqual([['screen_time_days_read', { ...range, purpose: 'model' }]]);
      const output = JSON.parse(toolOutput('st-on')!) as { ok: boolean; data: { state: string; days: { screen_on_minutes: number; device: number }[] } };
      expect(output).toMatchObject({ ok: true, data: { state: 'available', days: [{ day: '2026-11-02', device: 1, screen_on_minutes: 377, late_night_minutes: 41 }] } });
      // turn_only_output: the numbers live in the turn that asked, not in the owner object's storage.
      const kept = [...state.storage.kv.list()].map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')
        + state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
          .map(({ name }) => { try { return JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()); } catch { return ''; } }).join('\n');
      expect(kept).not.toContain('screen_on_minutes');
    });
  });
});
