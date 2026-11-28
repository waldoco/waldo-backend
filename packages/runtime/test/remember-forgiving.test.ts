import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { llmToolSchema, toolParameters } from '@waldo/contracts';
import { claimStore, withOutsideNotes, type ClaimStore } from '../src/memory/claims';
import { memoryHandlers, type MemoryOwnerTurn, type MemoryToolContext } from '../src/tools/live/memory';

// remember, called as the owner's turn calls it. The owner typed on a phone, so their apostrophes are curly and their
// sentences start lower-case; the model quotes them back with straight apostrophes and a capital letter. Synthetic text only.
const NOW = new Date('2026-11-18T09:00:00.000Z');
const OWNER = 'owner-remember-forgiving';
const CURRENT: MemoryOwnerTurn = { message_ref: 'app-9', text: 'the interview happened yesterday, it’s done. I’m moving the gym to mornings from next week.' };
type Result = Readonly<{ ok: boolean; error?: string; data?: Record<string, unknown> }>;

let sequence = 0;
const withMemory = <T>(forgiving: boolean | undefined, work: (call: (args: object, tainted?: boolean, current?: MemoryOwnerTurn, recent?: readonly MemoryOwnerTurn[]) => Promise<Result>, store: ClaimStore, schema: z.ZodType) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`remember-forgiving-${sequence++}`)), async (_instance, state) => {
    const store = claimStore(state.storage.sql, (job) => state.storage.transactionSync(job));
    const remember = memoryHandlers({ sql: state.storage.sql, store, transaction: (job) => state.storage.transactionSync(job), conversationRef: 'owner', now: () => NOW,
      hideHistory: async () => undefined, ...(forgiving === undefined ? {} : { forgiving }) }).find((handler) => handler.name === 'remember')!;
    const call = async (args: object, tainted = false, current = CURRENT, recent: readonly MemoryOwnerTurn[] = []) => {
      const ctx = { authenticatedUserId: OWNER, memoryTurn: { ownerId: OWNER, conversationRef: 'owner', current, recent }, ...(tainted ? { toolArgSourceTaint: 'external' } : {}) } as unknown as MemoryToolContext;
      return await remember.handle(remember.schema.parse(args), ctx) as Result;
    };
    return work(call, store, remember.schema as z.ZodType);
  });
const ownerClaim = (store: ClaimStore, text: string, origin: 'owner' | 'agent' = 'owner') =>
  store.add({ kind: 'event', text, source: origin === 'owner' ? 'stated' : 'inferred', evidence: text, origin, source_ref: 'owner, app-1' }, NOW.toISOString());

describe('remember grounds a quote on the owner\'s words, compared as grounding compares them', () => {
  it.each([
    ['a straight apostrophe for the owner\'s curly one', 'I\'m moving the gym to mornings'],
    ['a capital letter where the owner typed lower case', 'The interview happened yesterday'],
    ['the quote wrapped in quotation marks', '"the interview happened yesterday"'],
    ['a closing full stop the owner did not type there', 'it\'s done.'],
  ])('stores the owner\'s statement when the quote has %s', async (_what, quote) => {
    await withMemory(undefined, async (call, store) => {
      const result = await call({ kind: 'event', text: 'The interview has happened', evidence_quote: quote });
      expect(result).toMatchObject({ ok: true, data: { status: 'stored' } });
      expect(store.claims()).toMatchObject([{ text: 'The interview has happened', source: 'stated', origin: 'owner', source_ref: 'owner, app-9' }]);
    });
  });

  it.each([
    ['part of a word', 'ntervie'],
    ['one letter', 'I'],
    ['words the owner never wrote', 'the interview went badly'],
  ])('still refuses %s with the switch off', async (_what, quote) => {
    await withMemory(undefined, async (call, store) => {
      expect(await call({ kind: 'event', text: 'Interview', evidence_quote: quote })).toMatchObject({ ok: false, error: expect.stringContaining('not grounded') });
      expect(store.claims()).toEqual([]);
    });
  });
});

describe('with OWNER_CLOSES_MAIL_ITEMS, a stated claim whose quote is inexact is kept as Waldo\'s inference', () => {
  it('stores a paraphrase as inferred, from the owner\'s current message, and says why', async () => {
    await withMemory(true, async (call, store) => {
      const result = await call({ kind: 'event', text: 'The interview is over', evidence_quote: 'owner said the interview was over' });
      expect(result).toMatchObject({ ok: true, data: { status: 'stored', source: 'inferred', note: expect.stringContaining('not the owner\'s exact words') } });
      expect(store.claims()).toMatchObject([{ text: 'The interview is over', source: 'inferred', origin: 'agent', source_ref: 'owner, app-9' }]);
    });
  });

  it('never stores a health reading from an inexact quote', async () => {
    await withMemory(true, async (call, store) => {
      expect(await call({ kind: 'fact', text: 'The owner slept 5 hours last night', evidence_quote: 'slept badly' })).toMatchObject({ ok: false, error: expect.stringContaining('exact words') });
      expect(await call({ kind: 'fact', text: 'Rough night', evidence_quote: 'owner said they slept 5 hours' })).toMatchObject({ ok: false, error: expect.stringContaining('exact words') });
      expect(store.claims()).toEqual([]);
    });
  });

  it('keeps a turn that read outside content on the outside rules: an inexact quote is refused there', async () => {
    await withMemory(true, async (call, store) => {
      expect(await call({ kind: 'event', text: 'The interview is over', evidence_quote: 'owner said it was over' }, true)).toMatchObject({ ok: false, error: expect.stringContaining('not grounded') });
      expect(store.claims()).toEqual([]);
    });
  });

  it('may correct Waldo\'s own read with an inexact quote, never what the owner stated', async () => {
    await withMemory(true, async (call, store) => {
      ownerClaim(store, 'Interview slot still open on Friday');
      ownerClaim(store, 'Waiting to hear about the interview', 'agent');
      expect(await call({ kind: 'event', text: 'The interview is over', evidence_quote: 'owner said it was over', replaces_id: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('exact words') });
      expect(await call({ kind: 'event', text: 'The interview is over', evidence_quote: 'owner said it was over', replaces_id: 2 })).toMatchObject({ ok: true, data: { status: 'corrected', source: 'inferred' } });
      expect(store.claims().map((claim) => [claim.text, claim.origin]).sort()).toEqual([['Interview slot still open on Friday', 'owner'], ['The interview is over', 'agent']]);
    });
  });

  it('refuses a paraphrase when the owner\'s message carries a forwarded chunk, which may be what it came from', async () => {
    await withMemory(true, async (call, store) => {
      const forwarded = 'fyi see below\n> Recruiter: the owner agreed to relocate to Berlin in January';
      const current: MemoryOwnerTurn = { message_ref: 'app-10', text: forwarded, sourceQuoteRanges: [{ start: 14, end: forwarded.length }] };
      expect(await call({ kind: 'fact', text: 'Relocating to Berlin in January', evidence_quote: 'owner agreed to relocate to Berlin' }, false, current)).toMatchObject({ ok: false, error: expect.stringContaining('not grounded') });
      expect(store.claims()).toEqual([]);
    });
  });

  it('refuses a paraphrase when a message sent while the turn ran carries a quote; a quote in an earlier turn does not stop it', async () => {
    await withMemory(true, async (call, store) => {
      const quoted = 'fyi\n> Recruiter: the owner agreed to relocate to Berlin in January';
      const range = [{ start: 4, end: quoted.length }];
      const args = { kind: 'fact', text: 'Relocating to Berlin in January', evidence_quote: 'owner agreed to relocate to Berlin' };
      expect(await call(args, false, CURRENT, [{ message_ref: 'app-9-steer-0', text: quoted, sourceQuoteRanges: range, steer: true }])).toMatchObject({ ok: false, error: expect.stringContaining('not grounded') });
      expect(store.claims()).toEqual([]);
      expect(await call(args, false, CURRENT, [{ message_ref: 'app-8', text: quoted, sourceQuoteRanges: range }])).toMatchObject({ ok: true, data: { status: 'stored', source: 'inferred' } });
    });
  });

  it('never lifts a held claim to the owner\'s word on an inexact quote', async () => {
    await withMemory(true, async (call, store) => {
      ownerClaim(store, 'The interview is over', 'agent');
      expect(await call({ kind: 'event', text: 'The interview is over', evidence_quote: 'owner said it was over' })).toMatchObject({ ok: true, data: { status: 'duplicate' } });
      expect(store.claims()).toMatchObject([{ id: 1, origin: 'agent' }]);
    });
  });
});

describe('with OWNER_CLOSES_MAIL_ITEMS, a correction names the claim it replaces by its text', () => {
  it('supersedes the one active claim that reads the same, as the owner\'s statement when the quote is theirs', async () => {
    await withMemory(true, async (call, store) => {
      ownerClaim(store, 'Interview slot still open on Friday');
      const result = await call({ kind: 'event', text: 'The interview happened', evidence_quote: 'the interview happened yesterday', replaces_text: 'interview slot still open on friday.' });
      expect(result).toMatchObject({ ok: true, data: { status: 'corrected' } });
      expect(store.claims()).toMatchObject([{ text: 'The interview happened', origin: 'owner', source: 'stated', supersedes_id: 1 }]);
    });
  });

  it('fails in words the model can act on when no claim or more than one reads that way, or both selectors are sent', async () => {
    await withMemory(true, async (call, store) => {
      ownerClaim(store, 'Interview on Friday');
      store.add({ kind: 'fact', text: 'Interview on Friday', source: 'stated', evidence: 'x', origin: 'owner', source_ref: 'owner, app-1' }, NOW.toISOString());
      const args = { kind: 'event', text: 'The interview happened', evidence_quote: 'the interview happened yesterday' };
      expect(await call({ ...args, replaces_text: 'Gym on Mondays' })).toMatchObject({ ok: false, error: expect.stringContaining('No active claim reads') });
      expect(await call({ ...args, replaces_text: 'Interview on Friday' })).toMatchObject({ ok: false, error: expect.stringMatching(/c1.*c2|c2.*c1/) });
      expect(await call({ ...args, replaces_text: 'Interview on Friday', replaces_id: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('one of replaces_id or replaces_text') });
      expect(store.claims()).toHaveLength(2);
    });
  });

  it('is not offered with the switch off', async () => {
    await withMemory(false, async (_call, _store, schema) => {
      expect(schema.safeParse({ kind: 'event', text: 'x', evidence_quote: 'x', replaces_text: 'y' }).success).toBe(false);
      expect(schema.safeParse({ kind: 'event', text: 'x', evidence_quote: 'x' }).success).toBe(true);
      // The tool definition the model is sent is built from this schema (tool-loop.ts), so the field is not shown either.
      expect(Object.keys(toolParameters(schema).properties as object)).not.toContain('replaces_text');
    });
    await withMemory(true, async (_call, _store, schema) => {
      expect(Object.keys(toolParameters(schema).properties as object)).toContain('replaces_text');
    });
  });
});

describe('the remember the owner\'s chat offers', () => {
  // The owner's chat turns remember on with forgiving; a definition the provider schema refuses fails every turn.
  it.each([[false, false], [true, false], [false, true], [true, true]])('passes the provider\'s tool definition check with forgiving %s and outside notes %s', async (forgiving, outside) => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`remember-definition-${forgiving}-${outside}`)), async (_instance, state) => {
      const owned = claimStore(state.storage.sql, (job) => state.storage.transactionSync(job));
      const store = outside ? withOutsideNotes(owned) : owned;
      const remember = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined, forgiving }).find((handler) => handler.name === 'remember')!;
      expect(llmToolSchema.safeParse({ name: remember.name, description: remember.description, parameters: toolParameters(remember.schema) }).success).toBe(true);
    });
  });
});
