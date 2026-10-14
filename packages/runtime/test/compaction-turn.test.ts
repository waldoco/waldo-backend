import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION, COMPACTION_INSTRUCTION, COMPACTION_SUPERSEDED_MARKER } from '../src/conversation/compaction';
import { compactionSummaryOpen } from '@waldo/contracts';

const fake = vi.hoisted(() => ({ summary: 'The owner prefers tea and wants quiet mornings.', bodies: [] as Array<{ instructions?: string; input?: unknown }> }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: { instructions?: string; input?: unknown }) => {
  fake.bodies.push(body);
  const text = body.instructions?.startsWith(COMPACTION_INSTRUCTION.slice(0, 40)) ? fake.summary : 'Noted.';
  return { id: 'fixture', output_text: text, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { localTrustedBriefScheduleInput } = await import('../src/run-loop/adapters');

const defaults = { ...COMPACTION };
beforeEach(() => { fake.bodies = []; fake.summary = 'The owner prefers tea and wants quiet mornings.'; });
afterEach(() => { Object.assign(COMPACTION, defaults); });

const memoryStorage = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string) => data.get(key),
    put: async (entries: Record<string, unknown> | string, value?: unknown) => { if (typeof entries === 'string') data.set(entries, value); else for (const [key, item] of Object.entries(entries)) data.set(key, item); },
    list: async ({ prefix, reverse, limit }: { prefix: string; reverse?: boolean; limit?: number }) => {
      const rows = [...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      if (reverse) rows.reverse();
      return new Map(limit ? rows.slice(0, limit) : rows);
    },
  } as unknown as DurableObjectStorage & { data: Map<string, unknown> };
};
const authority = localTrustedBriefScheduleInput().admission.verified_authority;
const PREFIX = `canonical-owner-v1:${authority.principal_ref}:${authority.tenant_ref}:`;
const inOwner = <T,>(name: string, work: () => Promise<T>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), work);
const inputText = () => JSON.stringify(fake.bodies.at(-1)?.input ?? '');
const question = (n: number) => `Question ${n}: ${'q'.repeat(90)}`;
// Rows written after a summary count toward the next one only when their millisecond is later than the summary's.
const settle = () => new Promise(resolve => setTimeout(resolve, 2));

it('after a turn that dropped rows, compactIfDue writes one summary row the next turn sees first, supersedes it later, and never compacts twice for one span', async () => {
  Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
  const storage = memoryStorage();
  const logs: TurnLogEntry[] = [];
  await inOwner('compaction-turn', async () => {
    const store = canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
    const responder = createOwnerResponder('fixture', store, undefined, entry => logs.push(entry));
    for (let n = 1; n <= 6; n += 1) await responder.respond({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }, (_name, work) => work());
    expect(logs.find(entry => entry.hop === 'context_window')).toBeDefined();
    await responder.compactIfDue!('owner');
    await settle();
    const hop = logs.filter(entry => entry.hop === 'compaction').at(-1)!;
    expect(hop).toMatchObject({ ok: true, code: 'compacted' });
    expect(fake.bodies.at(-1)?.instructions).toBe(COMPACTION_INSTRUCTION);
    // the compaction call carries the span's rows and nothing after it, and its text never reaches the trace
    expect(logs.filter(entry => entry.hop === 'llm_compaction').every(entry => !('text' in entry))).toBe(true);
    const rows = [...storage.data.entries()].filter(([key]) => key.startsWith(`${PREFIX}conv:`)).map(([, value]) => value as { id: string; role?: string; covers?: unknown; modelPayload: string });
    const summaries = rows.filter(row => row.role === 'compaction');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ modelPayload: fake.summary, covers: expect.objectContaining({ to_id: expect.any(String) }) });
    expect(storage.data.get(`${PREFIX}leaf`)).toBe('app-6-reply');
    expect(rows.filter(row => row.role !== 'compaction').map(row => row.modelPayload)).toEqual(expect.arrayContaining([question(1), 'Noted.']));
    // the same span again is not compacted: no second row, no second model call
    const calls = fake.bodies.length;
    await responder.compactIfDue!('owner');
    expect(fake.bodies.length).toBe(calls);
    // the next turn's model input opens with the labelled summary and no longer carries the earliest question
    await responder.respond({ traceId: 'app-7', conversationRef: 'owner', surface: 'app', text: question(7) }, (_name, work) => work());
    const input = inputText();
    expect(input).toContain(compactionSummaryOpen((summaries[0] as { covers: { rows: number } }).covers.rows));
    expect(input).toContain(fake.summary);
    expect(input).not.toContain(question(1));
    expect(input).toContain(question(7));
    // a later compaction carries the first forward: the first is superseded in storage, the second is live and covers more
    fake.summary = 'Tea, quiet mornings, and a dentist on Friday.';
    await responder.respond({ traceId: 'app-8', conversationRef: 'owner', surface: 'app', text: question(8) }, (_name, work) => work());
    await responder.compactIfDue!('owner');
    const after = [...storage.data.entries()].filter(([key]) => key.startsWith(`${PREFIX}conv:`)).map(([, value]) => value as { id: string; role?: string; modelPayload: string; modelProjection: { mode: string }; covers?: { from_id: string; rows: number } });
    const [first, second] = after.filter(row => row.role === 'compaction');
    expect(first).toMatchObject({ modelPayload: COMPACTION_SUPERSEDED_MARKER, modelProjection: { mode: 'omit' } });
    expect(second).toMatchObject({ modelPayload: fake.summary, modelProjection: { mode: 'include' } });
    expect(second!.covers!.from_id).toBe(first!.covers!.from_id);
    expect(second!.covers!.rows).toBeGreaterThan(first!.covers!.rows);
    expect(storage.data.get(`${PREFIX}leaf`)).toBe('app-8-reply');
  });
});

it('a summary that carries a health number is never written, and counts as an attempt', async () => {
  Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 3_600_000 });
  fake.summary = 'The owner slept 5 hours and prefers tea.';
  const storage = memoryStorage();
  const logs: TurnLogEntry[] = [];
  await inOwner('compaction-health', async () => {
    const store = canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
    const responder = createOwnerResponder('fixture', store, undefined, entry => logs.push(entry));
    for (let n = 1; n <= 6; n += 1) await responder.respond({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }, (_name, work) => work());
    await responder.compactIfDue!('owner');
    expect(logs.filter(entry => entry.hop === 'compaction').at(-1)).toMatchObject({ ok: false, code: 'numeric_health' });
    expect([...storage.data.values()].some(value => (value as { role?: string })?.role === 'compaction')).toBe(false);
    expect(typeof storage.data.get(`${PREFIX}compaction-attempt:owner`)).toBe('number');
    // the attempt is rate limited: no second model call within the interval
    const calls = fake.bodies.length;
    await responder.compactIfDue!('owner');
    expect(fake.bodies.length).toBe(calls);
  });
});

it('with the switch off nothing is called and an existing summary row shapes no view', async () => {
  const storage = memoryStorage();
  await inOwner('compaction-off', async () => {
    const store = canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
    const responder = createOwnerResponder('fixture', store);
    Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
    for (let n = 1; n <= 6; n += 1) await responder.respond({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }, (_name, work) => work());
    await responder.compactIfDue!('owner');
    await settle();
    expect([...storage.data.values()].some(value => (value as { role?: string })?.role === 'compaction')).toBe(true);
    // the switch alone stops the next one: the same budget, two new owner rows and no interval would let it through
    Object.assign(COMPACTION, { ...defaults, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
    const compactions = () => fake.bodies.filter(body => body.instructions === COMPACTION_INSTRUCTION).length;
    expect(compactions()).toBe(1);
    for (const n of [7, 8]) await responder.respond({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }, (_name, work) => work());
    expect(inputText()).not.toContain(compactionSummaryOpen(0).slice(0, 20));
    await responder.compactIfDue!('owner');
    expect(compactions()).toBe(1);
  });
});

it('after a restart the stored summary row is never the leaf: the next turn continues from the last reply, with the switch on or off', async () => {
  Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
  const storage = memoryStorage();
  const parentOf = (id: string) => ([...storage.data.values()].find(row => (row as { id?: string })?.id === id) as { parentId: string | null } | undefined)?.parentId;
  await inOwner('compaction-restart', async () => {
    const store = () => canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
    const first = createOwnerResponder('fixture', store());
    for (let n = 1; n <= 6; n += 1) await first.respond({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }, (_name, work) => work());
    await first.compactIfDue!('owner');
    const summary = [...storage.data.values()].find(row => (row as { role?: string })?.role === 'compaction') as { id: string; covers: { to_id: string; rows: number } };
    expect(summary.covers.to_id).toBe('app-5-reply');
    // a fresh responder on the same storage, as after an eviction, with the switch on: the verbatim tail stays in the chain
    const second = createOwnerResponder('fixture', store());
    await second.respond({ traceId: 'app-7', conversationRef: 'owner', surface: 'app', text: question(7) }, (_name, work) => work());
    expect(parentOf('app-7')).toBe('app-6-reply');
    expect(inputText()).toContain(compactionSummaryOpen(summary.covers.rows));
    expect(inputText()).toContain(question(6));
    // and with the switch off: the stored row shapes nothing and the chain continues from the last reply
    Object.assign(COMPACTION, defaults);
    const third = createOwnerResponder('fixture', store());
    await third.respond({ traceId: 'app-8', conversationRef: 'owner', surface: 'app', text: question(8) }, (_name, work) => work());
    expect(parentOf('app-8')).toBe('app-7-reply');
    expect(inputText()).not.toContain(compactionSummaryOpen(0).slice(0, 20));
    expect(inputText()).toContain(question(7));
  });
});
