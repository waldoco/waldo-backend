// A WhatsApp owner who asks for their console gets the one-time link as its own message on WhatsApp, sent while the window
// is open and never held for later. The link is a credential: no model request, stored row or search index holds it.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { handleWhatsAppWebhook } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { ownerOnboardingHost, type OwnerOnboardingDeps } from '../src/channels/app-onboarding';

const model = vi.hoisted(() => ({ requests: [] as string[], all: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    model.all.push(JSON.stringify(request));
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    model.requests.push(JSON.stringify(request));
    const call = !request.tool_turns?.length && JSON.stringify(request.messages.at(-1)).includes('console link');
    return { ok: true as const, data: { model: request.model, text: call ? '' : 'Sent it here as its own message.', ...(call ? { tool_calls: [{ call_id: 'console', name: 'send_console_link', arguments: '{}' }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const SUBJECT = '15550003333';
const APP_SECRET = 'fictional-app-secret';
let NAME = 'wa-console-link';
const sign = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
};
const deliver = async (instance: InstanceType<typeof OwnerDO>, id: string, text: string) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'fictional-waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'fictional-phone-id' },
    contacts: [{ profile: { name: 'Fictional Owner' }, wa_id: SUBJECT }],
    messages: [{ from: SUBJECT, id, timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text }, type: 'text' }],
  } }] }] });
  const owners = { idFromName: (name: string) => name, get: () => ({ fetch: (url: string, init?: RequestInit) => instance.fetch(new Request(url, init)) }) } as unknown as DurableObjectNamespace;
  const directory: OwnerDirectory = { byPresence: async () => ({ doName: NAME, subject: SUBJECT, timezone: null }), redeem: async () => null };
  const request = new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } });
  expect((await handleWhatsAppWebhook(request, { OWNER_DO: owners, WHATSAPP_APP_SECRET: APP_SECRET }, () => undefined, directory)).status).toBe(200);
  await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
};

it('a WhatsApp turn that asks for the console link sends it as its own message now, and keeps it out of history, search and every model request', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(NAME)), async (_instance, state) => {
    const graph: Record<string, unknown>[] = [];
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { graph.push(JSON.parse(String(init?.body ?? '{}'))); return Response.json({ messaging_product: 'whatsapp', contacts: [{ wa_id: SUBJECT }], messages: [{ id: `wamid.out.${graph.length}` }] }); });
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      await deliver(instance, 'wamid.in.console', 'Send me my console link please');
      await vi.waitFor(() => expect(model.requests.join('\n').replaceAll('\\"', '"')).toContain('"sent":true,"surface":"whatsapp"'), { timeout: 10_000, interval: 20 });
      expect(await state.storage.get('console:link')).toMatchObject({ token: expect.any(String) });
      await vi.waitFor(() => expect(graph.some(body => JSON.stringify(body).includes('Sent it here as its own message.'))).toBe(true), { timeout: 10_000, interval: 20 });
      const links = graph.filter(body => JSON.stringify(body).includes('console?t='));
      expect(links).toHaveLength(1);
      // Graph previews a link only when asked (preview_url: true); a credential never asks.
      expect(links[0]).toEqual({ messaging_product: 'whatsapp', to: `+${SUBJECT}`, type: 'text', text: { body: expect.stringMatching(/^Console \(link works once, for 10 minutes\): https:\/\/\S+\/console\?t=\S+$/) } });

      await deliver(instance, 'wamid.in.thanks', 'Thanks, got it');
      await vi.waitFor(() => expect(model.requests.at(-1)).toContain('Sent it here as its own message.'), { timeout: 10_000, interval: 20 });
      expect(model.all.join('\n')).not.toContain('console?t=');
      const kvRows = [...state.storage.kv.list()];
      expect(kvRows.some(([, value]) => JSON.stringify(value).includes('Sent it here as its own message.'))).toBe(true);
      expect(kvRows.filter(([, value]) => JSON.stringify(value).includes('console?t=')).map(([key]) => key)).toEqual([]);
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM episodes').toArray())).toContain('Sent it here as its own message.');
      const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").toArray().map(row => row.name);
      for (const table of tables) {
        let rows: unknown[];
        try { rows = state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray(); } catch { expect(table).not.toBe('episodes'); continue; }
        expect(JSON.stringify(rows), table).not.toContain('console?t=');
      }
    } finally { net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 60_000);

it('setup answers saved from the app reach a WhatsApp turn as owner facts in its prompt', async () => {
  NAME = 'wa-setup-answers';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(NAME)), async (_instance, state) => {
    // The writer POST /app/v1/onboarding/answers uses (its app route is tested end to end in setup-answers-app.test.ts).
    const host = ownerOnboardingHost({ storage: state.storage, doName: NAME, now: Date.now, agreementsOffered: false, lookupOffered: false } as unknown as OwnerOnboardingDeps);
    expect(host.transaction(() => host.firstRun.saveAnswers({ request_id: 'setup-answers-wa-1', name: 'Asha', day: { shape: 'meetings', own_words: '' }, wearable: 'apple' })))
      .toEqual({ name: true, day: true, slips: false, wearable: true });
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ messaging_product: 'whatsapp', contacts: [{ wa_id: SUBJECT }], messages: [{ id: 'wamid.out' }] }));
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      const before = model.requests.length;
      await deliver(instance, 'wamid.in.plan', 'What should I do first today?');
      await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(before), { timeout: 10_000, interval: 20 });
      const turn = model.requests.slice(before).join('\n');
      const profile = turn.slice(turn.indexOf('<owner_profile>'), turn.indexOf('</owner_profile>'));
      for (const fact of ['Wants to be called Asha', 'Most workdays are meetings, often back to back.', 'Wears an Apple Watch.']) expect(profile).toContain(fact);
    } finally { net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 60_000);
