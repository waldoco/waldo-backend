// Actual deployed constructor, authenticated Telegram inbox and alarm, and the production handler wiring.
// Only the model, Telegram and the signed owner directory are local fixtures.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { routerSignature } from '../src/identity/owner-directory';

type RequestBody = { tools?: { name: string }[]; text?: { format?: { name?: string } } };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[] }));
vi.mock('../src/channels/telegram-api', async load => ({
  ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true,
}));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const text = format === 'task_source_scope' ? '{"decision":"retain","sources":[]}'
      : format === 'claim_ops' ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'reaction' ? '{"reaction":"👌"}' : format ? 'Local structured fixture.' : 'Fixture reply.';
    return { id: 'fixture', output_text: text, output: [], usage: { input_tokens: 1, output_tokens: 1 } };
  } };
} }));

const OWNER = '10000000-0000-0000-0000-000000000001';
const PRESENCE = '10000000-0000-0000-0000-00000000000a';
const SUBJECT = '81101';
beforeEach(() => { model.requests = []; });

// One owner Telegram turn against a directory that lists these devices; returns the tool names the model was offered.
async function ownerTurn(devices: readonly object[]): Promise<readonly string[]> {
  const name = `use-mac-eligibility-${crypto.randomUUID()}`;
  const unexpected: string[] = [];
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const fixtureEnv = { ...env, WALDO_ENVIRONMENT: 'fixture', WALDO_OWNER_DO_NAMESPACE: 'fixture-owner-namespace',
      TELEGRAM_BOT_TOKEN: '12345:fictional', TELEGRAM_WEBHOOK_SECRET: 'fictional-inbox-secret', OPENAI_API_KEY: 'fictional-model-key',
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret' };
    const mapping = { owner_id: OWNER, environment: fixtureEnv.WALDO_ENVIRONMENT, namespace: fixtureEnv.WALDO_OWNER_DO_NAMESPACE, do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const locator = JSON.stringify([mapping.environment, mapping.namespace, name, mapping.do_id]);
    const locatorHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(locator)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const directory = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input), prefix = `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`;
      if (!url.startsWith(prefix) || init?.method !== 'POST') { unexpected.push(url); throw new Error(`local fixture denies unexpected network: ${url}`); }
      const fn = url.slice(prefix.length), args = JSON.parse(String(init.body)) as Record<string, string | number>;
      const messages: Record<string, string> = {
        assert_channel_presence: `presence.${name}.telegram.${SUBJECT}`,
        common_owner_authority: `common.owner.${args.p_locator}`,
        health_context_read: `healthctx.read.${name}`,
        health_log_recent: `health.recent.${name}.${args.p_limit}`,
        list_devices: `devlist.${name}`,
        workspace_owner_binding: `workspace.bind.${locatorHash}`,
      };
      // Recorded, not expect()ed here: the turn catches what this mock throws, so only the list is asserted after it.
      if (!messages[fn] || args.p_sig !== await routerSignature(fixtureEnv.WALDO_ROUTER_HMAC_SECRET, Number(args.p_at), messages[fn])) { unexpected.push(fn); throw new Error(`local fixture denies unexpected or unsigned RPC: ${fn}`); }
      return Response.json(fn === 'assert_channel_presence' ? true : fn === 'health_log_recent' ? [] : fn === 'list_devices' ? devices : fn === 'workspace_owner_binding' ? mapping : fn === 'common_owner_authority'
        ? { admission_revision: '1', auth_user_id: OWNER, do_name: name, owner_id: OWNER, presence_id: PRESENCE, provider: 'telegram', subject: SUBJECT, state_version: 0 } : null);
    });
    const instance = new OwnerDO(state, fixtureEnv);
    const update = 950001;
    try {
      const admitted = await instance.fetch(new Request('https://local.invalid/enqueue', {
        method: 'POST', headers: { 'x-waldo-inbox-secret': fixtureEnv.TELEGRAM_WEBHOOK_SECRET, 'x-waldo-telegram-subject': SUBJECT, 'x-waldo-do-name': name },
        body: JSON.stringify({ update_id: update, message: { message_id: update, from: { id: Number(SUBJECT), is_bot: false }, chat: { id: Number(SUBJECT), type: 'private' }, text: 'What can you do for me today?' } }),
      }));
      expect(admitted.status).toBe(200);
      for (let alarms = 0; alarms < 3; alarms++) {
        await instance.alarm();
        if (state.storage.kv.get<{ updateId: number; closedAt?: number }[]>('telegram_owner_inbox_v1')?.find(row => row.updateId === update)?.closedAt !== undefined) break;
      }
    } finally { await state.storage.deleteAlarm(); directory.mockRestore(); }
  });
  expect(unexpected).toEqual([]);
  const reply = model.requests.find(request => !request.text?.format);
  return reply?.tools?.map(tool => tool.name) ?? [];
}

it('an owner with no paired Mac is not offered use_mac', async () => {
  const offered = await ownerTurn([]);
  expect(offered).toContain('connect_service');
  expect(offered).not.toContain('use_mac');
});
