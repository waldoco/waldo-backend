// The commands Telegram took, in the owner's console (CONSOLE_HARNESS): the same handlers, run as the signed-in owner behind
// the console's session, CSRF check and rate budget, on a deploy with no Telegram bot. /fire and /langfuse are for admins. /console and /stop have their
// own homes (the console itself; a message's stop and WhatsApp's /stop), so they are refused here.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { consoleAccess } from '../src/channels/console';
import { dayPlanBook } from '../src/channels/day-cards';
import { DASHBOARD_HARNESS_PATH, FIRE_DAILY_LIMIT, FIRE_SPACING_MS } from '../src/channels/dashboard-harness';
import { FIRE_TARGETS } from '../src/channels/harness';
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
const wire = { authority: 'current' as 'current' | 'outage', admin: 'up' as 'up' | 'outage', adminAsks: 0 };
// The directory admits these owners as admins; it answers null for anyone else.
const ADMINS = new Set(['harness-get', 'harness-fire-card', 'harness-fire-unconfirmed', 'harness-budget', 'harness-spacing', 'harness-daily', 'harness-fire-failure', 'harness-admin-outage']);
beforeEach(() => {
  wire.authority = 'current'; wire.admin = 'up'; wire.adminAsks = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return wire.authority === 'outage' ? new Response('upstream unavailable', { status: 503 })
      : Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'admin_overview') wire.adminAsks += 1;
    if (fn === 'admin_overview') return wire.admin === 'outage' ? new Response('upstream unavailable', { status: 503 }) : Response.json(ADMINS.has(asked.p_do_name ?? '') ? { owners: [], invites: [] } : null);
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'presence_hint') return Response.json(null);
    if (fn === 'health_log_recent' || fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

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

describe('diagnostics in the console', { timeout: 30_000 }, () => {
  it('says which commands this owner has, with this session\'s token, and is not there with the switch off', async () => {
    await consoleOf('harness-get', ON, async (send) => {
      const response = await send('', undefined, 'GET');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: 1, csrf: expect.stringMatching(/^.{16,}$/), commands: ['/trace', '/e2e', '/usage', '/heldrows', '/ledger', '/langfuse', '/fire'] });
    });
    await consoleOf('harness-get-owner', ON, async (send) => {
      expect(((await (await send('', undefined, 'GET')).json()) as { commands: string[] }).commands).toEqual(['/trace', '/e2e', '/usage', '/heldrows', '/ledger']);
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
      expect(await output(await send('/fire card:brief'))).toBe('Waldo could not confirm your account just now, so nothing was fired.');
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
    // Staging's text capture lets free-form error text into the trace book, so this is where the text would land.
    await consoleOf('harness-failure', { ...ON, LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' }, async (send, state, owner) => {
      const lines: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
      vi.spyOn(owner as unknown as { runHarness(): Promise<string> }, 'runHarness').mockRejectedValue(new TypeError('synthetic internal detail'));
      const response = await send('/usage');
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('synthetic internal detail');
      expect(lines.join('\n')).toContain('"error_class":"TypeError"');
      expect(lines.join('\n')).not.toContain('synthetic internal detail');
      expect(state.storage.sql.exec<{ note: string | null }>("SELECT note FROM trace_log WHERE trace LIKE 'console-%'").toArray().map(row => row.note).join('\n')).not.toContain('synthetic internal detail');
      expect(hops(state)).toEqual(receipt(0));
    });
  });

  it('keeps /fire and /langfuse for admins: an owner gets their own diagnostics, and a fire or self-test is refused without running', async () => {
    await consoleOf('harness-owner-only', ON, async (send, state, owner) => {
      dayPlanBook(state.storage.sql).save(new Date().toISOString().slice(0, 10), { card: 'card:brief', time: '00:00', reason: 'planned' });
      const ran = vi.spyOn(owner as unknown as { runHarness(): Promise<string> }, 'runHarness');
      for (const command of ['/fire card:brief', '/fire', '/langfuse']) {
        const response = await send(command);
        expect([command, response.status, await response.json()]).toEqual([command, 403, { error: 'admin_only' }]);
      }
      expect(ran).not.toHaveBeenCalled();
      expect((await appChat(owner, 'harness-owner-only')).filter(row => row.role === 'assistant')).toEqual([]);
      expect(await output(await send('/usage'))).toBe('No model usage recorded yet.');
    });
  });

  it('on a deploy without the directory, offers its one owner every command and leaves their fires unspaced, as before', async () => {
    await consoleOf('harness-no-directory', { ...ON, SUPABASE_PROJECT_URL: undefined, SUPABASE_PUBLISHABLE_KEY: undefined, WALDO_ROUTER_HMAC_SECRET: undefined } as never, async (send, _state, owner) => {
      vi.spyOn(owner as unknown as { runHarness(): Promise<string> }, 'runHarness').mockResolvedValue('Fired.');
      expect(((await (await send('', undefined, 'GET')).json()) as { commands: string[] }).commands).toEqual(['/trace', '/e2e', '/usage', '/heldrows', '/ledger', '/langfuse', '/fire']);
      expect([await output(await send('/fire fetch')), await output(await send('/fire fetch'))]).toEqual(['Fired.', 'Fired.']);
    });
  });

  it('spends a read before asking the directory, so a non-admin repeating /fire is stopped by the read budget', async () => {
    await consoleOf('harness-owner-repeats', ON, async send => {
      const statuses: number[] = [];
      for (let n = 0; n < 100; n += 1) statuses.push((await send('/fire fetch')).status);
      expect(statuses.slice(0, 10).every(status => status === 403)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
      expect(wire.adminAsks).toBeLessThan(90);
    });
  });

  it('refuses an admin command when the directory cannot say who is an admin, and offers only the diagnostics', async () => {
    await consoleOf('harness-admin-outage', ON, async (send, _state, owner) => {
      const ran = vi.spyOn(owner as unknown as { runHarness(): Promise<string> }, 'runHarness');
      wire.admin = 'outage';
      expect(((await (await send('', undefined, 'GET')).json()) as { commands: string[] }).commands).toEqual(['/trace', '/e2e', '/usage', '/heldrows', '/ledger']);
      expect((await send('/fire fetch')).status).toBe(503);
      expect(ran).not.toHaveBeenCalled();
    });
  });

  it('runs each job at most once in ten minutes, and a refused fire spends none of the action budget approvals share', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-07T09:00:00Z') });
    await consoleOf('harness-spacing', ON, async (send, _state, owner) => {
      vi.spyOn(owner as unknown as { runHarness(): Promise<string> }, 'runHarness').mockResolvedValue('Fired.');
      expect(await output(await send('/fire fetch'))).toBe('Fired.');
      const refused = await send('/fire fetch');
      expect([refused.status, refused.headers.get('retry-after')]).toEqual([429, String(FIRE_SPACING_MS / 1000)]);
      // More refusals than the action budget's 20 a minute: had they spent it, the other jobs would be refused below.
      for (let n = 0; n < 25; n += 1) expect((await send('/fire fetch')).status).toBe(429);
      for (const target of FIRE_TARGETS.filter(name => name !== 'fetch')) expect([target, (await send(`/fire ${target}`)).status]).toEqual([target, 200]);
      vi.setSystemTime(Date.now() + FIRE_SPACING_MS);
      expect(await output(await send('/fire fetch'))).toBe('Fired.');
    });
  });

  it('caps an owner\'s fires in a day, and the cap lifts a day after the first', async () => {
    const start = Date.parse('2026-11-07T09:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    await consoleOf('harness-daily', ON, async (send, _state, owner) => {
      vi.spyOn(owner as unknown as { runHarness(): Promise<string> }, 'runHarness').mockResolvedValue('Fired.');
      const statuses: number[] = [];
      while (statuses.length < FIRE_DAILY_LIMIT + 2) {
        for (const target of FIRE_TARGETS) statuses.push((await send(`/fire ${target}`)).status);
        vi.setSystemTime(Date.now() + FIRE_SPACING_MS);
      }
      expect(statuses.slice(0, FIRE_DAILY_LIMIT).every(status => status === 200)).toBe(true);
      expect(statuses.slice(FIRE_DAILY_LIMIT).every(status => status === 429)).toBe(true);
      vi.setSystemTime(start + 24 * 60 * 60_000);
      expect((await send('/fire fetch')).status).toBe(200);
    });
  });

  it('answers a fire whose job failed with the error\'s class only, on the page and in the log', async () => {
    await consoleOf('harness-fire-failure', { ...ON, LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' }, async (send, state, owner) => {
      const lines: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
      vi.spyOn(owner as unknown as { asOwnerJob(): Promise<void> }, 'asOwnerJob').mockRejectedValue(new TypeError('synthetic internal detail'));
      const said = await output(await send('/fire fetch'));
      expect(said).toMatch(/^Fired fetch; it failed \(TypeError\)\.\n/);
      expect([said, lines.join('\n')].join('\n')).not.toContain('synthetic internal detail');
      expect(state.storage.sql.exec<{ note: string | null }>('SELECT note FROM trace_log').toArray().map(row => row.note).join('\n')).not.toContain('synthetic internal detail');
    });
  });
});
