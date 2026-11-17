// On a deploy with the directory, a command typed on WhatsApp passes the same admission as the console: /fire and /langfuse
// need the directory's admin check, and a job fires at most once in ten minutes. The rest stay every owner's.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRE_SPACING_MS } from '../src/channels/dashboard-harness';
import { OwnerDO } from '../src/channels/owner-do';
import { presenceAuthority } from './helpers/directory-presence';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const OWNER_ID = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
const SUBJECT = '15550007777';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const whatsapp = { WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' };
const wire = { texts: [] as string[], admins: new Set<string>(), admin: 'up' as 'up' | 'outage' };

beforeEach(() => {
  wire.texts = []; wire.admins = new Set(); wire.admin = 'up';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn === 'admin_overview') return wire.admin === 'outage' ? new Response('upstream unavailable', { status: 503 })
      : Response.json(wire.admins.has((JSON.parse(String(init?.body)) as { p_do_name: string }).p_do_name) ? { owners: [], invites: [] } : null);
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') {
      const body = JSON.parse(String(init?.body)) as { to: string; type: string; text?: { body: string } };
      if (body.type === 'text') wire.texts.push(body.text!.body);
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${wire.texts.length}` }] });
    }
    return Response.json(null);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const withOwner = (name: string, run: (owner: OwnerDO, commands: () => number, state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('whatsapp_subject', SUBJECT);
    const owner = new OwnerDO(state, { ...env, ...directory, ...whatsapp, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TELEGRAM_ID: undefined } as never);
    let commands = 0;
    (owner as unknown as { runHarness: () => Promise<string> }).runHarness = async () => { commands += 1; return 'HARNESS-RAN'; };
    try { await run(owner, () => commands, state); } finally { await state.storage.deleteAlarm(); }
  });
let wamid = 0;
const says = async (owner: OwnerDO, text: string): Promise<string> => {
  wamid += 1;
  const response = await owner.fetch(new Request('https://telegram-owner/whatsapp-admit', {
    method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT },
    body: JSON.stringify({ messages: [{ from: SUBJECT, id: `wamid.gate.${wamid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] }),
  }));
  expect(response.status).toBe(200);
  await drainWhatsAppTurns(owner);
  return wire.texts.at(-1) ?? '';
};

describe('admin commands on WhatsApp', { timeout: 30_000 }, () => {
  it('refuses /fire and /langfuse to an owner who is not an admin, and still answers their own diagnostics', async () => {
    await withOwner('gate-wa-owner', async (owner, commands, state) => {
      for (const text of ['/fire nightly', '/langfuse', '/fire']) expect([text, await says(owner, text)]).toEqual([text, 'That command is for Waldo admins.']);
      expect(commands()).toBe(0);
      // Each receipt says the command was refused, not that it ran.
      expect(state.storage.sql.exec<{ note: string }>("SELECT note FROM trace_log WHERE hop = 'command' ORDER BY id").toArray().map(row => row.note)).toEqual(['refused_admin_only', 'refused_admin_only', 'refused_admin_only']);
      expect(await says(owner, '/usage')).toBe('HARNESS-RAN');
    });
  });

  it('runs an admin\'s fire, and refuses the same job again inside ten minutes without running it', async () => {
    await withOwner('gate-wa-admin', async (owner, commands) => {
      wire.admins.add('gate-wa-admin');
      expect(await says(owner, '/fire nightly')).toBe('HARNESS-RAN');
      expect(await says(owner, '/fire nightly')).toBe(`Not yet: try again in ${FIRE_SPACING_MS / 60_000} minutes.`);
      expect(commands()).toBe(1);
    });
  });

  it('runs nothing when the directory cannot say who is an admin', async () => {
    await withOwner('gate-wa-outage', async (owner, commands) => {
      wire.admin = 'outage';
      expect(await says(owner, '/fire nightly')).toBe('Waldo could not check that command just now, so nothing ran.');
      expect(commands()).toBe(0);
    });
  });
});
