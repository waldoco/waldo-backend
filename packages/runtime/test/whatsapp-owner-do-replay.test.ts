// Real signed webhook routing, owner DO storage and turn handling. Graph effects stay local;
// /stop makes the ingress receipt independent of model/provider behavior.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { handleWhatsAppWebhook } from '../src/channels/whatsapp-webhook';
import { WA_UPDATE_BASE, WAMID_RETENTION_MS } from '../src/channels/whatsapp-api';
import type { OwnerDirectory } from '../src/identity/owner-directory';

// Runtime initialization can start a background day-plan call. It is outside this ingress proof.
vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const SUBJECT = '15550001111';
const SECRET = 'fictional-whatsapp-app-secret';
const body = (id: string) => JSON.stringify({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: 'fictional-phone-id' },
  messages: [{ from: SUBJECT, id, type: 'text', text: { body: '/stop' } }],
} }] }] });

async function signedRequest(payload: string): Promise<Request> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const signature = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://fixture.invalid/whatsapp/webhook', {
    method: 'POST', body: payload, headers: { 'x-hub-signature-256': `sha256=${signature}` },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('WhatsApp owner DO replay', () => {
  it('runs one turn for a signed payload replay, runs a new wamid, and sweeps expired claims', async () => {
    const name = 'whatsapp-owner-do-replay';
    const namespace = env.TELEGRAM_OWNER_DO!;
    await runInDurableObject(namespace.get(namespace.idFromName(name)), async (_instance, state) => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      state.storage.kv.put('wamid:expired', now - WAMID_RETENTION_MS - 1);
      state.storage.kv.put('wamid:within-retention', now - WAMID_RETENTION_MS + 1);
      const sent: unknown[] = [];
      const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        expect(String(input)).toBe('https://graph.facebook.com/v21.0/fictional-phone-id/messages');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fictional-whatsapp-token');
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ messages: [{ id: `wamid.out.${sent.length}` }] });
      });
      const instance = new TelegramOwnerDO(state, {
        ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      });
      // Pass-through spy: the actual turn executes, including owner checks and wa_offset.
      const turns = vi.spyOn(instance as unknown as { turn(update: { update_id: number }, channel: string): Promise<void> }, 'turn');
      const routed = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://telegram-owner/whatsapp-admit');
        expect(new Headers(init.headers).get('x-waldo-whatsapp-subject')).toBe(SUBJECT);
        const response = await instance.fetch(new Request(url, init));
        expect(response.status).toBe(200);
        // Admission acks first; the turns run after, so wait for them before the test inspects effects.
        await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
        return response;
      });
      const directory: OwnerDirectory = {
        byPresence: async (provider, subject) => {
          expect([provider, subject]).toEqual(['whatsapp', SUBJECT]);
          return { doName: name, subject, timezone: 'Asia/Kolkata' };
        },
        redeem: async () => { throw new Error('known owner must not redeem'); },
      };
      const localNamespace = {
        idFromName: (doName: string) => { expect(doName).toBe(name); return namespace.idFromName(doName); },
        get: () => ({ fetch: routed }),
      } as unknown as DurableObjectNamespace;
      const deliver = async (payload: string) => {
        const pending: Promise<unknown>[] = [];
        const response = await handleWhatsAppWebhook(await signedRequest(payload), {
          TELEGRAM_OWNER_DO: localNamespace, WHATSAPP_APP_SECRET: SECRET,
        }, work => { pending.push(work); }, directory);
        expect(response.status).toBe(200);
        await Promise.all(pending);
      };
      try {
        const payload = body('wamid.A');
        await deliver(payload);
        await deliver(payload);
        expect(routed).toHaveBeenCalledTimes(2);
        expect(turns).toHaveBeenCalledTimes(1);
        expect(turns).toHaveBeenNthCalledWith(1, expect.objectContaining({ update_id: WA_UPDATE_BASE + 1 }), 'whatsapp');
        expect(sent).toEqual([{ messaging_product: 'whatsapp', to: SUBJECT, type: 'text', text: { body: 'Nothing is running right now.' } }]);
        expect(state.storage.kv.get('wamid:wamid.A')).toBe(now);
        expect(state.storage.kv.get('wamid:expired')).toBeUndefined();
        expect(state.storage.kv.get('wamid:within-retention')).toBe(now - WAMID_RETENTION_MS + 1);
        expect(await state.storage.get('wa_seq')).toBe(1);

        await deliver(body('wamid.B'));
        expect(turns).toHaveBeenCalledTimes(2);
        expect(turns).toHaveBeenNthCalledWith(2, expect.objectContaining({ update_id: WA_UPDATE_BASE + 2 }), 'whatsapp');
        expect(graph).toHaveBeenCalledTimes(2);
        expect(state.storage.kv.get('wamid:wamid.B')).toBe(now);
        expect(await state.storage.get('wa_seq')).toBe(2);
        expect(await state.storage.get('wa_offset')).toBe(WA_UPDATE_BASE + 3);
      } finally {
        await state.storage.deleteAlarm();
      }
    });
  });
});
