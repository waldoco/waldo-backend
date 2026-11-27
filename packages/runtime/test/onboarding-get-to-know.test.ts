import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { claimStore } from '../src/memory/claims';
import { nodeSources } from '../src/memory/node-sources';
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
  it('turns the worker\'s findings into Waldo\'s reads in the constellation, with the people they name, in one model call', async () => {
    await withSql(async (sql, transaction) => {
      const claims = claimStore(sql, transaction), build = welcomeBuild(sql, () => T0);
      build.start();
      const asked: string[] = [];
      let settled = 0;
      const apply = getToKnowApplier({ claims, build, now: () => T0, transaction, healthMemory: () => true,
        ask: async (text) => { asked.push(text); return JSON.stringify({ nodes: [
          { domain: 'goals', label: 'Training for a spring marathon', summary: 'You are building toward a spring marathon.', observation: 'Coach thread plans the build to race day.', source: 'gmail', pointers: ['thr_9'], extends: null, people: [{ name: 'Maya Coach', address: 'maya@run.example', relation: 'running coach' }], links_to: [] },
          { domain: 'work', label: 'Weekly sync with Priya', summary: 'You meet Priya every Tuesday.', observation: 'A Tuesday sync with Priya repeats.', source: 'calendar', pointers: ['evt_2'], extends: null, people: [{ name: 'Priya Shah', address: 'priya@studio.example', relation: null }], links_to: [] },
        ] }); } });
      const outcome = await apply.apply(row(), result([
        { text: 'Maya Coach <maya@run.example> sends a training plan building to a spring marathon.', source_ref: 'gmail:thr_9' },
        { text: 'Tuesday design sync with Priya Shah <priya@studio.example>, repeats weekly.', source_ref: 'calendar:evt_2' },
        { text: 'Resting heart rate 48 bpm in the coach notes.', source_ref: 'gmail:thr_10' },
        { text: 'A doc titled "2027 plan".', source_ref: 'drive:file_1' },
      ]), { trace: 'task:job-1', current: async () => undefined, settle: () => { settled += 1; } });
      expect(outcome).toBe('skipped');
      expect(settled).toBe(1);
      expect(asked).toHaveLength(1);
      // A reading in a finding never reaches the model call or memory; a file is context, not something a node can cite.
      expect(asked[0]).not.toMatch(/48|thr_10/);
      expect(asked[0]).toContain('[file_1]');
      expect(asked[0]).toMatch(/Sources to name \(a node's source is exactly one of these\): gmail, calendar/);
      const nodes = claims.nodes().filter((node) => node.status === 'active');
      expect(nodes.map((node) => node.label)).toEqual(['Training for a spring marathon', 'Weekly sync with Priya']);
      expect(nodes.map((node) => nodeSources(claims.allClaims(), node))).toEqual([['gmail'], ['calendar']]);
      expect(claims.people.all().map((person) => person.name).sort()).toEqual(['Maya Coach', 'Priya Shah']);
      expect(claims.allClaims().every((claim) => claim.origin === 'untrusted')).toBe(true);
    });
  });

  it('settles without a model call when the worker found nothing it could cite', async () => {
    await withSql(async (sql, transaction) => {
      const claims = claimStore(sql, transaction), build = welcomeBuild(sql, () => T0);
      let asked = 0, settled = 0;
      const apply = getToKnowApplier({ claims, build, now: () => T0, transaction, healthMemory: () => true, ask: async () => { asked += 1; return '{"nodes":[]}'; } });
      await apply.apply(row(), result([{ text: 'A doc titled "notes".', source_ref: 'drive:file_1' }, { text: 'No source given.' }]), { trace: 't', current: async () => undefined, settle: () => { settled += 1; } });
      expect([asked, settled]).toEqual([0, 1]);
    });
  });

  it('an owner who keeps health out of memory gets no health node from it', async () => {
    await withSql(async (sql, transaction) => {
      const claims = claimStore(sql, transaction), build = welcomeBuild(sql, () => T0);
      const apply = getToKnowApplier({ claims, build, now: () => T0, transaction, healthMemory: () => false,
        ask: async () => JSON.stringify({ nodes: [{ domain: 'health', label: 'Sleeps late', summary: 'You sleep late.', observation: 'Late replies at night.', source: 'gmail', pointers: ['thr_1'], extends: null, people: [], links_to: [] }] }) });
      await apply.apply(row(), result([{ text: 'Replies late at night.', source_ref: 'gmail:thr_1' }]), { trace: 't', current: async () => undefined, settle: () => undefined });
      expect(claims.nodes()).toEqual([]);
    });
  });
});
