import { acquire, connect, endpointURLString, sessions } from '@cloudflare/playwright';
import type { BrowserWorker } from '@cloudflare/playwright';
import { handleS0 } from './channels/s0-network-block';

// Throwaway staging-only worker for the S0 network-block test. No owner state, no
// Durable Objects, no model or provider keys. It answers only the bearer-gated S0 POST.
export default {
  async fetch(request: Request, env: { WALDO_ENVIRONMENT?: string; S0_TOKEN?: string; BROWSER?: BrowserWorker }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/s0' && path !== '/s0/ping') return new Response('not found', { status: 404, headers: { 'x-waldo-s0': 'waldo-s0-staging;path' } });
    return handleS0(request, env, async () => ({ acquire, connect, endpointURLString, sessions }));
  },
};
