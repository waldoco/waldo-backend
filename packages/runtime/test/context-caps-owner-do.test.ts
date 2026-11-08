// WALDO_CONTEXT_CAPS through a real owner object: a WhatsApp turn's system prompt carries the owner's every-turn orders and
// scheduled ones up to the cap, and counts the scheduled ones left out; with the switch off it carries every one, as before.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { standingOrderBook } from '../src/channels/standing-orders';
import { handleWhatsAppWebhook } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';
import { CONTEXT_BUDGET } from '../src/conversation/context-budget';

const { calls } = vi.hoisted(() => ({ calls: [] as { instructions?: string }[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: { instructions?: string }) => {
    calls.push({ instructions: body.instructions });
    return { id: `fixture-${calls.length}`, output_text: 'Noted.', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));

const SUBJECT = '15550004444';
const APP_SECRET = 'fictional-app-secret';
const sign = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
};
const deliver = async (instance: OwnerDO, doName: string, text: string) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'fictional-waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'fictional-phone-id' },
    contacts: [{ profile: { name: 'Fictional Owner' }, wa_id: SUBJECT }], messages: [{ from: SUBJECT, id: `wamid.${doName}`, timestamp: '1700000000', text: { body: text }, type: 'text' }],
  } }] }] });
  const owners = { idFromName: (name: string) => name, get: () => ({ fetch: (url: string, init?: RequestInit) => instance.fetch(new Request(url, init)) }) } as unknown as DurableObjectNamespace;
  const directory: OwnerDirectory = { byPresence: async () => ({ doName, subject: SUBJECT, timezone: null }), redeem: async () => null };
  const request = new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } });
  expect((await handleWhatsAppWebhook(request, { OWNER_DO: owners, WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' }, () => undefined, directory)).status).toBe(200);
  await drainWhatsAppTurns(instance);
};

it.each([['1', true], ['0', false]] as const)('WALDO_CONTEXT_CAPS=%s: the turn\'s system prompt caps the standing orders (%s)', async (caps, capped) => {
  const doName = `context-caps-${caps}`;
  calls.length = 0;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_instance, state) => {
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    let n = 0;
    const orders = standingOrderBook(state.storage.sql, { schedule: async () => undefined, cancel: async () => undefined } as never, { timezone: 'UTC', now: () => new Date() } as never, () => `so${++n}`);
    for (let index = 0; index < 12; index += 1) await orders.set(index < 2
      ? { scope: `Rule ${index}: ${'keep my mornings free of calls before ten unless I say otherwise. '.repeat(6)}`, trigger: 'every_turn', gate: 'confirm_first', escalation: 'message_owner' }
      : { scope: `Digest ${index}: ${'sum up what moved on my plate and what is still open. '.repeat(6)}`, trigger: 'daily', at: '21:00', gate: 'act_and_report', escalation: 'message_owner' });
    const instance = new OwnerDO(state, { ...env, WALDO_CONTEXT_CAPS: caps, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      await deliver(instance, doName, 'What do my rules say about mornings?');
      const system = calls.find((call) => (call.instructions ?? '').includes('Standing orders from the owner'))!.instructions!;
      const shown = system.split('\n').filter((line) => /^- \[order:so\d+\]/.test(line));
      if (capped) {
        expect(shown.join('\n').length).toBeLessThanOrEqual(CONTEXT_BUDGET.standingOrdersChars);
        expect(shown.slice(0, 2).map((line) => line.slice(3, line.indexOf(']')))).toEqual(['order:so1', 'order:so2']);
        expect(system).toContain(`${12 - shown.length} more scheduled standing orders are not shown here`);
      } else {
        expect(shown).toHaveLength(12);
        expect(system).not.toContain('more scheduled standing orders');
      }
    } finally { net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 60_000);
