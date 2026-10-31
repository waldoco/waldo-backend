import type { EmbeddingRunner } from '../../src/memory/semantic-recall';

// Workers AI over Cloudflare's REST API, for a live run outside a Worker: the same model the owner object reaches through
// its AI binding. The REST answer wraps the model's output in `result` beside `success` and `errors`
// (developers.cloudflare.com/workers-ai/get-started/rest-api). An error names the status only, never the token or a text.
export const workersAiRest = ({ accountId, token, fetcher = fetch }: Readonly<{ accountId: string; token: string; fetcher?: typeof fetch }>): EmbeddingRunner => ({
  async run(model, input) {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => null) as { success?: boolean; result?: unknown } | null;
    if (!response.ok || body?.success !== true) throw new Error(`workers ai rest ${response.status}`);
    return body.result;
  },
});
