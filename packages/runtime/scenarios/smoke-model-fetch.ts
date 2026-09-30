// Test-only outbound boundary. Workers supports manual, not error, redirects.
export type SmokeRequestReceipt = { url: string; status: number | null; response_id: string | null; model: string | null; usage: unknown; failure: 'transport' | 'redirect' | 'response_json' | null };
export const smokeModelFetch = (network: typeof fetch, requests: SmokeRequestReceipt[], denied: string[]): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.href !== 'https://api.openai.com/v1/responses' || method !== 'POST') {
      denied.push(url.origin + url.pathname); throw new Error('unexpected smoke network destination');
    }
    if (requests.length >= 8) throw new Error('smoke model request cap reached');
    // Reserve attempts before await so failed/concurrent requests still count.
    const receipt: SmokeRequestReceipt = { url: url.href, status: null, response_id: null, model: null, usage: null, failure: null };
    requests.push(receipt);
    let response: Response;
    try { response = await network(input, { ...init, redirect: 'manual' }); }
    catch { receipt.failure = 'transport'; throw new Error('smoke model transport failed'); }
    receipt.status = response.status;
    if (response.status >= 300 && response.status < 400) {
      receipt.failure = 'redirect'; throw new Error('smoke model redirect rejected');
    }
    try {
      const body = await response.clone().json() as { id?: unknown; model?: unknown; usage?: unknown };
      receipt.response_id = typeof body?.id === 'string' ? body.id : null;
      receipt.model = typeof body?.model === 'string' ? body.model : null;
      receipt.usage = body?.usage ?? null;
    } catch { receipt.failure = 'response_json'; }
    return response;
  }) as typeof fetch;
