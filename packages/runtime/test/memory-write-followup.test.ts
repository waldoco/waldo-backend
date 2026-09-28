import { describe, expect, it, vi } from 'vitest';

// The memory-writer hop is the claim_ops schema call; the reply hop is plain text.
// memoryFails flips the writer between throwing (provider down) and returning empty ops.
let memoryFails = true;
vi.mock('openai', () => ({
  default: class {
    responses = {
      create: async (body: unknown) => {
        if (JSON.stringify(body).includes('claim_ops')) {
          if (memoryFails) throw new Error('writer unavailable');
          return { id: 'resp_mem', output_text: '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
        }
        return { id: `resp_${Math.random()}`, output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      },
    };
  },
}));

const { createTelegramResponder } = await import('../src/channels/telegram-turn');

const fakeMemory = {
  claims: () => [],
  nodes: () => [],
  edges: () => [],
  barriers: () => [],
  beginSettle: () => undefined,
  endSettle: () => undefined,
  settle: () => undefined,
  sweepInterruptedSettles: () => 0,
};

const drive = () => {
  const notes: Array<unknown> = [];
  let pending: Promise<unknown> | undefined;
  const responder = createTelegramResponder(
    'test-key', undefined, fakeMemory as never, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, (work) => { pending = work; },
    (error) => notes.push(error),
  );
  const turn = async (updateId: number) => {
    const text = await responder.respond({ updateId, chatId: 7, text: 'hello' } as never, (_name, run) => run());
    expect(text).toBe('pong');
    await pending;
  };
  return { notes, turn };
};

describe('memory-write failure follow-up', () => {
  it('notifies once per failure streak, and again after a success resets the latch', async () => {
    const { notes, turn } = drive();
    memoryFails = true;
    await turn(1);
    expect(notes).toHaveLength(1);
    // A second consecutive failure stays silent: no spam during a provider outage.
    await turn(2);
    expect(notes).toHaveLength(1);
    // A successful settle resets the latch without notifying.
    memoryFails = false;
    await turn(3);
    expect(notes).toHaveLength(1);
    // The next failure notifies again.
    memoryFails = true;
    await turn(4);
    expect(notes).toHaveLength(2);
  });
});
