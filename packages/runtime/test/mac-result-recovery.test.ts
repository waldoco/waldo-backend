import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnerDO } from '../src/channels/owner-do';
import { appSubjectFor } from '../src/channels/app-api';
import { durableConversationStore } from '../src/channels/conversation-store';
import { MAC_FOLLOWUP_RETRY_MS, MAC_FOLLOWUP_UNDELIVERABLE_RETRY_MS, macInbox } from '../src/devices/mac-delivery';
import { DeviceCommandStore } from '../src/devices/command-store';
import { claimStore } from '../src/memory/claims';
import { rearmSharedAlarm } from '../src/scheduler/alarm-slot';
import { presenceAuthority } from './helpers/directory-presence';

const model = vi.hoisted(() => ({ calls: 0, requests: [] as string[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (params: unknown) => {
    model.calls++;
    model.requests.push(JSON.stringify(params));
    return { id: 'fixture', output_text: 'Fixture result summary.', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));
afterEach(() => vi.unstubAllGlobals());
const { createOwnerResponder } = await import('../src/channels/owner-turn');

it('recovers a saved Mac summary after restart without a second model call', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('mac_summary_recovery'));
  await runInDurableObject(stub, async (_instance, state) => {
    model.calls = 0;
    const store = durableConversationStore(state.storage);
    const timer = async <T>(_hop: string, work: () => Promise<T>) => work();
    const first = createOwnerResponder('fictional-key', store);
    const reply = await first.prompt('mac:result:request_fixture', 'telegram-700000001', 'Summarize this fixture Mac result.', timer, 'telegram', [], undefined, undefined, undefined, 'external');
    const restarted = createOwnerResponder('fictional-key', store);
    expect(await restarted.prompt('mac:result:request_fixture', 'telegram-700000001', 'Summarize this fixture Mac result.', timer, 'telegram', [], undefined, undefined, undefined, 'external')).toBe(reply);
    expect(model.calls).toBe(1);
  });
});

it('quarantines revoked result custody so the owner alarm can continue', async () => {
  const name = 'mac_revoked_recovery';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)) as DurableObjectStub<OwnerDO>;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/device_for_auth_v030')) return Response.json([]);
    return Response.json(true);
  });
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('telegram_subject', '700000001');
    const inbox = macInbox(state.storage);
    expect(await inbox.admit({ kind: 'session_event', request_id: 'event_fixture', device_id: 'revoked_device', owner_id: 'owner_fixture', payload: { project: 'fixture', session_id: 'session_fixture', event: 'blocked_on_tool' } })).toBe(true);
    await expect(instance.alarm()).resolves.toBeUndefined();
    expect(inbox.pending()).toHaveLength(0);
  });
});

it('admits exactly one expired follow-up for a Mac command that arrives after its deadline', async () => {
  const stub = env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('mac_expired_ack'));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new DeviceCommandStore(state.storage);
    const result = await store.enqueue({ owner_id: 'owner_fixture', device_id: 'mac_expired_ack', request_id: 'expired_request', class: 'shell_exec', payload: { project: 'fixture', command: 'true', reason: 'Fixture expiry', timeout_seconds: 120 } }, 1000, ['shell_exec']);
    if (!result.accepted) throw new Error('fixture enqueue failed');
    const command = JSON.parse(store.pending(1000)[0]!.wire);
    store.markSent(result.command_id);
    const ack = { ...command, type: 'ack', timestamp: 1901, nonce: 'AAECAwQFBgcICQoLDA0ODw', signature: 'A'.repeat(86), payload: { state: 'expired', reason: 'expired' } };
    store.acceptAck(ack);
    store.acceptAck(ack);
    expect(store.deliveries()).toHaveLength(1);
    expect(JSON.parse(store.deliveries()[0]!.body)).toMatchObject({ kind: 'result', request_id: 'expired_request', payload: { status: 'expired' } });
  });
});

// This pool binds the directory, so a follow-up runs as the owner the directory admits for the object, through the alarm.
describe('a Mac result follow-up on a directory-backed deploy', () => {
  const OWNER_ID = '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e';
  const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
  const SUBJECT = '700000001';
  const RESULT = { kind: 'result' as const, request_id: 'request_fixture', device_id: 'device_fixture', owner_id: OWNER_ID,
    payload: { status: 'completed', exit_code: 0, output_tail: 'knee physio, the Pune office and the standup', truncated: false } };
  type Directory = 'current' | 'revoked' | 'outage';
  const directory = (name: string, answer: Directory, asked: string[], sent: string[]) => vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input), path = new URL(url).pathname;
    if (path.endsWith('/device_for_auth_v030')) return Response.json([{ owner_id: OWNER_ID, do_name: name, contract_version: '0.3.0', pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', capabilities: 'shell_exec' }]);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path)?.[1];
    if (fn === 'common_owner_authority' || fn === 'owner_runtime_authority') {
      asked.push(fn);
      if (answer === 'outage') throw new Error('directory unavailable');
      if (answer === 'revoked') return Response.json(null);
      if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
      return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: name, state_version: 1, admission_revision: '5' });
    }
    if (/\/sendMessage$/.test(path)) {
      sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Response.json({ ok: true, result: { message_id: sent.length, chat: { id: Number(SUBJECT) } } });
    }
    return Response.json(true);
  });
  // A result row with its wake, for an owner bound through Telegram (and the app, when dual), whose memory holds a health
  // claim and a pinned fact that the result's words both match.
  const seed = (name: string, dual: boolean) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('telegram_subject', SUBJECT);
    if (dual) state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const memory = claimStore(state.storage.sql);
    const owned = (text: string, kind: string) => memory.add({ kind, text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: 'owner, tg-41' }, new Date().toISOString());
    owned('Knee physio exercises every morning before the standup', 'health');
    owned('Works from the Pune office on Tuesdays before the standup', 'fact');
    expect(memory.pin(memory.claims().find(claim => claim.kind === 'fact')!.id, 'facts', 1)).toBe(true);
    expect(await macInbox(state.storage).admit(RESULT)).toBe(true);
    await rearmSharedAlarm(state.storage, null, Date.now());
  });
  const inspect = (name: string) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => ({
    rows: state.storage.sql.exec<{ state: string }>('SELECT state FROM mac_result_inbox').toArray().map(row => row.state),
    due: state.storage.kv.get<number>('mac_results_due_v1') ?? null,
    chain: [...state.storage.kv.list<{ chatId: string; ownerId: string; appPayload: string }>({ prefix: 'conv:' })].map(([, row]) => row)
      .filter(row => row.appPayload === 'Fixture result summary.').map(({ chatId, ownerId }) => ({ chatId, ownerId })),
  }));
  const clear = (name: string) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => { await state.storage.deleteAlarm(); });

  it.each([['Telegram-bound', false], ['dual-bound', true]] as const)('a %s owner gets the report as the admitted owner, on the Telegram chain, recalling no health claim by the result\'s words', async (_label, dual) => {
    const name = `mac_followup_owner_${dual ? 'dual' : 'telegram'}`, asked: string[] = [], sent: string[] = [];
    model.calls = 0; model.requests = [];
    directory(name, 'current', asked, sent);
    await seed(name, dual);
    try {
      await runDurableObjectAlarm(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)));
      await vi.waitFor(async () => expect((await inspect(name)).rows).toEqual(['finished']), { timeout: 8_000, interval: 50 });
      await vi.waitFor(() => expect(sent).toContain('Mac request request_fixture: completed (exit code 0).\nFixture result summary.'), { timeout: 8_000, interval: 50 });
      const request = model.requests.find(sent => sent.includes('Report this Mac result briefly'));
      expect(request).toContain(`Authenticated owner ${PRINCIPAL}`);
      expect((JSON.parse(request!) as { prompt_cache_key?: string }).prompt_cache_key).toBe(`waldo:${PRINCIPAL}`);
      expect(request).not.toContain('prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(request).not.toContain('Knee physio exercises every morning');
      expect((await inspect(name)).chain).toEqual([{ chatId: `telegram-${SUBJECT}`, ownerId: PRINCIPAL }]);
      // The owner is asked through the binding that admits it, once per unit of work (the boot day plan is another unit).
      expect([...new Set(asked)]).toEqual([dual ? 'owner_runtime_authority' : 'common_owner_authority']);
    } finally { await clear(name); }
  }, 20_000);

  it.each([['revoked', MAC_FOLLOWUP_UNDELIVERABLE_RETRY_MS], ['outage', MAC_FOLLOWUP_RETRY_MS]] as const)('waits when the directory says %s: nothing is reported, no model is asked, and the row is asked about again later', async (answer, backoff) => {
    const name = `mac_followup_${answer}`, asked: string[] = [], sent: string[] = [];
    model.calls = 0; model.requests = [];
    directory(name, answer, asked, sent);
    await seed(name, false);
    try {
      const before = Date.now();
      await runDurableObjectAlarm(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)));
      await vi.waitFor(() => expect(asked).toContain('common_owner_authority'), { timeout: 8_000, interval: 50 });
      const after = await inspect(name);
      expect(after.rows).toEqual(['pending']);
      expect(after.due).toBeGreaterThanOrEqual(before + backoff);
      expect(after.due).toBeLessThan(Date.now() + backoff + 1_000);
      expect(model.requests.filter(sent => sent.includes('Report this Mac result briefly'))).toEqual([]);
      expect(sent).toEqual([]);
    } finally { await clear(name); }
  }, 20_000);
});
