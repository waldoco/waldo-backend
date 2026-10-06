import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

vi.mock('openai', () => ({ default: class { responses = { create: async () => ({ id: 'fixture', output_text: 'pong', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }) }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { claimStore } = await import('../src/memory/claims');
const { OWNER_REQUEST_HOP, traceBook } = await import('../src/channels/harness');

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

// End to end inside one owner DO: owner turn -> the same record sink the DO uses -> lastRequest.
it('an owner turn recorded through the trace book becomes the console last request', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('owner-request-e2e')), async (_i, state) => {
    const book = traceBook(state.storage.sql);
    const responder = createOwnerResponder('fixture', undefined, claimStore(state.storage.sql) as never, (entry) => { book.record(entry as never, Date.now()); });
    await responder.respond({ traceId: 'tg-e2e-1', conversationRef: 'owner', surface: 'telegram', text: 'ping' }, (_n, work) => work());
    book.record({ trace: 'card:brief:1', hop: 'llm_reply', ms: 5, ok: true }, Date.now());
    const last = book.lastRequest('UTC');
    expect(last?.trace).toBe('tg-e2e-1');
    expect(last?.hops[0]?.hop).toBe(OWNER_REQUEST_HOP);
    expect(last?.hops.length).toBe(last?.recorded_steps);
    const { projectControls } = await import('../src/channels/dashboard-controls');
    const { SAMPLE_CONSOLE_VIEW } = await import('./fixtures/console-sample');
    const shown = projectControls({ ...SAMPLE_CONSOLE_VIEW, lastRequest: last }, 'activity').data.last_request as Record<string, unknown>;
    expect(JSON.stringify(shown)).not.toContain('tg-e2e-1');
    expect((shown.hops as { hop: string }[])[0]?.hop).toBe(OWNER_REQUEST_HOP);
  });
});
