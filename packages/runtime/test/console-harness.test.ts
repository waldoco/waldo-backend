// The operator commands Telegram took, in the owner's console (CONSOLE_HARNESS): the same handlers, run as the signed-in owner
// behind the console's session, CSRF check and rate budget, on a deploy with no Telegram bot. /console and /stop have their
// own homes (the console itself; a message's stop and WhatsApp's /stop), so they are refused here.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { consoleAccess } from '../src/channels/console';
import { dayPlanBook } from '../src/channels/day-cards';
import { DASHBOARD_HARNESS_PATH } from '../src/channels/dashboard-harness';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const CARD_TEXT = 'Your morning is clear until noon.';
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = String(request.request.messages.at(-1)?.content ?? '');
    const format = request.request.response_format?.name;
    const text = format === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null })
      : format ? '{}' : content.includes('[Scheduled card') ? CARD_TEXT : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');
const { default: worker } = await import('../src/index');

const OWNER_ID = '2b1c0d9e-8f7a-4b6c-9d5e-4f3a2b1c0d9e';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { authority: 'current' as 'current' | 'outage' };
beforeEach(() => {
  wire.authority = 'current';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return wire.authority === 'outage' ? new Response('upstream unavailable', { status: 503 })
      : Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'presence_hint') return Response.json(null);
    if (fn === 'health_log_recent' || fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Console = (command: string, csrf?: string, method?: string) => Promise<Response>;
type Owner = InstanceType<typeof OwnerDO>;
const consoleOf = (name: string, switches: Record<string, string>, run: (send: Console, state: DurableObjectState, owner: Owner) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    state.storage.kv.put('timezone', 'UTC');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-fixture',
      WALDO_OWNER_TIMEZONE: 'UTC', OWNER_SURFACE_DEFAULT: '1', ...switches } as never);
    const cookie = `waldo_console=${await consoleAccess(state.storage).grant()}`;
    const { csrf } = await (await owner.fetch(new Request('https://owner/console/dashboard/api/v1/controls?view=connections', { headers: { cookie } }))).json() as { csrf: string };
    const send: Console = (command, token = csrf, method = 'POST') => owner.fetch(new Request(`https://owner${DASHBOARD_HARNESS_PATH}`, method === 'POST'
      ? { method, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, command }) }
      : { method, headers: { cookie } }));
    try { await run(send, state, owner); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
const output = async (response: Response) => { expect(response.status).toBe(200); return (await response.json() as { output: string }).output; };
// The trace book keeps each command's receipt: a command hop and the machine_turn root that closes it.
const hops = (state: DurableObjectState) => state.storage.sql.exec<{ hop: string; ok: number }>("SELECT hop, ok FROM trace_log WHERE trace LIKE 'console-%' ORDER BY id").toArray().map(({ hop, ok }) => [hop, ok]);
const receipt = (ok: 0 | 1) => [['command', ok], ['machine_turn', ok]];
const appChat = async (owner: Owner, name: string) => (await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64) } })))
  .json() as { messages: { role: string; text: string }[] }).messages;
const ON = { CONSOLE_HARNESS: '1' };

describe('operator commands in the console', { timeout: 30_000 }, () => {
  it('says the commands are here, with this session\'s token, and is not there with the switch off', async () => {
    await consoleOf('harness-get', ON, async (send) => {
      const response = await send('', undefined, 'GET');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: 1, csrf: expect.stringMatching(/^.{16,}$/), commands: ['/trace', '/e2e', '/usage', '/langfuse', '/heldrows', '/fire', '/ledger'] });
    });
    await consoleOf('harness-off', { CONSOLE_HARNESS: '0' }, async send => {
      expect((await send('/trace')).status).toBe(404);
      expect((await send('', undefined, 'GET')).status).toBe(404);
    });
  });

  it('answers each read as the Telegram commands did, for an app owner with no Telegram, and leaves a receipt for each', async () => {
    await consoleOf('harness-reads', ON, async (send, state) => {
      traceBook(state.storage.sql).record({ trace: 'app-1', hop: 'llm_reply', ms: 3, ok: true }, Date.now());
      expect(await output(await send('/trace'))).toContain('llm_reply');
      expect(await output(await send('/e2e'))).toMatch(/^\[x\] Chat reply: ok at /);
      expect(await output(await send('/usage'))).toBe('No model usage recorded yet.');
      expect(await output(await send('/heldrows'))).toMatch(/^topics none pending\nUsage: \/heldrows </);
      expect(await output(await send('/ledger'))).toMatch(/^Waldo is on\n/);
      expect(hops(state)).toEqual(['/trace', '/e2e', '/usage', '/heldrows'].flatMap(() => receipt(1)));
    });
  });

  it('fires a day card for an app owner: it is written, it reaches the app chat, and the fire says it ran', async () => {
    await consoleOf('harness-fire-card', ON, async (send, state, owner) => {
      dayPlanBook(state.storage.sql).save(new Date().toISOString().slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
      const said = await output(await send('/fire card:brief'));
      expect(said).toMatch(/^Fired card:brief\.\n/);
      expect((await appChat(owner, 'harness-fire-card')).filter(row => row.role === 'assistant').map(row => row.text)).toContain(CARD_TEXT);
      expect(hops(state)).toEqual(receipt(1));
    });
  });

  it('fires nothing for an app owner the directory cannot confirm, and says so', async () => {
    await consoleOf('harness-fire-unconfirmed', ON, async (send, state, owner) => {
      dayPlanBook(state.storage.sql).save(new Date().toISOString().slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
      wire.authority = 'outage';
      expect(await output(await send('/fire card:brief'))).toBe('Waldo could not confirm your account just now, so nothing was fired. Try again in a minute.');
      wire.authority = 'current';
      expect((await appChat(owner, 'harness-fire-unconfirmed')).filter(row => row.role === 'assistant')).toEqual([]);
    });
  });

  it('answers a signed-out call with a JSON 401, so the panel asks the owner to sign in rather than failing on a redirect', async () => {
    for (const method of ['GET', 'POST']) {
      const response = await worker.fetch(new Request(`https://waldo.invalid${DASHBOARD_HARNESS_PATH}`, { method, headers: { origin: 'https://waldo.invalid' } }), { ...env, ...directory } as never, { waitUntil: () => undefined, passThroughOnException: () => undefined } as never);
      expect([method, response.status, response.headers.get('cache-control')]).toEqual([method, 401, 'private, no-store']);
    }
  });

  it('refuses a wrong token, another method, a command with another home and anything else', async () => {
    await consoleOf('harness-refusals', ON, async send => {
      expect((await send('/trace', 'not-the-session-token')).status).toBe(403);
      expect((await send('/trace', undefined, 'PUT')).status).toBe(405);
      for (const command of ['/console', '/stop', 'trace', 'hello there', ''])
        expect([command, (await send(command)).status]).toEqual([command, 400]);
    });
  });

  it('answers a failed command with a bare 503, logs its class, never its text, and leaves a failed receipt', async () => {
    await consoleOf('harness-failure', ON, async (send, state, owner) => {
      const lines: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
      vi.spyOn(owner as unknown as { runHarness(): Promise<string> }, 'runHarness').mockRejectedValue(new TypeError('synthetic internal detail'));
      const response = await send('/usage');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('synthetic internal detail');
      expect(lines.join('\n')).toContain('"error_class":"TypeError"');
      expect(lines.join('\n')).not.toContain('synthetic internal detail');
      expect(hops(state)).toEqual(receipt(0));
    });
  });

  it('spends the action budget on fires, not on a /fire that names no job: past it, a fire is refused and a read still answers', async () => {
    await consoleOf('harness-budget', ON, async send => {
      for (let n = 0; n < 25; n += 1) expect(await output(await send('/fire'))).toMatch(/^Usage: \/fire </);
      const statuses: number[] = [];
      for (let n = 0; n < 22; n += 1) statuses.push((await send('/fire fetch')).status);
      expect(statuses.filter(status => status === 429).length).toBeGreaterThan(0);
      expect(statuses.slice(0, statuses.indexOf(429)).every(status => status === 200)).toBe(true);
      expect((await send('/usage')).status).toBe(200);
    });
  });
});
