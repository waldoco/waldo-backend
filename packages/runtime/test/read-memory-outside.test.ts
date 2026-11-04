import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { memoryHandlers } from '../src/tools/live/memory';

// A job built from outside content reads the owner's memory through read_memory under the same fence as its memory block:
// no health note, no stated reading, nothing filed under body or mind, by search, by area or unfiltered. The host sets
// what the job was built from; the model's arguments cannot widen it.
const AT = '2026-10-30T04:00:00Z';
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const READS = [{ area: 'mind' }, { area: 'body' }, { query: 'board meetings stressed knee pulse' }, { limit: 20 }];

const readsIn = (name: string, taint?: 'external') => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  const memory = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
  const said = (text: string, kind: string, area?: 'mind' | 'body' | 'work') =>
    memory.add({ kind, text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: `owner, ${text}`, ...(area ? { area } : {}) }, AT);
  said('Stressed before board meetings', 'observation', 'mind');
  said('Knee aches after long runs', 'observation', 'body');
  said('Knee physio exercises every morning', 'health', 'work');
  said('Pulse reads 61 after the stairs', 'observation', 'work');
  said('Board meets on Thursdays', 'event', 'work');
  const requests: LLMGatewayRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    const args = READS[requests.length - 1];
    return args ? { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: `call-${requests.length}`, name: 'read_memory', arguments: JSON.stringify(args) }] } } : { ok: true, data: { ...base, text: 'Done.' } };
  } };
  const tools = memoryHandlers({ sql: state.storage.sql, store: memory, conversationRef: 'telegram-1', hideHistory: async () => undefined });
  const responder = createOwnerResponder('fixture', undefined, memory, undefined, undefined, tools as never, undefined, false, undefined, undefined, gateway);
  await responder.prompt(`${name}-job`, 'owner', 'Summarise this forwarded note for the owner.', time, 'telegram', ['read_memory'], undefined, undefined, undefined, taint);
  return (requests.at(-1)!.request.tool_turns ?? []).map((turn) => turn.output).join('\n');
});

it('a job built from outside content reads nothing filed under body or mind, and no health, however it asks', async () => {
  const read = await readsIn('read-memory-outside-external', 'external');
  expect(read).toContain('Board meets on Thursdays');
  for (const kept of ['Stressed before board meetings', 'Knee aches after long runs', 'Knee physio', 'Pulse reads']) expect(read, kept).not.toContain(kept);
});

it('a job the owner\'s own words started reads all of it', async () => {
  const read = await readsIn('read-memory-outside-owner');
  for (const shown of ['Stressed before board meetings', 'Knee aches after long runs', 'Knee physio exercises every morning', 'Board meets on Thursdays']) expect(read, shown).toContain(shown);
});
