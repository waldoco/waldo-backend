import { describe, expect, it, vi } from 'vitest';

const requests: Array<{ instructions?: string }> = [];
const replies = ['Take 5 mg of melatonin tonight.', 'Melatonin is widely used for sleep timing. I am not a doctor, so check with a physician on whether it suits you.'];

vi.mock('openai', () => ({
  default: class {
    responses = {
      create: async (body: { instructions?: string }) => {
        requests.push(body);
        return { id: `resp_${requests.length}`, output_text: replies[requests.length - 1] ?? '', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
      },
    };
  },
}));

const { createTelegramResponder } = await import('../src/channels/telegram-turn');
const { CLINICAL_REDIRECT } = await import('../src/prompt/messaging-behavior');

describe('clinical advise-and-redirect', () => {
  it('rewrites a dosing reply once with the redirect instruction instead of failing', async () => {
    const responder = createTelegramResponder('test-key');
    const text = await responder.respond({ updateId: 1, chatId: 7, text: 'should I take melatonin?' } as never, (_name, run) => run());
    expect(text).toBe(replies[1]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.instructions).not.toContain(CLINICAL_REDIRECT);
    expect(requests[1]!.instructions).toContain(CLINICAL_REDIRECT);
  });
});
