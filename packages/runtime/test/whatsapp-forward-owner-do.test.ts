// A forward on the real WhatsApp Cloud API webhook shape is someone else's text: it reaches the model under the forward
// label and never runs as the owner's approval decision. The owner's own reply reaches the model as their words.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { handleWhatsAppWebhook } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const { modelInputs } = vi.hoisted(() => ({ modelInputs: [] as unknown[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: unknown) => {
    modelInputs.push(body);
    return { id: `fixture-${modelInputs.length}`, output_text: 'Noted.', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));

const SUBJECT = '15550001111';
const APP_SECRET = 'fictional-app-secret';
const sign = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
};
// Meta's signed webhook, through the Worker's handler into this owner's object, then every turn it started.
const deliver = async (instance: OwnerDO, messages: readonly Record<string, unknown>[]) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'fictional-waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'fictional-phone-id' },
    contacts: [{ profile: { name: 'Fictional Owner' }, wa_id: SUBJECT }], messages,
  } }] }] });
  const owners = { idFromName: (name: string) => name, get: () => ({ fetch: (url: string, init?: RequestInit) => instance.fetch(new Request(url, init)) }) } as unknown as DurableObjectNamespace;
  const directory: OwnerDirectory = { byPresence: async () => ({ doName: 'wa-forward', subject: SUBJECT, timezone: null }), redeem: async () => null };
  const request = new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } });
  expect((await handleWhatsAppWebhook(request, { OWNER_DO: owners, WHATSAPP_APP_SECRET: APP_SECRET }, () => undefined, directory)).status).toBe(200);
  await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
};
const message = (id: string, body: string, context: Record<string, unknown>) => ({ context, from: SUBJECT, id, timestamp: '1700000000', text: { body }, type: 'text' });
// The newest owner message in the first reply request among these model calls.
const newestOwnerItem = (bodies: readonly unknown[]) => {
  const reply = bodies.find(body => !(body as { text?: { format?: unknown } }).text?.format) as { input?: { role?: string }[] } | undefined;
  return JSON.stringify((reply?.input ?? []).filter(item => item.role === 'user').at(-1));
};
const labelled = (text: string) => JSON.stringify(`[Forwarded by the owner from someone else:]\n${JSON.stringify(text)}\n[End of forwarded text.]`).slice(1, -1);

it('a forwarded /fire nightly, /stop, /ledger or approval reply reaches the model under the forward label; the owner\'s own reply reaches it as their words', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('wa-forward')), async (_instance, state) => {
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      await deliver(instance, [
        message('wamid.fwd.fire', '/fire nightly', { forwarded: true }),
        message('wamid.fwd.stop', '/stop', { forwarded: true }),
        message('wamid.fwd.ledger', '/ledger', { frequently_forwarded: true }),
        message('wamid.fwd.approve', 'a:p12', { forwarded: true }),
      ]);
      for (const text of ['/fire nightly', '/stop', '/ledger', 'a:p12']) expect.soft(JSON.stringify(modelInputs), text).toContain(labelled(text));
      // A reply carries context too, with no forward flag: the owner typed it, so the model reads it as their words.
      const before = modelInputs.length;
      await deliver(instance, [message('wamid.reply.fire', '/fire nightly', { from: '15550002222', id: 'wamid.original' })]);
      const said = newestOwnerItem(modelInputs.slice(before));
      expect.soft(said).toContain('/fire nightly');
      expect.soft(said).not.toContain(labelled('/fire nightly'));
    } finally { net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 60_000);
