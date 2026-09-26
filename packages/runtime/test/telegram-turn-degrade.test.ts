import { describe, expect, it, vi } from 'vitest';

const requests: Array<unknown> = [];
vi.mock('openai', () => ({
  default: class {
    responses = {
      create: async (body: unknown) => {
        requests.push(body);
        return { id: `resp_${requests.length}`, output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      },
    };
  },
}));

const { createTelegramResponder } = await import('../src/channels/telegram-turn');

// A triple-nested percent encoding still decodes after the scribe's 2-pass limit, so the deny is
// correct and stays: this shape is probe-verified to fail decodedViews at internal_context.
const POISON = 'look %252525 here';

describe('poisoned history degrade', () => {
  it('one unrenderable historical entry cannot brick the chat, and the degraded retry never carries it', async () => {
    const entry = {
      id: 'h1', ownerId: 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chatId: 'telegram-7',
      parentId: null, threadAnchorId: null, surface: 'telegram',
      modelPayload: POISON, appPayload: POISON, modelProjection: { mode: 'include' },
    };
    const store = { load: async () => ({ entries: [entry], leafId: 'h1' }), save: async () => undefined };
    const responder = createTelegramResponder('test-key', store as never);
    const text = await responder.respond({ updateId: 2, chatId: 7, text: 'hello' } as never, (_name, run) => run());
    expect(text).toBe('pong');
    expect(requests.length).toBeGreaterThan(0);
    for (const body of requests) expect(JSON.stringify(body)).not.toContain('%252525');
  });

  it('the sanitizer still denies the poisoned shape when it is the CURRENT message - no bypass', async () => {
    const responder = createTelegramResponder('test-key');
    await expect(
      responder.respond({ updateId: 3, chatId: 7, text: POISON } as never, (_name, run) => run()),
    ).rejects.toThrow('scribe_sanitise');
  });

  it('records the typed preflight reason for capture-off sinks', async () => {
    const entries: Array<{ hop: string; code?: string }> = [];
    const responder = createTelegramResponder('test-key', undefined, undefined, (entry) => {
      entries.push(entry);
    });
    await expect(
      responder.respond({ updateId: 4, chatId: 7, text: 'check 19c8a1b2f3d4e5f6' } as never, (_name, run) => run()),
    ).rejects.toThrow('scribe_sanitise');
    const llm = entries.find((entry) => entry.hop === 'llm_reply');
    expect(llm?.code).toBe('forbidden:scribe_sanitise:internal_context:canary_leak');
  });
});
