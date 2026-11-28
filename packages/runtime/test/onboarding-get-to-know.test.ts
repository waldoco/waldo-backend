import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { claimStore } from '../src/memory/claims';
import { GET_TO_KNOW_DAYS, GET_TO_KNOW_DELAY_MS, getToKnowApplier, startGetToKnow } from '../src/onboarding/get-to-know';
import { welcomeBuild } from '../src/onboarding/welcome';
import { jobBook, taskBrief, type JobRow } from '../src/tasks/jobs';
import { jobTools } from '../src/tasks/profiles';
import { MACHINE_READER } from '../src/tasks/profile-tools';

let sequence = 0;
const T0 = Date.parse('2026-11-27T09:00:00Z');
const DAY = 86_400_000;
const withSql = <T>(fn: (sql: SqlStorage, transaction: <R>(work: () => R) => R) => Promise<T> | T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`get-to-know-${sequence++}`)), (_instance, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));
const book = (sql: SqlStorage, now: () => number) => { let n = 0; return jobBook(sql, { now, newId: () => `job-${n += 1}`, newToken: () => `tok-${n += 1}` }); };

describe('the first-week get-to-know read: when it starts', () => {
  it('writes one reader job once per owner, after the welcome build began and Google is connected, due after the first reply has room', async () => {
    await withSql((sql) => {
      const now = () => T0, jobs = book(sql, now), build = welcomeBuild(sql, now);
      let started: number | null = null;
      const deps = { book: jobs, now, surface: 'app', held: [], build, started: () => started, markStarted: (at: number) => { started = at; } };
      expect(startGetToKnow(deps, false).code).toBe('no_build');
      build.start();
      expect(startGetToKnow(deps, false).code).toBe('no_google');
      const made = startGetToKnow(deps, true);
      expect(made.code).toBe('enqueued');
      if (made.code !== 'enqueued') return;
      expect(made.job.origin).toBe('machine:get_to_know_you');
      expect(made.job.due_at).toBe(T0 + GET_TO_KNOW_DELAY_MS);
      // A reader of the owner's own data and nothing else: no web, no memory writes, no sends.
      expect(jobTools(made.job)).toEqual(MACHINE_READER);
      expect(jobTools(made.job)).not.toContain('web_search');
      const brief = taskBrief(made.job);
      expect(brief.goal).toMatch(/seven days/);
      expect(brief.context).not.toMatch(/@/);
      expect(startGetToKnow(deps, true).code).toBe('started');
      expect(jobs.openMachine('get_to_know_you', 'owner')?.id).toBe(made.job.id);
    });
  });

  it('is over once the first week is: a build begun more than seven days ago starts nothing', async () => {
    await withSql((sql) => {
      let at = T0;
      const now = () => at, build = welcomeBuild(sql, now);
      build.start();
      at = T0 + GET_TO_KNOW_DAYS * DAY + 1;
      expect(startGetToKnow({ book: book(sql, now), now, surface: 'app', held: [], build, started: () => null, markStarted: () => undefined }, true).code).toBe('too_late');
    });
  });
});

const row = (id = 'job-1'): JobRow => ({ id, origin: 'machine:get_to_know_you', created_at: T0 } as JobRow);
const result = (findings: TaskResult['findings']): TaskResult => ({ status: 'done', summary: 'Read the first week.', findings, proposals: [], left: [] });

describe('the first-week get-to-know read: what it writes', () => {
  it('turns the worker\'s findings into Waldo\'s spots, with the people they name, in one model call, then runs the join once', async () => {
    await withSql(async (sql, transaction) => {
      const claims = claimStore(sql, transaction);
      const asked: string[] = [];
      let settled = 0, joined = 0;
      const apply = getToKnowApplier({ claims, now: () => T0, transaction, healthMemory: () => true, join: async () => { joined += 1; },
        ask: async (text) => { asked.push(text); return JSON.stringify({ spots: [
          { area: 'goals', text: 'A coach thread plans the build to a spring marathon', source: 'gmail', pointers: ['thr_9'], people: [{ name: 'Maya Coach', address: 'maya@run.example', relation: 'running coach' }] },
          { area: 'work', text: 'A Tuesday design sync with Priya repeats weekly', source: 'calendar', pointers: ['evt_2'], people: [{ name: 'Priya Shah', address: 'priya@studio.example', relation: null }] },
        ] }); } });
      const outcome = await apply.apply(row(), result([
        { text: 'Maya Coach <maya@run.example> sends a training plan building to a spring marathon.', source_ref: 'gmail:thr_9' },
        { text: 'Tuesday design sync with Priya Shah <priya@studio.example>, repeats weekly.', source_ref: 'calendar:evt_2' },
        { text: 'Resting heart rate 48 bpm in the coach notes.', source_ref: 'gmail:thr_10' },
        { text: 'A doc titled "2027 plan".', source_ref: 'drive:file_1' },
      ]), { trace: 'task:job-1', current: async () => undefined, settle: () => { settled += 1; } });
      expect(outcome).toBe('skipped');
      expect([settled, joined]).toEqual([1, 1]);
      expect(asked).toHaveLength(1);
      // A reading in a finding never reaches the model call or memory; a file is context, not something a spot can cite.
      expect(asked[0]).not.toMatch(/48|thr_10/);
      expect(asked[0]).toContain('[file_1]');
      expect(asked[0]).toMatch(/Sources to name \(a spot's source is exactly one of these\): gmail, calendar/);
      // The read writes spots only; constellations are the join's.
      expect(claims.nodes()).toEqual([]);
      const spots = claims.claims();
      expect(spots.map((claim) => [claim.kind, claim.source_ref]).sort()).toEqual([['observation', 'welcome:calendar:evt_2'], ['observation', 'welcome:gmail:thr_9']]);
      expect(claims.people.all().map((person) => person.name).sort()).toEqual(['Maya Coach', 'Priya Shah']);
      expect(claims.allClaims().every((claim) => claim.origin === 'untrusted')).toBe(true);
    });
  });

  it('settles without a model call or a join when the worker found nothing it could cite', async () => {
    await withSql(async (sql, transaction) => {
      const claims = claimStore(sql, transaction);
      let asked = 0, settled = 0, joined = 0;
      const apply = getToKnowApplier({ claims, now: () => T0, transaction, healthMemory: () => true, join: async () => { joined += 1; }, ask: async () => { asked += 1; return '{"spots":[]}'; } });
      await apply.apply(row(), result([{ text: 'A doc titled "notes".', source_ref: 'drive:file_1' }, { text: 'No source given.' }]), { trace: 't', current: async () => undefined, settle: () => { settled += 1; } });
      expect([asked, settled, joined]).toEqual([0, 1, 0]);
    });
  });

  it('an owner who keeps health out of memory gets no body or mind spot from it, and is told so', async () => {
    await withSql(async (sql, transaction) => {
      const claims = claimStore(sql, transaction);
      const asked: string[] = [];
      const apply = getToKnowApplier({ claims, now: () => T0, transaction, healthMemory: () => false,
        ask: async (text) => { asked.push(text); return JSON.stringify({ spots: [{ area: 'body', text: 'Replies late at night, so sleeps late', source: 'gmail', pointers: ['thr_1'], people: [] }, { area: 'mind', text: 'Sounds stressed in late replies', source: 'gmail', pointers: ['thr_1'], people: [] }] }); } });
      await apply.apply(row(), result([{ text: 'Replies late at night.', source_ref: 'gmail:thr_1' }]), { trace: 't', current: async () => undefined, settle: () => undefined });
      expect(asked[0]).toContain('keeps health out of memory');
      expect(claims.claims()).toEqual([]);
    });
  });
});
