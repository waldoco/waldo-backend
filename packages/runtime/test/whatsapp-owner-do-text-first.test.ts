// The confirm through the real owner DO: only a live console session's CSRF can bind, a confirmed link rebinds
// this owner's WhatsApp subject, and admission then follows the new number, not the old one.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const TOKEN = 'C'.repeat(43);
const OLD = '15550001111', NEW = '15550002222';

it('a confirmed text-first link rebinds the WhatsApp subject; GET and a forged confirm change nothing', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('whatsapp-text-first-rebind')), async (_instance, state) => {
    state.storage.kv.put('do_name', 'do-text-first');
    state.storage.kv.put('whatsapp_subject', OLD);
    const access = consoleAccess(state.storage);
    const token = await access.grant();
    const cookie = `${CONSOLE_COOKIE}=${token}`;
    const { csrf } = (await access.session(token))!;
    const rpcs: string[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const fn = String(input).split('/rpc/')[1] ?? '';
      rpcs.push(fn);
      return Response.json(fn === 'presence_link_request_subject' ? NEW : fn === 'consume_presence_link_request' ? 'linked' : true);
    });
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      SUPABASE_PROJECT_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router',
    });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => undefined);
    const confirm = (csrfValue: string) => instance.fetch(new Request('https://w.test/console/action', {
      method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf: csrfValue, action: 'whatsapp.confirm', token: TOKEN, subject: NEW }),
    }));
    const admit = (subject: string) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': subject },
      body: JSON.stringify({ messages: [{ from: subject, id: `wamid.${subject}`, type: 'text', text: { body: 'hi' } }] }),
    }));
    try {
      const page = await instance.fetch(new Request(`https://w.test/console/whatsapp/link/${TOKEN}`, { headers: { cookie } }));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('+15550002222');
      expect((await instance.fetch(new Request(`https://w.test/console/whatsapp/link/${TOKEN}`))).status).toBe(401);
      expect((await confirm('forged')).status).toBe(403);
      expect(rpcs).not.toContain('consume_presence_link_request');
      expect(state.storage.kv.get('whatsapp_subject')).toBe(OLD);

      expect((await confirm(csrf)).status).toBe(200);
      expect(rpcs.filter(fn => fn === 'consume_presence_link_request')).toHaveLength(1);
      expect(state.storage.kv.get('whatsapp_subject')).toBe(NEW);
      expect((await admit(OLD)).status).toBe(403);
      expect((await admit(NEW)).status).toBe(200);
      await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
    } finally { await state.storage.deleteAlarm(); turn.mockRestore(); graph.mockRestore(); }
  });
});

it('confirming a new number clears what was held for the old one, so nothing held for A ever reaches B', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('whatsapp-text-first-replace')), async (_instance, state) => {
    const kv = state.storage.kv, now = Date.now();
    kv.put('do_name', 'do-text-first-replace');
    kv.put('whatsapp_subject', OLD);
    // A's window is open, and A has text held, a refusal marker and a knock marker.
    kv.put('wa_last_inbound_ms', now - 60_000);
    kv.put('wa_held:000000000001', { heldAt: now - 30_000, body: { chat_id: Number(OLD), text: 'held for A only' } });
    kv.put('wa_reheld:wamid.old', now - 30_000);
    kv.put('wa_knocked_for', now - 60_000);
    kv.put('wa_window_refused_for', now - 60_000);
    const access = consoleAccess(state.storage);
    const token = await access.grant();
    const cookie = `${CONSOLE_COOKIE}=${token}`;
    const { csrf } = (await access.session(token))!;
    const sent: string[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('graph.facebook.com')) { sent.push(String(init?.body)); return Response.json({ messages: [{ id: 'wamid.out' }], contacts: [{ wa_id: NEW }] }); }
      const fn = url.split('/rpc/')[1] ?? '';
      return Response.json(fn === 'consume_presence_link_request' ? 'linked' : true);
    });
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      SUPABASE_PROJECT_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router',
    });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const confirmed = await instance.fetch(new Request('https://w.test/console/action', {
        method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf, action: 'whatsapp.confirm', token: TOKEN, subject: NEW }),
      }));
      expect(confirmed.status).toBe(200);
      expect(kv.get('whatsapp_subject')).toBe(NEW);
      expect([...kv.list({ prefix: 'wa_held:' })]).toEqual([]);
      expect([...kv.list({ prefix: 'wa_reheld:' })]).toEqual([]);
      expect([kv.get('wa_last_inbound_ms'), kv.get('wa_knocked_for'), kv.get('wa_window_refused_for')]).toEqual([undefined, undefined, undefined]);

      // A held-delivery pass that was already running for A can put its record back after the clear; it is dropped, not sent.
      kv.put('wa_held:000000000002', { heldAt: Date.now(), body: { chat_id: Number(OLD), text: 'restored for A only' } });
      const admitB = () => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': NEW },
        body: JSON.stringify({ messages: [{ from: NEW, id: 'wamid.new', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] }),
      }));
      const inflight = () => Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
      expect((await admitB()).status).toBe(200);
      await inflight();
      const turns = turn.mock.calls.length;
      expect(turns).toBeGreaterThan(0);
      // The clear leaves message dedupe alone: a redelivery of B's message starts no second turn.
      expect((await admitB()).status).toBe(200);
      await inflight();
      expect(turn.mock.calls.length).toBe(turns);
      expect(sent.filter(body => body.includes('for A only'))).toEqual([]);
      expect([...kv.list({ prefix: 'wa_held:' })]).toEqual([]);
      expect(kv.get('wa_last_inbound_ms')).toBeTypeOf('number');
    } finally { await state.storage.deleteAlarm(); turn.mockRestore(); graph.mockRestore(); log.mockRestore(); }
  });
});
