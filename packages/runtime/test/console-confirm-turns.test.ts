import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { consoleAuth } from '../src/identity/console-auth';
import { linkCodeHash } from '../src/identity/owner-directory';

const proof = vi.hoisted(() => ({ hold: null as null | (() => Promise<void>) }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: { text?: { format?: { name?: string } } }) => {
  const format = input.text?.format?.name;
  if (!format && proof.hold) { const hold = proof.hold; proof.hold = null; await hold(); }
  return { id: 'confirm-fixture-model-reply', output: [], usage: { input_tokens: 1, output_tokens: 1 },
    output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'Done.' };
} }; } }));

const FIVE_MINUTES = 5 * 60_000;

// The console's chat runs under the console session's directory row. By owner ruling, a confirm in the browser caps that
// row for 5 minutes instead of ending it, so the owner's turn in flight and the message queued behind it both finish.
it('a turn running across a confirm completes, and a message queued under the old session still runs', async () => {
  proof.hold = null;
  const name = `confirm-turn-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    const DIRECTORY = 'https://confirm-turn.fixture.invalid', OWNER = '10000000-0000-0000-0000-000000000003';
    const rows = new Map<string, { until: number }>(), calls: string[] = [];
    const live = (hash: string) => (rows.get(hash)?.until ?? 0) > Date.now();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(DIRECTORY);
      const fn = url.pathname.split('/rpc/')[1]!, a = JSON.parse(String(init?.body)) as Record<string, string>;
      calls.push(fn);
      if (fn === 'console_session_open_for') { rows.set(a.p_session_hash!, { until: Date.now() + 30 * 24 * 60 * 60_000 }); return Response.json(true); }
      if (fn === 'console_session_cap') {
        const row = rows.get(a.p_session_hash!);
        if (!row || !live(a.p_session_hash!)) return Response.json(false);
        row.until = Math.min(row.until, Date.now() + FIVE_MINUTES);
        return Response.json(true);
      }
      if (fn === 'console_session_revoke') { rows.delete(a.p_session_hash!); return Response.json(true); }
      if (fn === 'app_session_authority') return Response.json(a.p_do_name === name && live(a.p_session_hash!)
        ? { owner_id: OWNER, do_name: name, session_hash: a.p_session_hash, state_version: 0, admission_revision: '1', expires_at: rows.get(a.p_session_hash!)!.until } : null);
      if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER, auth_user_id: '20000000-0000-0000-0000-000000000003', do_name: name, state_version: 0, admission_revision: '1' });
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'confirm-turn-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_WEBHOOK_SECRET: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key',
      COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'confirm-turn-owner', WALDO_OWNER_TIMEZONE: 'UTC',
      WALDO_EGRESS_ALLOWLIST: '*', WALDO_TOOL_OFFLOAD: '0', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key',
      WALDO_ROUTER_HMAC_SECRET: 'fictional-confirm-router-secret-0000000000000', RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, BROWSER: undefined };
    const instance = new OwnerDO(state, settings as never);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('origin', 'https://console.fixture.invalid');
    const auth = consoleAuth(settings)!;
    const oldCookie = (await auth.ownerCookie(name))!;
    const oldHash = await linkCodeHash(oldCookie.split('.')[1]!);
    const send = async (clientId: string, text: string) => {
      const response = await instance.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', {
        method: 'POST', body: JSON.stringify({ client_message_id: clientId, text }),
        headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': oldHash, 'x-waldo-app-origin': 'https://console.fixture.invalid', 'content-type': 'application/json' },
      }));
      expect(response.status).toBe(202);
      return (await response.json() as { message_id: string }).message_id;
    };
    const record = (id: string) => state.storage.kv.get<{ state: string; closedReason?: string }>(`app:inbox-record:${id}`);
    try {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      proof.hold = () => held;
      const running = await send('confirm-running-client', 'Plan my afternoon.');
      await vi.waitFor(() => expect(record(running)?.state).toBe('running'), { timeout: 10_000, interval: 20 });
      await vi.waitFor(() => expect(proof.hold).toBeNull(), { timeout: 10_000, interval: 20 });
      const queued = await send('confirm-queued-client', 'And remind me at five.');
      expect(record(queued)?.state).toBe('admitted');

      const confirmed = await auth.ownerCookie(name, new Request('https://console.fixture.invalid/console/verify', { method: 'POST', headers: { cookie: `waldo_owner=${oldCookie}` } }));
      expect(confirmed).not.toBeNull();

      release();
      await vi.waitFor(() => expect(record(running)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      await vi.waitFor(() => expect(record(queued)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      expect(calls).toContain('console_session_cap');
      expect(calls).not.toContain('console_session_revoke');
    } finally {
      const browser = (instance as unknown as { ownerBrowser: { stop(): void; maintain(): Promise<void> } }).ownerBrowser;
      browser.stop(); await browser.maintain(); await state.storage.deleteAlarm(); fetcher.mockRestore();
    }
  });
}, 30_000);
