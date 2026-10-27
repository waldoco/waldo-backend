import { describe, expect, it } from 'vitest';
import { OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { openAIDecisionsRouter, ROUTER_RECENT_TURNS } from '../src/llm/router/decisions';

type Sent = { url: string; init: RequestInit; body: Record<string, unknown> };
const answering = (body: unknown, status = 200) => {
  const sent: Sent[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, fetcher };
};
const choice = (value: unknown, confidence: unknown) => ({
  model: OPENAI_GPT_6_LUNA_MODEL, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
  answers: [{ type: 'choice', name: 'tier', choice: value, confidence, probabilities: [] }],
});
const owner = (text: string) => ({ role: 'owner' as const, text });

describe('the Decisions router adapter', () => {
  it('asks Luna one choice question about the recent turns, with the key as a bearer credential, and reads the tier and confidence', async () => {
    const { sent, fetcher } = answering(choice('deep', 0.87));
    const router = openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: fetcher });
    expect(await router.route([owner('Plan my week around the board deck and two flights'), { role: 'waldo', text: 'On it.' }, owner('Also move gym')])).toEqual({ tier: 'deep', confidence: 0.87 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/decisions');
    expect(new Headers(sent[0]!.init.headers).get('authorization')).toBe('Bearer sk-fixture-not-a-secret');
    expect(sent[0]!.body).toMatchObject({
      model: OPENAI_GPT_6_LUNA_MODEL,
      input: [{ role: 'user', content: 'Plan my week around the board deck and two flights' }, { role: 'assistant', content: 'On it.' }, { role: 'user', content: 'Also move gym' }],
      questions: [{ type: 'choice', name: 'tier', choices: ['light', 'standard', 'deep'].map((value) => expect.objectContaining({ value })) }],
    });
    expect(sent[0]!.body).not.toHaveProperty('safety_identifier');
  });

  it('sends only the latest turns', async () => {
    const { sent, fetcher } = answering(choice('standard', 0.9));
    const turns = Array.from({ length: ROUTER_RECENT_TURNS + 3 }, (_, index) => owner(`turn ${index}`));
    await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: fetcher }).route(turns);
    expect((sent[0]!.body.input as unknown[]).length).toBe(ROUTER_RECENT_TURNS);
    expect(JSON.stringify(sent[0]!.body.input)).toContain(`turn ${ROUTER_RECENT_TURNS + 2}`);
  });

  it('sends nothing when a turn carries a secret or a canary, and withholds health readings from what it does send', async () => {
    const quiet = answering(choice('standard', 0.9));
    expect(await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: quiet.fetcher }).route([owner('my key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')])).toBeNull();
    expect(quiet.sent).toHaveLength(0);
    const { sent, fetcher } = answering(choice('standard', 0.9));
    await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: fetcher }).route([owner('My HRV was 42 ms this morning, plan an easy day')]);
    expect(JSON.stringify(sent[0]!.body)).not.toContain('42');
  });

  it('falls back (null) on a refusal, an unknown or malformed answer, an HTTP error, a network error, a timeout, or nothing to ask', async () => {
    const cases: unknown[] = [
      { model: OPENAI_GPT_6_LUNA_MODEL, usage: {}, answers: [{ type: 'refusal', name: 'tier' }] },
      choice('opus', 0.9), choice('deep', 1.5), choice('deep', '0.9'), choice(true, 0.9), { answers: [] }, 'not json at all',
    ];
    for (const body of cases) {
      const { fetcher } = answering(body);
      expect(await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: fetcher }).route([owner('hi')])).toBeNull();
    }
    expect(await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: answering(choice('deep', 0.9), 403).fetcher }).route([owner('hi')])).toBeNull();
    const broken = (async () => { throw new TypeError('network down'); }) as typeof fetch;
    expect(await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: broken }).route([owner('hi')])).toBeNull();
    const hanging = ((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))) as typeof fetch;
    expect(await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: hanging, timeoutMs: 20 }).route([owner('hi')])).toBeNull();
    expect(await openAIDecisionsRouter({ apiKey: 'sk-fixture-not-a-secret', fetch: answering(choice('deep', 0.9)).fetcher }).route([])).toBeNull();
  });

  it('never calls out without a usable key', async () => {
    const { sent, fetcher } = answering(choice('deep', 0.9));
    expect(await openAIDecisionsRouter({ apiKey: '', fetch: fetcher }).route([owner('hi')])).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
