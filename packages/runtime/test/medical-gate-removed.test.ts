import { describe, expect, it, vi } from 'vitest';

const requests: Array<{ instructions?: string }> = [];
const DOSE_TEXT = 'Take 5 mg of melatonin tonight.';

vi.mock('openai', () => ({
  default: class {
    responses = {
      create: async (body: { instructions?: string }) => {
        requests.push(body);
        return { id: `resp_${requests.length}`, output_text: DOSE_TEXT, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      },
    };
  },
}));

const { createTelegramResponder } = await import('../src/channels/telegram-turn');
const { HOOK_REGISTRY } = await import('../src/hooks/registry');

// Layer: SOURCE (mocked provider). Dose wording in a model output is no longer halted by a regex gate;
// the model-judged messaging rule ("never give medication, supplement or dose instructions") stays in the prompt.
describe('regex medical gate removed', () => {
  it('a model output with dose wording passes through in one call, with no redirect retry', async () => {
    const responder = createTelegramResponder('test-key');
    const text = await responder.respond({ updateId: 1, chatId: 7, text: 'what is in my notes?' } as never, (_name, run) => run());
    expect(text).toBe(DOSE_TEXT);
    expect(requests).toHaveLength(1);
  });

  it('no medical_gate hook is registered', () => {
    expect(HOOK_REGISTRY.map((h) => h.name)).not.toContain('medical_gate');
  });
});
