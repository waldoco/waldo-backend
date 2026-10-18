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
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const fn = String(input).split('/rpc/')[1] ?? '';
      rpcs.push(fn);
      if (fn === 'assert_channel_presence') return Response.json((JSON.parse(String(init?.body)) as { p_subject: string }).p_subject === NEW);
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

// The directory is the authority for which number is this owner's; the bound subject is this object's cache of it. A message
// from another number is reconciled against the directory at admission, so a relink the object never heard about (a console
// code redeemed from the new number, a confirm whose response was lost) does not leave the new number refused.
type Kv = DurableObjectState['storage']['kv'];
// A's number state: bound, an open window, text held for A, a knock and a refusal marker.
const seedA = (kv: Kv) => {
  const now = Date.now();
  kv.put('whatsapp_subject', OLD);
  kv.put('wa_last_inbound_ms', now - 60_000);
  kv.put('wa_held:000000000001', { heldAt: now - 30_000, body: { chat_id: Number(OLD), text: 'held for A only' } });
  kv.put('wa_knocked_for', now - 60_000);
  kv.put('wa_window_refused_for', now - 120_000);
};
const reconcileHarness = async (name: string, presence: (subject: string) => Promise<Response>,
  work: (ctx: { instance: OwnerDO; kv: Kv; sent: string[]; turn: ReturnType<typeof vi.fn>; admit: (subject: string, id: string | null) => Promise<Response>; confirm: (subject: string) => Promise<Response> }) => Promise<void>,
  seed: (kv: Kv) => void = seedA) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const kv = state.storage.kv;
    kv.put('do_name', `do-${name}`);
    seed(kv);
    const sent: string[] = [];
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('graph.facebook.com')) { sent.push(String(init?.body)); return Response.json({ messages: [{ id: 'wamid.out' }], contacts: [{ wa_id: NEW }] }); }
      if (url.endsWith('/rpc/assert_channel_presence')) return presence((JSON.parse(String(init?.body)) as { p_subject: string }).p_subject);
      if (url.endsWith('/rpc/consume_presence_link_request')) return Response.json('linked');
      return Response.json(true);
    });
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      SUPABASE_PROJECT_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router',
    });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const admit = (subject: string, id: string | null) => instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
      method: 'POST', headers: { 'x-waldo-whatsapp-subject': subject },
      body: JSON.stringify({ messages: id === null ? [] : [{ from: subject, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] }),
    }));
    const confirm = async (subject: string) => {
      const access = consoleAccess(state.storage);
      const token = await access.grant();
      const { csrf } = (await access.session(token))!;
      return instance.fetch(new Request('https://w.test/console/action', {
        method: 'POST', headers: { cookie: `${CONSOLE_COOKIE}=${token}` }, body: new URLSearchParams({ csrf, action: 'whatsapp.confirm', token: TOKEN, subject }),
      }));
    };
    try {
      await work({ instance, kv, sent, turn: turn as never, admit, confirm });
      await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
    } finally { await state.storage.deleteAlarm(); turn.mockRestore(); net.mockRestore(); log.mockRestore(); }
  });
};

it('link A text-first, then redeem a console code from B: B is admitted, A\'s held state is gone, and A is refused', async () => {
  // The directory's answer for this owner's number: A after the text-first link, B once the code from B is redeemed
  // (redeem_link_code unlinks A and inserts B; the object is not told).
  let directoryHas = OLD;
  await reconcileHarness('wa-reconcile-code', async subject => Response.json(subject === directoryHas), async ({ instance, kv, sent, turn, admit, confirm }) => {
    expect((await confirm(OLD)).status).toBe(200);
    expect(kv.get('whatsapp_subject')).toBe(OLD);
    expect((await admit(OLD, 'wamid.a0')).status).toBe(200);
    await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
    // Waldo then holds text for A and knocks, as it does once A's window closes.
    kv.put('wa_held:000000000001', { heldAt: Date.now(), body: { chat_id: Number(OLD), text: 'held for A only' } });
    kv.put('wa_knocked_for', kv.get<number>('wa_last_inbound_ms'));
    directoryHas = NEW;
    const turns = turn.mock.calls.length;
    expect((await admit(NEW, 'wamid.b1')).status).toBe(200);
    expect(kv.get('whatsapp_subject')).toBe(NEW);
    expect([...kv.list({ prefix: 'wa_held:' })]).toEqual([]);
    expect(kv.get('wa_knocked_for')).toBeUndefined();
    await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
    expect(turn.mock.calls.length).toBe(turns + 1);
    expect(sent.filter(body => body.includes('for A only'))).toEqual([]);
    expect((await admit(OLD, 'wamid.a1')).status).toBe(403);
    expect(kv.get('whatsapp_subject')).toBe(NEW);
    expect(kv.get('wamid:wamid.a1')).toBeUndefined();
    expect(turn.mock.calls.length).toBe(turns + 1);
  }, () => undefined);
});

it('a confirm and a reconcile at admission leave the same number state: one helper rebinds and clears for both', async () => {
  const numberState = (kv: Kv) => Object.fromEntries([...kv.list({ prefix: '' })].filter(([key]) =>
    key === 'whatsapp_subject' || key === 'whatsapp_unlinked' || (key.startsWith('wa_') && !key.startsWith('wa_pending'))));
  const seed = (kv: Kv) => { seedA(kv); kv.put('wa_reheld:wamid.old', Date.now()); kv.put('whatsapp_unlinked', true); };
  const states: Record<string, unknown>[] = [];
  await reconcileHarness('wa-parity-confirm', async subject => Response.json(subject === NEW), async ({ kv, confirm }) => {
    expect((await confirm(NEW)).status).toBe(200);
    states.push(numberState(kv));
  }, seed);
  await reconcileHarness('wa-parity-reconcile', async subject => Response.json(subject === NEW), async ({ kv, admit }) => {
    expect((await admit(NEW, null)).status).toBe(200);
    states.push(numberState(kv));
  }, seed);
  expect(states[0]).toEqual({ whatsapp_subject: NEW });
  expect(states[1]).toEqual(states[0]);
});

it('a directory that cannot answer on a mismatch gets 503, never 403, and changes nothing', async () => {
  await reconcileHarness('wa-reconcile-down', async () => new Response('unavailable', { status: 503 }), async ({ kv, turn, admit }) => {
    expect((await admit(NEW, 'wamid.b1')).status).toBe(503);
    expect(kv.get('whatsapp_subject')).toBe(OLD);
    expect([...kv.list({ prefix: 'wa_held:' })]).toHaveLength(1);
    expect(kv.get('wamid:wamid.b1')).toBeUndefined();
    expect(turn).not.toHaveBeenCalled();
  });
});

it('a concurrent redelivery from the new number does not wipe the window the first admission opened', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  // Both admissions read the directory before either rebinds.
  await reconcileHarness('wa-reconcile-race', async subject => { reads += 1; if (reads === 2) release(); await gate; return Response.json(subject === NEW); },
    async ({ instance, kv, turn, admit }) => {
      // Meta redelivers the same message while the first delivery is still being admitted: the second claims nothing, so a
      // rebind that cleared again would leave B's window closed with nothing to reopen it.
      const [first, second] = await Promise.all([admit(NEW, 'wamid.b1'), admit(NEW, 'wamid.b1')]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(reads).toBe(2);
      expect(kv.get('whatsapp_subject')).toBe(NEW);
      expect(kv.get('wa_last_inbound_ms')).toBeGreaterThan(Date.now() - 60_000);
      await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
      expect(turn).toHaveBeenCalledTimes(1);
    });
});

it('a binding that moves while the directory is read sends the admission back to be checked again, and records nothing', async () => {
  let release!: () => void, reading!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reading = resolve; });
  await reconcileHarness('wa-reconcile-moved', async subject => { reading(); await gate; return Response.json(subject === NEW); }, async ({ kv, turn, admit }) => {
    const pendingAdmit = admit(NEW, 'wamid.b1');
    await started;
    // A confirm (or an unlink) lands meanwhile and binds a third number.
    kv.put('whatsapp_subject', '15550003333');
    const inbound = kv.get('wa_last_inbound_ms');
    release();
    expect((await pendingAdmit).status).toBe(503);
    expect(kv.get('whatsapp_subject')).toBe('15550003333');
    expect(kv.get('wamid:wamid.b1')).toBeUndefined();
    expect(kv.get('wa_last_inbound_ms')).toBe(inbound);
    expect(turn).not.toHaveBeenCalled();
  });
});
