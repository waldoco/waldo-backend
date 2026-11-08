// A chat call has a ceiling on its whole input (40k tokens, 80k hard). The history is the layer that grows without bound,
// so the switch holds it to the conversation layer's budget; the rest of the call is measured against the ceiling.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { handleWhatsAppWebhook } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';
import { CONTEXT_BUDGET } from '../src/conversation/context-budget';

type Body = { instructions?: string; tools?: unknown; input?: readonly unknown[]; prompt_cache_key?: string };
const { calls } = vi.hoisted(() => ({ calls: [] as Body[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: Body) => {
    calls.push(structuredClone(body));
    return { id: `fixture-${calls.length}`, output_text: `Reply ${calls.length}.`, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));

const SUBJECT = '15550003333';
const APP_SECRET = 'fictional-app-secret';
const sign = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
};
const deliver = async (instance: OwnerDO, id: string, text: string, doName: string) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'fictional-waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'fictional-phone-id' },
    contacts: [{ profile: { name: 'Fictional Owner' }, wa_id: SUBJECT }], messages: [{ from: SUBJECT, id, timestamp: '1700000000', text: { body: text }, type: 'text' }],
  } }] }] });
  const owners = { idFromName: (name: string) => name, get: () => ({ fetch: (url: string, init?: RequestInit) => instance.fetch(new Request(url, init)) }) } as unknown as DurableObjectNamespace;
  const directory: OwnerDirectory = { byPresence: async () => ({ doName, subject: SUBJECT, timezone: null }), redeem: async () => null };
  const request = new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } });
  expect((await handleWhatsAppWebhook(request, { OWNER_DO: owners, WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' }, () => undefined, directory)).status).toBe(200);
  await drainWhatsAppTurns(instance);
};
// With WALDO_CALL_CEILINGS on, a WhatsApp chat's history is held to the conversation layer's budget, and every reply call
// reports the ceiling its class has and whether the whole call went over it.
type ReplyShape = { history_tokens_est?: number; tools_tokens_est?: number; system_tokens_est?: number; current_tokens_est?: number; ceiling_tokens?: number; over_ceiling?: boolean };
const replyShapes = (logs: { mock: { calls: unknown[][] } }): ReplyShape[] => logs.mock.calls.flatMap(([raw]) => {
  try { const line = JSON.parse(String(raw)) as { hop?: string; shape?: { context?: ReplyShape } }; return line.hop === 'llm_reply' && line.shape?.context ? [line.shape.context] : []; } catch { return []; }
});

it.each([['1'], [undefined]] as const)('a long WhatsApp chat with WALDO_CALL_CEILINGS=%s', async (ceilings) => {
  const doName = `call-ceilings-${ceilings ?? 'off'}`;
  calls.length = 0;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_instance, state) => {
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    const logs = vi.spyOn(console, 'log');
    const instance = new OwnerDO(state, { ...env, ...(ceilings ? { WALDO_CALL_CEILINGS: ceilings } : {}), OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      const said = Array.from({ length: 36 }, (_, index) => `Note ${index}: ${'the venue changed again and the caterer needs the final count by Thursday. '.repeat(51)}`);
      for (const [index, text] of said.entries()) await deliver(instance, `wamid.ceiling.${index}`, text, doName);
      const shapes = replyShapes(logs);
      expect(shapes).toHaveLength(said.length);
      const last = shapes.at(-1)!;
      // The newest message always goes whole: what gives way is the oldest history.
      expect(JSON.stringify(calls.at(-1)!.input!.at(-1))).toContain(said.at(-1)!.slice(0, 200));
      if (ceilings) {
        for (const shape of shapes) {
          expect(shape.history_tokens_est!).toBeLessThanOrEqual(CONTEXT_BUDGET.historyTokens * 1.1);
          expect(shape.ceiling_tokens).toBe(40_000);
          const whole = shape.tools_tokens_est! + shape.system_tokens_est! + shape.history_tokens_est! + shape.current_tokens_est!;
          expect(shape.over_ceiling).toBe(whole > 40_000);
        }
        expect(last.history_tokens_est!).toBeGreaterThan(CONTEXT_BUDGET.historyTokens * 0.6);
      } else {
        expect(last.history_tokens_est!).toBeGreaterThan(CONTEXT_BUDGET.historyTokens * 1.2);
        expect(shapes.every((shape) => shape.ceiling_tokens === undefined && shape.over_ceiling === undefined)).toBe(true);
      }
    } finally { logs.mockRestore(); net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 240_000);

// The budget's sizes are deploy settings. With the stepped window on as well, each cut keeps the latest exchanges whole:
// what gives way is always the oldest history, never part of a recent message.
it('the history budget and chat ceiling come from their settings, and a stepped cut keeps the latest exchanges whole', async () => {
  const doName = 'call-ceilings-settings-stepped';
  calls.length = 0;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_instance, state) => {
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    const logs = vi.spyOn(console, 'log');
    const instance = new OwnerDO(state, { ...env, WALDO_CALL_CEILINGS: '1', WALDO_STEPPED_WINDOW: '1', WALDO_HISTORY_BUDGET_TOKENS: '14000', WALDO_CHAT_CEILING_TOKENS: '36000',
      OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      const said = Array.from({ length: 24 }, (_, index) => `Note ${index}: ${'the venue changed again and the caterer needs the final count by Thursday. '.repeat(51).trim()}`);
      for (const [index, text] of said.entries()) await deliver(instance, `wamid.stepped.${index}`, text, doName);
      const shapes = replyShapes(logs);
      expect(shapes).toHaveLength(said.length);
      for (const shape of shapes) {
        expect(shape.history_tokens_est!).toBeLessThanOrEqual(14_000 * 1.1);
        expect(shape.ceiling_tokens).toBe(36_000);
      }
      expect(shapes.at(-1)!.history_tokens_est!).toBeGreaterThan(14_000 * 0.3);
      const replies = calls.filter((body) => JSON.stringify(body.input).includes('Note '));
      expect(replies).toHaveLength(said.length);
      for (const [index, body] of replies.entries()) {
        const sent = JSON.stringify(body.input);
        for (const earlier of said.slice(Math.max(0, index - 3), index)) expect(sent.includes(JSON.stringify(earlier).slice(1, -1)), `${index}: ${earlier.slice(0, 8)} in ${sent.length} chars`).toBe(true);
      }
      // Some early note has given way by the end, and none is cut part way through.
      expect(JSON.stringify(replies.at(-1)!.input)).not.toContain('Note 0: ');
      const kept = said.filter((text) => JSON.stringify(replies.at(-1)!.input).includes(text.slice(0, 12)));
      for (const text of kept) expect(JSON.stringify(replies.at(-1)!.input)).toContain(JSON.stringify(text).slice(1, -1));
    } finally { logs.mockRestore(); net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 240_000);
