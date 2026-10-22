import { ownerTyped } from './helpers/owner-typed';
import { holdTopic } from './helpers/pending-topic';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION, COMPACTION_INSTRUCTION, COMPACTION_SUPERSEDED_MARKER, type CompactionFlush, type CompactionSpan } from '../src/conversation/compaction';
import { compactionSummaryOpen } from '@waldo/contracts';
import { claimStore, FLUSH_INSTRUCTION } from '../src/memory/claims';

const fake = vi.hoisted(() => ({ summary: 'The owner prefers tea and wants quiet mornings.', flushOps: '', bodies: [] as Array<{ instructions?: string; input?: unknown }> }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: { instructions?: string; input?: unknown }) => {
  fake.bodies.push(body);
  const text = body.instructions?.startsWith(COMPACTION_INSTRUCTION.slice(0, 40)) ? fake.summary : body.instructions === FLUSH_INSTRUCTION ? fake.flushOps : 'Noted.';
  return { id: 'fixture', output_text: text, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { localTrustedBriefScheduleInput } = await import('../src/llm/run-loop-adapters');

const defaults = { ...COMPACTION };
beforeEach(() => { fake.bodies = []; fake.summary = 'The owner prefers tea and wants quiet mornings.'; });
afterEach(() => { Object.assign(COMPACTION, defaults); });

const memoryStorage = () => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string | string[]) => Array.isArray(key) ? new Map(key.filter((one) => data.has(one)).map((one) => [one, data.get(one)])) : data.get(key),
    put: async (entries: Record<string, unknown> | string, value?: unknown) => { if (typeof entries === 'string') data.set(entries, value); else for (const [key, item] of Object.entries(entries)) data.set(key, item); },
    list: async ({ prefix, reverse, limit, end }: { prefix: string; reverse?: boolean; limit?: number; end?: string }) => {
      const rows = [...data].filter(([key]) => key.startsWith(prefix) && (end === undefined || key < end)).sort(([a], [b]) => a.localeCompare(b));
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
    for (let n = 1; n <= 6; n += 1) await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }), (_name, work) => work());
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
    await responder.respond(ownerTyped({ traceId: 'app-7', conversationRef: 'owner', surface: 'app', text: question(7) }), (_name, work) => work());
    const input = inputText();
    expect(input).toContain(compactionSummaryOpen((summaries[0] as { covers: { rows: number } }).covers.rows));
    expect(input).toContain(fake.summary);
    expect(input).not.toContain(question(1));
    expect(input).toContain(question(7));
    // a later compaction carries the first forward: the first is superseded in storage, the second is live and covers more
    fake.summary = 'Tea, quiet mornings, and a dentist on Friday.';
    await responder.respond(ownerTyped({ traceId: 'app-8', conversationRef: 'owner', surface: 'app', text: question(8) }), (_name, work) => work());
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
    for (let n = 1; n <= 6; n += 1) await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }), (_name, work) => work());
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
    for (let n = 1; n <= 6; n += 1) await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }), (_name, work) => work());
    await responder.compactIfDue!('owner');
    await settle();
    expect([...storage.data.values()].some(value => (value as { role?: string })?.role === 'compaction')).toBe(true);
    // the switch alone stops the next one: the same budget, two new owner rows and no interval would let it through
    Object.assign(COMPACTION, { ...defaults, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
    const compactions = () => fake.bodies.filter(body => body.instructions === COMPACTION_INSTRUCTION).length;
    expect(compactions()).toBe(1);
    for (const n of [7, 8]) await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }), (_name, work) => work());
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
    for (let n = 1; n <= 6; n += 1) await first.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }), (_name, work) => work());
    await first.compactIfDue!('owner');
    const summary = [...storage.data.values()].find(row => (row as { role?: string })?.role === 'compaction') as { id: string; covers: { to_id: string; rows: number } };
    expect(summary.covers.to_id).toBe('app-5-reply');
    // a fresh responder on the same storage, as after an eviction, with the switch on: the verbatim tail stays in the chain
    const second = createOwnerResponder('fixture', store());
    await second.respond(ownerTyped({ traceId: 'app-7', conversationRef: 'owner', surface: 'app', text: question(7) }), (_name, work) => work());
    expect(parentOf('app-7')).toBe('app-6-reply');
    expect(inputText()).toContain(compactionSummaryOpen(summary.covers.rows));
    expect(inputText()).toContain(question(6));
    // and with the switch off: the stored row shapes nothing and the chain continues from the last reply
    Object.assign(COMPACTION, defaults);
    const third = createOwnerResponder('fixture', store());
    await third.respond(ownerTyped({ traceId: 'app-8', conversationRef: 'owner', surface: 'app', text: question(8) }), (_name, work) => work());
    expect(parentOf('app-8')).toBe('app-7-reply');
    expect(inputText()).not.toContain(compactionSummaryOpen(0).slice(0, 20));
    expect(inputText()).toContain(question(7));
  });
});

describe('the memory flush seam', () => {
  const withFlush = (store: ReturnType<typeof canonicalOwnerConversationStore>, logs: TurnLogEntry[], compactionFlush: CompactionFlush) => {
    const args: Parameters<typeof createOwnerResponder> = ['fixture', store];
    args[3] = entry => logs.push(entry);
    args[21] = { compactionFlush };
    return createOwnerResponder(...args);
  };

  it('sees the span, before its summary row exists, with the rows the summary covers', async () => {
    Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
    const storage = memoryStorage();
    const logs: TurnLogEntry[] = [];
    const seen: CompactionSpan[] = [];
    let summaryExistedAtFlush: boolean | undefined;
    await inOwner('compaction-flush', async () => {
      const store = canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
      const responder = withFlush(store, logs, async (span) => {
        seen.push(span);
        summaryExistedAtFlush = [...storage.data.values()].some(value => (value as { role?: string })?.role === 'compaction');
      });
      for (let n = 1; n <= 6; n += 1) await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }), (_name, work) => work());
      await responder.compactIfDue!('owner');
      expect(seen).toHaveLength(1);
      expect(summaryExistedAtFlush).toBe(false);
      const summary = [...storage.data.values()].find(value => (value as { role?: string })?.role === 'compaction') as { covers: unknown };
      expect(seen[0]).toMatchObject({ conversationRef: 'owner', covers: summary.covers });
      // the flush gets the same rows the summarizer reads
      expect(seen[0]!.messages.map(message => message.content)).toContain(question(5));
      for (const message of seen[0]!.messages) expect(inputText()).toContain(JSON.stringify(message.content).slice(1, 40));
      expect(logs.filter(entry => entry.hop === 'compaction').at(-1)).toMatchObject({ ok: true, code: 'compacted' });
    });
  });

  it('a flush that fails writes no summary and keeps the span in the window; the next attempt runs it again', async () => {
    Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
    const storage = memoryStorage();
    const logs: TurnLogEntry[] = [];
    let fail = true, flushes = 0;
    await inOwner('compaction-flush-fails', async () => {
      const store = canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
      const responder = withFlush(store, logs, async () => { flushes += 1; if (fail) throw new Error('memory store unavailable'); });
      for (let n = 1; n <= 6; n += 1) await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n) }), (_name, work) => work());
      const calls = fake.bodies.length;
      await responder.compactIfDue!('owner');
      expect(logs.filter(entry => entry.hop === 'compaction').at(-1)).toMatchObject({ ok: false, code: 'flush_failed' });
      expect(fake.bodies.length).toBe(calls);
      expect([...storage.data.values()].some(value => (value as { role?: string })?.role === 'compaction')).toBe(false);
      fail = false;
      await responder.compactIfDue!('owner');
      expect(flushes).toBe(2);
      expect([...storage.data.values()].some(value => (value as { role?: string })?.role === 'compaction')).toBe(true);
    });
  });
});

describe('what the flush keeps', () => {
  const OWNER = 'I sleep badly after late coffee. Please keep my evenings calm.';
  const flushOps = JSON.stringify({
    add: [
      { kind: 'health', text: 'Sleeps badly after late coffee', source: 'stated', evidence: 'I sleep badly after late coffee', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false },
      { kind: 'preference', text: 'Wants calm evenings', source: 'stated', evidence: 'Please keep my evenings calm', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false },
    ],
    corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [1], forget_nodes: [], forget_topic: 'tea', pin: [{ id: 1, block: 'owner_profile', order: 1 }], unpin: [],
  });
  type Kept = Readonly<{ saved: (readonly Readonly<{ id: number; kind: string }>[])[]; memory: ReturnType<typeof claimStore>; logs: TurnLogEntry[] }>;
  const keepWith = async (name: string, health: boolean, inspect: (kept: Kept) => void, prepare: (sql: SqlStorage) => void = () => undefined) => {
    Object.assign(COMPACTION, { enabled: true, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });
    fake.flushOps = flushOps;
    const storage = memoryStorage();
    const logs: TurnLogEntry[] = [];
    return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
      const memory = claimStore(state.storage.sql);
      memory.add({ kind: 'preference', text: 'Prefers tea', source: 'stated', evidence: '"Prefers tea"', origin: 'owner', source_ref: 'owner, fixture-1' }, '2026-10-20T08:00:00Z', 1);
      prepare(state.storage.sql);
      const saved: (readonly Readonly<{ id: number; kind: string }>[])[] = [];
      const store = canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
      const args: Parameters<typeof createOwnerResponder> = ['fixture', store, memory];
      args[3] = entry => logs.push(entry);
      args[21] = { compactionFlush: async (_span, keep) => { saved.push(await keep.save(`owner: ${OWNER}`, { owner: OWNER }, { health })); } };
      const responder = createOwnerResponder(...args);
      for (let n = 1; n <= 6; n += 1) await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n), memoryWrites: false }), (_name, work) => work());
      await responder.compactIfDue!('owner');
      inspect({ saved, memory, logs });
    });
  };

  it('writes what the owner said through the admission gate, and never forgets or pins from there', async () => {
    await keepWith('flush-keeps', true, ({ saved, memory, logs }) => {
      expect(saved).toHaveLength(1);
      expect(saved[0]!.map((claim) => claim.kind).sort()).toEqual(['health', 'preference']);
      expect(memory.claims().map((claim) => [claim.text, claim.origin, claim.source]).sort()).toEqual([
        ['Prefers tea', 'owner', 'stated'], ['Sleeps badly after late coffee', 'owner', 'stated'], ['Wants calm evenings', 'owner', 'stated'],
      ]);
      expect(memory.barriers()).toEqual([]);
      expect(memory.claims().every((claim) => claim.pinned === null)).toBe(true);
      expect(fake.bodies.some((body) => body.instructions === FLUSH_INSTRUCTION)).toBe(true);
      expect(logs.find((entry) => entry.hop === 'memory_flush')).toMatchObject({ ok: true });
    });
  });

  // A forget whose purge has not settled holds its topic out of every read; the span still carries it, so the flush saves
  // nothing from that span and leaves it to the nightly pass, which reads the rows after the purge.
  it('saves nothing from a span that carries a topic the owner is still forgetting', async () => {
    await keepWith('flush-held-topic', true, ({ saved, memory, logs }) => {
      expect(saved).toEqual([[]]);
      expect(memory.claims().map((claim) => claim.text)).toEqual(['Prefers tea']);
      expect(fake.bodies.some((body) => body.instructions === FLUSH_INSTRUCTION)).toBe(false);
      expect(logs.find((entry) => entry.hop === 'memory_flush')).toMatchObject({ ok: true, code: 'held_topic' });
    }, (sql) => holdTopic(sql, 'late coffee', '2026-10-20T08:30:00Z'));
  });

  it('keeps no health note when the owner has health notes off', async () => {
    await keepWith('flush-no-health', false, ({ saved, memory }) => {
      expect(saved[0]!.map((claim) => claim.kind)).toEqual(['preference']);
      expect(memory.claims().some((claim) => claim.kind === 'health')).toBe(false);
    });
  });
});

describe('the memory notice', () => {
  it('rides the owner\'s next reply after its receipts, once, and never a machine turn\'s', async () => {
    const storage = memoryStorage();
    const notices = ['Saved to memory from our earlier chat: "Sleeps badly after late coffee" (c1).'];
    await inOwner('memory-notice', async () => {
      const store = canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
      const args: Parameters<typeof createOwnerResponder> = ['fixture', store];
      args[21] = { memoryNotice: () => notices.shift() ?? null };
      const responder = createOwnerResponder(...args);
      const job = await responder.prompt('job-1', 'owner', '[Reminder] stretch', (_name, work) => work());
      expect(job).not.toContain('Saved to memory');
      const first = await responder.respond(ownerTyped({ traceId: 'app-1', conversationRef: 'owner', surface: 'app', text: 'hello' }), (_name, work) => work());
      expect(first).toBe('Noted.\n\nSaved to memory from our earlier chat: "Sleeps badly after late coffee" (c1).');
      const second = await responder.respond(ownerTyped({ traceId: 'app-2', conversationRef: 'owner', surface: 'app', text: 'and now?' }), (_name, work) => work());
      expect(second).toBe('Noted.');
    });
  });
});
