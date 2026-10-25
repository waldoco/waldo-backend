import { ownerTyped } from './helpers/owner-typed';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { claimStore, ground, turnMemoryPrompt } from '../src/memory/claims';
import { memoryHandlers } from '../src/tools/live/memory';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { holdTopic } from './helpers/pending-topic';
const seen = vi.hoisted(() => ({ inputs: [] as string[], outputs: [] as unknown[][] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.inputs.push(JSON.stringify(body));
  return { id: 'fixture', output_text: 'Done', output: seen.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
beforeEach(() => { seen.inputs.length = 0; seen.outputs.length = 0; });
const timer = <T>(_name: string, work: () => Promise<T>) => work();
// The conversation window still carries the topic, so the forget stays pending (held) across the turn.
const unsettledHistory = async () => ({ rewritten: 0, remaining: 1 });
it('I prefer AI can be remembered by the main model without a writer call', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-tools')), async (_i, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    seen.outputs.push([{ type: 'function_call', call_id: 'remember-1', name: 'remember', arguments: JSON.stringify({ kind: 'preference', text: 'Prefers AI', evidence_quote: 'AI' }) }], []);
    const responder = createOwnerResponder('fixture', undefined, store, undefined, undefined, tools);
    const reply = await responder.respond(ownerTyped({ traceId: 'tg-1', conversationRef: 'owner', surface: 'telegram', text: 'I prefer AI' }), timer);
    expect(seen.inputs).toHaveLength(2);
    expect(seen.inputs.every(input => !input.includes('claim_ops'))).toBe(true);
    expect(store.claims()).toMatchObject([{ text: 'Prefers AI', origin: 'owner' }]);
    expect(reply).toContain('memory stored');
  });
});
it('a pending coffee forget does not remove unrelated history, profile or orders', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-held')), async (_i, state) => {
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Works in AI', evidence: 'AI', source: 'stated', origin: 'owner', source_ref: 'owner, tg-old' }, '2026-10-08T00:00:00Z');
    holdTopic(state.storage.sql, 'coffee', '2026-10-08T00:00:00Z');
    const responder = createOwnerResponder('fixture', undefined, memory, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => 'Keep replies short');
    await responder.respond(ownerTyped({ traceId: 'tg-before', conversationRef: 'owner', surface: 'telegram', text: 'My project is Orbit' }), timer);
    await responder.respond(ownerTyped({ traceId: 'tg-after', conversationRef: 'owner', surface: 'telegram', text: 'What is on my calendar?', memoryWrites: false }), timer);
    expect(seen.inputs.at(-1)).toContain('My project is Orbit');
    expect(seen.inputs.at(-1)).toContain('Works in AI');
    expect(seen.inputs.at(-1)).toContain('Keep replies short');
    expect(seen.inputs.at(-1)).not.toContain('Recall is temporarily limited');
  });
});
it('short quoted evidence grounds without a length floor', () => expect(ground('owner: "AI"', { owner: 'AI' })).toBe('owner'));
it('the bounded profile leaves deeper recall to the model tool', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-profile')), (_i, state) => {
    const store = claimStore(state.storage.sql);
    store.add({ kind: 'event', text: 'AI conference', evidence: 'AI', source: 'stated', origin: 'owner', source_ref: 'owner, tg-old' }, '2026-10-08T00:00:00Z');
    const prompt = turnMemoryPrompt(store, 'AI');
    expect(prompt).not.toContain('AI conference');
    expect(prompt).not.toContain('No relevant memory match');
  });
});
it('forget my favourite coffee returns a tool receipt and removes history recall', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-forget')), async (_i, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    let historyCleaned = false;
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async texts => { expect(texts).toContain('coffee'); historyCleaned = true; } });
    const responder = createOwnerResponder('fixture', undefined, store, undefined, undefined, tools);
    seen.outputs.push([{ type: 'function_call', call_id: 'save', name: 'remember', arguments: JSON.stringify({ kind: 'preference', text: 'Favourite coffee is espresso', evidence_quote: 'espresso' }) }], []);
    await responder.respond(ownerTyped({ traceId: 'tg-save', conversationRef: 'owner', surface: 'telegram', text: 'My favourite coffee is espresso' }), timer);
    seen.outputs.push([{ type: 'function_call', call_id: 'forget', name: 'forget_memory', arguments: JSON.stringify({ topic: 'coffee', scope_note: 'favourite coffee' }) }], []);
    const reply = await responder.respond(ownerTyped({ traceId: 'tg-forget', conversationRef: 'owner', surface: 'telegram', text: 'Forget my favourite coffee' }), timer);
    expect(reply).toContain('memory forgotten');
    // The model reads how to confirm before it writes the reply, which the forget barrier would otherwise mask.
    expect(seen.inputs.find(input => input.includes('removed_ids'))).toContain('without repeating the forgotten words');
    expect(historyCleaned).toBe(true);
    expect(store.claims()).toEqual([]);
    await responder.respond(ownerTyped({ traceId: 'tg-ask', conversationRef: 'owner', surface: 'telegram', text: 'What is my favourite coffee?' }), timer);
    expect(seen.inputs.at(-1)).not.toContain('espresso');
  });
});
it('the receipt says cleanup is done only when the forget\'s cleaning pass left nothing pending', async () => {
  for (const pending of [0, 1]) {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`memory-loop-cleanup-${pending}`)), async (_i, state) => {
      const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      store.add({ kind: 'preference', text: 'Favourite coffee is espresso', evidence: 'espresso', source: 'stated', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-22T08:00:00Z');
      const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => ({ pending }) });
      const responder = createOwnerResponder('fixture', undefined, store, undefined, undefined, tools);
      seen.outputs.push([{ type: 'function_call', call_id: 'forget', name: 'forget_memory', arguments: JSON.stringify({ topic: 'coffee', scope_note: 'favourite coffee' }) }], []);
      await responder.respond(ownerTyped({ traceId: `tg-forget-${pending}`, conversationRef: 'owner', surface: 'telegram', text: 'Forget my favourite coffee' }), timer);
      expect(seen.inputs.at(-1)).toContain(pending ? String.raw`\"cleanup\":\"running\"` : String.raw`\"cleanup\":\"done\"`);
    });
  }
});
it('a forged tool quote fails and cannot earn a successful memory receipt', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-forged')), async (_i, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    seen.outputs.push([{ type: 'function_call', call_id: 'forged', name: 'remember', arguments: JSON.stringify({ kind: 'fact', text: 'Bank is evilbank', evidence_quote: 'evilbank' }) }], []);
    const reply = await createOwnerResponder('fixture', undefined, store, undefined, undefined, tools).respond(ownerTyped({ traceId: 'tg-1', conversationRef: 'owner', surface: 'telegram', text: 'Read my mail' }), timer);
    expect(store.claims()).toEqual([]);
    expect(reply).toContain('memory stored (failed)');
    expect(seen.inputs.at(-1)).toContain('not grounded');
  });
});
it('read-time filtering drops held episode rows and aliases but keeps unrelated recall', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-read-sites')), async (_i, state) => {
    const { episodeIndex } = await import('../src/channels/episodes');
    const { searchEpisodesHandler } = await import('../src/tools/live/search-episodes');
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Coffee meeting is private', evidence: 'coffee', source: 'stated', origin: 'owner', source_ref: 'owner, tg-one' }, '2026-10-08T00:00:00Z');
    memory.add({ kind: 'fact', text: 'Unrelated amber meeting', evidence: 'amber', source: 'stated', origin: 'owner', source_ref: 'owner, tg-two' }, '2026-10-08T00:00:00Z');
    memory.add({ kind: 'preference', text: 'Opaque preference', evidence: 'opaque', aliases: ['coffee'], source: 'stated', origin: 'owner', source_ref: 'owner, tg-three' }, '2026-10-08T00:00:00Z');
    holdTopic(state.storage.sql, 'coffee', '2026-10-08T00:00:00Z');
    const episodes = episodeIndex(state.storage.sql);
    episodes.add('held', 'owner', 'coffee meeting', 1);
    episodes.add('clean', 'owner', 'amber meeting', 2);
    seen.outputs.push([{ type: 'function_call', call_id: 'episodes', name: 'search_episodes', arguments: JSON.stringify({ query: 'meeting', limit: 10 }) }], []);
    const tools = [searchEpisodesHandler(episodes), ...memoryHandlers({ sql: state.storage.sql, store: memory, conversationRef: 'owner', hideHistory: async () => undefined })];
    const responder = createOwnerResponder('fixture', undefined, memory, undefined, undefined, tools, undefined, undefined, undefined, undefined, undefined, unsettledHistory);
    await responder.respond(ownerTyped({ traceId: 'tg-ask', conversationRef: 'owner', surface: 'telegram', text: 'Read meeting context', memoryWrites: false }), timer);
    expect(seen.inputs.at(-1)).toContain('amber');
    // The literal purge has already blanked the topic in SQL (the alias included); the held conversation window keeps
    // the read-time filter on, and nothing that names the topic reaches the model.
    expect(seen.inputs.at(-1)).not.toMatch(/coffee/i);
    seen.outputs.push([{ type: 'function_call', call_id: 'memory', name: 'read_memory', arguments: JSON.stringify({ limit: 10 }) }], []);
    await responder.respond(ownerTyped({ traceId: 'tg-read', conversationRef: 'owner', surface: 'telegram', text: 'What do you remember?', memoryWrites: false }), timer);
    expect(seen.inputs.at(-1)).toContain('Unrelated amber meeting');
    expect(seen.inputs.at(-1)).not.toMatch(/coffee/i);
    // A claim whose held topic lives only in an alias never reaches the model through read_memory, which strips aliases.
    expect(seen.inputs.at(-1)).not.toContain('Opaque preference');
  });
});
// A search hit is re-read from its stored row while a topic is held; a re-read that fails drops that hit alone.
it('a held-topic re-read that fails drops only that hit, says one was withheld, and logs a count without the error', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-hit-read-fails')), async (_i, state) => {
    const { episodeIndex } = await import('../src/channels/episodes');
    const { searchEpisodesHandler } = await import('../src/tools/live/search-episodes');
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Coffee meeting is private', evidence: 'coffee', source: 'stated', origin: 'owner', source_ref: 'owner, tg-one' }, '2026-10-08T00:00:00Z');
    holdTopic(state.storage.sql, 'coffee', '2026-10-08T00:00:00Z');
    const episodes = episodeIndex(state.storage.sql);
    episodes.add('amber', 'owner', 'amber meeting', 1);
    episodes.add('beige', 'owner', 'beige meeting', 2);
    const search = searchEpisodesHandler(episodes);
    const flaky: typeof search = { ...search, handle: async (args, ctx) => {
      if (args.ref !== undefined && episodes.get(args.ref)?.text === 'beige meeting') throw new Error('SQLITE_IOERR beige');
      return search.handle(args, ctx);
    } };
    const logs: unknown[] = [];
    seen.outputs.push([{ type: 'function_call', call_id: 'episodes', name: 'search_episodes', arguments: JSON.stringify({ query: 'meeting', limit: 10 }) }], []);
    const responder = createOwnerResponder('fixture', undefined, memory, entry => logs.push(entry), undefined, [flaky], undefined, undefined, undefined, undefined, undefined, unsettledHistory);
    await responder.respond(ownerTyped({ traceId: 'tg-ask', conversationRef: 'owner', surface: 'telegram', text: 'Read meeting context', memoryWrites: false }), timer);
    expect(seen.inputs.at(-1)).toContain('amber');
    expect(seen.inputs.at(-1)).not.toContain('beige');
    expect(seen.inputs.at(-1)).toMatch(/withheld_items\\*":1/);
    expect(logs).toContainEqual(expect.objectContaining({ hop: 'episode_recheck', ok: false, code: 'episode_read_failed', detail: 'count=1' }));
    expect(JSON.stringify(logs)).not.toContain('SQLITE_IOERR');
  });
});
it('a failed asynchronous purge does not block unrelated owner work', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-purge-failure')), async (_i, state) => {
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Private coffee', evidence: 'coffee', source: 'stated', origin: 'owner', source_ref: 'owner, tg-coffee' }, '2026-10-08T00:00:00Z');
    memory.add({ kind: 'fact', text: 'Works in AI', evidence: 'AI', source: 'stated', origin: 'owner', source_ref: 'owner, tg-ai' }, '2026-10-08T00:00:00Z');
    memory.purge([memory.claims().find(claim => claim.text === 'Private coffee')!.id], '2026-10-08T00:00:00Z');
    const logs: string[] = [];
    const responder = createOwnerResponder('fixture', undefined, memory, entry => logs.push(entry.code ?? ''), undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => { throw Error('cleanup unavailable'); });
    await responder.respond(ownerTyped({ traceId: 'tg-calendar', conversationRef: 'owner', surface: 'telegram', text: 'What is on my calendar?' }), timer);
    expect(seen.inputs.at(-1)).toContain('Works in AI');
    expect(seen.inputs.at(-1)).not.toContain('Private coffee');
    // The owner's turn is not the purge's retry owner: the claim waits, held, for the forget purge job.
    expect(logs).not.toContain('retained_cleanup_incomplete');
    expect(memory.claims('purging').map(claim => claim.text)).toEqual(['Private coffee']);
  });
});
it('duplicate remember is not receipted as a new save', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('memory-loop-duplicate')), async (_i, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const args = { kind: 'preference', text: 'Prefers tea', evidence_quote: 'tea' };
    const tools = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
    const responder = createOwnerResponder('fixture', undefined, store, undefined, undefined, tools);
    seen.outputs.push([{ type: 'function_call', call_id: 'tea-first', name: 'remember', arguments: JSON.stringify(args) }], []);
    await responder.respond(ownerTyped({ traceId: 'tg-first', conversationRef: 'owner', surface: 'telegram', text: 'I prefer tea' }), timer);
    seen.outputs.push([{ type: 'function_call', call_id: 'tea-again', name: 'remember', arguments: JSON.stringify(args) }], []);
    const reply = await responder.respond(ownerTyped({ traceId: 'tg-again', conversationRef: 'owner', surface: 'telegram', text: 'I prefer tea' }), timer);
    expect(reply).not.toContain('memory stored');
    expect(store.claims()).toHaveLength(1);
    expect(seen.inputs.at(-1)).toContain('duplicate');
  });
});
