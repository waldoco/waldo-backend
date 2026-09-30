import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
vi.mock('openai', () => ({ default: class { responses = { create: async () => ({ id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }) }; } }));
const { createOwnerResponder, ownerToolApproval } = await import('../src/channels/owner-turn');
const { createTelegramResponder, telegramTurnEnvelope } = await import('../src/channels/telegram-turn');
const time = <T>(_hop: string, work: () => Promise<T>) => work();

describe('channel-neutral owner conversation seam', () => {
  for (const surface of ['telegram', 'whatsapp', 'app']) {
    it(`core preserves ${surface} identity without a Telegram update`, async () => {
      const entries: ConversationEntry[] = [];
      const store = { load: async () => ({ entries: [], leafId: null }), save: async (rows: readonly ConversationEntry[]) => { entries.push(...rows); } };
      const responder = createOwnerResponder('fixture-key', store);
      expect(await responder.respond({ traceId: `${surface}-fixture-1`, conversationRef: `${surface}-owner-7`, surface, text: 'hello' }, time)).toBe('pong');
      expect(entries[0]).toMatchObject({ id: `${surface}-fixture-1`, chatId: `${surface}-owner-7`, surface });
      expect(JSON.stringify(entries)).not.toContain('telegram-7');
    });
  }
  it('Telegram adapter preserves existing trace and conversation IDs', () => {
    expect(telegramTurnEnvelope({ updateId: 12, chatId: 7, text: 'hello' } as never)).toEqual({ traceId: 'tg-12', conversationRef: 'telegram-7', surface: 'telegram', text: 'hello' });
  });
  it('WhatsApp compatibility adapter no longer labels persisted entries Telegram', async () => {
    const entries: ConversationEntry[] = [];
    const args: Parameters<typeof createTelegramResponder> = ['fixture-key', { load: async () => ({ entries: [], leafId: null }), save: async rows => { entries.push(...rows); } }];
    args[22] = 'whatsapp';
    const responder = createTelegramResponder(...args);
    expect(await responder.respond({ updateId: 9000000000001, chatId: 777, text: 'hello' } as never, time)).toBe('pong');
    expect(entries[0]).toMatchObject({ id: 'whatsapp-9000000000001', chatId: 'whatsapp-777', surface: 'whatsapp' });
  });
  it('approval policy remains identical across transports', () => {
    for (const tool of ['execute_action', 'delete_message', 'restore_message']) expect(ownerToolApproval({ tool })).toBe(false);
    expect(ownerToolApproval({ tool: 'get_context' })).toBe(true);
  });
});

it('same numeric transport sequence does not collide across host surfaces', async () => {
  const { ownerTurnTrace } = await import('../src/channels/owner-turn-envelope');
  expect(ownerTurnTrace('telegram', 12)).toBe('tg-12');
  expect(ownerTurnTrace('whatsapp', 12)).toBe('whatsapp-12');
  expect(telegramTurnEnvelope({ updateId: 12, chatId: 7, text: 'same id' } as never, 'whatsapp').traceId).toBe(ownerTurnTrace('whatsapp', 12));
});
