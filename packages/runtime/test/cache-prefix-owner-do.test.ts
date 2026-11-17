// The provider caches a request by its leading bytes: tools, then the system prompt, then the history. Between two chat turns
// on one surface, everything the earlier reply call sent ahead of its new message must lead the later call unchanged, so
// the later call reads it back from the cache; what changes per turn rides the new message.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { COMPACTION } from '../src/conversation/compaction';
import { handleWhatsAppWebhook } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

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
const deliver = async (instance: OwnerDO, id: string, text: string, doName = 'cache-prefix') => {
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
// A chain's first call sends its lone message as a string; every later call sends a list ending in the new message.
const ownerSaid = (body: Body, text: string) => Array.isArray(body.input) && JSON.stringify(body.input.at(-1)).includes(text);
type ReplyShape = { history_moved?: boolean; system_tokens_est?: number; history_tokens_est?: number; current_tokens_est?: number };
// The owner object's reply-call log lines, in turn order, read from the console sink.
const replyShapes = (logs: { mock: { calls: unknown[][] } }): ReplyShape[] => logs.mock.calls.flatMap(([raw]) => {
  try { const line = JSON.parse(String(raw)) as { hop?: string; shape?: { context?: ReplyShape } }; return line.hop === 'llm_reply' && line.shape?.context ? [line.shape.context] : []; } catch { return []; }
});

it('each WhatsApp chat turn starts with the tools, system prompt and history the turn before it sent', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('cache-prefix')), async (_instance, state) => {
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    const logs = vi.spyOn(console, 'log');
    const instance = new OwnerDO(state, { ...env, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      await deliver(instance, 'wamid.prefix.0', 'My gym is at 7 on weekdays.');
      const said = ['Move my dentist to Friday afternoon.', 'What did I say about the gym?', 'Remind me to call Priya at 6.'];
      for (const [index, text] of said.entries()) await deliver(instance, `wamid.prefix.${index + 1}`, text);
      const replies = said.map((text) => calls.find((body) => ownerSaid(body, text)));
      expect(replies.every(Boolean)).toBe(true);
      for (let turn = 1; turn < replies.length; turn += 1) {
        const [before, after] = [replies[turn - 1]!, replies[turn]!];
        expect.soft(after.tools, `tools, turn ${turn + 1}`).toEqual(before.tools);
        expect.soft(after.instructions, `system prompt, turn ${turn + 1}`).toBe(before.instructions);
        expect.soft(after.prompt_cache_key, `cache key, turn ${turn + 1}`).toBe(before.prompt_cache_key);
        const history = before.input!.slice(0, -1);
        expect.soft(after.input!.slice(0, history.length), `history, turn ${turn + 1}`).toEqual(history);
        expect(after.input!.length).toBeGreaterThan(before.input!.length);
      }
      // Each reply call reports the size of each cache layer and that its history window did not move.
      const shapes = replyShapes(logs);
      expect(shapes).toHaveLength(said.length + 1);
      for (const shape of shapes) {
        expect(shape.history_moved).toBe(false);
        expect(shape.system_tokens_est).toBeGreaterThan(1_000);
        expect(shape.current_tokens_est).toBeGreaterThan(0);
      }
      expect(shapes.slice(1).every((shape) => shape.history_tokens_est! > 0)).toBe(true);
    } finally { logs.mockRestore(); net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 60_000);

// Past the budget, the plain window drops the oldest row on every turn, so no turn starts with what the one before it sent.
// The stepped window cuts once and holds its start, so only the turns that cut break the prefix.
it.each([['1', 2], [undefined, 9]] as const)('past its budget, a WhatsApp chat with WALDO_STEPPED_WINDOW=%s breaks the prefix on at most %i of 9 turns', async (stepped, most) => {
  const doName = `cache-prefix-long-${stepped ?? 'off'}`;
  const budget = COMPACTION.budgetTokens;
  Object.assign(COMPACTION, { budgetTokens: 3_000 });
  calls.length = 0;
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_instance, state) => {
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    const logs = vi.spyOn(console, 'log');
    const instance = new OwnerDO(state, { ...env, ...(stepped ? { WALDO_STEPPED_WINDOW: stepped } : {}), OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      const said = Array.from({ length: 14 }, (_, index) => `Note ${index}: ${'the venue changed again and the caterer needs the final count by Thursday. '.repeat(20)}`);
      for (const [index, text] of said.entries()) await deliver(instance, `wamid.long.${index}`, text, doName);
      const replies = said.map((text) => calls.find((body) => ownerSaid(body, text.slice(0, 40))));
      const later = replies.slice(4);
      expect(later.every(Boolean)).toBe(true);
      let broken = 0;
      for (let turn = 1; turn < later.length; turn += 1) {
        const history = later[turn - 1]!.input!.slice(0, -1);
        if (JSON.stringify(later[turn]!.input!.slice(0, history.length)) !== JSON.stringify(history)) broken += 1;
      }
      expect(broken).toBeLessThanOrEqual(most);
      if (stepped) expect(broken).toBeGreaterThan(0);
      else expect(broken).toBeGreaterThan(5);
      // The trace says which turns moved their history window: exactly the turns that broke the prefix.
      expect(replyShapes(logs).slice(5).filter((shape) => shape.history_moved).length).toBe(broken);
    } finally { Object.assign(COMPACTION, { budgetTokens: budget }); logs.mockRestore(); net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 120_000);
