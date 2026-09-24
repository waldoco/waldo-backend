import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';

const bodies: Array<Record<string, unknown>> = [];
vi.mock('openai', () => ({
  default: class {
    responses = {
      create: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return { id: `resp_${bodies.length}`, output_text: 'Your sleep looks steady this week.', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      },
    };
  },
}));

const { createTelegramResponder } = await import('../src/channels/telegram-turn');

const tokens = (value: unknown) => Math.ceil(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value) ?? '').byteLength / 4);

describe('token baseline (phase 1 measurement)', () => {
  it('captures per-hop request composition over a six-turn conversation', async () => {
    let saved: { entries: readonly ConversationEntry[]; leafId: string | null } = { entries: [], leafId: null };
    const store = {
      load: async () => saved,
      save: async (entries: readonly ConversationEntry[], leafId: string) => { saved = { entries, leafId }; },
    };
    const responder = createTelegramResponder('test-key', store, undefined, () => undefined, {}, { timezone: 'UTC', now: () => new Date('2026-09-24T05:00:00Z') });
    for (let turn = 0; turn < 6; turn++) {
      await responder.respond({ updateId: turn + 1, chatId: 7, text: `message ${turn + 1}: how is my sleep trend and what should I focus on today?` } as never, (_name, run) => run());
    }
    const rows = bodies.map((body) => ({ instructions: tokens(body.instructions), input: tokens(body.input), tools: tokens(body.tools ?? []) }));
    console.log('BASELINE_PER_HOP ' + JSON.stringify(rows));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.instructions).toBeLessThan(8192);
  });
});
