import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

vi.mock('openai', () => ({ default: class { responses = { create: async () => ({ id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }) }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');
const { OWNER_REQUEST_HOP } = await import('../src/channels/harness');

// The console's "last request" starts at this marker, so every owner turn must log it once, before any other hop of that trace.
it('each owner turn logs the owner_request marker once, ahead of its other hops', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('owner-request-hop')), async (_i, state) => {
    const entries: { trace: string; hop: string }[] = [];
    const responder = createOwnerResponder('fixture', undefined, claimStore(state.storage.sql) as never, (entry) => { entries.push(entry as { trace: string; hop: string }); });
    for (const trace of ['tg-1', 'tg-2']) await responder.respond({ traceId: trace, conversationRef: 'owner', surface: 'telegram', text: `ping ${trace}` }, (_n, work) => work());
    for (const trace of ['tg-1', 'tg-2']) {
      const hops = entries.filter(entry => entry.trace === trace).map(entry => entry.hop);
      expect(hops.length).toBeGreaterThan(1);
      expect(hops[0]).toBe(OWNER_REQUEST_HOP);
      expect(hops.filter(hop => hop === OWNER_REQUEST_HOP)).toHaveLength(1);
    }
  });
});
