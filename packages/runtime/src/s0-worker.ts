import { acquire, connect, endpointURLString, sessions } from '@cloudflare/playwright';
import type { BrowserWorker } from '@cloudflare/playwright';
import { handleS0, S0_PATHS } from './channels/s0-network-block';

// Throwaway staging-only worker for the S0 network-block checks. No owner state, no
// Durable Objects, no model or provider keys. Everything but the static probe routes is bearer-gated.
export default {
  async fetch(request: Request, env: { WALDO_ENVIRONMENT?: string; S0_TOKEN?: string; BROWSER?: BrowserWorker }): Promise<Response> {
    if (!S0_PATHS.includes(new URL(request.url).pathname)) return new Response('not found', { status: 404, headers: { 'x-waldo-s0': 'waldo-s0-staging;path' } });
    return handleS0(request, env, async () => ({ acquire, connect, endpointURLString, sessions }));
  },
};
