import { describe, expect, it } from 'vitest';
import { WORKERS_AI_BGE_M3_EMBEDDING_MODEL } from '@waldo/contracts';
import { workersAiEmbedder } from '../src/memory/semantic-recall';
import { workersAiRest } from '../evals/nightly/embeddings';

const TOKEN = 'cf-token-secret';
const answering = (status: number, body: unknown) => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  return { sent, fetcher };
};

describe('Workers AI over REST, for a live eval run', () => {
  it('posts the texts to the account\'s bge-m3 route with the token as a bearer, and reads the vectors from result', async () => {
    const { sent, fetcher } = answering(200, { success: true, errors: [], messages: [], result: { shape: [2, 2], data: [[1, 0], [0, 1]], pooling: 'cls' } });
    const vectors = await workersAiEmbedder(workersAiRest({ accountId: 'acct', token: TOKEN, fetcher })).embed(['one', 'two']);
    expect(vectors).toEqual([[1, 0], [0, 1]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${WORKERS_AI_BGE_M3_EMBEDDING_MODEL}`);
    expect(sent[0]!.init).toMatchObject({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ text: ['one', 'two'] }) });
  });

  it('fails on a refused or unsuccessful answer, naming the status and never the token', async () => {
    for (const [status, body] of [[403, { success: false, errors: [{ message: `bad token ${TOKEN}` }] }], [200, { success: false, result: null }]] as const) {
      const { fetcher } = answering(status, body);
      const failure = await workersAiRest({ accountId: 'acct', token: TOKEN, fetcher }).run(WORKERS_AI_BGE_M3_EMBEDDING_MODEL, { text: ['one'] }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(`workers ai rest ${status}`);
      expect((failure as Error).message).not.toContain(TOKEN);
    }
  });
});
