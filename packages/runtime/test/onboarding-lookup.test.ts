import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { CURRENT_CONSENT_VERSION } from '../src/onboarding/consent-ledger';
import { LOOKUP_DEADLINE_MS, LOOKUP_MAX_ROUNDS, LOOKUP_START_DELAY_MS, lookupPending, openLookup, startLookup, type LookupDeps } from '../src/onboarding/lookup';
import { jobBook, taskBrief, type JobBook } from '../src/tasks/jobs';
import { applyMachineJob } from '../src/tasks/machine';
import { fenced } from '../src/prompt/turn-prompt';
import { jobTools, LOOKUP_READER, MACHINE_READER } from '../src/tasks/profiles';

// The owner look-up the owner's yes starts, over the real job book and consent ledger on Durable Object SQLite.
const T0 = 1_800_000_000_000;
type Harness = Readonly<{ book: JobBook; clock: { at: number }; sql: SqlStorage; deps(over?: Partial<LookupDeps> & { lookupOffered?: boolean }): LookupDeps }>;
let seq = 0;
const withOwner = <T,>(work: (h: Harness) => Promise<T> | T): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`onboarding-lookup-${seq += 1}`)), async (_instance, state) => {
    const clock = { at: T0 };
    let n = 0, started: number | null = null;
    const book = jobBook(state.storage.sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const deps = ({ lookupOffered = true, ...over }: Partial<LookupDeps> & { lookupOffered?: boolean } = {}): LookupDeps => ({
      book, consent: consentLedger(state.storage.sql, { agreementsOffered: true, lookupOffered }), now: () => clock.at, timezone: 'Europe/London', surface: 'app',
      started: () => started, markStarted: (at) => { started = at; }, held: [], ...over,
    });
    return work({ book, clock, sql: state.storage.sql, deps });
  });
const agree = (consent: LookupDeps['consent'], at: number, lookup = true) => {
  consent.grant('terms', CURRENT_CONSENT_VERSION.terms, at);
  consent.grant('privacy_notice', CURRENT_CONSENT_VERSION.privacy_notice, at);
  if (lookup) consent.grant('owner_lookup', CURRENT_CONSENT_VERSION.owner_lookup, at);
};
const identity = { name: 'Asha Rao', email: 'asha@studio.example' };

describe('starting the owner look-up', () => {
  it('writes one machine job for the yes, carrying only the name and address, bounded in time and rounds', () => withOwner(({ book, deps }) => {
    const d = deps();
    agree(d.consent, T0);
    const made = startLookup(d, identity);
    expect(made.code).toBe('enqueued');
    const row = openLookup(book)!;
    const brief = taskBrief(row);
    expect(row.origin).toBe('machine:owner_lookup');
    expect(brief.machine).toMatchObject({ job: 'owner_lookup', refs: ['name', 'email'], max_rounds: LOOKUP_MAX_ROUNDS });
    expect(brief.context).toBe(fenced('Data fetched for this job', '- [name] Asha Rao\n- [email] asha@studio.example').trim());
    expect([row.due_at, row.deadline_at]).toEqual([T0 + LOOKUP_START_DELAY_MS, T0 + LOOKUP_START_DELAY_MS + LOOKUP_DEADLINE_MS]);
  }));

  it('gives the worker exactly the look-up tools, and no other machine job any egress read', () => withOwner(({ book, deps }) => {
    const d = deps();
    agree(d.consent, T0);
    startLookup(d, identity);
    expect([...jobTools(openLookup(book)!)].sort()).toEqual(['browse_page', 'list_owner_findings', 'read_tool_output', 'record_owner_finding', 'web_search']);
    expect(LOOKUP_READER).not.toContain('get_communication');
    expect(jobTools({ origin: 'machine:heartbeat', profile: 'reader' })).toEqual(MACHINE_READER);
  }));

  it('starts nothing without a live yes: not offered, never granted, withdrawn, or no name yet', () => withOwner(({ book, deps }) => {
    const off = deps({ lookupOffered: false });
    agree(off.consent, T0, false);
    expect(startLookup(off, identity).code).toBe('not_offered');
    const d = deps();
    expect(startLookup(d, identity).code).toBe('not_granted');
    agree(d.consent, T0);
    d.consent.withdraw('owner_lookup', T0 + 1);
    expect(startLookup(d, identity).code).toBe('not_granted');
    d.consent.grant('owner_lookup', CURRENT_CONSENT_VERSION.owner_lookup, T0 + 2);
    expect(startLookup(d, null).code).toBe('no_name');
    expect(startLookup(d, { name: '  ', email: null }).code).toBe('no_name');
    expect(openLookup(book)).toBeNull();
  }));

  it('starts once per grant, even after its job row is gone, and once more for a new yes', () => withOwner(({ book, clock, deps }) => {
    const d = deps();
    agree(d.consent, T0);
    expect(startLookup(d, identity).code).toBe('enqueued');
    expect(startLookup(d, identity).code).toBe('started');
    book.cancel(openLookup(book)!.id, 'owner');
    expect(startLookup(d, identity).code).toBe('started');
    d.consent.withdraw('owner_lookup', (clock.at += 1000));
    d.consent.grant('owner_lookup', CURRENT_CONSENT_VERSION.owner_lookup, (clock.at += 1000));
    expect(startLookup(d, identity).code).toBe('enqueued');
  }));

  it('starts at once when brought forward, and never later than written', () => withOwner(({ book, clock, deps }) => {
    const d = deps();
    agree(d.consent, T0);
    startLookup(d, identity);
    const id = openLookup(book)!.id;
    expect(book.due().map(row => row.id)).toEqual([]);
    expect(book.bringForward(id, (clock.at += 5000))).toBe(true);
    expect(book.due().map(row => row.id)).toEqual([id]);
    expect(book.bringForward(id, clock.at + 60_000)).toBe(false);
  }));
});

describe('whether a look-up is pending', () => {
  it('is pending from the live yes with a name until its job ends, so the web stage never reads before the job is written', () => withOwner(({ book, deps }) => {
    const d = deps();
    agree(d.consent, T0);
    expect(lookupPending(d, false)).toBe(false);
    expect(lookupPending(d, true)).toBe(true);
    startLookup(d, identity);
    expect(lookupPending(d, true)).toBe(true);
    book.cancel(openLookup(book)!.id, 'owner');
    expect(lookupPending(d, true)).toBe(false);
    d.consent.withdraw('owner_lookup', T0 + 5);
    expect(lookupPending(d, true)).toBe(false);
  }));
});

describe('when the look-up job ends', () => {
  const result: TaskResult = { status: 'done', summary: 'Two findings recorded.', findings: [], proposals: [], left: [] };
  it('tells the work waiting on it once, whether it applied or parked, and never sends the owner anything', () => withOwner(async ({ book, deps }) => {
    const d = deps();
    agree(d.consent, T0);
    startLookup(d, identity);
    const row = openLookup(book)!;
    const ticket = book.startAttempt(row.id)!;
    expect(book.report(ticket, result, { rounds: 3, costUsd: 0.01 })).toBe('accepted');
    const ended: string[] = [], hops: string[] = [];
    await applyMachineJob(book.get(row.id)!, { book, now: () => T0, hop: (_row, name) => { hops.push(name); },
      appliers: { owner_lookup: { decidesOnEmpty: true, apply: async (_row, _result, io) => { io.settle(); return 'skipped'; }, ended: (after) => { ended.push(after.status); } } } });
    expect(ended).toEqual(['applied']);
    expect(hops).toContain('machine_skipped');
    expect(hops).not.toContain('machine_applied');
  }));
});
