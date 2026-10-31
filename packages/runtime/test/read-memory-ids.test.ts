import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { claimStore, textFingerprint } from '../src/memory/claims';
import { NODE_STATEMENT } from '../src/memory/node-sources';
import { memoryHandlers } from '../src/tools/live/memory';

// read_memory({ ids }) opens a stub by its id through the same filters as every other read: an id the read may not show
// (held, forgotten, being purged, superseded, untrusted, a node's statement, or health in a job built from outside content)
// comes back exactly as an id that does not exist. Synthetic fixtures only.
const AT = '2026-10-31T04:00:00Z';
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();

const readIds = (name: string, seed: (said: (text: string, kind?: string, origin?: string) => number, memory: ReturnType<typeof claimStore>, sql: SqlStorage) => readonly number[], taint?: 'external') =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const memory = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
    const said = (text: string, kind = 'fact', origin = 'owner') => {
      memory.add({ kind, text, source: origin === 'owner' ? 'stated' : 'inferred', evidence: text, origin, source_ref: `owner, ${text}` }, AT);
      return memory.allClaims().find((claim) => claim.text === text)!.id;
    };
    const ids = seed(said, memory, state.storage.sql);
    const requests: LLMGatewayRequest[] = [];
    const gateway: LLMGatewayAdapter = { complete: async (input) => {
      requests.push(input);
      const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
      return requests.length === 1
        ? { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: 'call-1', name: 'read_memory', arguments: JSON.stringify({ ids }) }] } }
        : { ok: true, data: { ...base, text: 'Done.' } };
    } };
    const tools = memoryHandlers({ sql: state.storage.sql, store: memory, conversationRef: 'telegram-1', hideHistory: async () => undefined });
    const responder = createOwnerResponder('fixture', undefined, memory, undefined, undefined, tools as never, undefined, false, undefined, undefined, gateway);
    await responder.prompt(`${name}-turn`, 'owner', 'Open those notes.', time, 'telegram', ['read_memory'], undefined, undefined, undefined, taint);
    const output = JSON.parse(requests.at(-1)!.request.tool_turns!.at(-1)!.output) as { ok: boolean; data: { claims: { id: number; text: string }[] } };
    return output.data.claims.map((claim) => claim.text);
  });

const seedAll = (said: (text: string, kind?: string, origin?: string) => number, memory: ReturnType<typeof claimStore>, sql: SqlStorage) => {
  const dentist = said('Dentist is Dr Rao on Tuesdays');
  const pulse = said('Pulse runs high after cardio', 'health');
  const untrusted = said('Cafe on 4th Cross has the best latte', 'fact', 'untrusted');
  const old = said('Gym locker has a blue door');
  memory.correct(old, { kind: 'fact', text: 'Gym locker moved to the red door', source: 'stated', evidence: '"red door"', origin: 'owner', source_ref: 'owner, red door' }, AT);
  const replacement = memory.claims().find((claim) => claim.supersedes_id === old)!.id;
  const forgotten = said('Mr Okafor kept the old deposit');
  memory.forget(forgotten);
  const held = said('Lotus Hall venue deposit paid in two parts');
  sql.exec('INSERT OR IGNORE INTO topic_purge_pending (fingerprint, topic, created_at) VALUES (?, ?, ?)', textFingerprint('Lotus Hall'), 'Lotus Hall', AT);
  const purging = said('Spare key is with the neighbour');
  memory.setStatus(purging, 'purging');
  const statement = said('The owner confirmed this pattern', NODE_STATEMENT);
  return [dentist, pulse, untrusted, old, replacement, forgotten, held, purging, statement, 999];
};

it('opens only what the turn may read, in the order asked, and an unreadable id looks like a missing one', async () => {
  expect(await readIds('read-memory-ids-owner', seedAll)).toEqual(['Dentist is Dr Rao on Tuesdays', 'Pulse runs high after cardio', 'Gym locker moved to the red door']);
});

it('opens no health note by id in a job built from outside content', async () => {
  expect(await readIds('read-memory-ids-outside', seedAll, 'external')).toEqual(['Dentist is Dr Rao on Tuesdays', 'Gym locker moved to the red door']);
});

it('reads an id in this owner\'s store only: the same number in another owner\'s store is that owner\'s claim', async () => {
  expect(await readIds('read-memory-ids-owner-a', (said) => [said('Owner A sees Dr Rao')])).toEqual(['Owner A sees Dr Rao']);
  expect(await readIds('read-memory-ids-owner-b', (said) => [said('Owner B keeps a blue locker')])).toEqual(['Owner B keeps a blue locker']);
});
