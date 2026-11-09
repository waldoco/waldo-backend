import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { memoryControl } from '../src/channels/dashboard-memory-actions';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { claimStore, MEMORY_HEADER, QUIET_NOTE, turnMemoryPrompt, withoutBringUpLess } from '../src/memory/claims';
import { DAY_CARDS, dayPlanInput } from '../src/prompt/day-cards';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';

// A claim the owner asked Waldo to bring up less never reaches a turn Waldo starts itself: the day plan the daily Brief is
// built from, and the constellation nodes that rest on such a claim. The header sentence about the mark appears only with one.
const AT = '2026-10-04T00:00:00.000Z';
const input = dayPlanInput({ localNow: '2026-10-04T08:00', calendar: 'No events.', cards: DAY_CARDS, proactivity: 'Quiet hours 23:00-07:00' });
const owned = (text: string) => ({ kind: 'routine', text, source: 'stated', evidence: text, origin: 'owner', source_ref: 'owner, synthetic' });

const planDayPrompt = (name: string, quiet: boolean) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  const memory = claimStore(state.storage.sql);
  memory.add(owned('Practises Portuguese most evenings'), AT);
  memory.add(owned('Runs on Tuesday mornings'), AT);
  const [portuguese, runs] = [...memory.claims()].sort((a, b) => a.id - b.id);
  if (quiet) expect(memory.bringUpLess(portuguese!.id, AT, true)).toBe(true);
  memory.saveNode({ id: null, domain: 'routine', label: 'Evening language study', summary: 'Studies in the evenings', strength: 0.8, status: 'active', supporting_spots: [portuguese!.id] }, AT);
  memory.saveNode({ id: null, domain: 'routine', label: 'Morning running', summary: 'Runs early in the week', strength: 0.8, status: 'active', supporting_spots: [runs!.id] }, AT);
  const requests: LLMGatewayRequest[] = [];
  const output = JSON.stringify({ cards: DAY_CARDS.map(card => ({ id: card.id, time: card.defaultTime, reason: 'synthetic' })) });
  const gateway: LLMGatewayAdapter = { complete: async request => { requests.push(request); return { ok: true, data: { model: request.request.model, text: output, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } }; } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture', undefined, memory]; args[10] = gateway;
  await createOwnerResponder(...args).planDay('quiet-plan', input);
  expect(requests).toHaveLength(1);
  return requests[0]!.request.messages[0]!.content as string;
});

describe('a claim marked bring up less, in a turn Waldo starts', () => {
  it('stays out of the day plan, with the node resting on it, while the rest of memory is read', async () => {
    const content = await planDayPrompt('quiet-plan-on', true);
    expect(content).toContain('Runs on Tuesday mornings');
    expect(content).not.toContain('Portuguese');
    expect(content).not.toContain('Evening language study');
  });

  it('is read by the same day plan when the owner has not asked for less, so the check above can fail', async () => {
    const content = await planDayPrompt('quiet-plan-off', false);
    expect(content).toContain('Portuguese');
    expect(content).toContain('Evening language study');
  });

  it('leaves the owner\'s own turns, and edges and statements of kept nodes, alone', () => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('quiet-view')), async (_instance, state) => {
    const memory = claimStore(state.storage.sql);
    memory.add(owned('Practises Portuguese most evenings'), AT);
    const id = memory.claims()[0]!.id;
    memory.saveNode({ id: null, domain: 'routine', label: 'Evening language study', summary: 'Studies', strength: 0.8, status: 'active', supporting_spots: [id] }, AT);
    memory.bringUpLess(id, AT, true);
    expect(memory.nodes()).toHaveLength(1);
    expect(withoutBringUpLess(memory).nodes()).toEqual([]);
    expect(withoutBringUpLess(memory).edges()).toEqual([]);
    expect(withoutBringUpLess(memory).statements()).toEqual([]);
  }));
});

describe('the memory header', () => {
  it('is the same text as before the mark existed unless a marked line is shown', () => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('quiet-header')), async (_instance, state) => {
    const memory = claimStore(state.storage.sql);
    memory.add({ ...owned('Practises Portuguese most evenings'), verification_status: 'owner-grounded' } as never, AT);
    memory.ownerGround(memory.claims()[0]!.id, AT, 'owner, synthetic');
    expect(turnMemoryPrompt(memory, '').startsWith(`${MEMORY_HEADER}\n`)).toBe(true);
    expect(turnMemoryPrompt(memory, '')).not.toContain(QUIET_NOTE);
    memory.bringUpLess(memory.claims()[0]!.id, AT, true);
    expect(turnMemoryPrompt(memory, '').startsWith(`${MEMORY_HEADER} ${QUIET_NOTE}\n`)).toBe(true);
  }));
});

describe('the console', () => {
  it('lists the quiet actions it registers, for the claim in its current state', () => {
    const claim = { id: 4, kind: 'fact', text: 'x', source: 'stated', evidence: 'e', origin: 'owner', status: 'active', seen_count: 1, last_seen_at: AT, pinned: null, area: null, bring_up_less_at: null };
    const view = (row: object) => ({ spots: [row], forgettingSpots: [], nodes: [], retiredSpots: [], statements: [] }) as never;
    expect(memoryControl(view(claim), 's', 's:claim:4')!.actions).toContain('spot.quiet');
    expect(memoryControl(view({ ...claim, bring_up_less_at: AT }), 's', 's:claim:4')!.actions).toContain('spot.unquiet');
  });
});
