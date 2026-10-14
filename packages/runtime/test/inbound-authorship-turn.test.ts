import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import { claimStore } from '../src/memory/claims';
import { memoryHandlers } from '../src/tools/live/memory';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';

const seen = vi.hoisted(() => ({ inputs: [] as string[], outputs: [] as unknown[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.inputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: 'Noted.', output: seen.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createTelegramResponder } = await import('../src/channels/telegram-turn');
beforeEach(() => { seen.inputs.length = 0; seen.outputs.length = 0; });

const timer = <T>(_name: string, work: () => Promise<T>) => work();
const OWN = 'my sister is called Mira. Look what Sam wrote:\n', QUOTE = 'I swim every Friday before work';
const turnFrom = async (message: Record<string, unknown>) => (await new TelegramPollingAdapter({ getUpdates: async () => [
  { update_id: 300, message: { message_id: 41, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, ...message } },
] }).poll(0)).accepted[0]!;
// The request body is JSON, so the expected model text is looked for in its JSON-escaped form.
const inModelInput = (text: string) => seen.inputs.some(input => input.includes(JSON.stringify(text).slice(1, -1)));

for (const [name, message, block] of [
  ['a pasted quote', { text: `${OWN}${QUOTE}`, entities: [{ type: 'blockquote', offset: OWN.length, length: QUOTE.length }] }, `${OWN}\n[Quoted by the owner; not their words:]\n${JSON.stringify(QUOTE)}\n[End of quote.]`],
  ['a forwarded message', { text: QUOTE, forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'Sam' }, forward_sender_name: 'Sam', forward_date: 1 }, `[Forwarded by the owner from someone else:]\n${JSON.stringify(QUOTE)}\n[End of forwarded text.]`],
] as const) {
  it(`the model reads ${name} under its label; the stored message is the text as received, with no label`, async () => {
    const entries: ConversationEntry[] = [];
    const responder = createTelegramResponder('fixture', { load: async () => ({ entries: [], leafId: null }), save: async rows => { entries.push(...rows); } });
    await responder.respond(await turnFrom(message), timer);
    expect(inModelInput(block)).toBe(true);
    expect(entries[0]).toMatchObject({ id: 'tg-300', role: 'user', modelPayload: block, appPayload: message.text });
  });
}

it('a remember sourced to a voice transcript is refused through the turn, while the owner\'s caption beside it grounds', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('inbound-transcript-remember')), async (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'telegram-7', hideHistory: async () => undefined });
    seen.outputs.push([
      { type: 'function_call', call_id: 'from-transcript', name: 'remember', arguments: JSON.stringify({ kind: 'fact', text: 'Swims every Friday before work', evidence_quote: QUOTE }) },
      { type: 'function_call', call_id: 'from-caption', name: 'remember', arguments: JSON.stringify({ kind: 'fact', text: 'Has a sister called Mira', evidence_quote: 'my sister is called Mira' }) },
    ], []);
    const responder = createTelegramResponder('fixture', undefined, store, undefined, { download: async () => new Uint8Array([1]), transcribe: async () => QUOTE }, undefined, tools);
    await responder.respond(await turnFrom({ caption: 'my sister is called Mira. Listen to what Sam said.', audio: { file_id: 'a', file_name: 'sam.m4a', mime_type: 'audio/mp4', file_size: 1 } }), timer);
    expect(inModelInput(`[Transcript of a file the owner sent; the speaker may not be the owner:]\n${JSON.stringify(QUOTE)}\n[End of transcript.]`)).toBe(true);
    expect(store.claims().map(claim => claim.text)).toEqual(['Has a sister called Mira']);
  });
});
