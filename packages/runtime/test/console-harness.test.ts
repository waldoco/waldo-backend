// The operator commands Telegram took, in the owner's console (CONSOLE_HARNESS): the same handlers, run as the signed-in owner
// behind the console's session, CSRF check and rate budget, on a deploy with no Telegram bot. /console and /stop have their
// own homes (the console itself; a message's stop and WhatsApp's /stop), so they are refused here.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { consoleAccess } from '../src/channels/console';
import { DASHBOARD_HARNESS_PATH } from '../src/channels/dashboard-harness';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const OWNER_ID = '2b1c0d9e-8f7a-4b6c-9d5e-4f3a2b1c0d9e';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'presence_hint') return Response.json(null);
    if (fn === 'health_log_recent' || fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Console = (command: string, csrf?: string, method?: string) => Promise<Response>;
const consoleOf = (name: string, switches: Record<string, string>, run: (send: Console, csrf: string, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-fixture',
      WALDO_OWNER_TIMEZONE: 'UTC', OWNER_SURFACE_DEFAULT: '1', ...switches } as never);
    const cookie = `waldo_console=${await consoleAccess(state.storage).grant()}`;
    const { csrf } = await (await owner.fetch(new Request('https://owner/console/dashboard/api/v1/controls?view=connections', { headers: { cookie } }))).json() as { csrf: string };
    const send: Console = (command, token = csrf, method = 'POST') => owner.fetch(new Request(`https://owner${DASHBOARD_HARNESS_PATH}`, method === 'POST'
      ? { method, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, command }) }
      : { method, headers: { cookie } }));
    try { await run(send, csrf, state); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
const { OwnerDO } = await import('../src/channels/owner-do');
const output = async (response: Response) => { expect(response.status).toBe(200); return (await response.json() as { output: string }).output; };
const ON = { CONSOLE_HARNESS: '1' };

describe('operator commands in the console', { timeout: 30_000 }, () => {
  it('answers /trace, /e2e, /usage, /heldrows and /ledger for an app owner with no Telegram, as the Telegram commands did', async () => {
    await consoleOf('harness-reads', ON, async (send, _csrf, state) => {
      traceBook(state.storage.sql).record({ trace: 'app-1', hop: 'llm_reply', ms: 3, ok: true }, Date.now());
      expect(await output(await send('/trace'))).toContain('llm_reply');
      expect(typeof await output(await send('/e2e'))).toBe('string');
      expect(typeof await output(await send('/usage'))).toBe('string');
      expect(typeof await output(await send('/heldrows'))).toBe('string');
      expect(typeof await output(await send('/ledger'))).toBe('string');
    });
  });

  it('fires a scheduled job as the owner, and says so', async () => {
    await consoleOf('harness-fire', ON, async send => {
      expect(await output(await send('/fire fetch'))).toMatch(/^Fired fetch/);
      expect(await output(await send('/fire'))).toMatch(/^Usage: \/fire </);
    });
  });

  it('is not there with the switch off, and refuses a wrong token, a GET, a command with another home and anything else', async () => {
    await consoleOf('harness-off', { CONSOLE_HARNESS: '0' }, async send => {
      expect((await send('/trace')).status).toBe(404);
    });
    await consoleOf('harness-refusals', ON, async send => {
      expect((await send('/trace', 'not-the-session-token')).status).toBe(403);
      expect((await send('/trace', undefined, 'GET')).status).toBe(405);
      for (const command of ['/console', '/stop', 'trace', 'hello there', ''])
        expect([command, (await send(command)).status]).toEqual([command, 400]);
    });
  });

  it('spends the action budget on fires: past it, a fire is refused and a read still answers', async () => {
    await consoleOf('harness-budget', ON, async send => {
      let refused = 0;
      for (let n = 0; n < 22; n += 1) if ((await send('/fire fetch')).status === 429) refused += 1;
      expect(refused).toBeGreaterThan(0);
      expect((await send('/usage')).status).toBe(200);
    });
  });
});
