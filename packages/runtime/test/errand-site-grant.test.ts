import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { StartTaskArgs } from '@waldo/contracts';
import { jobBook, type JobBook } from '../src/tasks/jobs';
import { taskToolHandlers } from '../src/tasks/tools';
import { argumentDigest, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { BROWSER_ERRAND_GRANT_MS, type BrowserErrandGrant } from '../src/channels/browser-errand-grant';
import type { TaintedActionProposal } from '../src/channels/approvals';

// One owner yes for a named errand: start_task with a site grant raises the owner's card and runs nothing; the approved
// replay of that exact call writes the errand job and its grant together.
const T0 = 1_800_000_000_000;
type Start = Readonly<{ handle(args: StartTaskArgs, ctx: ToolDispatcherContext): Promise<unknown> }>;
let seq = 0;
const withStart = <T,>(work: (h: Readonly<{ book: JobBook; start: Start; proposed: TaintedActionProposal[]; grant: (jobId: string) => BrowserErrandGrant | undefined; storage: DurableObjectStorage }>) => Promise<T>, granting = true): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`errand-grant-${seq += 1}`)), async (_instance, state) => {
    let n = 0;
    const book = jobBook(state.storage.sql, { now: () => T0, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const proposed: TaintedActionProposal[] = [];
    const [start] = taskToolHandlers({
      book, now: () => T0, timezone: () => 'Europe/London', surface: 'app', wake: async () => {}, fence: () => {}, log: () => {},
      ...(granting ? { errandGrant: { storage: state.storage, propose: async (proposal: TaintedActionProposal) => { proposed.push(proposal); return 'approval-1'; } } } : {}),
    });
    return work({ book, start: start as Start, proposed, storage: state.storage, grant: jobId => state.storage.kv.get<BrowserErrandGrant>(`browser-errand-grant:task:${jobId}`) });
  });
const args: StartTaskArgs = { profile: 'errand', title: 'Check in for WA101', goal: 'Check the owner in for fictional flight WA101 and fetch the boarding pass PDF.',
  context: 'Booking ref FICT01, surname Example. The browser session_handle is fictional-session.', done_when: 'Checked in and the boarding pass downloaded.',
  site_grant: { origin: 'https://checkin.airline.example', submits: 3 } };
const owner = { turnId: 'turn-1', toolCallId: 'call-1' } as ToolDispatcherContext;

it('a site grant in an owner turn raises one card naming the site, the submits and fifteen minutes, and starts nothing', async () => {
  await withStart(async ({ book, start, proposed }) => {
    expect(await start.handle(args, owner)).toMatchObject({ ok: true, data: { status: 'waiting_for_owner', proposal_id: 'approval-1', executed: false } });
    expect(book.taskCounts('turn-1').fromTurn).toBe(0);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ tool: 'start_task', args, args_digest: await argumentDigest(args) });
    expect(proposed[0]!.preview!.join(' ')).toMatch(/https:\/\/checkin\.airline\.example.*3.*15 minutes/);
  });
});
it('the approved replay writes the errand job and its grant in one commit; a repeat changes neither', async () => {
  await withStart(async ({ book, start, grant }) => {
    const approved = { turnId: 'approval:approval-1', toolCallId: 'approval:approval-1', approvedTaintedAction: { tool: 'start_task', args_digest: await argumentDigest(args) } } as ToolDispatcherContext;
    const first = await start.handle(args, approved) as { ok: true; data: { job_id: string } };
    expect(first).toMatchObject({ ok: true, data: { status: 'started', profile: 'errand' } });
    const job = book.get(first.data.job_id)!;
    expect(job).toMatchObject({ kind: 'task', profile: 'errand', deadline_at: T0 + BROWSER_ERRAND_GRANT_MS });
    expect(grant(job.id)).toEqual({ approvalId: 'approval-1', runId: `task:${job.id}`, origin: 'https://checkin.airline.example', expiresAt: T0 + BROWSER_ERRAND_GRANT_MS, maxSubmits: 3, submits: [] });
    expect(await start.handle(args, approved)).toEqual(first);
  });
});
it('a site grant on a reader task, or on a Waldo that cannot grant one, is refused and starts nothing', async () => {
  await withStart(async ({ book, start, proposed }) => {
    expect(await start.handle({ ...args, profile: 'reader' }, owner)).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(proposed).toHaveLength(0);expect(book.taskCounts('turn-1').fromTurn).toBe(0);
  });
  await withStart(async ({ book, start }) => {
    expect(await start.handle(args, owner)).toMatchObject({ ok: false });
    expect(book.taskCounts('turn-1').fromTurn).toBe(0);
  }, false);
});

import { buildSessionState } from '@waldo/contracts';
import { approvalDesk } from '../src/channels/approvals';
import { dispatchTool } from '../src/tools/dispatcher';
import { proposeActionHandler, taintedActionReplay } from '../src/tools/live/propose-action';
import { sanitise } from '../src/scribe/sanitiser';
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const turn = (over: Partial<ToolDispatcherContext> = {}): ToolDispatcherContext => ({
  authenticatedUserId: 'owner-1', trigger: 'user_message', canaryTokens: CANARIES, sourceTaint: null, toolArgSourceTaint: null, sanitise, hasApproval: () => true, turnId: 'turn-1',
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: Date.now() }), ...over,
});
const desked = (work: (h: Readonly<{ card: () => string; decide: () => Promise<string>; open: () => readonly unknown[]; grants: () => number; handlers: ReturnType<typeof taskToolHandlers>; desk: ReturnType<typeof approvalDesk> }>) => Promise<void>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`errand-grant-desk-${seq += 1}`)), async (_instance, state) => {
    let n = 0, m = 0;
    const book = jobBook(state.storage.sql, { now: () => T0, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const cards: string[] = [];
    let handlers: ReturnType<typeof taskToolHandlers> = [];
    const desk = approvalDesk(state.storage.sql, { owner: 42, call: async (_method, body) => { cards.push((body as { text: string }).text); return { message_id: cards.length }; },
      google: async () => null, newId: () => `pa${++m}`, now: () => T0, timezone: 'UTC', log: () => undefined,
      replayTaintedAction: taintedActionReplay({ handlers: () => handlers, context: () => turn() }) });
    handlers = taskToolHandlers({ book, now: () => T0, timezone: () => 'UTC', surface: 'app', wake: async () => {}, fence: () => {}, log: () => {}, errandGrant: { storage: state.storage, propose: proposal => desk.proposeTaintedAction(proposal) } });
    const id = () => state.storage.sql.exec<{ id: string }>("SELECT id FROM ledger WHERE kind = 'tainted_action'").one().id;
    await work({ card: () => cards.at(-1) ?? '', decide: async () => (await desk.decide(id(), 'a', 't')).toast, open: () => book.open().filter(row => row.kind === 'task'),
      grants: () => [...state.storage.kv.list({ prefix: 'browser-errand-grant:' })].length, handlers, desk });
  });
it('an owner turn\'s site grant reaches the owner as one card in plain words; their yes starts the errand with its grant', async () => {
  await desked(async ({ card, decide, open, grants, handlers }) => {
    expect(await dispatchTool({ id: 'c1', name: 'start_task', args }, turn({ toolCallId: 'c1' }), { handlers })).toMatchObject({ ok: true, data: { status: 'waiting_for_owner' } });
    expect(open()).toEqual([]);expect(grants()).toBe(0);
    expect(card()).toContain('may submit forms on https://checkin.airline.example only');
    expect(card()).not.toContain('email or web page');
    expect(await decide()).toBe('Done');
    expect(open()).toHaveLength(1);expect(grants()).toBe(1);
  });
});
it('after outside content the same errand goes through propose_action, and its card still says what the grant allows', async () => {
  await desked(async ({ card, decide, open, grants, handlers, desk }) => {
    const tainted = turn({ toolArgSourceTaint: 'external', toolCallId: 'p1' });
    expect(await dispatchTool({ id: 'c1', name: 'start_task', args }, { ...tainted, toolCallId: 'c1' }, { handlers })).toMatchObject({ ok: false, error_code: 'taint_needs_approval' });
    expect(await proposeActionHandler(desk).handle({ tool: 'start_task', args, reasoning: 'The airline page offers online check-in.' } as never, tainted)).toMatchObject({ ok: true, data: { executed: false } });
    expect(card()).toContain('may submit forms on https://checkin.airline.example only');
    expect(await decide()).toBe('Done');
    expect(open()).toHaveLength(1);expect(grants()).toBe(1);
  });
});
